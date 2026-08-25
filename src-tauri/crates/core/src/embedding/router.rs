use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{coded_error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EmbedInputKind {
    Query,
    Document,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingProfileRevision {
    pub revision_id: String,
    pub backend: String,
    pub dimensions: usize,
    pub fingerprint: String,
    pub query_prefix: String,
    pub document_prefix: String,
}

#[derive(Debug, thiserror::Error)]
pub enum EmbeddingRouterError {
    #[error("{0}")]
    Coded(String),
}

impl From<EmbeddingRouterError> for crate::error::AQBotError {
    fn from(value: EmbeddingRouterError) -> Self {
        crate::error::AQBotError::Coded(value.to_string())
    }
}

#[async_trait]
pub trait EmbeddingBackend: Send + Sync {
    async fn embed(
        &self,
        revision: &EmbeddingProfileRevision,
        kind: EmbedInputKind,
        inputs: Vec<String>,
    ) -> Result<Vec<Vec<f32>>>;
}

fn apply_prefix(
    revision: &EmbeddingProfileRevision,
    kind: EmbedInputKind,
    inputs: Vec<String>,
) -> Vec<String> {
    let prefix = match kind {
        EmbedInputKind::Query => &revision.query_prefix,
        EmbedInputKind::Document => &revision.document_prefix,
    };
    if prefix.is_empty() {
        return inputs;
    }
    inputs
        .into_iter()
        .map(|input| format!("{prefix}{input}"))
        .collect()
}

pub async fn embed<B: EmbeddingBackend>(
    backend: &B,
    revision: &EmbeddingProfileRevision,
    kind: EmbedInputKind,
    inputs: Vec<String>,
) -> Result<Vec<Vec<f32>>> {
    let expected = inputs.len();
    let prefixed = apply_prefix(revision, kind, inputs);
    let vectors = backend.embed(revision, kind, prefixed).await?;
    validate_embeddings(revision, expected, &vectors)?;
    Ok(vectors)
}

fn validate_embeddings(
    revision: &EmbeddingProfileRevision,
    expected_count: usize,
    vectors: &[Vec<f32>],
) -> Result<()> {
    if vectors.len() != expected_count {
        return Err(coded_error(
            "EMBEDDING_COUNT_MISMATCH",
            serde_json::json!({
                "expected": expected_count,
                "actual": vectors.len()
            }),
        ));
    }
    for (index, vector) in vectors.iter().enumerate() {
        if vector.len() != revision.dimensions {
            return Err(coded_error(
                "EMBEDDING_DIMENSION_MISMATCH",
                serde_json::json!({
                    "expected": revision.dimensions,
                    "actual": vector.len(),
                    "index": index
                }),
            ));
        }
        if vector.iter().any(|value| !value.is_finite()) {
            return Err(coded_error(
                "EMBEDDING_NON_FINITE",
                serde_json::json!({ "index": index }),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AQBotError;

    struct OkBackend {
        vectors: Vec<Vec<f32>>,
    }

    struct FallbackBackend;

    #[async_trait]
    impl EmbeddingBackend for OkBackend {
        async fn embed(
            &self,
            _revision: &EmbeddingProfileRevision,
            _kind: EmbedInputKind,
            _inputs: Vec<String>,
        ) -> Result<Vec<Vec<f32>>> {
            Ok(self.vectors.clone())
        }
    }

    #[async_trait]
    impl EmbeddingBackend for FallbackBackend {
        async fn embed(
            &self,
            _revision: &EmbeddingProfileRevision,
            _kind: EmbedInputKind,
            _inputs: Vec<String>,
        ) -> Result<Vec<Vec<f32>>> {
            Err(coded_error(
                "EMBEDDING_BACKEND_UNAVAILABLE",
                serde_json::json!({ "backend": "builtin" }),
            ))
        }
    }

    fn revision() -> EmbeddingProfileRevision {
        EmbeddingProfileRevision {
            revision_id: "rev-1".into(),
            backend: "remote".into(),
            dimensions: 2,
            fingerprint: "fp".into(),
            query_prefix: "query: ".into(),
            document_prefix: "passage: ".into(),
        }
    }

    fn is_code(err: &AQBotError, code: &str) -> bool {
        err.to_string().contains(code)
    }

    #[tokio::test]
    async fn rejects_count_mismatch() {
        let backend = OkBackend {
            vectors: vec![vec![0.1, 0.2]],
        };
        let err = embed(
            &backend,
            &revision(),
            EmbedInputKind::Query,
            vec!["a".into(), "b".into()],
        )
        .await
        .unwrap_err();
        assert!(is_code(&err, "EMBEDDING_COUNT_MISMATCH"));
    }

    #[tokio::test]
    async fn rejects_dimension_mismatch() {
        let backend = OkBackend {
            vectors: vec![vec![0.1, 0.2, 0.3]],
        };
        let err = embed(
            &backend,
            &revision(),
            EmbedInputKind::Document,
            vec!["a".into()],
        )
        .await
        .unwrap_err();
        assert!(is_code(&err, "EMBEDDING_DIMENSION_MISMATCH"));
    }

    #[tokio::test]
    async fn rejects_nan() {
        let backend = OkBackend {
            vectors: vec![vec![0.1, f32::NAN]],
        };
        let err = embed(
            &backend,
            &revision(),
            EmbedInputKind::Query,
            vec!["a".into()],
        )
        .await
        .unwrap_err();
        assert!(is_code(&err, "EMBEDDING_NON_FINITE"));
    }

    #[tokio::test]
    async fn does_not_fall_back_to_another_backend() {
        let err = embed(
            &FallbackBackend,
            &revision(),
            EmbedInputKind::Query,
            vec!["a".into()],
        )
        .await
        .unwrap_err();
        assert!(is_code(&err, "EMBEDDING_BACKEND_UNAVAILABLE"));
        assert!(!err.to_string().contains("remote"));
    }
}
