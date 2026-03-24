use sea_orm::*;

use crate::entity::tool_executions;
use crate::error::{AQBotError, Result};
use crate::types::ToolExecution;
use crate::utils::gen_id;

fn model_to_tool_execution(m: tool_executions::Model) -> ToolExecution {
    ToolExecution {
        id: m.id,
        conversation_id: m.conversation_id,
        message_id: m.message_id,
        server_id: m.server_id,
        tool_name: m.tool_name,
        status: m.status,
        input_preview: m.input_preview,
        output_preview: m.output_preview,
        error_message: m.error_message,
        duration_ms: m.duration_ms,
        created_at: m.created_at,
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
) -> Result<ToolExecution> {
    let id = gen_id();
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    tool_executions::ActiveModel {
        id: Set(id.clone()),
        conversation_id: Set(conversation_id.to_string()),
        message_id: Set(message_id.map(|s| s.to_string())),
        server_id: Set(server_id.to_string()),
        tool_name: Set(tool_name.to_string()),
        status: Set("pending".to_string()),
        input_preview: Set(input_preview.map(|s| s.to_string())),
        output_preview: Set(None),
        error_message: Set(None),
        duration_ms: Set(None),
        created_at: Set(now),
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
    am.status = Set(status.to_string());
    am.output_preview = Set(output.map(|s| s.to_string()));
    am.error_message = Set(error.map(|s| s.to_string()));
    am.update(db).await?;

    Ok(())
}
