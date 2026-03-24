use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "context_sources")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    #[sea_orm(column_name = "type")]
    pub source_type: String,
    pub ref_id: String,
    pub title: String,
    pub enabled: i32,
    #[sea_orm(column_type = "Text", nullable)]
    pub summary: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
