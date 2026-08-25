use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::builtin_manifest::{BuiltinEmbeddingFile, MULTILINGUAL_E5_SMALL_INT8};
use crate::error::{coded_error, Result};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingArtifactStatus {
    pub status: String,
    pub artifact_id: String,
    pub revision: String,
    pub path: String,
    pub size_bytes: u64,
    pub downloaded_bytes: u64,
    pub license: String,
}

pub fn artifact_dir(config_home: &Path) -> PathBuf {
    config_home
        .join("models")
        .join("embeddings")
        .join(MULTILINGUAL_E5_SMALL_INT8.artifact_id)
        .join(MULTILINGUAL_E5_SMALL_INT8.revision)
}

pub fn artifact_file_path(config_home: &Path, file_name: &str) -> PathBuf {
    artifact_dir(config_home).join(file_name)
}

pub fn primary_file_path(config_home: &Path) -> PathBuf {
    artifact_file_path(config_home, MULTILINGUAL_E5_SMALL_INT8.files[0].name)
}

pub fn huggingface_file_url(file_name: &str) -> String {
    let manifest = &MULTILINGUAL_E5_SMALL_INT8;
    format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        manifest.huggingface_repo, manifest.revision, file_name
    )
}

pub fn partial_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    dest.with_file_name(name)
}

pub fn sha256_reader(mut reader: impl Read) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 32 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn inspect_file(path: &Path, file: &BuiltinEmbeddingFile) -> &'static str {
    let Ok(meta) = std::fs::metadata(path) else {
        return "missing";
    };
    if !meta.is_file() {
        return "missing";
    }
    if meta.len() == file.size_bytes {
        "installed"
    } else {
        "corrupted"
    }
}

pub fn inspect_artifact(config_home: &Path) -> EmbeddingArtifactStatus {
    let manifest = &MULTILINGUAL_E5_SMALL_INT8;
    let file = &manifest.files[0];
    let path = primary_file_path(config_home);
    let status = inspect_file(&path, file);
    EmbeddingArtifactStatus {
        status: status.into(),
        artifact_id: manifest.artifact_id.into(),
        revision: manifest.revision.into(),
        path: path.display().to_string(),
        size_bytes: file.size_bytes,
        downloaded_bytes: if status == "installed" {
            file.size_bytes
        } else {
            std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0)
        },
        license: manifest.license.into(),
    }
}

pub fn uninstall_artifact(config_home: &Path) -> Result<()> {
    let dir = artifact_dir(config_home);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    if let Some(parent) = dir.parent() {
        if parent.exists()
            && std::fs::read_dir(parent)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
        {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(())
}

pub fn publish_partial(partial: &Path, dest: &Path, expected_sha: &str) -> Result<()> {
    let file = std::fs::File::open(partial)?;
    let hash = sha256_reader(file)?;
    if hash != expected_sha {
        let _ = std::fs::remove_file(partial);
        return Err(coded_error(
            "EMBEDDING_ARTIFACT_HASH_MISMATCH",
            serde_json::json!({ "expected": expected_sha, "actual": hash }),
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(partial, dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn inspect_missing_when_file_absent() {
        let dir = tempfile::tempdir().unwrap();
        let status = inspect_artifact(dir.path());
        assert_eq!(status.status, "missing");
        assert!(status.path.contains("multilingual-e5-small"));
    }

    #[test]
    fn publish_rejects_wrong_hash() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("model.partial");
        let dest = dir.path().join("onnx").join("model_int8.onnx");
        std::fs::write(&partial, b"not-the-model").unwrap();
        let err = publish_partial(&partial, &dest, "abcd").unwrap_err();
        assert!(err.to_string().contains("EMBEDDING_ARTIFACT_HASH_MISMATCH"));
        assert!(!dest.exists());
    }

    #[test]
    fn publish_renames_when_hash_matches() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("model.partial");
        let dest = dir.path().join("onnx").join("model_int8.onnx");
        let bytes = b"ok-model";
        let mut file = std::fs::File::create(&partial).unwrap();
        file.write_all(bytes).unwrap();
        drop(file);
        let hash = sha256_reader(bytes.as_slice()).unwrap();
        publish_partial(&partial, &dest, &hash).unwrap();
        assert!(dest.is_file());
        assert!(!partial.exists());
    }

    #[test]
    fn inspect_file_uses_size_not_hash() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.onnx");
        std::fs::write(&dest, b"abc").unwrap();
        let file = BuiltinEmbeddingFile {
            name: "model.onnx",
            sha256: "deadbeef",
            size_bytes: 3,
        };
        assert_eq!(inspect_file(&dest, &file), "installed");
        std::fs::write(&dest, b"ab").unwrap();
        assert_eq!(inspect_file(&dest, &file), "corrupted");
    }

    #[test]
    fn uninstall_removes_artifact_dir() {
        let dir = tempfile::tempdir().unwrap();
        let dest = primary_file_path(dir.path());
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, b"model").unwrap();
        uninstall_artifact(dir.path()).unwrap();
        assert!(!artifact_dir(dir.path()).exists());
    }
}
