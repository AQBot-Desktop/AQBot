//! Unified RAG (Retrieval-Augmented Generation) abstraction layer.
//!
//! Provides a trait-based interface for different RAG sources (knowledge bases,
//! memory namespaces, etc.) to share indexing, searching, and context-collection
//! logic without code duplication.

use async_trait::async_trait;
use sea_orm::DatabaseConnection;

use crate::error::{AQBotError, Result};
use crate::types::{
    RagContextResult, RagRetrievedItem, RagSourceEmptyResult, RagSourceError, RagSourceResult,
};
use crate::vector_store::{EmbeddingRecord, VectorSearchResult, VectorStore};
use crate::{document_parser, text_chunker};

fn format_rag_failure_message(reason: impl AsRef<str>) -> String {
    const PREFIX: &str = "检索失败";
    let reason = reason.as_ref().trim();
    if reason.is_empty() {
        return PREFIX.to_string();
    }
    if reason.starts_with(PREFIX) {
        return reason.to_string();
    }
    format!("{PREFIX}：{reason}")
}

// ── Trait ────────────────────────────────────────────────────────────────────

/// A source of RAG content that can be searched and indexed.
///
/// Each implementor describes how to look up its embedding provider and
/// what prefix / label to use for vector-store collections and conversation
/// context injection.
#[async_trait]
pub trait RAGSource: Send + Sync {
    /// Collection prefix for vector-store table names (e.g. `"kb"`, `"mem"`).
    fn collection_prefix(&self) -> &'static str;

    /// Human-readable label inserted into conversation context
    /// (e.g. `"Knowledge Base Reference"`, `"Memory Reference"`).
    fn context_label(&self) -> &'static str;

    /// Resolve the `"providerId::modelId"` embedding provider string
    /// configured on the container identified by `container_id`.
    async fn resolve_embedding_provider(
        &self,
        db: &DatabaseConnection,
        container_id: &str,
    ) -> Result<String>;
}

// ── Built-in implementations ─────────────────────────────────────────────────

/// RAG source backed by a knowledge base (documents → parsed → chunked → embedded).
pub struct KnowledgeRAG;

#[async_trait]
impl RAGSource for KnowledgeRAG {
    fn collection_prefix(&self) -> &'static str {
        "kb"
    }

    fn context_label(&self) -> &'static str {
        "Knowledge Base Reference"
    }

    async fn resolve_embedding_provider(
        &self,
        db: &DatabaseConnection,
        container_id: &str,
    ) -> Result<String> {
        let kb = crate::repo::knowledge::get_knowledge_base(db, container_id).await?;
        kb.embedding_provider.ok_or_else(|| {
            AQBotError::Provider("Knowledge base has no embedding provider configured".to_string())
        })
    }
}

/// RAG source backed by a memory namespace (text items → directly embedded).
pub struct MemoryRAG;

