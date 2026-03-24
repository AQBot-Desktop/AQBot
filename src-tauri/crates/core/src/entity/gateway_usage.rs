use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "gateway_usage")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub key_id: String,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub request_tokens: i32,
    pub response_tokens: i32,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::gateway_keys::Entity",
        from = "Column::KeyId",
        to = "super::gateway_keys::Column::Id"
    )]
    GatewayKeys,
}

impl Related<super::gateway_keys::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::GatewayKeys.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
