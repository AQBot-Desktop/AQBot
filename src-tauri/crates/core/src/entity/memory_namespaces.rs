use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "memory_namespaces")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    pub scope: String,
    pub embedding_provider: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::memory_items::Entity")]
    MemoryItems,
}

impl Related<super::memory_items::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::MemoryItems.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
