use sea_orm::*;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use crate::entity::backup_manifests;
use crate::error::{AQBotError, Result};
use crate::types::BackupManifest;
use crate::utils::gen_id;

fn model_to_manifest(m: backup_manifests::Model) -> BackupManifest {
    BackupManifest {
        id: m.id,
        version: m.version,
        created_at: m.created_at,
        encrypted: m.encrypted != 0,
        checksum: m.checksum,
        object_counts_json: m.object_counts_json,
        source_app_version: m.source_app_version,
        file_path: m.file_path,
        file_size: m.file_size,
    }
}

/// Get the backup directory, using the configured path or defaulting to the AQBot home backups dir.
pub fn resolve_backup_dir(backup_dir_setting: Option<&str>, app_data_dir: &Path) -> PathBuf {
    if let Some(dir) = backup_dir_setting {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    app_data_dir.join("backups")
}

/// Ensure the backup directory exists
pub fn ensure_backup_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(|e| {
        AQBotError::Gateway(format!("Failed to create backup directory: {}", e))
    })
}

/// Create a real backup file (SQLite copy or JSON export)
pub async fn create_backup(
    db: &DatabaseConnection,
    format: &str,
    backup_dir: &Path,
) -> Result<BackupManifest> {
    ensure_backup_dir(backup_dir)?;

    let id = gen_id();
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let extension = match format {
        "sqlite" => "db",
        _ => "json",
    };
    let filename = format!("aqbot-backup-{}.{}", timestamp, extension);
    let file_path = backup_dir.join(&filename);

    match format {
        "sqlite" => {
            create_sqlite_backup(db, &file_path).await?;
        }
        _ => {
            create_json_backup(db, &file_path).await?;
        }
    }

    let file_size = std::fs::metadata(&file_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let checksum = compute_file_checksum(&file_path)?;

    // Count objects for manifest
    let object_counts = count_objects(db).await?;

    let am = backup_manifests::ActiveModel {
        id: Set(id.clone()),
        version: Set(format.to_string()),
        encrypted: Set(0),
        checksum: Set(checksum),
        object_counts_json: Set(object_counts),
        source_app_version: Set(env!("CARGO_PKG_VERSION").to_string()),
        file_path: Set(Some(file_path.to_string_lossy().to_string())),
        file_size: Set(file_size),
        ..Default::default()
    };

    am.insert(db).await?;

    get_backup(db, &id).await
}

/// Create a SQLite backup using VACUUM INTO
async fn create_sqlite_backup(db: &DatabaseConnection, dest: &Path) -> Result<()> {
    let dest_str = dest.to_string_lossy().to_string();
    // Remove existing file if present (VACUUM INTO fails otherwise)
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|e| {
            AQBotError::Gateway(format!("Failed to remove existing backup file: {}", e))
        })?;
    }
    db.execute(Statement::from_string(
        sea_orm::DatabaseBackend::Sqlite,
        format!("VACUUM INTO '{}'", dest_str.replace('\'', "''")),
    ))
    .await
    .map_err(|e| AQBotError::Gateway(format!("VACUUM INTO failed: {}", e)))?;
    Ok(())
}

/// Create a JSON backup by exporting all important tables
async fn create_json_backup(db: &DatabaseConnection, dest: &Path) -> Result<()> {
    use crate::entity::*;

    let conversations = conversations::Entity::find().all(db).await?;
    let messages = messages::Entity::find().all(db).await?;
    let providers = providers::Entity::find().all(db).await?;
    let provider_keys = provider_keys::Entity::find().all(db).await?;
    let models = models::Entity::find().all(db).await?;
    let settings = settings::Entity::find().all(db).await?;
    let gateway_keys = gateway_keys::Entity::find().all(db).await?;

    let data = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "tables": {
            "conversations": conversations,
            "messages": messages,
            "providers": providers,
            "provider_keys": provider_keys,
            "models": models,
            "settings": settings,
            "gateway_keys": gateway_keys,
        }
    });

    let json_str = serde_json::to_string_pretty(&data)
        .map_err(|e| AQBotError::Gateway(format!("JSON serialization failed: {}", e)))?;
    std::fs::write(dest, json_str)
        .map_err(|e| AQBotError::Gateway(format!("Failed to write backup file: {}", e)))?;
    Ok(())
}

