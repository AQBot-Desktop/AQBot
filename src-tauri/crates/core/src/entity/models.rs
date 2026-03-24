use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "models")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub provider_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub model_id: String,
    pub name: String,
    pub group_name: Option<String>,
    pub model_type: String,
    pub capabilities: String,
    pub max_tokens: Option<i64>,
    pub enabled: i32,
    pub param_overrides: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::providers::Entity",
        from = "Column::ProviderId",
        to = "super::providers::Column::Id"
    )]
    Provider,
}

impl Related<super::providers::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Provider.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
