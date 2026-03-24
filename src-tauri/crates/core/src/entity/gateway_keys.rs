use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "gateway_keys")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    #[sea_orm(unique)]
    pub key_hash: String,
    pub key_prefix: String,
    pub enabled: i32,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub encrypted_key: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::gateway_usage::Entity")]
    GatewayUsage,
}

impl Related<super::gateway_usage::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::GatewayUsage.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
