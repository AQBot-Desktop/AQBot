use crate::AppState;
use aqbot_core::repo::cherry_import::{
    CherryStudioImportOptions, CherryStudioImportResult, CherryStudioImportSummary,
    CherryStudioImportWarning,
};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn scan_cherry_studio_import(
    state: State<'_, AppState>,
    path: String,
) -> Result<CherryStudioImportSummary, String> {
    aqbot_core::repo::cherry_import::scan_cherry_studio_import_from_path(
        &state.sea_db,
        &PathBuf::from(path),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_cherry_studio_backup(
    state: State<'_, AppState>,
    path: String,
    options: CherryStudioImportOptions,
) -> Result<CherryStudioImportResult, String> {
    let before = super::import_media::pending_snapshot(&state.sea_db).await?;
    let mut result = aqbot_core::repo::cherry_import::import_cherry_studio_backup_from_path(
        &state.sea_db,
        &state.master_key,
        &PathBuf::from(path),
        options,
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
                    .map(|failure| CherryStudioImportWarning {
                        code: "inline_media_materialization_failed".to_string(),
                        message: failure.error,
                        source_id: Some(failure.message_id),
                    }),
            ),
        Err(error) => result.warnings.push(CherryStudioImportWarning {
            code: "inline_media_materialization_failed".to_string(),
            message: error,
            source_id: None,
        }),
    }
    Ok(result)
}
