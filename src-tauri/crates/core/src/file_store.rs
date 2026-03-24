use std::path::PathBuf;

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
        let hash = Self::compute_hash(data);
        let relative_path =
            crate::storage_paths::build_relative_path(original_name, mime_type, &hash);
        let abs_path = self.base_dir.join(&relative_path);

        if let Some(parent) = abs_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Deduplication: skip write if file already exists with same hash
        if !abs_path.exists() {
            std::fs::write(&abs_path, data)?;
        }

        Ok(SavedFile {
            hash,
            storage_path: relative_path,
            size_bytes: data.len() as i64,
        })
    }

    /// Read file bytes from a relative storage path.
    pub fn read_file(&self, storage_path: &str) -> Result<Vec<u8>> {
        let path = self.resolve_path(storage_path);
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
        let path = self.resolve_path(storage_path);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    fn resolve_path(&self, storage_path: &str) -> PathBuf {
        self.base_dir.join(storage_path)
    }

    fn compute_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }
}
