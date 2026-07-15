use crate::AppState;
use aqbot_core::repo::kelivo_import::{
    ThirdPartyImportOptions, ThirdPartyImportResult, ThirdPartyImportSummary,
    ThirdPartyImportWarning,
};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn scan_kelivo_import(
    state: State<'_, AppState>,
    path: String,
) -> Result<ThirdPartyImportSummary, String> {
    aqbot_core::repo::kelivo_import::scan_kelivo_import_from_path(
        &state.sea_db,
        &PathBuf::from(path),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_kelivo_backup(
    state: State<'_, AppState>,
    path: String,
    options: ThirdPartyImportOptions,
) -> Result<ThirdPartyImportResult, String> {
    let before = super::import_media::pending_snapshot(&state.sea_db).await?;
    let mut result = aqbot_core::repo::kelivo_import::import_kelivo_backup_from_path(
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
                    .map(|failure| ThirdPartyImportWarning {
                        code: "inline_media_materialization_failed".to_string(),
                        message: failure.error,
                        source_id: Some(failure.message_id),
                    }),
            ),
        Err(error) => result.warnings.push(ThirdPartyImportWarning {
            code: "inline_media_materialization_failed".to_string(),
            message: error,
            source_id: None,
        }),
    }
    Ok(result)
}
