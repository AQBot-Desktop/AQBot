use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "roles")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub opening_message: Option<String>,
    pub opening_questions_json: String,
    pub opening_questions_v2_json: Option<String>,
    pub tags_json: String,
    pub avatar: Option<String>,
    pub avatar_type: Option<String>,
    pub avatar_value: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub enabled_mcp_server_ids_json: String,
    pub enabled_skill_names_json: String,
    pub enabled_knowledge_base_ids_json: String,
    pub enabled_memory_namespace_ids_json: String,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
