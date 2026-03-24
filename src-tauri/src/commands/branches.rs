use crate::AppState;
use aqbot_core::types::*;
use tauri::State;

#[tauri::command]
pub async fn list_branches(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<ConversationBranch>, String> {
    aqbot_core::repo::conversation_branch::list_branches(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fork_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    message_id: String,
) -> Result<ConversationBranch, String> {
    aqbot_core::repo::conversation_branch::create_branch(
        &state.sea_db,
        &conversation_id,
        &message_id,
        "Branch",
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn compare_branches(
    _state: State<'_, AppState>,
    branch_a: String,
    branch_b: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "branch_a": branch_a,
        "branch_b": branch_b,
        "differences": []
    }))
}

#[tauri::command]
pub async fn get_workspace_snapshot(
    _state: State<'_, AppState>,
    conversation_id: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "conversation_id": conversation_id,
        "context_sources": [],
        "active_tools": [],
        "knowledge_bindings": [],
        "memory_policy": null,
        "search_policy": null,
        "artifacts": [],
        "branches": []
    }))
}

#[tauri::command]
pub async fn update_workspace_snapshot(
    _state: State<'_, AppState>,
    _conversation_id: String,
) -> Result<(), String> {
    Ok(())
}