#[async_trait]
impl RAGSource for MemoryRAG {
    fn collection_prefix(&self) -> &'static str {
        "mem"
    }

    fn context_label(&self) -> &'static str {
        "Memory Reference"
    }

    async fn resolve_embedding_provider(
        &self,
        db: &DatabaseConnection,
        container_id: &str,
    ) -> Result<String> {
        let ns = crate::repo::memory::get_namespace(db, container_id).await?;
        ns.embedding_provider.ok_or_else(|| {
            AQBotError::Provider(
                "Memory namespace has no embedding provider configured".to_string(),
            )
        })
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Build the sanitised collection ID for a RAG source.
pub fn collection_id(prefix: &str, container_id: &str) -> String {
    format!("{}_{}", prefix, container_id)
}

// ── Unified search ───────────────────────────────────────────────────────────

/// Search a single RAG source for content relevant to `query`.
///
/// This is the generic replacement for the separate `search_knowledge` /
/// `search_memory` functions.  The concrete `EmbedFn` is injected by the
/// caller (typically `crate::indexing::generate_embeddings`).
pub async fn search<S: RAGSource + ?Sized>(
    source: &S,
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    container_id: &str,
    query: &str,
    top_k: usize,
    dimensions: Option<usize>,
    embed_fn: impl AsyncEmbedFn,
) -> Result<Vec<VectorSearchResult>> {
    let embedding_provider = source.resolve_embedding_provider(db, container_id).await?;
    let cid = collection_id(source.collection_prefix(), container_id);

    let embed_response = embed_fn
        .generate(
            db,
            master_key,
            &embedding_provider,
            vec![query.to_string()],
            dimensions,
        )
        .await?;

    let query_embedding = embed_response
        .embeddings
        .into_iter()
        .next()
        .ok_or_else(|| AQBotError::Provider("No query embedding returned".into()))?;

    let results = vector_store.search(&cid, query_embedding, top_k).await?;
    Ok(results)
}

// ── Unified indexing ─────────────────────────────────────────────────────────

/// Chunking strategy for indexing content.
pub enum ChunkStrategy {
    /// Parse a file and chunk the resulting text.
    ParseAndChunk {
        source_path: String,
        mime_type: String,
        chunk_size: usize,
        overlap: usize,
    },
    /// Embed the content directly as a single vector.
    Direct,
}

/// Index content into a RAG source's vector collection.
///
/// Depending on the `ChunkStrategy`, the content is either:
/// - Parsed from a file, chunked, and batch-embedded (`ParseAndChunk`), or
/// - Embedded directly as a single item (`Direct`).
pub async fn index(
    vector_store: &VectorStore,
    collection_prefix: &str,
    container_id: &str,
    item_id: &str,
    _content: &str,
    embeddings: Vec<Vec<f32>>,
    chunks: Vec<(String, String, i32)>, // (id, content, chunk_index)
) -> Result<()> {
    if chunks.is_empty() || embeddings.is_empty() {
        return Ok(());
    }

    if embeddings.len() != chunks.len() {
        return Err(AQBotError::Provider(format!(
            "Embedding count mismatch: got {} embeddings for {} chunks",
            embeddings.len(),
            chunks.len()
        )));
    }

    let cid = collection_id(collection_prefix, container_id);

    let records: Vec<EmbeddingRecord> = chunks
        .into_iter()
        .zip(embeddings)
        .map(|((id, text, chunk_index), embedding)| EmbeddingRecord {
            id,
            document_id: item_id.to_string(),
            chunk_index,
            content: text,
            embedding,
        })
        .collect();

    vector_store.upsert_embeddings(&cid, records).await
}

/// Prepare chunks from content using the given strategy.
///
/// Returns a list of `(chunk_id, chunk_content, chunk_index)` tuples.
pub fn prepare_chunks(
    item_id: &str,
    strategy: &ChunkStrategy,
) -> Result<Vec<(String, String, i32)>> {
    match strategy {
        ChunkStrategy::ParseAndChunk {
            source_path,
            mime_type,
            chunk_size,
            overlap,
        } => {
            let path = std::path::Path::new(source_path);
            let text = document_parser::extract_text(path, mime_type)?;

            if text.trim().is_empty() {
                return Ok(vec![]);
            }

            let chunks = text_chunker::chunk_text(&text, *chunk_size, *overlap);

            Ok(chunks
                .into_iter()
                .map(|c| (format!("{}_{}", item_id, c.index), c.content, c.index))
                .collect())
        }
        ChunkStrategy::Direct => {
            // Caller provides content directly; we don't read from strategy.
            // The actual content is passed to `index()` separately.
            // Return a placeholder that the caller fills in.
            Ok(vec![])
        }
    }
}

/// Prepare a single direct chunk (for memory items).
pub fn prepare_direct_chunk(item_id: &str, content: &str) -> Vec<(String, String, i32)> {
    if content.trim().is_empty() {
        return vec![];
    }
    vec![(item_id.to_string(), content.to_string(), 0)]
}

pub fn vector_similarity(distance: f32) -> f32 {
    1.0 / (1.0 + distance.max(0.0))
}

pub fn passes_retrieval_threshold(distance: f32, threshold: f32) -> bool {
    if threshold <= 0.0 {
        return true;
    }
    if threshold <= 1.0 {
        vector_similarity(distance) >= threshold
    } else {
        distance <= threshold
    }
}

fn filter_results_by_threshold(
    raw_results: Vec<VectorSearchResult>,
    threshold: f32,
) -> (Vec<VectorSearchResult>, Option<&'static str>) {
    if raw_results.is_empty() {
        return (raw_results, Some("no_candidates"));
    }

    if threshold <= 0.0 {
        return (raw_results, None);
    }

    let results: Vec<_> = raw_results
        .into_iter()
        .filter(|r| passes_retrieval_threshold(r.score, threshold))
        .collect();

    if results.is_empty() {
        (results, Some("threshold_filtered"))
    } else {
        (results, None)
    }
}

// ── Context collection ───────────────────────────────────────────────────────

/// A typed RAG source reference for context collection.
pub struct RAGSourceRef {
    pub source_type: RAGSourceType,
    pub container_id: String,
}

/// The type of RAG source.
#[derive(PartialEq)]
pub enum RAGSourceType {
    Knowledge,
    Memory,
}

impl RAGSourceRef {
    fn source(&self) -> Box<dyn RAGSource> {
        match self.source_type {
            RAGSourceType::Knowledge => Box::new(KnowledgeRAG),
            RAGSourceType::Memory => Box::new(MemoryRAG),
        }
    }

    fn source_type_str(&self) -> &'static str {
        match self.source_type {
            RAGSourceType::Knowledge => "knowledge",
            RAGSourceType::Memory => "memory",
        }
    }

    fn empty_result(&self, reason: &str) -> RagSourceEmptyResult {
        RagSourceEmptyResult {
            source_type: self.source_type_str().to_string(),
            container_id: self.container_id.clone(),
            reason: reason.to_string(),
        }
    }
}

