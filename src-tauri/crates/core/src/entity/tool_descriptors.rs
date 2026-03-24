use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "tool_descriptors")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub description: Option<String>,
    pub input_schema_json: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::mcp_servers::Entity",
        from = "Column::ServerId",
        to = "super::mcp_servers::Column::Id"
    )]
    McpServers,
}

impl Related<super::mcp_servers::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::McpServers.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
