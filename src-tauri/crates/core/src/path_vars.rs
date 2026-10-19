//! Path encoding/decoding for cross-device portability.
//!
//! Replaces absolute path prefixes with variables (`{{AQBOT_HOME}}`, `{{DOCUMENTS}}`,
//! `{{HOME}}`) when writing to the database, and resolves them back to platform-specific
//! absolute paths when reading.  This allows backups and WebDAV syncs to be restored on
//! a different machine without hard-coded user paths breaking.

const VAR_AQBOT_HOME: &str = "{{AQBOT_HOME}}";
const VAR_DOCUMENTS: &str = "{{DOCUMENTS}}";
const VAR_HOME: &str = "{{HOME}}";

/// Encode an absolute path by replacing known prefixes with variables.
/// More-specific prefixes (AQBOT_HOME, DOCUMENTS) are tried before HOME.
pub fn encode_path(absolute_path: &str) -> String {
    if absolute_path.is_empty() {
        return absolute_path.to_string();
    }

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return absolute_path.to_string(),
    };
    let aqbot_home = home.join(".aqbot");
    let documents_root = crate::storage_paths::documents_root();

    // Try the most specific prefix first so that e.g. ~/.aqbot/… is not
    // encoded as {{HOME}}/.aqbot/… when {{AQBOT_HOME}}/… is more precise.
    if let Some(encoded) = try_encode(absolute_path, &aqbot_home.to_string_lossy(), VAR_AQBOT_HOME)
    {
        return encoded;
    }
    if let Some(encoded) = try_encode(
        absolute_path,
        &documents_root.to_string_lossy(),
        VAR_DOCUMENTS,
    ) {
        return encoded;
    }
    if let Some(encoded) = try_encode(absolute_path, &home.to_string_lossy(), VAR_HOME) {
        return encoded;
    }

    absolute_path.to_string()
}

/// Decode a path by replacing variables with the current system's actual paths.
pub fn decode_path(encoded_path: &str) -> String {
    if encoded_path.is_empty() {
        return encoded_path.to_string();
    }

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return encoded_path.to_string(),
    };
    let aqbot_home = home.join(".aqbot");
    let documents_root = crate::storage_paths::documents_root();

    if let Some(rest) = encoded_path.strip_prefix(VAR_AQBOT_HOME) {
        return format!("{}{}", aqbot_home.to_string_lossy(), platform_sep(rest));
    }
    if let Some(rest) = encoded_path.strip_prefix(VAR_DOCUMENTS) {
        return format!("{}{}", documents_root.to_string_lossy(), platform_sep(rest));
    }
    if let Some(rest) = encoded_path.strip_prefix(VAR_HOME) {
        return format!("{}{}", home.to_string_lossy(), platform_sep(rest));
    }

    encoded_path.to_string()
}

/// Encode an `Option<String>` path.
pub fn encode_path_opt(path: &Option<String>) -> Option<String> {
    path.as_ref().map(|p| encode_path(p))
}

