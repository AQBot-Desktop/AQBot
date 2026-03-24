//! Indexing pipeline for knowledge base documents and memory items.
//!
//! Provides functions to:
//! - Parse an `embedding_provider` string ("providerId::modelId")
//! - Build a `ProviderRequestContext` for embedding API calls
//! - Index a knowledge base document (parse → chunk → embed → store)
//! - Index a memory item (embed → store)
//! - Search knowledge base / memory vectors

use sea_orm::DatabaseConnection;

use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use aqbot_core::vector_store::{EmbeddingRecord, VectorSearchResult, VectorStore};
use aqbot_core::{document_parser, text_chunker};

use aqbot_providers::{ProviderAdapter, ProviderRequestContext, registry::ProviderRegistry};

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
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Custom => "openai",
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
        base_url: Some(provider.api_host.clone()),
        proxy_config: resolved_proxy,
    };

    Ok((ctx, provider))
}

/// Generate embeddings for a list of texts using the specified provider.
pub async fn generate_embeddings(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    embedding_provider: &str,
    texts: Vec<String>,
) -> Result<EmbedResponse> {
    let (provider_id, model_id) = parse_embedding_provider(embedding_provider)?;
    let (ctx, provider_config) = build_embed_context(db, master_key, &provider_id).await?;

    let registry = ProviderRegistry::create_default();
    let registry_key = provider_type_to_registry_key(&provider_config.provider_type);
    let adapter: &dyn ProviderAdapter = registry
        .get(registry_key)
        .ok_or_else(|| AQBotError::Provider(format!("Unsupported provider type: {}", registry_key)))?;

    let request = EmbedRequest {
        model: model_id,
        input: texts,
    };

    adapter.embed(&ctx, request).await
}

/// Index a single knowledge base document: parse → chunk → embed → store in vector DB.
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
) -> Result<()> {
    // Update status to indexing
    aqbot_core::repo::knowledge::update_document_status(db, document_id, "indexing").await?;

    // Parse document
    let path = std::path::Path::new(source_path);
    let text = document_parser::extract_text(path, mime_type)?;

    if text.trim().is_empty() {
        aqbot_core::repo::knowledge::update_document_status(db, document_id, "ready").await?;
        return Ok(());
    }

    // Chunk text
    let chunks = text_chunker::chunk_text(
        &text,
        text_chunker::DEFAULT_CHUNK_SIZE,
        text_chunker::DEFAULT_OVERLAP,
    );

    if chunks.is_empty() {
        aqbot_core::repo::knowledge::update_document_status(db, document_id, "ready").await?;
        return Ok(());
    }

    // Collect chunk texts for batch embedding
    let chunk_texts: Vec<String> = chunks.iter().map(|c| c.content.clone()).collect();

    // Generate embeddings (batch)
    let embed_response = generate_embeddings(db, master_key, embedding_provider, chunk_texts).await?;

    if embed_response.embeddings.len() != chunks.len() {
        return Err(AQBotError::Provider(format!(
            "Embedding count mismatch: got {} embeddings for {} chunks",
            embed_response.embeddings.len(),
            chunks.len()
        )));
    }

    // Build embedding records
    let records: Vec<EmbeddingRecord> = chunks
        .iter()
        .zip(embed_response.embeddings.into_iter())
        .map(|(chunk, embedding)| EmbeddingRecord {
            id: format!("{}_{}", document_id, chunk.index),
            document_id: document_id.to_string(),
            chunk_index: chunk.index,
            content: chunk.content.clone(),
            embedding,
        })
        .collect();

    // Upsert into vector store (ensure_collection is called internally)
    let collection_id = format!("kb_{}", knowledge_base_id);
    vector_store
        .upsert_embeddings(&collection_id, records)
        .await?;

    // Update status to ready
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
) -> Result<()> {
    if content.trim().is_empty() {
        return Ok(());
    }

    let collection_id = format!("mem_{}", namespace_id);

    // Generate embedding for the content
    let embed_response =
        generate_embeddings(db, master_key, embedding_provider, vec![content.to_string()]).await?;

    let embedding = embed_response
        .embeddings
        .into_iter()
        .next()
        .ok_or_else(|| AQBotError::Provider("No embedding returned".into()))?;

    let record = EmbeddingRecord {
        id: item_id.to_string(),
        document_id: item_id.to_string(),
        chunk_index: 0,
        content: content.to_string(),
        embedding,
    };

    vector_store
        .upsert_embeddings(&collection_id, vec![record])
        .await?;

    Ok(())
}

/// Search knowledge base vectors for relevant content.
pub async fn search_knowledge(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    knowledge_base_id: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>> {
    // Get the knowledge base to find its embedding provider
    let kb = aqbot_core::repo::knowledge::get_knowledge_base(db, knowledge_base_id).await?;
    let embedding_provider = kb.embedding_provider.ok_or_else(|| {
        AQBotError::Provider("Knowledge base has no embedding provider configured".into())
    })?;

    // Embed the query
    let embed_response =
        generate_embeddings(db, master_key, &embedding_provider, vec![query.to_string()]).await?;
    let query_embedding = embed_response
        .embeddings
        .into_iter()
        .next()
        .ok_or_else(|| AQBotError::Provider("No query embedding returned".into()))?;

    // Search vectors
    let collection_id = format!("kb_{}", knowledge_base_id);
    vector_store
        .search(&collection_id, query_embedding, top_k)
        .await
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
    // Get the namespace to find its embedding provider
    let ns = aqbot_core::repo::memory::get_namespace(db, namespace_id).await?;
    let embedding_provider = ns.embedding_provider.ok_or_else(|| {
        AQBotError::Provider("Memory namespace has no embedding provider configured".into())
    })?;

    let collection_id = format!("mem_{}", namespace_id);

    // Embed the query
    let embed_response =
        generate_embeddings(db, master_key, &embedding_provider, vec![query.to_string()]).await?;
    let query_embedding = embed_response
        .embeddings
        .into_iter()
        .next()
        .ok_or_else(|| AQBotError::Provider("No query embedding returned".into()))?;

    // Search vectors
    vector_store
        .search(&collection_id, query_embedding, top_k)
        .await
}
