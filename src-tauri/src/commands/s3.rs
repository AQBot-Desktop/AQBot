use crate::AppState;
use aqbot_core::crypto::{decrypt_key, encrypt_key};
use aqbot_core::repo::{backup, settings as settings_repo};
use aqbot_core::s3_backup::{S3BackupClient, S3Config, S3FileInfo};
use aqbot_core::webdav;
use sea_orm::{ConnectionTrait, DatabaseConnection, EntityTrait, PaginatorTrait, Statement};
use std::path::{Path, PathBuf};
use tauri::State;

const S3_ACCESS_KEY_ID_SETTING: &str = "s3_access_key_id_encrypted";
const S3_SECRET_ACCESS_KEY_SETTING: &str = "s3_secret_access_key_encrypted";
const S3_SESSION_TOKEN_SETTING: &str = "s3_session_token_encrypted";
const S3_LAST_SYNC_TIME_SETTING: &str = "s3_last_sync_time";
const S3_LAST_SYNC_STATUS_SETTING: &str = "s3_last_sync_status";

#[derive(Default)]
struct TempPathCleanup {
    files: Vec<PathBuf>,
}

impl TempPathCleanup {
    fn track_file<P: Into<PathBuf>>(&mut self, path: P) {
        self.files.push(path.into());
    }

}

