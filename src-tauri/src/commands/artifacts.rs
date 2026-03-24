use crate::AppState;
use aqbot_core::types::*;
use tauri::State;

#[tauri::command]
pub async fn list_artifacts(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Artifact>, String> {
    aqbot_core::repo::artifact::list_artifacts(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_artifact(
    state: State<'_, AppState>,
    input: CreateArtifactInput,
) -> Result<Artifact, String> {
    aqbot_core::repo::artifact::create_artifact(&state.sea_db, &input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_artifact(
    state: State<'_, AppState>,
    id: String,
    input: UpdateArtifactInput,
) -> Result<Artifact, String> {
    aqbot_core::repo::artifact::update_artifact(&state.sea_db, &id, &input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_artifact(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    aqbot_core::repo::artifact::delete_artifact(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}
