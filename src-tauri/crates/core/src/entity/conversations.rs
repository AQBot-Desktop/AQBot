use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "conversations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub title: String,
    pub model_id: String,
    pub provider_id: String,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub search_enabled: i32,
    pub search_provider_id: Option<String>,
    pub thinking_budget: Option<i64>,
    pub thinking_level: Option<String>,
    pub enabled_mcp_server_ids: String,
    pub enabled_knowledge_base_ids: String,
    pub enabled_memory_namespace_ids: String,
    pub message_count: i32,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: i32,
    pub is_archived: i32,
    pub workspace_snapshot_json: String,
    pub active_branch_id: Option<String>,
    pub active_artifact_id: Option<String>,
    pub research_mode: i32,
    pub context_compression: i32,
    /// Nullable snake_case `ContextStrategy`; `None` follows the global default.
    pub context_strategy_override: Option<String>,
    /// Max provider history messages for this conversation. `None` falls back
    /// to the global `default_context_count` setting. Values ≥ 50 mean unlimited.
    pub context_message_limit: Option<i32>,
    /// When compressing context, keep the last N compressible messages in clear
    /// text (not included in the summary). `None` means default (3). `0` keeps none.
    pub compression_keep_last_n: Option<i32>,
    /// Nullable kebab-case multi-model display mode; `None` follows the global setting.
    pub multi_model_display_mode_override: Option<String>,
    /// JSON array of `{ providerId, modelId }` companion targets, preserving user order.
    pub multi_model_targets_json: String,
    /// `selected` or `per_model`.
    pub multi_model_continuation_mode: String,
    pub category_id: Option<String>,
    pub parent_conversation_id: Option<String>,
    pub sort_order: i32,
    pub mode: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::messages::Entity")]
    Messages,
}

impl Related<super::messages::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Messages.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
