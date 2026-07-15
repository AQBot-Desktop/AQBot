use sea_orm::*;

use crate::entity::tool_executions;
use crate::error::{AQBotError, Result};
use crate::inline_media::filter_complete_inline_data;
use crate::types::ToolExecution;
use crate::utils::gen_id;

fn sanitize_preview(value: Option<&str>) -> Option<String> {
    value.map(filter_complete_inline_data)
}

fn sanitize_text(value: &str) -> String {
    filter_complete_inline_data(value)
}

fn model_to_tool_execution(m: tool_executions::Model) -> ToolExecution {
    ToolExecution {
        id: sanitize_text(&m.id),
        conversation_id: sanitize_text(&m.conversation_id),
        message_id: sanitize_preview(m.message_id.as_deref()),
        server_id: sanitize_text(&m.server_id),
        tool_name: sanitize_text(&m.tool_name),
        status: sanitize_text(&m.status),
        input_preview: sanitize_preview(m.input_preview.as_deref()),
        output_preview: sanitize_preview(m.output_preview.as_deref()),
        error_message: sanitize_preview(m.error_message.as_deref()),
        duration_ms: m.duration_ms,
        created_at: sanitize_text(&m.created_at),
        approval_status: sanitize_preview(m.approval_status.as_deref()),
    }
}

pub async fn list_tool_executions(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Vec<ToolExecution>> {
    let rows = tool_executions::Entity::find()
        .filter(tool_executions::Column::ConversationId.eq(conversation_id))
        .order_by_desc(tool_executions::Column::CreatedAt)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(model_to_tool_execution).collect())
}

pub async fn create_tool_execution(
    db: &DatabaseConnection,
    conversation_id: &str,
    message_id: Option<&str>,
    server_id: &str,
    tool_name: &str,
    input_preview: Option<&str>,
    approval_status: Option<&str>,
) -> Result<ToolExecution> {
    let id = gen_id();
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    tool_executions::ActiveModel {
        id: Set(id.clone()),
        conversation_id: Set(conversation_id.to_string()),
        message_id: Set(message_id.map(|s| s.to_string())),
        server_id: Set(sanitize_text(server_id)),
        tool_name: Set(sanitize_text(tool_name)),
        status: Set("pending".to_string()),
        input_preview: Set(sanitize_preview(input_preview)),
        output_preview: Set(None),
        error_message: Set(None),
        duration_ms: Set(None),
        created_at: Set(now),
        approval_status: Set(sanitize_preview(approval_status)),
    }
    .insert(db)
    .await?;

    let model = tool_executions::Entity::find_by_id(&id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ToolExecution {}", id)))?;

    Ok(model_to_tool_execution(model))
}

pub async fn update_tool_execution_status(
    db: &DatabaseConnection,
    id: &str,
    status: &str,
    output: Option<&str>,
    error: Option<&str>,
) -> Result<()> {
    let model = tool_executions::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ToolExecution {}", id)))?;

    let mut am: tool_executions::ActiveModel = model.into();
    am.status = Set(sanitize_text(status));
    am.output_preview = Set(sanitize_preview(output));
    am.error_message = Set(sanitize_preview(error));
    am.update(db).await?;

    Ok(())
}

pub async fn update_tool_execution_approval_status(
    db: &DatabaseConnection,
    id: &str,
    approval_status: &str,
) -> Result<()> {
    let model = tool_executions::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ToolExecution {}", id)))?;

    let mut am: tool_executions::ActiveModel = model.into();
    am.approval_status = Set(Some(sanitize_text(approval_status)));
    am.update(db).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn previews_are_sanitized_before_persistence() {
        let db = crate::db::create_test_pool().await.unwrap().conn;
        let conversation = crate::repo::conversation::create_conversation(
            &db,
            "Tool execution media",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let execution = create_tool_execution(
            &db,
            &conversation.id,
            None,
            "server-data:image/png;base64,SERVER_SECRET",
            "image_tool-data:image/png;base64,TOOL_SECRET",
            Some(r#"{\"image\":\"data:image/png;base64,INPUT_SECRET\"}"#),
            Some("pending-data:image/png;base64,APPROVAL_SECRET"),
        )
        .await
        .unwrap();

        update_tool_execution_status(
            &db,
            &execution.id,
            "failed-data:image/gif;base64,STATUS_SECRET",
            Some("data:image/jpeg;base64,OUTPUT_SECRET"),
            Some("data:image/webp;base64,ERROR_SECRET"),
        )
        .await
        .unwrap();

        let stored = tool_executions::Entity::find_by_id(&execution.id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        let serialized = serde_json::to_string(&stored).unwrap();

        assert!(!serialized.to_ascii_lowercase().contains("data:image/"));
        assert!(!serialized.contains("INPUT_SECRET"));
        assert!(!serialized.contains("OUTPUT_SECRET"));
        assert!(!serialized.contains("ERROR_SECRET"));
        assert!(!serialized.contains("SERVER_SECRET"));
        assert!(!serialized.contains("TOOL_SECRET"));
        assert!(!serialized.contains("APPROVAL_SECRET"));
        assert!(!serialized.contains("STATUS_SECRET"));
    }
}