/// Collect RAG context from all enabled sources for a conversation query.
///
/// Returns a `RagContextResult` containing both formatted context parts
/// (for injection into the system prompt) and structured results
/// (for frontend display).  Errors for individual sources are logged and skipped.
pub async fn collect_rag_context(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    kb_ids: &[String],
    mem_ids: &[String],
    query: &str,
    top_k: usize,
    embed_fn: impl AsyncEmbedFn + Clone,
    rerank_fn: impl AsyncRerankFn + Clone,
) -> RagContextResult {
    let mut sources: Vec<RAGSourceRef> = Vec::new();

    for id in kb_ids {
        sources.push(RAGSourceRef {
            source_type: RAGSourceType::Knowledge,
            container_id: id.clone(),
        });
    }
    for id in mem_ids {
        sources.push(RAGSourceRef {
            source_type: RAGSourceType::Memory,
            container_id: id.clone(),
        });
    }

    let mut context_parts = Vec::new();
    let mut source_results = Vec::new();
    let mut errors = Vec::new();
    let mut empty_results = Vec::new();

    for src_ref in &sources {
        let source = src_ref.source();

        // Resolve per-source search parameters (top_k, threshold, dimensions)
        let resolved = match src_ref.source_type {
            RAGSourceType::Memory => {
                match crate::repo::memory::get_namespace(db, &src_ref.container_id).await {
                    Ok(ns) => {
                        let final_top_k = ns
                            .retrieval_top_k
                            .filter(|v| *v > 0)
                            .map(|v| v as usize)
                            .unwrap_or(top_k)
                            .max(1);
                        Some((
                            final_top_k,
                            ns.retrieval_threshold.unwrap_or(0.0),
                            ns.embedding_dimensions.map(|v| v as usize),
                            final_top_k,
                            None,
                        ))
                    }
                    Err(err) => {
                        errors.push(RagSourceError {
                            source_type: src_ref.source_type_str().to_string(),
                            container_id: src_ref.container_id.clone(),
                            message: format_rag_failure_message(err.to_string()),
                        });
                        None
                    }
                }
            }
            RAGSourceType::Knowledge => {
                match crate::repo::knowledge::get_knowledge_base(db, &src_ref.container_id).await {
                    Ok(kb) => {
                        let final_top_k = kb
                            .retrieval_top_k
                            .filter(|v| *v > 0)
                            .map(|v| v as usize)
                            .unwrap_or(top_k)
                            .max(1);
                        let rerank_provider = kb
                            .rerank_provider
                            .filter(|provider| !provider.trim().is_empty());
                        let source_top_k = if rerank_provider.is_some() {
                            let min_candidates = final_top_k.min(100) as i32;
                            kb.rerank_candidate_k
                                .unwrap_or(20)
                                .clamp(min_candidates, 100) as usize
                        } else {
                            final_top_k
                        };
                        Some((
                            source_top_k,
                            kb.retrieval_threshold.unwrap_or(0.0),
                            kb.embedding_dimensions
                                .and_then(|value| usize::try_from(value).ok())
                                .filter(|value| *value > 0),
                            final_top_k,
                            rerank_provider,
                        ))
                    }
                    Err(err) => {
                        errors.push(RagSourceError {
                            source_type: src_ref.source_type_str().to_string(),
                            container_id: src_ref.container_id.clone(),
                            message: format_rag_failure_message(err.to_string()),
                        });
                        None
                    }
                }
            }
        };
        let Some((source_top_k, threshold, dims, final_top_k, rerank_provider)) = resolved else {
            continue;
        };

        let result = search(
            source.as_ref(),
            db,
            master_key,
            vector_store,
            &src_ref.container_id,
            query,
            source_top_k,
            dims,
            embed_fn.clone(),
        )
        .await;

        match result {
            Ok(raw_results) => {
                let (mut results, empty_reason) =
                    filter_results_by_threshold(raw_results, threshold);
                if let Some(reason) = empty_reason {
                    tracing::warn!(
                        "RAG search returned no usable results for {} {}: {}",
                        source.collection_prefix(),
                        src_ref.container_id,
                        reason,
                    );
                    empty_results.push(src_ref.empty_result(reason));
                    continue;
                }

                if let Some(rerank_provider) = rerank_provider {
                    match rerank_fn
                        .rerank(
                            db,
                            master_key,
                            &rerank_provider,
                            query,
                            &results,
                            final_top_k,
                        )
                        .await
                    {
                        Ok(reranked) if !reranked.is_empty() => {
                            results = reranked;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!(
                                "RAG rerank failed for {} {}: {}",
                                source.collection_prefix(),
                                src_ref.container_id,
                                e
                            );
                            errors.push(RagSourceError {
                                source_type: src_ref.source_type_str().to_string(),
                                container_id: src_ref.container_id.clone(),
                                message: format_rag_failure_message(format!("重排序失败：{e}")),
                            });
                            continue;
                        }
                    }
                }

                results.truncate(final_top_k);

                let items: Vec<RagRetrievedItem> = results
                    .iter()
                    .map(|r| RagRetrievedItem {
                        content: r.content.clone(),
                        score: r.score,
                        rerank_score: r.rerank_score,
                        document_id: r.document_id.clone(),
                        id: r.id.clone(),
                        document_name: None,
                    })
                    .collect();

                let snippets: Vec<String> = results.iter().map(|r| r.content.clone()).collect();
                context_parts.push(format!(
                    "[{}]\n{}",
                    source.context_label(),
                    snippets.join("\n---\n")
                ));

                source_results.push(RagSourceResult {
                    source_type: src_ref.source_type_str().to_string(),
                    container_id: src_ref.container_id.clone(),
                    items,
                });
            }
            Err(e) => {
                tracing::warn!(
                    "RAG search failed for {} {}: {}",
                    source.collection_prefix(),
                    src_ref.container_id,
                    e
                );
                errors.push(RagSourceError {
                    source_type: src_ref.source_type_str().to_string(),
                    container_id: src_ref.container_id.clone(),
                    message: format_rag_failure_message(format!("向量检索失败：{e}")),
                });
            }
        }
    }

    // Batch-lookup document titles for knowledge sources
    {
        let kb_doc_ids: Vec<String> = source_results
            .iter()
            .filter(|s| s.source_type == "knowledge")
            .flat_map(|s| s.items.iter().map(|it| it.document_id.clone()))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        if !kb_doc_ids.is_empty() {
            match crate::repo::knowledge::get_document_titles(db, &kb_doc_ids).await {
                Ok(titles) => {
                    for src in source_results
                        .iter_mut()
                        .filter(|s| s.source_type == "knowledge")
                    {
                        for item in &mut src.items {
                            item.document_name = titles.get(&item.document_id).cloned();
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to lookup document titles: {e}");
                }
            }
        }
    }

    RagContextResult {
        context_parts,
        source_results,
        errors,
        empty_results,
    }
}

// ── Embed function trait ─────────────────────────────────────────────────────

/// Trait for embedding generation, allowing the RAG layer to be independent
/// of the concrete provider implementation in the `indexing` module.
#[async_trait]
pub trait AsyncEmbedFn: Send + Sync + Clone {
    async fn generate(
        &self,
        db: &DatabaseConnection,
        master_key: &[u8; 32],
        embedding_provider: &str,
        texts: Vec<String>,
        dimensions: Option<usize>,
    ) -> Result<crate::types::EmbedResponse>;
}

#[async_trait]
pub trait AsyncRerankFn: Send + Sync + Clone {
    async fn rerank(
        &self,
        db: &DatabaseConnection,
        master_key: &[u8; 32],
        rerank_provider: &str,
        query: &str,
        results: &[VectorSearchResult],
        top_n: usize,
    ) -> Result<Vec<VectorSearchResult>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector_result(id: &str, score: f32) -> VectorSearchResult {
        VectorSearchResult {
            id: id.to_string(),
            document_id: format!("doc-{id}"),
            chunk_index: 0,
            content: format!("content {id}"),
            score,
            rerank_score: None,
            has_embedding: true,
        }
    }

    #[test]
    fn retrieval_threshold_uses_displayed_similarity_for_zero_to_one_values() {
        assert!(passes_retrieval_threshold(1.0, 0.5));
        assert!(passes_retrieval_threshold(4.0, 0.1));
        assert!(!passes_retrieval_threshold(4.0, 0.3));
    }

    #[test]
    fn retrieval_threshold_keeps_distance_compatibility_for_values_above_one() {
        assert!(passes_retrieval_threshold(1.5, 2.0));
        assert!(!passes_retrieval_threshold(2.5, 2.0));
    }

    #[test]
    fn retrieval_empty_reason_marks_threshold_filtered_candidates() {
        let (results, empty_reason) =
            filter_results_by_threshold(vec![vector_result("a", 4.0)], 0.49);

        assert!(results.is_empty());
        assert_eq!(empty_reason, Some("threshold_filtered"));
    }

    #[test]
    fn retrieval_empty_reason_marks_no_candidates() {
        let (results, empty_reason) = filter_results_by_threshold(Vec::new(), 0.1);

        assert!(results.is_empty());
        assert_eq!(empty_reason, Some("no_candidates"));
    }
}
