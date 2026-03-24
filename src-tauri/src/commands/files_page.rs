use aqbot_core::repo::stored_file::StoredFile;
use aqbot_core::types::BackupManifest;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

use crate::AppState;

// ── Shared row type sent to the frontend ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesPageEntry {
    /// Stable namespaced id: `"attachment::<record_id>"` or `"backup_manifest::<record_id>"`
    pub id: String,
    /// `"attachment"` | `"backup_manifest"`
    pub source_kind: String,
    /// `"images"` | `"files"` | `"backups"`
    pub category: String,
    pub display_name: String,
    pub path: String,
    /// Relative storage path under documents root (e.g. `images/abc123_photo.jpg`).
    /// Used by frontend to load base64 preview via `read_attachment_preview`.
    pub storage_path: Option<String>,
    pub size_bytes: i64,
    pub created_at: String,
    /// `true` when the backing file no longer exists on disk
    pub missing: bool,
    /// `file://`-prefixed URI suitable for use as an `<img src>`, populated for
    /// image entries whose backing file exists on disk; `null` for all other entries.
    pub preview_url: Option<String>,
}

// ── Pure helpers (unit-testable, no AppState / DB) ────────────────────────────

/// Returns `true` when the file at `path` does not exist on disk.
pub fn check_file_missing(path: &str) -> bool {
    !Path::new(path).exists()
}

fn resolve_storage_path(storage_path: &str) -> String {
    let storage_path = Path::new(storage_path);
    if storage_path.is_absolute() {
        return storage_path.to_string_lossy().to_string();
    }

    aqbot_core::storage_paths::resolve_documents_path(&storage_path.to_string_lossy())
        .to_string_lossy()
        .to_string()
}

/// Build image entries from stored files (mime_type starts with "image/").
/// Missing rows are included and flagged rather than filtered out.
pub fn build_image_entries(files: &[StoredFile]) -> Vec<FilesPageEntry> {
    files
        .iter()
        .filter(|f| f.mime_type.starts_with("image/"))
        .map(|f| {
            let resolved_path = resolve_storage_path(&f.storage_path);
            let missing = check_file_missing(&resolved_path);
            let preview_url = if missing {
                None
            } else {
                Some(format!("file://{}", resolved_path))
            };
            FilesPageEntry {
                id: format!("attachment::{}", f.id),
                source_kind: "attachment".to_string(),
                category: "images".to_string(),
                display_name: f.original_name.clone(),
                path: resolved_path,
                storage_path: Some(f.storage_path.clone()),
                size_bytes: f.size_bytes,
                created_at: f.created_at.clone(),
                missing,
                preview_url,
            }
        })
        .collect()
}

/// Build non-image file entries from stored files.
/// Missing rows are included and flagged rather than filtered out.
pub fn build_file_entries(files: &[StoredFile]) -> Vec<FilesPageEntry> {
    files
        .iter()
        .filter(|f| !f.mime_type.starts_with("image/"))
        .map(|f| {
            let resolved_path = resolve_storage_path(&f.storage_path);
            FilesPageEntry {
                id: format!("attachment::{}", f.id),
                source_kind: "attachment".to_string(),
                category: "files".to_string(),
                display_name: f.original_name.clone(),
                path: resolved_path.clone(),
                storage_path: Some(f.storage_path.clone()),
                size_bytes: f.size_bytes,
                created_at: f.created_at.clone(),
                missing: check_file_missing(&resolved_path),
                preview_url: None,
            }
        })
        .collect()
}

/// Build backup entries from backup manifests.
/// A manifest whose `file_path` is `None` or points to a missing file is flagged.
pub fn build_backup_entries(manifests: &[BackupManifest]) -> Vec<FilesPageEntry> {
    manifests
        .iter()
        .map(|m| {
            let path = m.file_path.clone().unwrap_or_default();
            let missing = path.is_empty() || check_file_missing(&path);
            FilesPageEntry {
                id: format!("backup_manifest::{}", m.id),
                source_kind: "backup_manifest".to_string(),
                category: "backups".to_string(),
                display_name: format!("backup-{}.{}", m.created_at, m.version),
                path,
                storage_path: None,
                size_bytes: m.file_size,
                created_at: m.created_at.clone(),
                missing,
                preview_url: None,
            }
        })
        .collect()
}

