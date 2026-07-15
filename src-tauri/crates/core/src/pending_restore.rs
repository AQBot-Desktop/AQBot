mod apply;
mod sqlite;

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AQBotError, Result};

const PENDING_DIR_NAME: &str = ".pending-restore";
const PAYLOAD_DIR_NAME: &str = "payload";
const MANIFEST_FILE_NAME: &str = "manifest.json";
const JOURNAL_FILE_NAME: &str = "apply-journal.json";
const COMMITTED_MARKER_NAME: &str = "committed";
const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PayloadFile {
    path: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingRestoreManifest {
    version: u32,
    restore_id: String,
    documents_root: String,
    #[serde(default)]
    documents_root_override: Option<String>,
    files: Vec<PayloadFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingRestoreOutcome {
    NotPending,
    Applied,
    FailedSafely {
        error: String,
        quarantine_path: PathBuf,
        report_path: Option<PathBuf>,
    },
}

#[derive(Serialize)]
struct PendingRestoreFailureReport<'a> {
    version: u32,
    failed_at: String,
    error: &'a str,
    quarantine_path: String,
}

struct StagingCleanup {
    path: PathBuf,
    armed: bool,
}

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

pub fn queue_pending_restore(
    backup_path: &Path,
    app_dir: &Path,
    documents_root: &Path,
) -> Result<()> {
    if !backup_path.is_file() {
        return Err(AQBotError::NotFound(format!(
            "Restore source not found: {}",
            backup_path.display()
        )));
    }
    if !documents_root.is_absolute() {
        return Err(AQBotError::Validation(
            "Pending restore documents root must be absolute".to_string(),
        ));
    }
    std::fs::create_dir_all(app_dir).map_err(|error| {
        AQBotError::Gateway(format!(
            "Failed to create restore config directory: {error}"
        ))
    })?;
    let pending_dir = pending_dir(app_dir);
    if pending_dir.exists() {
        return Err(AQBotError::Validation(
            "A pending restore is already queued".to_string(),
        ));
    }

    let restore_id = crate::utils::gen_id();
    let staging_dir = app_dir.join(format!("{PENDING_DIR_NAME}.{restore_id}.migrating"));
    std::fs::create_dir(&staging_dir).map_err(|error| {
        AQBotError::Gateway(format!("Failed to create pending restore staging: {error}"))
    })?;
    secure_directory(&staging_dir)?;
    let mut cleanup = StagingCleanup {
        path: staging_dir.clone(),
        armed: true,
    };
    let payload_dir = staging_dir.join(PAYLOAD_DIR_NAME);
    std::fs::create_dir(&payload_dir).map_err(|error| {
        AQBotError::Gateway(format!("Failed to create pending restore payload: {error}"))
    })?;

    if is_zip_bundle(backup_path)? {
        stage_zip_bundle(backup_path, &payload_dir)?;
    } else {
        copy_file_synced(backup_path, &payload_dir.join("aqbot.db"))?;
    }
    let master_key_path = payload_dir.join("master.key");
    if master_key_path.exists() {
        validate_master_key(&master_key_path)?;
        secure_file(&master_key_path)?;
    }

    let database_path = payload_dir.join("aqbot.db");
    if !database_path.is_file() {
        return Err(AQBotError::Validation(
            "Pending restore payload does not contain aqbot.db".to_string(),
        ));
    }
    let (documents_root, documents_root_override) =
        resolve_restore_documents_root(&database_path, documents_root)?;
    let files = collect_payload_files(&payload_dir)?;
    let documents_root = documents_root.to_str().ok_or_else(|| {
        AQBotError::Validation("Pending restore documents root is not valid UTF-8".to_string())
    })?;
    let manifest = PendingRestoreManifest {
        version: MANIFEST_VERSION,
        restore_id,
        documents_root: documents_root.to_string(),
        documents_root_override,
        files,
    };
    write_json_synced(&staging_dir.join(MANIFEST_FILE_NAME), &manifest)?;
    sync_directory(&staging_dir)?;
    std::fs::rename(&staging_dir, &pending_dir).map_err(|error| {
        AQBotError::Gateway(format!("Failed to publish pending restore: {error}"))
    })?;
    cleanup.armed = false;
    sync_directory(app_dir)?;
    Ok(())
}

pub fn apply_pending_restore(app_dir: &Path) -> Result<PendingRestoreOutcome> {
    match apply::apply_pending_restore(app_dir, None) {
        Ok(true) => Ok(PendingRestoreOutcome::Applied),
        Ok(false) => Ok(PendingRestoreOutcome::NotPending),
        Err(primary) => match apply::settle_failed_apply(app_dir) {
            Ok(true) => Ok(PendingRestoreOutcome::Applied),
            Ok(false) => quarantine_failed_restore(app_dir, primary),
            Err(rollback) => Err(AQBotError::Gateway(format!(
                "Pending restore failed: {primary}; safe rollback could not be confirmed: {rollback}"
            ))),
        },
    }
}

#[cfg(test)]
fn apply_pending_restore_with_failure_after(
    app_dir: &Path,
    published_files: usize,
) -> Result<bool> {
    apply::apply_pending_restore(app_dir, Some(published_files))
}

#[cfg(test)]
fn apply_pending_restore_without_cleanup(app_dir: &Path) -> Result<bool> {
    apply::apply_pending_restore_without_cleanup(app_dir)
}

fn pending_dir(app_dir: &Path) -> PathBuf {
    app_dir.join(PENDING_DIR_NAME)
}

fn canonical_restore_root(path: &Path) -> Result<PathBuf> {
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(AQBotError::Validation(format!(
            "Pending restore documents root is not normalized: {}",
            path.display()
        )));
    }

    let mut existing = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = existing.file_name().ok_or_else(|| {
                    AQBotError::Validation(format!(
                        "Pending restore documents root has no existing ancestor: {}",
                        path.display()
                    ))
                })?;
                missing.push(name.to_os_string());
                existing.pop();
            }
            Err(error) => {
                return Err(AQBotError::Gateway(format!(
                    "Failed to inspect pending restore documents root {}: {error}",
                    existing.display()
                )));
            }
        }
    }

    let mut canonical = std::fs::canonicalize(&existing).map_err(|error| {
        AQBotError::Gateway(format!(
            "Failed to canonicalize pending restore documents root ancestor {}: {error}",
            existing.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(AQBotError::Validation(format!(
            "Pending restore documents root ancestor is not a directory: {}",
            canonical.display()
        )));
    }
    for name in missing.into_iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

fn resolve_restore_documents_root(
    database_path: &Path,
    fallback_root: &Path,
) -> Result<(PathBuf, Option<String>)> {
    if let Some(raw_override) = sqlite::read_documents_root_override(database_path)? {
        if let Some(override_value) = decode_documents_root_override(&raw_override) {
            let override_path = PathBuf::from(&override_value);
            if override_path.is_absolute() && override_path.is_dir() {
                let canonical = canonical_restore_root(&override_path)?;
                let canonical_value = canonical.to_str().ok_or_else(|| {
                    AQBotError::Validation(
                        "Restored documents root override is not valid UTF-8".to_string(),
                    )
                })?;
                return Ok((canonical.clone(), Some(canonical_value.to_string())));
            }
            tracing::warn!(
                restored_override = %override_value,
                fallback_root = %fallback_root.display(),
                "Restored documents root override is unavailable; using the platform default"
            );
        }
    }

    Ok((canonical_restore_root(fallback_root)?, None))
}

fn decode_documents_root_override(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(value) {
        Ok(serde_json::Value::String(value)) if !value.trim().is_empty() => Some(value),
        Ok(serde_json::Value::Null) => None,
        Ok(_) => None,
        Err(_) => Some(value.to_string()),
    }
}

fn quarantine_failed_restore(app_dir: &Path, error: AQBotError) -> Result<PendingRestoreOutcome> {
    let pending = pending_dir(app_dir);
    if !pending.exists() {
        return Err(AQBotError::Gateway(format!(
            "Pending restore failed but its payload disappeared: {error}"
        )));
    }
    let failure_id = crate::utils::gen_id();
    let quarantine_path = app_dir.join(format!("{PENDING_DIR_NAME}.failed-{failure_id}"));
    std::fs::rename(&pending, &quarantine_path).map_err(|quarantine_error| {
        AQBotError::Gateway(format!(
            "Pending restore failed safely ({error}), but its payload could not be quarantined: {quarantine_error}"
        ))
    })?;
    sync_directory(app_dir)?;

    let error = error.to_string();
    let report_path = app_dir.join(format!(".pending-restore-error-{failure_id}.json"));
    let report = PendingRestoreFailureReport {
        version: 1,
        failed_at: chrono::Utc::now().to_rfc3339(),
        error: &error,
        quarantine_path: quarantine_path.to_string_lossy().into_owned(),
    };
    let report_path = match write_json_synced(&report_path, &report) {
        Ok(()) => Some(report_path),
        Err(report_error) => {
            tracing::error!(
                error = %report_error,
                quarantine_path = %quarantine_path.display(),
                "Failed to persist pending restore failure report"
            );
            None
        }
    };
    Ok(PendingRestoreOutcome::FailedSafely {
        error,
        quarantine_path,
        report_path,
    })
}

fn read_manifest(pending_dir: &Path) -> Result<PendingRestoreManifest> {
    let bytes = std::fs::read(pending_dir.join(MANIFEST_FILE_NAME)).map_err(|error| {
        AQBotError::Gateway(format!("Failed to read pending restore manifest: {error}"))
    })?;
    let manifest: PendingRestoreManifest = serde_json::from_slice(&bytes).map_err(|error| {
        AQBotError::Validation(format!("Pending restore manifest is invalid: {error}"))
    })?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &PendingRestoreManifest) -> Result<()> {
    if manifest.version != MANIFEST_VERSION {
        return Err(AQBotError::Validation(format!(
            "Unsupported pending restore manifest version: {}",
            manifest.version
        )));
    }
    if manifest.restore_id.is_empty()
        || !manifest
            .restore_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AQBotError::Validation(
            "Pending restore id is invalid".to_string(),
        ));
    }
    let documents_root = Path::new(&manifest.documents_root);
    if !documents_root.is_absolute()
        || documents_root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(AQBotError::Validation(
            "Pending restore documents root must be absolute and normalized".to_string(),
        ));
    }
    if manifest
        .documents_root_override
        .as_deref()
        .is_some_and(|value| value != manifest.documents_root)
    {
        return Err(AQBotError::Validation(
            "Pending restore documents root decision is inconsistent".to_string(),
        ));
    }
    let mut paths = HashSet::new();
    for file in &manifest.files {
        validate_payload_relative_path(&file.path)?;
        if !paths.insert(file.path.as_str()) {
            return Err(AQBotError::Validation(format!(
                "Pending restore manifest contains duplicate path: {}",
                file.path
            )));
        }
    }
    if !paths.contains("aqbot.db") {
        return Err(AQBotError::Validation(
            "Pending restore manifest does not contain aqbot.db".to_string(),
        ));
    }
    Ok(())
}

