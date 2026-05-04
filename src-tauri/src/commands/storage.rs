use crate::AppState;
use aqbot_core::storage_inventory::{self, StorageInventory};
use aqbot_core::storage_paths;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn get_storage_inventory() -> Result<StorageInventory, String> {
    Ok(storage_inventory::scan_storage())
}

#[tauri::command]
pub async fn open_storage_directory(app: tauri::AppHandle) -> Result<(), String> {
    let root = storage_paths::documents_root();
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&root)
        .map_err(|e| e.to_string())
}

// -- Change documents root --

#[derive(Debug, Serialize)]
pub struct ChangeDocumentsRootResult {
    pub files_moved: usize,
    pub files_failed: usize,
}

/// Validate a candidate documents root directory.
/// Returns (is_empty, exists, writable).
#[tauri::command]
pub async fn validate_documents_root(path: String) -> Result<ValidateResult, String> {
    let target = PathBuf::from(&path);

    if !target.is_absolute() {
        return Err("路径必须是绝对路径".into());
    }

    let exists = target.exists();

    // Create if missing (to test writability), then remove if we created it.
    let created_now = if !exists {
        std::fs::create_dir_all(&target).map_err(|e| format!("无法创建目录: {e}"))?;
        true
    } else {
        false
    };

    // Test writability
    let probe = target.join(".aqbot_write_probe");
    let writable = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);

    // Check emptiness
    let is_empty = match std::fs::read_dir(&target) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => true,
    };

    // Clean up if we created the dir
    if created_now && is_empty {
        let _ = std::fs::remove_dir(&target);
    }

    Ok(ValidateResult {
        exists,
        is_empty,
        writable,
    })
}

#[derive(Debug, Serialize)]
pub struct ValidateResult {
    pub exists: bool,
    pub is_empty: bool,
    pub writable: bool,
}

/// Change the documents root to `new_path`.
/// If `migrate` is true, copies all files from the current root.
#[tauri::command]
pub async fn change_documents_root(
    state: State<'_, AppState>,
    new_path: String,
    migrate: bool,
) -> Result<ChangeDocumentsRootResult, String> {
    let new_root = PathBuf::from(&new_path);
    let old_root = storage_paths::documents_root();

    if new_root == old_root {
        return Err("新目录与当前目录相同".into());
    }

    if !new_root.is_absolute() {
        return Err("路径必须是绝对路径".into());
    }

    // Ensure the target directory and subdirs exist
    for sub in &["images", "files", "backups"] {
        std::fs::create_dir_all(new_root.join(sub))
            .map_err(|e| format!("无法创建目录 {sub}: {e}"))?;
    }

    let mut result = ChangeDocumentsRootResult {
        files_moved: 0,
        files_failed: 0,
    };

    // Migrate files if requested — move (rename or copy+delete)
    if migrate {
        for sub in &["images", "files", "backups"] {
            let src_dir = old_root.join(sub);
            let dst_dir = new_root.join(sub);
            if !src_dir.exists() {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&src_dir) {
                for entry in entries.flatten() {
                    let meta = match entry.metadata() {
                        Ok(m) => m,
                        Err(_) => {
                            result.files_failed += 1;
                            continue;
                        }
                    };
                    if !meta.is_file() {
                        continue;
                    }
                    let src = entry.path();
                    let dst = dst_dir.join(entry.file_name());
                    if dst.exists() {
                        // Already at destination — delete source and count as moved
                        let _ = std::fs::remove_file(&src);
                        result.files_moved += 1;
                        continue;
                    }
                    // Try rename first (atomic, same filesystem)
                    if std::fs::rename(&src, &dst).is_ok() {
                        result.files_moved += 1;
                        continue;
                    }
                    // Cross-filesystem: copy then delete source
                    match std::fs::copy(&src, &dst) {
                        Ok(_) => {
                            let _ = std::fs::remove_file(&src);
                            result.files_moved += 1;
                        }
                        Err(e) => {
                            tracing::warn!(
                                src = %src.display(),
                                dst = %dst.display(),
                                error = %e,
                                "failed to move file during documents root change"
                            );
                            result.files_failed += 1;
                        }
                    }
                }
            }
        }
    }

    // Persist the setting
    let db = &state.sea_db;
    let mut settings = aqbot_core::repo::settings::get_settings(db)
        .await
        .map_err(|e| e.to_string())?;
    settings.documents_root_override = Some(new_path);
    aqbot_core::repo::settings::save_settings(db, &settings)
        .await
        .map_err(|e| e.to_string())?;

    // Update the in-process global so subsequent calls see the new root
    storage_paths::set_documents_root(new_root);

    Ok(result)
}

/// Reset documents root back to the platform default.
#[tauri::command]
pub async fn reset_documents_root(state: State<'_, AppState>) -> Result<(), String> {
    let db = &state.sea_db;
    let mut settings = aqbot_core::repo::settings::get_settings(db)
        .await
        .map_err(|e| e.to_string())?;
    settings.documents_root_override = None;
    aqbot_core::repo::settings::save_settings(db, &settings)
        .await
        .map_err(|e| e.to_string())?;

    storage_paths::clear_documents_root_override();
    Ok(())
}
