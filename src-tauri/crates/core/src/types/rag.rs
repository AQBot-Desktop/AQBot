use serde::{Deserialize, Serialize};

use super::ContextDiagnostic;

// === RAG Context Events ===

/// A single retrieved chunk from RAG search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagRetrievedItem {
    pub content: String,
    pub score: f32,
    #[serde(
        default,
        rename = "rerankScore",
        skip_serializing_if = "Option::is_none"
    )]
    pub rerank_score: Option<f32>,
    pub document_id: String,
    /// Chunk ID within the vector store.
    #[serde(default)]
    pub id: String,
    /// Human-readable document name (populated for knowledge items).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_name: Option<String>,
}

/// Results from a single RAG source (knowledge base or memory namespace).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagSourceResult {
    /// "knowledge" or "memory"
    pub source_type: String,
    pub container_id: String,
    pub items: Vec<RagRetrievedItem>,
}

/// Retrieval failure for a single RAG source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagSourceError {
    /// "knowledge" or "memory"
    pub source_type: String,
    pub container_id: String,
    pub message: String,
}

/// Retrieval completed but returned no usable items for a single RAG source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagSourceEmptyResult {
    /// "knowledge" or "memory"
    pub source_type: String,
    pub container_id: String,
    /// "no_candidates" or "threshold_filtered"
    pub reason: String,
}

/// Combined results of RAG context collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagContextResult {
    /// Formatted context parts for injection into system prompt.
    pub context_parts: Vec<String>,
    /// Structured results for frontend display.
    pub source_results: Vec<RagSourceResult>,
    /// Structured failures for frontend display.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<RagSourceError>,
    /// Sources that completed without injectable context.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub empty_results: Vec<RagSourceEmptyResult>,
}

/// Tauri event emitted after RAG context retrieval completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagContextRetrievedEvent {
    pub conversation_id: String,
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    pub sources: Vec<RagSourceResult>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<RagSourceError>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub empty_results: Vec<RagSourceEmptyResult>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<ContextDiagnostic>,
}

// === Embedding Types ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedRequest {
    pub model: String,
    pub input: Vec<String>,
    pub dimensions: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedResponse {
    pub embeddings: Vec<Vec<f32>>,
    pub dimensions: usize,
}

// === Rerank Types ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RerankRequest {
    pub model: String,
    pub query: String,
    pub documents: Vec<String>,
    pub top_n: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RerankResult {
    pub index: usize,
    pub relevance_score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RerankResponse {
    pub results: Vec<RerankResult>,
}