fn verify_payload(pending_dir: &Path, manifest: &PendingRestoreManifest) -> Result<()> {
    let actual = collect_payload_files(&pending_dir.join(PAYLOAD_DIR_NAME))?;
    if actual != manifest.files {
        return Err(AQBotError::Validation(
            "Pending restore payload no longer matches its manifest".to_string(),
        ));
    }
    Ok(())
}

fn stage_zip_bundle(backup_path: &Path, payload_dir: &Path) -> Result<()> {
    let contents = crate::webdav::extract_backup_zip(backup_path, payload_dir)?;
    let version = contents
        .metadata
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1);
    match contents
        .metadata
        .get("db_checksum")
        .and_then(serde_json::Value::as_str)
    {
        Some(expected) if !crate::webdav::verify_db_checksum(&contents.db_path, expected)? => {
            return Err(AQBotError::Validation(
                "Pending restore database checksum mismatch".to_string(),
            ));
        }
        None if version >= 2 => {
            return Err(AQBotError::Validation(
                "Pending restore bundle is missing its database checksum".to_string(),
            ));
        }
        _ => {}
    }
    crate::webdav::verify_backup_media_manifest(&contents, payload_dir)?;
    Ok(())
}

fn collect_payload_files(root: &Path) -> Result<Vec<PayloadFile>> {
    let mut paths = Vec::new();
    collect_file_paths(root, &mut paths)?;
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let relative = path.strip_prefix(root).map_err(|error| {
                AQBotError::Validation(format!("Invalid pending payload path: {error}"))
            })?;
            let relative = relative.to_string_lossy().replace('\\', "/");
            validate_payload_relative_path(&relative)?;
            let (sha256, size) = hash_file(&path)?;
            Ok(PayloadFile {
                path: relative,
                sha256,
                size,
            })
        })
        .collect()
}

