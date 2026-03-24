use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "memory_items")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub namespace_id: String,
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub source: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::memory_namespaces::Entity",
        from = "Column::NamespaceId",
        to = "super::memory_namespaces::Column::Id",
        on_delete = "Cascade"
    )]
    MemoryNamespace,
}

impl Related<super::memory_namespaces::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::MemoryNamespace.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