impl Drop for TempPathCleanup {
    fn drop(&mut self) {
        for path in &self.files {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command]
pub async fn get_s3_config(state: State<'_, AppState>) -> Result<S3Config, String> {
    get_s3_config_from_db(&state.sea_db, &state.master_key).await
}

#[tauri::command]
pub async fn save_s3_config(state: State<'_, AppState>, config: S3Config) -> Result<(), String> {
    save_s3_config_to_db(&state.sea_db, &state.master_key, config).await
}

#[tauri::command]
pub async fn s3_check_connection(config: S3Config) -> Result<bool, String> {
    let client = S3BackupClient::new(config)
        .await
        .map_err(|e| e.to_string())?;
    client.check_connection().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn s3_backup(state: State<'_, AppState>) -> Result<String, String> {
    do_s3_backup_impl(&state.sea_db, &state.master_key, &state.app_data_dir).await
}

#[tauri::command]
pub async fn s3_list_backups(state: State<'_, AppState>) -> Result<Vec<S3FileInfo>, String> {
    let config = get_s3_config_from_db(&state.sea_db, &state.master_key).await?;
    if config.bucket.trim().is_empty() {
        return Ok(vec![]);
    }
    let client = S3BackupClient::new(config)
        .await
        .map_err(|e| e.to_string())?;
    client.list_files().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn s3_restore(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    file_name: String,
) -> Result<(), String> {
    let config = get_s3_config_from_db(&state.sea_db, &state.master_key).await?;
    let settings = settings_repo::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    let decoded_backup_dir = aqbot_core::path_vars::decode_path_opt(&settings.backup_dir);
    let backup_dir = backup::resolve_backup_dir(decoded_backup_dir.as_deref(), &state.app_data_dir);
    backup::ensure_backup_dir(&backup_dir).map_err(|e| e.to_string())?;

    let mut cleanup = TempPathCleanup::default();

    let zip_path = backup_dir.join(&file_name);
    cleanup.track_file(&zip_path);
    let client = S3BackupClient::new(config)
        .await
        .map_err(|e| e.to_string())?;
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

#[tauri::command]
pub async fn s3_delete_backup(state: State<'_, AppState>, file_name: String) -> Result<(), String> {
    let config = get_s3_config_from_db(&state.sea_db, &state.master_key).await?;
    let client = S3BackupClient::new(config)
        .await
        .map_err(|e| e.to_string())?;
    client
        .delete_file(&file_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_s3_sync_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let last_time = settings_repo::get_setting(&state.sea_db, S3_LAST_SYNC_TIME_SETTING)
        .await
        .map_err(|e| e.to_string())?;
    let last_status = settings_repo::get_setting(&state.sea_db, S3_LAST_SYNC_STATUS_SETTING)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "lastSyncTime": last_time,
        "lastSyncStatus": last_status,
    }))
}

#[tauri::command]
pub async fn restart_s3_sync(state: State<'_, AppState>) -> Result<(), String> {
    let settings = settings_repo::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    let mut guard = state.s3_sync_handle.lock().await;
    if let Some(h) = guard.take() {
        h.abort();
    }

    if !settings.s3_sync_enabled || settings.s3_sync_interval_minutes == 0 {
        return Ok(());
    }

    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let app_data_dir = state.app_data_dir.clone();
    let interval_minutes = settings.s3_sync_interval_minutes;
    let task = spawn_s3_sync_task(
        db,
        master_key,
        app_data_dir,
        interval_minutes,
        interval_minutes as u64 * 60,
    );

    *guard = Some(task);
    Ok(())
}

pub(crate) async fn get_s3_config_from_db(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
) -> Result<S3Config, String> {
    let settings = settings_repo::get_settings(db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(S3Config {
        bucket: settings.s3_bucket.unwrap_or_default(),
        region: settings
            .s3_region
            .unwrap_or_else(|| "us-east-1".to_string()),
        prefix: settings.s3_prefix.unwrap_or_else(|| "aqbot/".to_string()),
        endpoint_url: settings.s3_endpoint,
        force_path_style: settings.s3_force_path_style,
        use_default_credentials: settings.s3_use_default_credentials,
        access_key_id: decrypt_setting(db, master_key, S3_ACCESS_KEY_ID_SETTING).await?,
        secret_access_key: decrypt_setting(db, master_key, S3_SECRET_ACCESS_KEY_SETTING).await?,
        session_token: Some(decrypt_setting(db, master_key, S3_SESSION_TOKEN_SETTING).await?)
            .filter(|v| !v.is_empty()),
    })
}

async fn save_s3_config_to_db(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    config: S3Config,
) -> Result<(), String> {
    let mut settings = settings_repo::get_settings(db)
        .await
        .map_err(|e| e.to_string())?;

    settings.s3_bucket = Some(config.bucket);
    settings.s3_region = Some(config.region);
    settings.s3_endpoint = config.endpoint_url;
    settings.s3_prefix = Some(config.prefix);
    settings.s3_force_path_style = config.force_path_style;
    settings.s3_use_default_credentials = config.use_default_credentials;

    settings_repo::save_settings(db, &settings)
        .await
        .map_err(|e| e.to_string())?;

    save_encrypted_setting(
        db,
        master_key,
        S3_ACCESS_KEY_ID_SETTING,
        if config.use_default_credentials {
            ""
        } else {
            &config.access_key_id
        },
    )
    .await?;
    save_encrypted_setting(
        db,
        master_key,
        S3_SECRET_ACCESS_KEY_SETTING,
        if config.use_default_credentials {
            ""
        } else {
            &config.secret_access_key
        },
    )
    .await?;
    save_encrypted_setting(
        db,
        master_key,
        S3_SESSION_TOKEN_SETTING,
        if config.use_default_credentials {
            ""
        } else {
            config.session_token.as_deref().unwrap_or("")
        },
    )
    .await?;

    Ok(())
}

async fn decrypt_setting(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    key: &str,
) -> Result<String, String> {
    let encrypted = settings_repo::get_setting(db, key)
        .await
        .map_err(|e| e.to_string())?;
    Ok(match encrypted {
        Some(enc) if !enc.is_empty() => decrypt_key(&enc, master_key).unwrap_or_default(),
        _ => String::new(),
    })
}

async fn save_encrypted_setting(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    key: &str,
    value: &str,
) -> Result<(), String> {
    if value.trim().is_empty() {
        settings_repo::set_setting(db, key, "")
            .await
            .map_err(|e| e.to_string())
    } else {
        let encrypted = encrypt_key(value, master_key).map_err(|e| e.to_string())?;
        settings_repo::set_setting(db, key, &encrypted)
            .await
            .map_err(|e| e.to_string())
    }
}

pub(crate) async fn do_s3_backup_impl(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    app_data_dir: &Path,
) -> Result<String, String> {
    let result = do_s3_backup_once(db, master_key, app_data_dir).await;
    record_s3_sync_status(db, if result.is_ok() { "success" } else { "failed" }).await;
    result
}

async fn do_s3_backup_once(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    app_data_dir: &Path,
) -> Result<String, String> {
    let config = get_s3_config_from_db(db, master_key).await?;
    if config.bucket.trim().is_empty() {
        return Err("S3 is not configured".to_string());
    }

    let settings = settings_repo::get_settings(db)
        .await
        .map_err(|e| e.to_string())?;

    let decoded_backup_dir = aqbot_core::path_vars::decode_path_opt(&settings.backup_dir);
    let backup_dir = backup::resolve_backup_dir(decoded_backup_dir.as_deref(), app_data_dir);
    backup::ensure_backup_dir(&backup_dir).map_err(|e| e.to_string())?;

    let temp_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_db_path = backup_dir.join(format!("_s3_temp_{}.db", temp_id));
    let _ = std::fs::remove_file(&temp_db_path);
    let mut cleanup = TempPathCleanup::default();
    cleanup.track_file(&temp_db_path);
    let file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;

    let db_str = temp_db_path.to_string_lossy().to_string();
    db.execute(Statement::from_string(
        sea_orm::DatabaseBackend::Sqlite,
        format!("VACUUM INTO '{}'", db_str.replace('\'', "''")),
    ))
    .await
    .map_err(|e| format!("VACUUM INTO failed: {}", e))?;

    let object_counts = count_objects_json(db).await;
    let documents_root = webdav::documents_sync_root();
    let documents_dir = if settings.s3_include_documents {
        let docs_root = documents_root.clone();
        docs_root.exists().then_some(docs_root)
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
    let workspace_root = app_data_dir.join("workspace");
    let workspace_dir = workspace_root.exists().then_some(workspace_root);

    let master_key_path = app_data_dir.join("master.key");
    let zip_filename = webdav::generate_backup_filename();
    let zip_path = backup_dir.join(&zip_filename);
    cleanup.track_file(&zip_path);
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

    let client = S3BackupClient::new(config)
        .await
        .map_err(|e| e.to_string())?;
    client
        .upload_file(&zip_filename, &zip_path)
        .await
        .map_err(|e| e.to_string())?;

    let _ = std::fs::remove_file(&temp_db_path);
    let _ = std::fs::remove_file(&zip_path);

    if settings.s3_max_remote_backups > 0 {
        cleanup_remote_backups(&client, settings.s3_max_remote_backups).await;
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

async fn cleanup_remote_backups(client: &S3BackupClient, max_per_host: u32) {
    if let Ok(files) = client.list_files().await {
        for file_name in backup_file_names_to_delete(files, max_per_host) {
            if let Err(e) = client.delete_file(&file_name).await {
                tracing::warn!("Failed to clean up old S3 backup {}: {}", file_name, e);
            }
        }
    }
}

fn backup_file_names_to_delete(files: Vec<S3FileInfo>, max_per_host: u32) -> Vec<String> {
    if max_per_host == 0 {
        return Vec::new();
    }

    let mut by_host: std::collections::HashMap<String, Vec<S3FileInfo>> =
        std::collections::HashMap::new();
    for file in files {
        by_host.entry(file.hostname.clone()).or_default().push(file);
    }

    let mut to_delete = Vec::new();
    for (_, mut host_files) in by_host {
        host_files.sort_by(|a, b| b.file_name.cmp(&a.file_name));
        if host_files.len() > max_per_host as usize {
            to_delete.extend(
                host_files
                    .split_off(max_per_host as usize)
                    .into_iter()
                    .map(|f| f.file_name),
            );
        }
    }
    to_delete.sort();
    to_delete
}

async fn record_s3_sync_status(db: &DatabaseConnection, status: &str) {
    let timestamp = webdav::sync_status_timestamp();
    let _ = settings_repo::set_setting(db, S3_LAST_SYNC_TIME_SETTING, &timestamp).await;
    let _ = settings_repo::set_setting(db, S3_LAST_SYNC_STATUS_SETTING, status).await;
}

pub(crate) fn spawn_s3_sync_task(
    db: DatabaseConnection,
    master_key: [u8; 32],
    app_data_dir: PathBuf,
    interval_minutes: u32,
    initial_delay_secs: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let interval = std::time::Duration::from_secs(interval_minutes as u64 * 60);
        tokio::time::sleep(std::time::Duration::from_secs(initial_delay_secs)).await;
        loop {
            match do_s3_backup_impl(&db, &master_key, &app_data_dir).await {
                Ok(name) => tracing::info!("S3 auto-sync completed: {}", name),
                Err(e) => tracing::warn!("S3 auto-sync failed: {}", e),
            }
            tokio::time::sleep(interval).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_cleanup_keeps_newest_backups_per_host() {
        let files = vec![
            file("aqbot-backup-20260513_010203.alpha.zip", "alpha"),
            file("aqbot-backup-20260515_010203.alpha.zip", "alpha"),
            file("aqbot-backup-20260514_010203.alpha.zip", "alpha"),
            file("aqbot-backup-20260512_010203.beta.zip", "beta"),
        ];

        let to_delete = backup_file_names_to_delete(files, 2);

        assert_eq!(
            to_delete,
            vec!["aqbot-backup-20260513_010203.alpha.zip".to_string()]
        );
    }

    #[tokio::test]
    async fn saved_s3_config_round_trips_encrypted_credentials() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let master_key = [7; 32];
        let config = S3Config {
            bucket: "bucket-a".to_string(),
            region: "us-west-2".to_string(),
            prefix: "aqbot/backups".to_string(),
            endpoint_url: Some("https://s3.example.com".to_string()),
            force_path_style: true,
            use_default_credentials: false,
            access_key_id: "access".to_string(),
            secret_access_key: "secret".to_string(),
            session_token: Some("token".to_string()),
        };

        save_s3_config_to_db(&db, &master_key, config.clone())
            .await
            .unwrap();
        let loaded = get_s3_config_from_db(&db, &master_key).await.unwrap();

        assert_eq!(loaded.bucket, config.bucket);
        assert_eq!(loaded.region, config.region);
        assert_eq!(loaded.prefix, config.prefix);
        assert_eq!(loaded.endpoint_url, config.endpoint_url);
        assert!(loaded.force_path_style);
        assert_eq!(loaded.access_key_id, "access");
        assert_eq!(loaded.secret_access_key, "secret");
        assert_eq!(loaded.session_token.as_deref(), Some("token"));
    }

    #[tokio::test]
    async fn default_credential_config_clears_stored_secret_values() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let master_key = [9; 32];
        let explicit = S3Config {
            bucket: "bucket-a".to_string(),
            region: "us-west-2".to_string(),
            prefix: "aqbot/backups".to_string(),
            use_default_credentials: false,
            access_key_id: "access".to_string(),
            secret_access_key: "secret".to_string(),
            session_token: Some("token".to_string()),
            ..Default::default()
        };
        save_s3_config_to_db(&db, &master_key, explicit)
            .await
            .unwrap();

        let default_credentials = S3Config {
            bucket: "bucket-a".to_string(),
            region: "us-west-2".to_string(),
            prefix: "aqbot/backups".to_string(),
            use_default_credentials: true,
            ..Default::default()
        };
        save_s3_config_to_db(&db, &master_key, default_credentials)
            .await
            .unwrap();
        let loaded = get_s3_config_from_db(&db, &master_key).await.unwrap();

        assert!(loaded.use_default_credentials);
        assert!(loaded.access_key_id.is_empty());
        assert!(loaded.secret_access_key.is_empty());
        assert_eq!(loaded.session_token, None);
    }

    #[test]
    fn restore_cleanup_removes_tracked_safety_key_files() {
        let temp_root = std::env::temp_dir().join(format!(
            "aqbot-s3-restore-cleanup-{}",
            aqbot_core::utils::gen_id()
        ));
        std::fs::create_dir_all(&temp_root).expect("create temp root");
        let safety_key = temp_root.join("_pre_s3_restore_safety.key");
        std::fs::write(&safety_key, b"secret").expect("write safety key");

        {
            let mut cleanup = TempPathCleanup::default();
            cleanup.track_file(&safety_key);
        }

        assert!(
            !safety_key.exists(),
            "restore cleanup must delete the plaintext safety key backup"
        );
        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn temp_path_cleanup_removes_backup_temp_files_on_drop() {
        let temp_root = std::env::temp_dir().join(format!(
            "aqbot-s3-backup-cleanup-{}",
            aqbot_core::utils::gen_id()
        ));
        std::fs::create_dir_all(&temp_root).expect("create temp root");
        let temp_db = temp_root.join("_s3_temp_123.db");
        let temp_zip = temp_root.join("aqbot-backup-20260519_010203.host.zip");
        std::fs::write(&temp_db, b"db").expect("write temp db");
        std::fs::write(&temp_zip, b"zip").expect("write temp zip");

        {
            let mut cleanup = TempPathCleanup::default();
            cleanup.track_file(&temp_db);
            cleanup.track_file(&temp_zip);
        }

        assert!(
            !temp_db.exists(),
            "backup cleanup must delete the temporary database copy"
        );
        assert!(
            !temp_zip.exists(),
            "backup cleanup must delete the generated temporary ZIP"
        );
        let _ = std::fs::remove_dir_all(&temp_root);
    }

    fn file(file_name: &str, hostname: &str) -> S3FileInfo {
        S3FileInfo {
            file_name: file_name.to_string(),
            size: 1,
            last_modified: String::new(),
            hostname: hostname.to_string(),
        }
    }
}
