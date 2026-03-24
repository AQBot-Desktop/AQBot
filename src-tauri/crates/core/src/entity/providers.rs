use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "providers")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub api_host: String,
    pub api_path: Option<String>,
    pub enabled: i32,
    pub proxy_config: Option<String>,
    pub sort_order: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::provider_keys::Entity")]
    ProviderKeys,
    #[sea_orm(has_many = "super::models::Entity")]
    Models,
}

impl Related<super::provider_keys::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ProviderKeys.def()
    }
}

impl Related<super::models::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Models.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
