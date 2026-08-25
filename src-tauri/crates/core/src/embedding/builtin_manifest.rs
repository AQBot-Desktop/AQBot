/// Pinned builtin embedding artifact. SHA-256 and file list are the install contract.
pub struct BuiltinEmbeddingFile {
    pub name: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

pub struct BuiltinEmbeddingManifest {
    pub artifact_id: &'static str,
    pub revision: &'static str,
    pub huggingface_repo: &'static str,
    pub files: &'static [BuiltinEmbeddingFile],
    pub dimensions: usize,
    pub max_length: usize,
    pub pooling: &'static str,
    pub normalize: bool,
    pub query_prefix: &'static str,
    pub document_prefix: &'static str,
    pub license: &'static str,
    pub platforms: &'static [&'static str],
}

/// Stored on Memory/Knowledge as `embedding_provider`. Not a chat Provider id.
pub const BUILTIN_EMBEDDING_REF: &str = "builtin::multilingual-e5-small";

pub fn is_builtin_embedding_ref(value: &str) -> bool {
    value == BUILTIN_EMBEDDING_REF
}

/// Xenova INT8 ONNX of intfloat/multilingual-e5-small (MIT).
/// ONNX weights plus tokenizer.json are downloaded from the same repo; hashes are verified at install.
pub const MULTILINGUAL_E5_SMALL_INT8: BuiltinEmbeddingManifest = BuiltinEmbeddingManifest {
    artifact_id: "multilingual-e5-small",
    revision: "761b726",
    huggingface_repo: "Xenova/multilingual-e5-small",
    files: &[
        BuiltinEmbeddingFile {
            name: "onnx/model_int8.onnx",
            sha256: "4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
            size_bytes: 118_054_593,
        },
        BuiltinEmbeddingFile {
            name: "tokenizer.json",
            sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
            size_bytes: 17_082_730,
        },
    ],
    dimensions: 384,
    max_length: 512,
    pooling: "mean",
    normalize: true,
    query_prefix: "query: ",
    document_prefix: "passage: ",
    license: "MIT",
    platforms: &[
        "macos-aarch64",
        "macos-x86_64",
        "windows-x86_64",
        "windows-aarch64",
        "linux-x86_64",
        "linux-aarch64",
    ],
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_ref_is_not_a_chat_provider_id() {
        assert_eq!(BUILTIN_EMBEDDING_REF, "builtin::multilingual-e5-small");
        assert!(is_builtin_embedding_ref(BUILTIN_EMBEDDING_REF));
        assert!(!is_builtin_embedding_ref("openai::text-embedding-3-small"));
    }

    #[test]
    fn builtin_manifest_pins_revision_hash_and_six_targets() {
        assert_eq!(MULTILINGUAL_E5_SMALL_INT8.dimensions, 384);
        assert_eq!(MULTILINGUAL_E5_SMALL_INT8.files.len(), 2);
        assert_eq!(MULTILINGUAL_E5_SMALL_INT8.files[0].sha256.len(), 64);
        assert_eq!(MULTILINGUAL_E5_SMALL_INT8.platforms.len(), 6);
        assert!(MULTILINGUAL_E5_SMALL_INT8
            .query_prefix
            .starts_with("query:"));
    }
}