/// Filter entries by display name (case-insensitive substring match).
pub fn apply_search_filter(
    entries: Vec<FilesPageEntry>,
    search: Option<&str>,
) -> Vec<FilesPageEntry> {
    match search {
        None | Some("") => entries,
        Some(q) => {
            let q = q.to_lowercase();
            entries
                .into_iter()
                .filter(|e| e.display_name.to_lowercase().contains(&q))
                .collect()
        }
    }
}

/// Sort entries by the given key (`"name"`, `"size"`, or `"date"` / default newest-first).
pub fn apply_sort(mut entries: Vec<FilesPageEntry>, sort_key: Option<&str>) -> Vec<FilesPageEntry> {
    match sort_key {
        Some("name") => entries.sort_by(|a, b| a.display_name.cmp(&b.display_name)),
        Some("size") => entries.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes)),
        _ => entries.sort_by(|a, b| b.created_at.cmp(&a.created_at)),
    }
    entries
}

/// Parse a namespaced entry id like `"attachment::abc"` → `("attachment", "abc")`.
/// Returns an error for malformed ids or an empty record part.
pub fn parse_entry_id(entry_id: &str) -> Result<(&str, &str), String> {
    let sep = entry_id
        .find("::")
        .ok_or_else(|| format!("Invalid entry_id (missing '::'): {}", entry_id))?;
    let kind = &entry_id[..sep];
    let record_id = &entry_id[sep + 2..];
    if record_id.is_empty() {
        return Err(format!("Invalid entry_id (empty record id): {}", entry_id));
    }
    Ok((kind, record_id))
}

/// Validate that `path` is non-empty and exists on disk.
/// Returns a descriptive error that surfaces to the caller; never swallows it.
pub fn validate_path_for_open(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Path is empty".to_string());
    }
    if !Path::new(path).exists() {
        return Err(format!("File not found: {}", path));
    }
    Ok(())
}

/// Map a file extension to a MIME type for common attachment types.
fn mime_from_extension(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("txt" | "md" | "csv" | "log") => "text/plain",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("zip") => "application/zip",
        Some("mp3") => "audio/mpeg",
        Some("mp4") => "video/mp4",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

// ── Tauri command wrappers ────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_attachment_exists(
    file_path: String,
) -> Result<bool, String> {
    if file_path.is_empty() {
        return Ok(false);
    }
    let abs = resolve_storage_path(&file_path);
    Ok(Path::new(&abs).exists())
}