fn compute_file_checksum(path: &Path) -> Result<String> {
    let data = std::fs::read(path)
        .map_err(|e| AQBotError::Gateway(format!("Failed to read file for checksum: {}", e)))?;
    let hash = Sha256::digest(&data);
    Ok(format!("{:x}", hash))
}

async fn count_objects(db: &DatabaseConnection) -> Result<String> {
    use crate::entity::*;

    let conv_count = conversations::Entity::find().count(db).await.unwrap_or(0);
    let msg_count = messages::Entity::find().count(db).await.unwrap_or(0);
    let provider_count = providers::Entity::find().count(db).await.unwrap_or(0);

    let counts = serde_json::json!({
        "conversations": conv_count,
        "messages": msg_count,
        "providers": provider_count,
    });
    Ok(counts.to_string())
}

pub async fn list_backups(db: &DatabaseConnection) -> Result<Vec<BackupManifest>> {
    let models = backup_manifests::Entity::find()
        .order_by_desc(backup_manifests::Column::CreatedAt)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_manifest).collect())
}

pub async fn get_backup(db: &DatabaseConnection, id: &str) -> Result<BackupManifest> {
    let model = backup_manifests::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("BackupManifest {}", id)))?;

    Ok(model_to_manifest(model))
}

pub async fn delete_backup(db: &DatabaseConnection, id: &str) -> Result<()> {
    let manifest = get_backup(db, id).await?;

    // Delete the file from disk if it exists
    if let Some(ref path) = manifest.file_path {
        let p = Path::new(path);
        if p.exists() {
            std::fs::remove_file(p).ok();
        }
    }

    let result = backup_manifests::Entity::delete_by_id(id)
        .exec(db)
        .await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("BackupManifest {}", id)));
    }
    Ok(())
}

pub async fn batch_delete_backups(db: &DatabaseConnection, ids: &[String]) -> Result<()> {
    for id in ids {
        delete_backup(db, id).await?;
    }
    Ok(())
}

/// Restore from a SQLite backup by replacing the current database file
pub async fn restore_sqlite_backup(backup_path: &str, current_db_path: &str) -> Result<()> {
    let src = Path::new(backup_path);
    if !src.exists() {
        return Err(AQBotError::NotFound(format!(
            "Backup file not found: {}",
            backup_path
        )));
    }
    std::fs::copy(src, current_db_path).map_err(|e| {
        AQBotError::Gateway(format!("Failed to restore backup: {}", e))
    })?;
    Ok(())
}

/// Clean up old backups exceeding max_count (keeps most recent)
pub async fn cleanup_old_backups(db: &DatabaseConnection, max_count: u32) -> Result<u32> {
    let all = list_backups(db).await?;
    if all.len() <= max_count as usize {
        return Ok(0);
    }

    let to_delete = &all[max_count as usize..];
    let mut deleted = 0u32;
    for backup in to_delete {
        delete_backup(db, &backup.id).await?;
        deleted += 1;
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::resolve_backup_dir;
    use std::path::PathBuf;

    #[test]
    fn resolve_backup_dir_defaults_to_aqbot_backups_subdir() {
        let aqbot_home = PathBuf::from("/Users/test/.aqbot");

        assert_eq!(resolve_backup_dir(None, &aqbot_home), aqbot_home.join("backups"));
        assert_eq!(
            resolve_backup_dir(Some(""), &aqbot_home),
            aqbot_home.join("backups")
        );
    }

    #[test]
    fn resolve_backup_dir_honors_explicit_absolute_override() {
        let aqbot_home = PathBuf::from("/Users/test/.aqbot");
        let override_dir = PathBuf::from("/Volumes/external/aqbot-backups");

        assert_eq!(
            resolve_backup_dir(Some(override_dir.to_str().unwrap()), &aqbot_home),
            override_dir
        );
    }
}
