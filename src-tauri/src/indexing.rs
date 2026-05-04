//! Indexing pipeline for knowledge base documents and memory items.
//!
//! Provides functions to:
//! - Parse an `embedding_provider` string ("providerId::modelId")
//! - Build a `ProviderRequestContext` for embedding API calls
//! - Generate embeddings via provider adapters
//! - Index knowledge base documents and memory items via the unified RAG layer
//! - Search knowledge base / memory vectors via the unified RAG layer
//! - Collect RAG context for conversation injection

use sea_orm::DatabaseConnection;

use aqbot_core::error::{AQBotError, Result};
use aqbot_core::rag::{self, ChunkStrategy, KnowledgeRAG, MemoryRAG};
use aqbot_core::types::*;
use aqbot_core::vector_store::{VectorSearchResult, VectorStore};

use aqbot_providers::{
    registry::ProviderRegistry, resolve_base_url_for_type, ProviderAdapter, ProviderRequestContext,
};

// ── AsyncEmbedFn implementation ──────────────────────────────────────────────

/// Concrete implementation of `AsyncEmbedFn` that uses provider adapters.
#[derive(Clone)]
pub struct ProviderEmbedFn;

#[derive(Clone)]
pub struct ProviderRerankFn;

#[async_trait::async_trait]
impl rag::AsyncEmbedFn for ProviderEmbedFn {
    async fn generate(
        &self,
        db: &DatabaseConnection,
        master_key: &[u8; 32],
        embedding_provider: &str,
        texts: Vec<String>,
        dimensions: Option<usize>,
    ) -> Result<EmbedResponse> {
        generate_embeddings(db, master_key, embedding_provider, texts, dimensions).await
    }
}

#[async_trait::async_trait]
impl rag::AsyncRerankFn for ProviderRerankFn {
    async fn rerank(
        &self,
        db: &DatabaseConnection,
        master_key: &[u8; 32],
        rerank_provider: &str,
        query: &str,
        results: &[VectorSearchResult],
        top_n: usize,
    ) -> Result<Vec<VectorSearchResult>> {
        rerank_search_results(db, master_key, rerank_provider, query, results, top_n).await
    }
}

// ── Low-level embedding utilities ────────────────────────────────────────────

/// Parse an embedding_provider string like "providerId::modelId" into (provider_id, model_id).
pub fn parse_embedding_provider(embedding_provider: &str) -> Result<(String, String)> {
    let parts: Vec<&str> = embedding_provider.splitn(2, "::").collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(AQBotError::Provider(format!(
            "Invalid embedding_provider format '{}'. Expected 'providerId::modelId'",
            embedding_provider
        )));
    }
    Ok((parts[0].to_string(), parts[1].to_string()))
}

/// Resolve the provider type string used for registry lookup.
fn provider_type_to_registry_key(pt: &ProviderType) -> &'static str {
    match pt {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::DeepSeek => "deepseek",
        ProviderType::XAI => "xai",
        ProviderType::GLM => "glm",
        ProviderType::SiliconFlow => "siliconflow",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Custom => "custom",
    }
}

/// Build a ProviderRequestContext for an embedding provider.
pub async fn build_embed_context(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    provider_id: &str,
) -> Result<(ProviderRequestContext, ProviderConfig)> {
    let provider = aqbot_core::repo::provider::get_provider(db, provider_id).await?;
    let key_row = aqbot_core::repo::provider::get_active_key(db, provider_id).await?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, master_key)?;

    let global_settings = aqbot_core::repo::settings::get_settings(db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: None,
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    Ok((ctx, provider))
}

/// Generate embeddings for a list of texts using the specified provider.
pub async fn generate_embeddings(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    embedding_provider: &str,
    texts: Vec<String>,
    dimensions: Option<usize>,
) -> Result<EmbedResponse> {
    let (provider_id, model_id) = parse_embedding_provider(embedding_provider)?;
    let (ctx, provider_config) = build_embed_context(db, master_key, &provider_id).await?;

    let registry = ProviderRegistry::create_default();
    let registry_key = provider_type_to_registry_key(&provider_config.provider_type);
    let adapter: &dyn ProviderAdapter = registry.get(registry_key).ok_or_else(|| {
        AQBotError::Provider(format!("Unsupported provider type: {}", registry_key))
    })?;

    let request = EmbedRequest {
        model: model_id,
        input: texts,
        dimensions,
    };

    adapter.embed(&ctx, request).await
}

