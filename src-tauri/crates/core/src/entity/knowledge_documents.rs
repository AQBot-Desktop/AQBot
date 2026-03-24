use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "knowledge_documents")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub knowledge_base_id: String,
    pub title: String,
    pub source_path: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub indexing_status: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::knowledge_bases::Entity",
        from = "Column::KnowledgeBaseId",
        to = "super::knowledge_bases::Column::Id",
        on_delete = "Cascade"
    )]
    KnowledgeBase,
}

impl Related<super::knowledge_bases::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::KnowledgeBase.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
