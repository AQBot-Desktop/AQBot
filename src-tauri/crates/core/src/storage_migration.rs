//! One-time migration: move files from legacy ~/.aqbot/files/ to ~/Documents/aqbot/

use std::collections::HashMap;
use std::path::Path;

use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set};

use crate::entity::{messages, stored_files};
use crate::storage_paths::{build_relative_path, documents_root};

/// Summary of what the migration did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    pub files_moved: usize,
    pub files_skipped: usize,
    pub files_missing: usize,
    pub db_records_updated: usize,
    pub messages_updated: usize,
}

/// Migrates files from legacy ~/.aqbot/files/ to ~/Documents/aqbot/{images,files}/
/// Updates stored_files.storage_path and messages.attachments JSON in the database.
/// Idempotent: safe to run multiple times.
pub async fn migrate_to_documents_root(
    db: &DatabaseConnection,
    legacy_files_dir: &Path,
) -> Result<MigrationReport, String> {
    let target = documents_root();
    run_migration(db, legacy_files_dir, &target).await
}

/// Internal entry point with an explicit target root, for testability.
async fn run_migration(
    db: &DatabaseConnection,
    legacy_dir: &Path,
    target_root: &Path,
) -> Result<MigrationReport, String> {
    // 1. Ensure target directories
    for sub in &["images", "files"] {
        std::fs::create_dir_all(target_root.join(sub))
            .map_err(|e| format!("create target dir: {e}"))?;
    }

    let mut report = MigrationReport::default();
    let mut path_map: HashMap<String, String> = HashMap::new();

    // 2. Query all stored_files
    let rows = stored_files::Entity::find()
        .all(db)
        .await
        .map_err(|e| format!("query stored_files: {e}"))?;

    // 3. Process each stored file
    for row in rows {
        // a. Already in new format — skip
        if row.storage_path.starts_with("images/") || row.storage_path.starts_with("files/") {
            report.files_skipped += 1;
            continue;
        }

        // b. Old absolute path
        let old_abs = legacy_dir.join(&row.storage_path);

        // c. New relative path
        let new_rel = build_relative_path(&row.original_name, &row.mime_type, &row.hash);

        // d. New absolute path
        let new_abs = target_root.join(&new_rel);

        // Remember mapping for message-attachment update
        path_map.insert(row.storage_path.clone(), new_rel.clone());

        // e. Copy if source exists, f. warn if missing
        if old_abs.exists() {
            if let Some(p) = new_abs.parent() {
                std::fs::create_dir_all(p).map_err(|e| format!("mkdir: {e}"))?;
            }
            std::fs::copy(&old_abs, &new_abs)
                .map_err(|e| format!("copy {}: {e}", old_abs.display()))?;
            report.files_moved += 1;
        } else {
            tracing::warn!(path = %old_abs.display(), "source file missing during migration");
            report.files_missing += 1;
        }

        // Update DB record (even when source is missing, for consistency)
        let mut am: stored_files::ActiveModel = row.into();
        am.storage_path = Set(new_rel);
        am.update(db)
            .await
            .map_err(|e| format!("update stored_files: {e}"))?;
        report.db_records_updated += 1;
    }

    // 4. Update message attachment paths
    let msgs = messages::Entity::find()
        .filter(messages::Column::Attachments.ne("[]"))
        .filter(messages::Column::Attachments.ne(""))
        .all(db)
        .await
        .map_err(|e| format!("query messages: {e}"))?;

    for msg in msgs {
        let Ok(mut atts) = serde_json::from_str::<Vec<serde_json::Value>>(&msg.attachments)
        else {
            continue;
        };

        let mut changed = false;
        for att in &mut atts {
            let Some(fp) = att.get("file_path").and_then(|v| v.as_str()).map(String::from) else {
                continue;
            };
            if fp.starts_with("images/") || fp.starts_with("files/") {
                continue;
            }

            let new_fp = if let Some(p) = path_map.get(&fp) {
                p.clone()
            } else {
                // Fallback: compute from attachment metadata
                let name = att
                    .get("file_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("file");
                let mime = att
                    .get("file_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("application/octet-stream");
                let hash = std::path::Path::new(&fp)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown");
                build_relative_path(name, mime, hash)
            };

            att["file_path"] = serde_json::Value::String(new_fp);
            changed = true;
        }

        if changed {
            let json =
                serde_json::to_string(&atts).map_err(|e| format!("serialize attachments: {e}"))?;
            let mut am: messages::ActiveModel = msg.into();
            am.attachments = Set(json);
            am.update(db)
                .await
                .map_err(|e| format!("update message: {e}"))?;
            report.messages_updated += 1;
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use std::fs;

    const CREATE_STORED_FILES: &str = "
        CREATE TABLE stored_files (
            id TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            original_name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            storage_path TEXT NOT NULL,
            conversation_id TEXT,
            created_at TEXT NOT NULL
        )";

    const CREATE_MESSAGES: &str = "
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            provider_id TEXT,
            model_id TEXT,
            token_count INTEGER,
            attachments TEXT NOT NULL DEFAULT '[]',
            thinking TEXT,
            created_at INTEGER NOT NULL DEFAULT 0,
            branch_id TEXT,
            parent_message_id TEXT,
            version_index INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            tool_calls_json TEXT,
            tool_call_id TEXT
        )";

    async fn test_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        for ddl in [CREATE_STORED_FILES, CREATE_MESSAGES] {
            db.execute(Statement::from_string(DbBackend::Sqlite, ddl))
                .await
                .unwrap();
        }
        db
    }

    struct TestDirs {
        _root: tempfile::TempDir,
        legacy: std::path::PathBuf,
        target: std::path::PathBuf,
    }

    fn test_dirs() -> TestDirs {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("legacy");
        let target = root.path().join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        TestDirs {
            _root: root,
            legacy,
            target,
        }
    }

    async fn insert_stored_file(
        db: &DatabaseConnection,
        id: &str,
        hash: &str,
        name: &str,
        mime: &str,
        path: &str,
        conv: Option<&str>,
    ) {
        let am = stored_files::ActiveModel {
            id: Set(id.into()),
            hash: Set(hash.into()),
            original_name: Set(name.into()),
            mime_type: Set(mime.into()),
            size_bytes: Set(100),
            storage_path: Set(path.into()),
            conversation_id: Set(conv.map(String::from)),
            created_at: Set("2024-01-01".into()),
        };
        am.insert(db).await.unwrap();
    }

    async fn insert_message(db: &DatabaseConnection, id: &str, conv: &str, attachments: &str) {
        let am = messages::ActiveModel {
            id: Set(id.into()),
            conversation_id: Set(conv.into()),
            role: Set("user".into()),
            content: Set("hi".into()),
            provider_id: Set(None),
            model_id: Set(None),
            token_count: Set(None),
            attachments: Set(attachments.into()),
            thinking: Set(None),
            created_at: Set(0),
            branch_id: Set(None),
            parent_message_id: Set(None),
            version_index: Set(0),
            is_active: Set(1),
            tool_calls_json: Set(None),
            tool_call_id: Set(None),
        };
        am.insert(db).await.unwrap();
    }

    #[tokio::test]
    async fn empty_db_is_noop() {
        let db = test_db().await;
        let dirs = test_dirs();
        let r = run_migration(&db, &dirs.legacy, &dirs.target).await.unwrap();
        assert_eq!(r, MigrationReport::default());
    }

    #[tokio::test]
    async fn already_migrated_paths_are_skipped() {
        let db = test_db().await;
        let dirs = test_dirs();
        insert_stored_file(&db, "f1", "aaa", "pic.png", "image/png", "images/aaa_pic.png", None)
            .await;
        insert_stored_file(
            &db,
            "f2",
            "bbb",
            "doc.pdf",
            "application/pdf",
            "files/bbb_doc.pdf",
            None,
        )
        .await;

        let r = run_migration(&db, &dirs.legacy, &dirs.target).await.unwrap();
        assert_eq!(r.files_skipped, 2);
        assert_eq!(r.files_moved, 0);
        assert_eq!(r.db_records_updated, 0);
    }

    #[tokio::test]
    async fn migrates_image_file() {
        let db = test_db().await;
        let dirs = test_dirs();

        let old_dir = dirs.legacy.join("conv1");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("abcdef123456789.png"), b"PNG_DATA").unwrap();

        insert_stored_file(
            &db,
            "f1",
            "abcdef123456789",
            "photo.png",
            "image/png",
            "conv1/abcdef123456789.png",
            Some("conv1"),
        )
        .await;

        let r = run_migration(&db, &dirs.legacy, &dirs.target).await.unwrap();
        assert_eq!(r.files_moved, 1);
        assert_eq!(r.db_records_updated, 1);

        // File copied to new location
        let expected = dirs.target.join("images/abcdef123456_photo.png");
        assert!(expected.exists(), "target file should exist");
        assert_eq!(fs::read(&expected).unwrap(), b"PNG_DATA");

        // Legacy file still exists (non-destructive)
        assert!(old_dir.join("abcdef123456789.png").exists());

        // DB updated
        let f = stored_files::Entity::find_by_id("f1")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(f.storage_path, "images/abcdef123456_photo.png");
    }

    #[tokio::test]
    async fn migrates_non_image_file() {
        let db = test_db().await;
        let dirs = test_dirs();

        let old_dir = dirs.legacy.join("conv1");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("fedcba654321abc.pdf"), b"PDF").unwrap();

        insert_stored_file(
            &db,
            "f1",
            "fedcba654321abc",
            "report.pdf",
            "application/pdf",
            "conv1/fedcba654321abc.pdf",
            Some("conv1"),
        )
        .await;

        let r = run_migration(&db, &dirs.legacy, &dirs.target).await.unwrap();
        assert_eq!(r.files_moved, 1);

        let expected = dirs.target.join("files/fedcba654321_report.pdf");
        assert!(expected.exists());

        let f = stored_files::Entity::find_by_id("f1")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(f.storage_path, "files/fedcba654321_report.pdf");
    }

    #[tokio::test]
    async fn missing_source_still_updates_db() {
        let db = test_db().await;
        let dirs = test_dirs();

        // No file on disk — only a DB record
        insert_stored_file(
            &db,
            "f1",
            "abcdef123456789",
            "photo.png",
            "image/png",
            "conv1/abcdef123456789.png",
            Some("conv1"),
        )
        .await;

        let r = run_migration(&db, &dirs.legacy, &dirs.target).await.unwrap();
        assert_eq!(r.files_missing, 1);
        assert_eq!(r.files_moved, 0);
        assert_eq!(r.db_records_updated, 1);

        let f = stored_files::Entity::find_by_id("f1")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(f.storage_path, "images/abcdef123456_photo.png");
    }

    #[tokio::test]
    async fn idempotent_second_run_skips() {
        let db = test_db().await;
        let dirs = test_dirs();

        let old_dir = dirs.legacy.join("conv1");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("abcdef123456789.png"), b"IMG").unwrap();

        insert_stored_file(
            &db,
            "f1",
            "abcdef123456789",
            "photo.png",
            "image/png",
            "conv1/abcdef123456789.png",
            Some("conv1"),
        )
        .await;

        let r1 = run_migration(&db, &dirs.legacy, &dirs.target).await.unwrap();
        assert_eq!(r1.files_moved, 1);
        assert_eq!(r1.db_records_updated, 1);

        let r2 = run_migration(&db, &dirs.legacy, &dirs.target).await.unwrap();
        assert_eq!(r2.files_skipped, 1);
        assert_eq!(r2.files_moved, 0);
        assert_eq!(r2.db_records_updated, 0);
    }

    #[tokio::test]
    async fn updates_message_attachments() {
        let db = test_db().await;
        let dirs = test_dirs();

        let old_dir = dirs.legacy.join("conv1");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("abcdef123456789.png"), b"IMG").unwrap();

        insert_stored_file(
            &db,
            "f1",
            "abcdef123456789",
            "photo.png",
            "image/png",
            "conv1/abcdef123456789.png",
            Some("conv1"),
        )
        .await;

        let att_json = r#"[{"id":"a1","file_type":"image/png","file_name":"photo.png","file_path":"conv1/abcdef123456789.png","file_size":100}]"#;
        insert_message(&db, "m1", "conv1", att_json).await;

        let r = run_migration(&db, &dirs.legacy, &dirs.target).await.unwrap();
        assert_eq!(r.messages_updated, 1);

        let m = messages::Entity::find_by_id("m1")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        let atts: Vec<serde_json::Value> = serde_json::from_str(&m.attachments).unwrap();
        assert_eq!(
            atts[0]["file_path"].as_str().unwrap(),
            "images/abcdef123456_photo.png"
        );
    }
}