fn collect_file_paths(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir).map_err(|error| {
        AQBotError::Gateway(format!(
            "Failed to inspect pending restore payload: {error}"
        ))
    })? {
        let entry = entry.map_err(|error| {
            AQBotError::Gateway(format!("Failed to inspect pending restore entry: {error}"))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            AQBotError::Gateway(format!(
                "Failed to inspect pending restore file type: {error}"
            ))
        })?;
        if file_type.is_symlink() {
            return Err(AQBotError::Validation(format!(
                "Pending restore payload cannot contain symlinks: {}",
                entry.path().display()
            )));
        }
        if file_type.is_dir() {
            collect_file_paths(&entry.path(), paths)?;
        } else if file_type.is_file() {
            paths.push(entry.path());
        }
    }
    Ok(())
}

fn validate_payload_relative_path(value: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AQBotError::Validation(format!(
            "Unsafe pending restore payload path: {value}"
        )));
    }
    Ok(())
}

fn is_zip_bundle(path: &Path) -> Result<bool> {
    let mut file = std::fs::File::open(path)?;
    let mut magic = [0_u8; 4];
    let read = file.read(&mut magic)?;
    Ok(read == magic.len()
        && matches!(
            magic,
            [b'P', b'K', 3, 4] | [b'P', b'K', 5, 6] | [b'P', b'K', 7, 8]
        ))
}

