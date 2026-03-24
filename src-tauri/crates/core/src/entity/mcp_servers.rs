use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "mcp_servers")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args_json: Option<String>,
    pub endpoint: Option<String>,
    pub env_json: Option<String>,
    pub enabled: i32,
    pub permission_policy: String,
    pub source: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::tool_descriptors::Entity")]
    ToolDescriptors,
}

impl Related<super::tool_descriptors::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ToolDescriptors.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
