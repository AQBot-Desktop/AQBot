use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    copy_file_synced, pending_dir, read_manifest, secure_file, sqlite, sync_directory,
    verify_payload, PendingRestoreManifest, COMMITTED_MARKER_NAME, JOURNAL_FILE_NAME,
    PAYLOAD_DIR_NAME,
};
use crate::error::{AQBotError, Result};

const JOURNAL_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct ApplyJournal {
    version: u32,
    restore_id: String,
    target_existed: Vec<bool>,
}

#[derive(Debug, Clone)]
struct DesiredOperation {
    source: Option<PathBuf>,
    target: PathBuf,
    containment_root: Option<PathBuf>,
}

#[derive(Debug)]
struct TransactionOperation {
    desired: DesiredOperation,
    staging: Option<PathBuf>,
    rollback: PathBuf,
    target_existed: bool,
}

enum RecoveryOutcome {
    Continue,
    Committed,
}

pub(super) fn apply_pending_restore(
    app_dir: &Path,
    fail_after_published: Option<usize>,
) -> Result<bool> {
    apply_pending_restore_with_options(app_dir, fail_after_published, false)
}

#[cfg(test)]
pub(super) fn apply_pending_restore_without_cleanup(app_dir: &Path) -> Result<bool> {
    apply_pending_restore_with_options(app_dir, None, true)
}

fn apply_pending_restore_with_options(
    app_dir: &Path,
    fail_after_published: Option<usize>,
    skip_committed_cleanup: bool,
) -> Result<bool> {
    let pending_dir = pending_dir(app_dir);
    if !pending_dir.exists() {
        return Ok(false);
    }
    if !pending_dir.is_dir() {
        return Err(AQBotError::Validation(
            "Pending restore path is not a directory".to_string(),
        ));
    }

    let manifest = read_manifest(&pending_dir)?;
    let desired = build_desired_operations(app_dir, &pending_dir, &manifest)?;
    if matches!(
        recover_interrupted_apply(&pending_dir, &manifest, &desired)?,
        RecoveryOutcome::Committed
    ) {
        return Ok(true);
    }
    verify_payload(&pending_dir, &manifest)?;

    let operations = prepare_operations(&manifest.restore_id, &desired)?;
    let journal = ApplyJournal {
        version: JOURNAL_VERSION,
        restore_id: manifest.restore_id.clone(),
        target_existed: operations
            .iter()
            .map(|operation| operation.target_existed)
            .collect(),
    };
    if let Err(error) = write_journal(&pending_dir, &journal) {
        return Err(cleanup_prepared_staging(&operations, error));
    }

    let publish_result = publish_operations(&operations, fail_after_published)
        .and_then(|()| {
            sqlite::finalize_restored_database(
                &app_dir.join("aqbot.db"),
                manifest.documents_root_override.as_deref(),
            )
        })
        .and_then(|()| sync_restored_database(app_dir))
        .and_then(|()| write_marker(&pending_dir.join(COMMITTED_MARKER_NAME)));
    if let Err(error) = publish_result {
        return rollback_after_error(&pending_dir, &operations, error);
    }

    if !skip_committed_cleanup {
        finalize_committed_restore(&pending_dir, &operations);
    }
    Ok(true)
}

