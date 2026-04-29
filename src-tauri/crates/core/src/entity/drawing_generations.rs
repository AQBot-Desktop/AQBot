use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "drawing_generations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub parent_generation_id: Option<String>,
    pub provider_id: String,
    pub key_id: String,
    pub model_id: String,
    pub api_kind: String,
    pub action: String,
    pub prompt: String,
    pub parameters_json: String,
    pub reference_file_ids_json: String,
    pub source_image_ids_json: String,
    pub mask_file_id: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub response_id: Option<String>,
    pub usage_json: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
