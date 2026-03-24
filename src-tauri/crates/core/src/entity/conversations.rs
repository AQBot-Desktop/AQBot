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