fn build_desired_operations(
    app_dir: &Path,
    pending_dir: &Path,
    manifest: &PendingRestoreManifest,
) -> Result<Vec<DesiredOperation>> {
    let payload = pending_dir.join(PAYLOAD_DIR_NAME);
    let documents_root = PathBuf::from(&manifest.documents_root);
    let workspace_root = app_dir.join("workspace");
    let mut documents = Vec::new();
    let mut workspace = Vec::new();
    let mut master_key = None;
    let mut database = None;

    for file in &manifest.files {
        let relative_path = Path::new(&file.path);
        let source = payload.join(&file.path);
        if file.path == "aqbot.db" {
            database = Some(DesiredOperation {
                source: Some(source),
                target: app_dir.join("aqbot.db"),
                containment_root: None,
            });
        } else if file.path == "master.key" {
            master_key = Some(DesiredOperation {
                source: Some(source),
                target: app_dir.join("master.key"),
                containment_root: None,
            });
        } else if let Ok(relative) = relative_path.strip_prefix(Path::new("documents")) {
            if relative.as_os_str().is_empty() {
                return Err(unsupported_payload_path(&file.path));
            }
            documents.push(DesiredOperation {
                source: Some(source),
                target: documents_root.join(relative),
                containment_root: Some(documents_root.clone()),
            });
        } else if let Ok(relative) = relative_path.strip_prefix(Path::new("workspace")) {
            if relative.as_os_str().is_empty() {
                return Err(unsupported_payload_path(&file.path));
            }
            workspace.push(DesiredOperation {
                source: Some(source),
                target: workspace_root.join(relative),
                containment_root: Some(workspace_root.clone()),
            });
        } else {
            return Err(unsupported_payload_path(&file.path));
        }
    }

    let database = database.ok_or_else(|| {
        AQBotError::Validation("Pending restore database payload is missing".to_string())
    })?;
    documents.sort_by(|left, right| left.target.cmp(&right.target));
    workspace.sort_by(|left, right| left.target.cmp(&right.target));
    let mut desired = documents;
    desired.extend(workspace);
    desired.extend(master_key);
    for suffix in ["wal", "shm", "journal"] {
        desired.push(DesiredOperation {
            source: None,
            target: app_dir.join(format!("aqbot.db-{suffix}")),
            containment_root: None,
        });
    }
    desired.push(database);

    let mut targets = HashSet::new();
    for operation in &desired {
        validate_target_chain(operation)?;
        if !targets.insert(operation.target.clone()) {
            return Err(AQBotError::Validation(format!(
                "Pending restore contains conflicting target: {}",
                operation.target.display()
            )));
        }
    }
    Ok(desired)
}

fn validate_target_chain(operation: &DesiredOperation) -> Result<()> {
    let Some(root) = &operation.containment_root else {
        return Ok(());
    };
    match std::fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(AQBotError::Validation(format!(
                "Pending restore target root is a symlink: {}",
                root.display()
            )));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(AQBotError::Validation(format!(
                "Pending restore target root is not a directory: {}",
                root.display()
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AQBotError::Gateway(format!(
                "Failed to inspect pending restore target root {}: {error}",
                root.display()
            )));
        }
    }
    let relative = operation.target.strip_prefix(root).map_err(|error| {
        AQBotError::Validation(format!(
            "Pending restore target {} escapes {}: {error}",
            operation.target.display(),
            root.display()
        ))
    })?;
    let components = relative.components().collect::<Vec<_>>();
    if components.is_empty()
        || components
            .iter()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(AQBotError::Validation(format!(
            "Pending restore target is unsafe: {}",
            operation.target.display()
        )));
    }

    let mut current = root.clone();
    for (index, component) in components.iter().enumerate() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AQBotError::Validation(format!(
                    "Pending restore target traverses a symlink: {}",
                    current.display()
                )));
            }
            Ok(metadata) if index + 1 < components.len() && !metadata.is_dir() => {
                return Err(AQBotError::Validation(format!(
                    "Pending restore target parent is not a directory: {}",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(AQBotError::Gateway(format!(
                    "Failed to inspect pending restore target {}: {error}",
                    current.display()
                )));
            }
        }
    }
    Ok(())
}

fn unsupported_payload_path(path: &str) -> AQBotError {
    AQBotError::Validation(format!("Unsupported pending restore payload path: {path}"))
}

fn sync_restored_database(app_dir: &Path) -> Result<()> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = app_dir.join(format!("aqbot.db{suffix}"));
        if !path.exists() {
            continue;
        }
        if !path.is_file() {
            return Err(AQBotError::Validation(format!(
                "Restored SQLite artifact is not a file: {}",
                path.display()
            )));
        }
        std::fs::File::open(&path)?.sync_all()?;
    }
    sync_directory(app_dir)
}

