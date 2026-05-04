use crate::AppState;
use aqbot_core::types::*;
use tauri::State;

#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Message>, String> {
    aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_messages_page(
    state: State<'_, AppState>,
    conversation_id: String,
    limit: Option<u64>,
    before_message_id: Option<String>,
) -> Result<MessagePage, String> {
    aqbot_core::repo::message::list_messages_page(
        &state.sea_db,
        &conversation_id,
        limit.unwrap_or(10),
        before_message_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_message(state: State<'_, AppState>, id: String) -> Result<(), String> {
    aqbot_core::repo::message::delete_message(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_message_content(
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<Message, String> {
    aqbot_core::repo::message::update_message_content(&state.sea_db, &id, &content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_conversation_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<u64, String> {
    let rows =
        aqbot_core::repo::message::clear_conversation_messages(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

    // Also clear the agent session's SDK context so the agent doesn't retain old history
    let _ = aqbot_core::repo::agent_session::clear_sdk_context_by_conversation_id(
        &state.sea_db,
        &conversation_id,
    )
    .await;

    Ok(rows)
}

#[tauri::command]
pub async fn export_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    format: String,
) -> Result<String, String> {
    let conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    match format.as_str() {
        "json" => serde_json::to_string_pretty(&serde_json::json!({
            "conversation": conversation,
            "messages": messages,
        }))
        .map_err(|e| e.to_string()),
        "markdown" => {
            let mut md = format!("# {}\n\n", conversation.title);
            for msg in &messages {
                let role = match msg.role {
                    MessageRole::System => "System",
                    MessageRole::User => "User",
                    MessageRole::Assistant => "Assistant",
                    MessageRole::Tool => "Tool",
                };
                md.push_str(&format!("## {}\n\n{}\n\n", role, msg.content));
            }
            Ok(md)
        }
        _ => Err(format!("Unsupported export format: {}", format)),
    }
}

#[tauri::command]
pub async fn get_conversation_stats(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ConversationStats, String> {
    aqbot_core::repo::message::get_conversation_stats(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}
