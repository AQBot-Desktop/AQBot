use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMemoryNamespaceInput {
    pub name: String,
    pub scope: String,
    pub embedding_provider: Option<String>,
    pub embedding_dimensions: Option<i32>,
    pub retrieval_threshold: Option<f32>,
    pub retrieval_top_k: Option<i32>,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub activation_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemoryNamespaceInput {
    pub name: Option<String>,
    pub embedding_provider: Option<String>,
    #[serde(default)]
    pub update_embedding_provider: bool,
    pub embedding_dimensions: Option<i32>,
    #[serde(default)]
    pub update_embedding_dimensions: bool,
    pub retrieval_threshold: Option<f32>,
    #[serde(default)]
    pub update_retrieval_threshold: bool,
    pub retrieval_top_k: Option<i32>,
    #[serde(default)]
    pub update_retrieval_top_k: bool,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    #[serde(default)]
    pub update_icon: bool,
    pub sort_order: Option<i32>,
    pub activation_mode: Option<String>,
    #[serde(default)]
    pub update_activation_mode: bool,
    pub migration_review_required: Option<bool>,
    #[serde(default)]
    pub update_migration_review_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMemoryItemInput {
    pub namespace_id: String,
    pub title: String,
    pub content: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemoryItemInput {
    pub title: Option<String>,
    pub content: Option<String>,
}