fn recover_interrupted_apply(
    pending_dir: &Path,
    manifest: &PendingRestoreManifest,
    desired: &[DesiredOperation],
) -> Result<RecoveryOutcome> {
    let journal_path = pending_dir.join(JOURNAL_FILE_NAME);
    if !journal_path.exists() {
        if pending_dir.join(COMMITTED_MARKER_NAME).exists() {
            return Err(AQBotError::Validation(
                "Pending restore has a committed marker without a journal".to_string(),
            ));
        }
        remove_file_if_exists(&pending_dir.join(format!("{JOURNAL_FILE_NAME}.migrating")))?;
        remove_file_if_exists(&pending_dir.join(format!("{COMMITTED_MARKER_NAME}.migrating")))?;
        return Ok(RecoveryOutcome::Continue);
    }

    let journal = read_journal(&journal_path)?;
    validate_journal(&journal, manifest, desired.len())?;
    let operations = operations_from_journal(&manifest.restore_id, desired, &journal)?;
    if pending_dir.join(COMMITTED_MARKER_NAME).exists() {
        finalize_committed_restore(pending_dir, &operations);
        return Ok(RecoveryOutcome::Committed);
    }

    rollback_operations(&operations)?;
    std::fs::remove_file(&journal_path).map_err(|error| {
        AQBotError::Gateway(format!(
            "Failed to clear recovered restore journal: {error}"
        ))
    })?;
    remove_file_if_exists(&pending_dir.join(format!("{COMMITTED_MARKER_NAME}.migrating")))?;
    sync_directory(pending_dir)?;
    Ok(RecoveryOutcome::Continue)
}

pub(super) fn settle_failed_apply(app_dir: &Path) -> Result<bool> {
    let pending_dir = super::pending_dir(app_dir);
    let journal_path = pending_dir.join(JOURNAL_FILE_NAME);
    if !journal_path.exists() {
        return Ok(false);
    }
    let manifest = super::read_manifest(&pending_dir)?;
    let desired = build_desired_operations(app_dir, &pending_dir, &manifest)?;
    let journal = read_journal(&journal_path)?;
    validate_journal(&journal, &manifest, desired.len())?;
    let operations = operations_from_journal(&manifest.restore_id, &desired, &journal)?;
    if pending_dir.join(COMMITTED_MARKER_NAME).exists() {
        finalize_committed_restore(&pending_dir, &operations);
        return Ok(true);
    }
    rollback_operations(&operations)?;
    std::fs::remove_file(&journal_path)?;
    remove_file_if_exists(&pending_dir.join(format!("{COMMITTED_MARKER_NAME}.migrating")))?;
    sync_directory(&pending_dir)?;
    Ok(false)
}

fn prepare_operations(
    restore_id: &str,
    desired: &[DesiredOperation],
) -> Result<Vec<TransactionOperation>> {
    let mut operations = Vec::with_capacity(desired.len());
    for (index, desired) in desired.iter().enumerate() {
        match prepare_operation(restore_id, index, desired) {
            Ok(operation) => operations.push(operation),
            Err(error) => return Err(cleanup_prepared_staging(&operations, error)),
        }
    }
    Ok(operations)
}

fn prepare_operation(
    restore_id: &str,
    index: usize,
    desired: &DesiredOperation,
) -> Result<TransactionOperation> {
    validate_target_chain(desired)?;
    let parent = desired.target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| {
        AQBotError::Gateway(format!(
            "Failed to create restore target directory {}: {error}",
            parent.display()
        ))
    })?;
    if desired.target.exists() && !desired.target.is_file() {
        return Err(AQBotError::Validation(format!(
            "Restore target is not a file: {}",
            desired.target.display()
        )));
    }
    let staging = desired
        .source
        .as_ref()
        .map(|_| artifact_path(&desired.target, restore_id, index, "migrating"));
    let rollback = artifact_path(&desired.target, restore_id, index, "rollback");
    if rollback.exists() {
        return Err(AQBotError::Validation(format!(
            "Unexpected restore rollback artifact: {}",
            rollback.display()
        )));
    }
    if let Some(staging) = &staging {
        remove_file_if_exists(staging)?;
        copy_file_synced(desired.source.as_ref().unwrap(), staging)?;
        if desired.target.file_name().and_then(|name| name.to_str()) == Some("master.key") {
            if let Err(error) = secure_file(staging) {
                let cleanup = std::fs::remove_file(staging);
                return match cleanup {
                    Ok(()) => Err(error),
                    Err(cleanup) => Err(AQBotError::Gateway(format!(
                        "Failed to secure restore staging: {error}; cleanup failed: {cleanup}"
                    ))),
                };
            }
        }
    }
    Ok(TransactionOperation {
        desired: desired.clone(),
        staging,
        rollback,
        target_existed: desired.target.is_file(),
    })
}

