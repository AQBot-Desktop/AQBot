use serde::{Deserialize, Serialize};

pub const MEMORY_L1_ID: &str = "global";
pub const MEMORY_L1_SIDEBAR_ID: &str = "aqbot-memory-l1";
pub const MEMORY_L1_MAX_BYTES: usize = 5000;
pub const MEMORY_ACTIVATION_TOOL_ONLY: &str = "tool_only";
pub const MEMORY_ACTIVATION_AUTO: &str = "auto";

// Memory
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryNamespace {
    pub id: String,
    pub name: String,
    pub scope: String, // global | project
    pub embedding_provider: Option<String>,
    pub embedding_dimensions: Option<i32>,
    pub retrieval_threshold: Option<f32>,
    pub retrieval_top_k: Option<i32>,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub sort_order: i32,
    pub activation_mode: String,
    pub migration_review_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryL1 {
    pub enabled: bool,
    pub markdown: String,
    pub revision: i64,
    pub sort_order: i32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMemoryL1Input {
    pub enabled: bool,
    pub markdown: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextDiagnostic {
    pub code: String,
    pub source_type: String,
    pub container_id: Option<String>,
    pub args: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub namespace_id: String,
    pub title: String,
    pub content: String,
    pub source: String,       // manual | auto_extract
    pub index_status: String, // pending | indexing | ready | failed | skipped
    pub index_error: Option<String>,
    pub updated_at: String,
}
