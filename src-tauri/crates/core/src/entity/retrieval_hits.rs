use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "retrieval_hits")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub knowledge_base_id: String,
    pub document_id: String,
    pub chunk_ref: String,
    pub score: f64,
    #[sea_orm(column_type = "Text")]
    pub preview: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