fn hash_file(path: &Path) -> Result<(String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn copy_file_synced(source: &Path, target: &Path) -> Result<()> {
    let mut input = std::fs::File::open(source)?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let copy = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    drop(output);
    match copy {
        Ok(()) => Ok(()),
        Err(primary) => match std::fs::remove_file(target) {
            Ok(()) => Err(primary.into()),
            Err(cleanup) => Err(AQBotError::Gateway(format!(
                "Failed to copy restore staging: {primary}; partial staging cleanup failed: {cleanup}"
            ))),
        },
    }
}

fn write_json_synced<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        AQBotError::Validation(format!(
            "Failed to serialize pending restore state: {error}"
        ))
    })?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

fn validate_master_key(path: &Path) -> Result<()> {
    let size = std::fs::metadata(path)?.len();
    if size != 32 {
        return Err(AQBotError::Validation(format!(
            "Pending restore master.key must be exactly 32 bytes, got {size}"
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn secure_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    std::fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, SeekFrom, Write};

    use sha2::{Digest, Sha256};
    use zip::write::SimpleFileOptions;

    use super::*;

    fn write_bundle(path: &Path) {
        write_bundle_with_options(path, None, false);
    }

    fn write_bundle_with_options(
        path: &Path,
        documents_root_override: Option<&Path>,
        corrupt_database: bool,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let database_path = temp.path().join("aqbot.db");
        sqlite::create_test_database(
            &database_path,
            "new-database",
            documents_root_override.and_then(Path::to_str),
        )
        .unwrap();
        if corrupt_database {
            let size = std::fs::metadata(&database_path).unwrap().len();
            assert!(size > 4096);
            let mut database = std::fs::OpenOptions::new()
                .write(true)
                .open(&database_path)
                .unwrap();
            database.seek(SeekFrom::Start(size - 4096)).unwrap();
            database.write_all(&u32::MAX.to_be_bytes()).unwrap();
            database.sync_all().unwrap();
        }
        let db = std::fs::read(&database_path).unwrap();
        let image = b"new-image";
        let db_checksum = format!("{:x}", Sha256::digest(&db));
        let image_checksum = format!("{:x}", Sha256::digest(image));
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();

        zip.start_file("aqbot.db", options).unwrap();
        zip.write_all(&db).unwrap();
        for (name, bytes) in [
            ("master.key", &[9_u8; 32][..]),
            ("documents/images/restored.png", image.as_slice()),
            ("workspace/state.json", &br#"{"restored":true}"#[..]),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.start_file("metadata.json", options).unwrap();
        zip.write_all(
            serde_json::json!({
                "version": 2,
                "db_checksum": db_checksum,
                "media_files": [{
                    "path": "images/restored.png",
                    "sha256": image_checksum,
                    "size": image.len(),
                }]
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let app_dir = temp.path().join("config");
        let documents_root = temp.path().join("documents");
        std::fs::create_dir_all(app_dir.join("workspace")).unwrap();
        std::fs::create_dir_all(documents_root.join("images")).unwrap();
        sqlite::create_test_database(&app_dir.join("aqbot.db"), "old-database", None).unwrap();
        std::fs::write(app_dir.join("master.key"), [1_u8; 32]).unwrap();
        std::fs::write(app_dir.join("workspace/state.json"), b"old-workspace").unwrap();
        std::fs::write(documents_root.join("images/existing.png"), b"old-image").unwrap();
        (temp, app_dir, documents_root)
    }

    fn assert_database_marker(path: &Path, expected: &str) {
        assert_eq!(
            sqlite::read_test_marker(path).unwrap().as_deref(),
            Some(expected)
        );
    }

    #[test]
    fn queued_restore_does_not_touch_live_files_before_restart() {
        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("backup.zip");
        write_bundle(&bundle);

        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();

        assert_database_marker(&app_dir.join("aqbot.db"), "old-database");
        assert_eq!(
            std::fs::read(app_dir.join("master.key")).unwrap(),
            [1_u8; 32]
        );
        assert!(!documents_root.join("images/restored.png").exists());
        assert!(app_dir.join(".pending-restore").is_dir());

        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));
        assert_database_marker(&app_dir.join("aqbot.db"), "new-database");
        assert_eq!(
            std::fs::read(app_dir.join("master.key")).unwrap(),
            [9_u8; 32]
        );
        assert_eq!(
            std::fs::read(documents_root.join("images/restored.png")).unwrap(),
            b"new-image"
        );
        assert!(!app_dir.join(".pending-restore").exists());
    }

    #[test]
    fn publish_failure_rolls_back_every_target_and_keeps_pending_payload() {
        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("backup.zip");
        write_bundle(&bundle);
        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();

        let error = apply_pending_restore_with_failure_after(&app_dir, 3).unwrap_err();

        assert!(error.to_string().contains("injected"));
        assert_database_marker(&app_dir.join("aqbot.db"), "old-database");
        assert_eq!(
            std::fs::read(app_dir.join("master.key")).unwrap(),
            [1_u8; 32]
        );
        assert_eq!(
            std::fs::read(app_dir.join("workspace/state.json")).unwrap(),
            b"old-workspace"
        );
        assert!(!documents_root.join("images/restored.png").exists());
        assert_eq!(
            std::fs::read(documents_root.join("images/existing.png")).unwrap(),
            b"old-image"
        );
        assert!(app_dir.join(".pending-restore").is_dir());

        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));
        assert_database_marker(&app_dir.join("aqbot.db"), "new-database");
        assert_eq!(
            std::fs::read(app_dir.join("master.key")).unwrap(),
            [9_u8; 32]
        );
    }

    #[test]
    fn database_quick_check_failure_rolls_back_every_published_target() {
        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("corrupt-backup.zip");
        write_bundle_with_options(&bundle, None, true);
        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();

        let outcome = apply_pending_restore(&app_dir).unwrap();

        let PendingRestoreOutcome::FailedSafely { error, .. } = outcome else {
            panic!("a corrupt restored database must be rolled back and quarantined");
        };
        assert!(error.contains("quick_check"), "unexpected error: {error}");
        assert_database_marker(&app_dir.join("aqbot.db"), "old-database");
        assert_eq!(
            std::fs::read(app_dir.join("master.key")).unwrap(),
            [1_u8; 32]
        );
        assert_eq!(
            std::fs::read(app_dir.join("workspace/state.json")).unwrap(),
            b"old-workspace"
        );
        assert!(!documents_root.join("images/restored.png").exists());
        assert_eq!(
            std::fs::read(documents_root.join("images/existing.png")).unwrap(),
            b"old-image"
        );
    }

    #[test]
    fn restored_override_selects_the_same_documents_root_for_media_and_startup() {
        let (temp, app_dir, fallback_root) = fixture();
        let restored_root = temp.path().join("restored-documents-root");
        std::fs::create_dir(&restored_root).unwrap();
        let bundle = temp.path().join("override-backup.zip");
        write_bundle_with_options(&bundle, Some(&restored_root), false);

        queue_pending_restore(&bundle, &app_dir, &fallback_root).unwrap();
        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));

        let restored_root = std::fs::canonicalize(restored_root).unwrap();
        assert!(!fallback_root.join("images/restored.png").exists());
        assert_eq!(
            std::fs::read(restored_root.join("images/restored.png")).unwrap(),
            b"new-image"
        );
        assert_eq!(
            sqlite::read_documents_root_override(&app_dir.join("aqbot.db"))
                .unwrap()
                .as_deref(),
            restored_root.to_str()
        );
    }

    #[test]
    fn unavailable_restored_override_falls_back_and_is_cleared() {
        let (temp, app_dir, fallback_root) = fixture();
        let unavailable_root = temp.path().join("missing-source-machine-root");
        let bundle = temp.path().join("unavailable-override-backup.zip");
        write_bundle_with_options(&bundle, Some(&unavailable_root), false);

        queue_pending_restore(&bundle, &app_dir, &fallback_root).unwrap();
        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));

        assert_eq!(
            std::fs::read(fallback_root.join("images/restored.png")).unwrap(),
            b"new-image"
        );
        assert!(!unavailable_root.join("images/restored.png").exists());
        assert_eq!(
            sqlite::read_documents_root_override(&app_dir.join("aqbot.db")).unwrap(),
            None
        );
    }

    #[test]
    fn invalid_pending_payload_is_quarantined_without_blocking_the_old_database() {
        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("backup.zip");
        write_bundle(&bundle);
        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();
        std::fs::write(
            app_dir.join(".pending-restore/payload/aqbot.db"),
            b"corrupted-after-queue",
        )
        .unwrap();

        let outcome = apply_pending_restore(&app_dir).unwrap();

        let PendingRestoreOutcome::FailedSafely {
            quarantine_path,
            report_path,
            ..
        } = outcome
        else {
            panic!("invalid payload must be quarantined");
        };
        assert_database_marker(&app_dir.join("aqbot.db"), "old-database");
        assert_eq!(
            std::fs::read(app_dir.join("master.key")).unwrap(),
            [1_u8; 32]
        );
        assert!(!app_dir.join(".pending-restore").exists());
        assert!(quarantine_path.is_dir());
        assert!(report_path.is_some_and(|path| path.is_file()));
        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::NotPending
        ));
    }

    #[test]
    fn committed_restore_cleanup_is_not_published_a_second_time() {
        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("backup.zip");
        write_bundle(&bundle);
        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();

        assert!(apply_pending_restore_without_cleanup(&app_dir).unwrap());
        assert!(app_dir.join(".pending-restore/committed").is_file());
        assert!(app_dir
            .join(".pending-restore/apply-journal.json")
            .is_file());

        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));
        assert_database_marker(&app_dir.join("aqbot.db"), "new-database");
        assert_eq!(
            std::fs::read(app_dir.join("master.key")).unwrap(),
            [9_u8; 32]
        );
        assert!(!app_dir.join(".pending-restore").exists());
    }

    #[test]
    fn committed_cleanup_failure_retries_without_republishing() {
        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("backup.zip");
        write_bundle(&bundle);
        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();
        assert!(apply_pending_restore_without_cleanup(&app_dir).unwrap());

        let database_rollback = std::fs::read_dir(&app_dir)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with(".aqbot.db.aqbot-restore-") && name.ends_with(".rollback")
                    })
            })
            .expect("committed restore must retain the old database until cleanup");
        std::fs::remove_file(&database_rollback).unwrap();
        std::fs::create_dir(&database_rollback).unwrap();

        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));
        assert!(app_dir.join(".pending-restore/committed").is_file());

        sqlite::update_test_marker(&app_dir.join("aqbot.db"), "changed-after-commit").unwrap();
        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));
        assert_database_marker(&app_dir.join("aqbot.db"), "changed-after-commit");

        std::fs::remove_dir(database_rollback).unwrap();
        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));
        assert!(!app_dir.join(".pending-restore").exists());
    }

    #[test]
    fn truncated_journal_staging_is_ignored_before_publication() {
        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("backup.zip");
        write_bundle(&bundle);
        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();
        std::fs::write(
            app_dir.join(".pending-restore/apply-journal.json.migrating"),
            b"{",
        )
        .unwrap();

        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::Applied
        ));
        assert_database_marker(&app_dir.join("aqbot.db"), "new-database");
        assert_eq!(
            std::fs::read(app_dir.join("master.key")).unwrap(),
            [9_u8; 32]
        );
        assert!(!app_dir.join(".pending-restore").exists());
    }

    #[cfg(unix)]
    #[test]
    fn document_target_symlink_escape_is_quarantined_without_publication() {
        use std::os::unix::fs::symlink;

        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("backup.zip");
        write_bundle(&bundle);
        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();

        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::remove_file(documents_root.join("images/existing.png")).unwrap();
        std::fs::remove_dir(documents_root.join("images")).unwrap();
        symlink(&outside, documents_root.join("images")).unwrap();

        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::FailedSafely { .. }
        ));
        assert_database_marker(&app_dir.join("aqbot.db"), "old-database");
        assert!(!outside.join("restored.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_target_symlink_escape_is_quarantined_without_publication() {
        use std::os::unix::fs::symlink;

        let (temp, app_dir, documents_root) = fixture();
        let bundle = temp.path().join("backup.zip");
        write_bundle(&bundle);
        queue_pending_restore(&bundle, &app_dir, &documents_root).unwrap();

        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::remove_file(app_dir.join("workspace/state.json")).unwrap();
        std::fs::remove_dir(app_dir.join("workspace")).unwrap();
        symlink(&outside, app_dir.join("workspace")).unwrap();

        assert!(matches!(
            apply_pending_restore(&app_dir).unwrap(),
            PendingRestoreOutcome::FailedSafely { .. }
        ));
        assert_database_marker(&app_dir.join("aqbot.db"), "old-database");
        assert!(!outside.join("state.json").exists());
    }
}
