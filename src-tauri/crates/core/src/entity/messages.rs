use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "messages")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub token_count: Option<i64>,
    pub attachments: String,
    pub thinking: Option<String>,
    pub created_at: i64,
    pub branch_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub version_index: i32,
    pub is_active: i32,
    pub tool_calls_json: Option<String>,
    pub tool_call_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::conversations::Entity",
        from = "Column::ConversationId",
        to = "super::conversations::Column::Id"
    )]
    Conversation,
}

impl Related<super::conversations::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Conversation.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
