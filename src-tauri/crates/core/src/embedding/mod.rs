//! Embedding profile routing. Local and remote backends share one validated path.

mod artifact;
mod builtin_manifest;
mod pooling;
mod router;

pub use artifact::{
    artifact_dir, artifact_file_path, huggingface_file_url, inspect_artifact, inspect_file,
    partial_path, primary_file_path, publish_partial, uninstall_artifact, EmbeddingArtifactStatus,
};

pub use builtin_manifest::{
    is_builtin_embedding_ref, BuiltinEmbeddingFile, BuiltinEmbeddingManifest,
    BUILTIN_EMBEDDING_REF, MULTILINGUAL_E5_SMALL_INT8,
};

pub use pooling::mean_pool_l2;

pub use router::{
    embed, EmbedInputKind, EmbeddingBackend, EmbeddingProfileRevision, EmbeddingRouterError,
};
