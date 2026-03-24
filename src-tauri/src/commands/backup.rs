use crate::AppState;
use aqbot_core::repo::backup;
use aqbot_core::repo::settings::get_settings;
use aqbot_core::types::*;
use sea_orm::DatabaseConnection;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

#[tauri::command]
pub async fn list_backups(
    state: State<'_, AppState>,
) -> Result<Vec<BackupManifest>, String> {
    backup::list_backups(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_backup(
    state: State<'_, AppState>,
    format: String,
) -> Result<BackupManifest, String> {
    let settings = get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    let backup_dir = backup::resolve_backup_dir(
        settings.backup_dir.as_deref(),
        &state.app_data_dir,
    );
    backup::create_backup(&state.sea_db, &format, &backup_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_backup(
    state: State<'_, AppState>,
    backup_id: String,
) -> Result<(), String> {
    let manifest = backup::get_backup(&state.sea_db, &backup_id)
        .await
        .map_err(|e| e.to_string())?;

    if manifest.version != "sqlite" {
        return Err("Only SQLite backups can be restored directly".to_string());
    }

    let backup_path = manifest
        .file_path
        .ok_or("Backup file path not available")?;
    let db_path = state
        .db_path
        .strip_prefix("sqlite:")
        .unwrap_or(&state.db_path);
    backup::restore_sqlite_backup(&backup_path, db_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_backup(
    state: State<'_, AppState>,
    backup_id: String,
) -> Result<(), String> {
    backup::delete_backup(&state.sea_db, &backup_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn batch_delete_backups(
    state: State<'_, AppState>,
    backup_ids: Vec<String>,
) -> Result<(), String> {
    backup::batch_delete_backups(&state.sea_db, &backup_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_backup_settings(
    state: State<'_, AppState>,
) -> Result<AutoBackupSettings, String> {
    let settings = get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    let default_dir = backup::resolve_backup_dir(None, &state.app_data_dir);
    Ok(AutoBackupSettings {
        enabled: settings.auto_backup_enabled,
        interval_hours: settings.auto_backup_interval_hours,
        max_count: settings.auto_backup_max_count,
        backup_dir: Some(
            settings
                .backup_dir
                .unwrap_or_else(|| default_dir.to_string_lossy().to_string()),
        ),
    })
}

#[tauri::command]
pub async fn update_backup_settings(
    state: State<'_, AppState>,
    backup_settings: AutoBackupSettings,
) -> Result<(), String> {
    let mut settings = get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    settings.auto_backup_enabled = backup_settings.enabled;
    settings.auto_backup_interval_hours = backup_settings.interval_hours;
    settings.auto_backup_max_count = backup_settings.max_count;
    settings.backup_dir = backup_settings.backup_dir.clone();

    aqbot_core::repo::settings::save_settings(&state.sea_db, &settings)
        .await
        .map_err(|e| e.to_string())?;

    // Restart scheduler with new settings
    restart_auto_backup(
        &state.auto_backup_handle,
        &state.sea_db,
        &state.app_data_dir,
        &backup_settings,
    )
    .await;

    Ok(())
}

/// Start or restart the auto-backup scheduler
async fn restart_auto_backup(
    handle: &Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    db: &DatabaseConnection,
    app_data_dir: &PathBuf,
    settings: &AutoBackupSettings,
) {
    let mut guard = handle.lock().await;

    // Stop existing scheduler
    if let Some(h) = guard.take() {
        h.abort();
    }

    if !settings.enabled || settings.interval_hours == 0 {
        return;
    }

    let db = db.clone();
    let app_dir = app_data_dir.clone();
    let interval_hours = settings.interval_hours;
    let max_count = settings.max_count;

    let task = tokio::spawn(async move {
        let interval = std::time::Duration::from_secs(interval_hours as u64 * 3600);
        loop {
            tokio::time::sleep(interval).await;

            // Read current settings to get backup_dir
            let backup_dir = match get_settings(&db).await {
                Ok(s) => backup::resolve_backup_dir(s.backup_dir.as_deref(), &app_dir),
                Err(_) => backup::resolve_backup_dir(None, &app_dir),
            };

            // Create auto backup (SQLite format for speed)
            if let Err(e) = backup::create_backup(&db, "sqlite", &backup_dir).await {
                tracing::warn!("Auto-backup failed: {}", e);
            } else {
                tracing::info!("Auto-backup created successfully");
                // Cleanup old backups
                if let Err(e) = backup::cleanup_old_backups(&db, max_count).await {
                    tracing::warn!("Auto-backup cleanup failed: {}", e);
                }
            }
        }
    });

    *guard = Some(task);
}