/// Rerank existing vector search results using a configured rerank provider.
pub async fn generate_rerank(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    rerank_provider: &str,
    query: &str,
    documents: Vec<String>,
    top_n: usize,
) -> Result<RerankResponse> {
    let (provider_id, model_id) = parse_embedding_provider(rerank_provider)?;
    let (ctx, provider_config) = build_embed_context(db, master_key, &provider_id).await?;

    let registry = ProviderRegistry::create_default();
    let registry_key = provider_type_to_registry_key(&provider_config.provider_type);
    let adapter: &dyn ProviderAdapter = registry.get(registry_key).ok_or_else(|| {
        AQBotError::Provider(format!("Unsupported provider type: {}", registry_key))
    })?;

    let request = RerankRequest {
        model: model_id,
        query: query.to_string(),
        documents,
        top_n,
    };

    adapter.rerank(&ctx, request).await
}

pub async fn rerank_search_results(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    rerank_provider: &str,
    query: &str,
    results: &[VectorSearchResult],
    top_n: usize,
) -> Result<Vec<VectorSearchResult>> {
    if results.is_empty() {
        return Ok(vec![]);
    }

    let top_n = top_n.max(1).min(results.len());
    let documents: Vec<String> = results.iter().map(|r| r.content.clone()).collect();
    let response =
        generate_rerank(db, master_key, rerank_provider, query, documents, top_n).await?;

    Ok(apply_rerank_response(results, response, top_n))
}

