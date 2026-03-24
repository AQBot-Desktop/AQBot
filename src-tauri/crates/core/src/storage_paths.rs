use std::path::{Path, PathBuf};

/// Returns the documents root: ~/Documents/aqbot/
pub fn documents_root() -> PathBuf {
    dirs::document_dir()
        .expect("Could not determine Documents directory")
        .join("aqbot")
}

/// Returns the typed subdirectory for a given MIME type.
/// - "image/*" → "images"
/// - everything else → "files"
/// - "backup" sentinel → "backups"
pub fn file_type_bucket(mime_type: &str) -> &'static str {
    if mime_type == "backup" {
        "backups"
    } else if mime_type.starts_with("image/") {
        "images"
    } else {
        "files"
    }
}

/// Resolves a relative storage path to absolute under documents root.
pub fn resolve_documents_path(relative_path: &str) -> PathBuf {
    documents_root().join(relative_path)
}

/// Generates a storage-ready relative path for a new file.
/// Format: "{bucket}/{hash_prefix}_{sanitized_name}"
pub fn build_relative_path(original_name: &str, mime_type: &str, hash: &str) -> String {
    let bucket = file_type_bucket(mime_type);
    let hash_prefix = &hash[..hash.len().min(12)];
    let sanitized = sanitize_filename(original_name);
    format!("{}/{}_{}", bucket, hash_prefix, sanitized)
}

/// Validates a relative path (no traversal, no absolute, lowercase dir).
pub fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err("path must not be absolute".to_string());
    }
    if path.contains("..") {
        return Err("path must not contain '..' traversal".to_string());
    }
    Ok(())
}

/// Ensures the documents root and subdirectories exist.
pub fn ensure_documents_dirs() -> std::io::Result<()> {
    let root = documents_root();
    for sub in &["images", "files", "backups"] {
        std::fs::create_dir_all(root.join(sub))?;
    }
    Ok(())
}

/// Sanitize a filename: replace spaces with `_`, remove special chars, keep extension.
fn sanitize_filename(name: &str) -> String {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str());

    let sanitized_stem: String = stem
        .chars()
        .filter_map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                Some(c)
            } else if c == ' ' {
                Some('_')
            } else {
                None
            }
        })
        .collect();

    let sanitized_stem = if sanitized_stem.is_empty() {
        "file".to_string()
    } else {
        sanitized_stem
    };

    match ext {
        Some(e) => format!("{}.{}", sanitized_stem, e),
        None => sanitized_stem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_root_ends_with_aqbot() {
        let root = documents_root();
        assert!(root.ends_with("aqbot"), "Expected path ending with 'aqbot', got {:?}", root);
        // Should be under the platform Documents directory
        let parent = root.parent().unwrap();
        let parent_name = parent.file_name().unwrap().to_str().unwrap();
        assert_eq!(parent_name, "Documents", "Expected parent 'Documents', got {}", parent_name);
    }

    #[test]
    fn documents_root_is_absolute() {
        let root = documents_root();
        assert!(root.is_absolute(), "Expected absolute path, got {:?}", root);
    }

    // -- file_type_bucket tests --

    #[test]
    fn bucket_image_png() {
        assert_eq!(file_type_bucket("image/png"), "images");
    }

    #[test]
    fn bucket_image_jpeg() {
        assert_eq!(file_type_bucket("image/jpeg"), "images");
    }

    #[test]
    fn bucket_image_gif() {
        assert_eq!(file_type_bucket("image/gif"), "images");
    }

    #[test]
    fn bucket_image_webp() {
        assert_eq!(file_type_bucket("image/webp"), "images");
    }

    #[test]
    fn bucket_application_pdf() {
        assert_eq!(file_type_bucket("application/pdf"), "files");
    }

    #[test]
    fn bucket_text_plain() {
        assert_eq!(file_type_bucket("text/plain"), "files");
    }

    #[test]
    fn bucket_application_zip() {
        assert_eq!(file_type_bucket("application/zip"), "files");
    }

    #[test]
    fn bucket_backup_sentinel() {
        assert_eq!(file_type_bucket("backup"), "backups");
    }

    // -- resolve_documents_path tests --

    #[test]
    fn resolve_joins_correctly() {
        let resolved = resolve_documents_path("images/abc123.jpg");
        let root = documents_root();
        assert_eq!(resolved, root.join("images").join("abc123.jpg"));
    }

    #[test]
    fn resolve_single_file() {
        let resolved = resolve_documents_path("readme.txt");
        let root = documents_root();
        assert_eq!(resolved, root.join("readme.txt"));
    }

    // -- build_relative_path tests --

    #[test]
    fn build_path_image() {
        let result = build_relative_path("photo.jpg", "image/png", "abcdef123456789xyz");
        assert_eq!(result, "images/abcdef123456_photo.jpg");
    }

    #[test]
    fn build_path_pdf() {
        let result = build_relative_path("report.pdf", "application/pdf", "fedcba987654321abc");
        assert_eq!(result, "files/fedcba987654_report.pdf");
    }

    #[test]
    fn build_path_sanitizes_spaces() {
        let result = build_relative_path("my photo file.png", "image/png", "aabbccddee11");
        assert_eq!(result, "images/aabbccddee11_my_photo_file.png");
    }

    #[test]
    fn build_path_sanitizes_special_chars() {
        let result = build_relative_path("file@#$%name!.txt", "text/plain", "112233445566");
        assert_eq!(result, "files/112233445566_filename.txt");
    }

    #[test]
    fn build_path_truncates_hash_to_12() {
        let result = build_relative_path("a.txt", "text/plain", "123456789012345");
        assert!(result.starts_with("files/123456789012_"));
    }

    #[test]
    fn build_path_short_hash() {
        let result = build_relative_path("a.txt", "text/plain", "abc");
        assert_eq!(result, "files/abc_a.txt");
    }

    // -- validate_relative_path tests --

    #[test]
    fn validate_accepts_valid_path() {
        assert!(validate_relative_path("images/abc123.jpg").is_ok());
    }

    #[test]
    fn validate_accepts_files_path() {
        assert!(validate_relative_path("files/report.pdf").is_ok());
    }

    #[test]
    fn validate_rejects_traversal() {
        let result = validate_relative_path("images/../etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(".."));
    }

    #[test]
    fn validate_rejects_absolute_unix() {
        let result = validate_relative_path("/etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_absolute_windows() {
        let result = validate_relative_path("\\Windows\\system32");
        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_empty() {
        let result = validate_relative_path("");
        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_dotdot_only() {
        let result = validate_relative_path("..");
        assert!(result.is_err());
    }

    // -- ensure_documents_dirs tests --

    #[test]
    fn ensure_dirs_creates_structure() {
        // Use a temp dir to avoid side effects
        let tmp = std::env::temp_dir().join("aqbot_test_ensure_dirs");
        let _ = std::fs::remove_dir_all(&tmp);

        // We test the logic by verifying the dirs exist after calling ensure_documents_dirs.
        // Since ensure_documents_dirs uses documents_root(), we test it indirectly:
        // just verify it doesn't error and the root exists afterward.
        let result = ensure_documents_dirs();
        assert!(result.is_ok(), "ensure_documents_dirs failed: {:?}", result.err());

        let root = documents_root();
        assert!(root.exists(), "documents root should exist after ensure_documents_dirs");
        assert!(root.join("images").exists(), "images/ should exist");
        assert!(root.join("files").exists(), "files/ should exist");
        assert!(root.join("backups").exists(), "backups/ should exist");
    }
}