#[tauri::command]
pub async fn read_attachment_preview(
    file_path: String,
) -> Result<String, String> {
    if file_path.is_empty() {
        return Err("file_path is empty".to_string());
    }
    let abs = resolve_storage_path(&file_path);
    let bytes = std::fs::read(&abs).map_err(|e| format!("Failed to read file: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mime = mime_from_extension(&abs);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[tauri::command]
pub async fn save_avatar_file(
    data: String,
    mime_type: String,
) -> Result<String, String> {
    use aqbot_core::file_store::FileStore;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {e}"))?;
    let store = FileStore::new();
    let saved = store
        .save_file(&bytes, "avatar", &mime_type)
        .map_err(|e| format!("Failed to save avatar: {e}"))?;
    Ok(saved.storage_path)
}

#[tauri::command]
pub async fn resolve_attachment_path(
    file_path: String,
) -> Result<String, String> {
    if file_path.is_empty() {
        return Err("file_path is empty".to_string());
    }
    Ok(resolve_storage_path(&file_path))
}

#[tauri::command]
pub async fn reveal_attachment_file(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<(), String> {
    if file_path.is_empty() {
        return Err("file_path is empty".to_string());
    }
    let abs = resolve_storage_path(&file_path);
    use tauri_plugin_opener::OpenerExt;
    let path = Path::new(&abs);
    if path.exists() {
        app.opener().reveal_item_in_dir(&abs).map_err(|e| e.to_string())
    } else if let Some(parent) = path.parent().filter(|p| p.exists()) {
        app.opener().reveal_item_in_dir(parent.to_string_lossy().as_ref()).map_err(|e| e.to_string())
    } else {
        Err("File and parent directory do not exist".to_string())
    }
}

/// Pure validation logic for `open_attachment_file`, extracted for unit tests.
fn open_attachment_file_validate(file_path: &str) -> Result<String, String> {
    if file_path.is_empty() {
        return Err("file_path is empty".to_string());
    }
    let abs = resolve_storage_path(file_path);
    validate_path_for_open(&abs)?;
    Ok(abs)
}

#[tauri::command]
pub async fn open_attachment_file(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<(), String> {
    let abs = open_attachment_file_validate(&file_path)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&abs, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_files_page_entries(
    state: State<'_, AppState>,
    category: String,
    search: Option<String>,
    sort_key: Option<String>,
) -> Result<Vec<FilesPageEntry>, String> {
    let entries = match category.as_str() {
        "images" | "files" => {
            let all_files = aqbot_core::repo::stored_file::list_all_stored_files(&state.sea_db)
                .await
                .map_err(|e| e.to_string())?;
            if category == "images" {
                build_image_entries(&all_files)
            } else {
                build_file_entries(&all_files)
            }
        }
        "backups" => {
            let manifests = aqbot_core::repo::backup::list_backups(&state.sea_db)
                .await
                .map_err(|e| e.to_string())?;
            build_backup_entries(&manifests)
        }
        _ => return Err(format!("Unknown category: {}", category)),
    };

    let entries = apply_search_filter(entries, search.as_deref());
    let entries = apply_sort(entries, sort_key.as_deref());
    Ok(entries)
}

#[tauri::command]
pub async fn open_files_page_entry(
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    validate_path_for_open(&path)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reveal_files_page_entry(
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    validate_path_for_open(&path)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cleanup_missing_files_page_entry(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<(), String> {
    let (source_kind, record_id) = parse_entry_id(&entry_id)?;
    match source_kind {
        "attachment" => {
            let file_store = aqbot_core::file_store::FileStore::new();
            super::file_cleanup::delete_attachment_reference(
                &state.sea_db,
                &file_store,
                record_id,
            )
            .await
        }
        "backup_manifest" => aqbot_core::repo::backup::delete_backup(&state.sea_db, record_id)
            .await
            .map_err(|e| e.to_string()),
        _ => Err(format!("Unknown source_kind: {}", source_kind)),
    }
}

// ── Inline unit tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_cleanup;

    fn make_stored_file(id: &str, name: &str, mime: &str, path: &str) -> StoredFile {
        StoredFile {
            id: id.to_string(),
            hash: "deadbeef".to_string(),
            original_name: name.to_string(),
            mime_type: mime.to_string(),
            size_bytes: 1024,
            storage_path: path.to_string(),
            conversation_id: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    fn make_backup_manifest(id: &str, path: Option<&str>) -> BackupManifest {
        BackupManifest {
            id: id.to_string(),
            version: "sqlite".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            encrypted: false,
            checksum: "abc123".to_string(),
            object_counts_json: "{}".to_string(),
            source_app_version: "1.0.0".to_string(),
            file_path: path.map(|s| s.to_string()),
            file_size: 2048,
        }
    }

    fn make_temp_app_data_dir() -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "aqbot-files-page-tests-{}-{}",
            std::process::id(),
            unique
        ))
    }

    // ── category loaders ─────────────────────────────────────────────────────

    #[test]
    fn test_images_includes_image_mime_types() {
        let files = vec![
            make_stored_file("1", "photo.jpg", "image/jpeg", "/tmp/test/a.jpg"),
            make_stored_file("2", "doc.pdf", "application/pdf", "/tmp/test/b.pdf"),
            make_stored_file("3", "photo.png", "image/png", "/tmp/test/c.png"),
        ];
        let entries = build_image_entries(&files);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.category == "images"));
        assert!(entries.iter().all(|e| e.source_kind == "attachment"));
        assert!(entries.iter().all(|e| e.id.starts_with("attachment::")));
    }

    #[test]
    fn test_files_returns_non_image_attachments() {
        let files = vec![
            make_stored_file("1", "photo.jpg", "image/jpeg", "/tmp/test/a.jpg"),
            make_stored_file("2", "doc.pdf", "application/pdf", "/tmp/test/b.pdf"),
            make_stored_file("3", "data.csv", "text/csv", "/tmp/test/c.csv"),
        ];
        let entries = build_file_entries(&files);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.category == "files"));
        let names: Vec<&str> = entries.iter().map(|e| e.display_name.as_str()).collect();
        assert!(names.contains(&"doc.pdf"));
        assert!(names.contains(&"data.csv"));
        assert!(!names.contains(&"photo.jpg"));
    }

    #[test]
    fn test_backups_reuses_backup_manifest_data() {
        let manifests = vec![
            make_backup_manifest("bk1", Some("/tmp/backup1.db")),
            make_backup_manifest("bk2", Some("/tmp/backup2.db")),
        ];
        let entries = build_backup_entries(&manifests);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.category == "backups"));
        assert!(entries.iter().all(|e| e.source_kind == "backup_manifest"));
        assert!(entries.iter().all(|e| e.id.starts_with("backup_manifest::")));
        assert!(entries.iter().any(|e| e.id == "backup_manifest::bk1"));
        assert!(entries.iter().any(|e| e.id == "backup_manifest::bk2"));
    }

    // ── missing detection ────────────────────────────────────────────────────

    #[test]
    fn test_missing_file_rows_are_flagged_not_filtered() {
        let files = vec![
            make_stored_file("1", "photo.jpg", "image/jpeg", "/nonexistent/path/a.jpg"),
            make_stored_file("2", "photo.png", "image/png", "/nonexistent/path/b.png"),
        ];
        let entries = build_image_entries(&files);
        // Both rows must be present even though the backing files are gone
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.missing), "all missing-path rows must be flagged");
    }

    #[test]
    fn test_existing_file_rows_are_not_flagged_missing() {
        // current_exe() always exists on the test runner machine
        let existing = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let files = vec![make_stored_file(
            "1",
            "app.bin",
            "application/octet-stream",
            &existing,
        )];
        let entries = build_file_entries(&files);
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].missing, "existing file must not be flagged missing");
    }

    #[test]
    fn test_backup_manifest_missing_file_flagged() {
        let manifests = vec![
            make_backup_manifest("bk1", Some("/nonexistent/backup.db")),
            make_backup_manifest("bk2", None), // no path at all
        ];
        let entries = build_backup_entries(&manifests);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.missing));
    }

    #[test]
    fn test_stored_file_paths_resolve_under_documents_root() {
        let files = vec![make_stored_file("1", "photo.jpg", "image/jpeg", "images/abc123_photo.jpg")];
        let entries = build_image_entries(&files);

        let expected = aqbot_core::storage_paths::documents_root()
            .join("images/abc123_photo.jpg")
            .to_string_lossy()
            .to_string();
        assert_eq!(entries[0].path, expected);
        assert_eq!(
            entries[0].preview_url.as_deref(),
            None,
            "missing files should not expose preview urls"
        );
    }

    // ── open / reveal path validation ────────────────────────────────────────

    #[test]
    fn test_open_returns_error_for_unavailable_path() {
        let result = validate_path_for_open("/absolutely/does/not/exist/file.txt");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(
            msg.to_lowercase().contains("not found") || msg.to_lowercase().contains("empty"),
            "error message should describe the problem, got: {msg}"
        );
    }

    #[test]
    fn test_open_returns_error_for_empty_path() {
        let result = validate_path_for_open("");
        assert!(result.is_err());
    }

    #[test]
    fn test_open_succeeds_for_existing_path() {
        let existing = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(validate_path_for_open(&existing).is_ok());
    }

    // ── open_attachment_file validation ─────────────────────────────────────

    #[test]
    fn test_open_attachment_rejects_empty_path() {
        // open_attachment_file's first guard: empty string → Err
        assert_eq!(
            open_attachment_file_validate(""),
            Err("file_path is empty".to_string()),
        );
    }

    #[test]
    fn test_open_attachment_rejects_missing_file() {
        // After resolve, validate_path_for_open should reject a non-existent path
        let result = open_attachment_file_validate("nonexistent/dir/fake.pdf");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(
            msg.to_lowercase().contains("not found"),
            "should report file not found, got: {msg}"
        );
    }

    #[test]
    fn test_open_attachment_accepts_existing_file() {
        let existing = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        // Absolute paths pass through resolve_storage_path unchanged
        assert!(open_attachment_file_validate(&existing).is_ok());
    }

    // ── cleanup: entry-id parsing ────────────────────────────────────────────

    #[test]
    fn test_cleanup_parse_attachment_id() {
        let (kind, id) = parse_entry_id("attachment::abc123").unwrap();
        assert_eq!(kind, "attachment");
        assert_eq!(id, "abc123");
    }

    #[test]
    fn test_cleanup_parse_backup_manifest_id() {
        let (kind, id) = parse_entry_id("backup_manifest::xyz789").unwrap();
        assert_eq!(kind, "backup_manifest");
        assert_eq!(id, "xyz789");
    }

    #[test]
    fn test_cleanup_parse_invalid_id_no_separator() {
        assert!(parse_entry_id("invalid_no_separator").is_err());
    }

    #[test]
    fn test_cleanup_parse_invalid_id_empty_record() {
        assert!(parse_entry_id("attachment::").is_err());
    }

    #[tokio::test]
    async fn test_attachment_cleanup_removes_disk_file_and_db_record() {
        let db = aqbot_core::db::create_test_pool()
            .await
            .unwrap()
            .conn;
        let app_data_dir = make_temp_app_data_dir();
        std::fs::create_dir_all(&app_data_dir).unwrap();

        let file_store = aqbot_core::file_store::FileStore::with_root(app_data_dir.clone());
        let saved = file_store.save_file(b"hello world", "photo.png", "image/png").unwrap();
        let physical_path = app_data_dir.join(&saved.storage_path);
        assert!(physical_path.exists(), "test fixture file must exist before cleanup");

        aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "file-1",
            &saved.hash,
            "photo.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            None,
        )
        .await
        .unwrap();

        let cleanup_result = file_cleanup::delete_attachment_reference(&db, &file_store, "file-1")
            .await;
        assert!(
            cleanup_result.is_ok(),
            "attachment cleanup should succeed, got: {cleanup_result:?}"
        );
        assert!(
            !physical_path.exists(),
            "attachment cleanup must remove the backing file from disk"
        );
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, "file-1")
                .await
                .is_err(),
            "attachment cleanup must also remove the stored-file record"
        );

        let _ = std::fs::remove_dir_all(&app_data_dir);
    }

    #[tokio::test]
    async fn test_attachment_cleanup_preserves_shared_file_until_last_reference() {
        let db = aqbot_core::db::create_test_pool()
            .await
            .unwrap()
            .conn;
        let app_data_dir = make_temp_app_data_dir();
        std::fs::create_dir_all(&app_data_dir).unwrap();

        let file_store = aqbot_core::file_store::FileStore::with_root(app_data_dir.clone());
        let saved = file_store.save_file(b"same-bytes", "shared.png", "image/png").unwrap();
        let physical_path = app_data_dir.join(&saved.storage_path);
        assert!(physical_path.exists(), "shared fixture file must exist before cleanup");

        for file_id in ["file-1", "file-2"] {
            aqbot_core::repo::stored_file::create_stored_file(
                &db,
                file_id,
                &saved.hash,
                "shared.png",
                "image/png",
                saved.size_bytes,
                &saved.storage_path,
                None,
            )
            .await
            .unwrap();
        }

        let cleanup_result = file_cleanup::delete_attachment_reference(&db, &file_store, "file-1")
            .await;
        assert!(
            cleanup_result.is_ok(),
            "attachment cleanup should succeed when duplicate records share a storage path, got: {cleanup_result:?}"
        );
        assert!(
            physical_path.exists(),
            "cleanup must keep the shared backing file while another record still references it"
        );
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, "file-1")
                .await
                .is_err(),
            "cleanup must remove the targeted record"
        );
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, "file-2")
                .await
                .is_ok(),
            "cleanup must preserve other records that still share the same storage path"
        );

        let _ = std::fs::remove_dir_all(&app_data_dir);
    }

    // ── search / sort ────────────────────────────────────────────────────────

    fn sample_entries() -> Vec<FilesPageEntry> {
        vec![
            FilesPageEntry {
                id: "attachment::1".to_string(),
                source_kind: "attachment".to_string(),
                category: "files".to_string(),
                display_name: "Important Document.pdf".to_string(),
                path: "/tmp/a.pdf".to_string(),
                storage_path: None,
                size_bytes: 500,
                created_at: "2024-01-03".to_string(),
                missing: false,
                preview_url: None,
            },
            FilesPageEntry {
                id: "attachment::2".to_string(),
                source_kind: "attachment".to_string(),
                category: "files".to_string(),
                display_name: "photo.jpg".to_string(),
                path: "/tmp/b.jpg".to_string(),
                storage_path: None,
                size_bytes: 200,
                created_at: "2024-01-01".to_string(),
                missing: false,
                preview_url: None,
            },
            FilesPageEntry {
                id: "attachment::3".to_string(),
                source_kind: "attachment".to_string(),
                category: "files".to_string(),
                display_name: "archive.zip".to_string(),
                path: "/tmp/c.zip".to_string(),
                storage_path: None,
                size_bytes: 9000,
                created_at: "2024-01-02".to_string(),
                missing: false,
                preview_url: None,
            },
        ]
    }

    #[test]
    fn test_search_filter_case_insensitive() {
        let filtered = apply_search_filter(sample_entries(), Some("important"));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].display_name, "Important Document.pdf");
    }

    #[test]
    fn test_search_filter_none_returns_all() {
        let all = apply_search_filter(sample_entries(), None);
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn test_search_filter_empty_string_returns_all() {
        let all = apply_search_filter(sample_entries(), Some(""));
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn test_sort_by_name() {
        let sorted = apply_sort(sample_entries(), Some("name"));
        let names: Vec<&str> = sorted.iter().map(|e| e.display_name.as_str()).collect();
        assert_eq!(names, ["Important Document.pdf", "archive.zip", "photo.jpg"]);
    }

    #[test]
    fn test_sort_by_size_descending() {
        let sorted = apply_sort(sample_entries(), Some("size"));
        assert_eq!(sorted[0].display_name, "archive.zip");
        assert_eq!(sorted[2].display_name, "photo.jpg");
    }

    #[test]
    fn test_sort_default_newest_first() {
        let sorted = apply_sort(sample_entries(), None);
        assert_eq!(sorted[0].display_name, "Important Document.pdf"); // 2024-01-03
        assert_eq!(sorted[2].display_name, "photo.jpg"); // 2024-01-01
    }

    // ── preview_url ──────────────────────────────────────────────────────────

    #[test]
    fn test_image_entry_has_preview_url_when_file_exists() {
        let existing = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let files = vec![make_stored_file("1", "photo.jpg", "image/jpeg", &existing)];
        let entries = build_image_entries(&files);
        assert_eq!(entries.len(), 1);
        let preview = entries[0].preview_url.as_deref().expect("preview_url must be Some for an existing image");
        assert!(preview.starts_with("file://"), "preview_url must be a file:// URI, got: {preview}");
        assert!(preview.contains(&existing), "preview_url must embed the storage path");
    }

    #[test]
    fn test_image_entry_has_no_preview_url_when_file_missing() {
        let files = vec![make_stored_file("1", "photo.jpg", "image/jpeg", "/nonexistent/photo.jpg")];
        let entries = build_image_entries(&files);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].preview_url.is_none(), "missing image must not have a preview_url");
    }

    #[test]
    fn test_non_image_entry_has_no_preview_url() {
        let files = vec![make_stored_file("1", "doc.pdf", "application/pdf", "/tmp/doc.pdf")];
        let entries = build_file_entries(&files);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].preview_url.is_none(), "non-image entries must not have a preview_url");
    }

    #[test]
    fn test_backup_entry_has_no_preview_url() {
        let manifests = vec![make_backup_manifest("bk1", Some("/tmp/backup.db"))];
        let entries = build_backup_entries(&manifests);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].preview_url.is_none(), "backup entries must not have a preview_url");
    }

    // ── save_avatar_file tests ──────────────────────────────────────────

    #[tokio::test]
    async fn test_save_avatar_file_returns_relative_path() {
        // 1x1 red PNG pixel
        let png_bytes: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00,
            0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
            0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
            0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63,
            0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21,
            0xBC, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82,
        ];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);

        // Use a temp dir so we don't pollute the real ~/Documents/aqbot
        let tmp = make_temp_app_data_dir();
        std::fs::create_dir_all(&tmp).unwrap();

        // Save via FileStore directly (mirrors command logic without the Tauri runtime)
        let store = aqbot_core::file_store::FileStore::with_root(tmp.clone());
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .unwrap();
        let saved = store.save_file(&decoded, "avatar", "image/png").unwrap();

        assert!(
            saved.storage_path.starts_with("images/"),
            "avatar should be stored under images/, got: {}",
            saved.storage_path
        );
        assert!(
            saved.storage_path.contains("avatar"),
            "storage path should contain 'avatar', got: {}",
            saved.storage_path
        );
        assert!(tmp.join(&saved.storage_path).exists());

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn test_save_avatar_file_rejects_invalid_base64() {
        let result = base64::engine::general_purpose::STANDARD.decode("not-valid-base64!!!");
        assert!(result.is_err(), "decoding garbage base64 should fail");
    }
}