fn apply_rerank_response(
    results: &[VectorSearchResult],
    response: RerankResponse,
    top_n: usize,
) -> Vec<VectorSearchResult> {
    let mut ranked = Vec::new();
    let mut used = std::collections::HashSet::new();
    let mut response_results = response.results;
    response_results.sort_by(|a, b| {
        b.relevance_score
            .partial_cmp(&a.relevance_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for item in response_results {
        if ranked.len() >= top_n {
            break;
        }
        if item.index >= results.len() || !used.insert(item.index) {
            continue;
        }
        let mut result = results[item.index].clone();
        result.rerank_score = Some(item.relevance_score);
        ranked.push(result);
    }

    for (idx, result) in results.iter().enumerate() {
        if ranked.len() >= top_n {
            break;
        }
        if used.insert(idx) {
            ranked.push(result.clone());
        }
    }

    ranked
}

// ── Document / item indexing (delegates to rag::index) ───────────────────────

/// Index a single knowledge base document: parse → chunk → embed → store.
///
/// Updates document status to "indexing" then "ready" or "failed".
pub async fn index_knowledge_document(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    knowledge_base_id: &str,
    document_id: &str,
    source_path: &str,
    mime_type: &str,
    embedding_provider: &str,
    chunk_size: Option<i32>,
    chunk_overlap: Option<i32>,
) -> Result<()> {
    aqbot_core::repo::knowledge::update_document_status(db, document_id, "indexing").await?;

    let strategy = ChunkStrategy::ParseAndChunk {
        source_path: source_path.to_string(),
        mime_type: mime_type.to_string(),
        chunk_size: chunk_size
            .map(|v| v as usize)
            .unwrap_or(aqbot_core::text_chunker::DEFAULT_CHUNK_SIZE),
        overlap: chunk_overlap
            .map(|v| v as usize)
            .unwrap_or(aqbot_core::text_chunker::DEFAULT_OVERLAP),
    };

    let chunks = rag::prepare_chunks(document_id, &strategy)?;

    if chunks.is_empty() {
        aqbot_core::repo::knowledge::update_document_status(db, document_id, "ready").await?;
        return Ok(());
    }

    let chunk_texts: Vec<String> = chunks.iter().map(|(_, text, _)| text.clone()).collect();
    let embed_response =
        generate_embeddings(db, master_key, embedding_provider, chunk_texts, None).await?;

    rag::index(
        vector_store,
        "kb",
        knowledge_base_id,
        document_id,
        "",
        embed_response.embeddings,
        chunks,
    )
    .await?;

    aqbot_core::repo::knowledge::update_document_status(db, document_id, "ready").await?;

    Ok(())
}

/// Index a single memory item: embed content → store in vector DB.
pub async fn index_memory_item(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    namespace_id: &str,
    item_id: &str,
    content: &str,
    embedding_provider: &str,
    dimensions: Option<usize>,
) -> Result<()> {
    let chunks = rag::prepare_direct_chunk(item_id, content);

    if chunks.is_empty() {
        return Ok(());
    }

    let chunk_texts: Vec<String> = chunks.iter().map(|(_, text, _)| text.clone()).collect();
    let embed_response =
        generate_embeddings(db, master_key, embedding_provider, chunk_texts, dimensions).await?;

    rag::index(
        vector_store,
        "mem",
        namespace_id,
        item_id,
        content,
        embed_response.embeddings,
        chunks,
    )
    .await
}

// ── Search (delegates to rag::search) ────────────────────────────────────────

/// Search knowledge base vectors for relevant content.
pub async fn search_knowledge(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    knowledge_base_id: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>> {
    let kb = aqbot_core::repo::knowledge::get_knowledge_base(db, knowledge_base_id).await?;
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

    let raw_results = rag::search(
        &KnowledgeRAG,
        db,
        master_key,
        vector_store,
        knowledge_base_id,
        query,
        source_top_k,
        None,
        ProviderEmbedFn,
    )
    .await?;

    let mut results: Vec<_> = if let Some(threshold) = kb.retrieval_threshold.filter(|v| *v > 0.0) {
        raw_results
            .into_iter()
            .filter(|r| rag::passes_retrieval_threshold(r.score, threshold))
            .collect()
    } else {
        raw_results
    };

    if let Some(rerank_provider) = rerank_provider {
        results = rerank_search_results(
            db,
            master_key,
            &rerank_provider,
            query,
            &results,
            final_top_k,
        )
        .await?;
    }
    results.truncate(final_top_k);
    Ok(results)
}

/// Search memory namespace vectors for relevant content.
pub async fn search_memory(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    namespace_id: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>> {
    // Look up namespace settings for dimensions
    let dims = aqbot_core::repo::memory::get_namespace(db, namespace_id)
        .await
        .ok()
        .and_then(|ns| ns.embedding_dimensions.map(|v| v as usize));
    rag::search(
        &MemoryRAG,
        db,
        master_key,
        vector_store,
        namespace_id,
        query,
        top_k,
        dims,
        ProviderEmbedFn,
    )
    .await
}

// ── Context collection (delegates to rag::collect_rag_context) ───────────────

/// Collect RAG context from all enabled sources for a conversation query.
///
/// Returns a `RagContextResult` with formatted context parts and structured results.
pub async fn collect_rag_context(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    kb_ids: &[String],
    mem_ids: &[String],
    query: &str,
    top_k: usize,
) -> RagContextResult {
    rag::collect_rag_context(
        db,
        master_key,
        vector_store,
        kb_ids,
        mem_ids,
        query,
        top_k,
        ProviderEmbedFn,
        ProviderRerankFn,
    )
    .await
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
    fn apply_rerank_response_reorders_by_provider_indexes_and_truncates() {
        let results = vec![
            vector_result("a", 0.1),
            vector_result("b", 0.2),
            vector_result("c", 0.3),
        ];

        let ranked = apply_rerank_response(
            &results,
            RerankResponse {
                results: vec![
                    RerankResult {
                        index: 0,
                        relevance_score: 0.82,
                    },
                    RerankResult {
                        index: 2,
                        relevance_score: 0.91,
                    },
                ],
            },
            2,
        );

        assert_eq!(
            ranked.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["c", "a"]
        );
        assert_eq!(ranked[0].score, 0.3);
        assert_eq!(ranked[0].rerank_score, Some(0.91));
        assert_eq!(ranked[1].rerank_score, Some(0.82));
    }
}
