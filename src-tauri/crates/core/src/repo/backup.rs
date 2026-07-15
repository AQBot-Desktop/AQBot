use sea_orm::*;
#[cfg(test)]
use serde::Deserialize;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::HashSet;
#[cfg(test)]
use std::io::Read;
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
        file_path: m
            .file_path
            .as_ref()
            .map(|p| crate::path_vars::decode_path(p)),
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
    std::fs::create_dir_all(dir)
        .map_err(|e| AQBotError::Gateway(format!("Failed to create backup directory: {}", e)))
}

/// Create a real backup file (SQLite copy or JSON export)
pub async fn create_backup(
    db: &DatabaseConnection,
    format: &str,
    backup_dir: &Path,
) -> Result<BackupManifest> {
    let documents_root = crate::storage_paths::documents_root();
    create_backup_with_documents_root(db, format, backup_dir, &documents_root).await
}

async fn create_backup_with_documents_root(
    db: &DatabaseConnection,
    format: &str,
    backup_dir: &Path,
    documents_root: &Path,
) -> Result<BackupManifest> {
    ensure_backup_dir(backup_dir)?;

    let id = gen_id();
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let extension = match format {
        "sqlite" => "zip",
        _ => "json",
    };
    let id_suffix = id.get(..8).unwrap_or(&id);
    let filename = format!("aqbot-backup-{timestamp}-{id_suffix}.{extension}");
    let file_path = backup_dir.join(&filename);
    let object_counts = count_objects(db).await?;

    match format {
        "sqlite" => {
            create_sqlite_bundle(db, &file_path, backup_dir, documents_root, &object_counts)
                .await?;
        }
        _ => {
            create_json_backup(db, &file_path).await?;
        }
    }

    let file_size = std::fs::metadata(&file_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let checksum = compute_file_checksum(&file_path)?;

    let am = backup_manifests::ActiveModel {
        id: Set(id.clone()),
        version: Set(format.to_string()),
        encrypted: Set(0),
        checksum: Set(checksum),
        object_counts_json: Set(object_counts),
        source_app_version: Set(env!("CARGO_PKG_VERSION").to_string()),
        file_path: Set(Some(crate::path_vars::encode_path(
            &file_path.to_string_lossy(),
        ))),
        file_size: Set(file_size),
        ..Default::default()
    };

    if let Err(error) = am.insert(db).await {
        let _ = std::fs::remove_file(&file_path);
        return Err(error.into());
    }

    get_backup(db, &id).await
}

struct BackupPathCleanup(Vec<PathBuf>);

impl Drop for BackupPathCleanup {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

async fn create_sqlite_bundle(
    db: &DatabaseConnection,
    dest: &Path,
    backup_dir: &Path,
    documents_root: &Path,
    object_counts_json: &str,
) -> Result<()> {
    let _file_reference_guard = crate::repo::stored_file::lock_file_references().await;
    let nonce = gen_id();
    let snapshot_path = backup_dir.join(format!(".aqbot-db-{nonce}.migrating.db"));
    let bundle_path = backup_dir.join(format!(".aqbot-bundle-{nonce}.migrating"));
    let cleanup = BackupPathCleanup(vec![snapshot_path.clone(), bundle_path.clone()]);

    create_sqlite_backup(db, &snapshot_path).await?;
    let mut required_media = crate::repo::stored_file::list_all_stored_files(db)
        .await?
        .into_iter()
        .map(|file| {
            Ok(crate::webdav::BackupMediaRequirement {
                storage_path: file.storage_path,
                sha256: file.hash,
                size: u64::try_from(file.size_bytes).map_err(|_| {
                    AQBotError::Validation(format!(
                        "Stored-file size is invalid for backup: {}",
                        file.id
                    ))
                })?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    required_media.sort_by(|left, right| left.storage_path.cmp(&right.storage_path));
    crate::webdav::create_backup_zip(
        &snapshot_path,
        None,
        documents_root,
        &required_media,
        None,
        None,
        &bundle_path,
        env!("CARGO_PKG_VERSION"),
        object_counts_json,
    )?;
    std::fs::File::open(&bundle_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            AQBotError::Gateway(format!("Failed to sync SQLite backup bundle: {error}"))
        })?;
    std::fs::rename(&bundle_path, dest).map_err(|error| {
        AQBotError::Gateway(format!("Failed to publish SQLite backup bundle: {error}"))
    })?;
    drop(cleanup);
    Ok(())
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
    let stored_files = stored_files::Entity::find().all(db).await?;

    let data = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "media_payload": {
            "included": false,
            "restorable": false,
            "note": "JSON backups contain stored_files metadata only; use SQLite ZIP backups for restorable media bytes"
        },
        "tables": {
            "conversations": conversations,
            "messages": messages,
            "providers": providers,
            "provider_keys": provider_keys,
            "models": models,
            "settings": settings,
            "gateway_keys": gateway_keys,
            "stored_files": stored_files,
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

    let result = backup_manifests::Entity::delete_by_id(id).exec(db).await?;

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

/// Persist a validated restore payload for publication on the next startup.
/// The live SQLite file is never renamed while its connection pool is open.
pub async fn restore_sqlite_backup(backup_path: &str, current_db_path: &str) -> Result<()> {
    let current_db_path = Path::new(current_db_path);
    let app_dir = current_db_path.parent().unwrap_or_else(|| Path::new("."));
    crate::pending_restore::queue_pending_restore(
        Path::new(backup_path),
        app_dir,
        &crate::storage_paths::documents_root(),
    )
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
struct BundleMediaEntry {
    path: String,
    sha256: String,
    size: u64,
}

#[cfg(test)]
struct StagedCopy {
    path: PathBuf,
    committed: bool,
}

#[cfg(test)]
impl StagedCopy {
    fn prepare(source: &Path, target: &Path) -> Result<Self> {
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent).map_err(|error| {
            AQBotError::Gateway(format!("Failed to create restore directory: {error}"))
        })?;
        let file_name = target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("aqbot.db");
        let path = parent.join(format!(".{file_name}.{}.migrating", gen_id()));
        let operation = (|| -> Result<()> {
            let mut input = std::fs::File::open(source).map_err(|error| {
                AQBotError::Gateway(format!("Failed to open restore source: {error}"))
            })?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| {
                    AQBotError::Gateway(format!("Failed to create restore staging file: {error}"))
                })?;
            std::io::copy(&mut input, &mut output).map_err(|error| {
                AQBotError::Gateway(format!("Failed to stage restore file: {error}"))
            })?;
            output.sync_all().map_err(|error| {
                AQBotError::Gateway(format!("Failed to sync restore staging file: {error}"))
            })?;
            Ok(())
        })();
        if let Err(error) = operation {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        Ok(Self {
            path,
            committed: false,
        })
    }

    fn commit(mut self, target: &Path) -> Result<()> {
        #[cfg(not(windows))]
        {
            std::fs::rename(&self.path, target).map_err(|error| {
                AQBotError::Gateway(format!(
                    "Failed to publish staged restore file {}: {error}",
                    target.display()
                ))
            })?;
            self.committed = true;
            return Ok(());
        }

        #[cfg(windows)]
        {
            let rollback_path = target
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(format!(
                    ".{}.{}.rollback",
                    target
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("aqbot.db"),
                    gen_id()
                ));
            let had_target = target.exists();
            if had_target {
                std::fs::rename(target, &rollback_path).map_err(|error| {
                    AQBotError::Gateway(format!(
                        "Failed to stage the existing restore target {}: {error}",
                        target.display()
                    ))
                })?;
            }
            if let Err(publish_error) = std::fs::rename(&self.path, target) {
                let rollback_error = had_target
                    .then(|| std::fs::rename(&rollback_path, target).err())
                    .flatten();
                return Err(AQBotError::Gateway(format!(
                    "Failed to publish staged restore file {}: {publish_error}; rollback error: {}",
                    target.display(),
                    rollback_error
                        .map(|error| error.to_string())
                        .unwrap_or_else(|| "none".to_string())
                )));
            }
            self.committed = true;
            if had_target {
                if let Err(error) = std::fs::remove_file(&rollback_path) {
                    tracing::warn!(
                        path = %rollback_path.display(),
                        error = %error,
                        "restored file published but rollback cleanup failed"
                    );
                }
            }
            Ok(())
        }
    }
}

#[cfg(test)]
impl Drop for StagedCopy {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
fn is_zip_bundle(path: &Path) -> Result<bool> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| AQBotError::Gateway(format!("Failed to open backup: {error}")))?;
    let mut magic = [0_u8; 4];
    let read = file
        .read(&mut magic)
        .map_err(|error| AQBotError::Gateway(format!("Failed to inspect backup: {error}")))?;
    Ok(read == magic.len()
        && matches!(
            magic,
            [b'P', b'K', 3, 4] | [b'P', b'K', 5, 6] | [b'P', b'K', 7, 8]
        ))
}

#[cfg(test)]
fn collect_relative_files(root: &Path, dir: &Path, files: &mut Vec<String>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|error| {
        AQBotError::Gateway(format!("Failed to inspect restored documents: {error}"))
    })? {
        let entry = entry.map_err(|error| {
            AQBotError::Gateway(format!("Failed to inspect restored document: {error}"))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            AQBotError::Gateway(format!("Failed to inspect restored document type: {error}"))
        })?;
        if file_type.is_symlink() {
            return Err(AQBotError::Validation(format!(
                "Restored document cannot be a symlink: {}",
                entry.path().display()
            )));
        }
        if file_type.is_dir() {
            collect_relative_files(root, &entry.path(), files)?;
        } else if file_type.is_file() {
            let entry_path = entry.path();
            let relative = entry_path.strip_prefix(root).map_err(|error| {
                AQBotError::Validation(format!("Invalid restored document path: {error}"))
            })?;
            files.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

#[cfg(test)]
fn validate_bundle_media(
    contents: &crate::webdav::BackupZipContents,
    extraction_root: &Path,
    documents_root: &Path,
) -> Result<Vec<(PathBuf, PathBuf)>> {
    let entries: Vec<BundleMediaEntry> = serde_json::from_value(
        contents
            .metadata
            .get("media_files")
            .cloned()
            .ok_or_else(|| {
                AQBotError::Validation(
                    "SQLite backup bundle is missing its media manifest".to_string(),
                )
            })?,
    )
    .map_err(|error| {
        AQBotError::Validation(format!("SQLite backup media manifest is invalid: {error}"))
    })?;
    let expected_paths = entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect::<HashSet<_>>();
    if expected_paths.len() != entries.len() {
        return Err(AQBotError::Validation(
            "SQLite backup media manifest contains duplicate paths".to_string(),
        ));
    }
    let extracted_documents = extraction_root.join("documents");
    let mut actual_paths = Vec::new();
    collect_relative_files(
        &extracted_documents,
        &extracted_documents,
        &mut actual_paths,
    )?;
    let actual_paths = actual_paths.into_iter().collect::<HashSet<_>>();
    if actual_paths != expected_paths {
        return Err(AQBotError::Validation(format!(
            "SQLite backup document payload does not match its media manifest (expected {}, found {})",
            expected_paths.len(),
            actual_paths.len()
        )));
    }

    let target_store = crate::file_store::FileStore::with_root(documents_root.to_path_buf());
    let mut copies = Vec::new();
    for entry in entries {
        let source = extracted_documents.join(&entry.path);
        let metadata = std::fs::metadata(&source).map_err(|error| {
            AQBotError::Gateway(format!(
                "Failed to inspect bundled media {}: {error}",
                entry.path
            ))
        })?;
        if metadata.len() != entry.size {
            return Err(AQBotError::Validation(format!(
                "Bundled media size mismatch: {}",
                entry.path
            )));
        }
        let data = std::fs::read(&source).map_err(|error| {
            AQBotError::Gateway(format!(
                "Failed to read bundled media {}: {error}",
                entry.path
            ))
        })?;
        let actual_hash = format!("{:x}", Sha256::digest(&data));
        if actual_hash != entry.sha256 {
            return Err(AQBotError::Validation(format!(
                "Bundled media checksum mismatch: {}",
                entry.path
            )));
        }
        let target = target_store.validated_path(&entry.path)?;
        if target.exists() {
            if !target.is_file() {
                return Err(AQBotError::Validation(format!(
                    "Media restore target is not a file: {}",
                    entry.path
                )));
            }
            let existing = std::fs::read(&target).map_err(|error| {
                AQBotError::Gateway(format!(
                    "Failed to inspect existing media {}: {error}",
                    entry.path
                ))
            })?;
            if format!("{:x}", Sha256::digest(&existing)) != entry.sha256 {
                return Err(AQBotError::Validation(format!(
                    "Media restore target conflicts with bundled content: {}",
                    entry.path
                )));
            }
        } else {
            copies.push((source, target));
        }
    }
    Ok(copies)
}

#[cfg(test)]
fn restore_sqlite_backup_with_documents_root(
    backup_path: &Path,
    current_db_path: &Path,
    documents_root: &Path,
) -> Result<()> {
    if !backup_path.is_file() {
        return Err(AQBotError::NotFound(format!(
            "Backup file not found: {}",
            backup_path.display()
        )));
    }
    if !is_zip_bundle(backup_path)? {
        return StagedCopy::prepare(backup_path, current_db_path)?.commit(current_db_path);
    }

    let temp_parent = current_db_path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(temp_parent).map_err(|error| {
        AQBotError::Gateway(format!(
            "Failed to create restore staging directory: {error}"
        ))
    })?;
    let extraction = tempfile::Builder::new()
        .prefix(".aqbot-restore-")
        .tempdir_in(temp_parent)
        .map_err(|error| {
            AQBotError::Gateway(format!(
                "Failed to create restore staging directory: {error}"
            ))
        })?;
    let contents = crate::webdav::extract_backup_zip(backup_path, extraction.path())?;
    let expected_db_checksum = contents
        .metadata
        .get("db_checksum")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            AQBotError::Validation("SQLite backup bundle is missing its DB checksum".to_string())
        })?;
    if !crate::webdav::verify_db_checksum(&contents.db_path, expected_db_checksum)? {
        return Err(AQBotError::Validation(
            "SQLite backup database checksum mismatch".to_string(),
        ));
    }

    let media_copies = validate_bundle_media(&contents, extraction.path(), documents_root)?;
    let staged_db = StagedCopy::prepare(&contents.db_path, current_db_path)?;
    let mut staged_media = Vec::new();
    for (source, target) in media_copies {
        staged_media.push((StagedCopy::prepare(&source, &target)?, target));
    }
    for (staged, target) in staged_media {
        staged.commit(&target)?;
    }
    staged_db.commit(current_db_path)
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
    use super::*;
    use crate::repo::{conversation, stored_file};
    use sea_orm::{Database, EntityTrait};
    use std::io::Write;
    use std::path::PathBuf;

    struct DocumentsRootOverrideGuard;

    impl DocumentsRootOverrideGuard {
        fn set(path: PathBuf) -> Self {
            crate::storage_paths::set_documents_root(path);
            Self
        }
    }

    impl Drop for DocumentsRootOverrideGuard {
        fn drop(&mut self) {
            crate::storage_paths::clear_documents_root_override();
        }
    }

    #[test]
    fn resolve_backup_dir_defaults_to_aqbot_backups_subdir() {
        let aqbot_home = PathBuf::from("/Users/test/.aqbot");

        assert_eq!(
            resolve_backup_dir(None, &aqbot_home),
            aqbot_home.join("backups")
        );
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

    #[tokio::test]
    async fn public_sqlite_backup_uses_active_documents_root_and_round_trips_media() {
        let temp = tempfile::tempdir().unwrap();
        let source_db = temp.path().join("source.db");
        let h = crate::db::create_pool(source_db.to_str().unwrap())
            .await
            .unwrap();
        let db = &h.conn;
        let source_documents = temp.path().join("source-documents");
        let backup_dir = temp.path().join("backups");
        let restored_documents = temp.path().join("restored-documents");
        let file_store = crate::file_store::FileStore::with_root(source_documents.clone());
        let conversation = conversation::create_conversation(db, "backup", "m", "p", None)
            .await
            .unwrap();
        let media_name = format!("migration-{}.png", gen_id());
        let saved = file_store
            .save_file(b"bundled-image", &media_name, "image/png")
            .unwrap();
        stored_file::create_stored_file(
            db,
            "media-1",
            &saved.hash,
            &media_name,
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&conversation.id),
        )
        .await
        .unwrap();

        let documents_root_override = DocumentsRootOverrideGuard::set(source_documents.clone());
        let manifest = create_backup(db, "sqlite", &backup_dir).await.unwrap();
        drop(documents_root_override);
        let bundle_path = PathBuf::from(manifest.file_path.unwrap());
        assert_eq!(
            bundle_path.extension().and_then(|value| value.to_str()),
            Some("zip")
        );

        let restored_db = temp.path().join("restored.db");
        std::fs::write(&restored_db, b"old-database").unwrap();
        restore_sqlite_backup_with_documents_root(&bundle_path, &restored_db, &restored_documents)
            .unwrap();

        assert_eq!(
            std::fs::read(restored_documents.join(&saved.storage_path)).unwrap(),
            b"bundled-image"
        );
        let restored =
            Database::connect(format!("sqlite:{}?mode=ro", restored_db.to_string_lossy()))
                .await
                .unwrap();
        let stored_count = crate::entity::stored_files::Entity::find()
            .count(&restored)
            .await
            .unwrap();
        assert_eq!(stored_count, 1);
    }

    #[test]
    fn legacy_plain_sqlite_backup_still_restores() {
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("legacy.db");
        let current = temp.path().join("current.db");
        std::fs::write(&backup, b"legacy sqlite bytes").unwrap();
        std::fs::write(&current, b"current bytes").unwrap();

        restore_sqlite_backup_with_documents_root(&backup, &current, &temp.path().join("docs"))
            .unwrap();

        assert_eq!(std::fs::read(current).unwrap(), b"legacy sqlite bytes");
    }

    #[test]
    fn traversal_bundle_is_rejected_without_replacing_database() {
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("malicious.zip");
        let current = temp.path().join("current.db");
        std::fs::write(&current, b"current database").unwrap();
        let db_bytes = b"replacement database";
        let db_checksum = format!("{:x}", Sha256::digest(db_bytes));
        let file = std::fs::File::create(&backup).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("aqbot.db", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(db_bytes).unwrap();
        archive
            .start_file("metadata.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(
                serde_json::json!({
                    "db_checksum": db_checksum,
                    "media_files": []
                })
                .to_string()
                .as_bytes(),
            )
            .unwrap();
        archive
            .start_file(
                "documents/images/../../escaped.txt",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(b"escape").unwrap();
        archive.finish().unwrap();

        let error = restore_sqlite_backup_with_documents_root(
            &backup,
            &current,
            &temp.path().join("documents"),
        )
        .unwrap_err();

        assert!(error.to_string().contains("Unsafe ZIP entry path"));
        assert_eq!(std::fs::read(&current).unwrap(), b"current database");
        assert!(!temp.path().join("escaped.txt").exists());
    }

    #[tokio::test]
    async fn conflicting_media_prevents_bundle_from_replacing_database() {
        let temp = tempfile::tempdir().unwrap();
        let source_db = temp.path().join("source.db");
        let h = crate::db::create_pool(source_db.to_str().unwrap())
            .await
            .unwrap();
        let db = &h.conn;
        let source_documents = temp.path().join("source-documents");
        let target_documents = temp.path().join("target-documents");
        let file_store = crate::file_store::FileStore::with_root(source_documents.clone());
        let saved = file_store
            .save_file(b"expected", "image.png", "image/png")
            .unwrap();
        stored_file::create_stored_file(
            db,
            "media-conflict",
            &saved.hash,
            "image.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            None,
        )
        .await
        .unwrap();
        let manifest = create_backup_with_documents_root(
            db,
            "sqlite",
            &temp.path().join("backups"),
            &source_documents,
        )
        .await
        .unwrap();
        let target_path = target_documents.join(&saved.storage_path);
        std::fs::create_dir_all(target_path.parent().unwrap()).unwrap();
        std::fs::write(&target_path, b"conflict").unwrap();
        let current = temp.path().join("current.db");
        std::fs::write(&current, b"current database").unwrap();

        let error = restore_sqlite_backup_with_documents_root(
            Path::new(manifest.file_path.as_deref().unwrap()),
            &current,
            &target_documents,
        )
        .unwrap_err();

        assert!(error.to_string().contains("conflicts"));
        assert_eq!(std::fs::read(current).unwrap(), b"current database");
        assert_eq!(std::fs::read(target_path).unwrap(), b"conflict");
    }

    #[tokio::test]
    async fn json_export_includes_stored_file_metadata_but_marks_media_non_restorable() {
        let h = crate::db::create_test_pool().await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("backup.json");
        stored_file::create_stored_file(
            &h.conn,
            "json-media",
            "hash",
            "image.png",
            "image/png",
            4,
            "images/hash_image.png",
            None,
        )
        .await
        .unwrap();

        create_json_backup(&h.conn, &dest).await.unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dest).unwrap()).unwrap();

        assert_eq!(json["media_payload"]["restorable"], false);
        assert_eq!(json["tables"]["stored_files"][0]["id"], "json-media");
    }
}
