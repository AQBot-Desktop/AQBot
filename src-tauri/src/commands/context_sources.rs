use crate::AppState;
use aqbot_core::types::*;
use tauri::State;

#[tauri::command]
pub async fn list_context_sources(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<ContextSource>, String> {
    aqbot_core::repo::context_source::list_context_sources(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_context_source(
    state: State<'_, AppState>,
    input: CreateContextSourceInput,
) -> Result<ContextSource, String> {
    aqbot_core::repo::context_source::add_context_source(&state.sea_db, &input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_context_source(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    aqbot_core::repo::context_source::remove_context_source(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_context_source(
    state: State<'_, AppState>,
    id: String,
) -> Result<ContextSource, String> {
    aqbot_core::repo::context_source::toggle_context_source(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}
