use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "gateway_request_logs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub key_id: String,
    pub key_name: String,
    pub method: String,
    pub path: String,
    pub model: Option<String>,
    pub provider_id: Option<String>,
    pub status_code: i32,
    pub duration_ms: i32,
    pub request_tokens: i32,
    pub response_tokens: i32,
    pub error_message: Option<String>,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
