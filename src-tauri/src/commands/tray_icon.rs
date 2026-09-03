use aqbot_core::{file_store::FileStore, repo::tray_icon as repo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::tray_icon::{self, TrayRuntime};

const CHANGED_EVENT: &str = "aqbot:tray-icon-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayIconStatus {
    revision: u64,
    tray_icon_file_id: Option<String>,
    applied: bool,
    error: Option<String>,
    warnings: Vec<String>,
}

async fn status(app: &AppHandle, runtime: &TrayRuntime) -> Result<TrayIconStatus, String> {
    let state = app.state::<crate::AppState>();
    let id = repo::file_id(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    Ok(current_status(app, runtime, id))
}

fn current_status(app: &AppHandle, runtime: &TrayRuntime, id: Option<String>) -> TrayIconStatus {
    TrayIconStatus {
        revision: runtime.revision,
        tray_icon_file_id: id,
        applied: runtime.applied.is_some()
            && runtime.error.is_none()
            && crate::tray::tray_exists(app),
        error: runtime.error.clone(),
        warnings: Vec::new(),
    }
}

#[tauri::command]
pub async fn get_tray_icon_status(app: AppHandle) -> Result<TrayIconStatus, String> {
    status(&app, &*tray_icon::runtime().lock().await).await
}

#[tauri::command]
pub async fn set_custom_tray_icon(
    app: AppHandle,
    data: String,
    mime_type: String,
) -> Result<TrayIconStatus, String> {
    let png = tauri::async_runtime::spawn_blocking(move || {
        crate::tray_icon_image::normalize(&data, &mime_type)
    })
    .await
    .map_err(|error| error.to_string())??;
    change(&app, Some(png)).await
}

#[tauri::command]
pub async fn reset_tray_icon(app: AppHandle) -> Result<TrayIconStatus, String> {
    change(&app, None).await
}

// Keep this ordered transaction and its compensation in one scope so both
// locks cover native rollback, database rollback, and physical-file cleanup.
async fn change(app: &AppHandle, png: Option<Vec<u8>>) -> Result<TrayIconStatus, String> {
    let mut runtime = tray_icon::runtime().lock().await;
    let _file_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let state = app.state::<crate::AppState>();
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    let store = FileStore::new();
    let id = aqbot_core::utils::gen_id();
    let name = format!("tray-icon-{id}.png");
    let desired = match &png {
        Some(bytes) => tray_icon::custom(bytes, &id)?,
        None => tray_icon::builtin(&settings)?,
    };
    // Reuse the current file only after verifying its actual bytes on disk.
    if let (Some(bytes), Some(current_id)) = (&png, &settings.tray_icon_file_id) {
        match tray_icon::load_custom(app, current_id).await {
            Ok(current) => {
                if current.fingerprint == format!("{current_id}:{}", FileStore::hash_bytes(bytes)) {
                    // A previous failure must not turn an explicit retry into a no-op.
                    let result = tray_icon::apply_native(app, &settings, &current);
                    if let Err(error) = result {
                        return Err(restore_after_error(app, &settings, &mut runtime, error));
                    }
                    runtime.applied = settings.tray_enabled.then_some(current);
                    runtime.error = None;
                    runtime.revision += 1;
                    tray_icon::update_availability(app);
                    return publish(app, current_status(app, &runtime, Some(current_id.clone())));
                }
            }
            Err(error) => tracing::warn!(%error, "Replacing an unreadable custom tray image"),
        }
    }
    let saved = png
        .as_ref()
        .map(|bytes| store.save_file(bytes, &name, "image/png"))
        .transpose()
        .map_err(|error| error.to_string())?;
    let new_icon = saved.as_ref().map(|saved| repo::NewIcon {
        id: &id,
        saved,
        name: &name,
    });
    let mut native_attempted = false;
    let result = repo::commit_change(&state.sea_db, new_icon, || {
        native_attempted = true;
        tray_icon::apply_native(app, &settings, &desired)
    })
    .await;
    let paths = match result {
        Ok(paths) => paths,
        Err(error) => {
            let mut error = if native_attempted {
                restore_after_error(app, &settings, &mut runtime, error)
            } else {
                error
            };
            if let Some(saved) = saved.filter(|saved| saved.created) {
                let cleanup = async {
                    let references =
                        aqbot_core::repo::stored_file::count_stored_files_with_storage_path(
                            &state.sea_db,
                            &saved.storage_path,
                        )
                        .await?;
                    if references == 0 {
                        store.delete_file(&saved.storage_path)?;
                    }
                    Ok::<(), aqbot_core::error::AQBotError>(())
                }
                .await;
                if let Err(cleanup) = cleanup {
                    error.push_str(&format!("; new image cleanup failed: {cleanup}"));
                }
            }
            tracing::error!(%error, "Tray icon change failed");
            return Err(error);
        }
    };
    runtime.applied = settings.tray_enabled.then_some(desired);
    runtime.error = None;
    runtime.revision += 1;
    tray_icon::update_availability(app);
    let mut result = current_status(app, &runtime, png.as_ref().map(|_| id));
    for path in paths {
        if let Err(error) = store.delete_file(&path) {
            tracing::warn!(%error, %path, "Tray icon saved but old image cleanup failed");
            result.warnings.push("tray_icon_cleanup_failed".into());
        }
    }
    publish(app, result)
}

fn publish(app: &AppHandle, mut result: TrayIconStatus) -> Result<TrayIconStatus, String> {
    if let Err(error) = app.emit(CHANGED_EVENT, &result) {
        tracing::warn!(%error, "Tray icon saved but change notification failed");
        result.warnings.push("tray_icon_notification_failed".into());
    }
    Ok(result)
}

fn restore_after_error(
    app: &AppHandle,
    settings: &aqbot_core::types::AppSettings,
    runtime: &mut TrayRuntime,
    error: String,
) -> String {
    let error = match tray_icon::restore_native(app, settings, runtime.applied.as_ref()) {
        Ok(()) => error,
        Err(rollback) => format!("{error}; native rollback failed: {rollback}"),
    };
    runtime.error = Some(error.clone());
    runtime.revision += 1;
    tracing::error!(%error, "Tray icon change could not be applied");
    tray_icon::update_availability(app);
    error
}
