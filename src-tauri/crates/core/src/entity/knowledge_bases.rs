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
