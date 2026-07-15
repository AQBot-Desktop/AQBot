use crate::AppState;
use aqbot_core::crypto::{decrypt_key, encrypt_key};
use aqbot_core::repo::{backup, settings as settings_repo};
use aqbot_core::webdav::{self, WebDavClient, WebDavConfig, WebDavFileInfo};
use sea_orm::{ConnectionTrait, DatabaseConnection, EntityTrait, PaginatorTrait, Statement};
use std::path::Path;
use std::path::PathBuf;
use tauri::State;

#[derive(Default)]
struct RestoreCleanup {
    files: Vec<PathBuf>,
}

impl RestoreCleanup {
    fn track_file<P: Into<PathBuf>>(&mut self, path: P) {
        self.files.push(path.into());
    }

}

impl Drop for RestoreCleanup {
    fn drop(&mut self) {
        for path in &self.files {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Get WebDAV configuration (password decrypted).
#[tauri::command]
pub async fn get_webdav_config(state: State<'_, AppState>) -> Result<WebDavConfig, String> {
    get_webdav_config_from_db(&state.sea_db, &state.master_key).await
}

/// Save WebDAV configuration (password encrypted).
#[tauri::command]
pub async fn save_webdav_config(
    state: State<'_, AppState>,
    config: WebDavConfig,
) -> Result<(), String> {
    let mut settings = settings_repo::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    settings.webdav_host = Some(config.host);
    settings.webdav_username = Some(config.username);
    settings.webdav_path = Some(config.path);
    settings.webdav_accept_invalid_certs = config.accept_invalid_certs;

    settings_repo::save_settings(&state.sea_db, &settings)
        .await
        .map_err(|e| e.to_string())?;

    // Encrypt and store password separately
    if !config.password.is_empty() {
        let encrypted =
            encrypt_key(&config.password, &state.master_key).map_err(|e| e.to_string())?;
        settings_repo::set_setting(&state.sea_db, "webdav_password_encrypted", &encrypted)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        settings_repo::set_setting(&state.sea_db, "webdav_password_encrypted", "")
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Test WebDAV connection without requiring saved config.
#[tauri::command]
pub async fn webdav_check_connection(config: WebDavConfig) -> Result<bool, String> {
    let client = WebDavClient::new(config).map_err(|e| e.to_string())?;
    client.check_connection().await.map_err(|e| e.to_string())
}

/// Create a backup and upload it to WebDAV.
#[tauri::command]
pub async fn webdav_backup(state: State<'_, AppState>) -> Result<String, String> {
    do_webdav_backup_impl(&state.sea_db, &state.master_key, &state.app_data_dir).await
}

/// List remote backups on WebDAV server.
#[tauri::command]
pub async fn webdav_list_backups(
    state: State<'_, AppState>,
) -> Result<Vec<WebDavFileInfo>, String> {
    let config = get_webdav_config_from_db(&state.sea_db, &state.master_key).await?;
    if config.host.is_empty() {
        return Ok(vec![]);
    }
    let client = WebDavClient::new(config).map_err(|e| e.to_string())?;
    client.list_files().await.map_err(|e| e.to_string())
}

/// Restore from a remote WebDAV backup.
#[tauri::command]
pub async fn webdav_restore(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    file_name: String,
) -> Result<(), String> {
    let config = get_webdav_config_from_db(&state.sea_db, &state.master_key).await?;
    let settings = settings_repo::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    let decoded_backup_dir = aqbot_core::path_vars::decode_path_opt(&settings.backup_dir);
    let backup_dir = backup::resolve_backup_dir(decoded_backup_dir.as_deref(), &state.app_data_dir);
    backup::ensure_backup_dir(&backup_dir).map_err(|e| e.to_string())?;

    let mut cleanup = RestoreCleanup::default();

    // 1. Download ZIP
    let zip_path = backup_dir.join(&file_name);
    cleanup.track_file(&zip_path);
    let client = WebDavClient::new(config).map_err(|e| e.to_string())?;
    client
        .download_file(&file_name, &zip_path)
        .await
        .map_err(|e| e.to_string())?;

    aqbot_core::pending_restore::queue_pending_restore(
        &zip_path,
        &state.app_data_dir,
        &aqbot_core::storage_paths::default_documents_root(),
    )
    .map_err(|error| error.to_string())?;
    drop(cleanup);

    // Startup publishes DB/key/documents/workspace before opening SQLite.
    app.restart();

    #[allow(unreachable_code)]
    Ok(())
}

/// Delete a remote backup file.
#[tauri::command]
pub async fn webdav_delete_backup(
    state: State<'_, AppState>,
    file_name: String,
) -> Result<(), String> {
    let config = get_webdav_config_from_db(&state.sea_db, &state.master_key).await?;
    let client = WebDavClient::new(config).map_err(|e| e.to_string())?;
    client
        .delete_file(&file_name)
        .await
        .map_err(|e| e.to_string())
}

/// Get WebDAV sync status (last sync time and result).
#[tauri::command]
pub async fn get_webdav_sync_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let last_time = settings_repo::get_setting(&state.sea_db, "webdav_last_sync_time")
        .await
        .map_err(|e| e.to_string())?;
    let last_status = settings_repo::get_setting(&state.sea_db, "webdav_last_sync_status")
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "lastSyncTime": last_time,
        "lastSyncStatus": last_status,
    }))
}

/// Restart the WebDAV auto-sync scheduler based on current settings.
#[tauri::command]
pub async fn restart_webdav_sync(state: State<'_, AppState>) -> Result<(), String> {
    let settings = settings_repo::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    let mut guard = state.webdav_sync_handle.lock().await;

    // Stop existing scheduler
    if let Some(h) = guard.take() {
        h.abort();
    }

    if !settings.webdav_sync_enabled || settings.webdav_sync_interval_minutes == 0 {
        return Ok(());
    }

    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let app_data_dir = state.app_data_dir.clone();
    let interval_minutes = settings.webdav_sync_interval_minutes;
    let task = spawn_webdav_sync_task(
        db,
        master_key,
        app_data_dir,
        interval_minutes,
        interval_minutes as u64 * 60,
    );

    *guard = Some(task);
    Ok(())
}

// === Internal Helpers ===

pub(crate) async fn get_webdav_config_from_db(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
) -> Result<WebDavConfig, String> {
    let settings = settings_repo::get_settings(db)
        .await
        .map_err(|e| e.to_string())?;
    let encrypted_pw = settings_repo::get_setting(db, "webdav_password_encrypted")
        .await
        .map_err(|e| e.to_string())?;
    let password = match encrypted_pw {
        Some(enc) if !enc.is_empty() => decrypt_key(&enc, master_key).unwrap_or_default(),
        _ => String::new(),
    };

    Ok(WebDavConfig {
        host: settings.webdav_host.unwrap_or_default(),
        username: settings.webdav_username.unwrap_or_default(),
        password,
        path: settings
            .webdav_path
            .unwrap_or_else(|| "/aqbot/".to_string()),
        accept_invalid_certs: settings.webdav_accept_invalid_certs,
    })
}

/// Core backup-and-upload logic, shared by the command and the auto-sync scheduler.
pub(crate) async fn do_webdav_backup_impl(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    app_data_dir: &Path,
) -> Result<String, String> {
    let result = do_webdav_backup_once(db, master_key, app_data_dir).await;
    record_webdav_sync_status(db, if result.is_ok() { "success" } else { "failed" }).await;
    result
}

async fn do_webdav_backup_once(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    app_data_dir: &Path,
) -> Result<String, String> {
    // 1. Load config
    let config = get_webdav_config_from_db(db, master_key).await?;
    if config.host.is_empty() {
        return Err("WebDAV is not configured".to_string());
    }

    let settings = settings_repo::get_settings(db)
        .await
        .map_err(|e| e.to_string())?;

    // 2. Create local SQLite snapshot via VACUUM INTO
    let decoded_backup_dir = aqbot_core::path_vars::decode_path_opt(&settings.backup_dir);
    let backup_dir = backup::resolve_backup_dir(decoded_backup_dir.as_deref(), app_data_dir);
    backup::ensure_backup_dir(&backup_dir).map_err(|e| e.to_string())?;

    let temp_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_db_path = backup_dir.join(format!("_webdav_temp_{}.db", temp_id));
    let _ = std::fs::remove_file(&temp_db_path);
    let file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;

    let db_str = temp_db_path.to_string_lossy().to_string();
    db.execute(Statement::from_string(
        sea_orm::DatabaseBackend::Sqlite,
        format!("VACUUM INTO '{}'", db_str.replace('\'', "''")),
    ))
    .await
    .map_err(|e| format!("VACUUM INTO failed: {}", e))?;

    // 3. Object counts for metadata
    let object_counts = count_objects_json(db).await;

    // 4. Documents directory (optional)
    let include_docs = settings.webdav_include_documents;
    let documents_root = webdav::documents_sync_root();
    let documents_dir = if include_docs {
        let docs_root = documents_root.clone();
        if docs_root.exists() {
            Some(docs_root)
        } else {
            None
        }
    } else {
        None
    };
    let required_media = aqbot_core::repo::stored_file::list_all_stored_files(db)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|file| {
            Ok(aqbot_core::webdav::BackupMediaRequirement {
                storage_path: file.storage_path,
                sha256: file.hash,
                size: u64::try_from(file.size_bytes)
                    .map_err(|_| format!("Stored-file size is invalid for backup: {}", file.id))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    // 4b. Workspace directory (always included if present)
    let workspace_root = app_data_dir.join("workspace");
    let workspace_dir = if workspace_root.exists() {
        Some(workspace_root)
    } else {
        None
    };

    // 5. Create ZIP (includes master.key for cross-device restore)
    let master_key_path = app_data_dir.join("master.key");
    let zip_filename = webdav::generate_backup_filename();
    let zip_path = backup_dir.join(&zip_filename);
    webdav::create_backup_zip(
        &temp_db_path,
        documents_dir.as_deref(),
        &documents_root,
        &required_media,
        workspace_dir.as_deref(),
        Some(&master_key_path),
        &zip_path,
        env!("CARGO_PKG_VERSION"),
        &object_counts,
    )
    .map_err(|e| e.to_string())?;
    drop(file_reference_guard);

    // 6. Upload
    let client = WebDavClient::new(config).map_err(|e| e.to_string())?;
    client
        .upload_file(&zip_filename, &zip_path)
        .await
        .map_err(|e| e.to_string())?;

    // 7. Cleanup temp files
    let _ = std::fs::remove_file(&temp_db_path);
    let _ = std::fs::remove_file(&zip_path);

    // 8. Cleanup old remote backups
    let max_backups = settings.webdav_max_remote_backups;
    if max_backups > 0 {
        cleanup_remote_backups(&client, max_backups).await;
    }

    Ok(zip_filename)
}

async fn count_objects_json(db: &DatabaseConnection) -> String {
    use aqbot_core::entity::*;

    let conv_count = conversations::Entity::find().count(db).await.unwrap_or(0);
    let msg_count = messages::Entity::find().count(db).await.unwrap_or(0);
    let provider_count = providers::Entity::find().count(db).await.unwrap_or(0);

    serde_json::json!({
        "conversations": conv_count,
        "messages": msg_count,
        "providers": provider_count,
    })
    .to_string()
}

async fn cleanup_remote_backups(client: &WebDavClient, max_per_host: u32) {
    if let Ok(files) = client.list_files().await {
        let mut by_host: std::collections::HashMap<String, Vec<WebDavFileInfo>> =
            std::collections::HashMap::new();
        for f in files {
            by_host.entry(f.hostname.clone()).or_default().push(f);
        }

        for (_, mut host_files) in by_host {
            if host_files.len() > max_per_host as usize {
                let to_delete = host_files.split_off(max_per_host as usize);
                for f in to_delete {
                    if let Err(e) = client.delete_file(&f.file_name).await {
                        tracing::warn!(
                            "Failed to clean up old WebDAV backup {}: {}",
                            f.file_name,
                            e
                        );
                    }
                }
            }
        }
    }
}

async fn record_webdav_sync_status(db: &DatabaseConnection, status: &str) {
    let timestamp = webdav::sync_status_timestamp();
    let _ = settings_repo::set_setting(db, "webdav_last_sync_time", &timestamp).await;
    let _ = settings_repo::set_setting(db, "webdav_last_sync_status", status).await;
}

pub(crate) fn spawn_webdav_sync_task(
    db: DatabaseConnection,
    master_key: [u8; 32],
    app_data_dir: std::path::PathBuf,
    interval_minutes: u32,
    initial_delay_secs: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let interval = std::time::Duration::from_secs(interval_minutes as u64 * 60);
        // Initial wait (may be shorter if overdue)
        tokio::time::sleep(std::time::Duration::from_secs(initial_delay_secs)).await;
        loop {
            match do_webdav_backup_impl(&db, &master_key, &app_data_dir).await {
                Ok(name) => tracing::info!("WebDAV auto-sync completed: {}", name),
                Err(e) => tracing::warn!("WebDAV auto-sync failed: {}", e),
            }
            tokio::time::sleep(interval).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::RestoreCleanup;

    #[test]
    fn restore_cleanup_removes_tracked_safety_key_files() {
        let temp_root = std::env::temp_dir().join(format!(
            "aqbot-webdav-restore-cleanup-{}",
            aqbot_core::utils::gen_id()
        ));
        std::fs::create_dir_all(&temp_root).expect("create temp root");
        let safety_key = temp_root.join("_pre_webdav_restore_safety.key");
        std::fs::write(&safety_key, b"secret").expect("write safety key");

        {
            let mut cleanup = RestoreCleanup::default();
            cleanup.track_file(&safety_key);
        }

        assert!(
            !safety_key.exists(),
            "restore cleanup must delete the plaintext safety key backup"
        );
        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[cfg(unix)]
    #[test]
    fn restore_cleanup_keeps_safety_key_backup_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp_root = std::env::temp_dir().join(format!(
            "aqbot-webdav-restore-perms-{}",
            aqbot_core::utils::gen_id()
        ));
        std::fs::create_dir_all(&temp_root).expect("create temp root");
        let safety_key = temp_root.join("_pre_webdav_restore_safety.key");
        std::fs::write(&safety_key, b"secret").expect("write safety key");
        std::fs::set_permissions(&safety_key, std::fs::Permissions::from_mode(0o600))
            .expect("set permissions");

        let mode = std::fs::metadata(&safety_key)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(
            mode, 0o600,
            "safety key backups must be owner-readable only"
        );
        let _ = std::fs::remove_dir_all(&temp_root);
    }
}
