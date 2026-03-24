use crate::AppState;
use aqbot_core::types::*;
use tauri::AppHandle;
use tauri::State;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), String> {
    aqbot_core::repo::settings::save_settings(&state.sea_db, &settings)
        .await
        .map_err(|e| e.to_string())?;

    crate::tray::sync_tray_language(&app, &settings.language)
        .map_err(|e| e.to_string())
}