fn cleanup_prepared_staging(
    operations: &[TransactionOperation],
    primary: AQBotError,
) -> AQBotError {
    let failures = operations
        .iter()
        .filter_map(|operation| operation.staging.as_ref())
        .filter_map(|staging| match std::fs::remove_file(staging) {
            Ok(()) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => Some(format!("{}: {error}", staging.display())),
        })
        .collect::<Vec<_>>();
    if failures.is_empty() {
        primary
    } else {
        AQBotError::Gateway(format!(
            "Pending restore preparation failed: {primary}; staging cleanup failed: {}",
            failures.join("; ")
        ))
    }
}

fn operations_from_journal(
    restore_id: &str,
    desired: &[DesiredOperation],
    journal: &ApplyJournal,
) -> Result<Vec<TransactionOperation>> {
    desired
        .iter()
        .enumerate()
        .map(|(index, desired)| {
            Ok(TransactionOperation {
                desired: desired.clone(),
                staging: desired
                    .source
                    .as_ref()
                    .map(|_| artifact_path(&desired.target, restore_id, index, "migrating")),
                rollback: artifact_path(&desired.target, restore_id, index, "rollback"),
                target_existed: journal.target_existed[index],
            })
        })
        .collect()
}

fn publish_operations(
    operations: &[TransactionOperation],
    fail_after_published: Option<usize>,
) -> Result<()> {
    let mut published = 0_usize;
    for operation in operations {
        validate_target_chain(&operation.desired)?;
        if operation.target_existed {
            if !operation.desired.target.is_file() {
                return Err(AQBotError::Validation(format!(
                    "Restore target changed before publication: {}",
                    operation.desired.target.display()
                )));
            }
            std::fs::rename(&operation.desired.target, &operation.rollback).map_err(|error| {
                AQBotError::Gateway(format!(
                    "Failed to preserve restore target {}: {error}",
                    operation.desired.target.display()
                ))
            })?;
        } else if operation.desired.target.exists() {
            return Err(AQBotError::Validation(format!(
                "Restore target appeared during publication: {}",
                operation.desired.target.display()
            )));
        }

        if let Some(staging) = &operation.staging {
            std::fs::rename(staging, &operation.desired.target).map_err(|error| {
                AQBotError::Gateway(format!(
                    "Failed to publish restore target {}: {error}",
                    operation.desired.target.display()
                ))
            })?;
        }
        sync_directory(
            operation
                .desired
                .target
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        )?;
        published += 1;
        if fail_after_published == Some(published) {
            return Err(AQBotError::Gateway(format!(
                "injected pending restore failure after {published} published files"
            )));
        }
    }
    Ok(())
}

fn rollback_after_error(
    pending_dir: &Path,
    operations: &[TransactionOperation],
    primary: AQBotError,
) -> Result<bool> {
    if let Err(rollback) = rollback_operations(operations) {
        return Err(AQBotError::Gateway(format!(
            "Pending restore failed: {primary}; rollback also failed: {rollback}"
        )));
    }
    let journal_path = pending_dir.join(JOURNAL_FILE_NAME);
    if journal_path.exists() {
        std::fs::remove_file(&journal_path).map_err(|error| {
            AQBotError::Gateway(format!(
                "Pending restore failed: {primary}; rollback succeeded but journal cleanup failed: {error}"
            ))
        })?;
        sync_directory(pending_dir)?;
    }
    Err(primary)
}

