use sea_orm::*;
use sea_orm::sea_query::Expr;
use std::collections::HashSet;

use crate::entity::messages;
use crate::error::{AQBotError, Result};
use crate::types::{Attachment, Message, MessagePage, MessageRole};
use crate::utils::{gen_id, now_ts};

fn parse_role(s: &str) -> MessageRole {
    match s {
        "system" => MessageRole::System,
        "user" => MessageRole::User,
        "tool" => MessageRole::Tool,
        _ => MessageRole::Assistant,
    }
}

fn role_str(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

fn parse_attachment_list(raw: &str) -> Result<Vec<Attachment>> {
    serde_json::from_str(raw)
        .map_err(|e| AQBotError::Validation(format!("Invalid message attachments JSON: {e}")))
}

fn stringify_attachment_list(attachments: &[Attachment]) -> Result<String> {
    serde_json::to_string(attachments)
        .map_err(|e| AQBotError::Validation(format!("Failed to serialize message attachments: {e}")))
}

fn message_from_entity(m: messages::Model) -> Result<Message> {
    Ok(Message {
        id: m.id,
        conversation_id: m.conversation_id,
        role: parse_role(&m.role),
        content: m.content,
        provider_id: m.provider_id,
        model_id: m.model_id,
        token_count: m.token_count.map(|v| v as u32),
        attachments: parse_attachment_list(&m.attachments)?,
        thinking: m.thinking,
        created_at: m.created_at,
        parent_message_id: m.parent_message_id,
        version_index: m.version_index,
        is_active: m.is_active == 1,
        tool_calls_json: m.tool_calls_json,
        tool_call_id: m.tool_call_id,
    })
}

pub async fn list_messages(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Vec<Message>> {
    let rows = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::IsActive.eq(1))
        .order_by_asc(messages::Column::CreatedAt)
        .all(db)
        .await?;

    rows.into_iter().map(message_from_entity).collect()
}

pub async fn list_messages_page(
    db: &DatabaseConnection,
    conversation_id: &str,
    limit: u64,
    before_message_id: Option<&str>,
) -> Result<MessagePage> {
    let mut query = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::IsActive.eq(1));

    if let Some(cursor_id) = before_message_id {
        let cursor = messages::Entity::find_by_id(cursor_id)
            .one(db)
            .await?
            .ok_or_else(|| AQBotError::NotFound(format!("Message {}", cursor_id)))?;

        query = query.filter(
            Condition::any()
                .add(messages::Column::CreatedAt.lt(cursor.created_at))
                .add(
                    Condition::all()
                        .add(messages::Column::CreatedAt.eq(cursor.created_at))
                        .add(messages::Column::Id.lt(cursor.id.clone())),
                ),
        );
    }

    let mut rows = query
        .order_by_desc(messages::Column::CreatedAt)
        .order_by_desc(messages::Column::Id)
        .limit(limit + 1)
        .all(db)
        .await?;

    let has_older = rows.len() > limit as usize;
    if has_older {
        rows.truncate(limit as usize);
    }
    rows.reverse();

    let messages = rows
        .into_iter()
        .map(message_from_entity)
        .collect::<Result<Vec<_>>>()?;
    let oldest_message_id = messages.first().map(|message| message.id.clone());

    Ok(MessagePage {
        messages,
        has_older,
        oldest_message_id,
    })
}

pub async fn create_message(
    db: &DatabaseConnection,
    conversation_id: &str,
    role: MessageRole,
    content: &str,
    attachments: &[Attachment],
    parent_message_id: Option<&str>,
    version_index: i32,
) -> Result<Message> {
    let id = gen_id();
    let now = now_ts();
    let role_s = role_str(&role);
    let attachments_json = stringify_attachment_list(attachments)?;

    messages::ActiveModel {
        id: Set(id.clone()),
        conversation_id: Set(conversation_id.to_string()),
        role: Set(role_s.to_string()),
        content: Set(content.to_string()),
        attachments: Set(attachments_json),
        created_at: Set(now),
        parent_message_id: Set(parent_message_id.map(|s| s.to_string())),
        version_index: Set(version_index),
        is_active: Set(1),
        ..Default::default()
    }
    .insert(db)
    .await?;

    let row = messages::Entity::find_by_id(&id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Message {}", id)))?;
    message_from_entity(row)
}

pub async fn update_message_content(
    db: &DatabaseConnection,
    id: &str,
    content: &str,
) -> Result<Message> {
    let row = messages::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Message {}", id)))?;

    let mut am: messages::ActiveModel = row.into();
    am.content = Set(content.to_string());
    am.update(db).await?;

    let row = messages::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Message {}", id)))?;
    message_from_entity(row)
}

pub async fn delete_message(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = messages::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("Message {}", id)));
    }
    Ok(())
}

/// Delete all messages in a conversation.
pub async fn clear_conversation_messages(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<u64> {
    let result = messages::Entity::delete_many()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .exec(db)
        .await?;

    Ok(result.rows_affected)
}

/// Delete all messages in a conversation created after the given timestamp (inclusive).
pub async fn delete_messages_after(
    db: &DatabaseConnection,
    conversation_id: &str,
    created_at: i64,
) -> Result<u64> {
    let result = messages::Entity::delete_many()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::CreatedAt.gte(created_at))
        .exec(db)
        .await?;

    Ok(result.rows_affected)
}