/// Decode an `Option<String>` path.
pub fn decode_path_opt(path: &Option<String>) -> Option<String> {
    path.as_ref().map(|p| decode_path(p))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Try to replace `prefix` at the start of `path` with `variable`.
fn try_encode(path: &str, prefix: &str, variable: &str) -> Option<String> {
    let np = normalize_sep_fwd(path);
    let npfx = normalize_sep_fwd(prefix).trim_end_matches('/').to_string();

    if np == npfx {
        return Some(variable.to_string());
    }
    if np.starts_with(&npfx) {
        let rest = &np[npfx.len()..];
        if rest.starts_with('/') {
            return Some(format!("{}{}", variable, rest));
        }
    }
    None
}

/// Normalize all path separators to forward slashes (for comparison / storage).
fn normalize_sep_fwd(s: &str) -> String {
    s.replace('\\', "/")
}

/// Convert separators in `s` to the current platform's native separator.
#[cfg(windows)]
fn platform_sep(s: &str) -> String {
    s.replace('/', "\\")
}

#[cfg(not(windows))]
fn platform_sep(s: &str) -> String {
    s.replace('\\', "/")
}

// ---------------------------------------------------------------------------
// Database migration for hardcoded paths
// ---------------------------------------------------------------------------

/// Settings keys that store filesystem paths.
const PATH_SETTING_KEYS: &[&str] = &[
    "backup_dir",
    "gateway_ssl_cert_path",
    "gateway_ssl_key_path",
    "agent_workspace_root",
];

/// Migrate hardcoded absolute paths in settings to use dynamic variables.
/// Called once at startup.  Only touches values that look like absolute paths
/// and do NOT already contain a `{{…}}` variable.
pub async fn migrate_hardcoded_paths(db: &sea_orm::DatabaseConnection) {
    for &key in PATH_SETTING_KEYS {
        match crate::repo::settings::get_setting(db, key).await {
            Ok(Some(value)) if !value.is_empty() && !value.contains("{{") => {
                let encoded = encode_path(&value);
                if encoded != value {
                    if let Err(e) = crate::repo::settings::set_setting(db, key, &encoded).await {
                        tracing::warn!("path_vars: failed to migrate setting '{}': {}", key, e);
                    } else {
                        tracing::info!("path_vars: migrated '{}': {} → {}", key, value, encoded);
                    }
                }
            }
            _ => {}
        }
    }

    // Also migrate backup_manifests.file_path entries
    migrate_backup_manifest_paths(db).await;
}

/// Migrate hardcoded file_path values in backup_manifests table.
async fn migrate_backup_manifest_paths(db: &sea_orm::DatabaseConnection) {
    use crate::entity::backup_manifests;
    use sea_orm::*;

    let manifests = match backup_manifests::Entity::find().all(db).await {
        Ok(m) => m,
        Err(_) => return,
    };

    for m in manifests {
        if let Some(ref fp) = m.file_path {
            if !fp.is_empty() && !fp.contains("{{") {
                let encoded = encode_path(fp);
                if encoded != *fp {
                    let mut am: backup_manifests::ActiveModel = m.into();
                    am.file_path = Set(Some(encoded));
                    if let Err(e) = am.update(db).await {
                        tracing::warn!("path_vars: failed to migrate backup manifest path: {}", e);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_aqbot_home() {
        let home = dirs::home_dir().unwrap();
        let original = home
            .join(".aqbot")
            .join("ssl")
            .join("cert.pem")
            .to_string_lossy()
            .to_string();
        let encoded = encode_path(&original);
        assert!(
            encoded.starts_with(VAR_AQBOT_HOME),
            "expected AQBOT_HOME prefix, got: {}",
            encoded
        );
        assert_eq!(decode_path(&encoded), original);
    }

    #[test]
    fn roundtrip_documents() {
        let docs = dirs::document_dir().unwrap().join("aqbot");
        let original = docs
            .join("images")
            .join("photo.jpg")
            .to_string_lossy()
            .to_string();
        let encoded = encode_path(&original);
        assert!(
            encoded.starts_with(VAR_DOCUMENTS),
            "expected DOCUMENTS prefix, got: {}",
            encoded
        );
        assert_eq!(decode_path(&encoded), original);
    }

    #[test]
    fn roundtrip_home() {
        let home = dirs::home_dir().unwrap();
        let original = home
            .join("some")
            .join("random")
            .join("file.txt")
            .to_string_lossy()
            .to_string();
        let encoded = encode_path(&original);
        assert!(
            encoded.starts_with(VAR_HOME),
            "expected HOME prefix, got: {}",
            encoded
        );
        assert_eq!(decode_path(&encoded), original);
    }

    #[test]
    fn aqbot_home_takes_priority_over_home() {
        let home = dirs::home_dir().unwrap();
        let original = home
            .join(".aqbot")
            .join("backups")
            .to_string_lossy()
            .to_string();
        let encoded = encode_path(&original);
        assert!(
            encoded.starts_with(VAR_AQBOT_HOME),
            "AQBOT_HOME should take priority over HOME, got: {}",
            encoded
        );
    }

    #[test]
    fn unrelated_path_unchanged() {
        let path = "/opt/data/file.txt";
        assert_eq!(encode_path(path), path);
        assert_eq!(decode_path(path), path);
    }

    #[test]
    fn empty_path_unchanged() {
        assert_eq!(encode_path(""), "");
        assert_eq!(decode_path(""), "");
    }

    #[test]
    fn option_helpers_none() {
        assert_eq!(encode_path_opt(&None), None);
        assert_eq!(decode_path_opt(&None), None);
    }

    #[test]
    fn option_helpers_some() {
        let home = dirs::home_dir().unwrap();
        let path = home
            .join(".aqbot")
            .join("backups")
            .to_string_lossy()
            .to_string();
        let encoded = encode_path_opt(&Some(path.clone()));
        assert!(encoded.as_ref().unwrap().starts_with(VAR_AQBOT_HOME));
        let decoded = decode_path_opt(&encoded);
        assert_eq!(decoded, Some(path));
    }

    #[test]
    fn exact_prefix_without_trailing_component() {
        let home = dirs::home_dir().unwrap();
        let exact = home.join(".aqbot").to_string_lossy().to_string();
        let encoded = encode_path(&exact);
        assert_eq!(encoded, VAR_AQBOT_HOME);
        assert_eq!(decode_path(&encoded), exact);
    }

    #[test]
    fn already_encoded_path_is_decoded() {
        let decoded = decode_path("{{AQBOT_HOME}}/ssl/cert.pem");
        let home = dirs::home_dir().unwrap();
        let expected = home
            .join(".aqbot")
            .join("ssl")
            .join("cert.pem")
            .to_string_lossy()
            .to_string();
        assert_eq!(decoded, expected);
    }

    #[test]
    fn path_without_variable_left_unchanged_by_decode() {
        let home = dirs::home_dir().unwrap();
        let abs = home
            .join(".aqbot")
            .join("foo")
            .to_string_lossy()
            .to_string();
        assert_eq!(decode_path(&abs), abs);
    }
}