fn rollback_operations(operations: &[TransactionOperation]) -> Result<()> {
    let mut failures = Vec::new();
    for operation in operations.iter().rev() {
        if operation.rollback.exists() {
            if operation.desired.target.exists() {
                if operation.desired.target.is_file() {
                    if let Err(error) = std::fs::remove_file(&operation.desired.target) {
                        failures.push(format!(
                            "remove replacement {}: {error}",
                            operation.desired.target.display()
                        ));
                        continue;
                    }
                } else {
                    failures.push(format!(
                        "replacement target became a directory: {}",
                        operation.desired.target.display()
                    ));
                    continue;
                }
            }
            if let Err(error) = std::fs::rename(&operation.rollback, &operation.desired.target) {
                failures.push(format!(
                    "restore rollback {}: {error}",
                    operation.desired.target.display()
                ));
            }
        } else if operation.target_existed {
            let published_without_rollback = operation
                .staging
                .as_ref()
                .is_some_and(|staging| !staging.exists())
                || (operation.staging.is_none() && !operation.desired.target.exists());
            if published_without_rollback {
                failures.push(format!(
                    "rollback artifact is missing for {}",
                    operation.desired.target.display()
                ));
            }
        } else if !operation.target_existed
            && operation.desired.target.is_file()
            && operation
                .staging
                .as_ref()
                .map_or(true, |staging| !staging.exists())
        {
            if let Err(error) = std::fs::remove_file(&operation.desired.target) {
                failures.push(format!(
                    "remove newly published {}: {error}",
                    operation.desired.target.display()
                ));
            }
        }

        if let Some(staging) = &operation.staging {
            if staging.exists() {
                if let Err(error) = std::fs::remove_file(staging) {
                    failures.push(format!("remove staging {}: {error}", staging.display()));
                }
            }
        }
        if let Err(error) = sync_directory(
            operation
                .desired
                .target
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        ) {
            failures.push(format!(
                "sync rollback directory for {}: {error}",
                operation.desired.target.display()
            ));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(AQBotError::Gateway(failures.join("; ")))
    }
}

fn finalize_committed_restore(pending_dir: &Path, operations: &[TransactionOperation]) {
    let mut failures = Vec::new();
    for operation in operations {
        if operation.rollback.exists() {
            if let Err(error) = std::fs::remove_file(&operation.rollback) {
                failures.push(format!("{}: {error}", operation.rollback.display()));
            }
        }
        if let Some(staging) = &operation.staging {
            if staging.exists() {
                if let Err(error) = std::fs::remove_file(staging) {
                    failures.push(format!("{}: {error}", staging.display()));
                }
            }
        }
    }
    if failures.is_empty() {
        if let Err(error) = std::fs::remove_dir_all(pending_dir) {
            tracing::warn!(
                path = %pending_dir.display(),
                error = %error,
                "pending restore committed but cleanup will be retried"
            );
        }
    } else {
        tracing::warn!(
            errors = %failures.join("; "),
            "pending restore committed but artifact cleanup will be retried"
        );
    }
}

fn validate_journal(
    journal: &ApplyJournal,
    manifest: &PendingRestoreManifest,
    operation_count: usize,
) -> Result<()> {
    if journal.version != JOURNAL_VERSION
        || journal.restore_id != manifest.restore_id
        || journal.target_existed.len() != operation_count
    {
        return Err(AQBotError::Validation(
            "Pending restore apply journal is inconsistent".to_string(),
        ));
    }
    Ok(())
}

fn read_journal(path: &Path) -> Result<ApplyJournal> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        AQBotError::Validation(format!("Pending restore apply journal is invalid: {error}"))
    })
}

fn write_journal(pending_dir: &Path, journal: &ApplyJournal) -> Result<()> {
    let path = pending_dir.join(JOURNAL_FILE_NAME);
    if path.exists() {
        return Err(AQBotError::Validation(
            "Pending restore apply journal already exists".to_string(),
        ));
    }
    let migrating = pending_dir.join(format!("{JOURNAL_FILE_NAME}.migrating"));
    remove_file_if_exists(&migrating)?;
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| {
        AQBotError::Validation(format!("Failed to serialize restore journal: {error}"))
    })?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&migrating)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    std::fs::rename(&migrating, &path)?;
    sync_directory(pending_dir)
}

fn write_marker(path: &Path) -> Result<()> {
    if path.exists() {
        return Err(AQBotError::Validation(
            "Pending restore committed marker already exists".to_string(),
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(COMMITTED_MARKER_NAME);
    let migrating = path.with_file_name(format!("{file_name}.migrating"));
    remove_file_if_exists(&migrating)?;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&migrating)?;
    file.sync_all()?;
    std::fs::rename(&migrating, path)?;
    sync_directory(path.parent().unwrap_or_else(|| Path::new(".")))
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn artifact_path(target: &Path, restore_id: &str, index: usize, suffix: &str) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("restore-target");
    parent.join(format!(
        ".{name}.aqbot-restore-{restore_id}-{index}.{suffix}"
    ))
}
