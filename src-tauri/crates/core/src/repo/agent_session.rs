use crate::entity::agent_sessions;
use crate::error::{AQBotError, Result};
use crate::types::AgentSession;
use crate::utils::gen_id;
use sea_orm::sea_query::Expr;
use sea_orm::*;

fn model_to_agent_session(model: agent_sessions::Model) -> AgentSession {
    AgentSession {
        id: model.id,
        conversation_id: model.conversation_id,
        cwd: model.cwd,
        permission_mode: model.permission_mode,
        runtime_status: model.runtime_status,
        sdk_context_json: model.sdk_context_json,
        sdk_context_backup_json: model.sdk_context_backup_json,
        total_tokens: model.total_tokens,
        total_cost_usd: model.total_cost_usd,
        created_at: model.created_at,
        updated_at: model.updated_at,
    }
}

/// Upsert an agent session. If no session exists for the conversation, create one.
/// If one exists, update the provided fields.
pub async fn upsert_agent_session(
    db: &DatabaseConnection,
    conversation_id: &str,
    cwd: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<AgentSession> {
    let existing = agent_sessions::Entity::find()
        .filter(agent_sessions::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await?;

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    if let Some(model) = existing {
        let mut am: agent_sessions::ActiveModel = model.into();
        if let Some(cwd) = cwd {
            am.cwd = Set(Some(cwd.to_string()));
        }
        if let Some(pm) = permission_mode {
            am.permission_mode = Set(pm.to_string());
        }
        am.updated_at = Set(now);
        let updated = am.update(db).await?;
        Ok(model_to_agent_session(updated))
    } else {
        let id = gen_id();
        let model = agent_sessions::ActiveModel {
            id: Set(id),
            conversation_id: Set(conversation_id.to_string()),
            cwd: Set(cwd.map(|s| s.to_string())),
            permission_mode: Set(permission_mode.unwrap_or("default").to_string()),
            runtime_status: Set("idle".to_string()),
            sdk_context_json: Set(None),
            sdk_context_backup_json: Set(None),
            total_tokens: Set(0),
            total_cost_usd: Set(0.0),
            created_at: Set(now.clone()),
            updated_at: Set(now),
        };
        let inserted = model.insert(db).await?;
        Ok(model_to_agent_session(inserted))
    }
}

/// Get agent session by conversation ID.
pub async fn get_agent_session_by_conversation_id(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Option<AgentSession>> {
    let model = agent_sessions::Entity::find()
        .filter(agent_sessions::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await?;

    Ok(model.map(model_to_agent_session))
}

/// Update runtime status of an agent session.
pub async fn update_agent_session_status(
    db: &DatabaseConnection,
    id: &str,
    runtime_status: &str,
) -> Result<()> {
    let model = agent_sessions::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("AgentSession {}", id)))?;

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut am: agent_sessions::ActiveModel = model.into();
    am.runtime_status = Set(runtime_status.to_string());
    am.updated_at = Set(now);
    am.update(db).await?;
    Ok(())
}

/// Update the working directory of an agent session.
pub async fn update_agent_session_cwd(db: &DatabaseConnection, id: &str, cwd: &str) -> Result<()> {
    let model = agent_sessions::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("AgentSession {}", id)))?;

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut am: agent_sessions::ActiveModel = model.into();
    am.cwd = Set(Some(cwd.to_string()));
    am.updated_at = Set(now);
    am.update(db).await?;
    Ok(())
}

/// Update the permission mode of an agent session.
pub async fn update_agent_session_permission_mode(
    db: &DatabaseConnection,
    id: &str,
    permission_mode: &str,
) -> Result<()> {
    let model = agent_sessions::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("AgentSession {}", id)))?;

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut am: agent_sessions::ActiveModel = model.into();
    am.permission_mode = Set(permission_mode.to_string());
    am.updated_at = Set(now);
    am.update(db).await?;
    Ok(())
}

/// Reset all running/waiting_approval sessions to idle (for app startup recovery).
pub async fn reset_running_sessions(db: &DatabaseConnection) -> Result<u64> {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let result = agent_sessions::Entity::update_many()
        .col_expr(agent_sessions::Column::RuntimeStatus, Expr::value("idle"))
        .col_expr(agent_sessions::Column::UpdatedAt, Expr::value(now))
        .filter(
            Condition::any()
                .add(agent_sessions::Column::RuntimeStatus.eq("running"))
                .add(agent_sessions::Column::RuntimeStatus.eq("waiting_approval")),
        )
        .exec(db)
        .await?;

    Ok(result.rows_affected)
}

/// Update sdk_context_json, total_tokens, and total_cost_usd after a successful query.
pub async fn update_agent_session_after_query(
    db: &DatabaseConnection,
    id: &str,
    runtime_status: &str,
    sdk_context_json: Option<&str>,
    tokens_delta: i32,
    cost_delta: f64,
) -> Result<()> {
    let model = agent_sessions::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("AgentSession {}", id)))?;

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut am: agent_sessions::ActiveModel = model.clone().into();
    am.runtime_status = Set(runtime_status.to_string());
    if let Some(ctx) = sdk_context_json {
        am.sdk_context_json = Set(Some(ctx.to_string()));
    }
    am.total_tokens = Set(model.total_tokens + tokens_delta);
    am.total_cost_usd = Set(model.total_cost_usd + cost_delta);
    am.updated_at = Set(now);
    am.update(db).await?;
    Ok(())
}

/// Clear the sdk_context_json for an agent session by conversation_id.
/// Called when conversation messages are cleared to prevent stale history.
pub async fn clear_sdk_context_by_conversation_id(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<()> {
    let session = agent_sessions::Entity::find()
        .filter(agent_sessions::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await?;

    if let Some(model) = session {
        let mut am: agent_sessions::ActiveModel = model.into();
        am.sdk_context_json = Set(None);
        am.sdk_context_backup_json = Set(None);
        am.update(db).await?;
    }
    Ok(())
}

/// Backup current sdk_context_json and clear it.
/// Called when a context-clear marker is inserted.
pub async fn backup_and_clear_sdk_context_by_conversation_id(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<()> {
    let session = agent_sessions::Entity::find()
        .filter(agent_sessions::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await?;

    if let Some(model) = session {
        let mut am: agent_sessions::ActiveModel = model.clone().into();
        am.sdk_context_backup_json = Set(model.sdk_context_json);
        am.sdk_context_json = Set(None);
        am.update(db).await?;
    }
    Ok(())
}

/// Restore sdk_context_json from backup.
/// Called when a context-clear marker is removed (undo).
pub async fn restore_sdk_context_from_backup_by_conversation_id(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<()> {
    let session = agent_sessions::Entity::find()
        .filter(agent_sessions::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await?;

    if let Some(model) = session {
        if model.sdk_context_backup_json.is_some() {
            let mut am: agent_sessions::ActiveModel = model.clone().into();
            am.sdk_context_json = Set(model.sdk_context_backup_json);
            am.sdk_context_backup_json = Set(None);
            am.update(db).await?;
        }
    }
    Ok(())
}
