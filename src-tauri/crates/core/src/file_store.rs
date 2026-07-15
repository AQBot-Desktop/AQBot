use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::Result;

pub struct FileStore {
    base_dir: PathBuf,
}

pub struct SavedFile {
    pub hash: String,
    /// Relative path from the documents root (e.g. "images/abc123_photo.jpg")
    pub storage_path: String,
    pub size_bytes: i64,
    /// True only when this call created the physical file.
    pub created: bool,
}

impl FileStore {
    /// Creates a FileStore rooted at `~/Documents/aqbot/`.
    pub fn new() -> Self {
        Self {
            base_dir: crate::storage_paths::documents_root(),
        }
    }

    /// Creates a FileStore with an explicit root directory (useful for testing).
    pub fn with_root(root: PathBuf) -> Self {
        Self { base_dir: root }
    }

    /// Save file bytes to disk. Returns hash and relative storage path.
    /// Files are stored under `{base_dir}/{bucket}/{hash_prefix}_{sanitized_name}`
    /// where bucket is determined by MIME type ("images" or "files").
    pub fn save_file(
        &self,
        data: &[u8],
        original_name: &str,
        mime_type: &str,
    ) -> Result<SavedFile> {
        let hash = Self::hash_bytes(data);
        let relative_path =
            crate::storage_paths::build_relative_path(original_name, mime_type, &hash);
        let abs_path = self.base_dir.join(&relative_path);

        if let Some(parent) = abs_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let created = if abs_path.exists() {
            let existing = std::fs::read(&abs_path)?;
            if Self::hash_bytes(&existing) != hash {
                return Err(crate::error::AQBotError::Validation(format!(
                    "Stored file hash mismatch at {}",
                    relative_path
                )));
            }
            false
        } else {
            let file_name = abs_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file");
            let staging_path = abs_path.with_file_name(format!(
                ".{}.{}.migrating",
                file_name,
                crate::utils::gen_id()
            ));
            let write_result = (|| -> std::io::Result<()> {
                let mut staging = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&staging_path)?;
                staging.write_all(data)?;
                staging.sync_all()?;
                std::fs::rename(&staging_path, &abs_path)
            })();
            match write_result {
                Ok(()) => true,
                Err(error) => {
                    let _ = std::fs::remove_file(&staging_path);
                    if !abs_path.exists() {
                        return Err(error.into());
                    }
                    let existing = std::fs::read(&abs_path)?;
                    if Self::hash_bytes(&existing) != hash {
                        return Err(crate::error::AQBotError::Validation(format!(
                            "Stored file hash mismatch at {}",
                            relative_path
                        )));
                    }
                    false
                }
            }
        };

        Ok(SavedFile {
            hash,
            storage_path: relative_path,
            size_bytes: data.len() as i64,
            created,
        })
    }

    /// Streams a file into storage without first collecting it in memory.
    /// The temporary file keeps the `.migrating` suffix until the content hash
    /// and final relative path are known.
    pub fn save_reader<R: Read>(
        &self,
        mut reader: R,
        original_name: &str,
        mime_type: &str,
    ) -> Result<SavedFile> {
        let bucket = crate::storage_paths::file_type_bucket(mime_type);
        let bucket_dir = self.base_dir.join(bucket);
        std::fs::create_dir_all(&bucket_dir)?;
        let staging_path = bucket_dir.join(format!(
            ".stream-{}.migrating",
            crate::utils::gen_id()
        ));

        let operation = (|| -> Result<SavedFile> {
            let mut staging = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging_path)?;
            let mut hasher = Sha256::new();
            let mut size_bytes = 0_i64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                staging.write_all(&buffer[..read])?;
                hasher.update(&buffer[..read]);
                size_bytes = size_bytes.checked_add(read as i64).ok_or_else(|| {
                    crate::error::AQBotError::Validation("Stored file is too large".to_string())
                })?;
            }
            staging.sync_all()?;
            drop(staging);

            let hash = format!("{:x}", hasher.finalize());
            let relative_path =
                crate::storage_paths::build_relative_path(original_name, mime_type, &hash);
            let final_path = self.base_dir.join(&relative_path);
            let created = if final_path.exists() {
                if Self::hash_reader(std::fs::File::open(&final_path)?)? != hash {
                    return Err(crate::error::AQBotError::Validation(format!(
                        "Stored file hash mismatch at {relative_path}"
                    )));
                }
                std::fs::remove_file(&staging_path)?;
                false
            } else {
                std::fs::rename(&staging_path, &final_path)?;
                true
            };

            Ok(SavedFile {
                hash,
                storage_path: relative_path,
                size_bytes,
                created,
            })
        })();

        if operation.is_err() {
            let _ = std::fs::remove_file(&staging_path);
        }
        operation
    }

    /// Read file bytes from a relative storage path.
    pub fn read_file(&self, storage_path: &str) -> Result<Vec<u8>> {
        let path = self.validated_path(storage_path)?;
        if !path.exists() {
            return Err(crate::error::AQBotError::NotFound(format!(
                "File not found: {}",
                storage_path
            )));
        }
        Ok(std::fs::read(&path)?)
    }

    /// Delete a file from storage.
    pub fn delete_file(&self, storage_path: &str) -> Result<()> {
        let path = self.validated_path(storage_path)?;
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    pub fn resolve_path(&self, storage_path: &str) -> PathBuf {
        self.base_dir.join(storage_path)
    }

    pub fn validated_path(&self, storage_path: &str) -> Result<PathBuf> {
        let relative = Path::new(storage_path);
        if relative.is_absolute() {
            return Err(crate::error::AQBotError::Validation(
                "Stored file path must be relative".to_string(),
            ));
        }
        let components = relative.components().collect::<Vec<_>>();
        let valid_bucket = matches!(
            components.first(),
            Some(Component::Normal(bucket)) if *bucket == "images" || *bucket == "files"
        );
        if !valid_bucket
            || components.len() != 2
            || components
                .iter()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(crate::error::AQBotError::Validation(
                "Stored file path must be a direct child of images/ or files/".to_string(),
            ));
        }

        let path = self.base_dir.join(relative);
        if path.exists() {
            let canonical_root = std::fs::canonicalize(&self.base_dir)?;
            let canonical_path = std::fs::canonicalize(&path)?;
            if !canonical_path.starts_with(&canonical_root) {
                return Err(crate::error::AQBotError::Validation(
                    "Stored file path escapes the documents root".to_string(),
                ));
            }
        }
        Ok(path)
    }

    pub fn hash_bytes(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    fn hash_reader<R: Read>(mut reader: R) -> Result<String> {
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_and_delete_reject_paths_outside_storage_buckets() {
        let root = tempfile::tempdir().unwrap();
        let store = FileStore::with_root(root.path().to_path_buf());

        assert!(store.read_file("../secret.txt").is_err());
        assert!(store.delete_file("/tmp/secret.txt").is_err());
        assert!(store.read_file("images/nested/secret.png").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn read_and_delete_reject_symlink_escaping_documents_root() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::create_dir_all(root.path().join("images")).unwrap();
        symlink(outside.path(), root.path().join("images/escape.png")).unwrap();
        let store = FileStore::with_root(root.path().to_path_buf());

        assert!(store.read_file("images/escape.png").is_err());
        assert!(store.delete_file("images/escape.png").is_err());
        assert!(outside.path().exists());
    }
}
