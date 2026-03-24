use crate::storage_paths;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
pub struct BucketStats {
    pub bucket: String,
    pub file_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct StorageInventory {
    pub buckets: Vec<BucketStats>,
    pub documents_root: String,
}

pub fn scan_storage() -> StorageInventory {
    let root = storage_paths::documents_root();
    let buckets = ["images", "files", "backups"]
        .iter()
        .map(|name| {
            let dir = root.join(name);
            let (count, bytes) = if dir.exists() {
                count_dir_contents(&dir)
            } else {
                (0, 0)
            };
            BucketStats {
                bucket: name.to_string(),
                file_count: count,
                total_bytes: bytes,
            }
        })
        .collect();
    StorageInventory {
        buckets,
        documents_root: root.to_string_lossy().to_string(),
    }
}

fn count_dir_contents(dir: &Path) -> (u64, u64) {
    let mut count = 0u64;
    let mut bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    count += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    (count, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_scan_empty_storage() {
        let tmp = tempfile::tempdir().unwrap();
        let images = tmp.path().join("images");
        let files = tmp.path().join("files");
        let backups = tmp.path().join("backups");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&files).unwrap();
        fs::create_dir_all(&backups).unwrap();

        for name in &["images", "files", "backups"] {
            let (count, bytes) = count_dir_contents(&tmp.path().join(name));
            assert_eq!(count, 0, "{name} should have 0 files");
            assert_eq!(bytes, 0, "{name} should have 0 bytes");
        }
    }

    #[test]
    fn test_scan_with_files() {
        let tmp = tempfile::tempdir().unwrap();
        let images = tmp.path().join("images");
        fs::create_dir_all(&images).unwrap();

        // Write two files of known sizes
        fs::write(images.join("a.png"), vec![0u8; 1024]).unwrap();
        fs::write(images.join("b.jpg"), vec![0u8; 2048]).unwrap();

        let (count, bytes) = count_dir_contents(&images);
        assert_eq!(count, 2);
        assert_eq!(bytes, 3072);
    }

    #[test]
    fn test_count_dir_nonexistent() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nonexistent");
        let (count, bytes) = count_dir_contents(&missing);
        assert_eq!(count, 0);
        assert_eq!(bytes, 0);
    }

    #[test]
    fn test_count_dir_skips_subdirectories() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mixed");
        fs::create_dir_all(dir.join("subdir")).unwrap();
        fs::write(dir.join("file.txt"), vec![0u8; 512]).unwrap();

        let (count, bytes) = count_dir_contents(&dir);
        assert_eq!(count, 1, "should only count files, not subdirs");
        assert_eq!(bytes, 512);
    }
}