pub async fn list_message_versions(
    db: &DatabaseConnection,
    conversation_id: &str,
    parent_message_id: &str,
) -> Result<Vec<Message>> {
    let rows = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::ParentMessageId.eq(parent_message_id))
        .filter(messages::Column::Role.eq("assistant"))
        .filter(messages::Column::VersionIndex.gte(0))
        .order_by_asc(messages::Column::VersionIndex)
        .all(db)
        .await?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let candidate_ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    let tool_rows = messages::Entity::find()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::Role.eq("tool"))
        .filter(messages::Column::ParentMessageId.is_in(candidate_ids.clone()))
        .all(db)
        .await?;

    let tool_parent_ids: HashSet<String> = tool_rows
        .into_iter()
        .filter_map(|row| row.parent_message_id)
        .collect();

    rows.into_iter()
        .filter(|row| !tool_parent_ids.contains(&row.id))
        .map(message_from_entity)
        .collect()
}

pub async fn set_active_version(
    db: &DatabaseConnection,
    conversation_id: &str,
    parent_message_id: &str,
    target_message_id: &str,
) -> Result<()> {
    // Deactivate all versions for this parent
    messages::Entity::update_many()
        .filter(messages::Column::ConversationId.eq(conversation_id))
        .filter(messages::Column::ParentMessageId.eq(parent_message_id))
        .col_expr(messages::Column::IsActive, Expr::value(0))
        .exec(db)
        .await?;
    // Activate target version
    let row = messages::Entity::find_by_id(target_message_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Message {}", target_message_id)))?;
    let mut am: messages::ActiveModel = row.into();
    am.is_active = Set(1);
    am.update(db).await?;
    Ok(())
}

pub async fn delete_message_group(
    db: &DatabaseConnection,
    user_message_id: &str,
) -> Result<u64> {
    // Delete all assistant versions for this user message
    let ai_result = messages::Entity::delete_many()
        .filter(messages::Column::ParentMessageId.eq(user_message_id))
        .exec(db)
        .await?;
    // Delete the user message itself
    messages::Entity::delete_by_id(user_message_id).exec(db).await?;
    Ok(ai_result.rows_affected + 1)
}

/// Create a message with role "tool" for storing tool execution results.
pub async fn create_tool_result_message(
    db: &DatabaseConnection,
    conversation_id: &str,
    tool_call_id: &str,
    content: &str,
    parent_message_id: &str,
) -> Result<()> {
    let id = crate::utils::gen_id();
    crate::entity::messages::ActiveModel {
        id: Set(id),
        conversation_id: Set(conversation_id.to_string()),
        role: Set("tool".to_string()),
        content: Set(content.to_string()),
        provider_id: Set(None),
        model_id: Set(None),
        token_count: Set(None),
        attachments: Set("[]".to_string()),
        thinking: Set(None),
        created_at: Set(crate::utils::now_ts()),
        branch_id: Set(None),
        parent_message_id: Set(Some(parent_message_id.to_string())),
        // Tool-result scaffolding: excluded from history reload (paired with intermediate assistant).
        version_index: Set(-1),
        is_active: Set(0),
        tool_calls_json: Set(None),
        tool_call_id: Set(Some(tool_call_id.to_string())),
    }
    .insert(db)
    .await?;
    Ok(())
}

/// Create an assistant message that contains tool_calls (intermediate message in tool loop).
pub async fn create_assistant_tool_call_message(
    db: &DatabaseConnection,
    conversation_id: &str,
    content: &str,
    tool_calls_json: Option<&str>,
    provider_id: &str,
    model_id: &str,
    parent_message_id: &str,
) -> Result<String> {
    let id = crate::utils::gen_id();
    crate::entity::messages::ActiveModel {
        id: Set(id.clone()),
        conversation_id: Set(conversation_id.to_string()),
        role: Set("assistant".to_string()),
        content: Set(content.to_string()),
        provider_id: Set(Some(provider_id.to_string())),
        model_id: Set(Some(model_id.to_string())),
        token_count: Set(None),
        attachments: Set("[]".to_string()),
        thinking: Set(None),
        created_at: Set(crate::utils::now_ts()),
        branch_id: Set(None),
        parent_message_id: Set(Some(parent_message_id.to_string())),
        // Intermediate tool-call scaffolding message. Excluded from user-visible AI version pagination.
        version_index: Set(-1),
        is_active: Set(0),
        tool_calls_json: Set(tool_calls_json.map(|s| s.to_string())),
        tool_call_id: Set(None),
    }
    .insert(db)
    .await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;
    use crate::repo::conversation;

    #[tokio::test]
    async fn create_message_round_trips_attachment_metadata() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;

        let conv = conversation::create_conversation(db, "Attach Chat", "m1", "p1", None)
            .await
            .unwrap();

        let msg = create_message(
            db,
            &conv.id,
            MessageRole::User,
            "See attached",
            &[Attachment {
                id: "att-1".into(),
                file_name: "image.png".into(),
                file_type: "image/png".into(),
                file_path: "conv-1/image.png".into(),
                file_size: 3,
                data: None,
            }],
            None,
            0,
        )
        .await
        .unwrap();

        assert_eq!(msg.attachments.len(), 1);
        assert_eq!(msg.attachments[0].file_name, "image.png");
        assert_eq!(msg.attachments[0].file_type, "image/png");
        assert_eq!(msg.attachments[0].file_path, "conv-1/image.png");
        assert_eq!(msg.attachments[0].file_size, 3);
    }
}
