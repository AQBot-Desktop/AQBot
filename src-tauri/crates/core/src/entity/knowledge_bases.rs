use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "knowledge_bases")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub description: Option<String>,
    pub embedding_provider: Option<String>,
    pub enabled: i32,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub sort_order: i32,
    pub embedding_dimensions: Option<i32>,
    pub retrieval_threshold: Option<f32>,
    pub retrieval_top_k: Option<i32>,
    pub rerank_provider: Option<String>,
    pub rerank_candidate_k: Option<i32>,
    pub chunk_size: Option<i32>,
    pub chunk_overlap: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub separator: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::knowledge_documents::Entity")]
    KnowledgeDocuments,
}

impl Related<super::knowledge_documents::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::KnowledgeDocuments.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
