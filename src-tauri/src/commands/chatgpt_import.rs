use crate::AppState;
use aqbot_core::repo::chatgpt_import::{
    ChatGptImportResult, ChatGptImportSummary, ChatGptImportWarning,
};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn scan_chatgpt_import(
    state: State<'_, AppState>,
    path: String,
) -> Result<ChatGptImportSummary, String> {
    aqbot_core::repo::chatgpt_import::scan_chatgpt_import_from_path(
        &state.sea_db,
        &PathBuf::from(path),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_chatgpt_export(
    state: State<'_, AppState>,
    path: String,
) -> Result<ChatGptImportResult, String> {
    let before = super::import_media::pending_snapshot(&state.sea_db).await?;
    let mut result = aqbot_core::repo::chatgpt_import::import_chatgpt_export_from_path(
        &state.sea_db,
        &PathBuf::from(path),
    )
    .await
    .map_err(|e| e.to_string())?;
    match super::import_media::materialize_new_candidates(&state.sea_db, &before).await {
        Ok(report) => result
            .warnings
            .extend(
                report
                    .failures
                    .into_iter()
                    .map(|failure| ChatGptImportWarning {
                        code: "inline_media_materialization_failed".to_string(),
                        message: failure.error,
                        source_id: Some(failure.message_id),
                    }),
            ),
        Err(error) => result.warnings.push(ChatGptImportWarning {
            code: "inline_media_materialization_failed".to_string(),
            message: error,
            source_id: None,
        }),
    }
    Ok(result)
}
