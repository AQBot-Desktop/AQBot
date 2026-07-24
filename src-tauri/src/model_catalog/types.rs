use super::metadata::CatalogEntry;
use super::DEFAULT_SOURCE_URL;
use aqbot_core::types::{Model, ModelCatalogSourcePreference, ModelMetadataSource};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CatalogFreshness {
    Fresh,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Builtin,
    Network,
    Cache,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogStatus {
    pub configured_source: ModelCatalogSourcePreference,
    pub source: CatalogSource,
    pub freshness: CatalogFreshness,
    pub matched_context_windows: usize,
    pub total_chat_models: usize,
    pub matched_models: usize,
    pub autofilled_fields: usize,
    pub inferred_types: usize,
    pub unsupported_models: usize,
    pub checked_at: Option<i64>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModelSyncStatus {
    Synced,
    LocalOnly,
    RemoteOnly,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelMetadataChange {
    pub field: String,
    pub previous: serde_json::Value,
    pub proposed: serde_json::Value,
    pub source: ModelMetadataSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSyncCandidate {
    pub proposed_model: Model,
    pub status: ModelSyncStatus,
    pub catalog_mode: Option<String>,
    pub inference_source: ModelMetadataSource,
    pub changes: Vec<ModelMetadataChange>,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModelCatalogConfig {
    pub source_url: String,
    pub ttl: Duration,
    pub request_timeout: Duration,
    pub max_response_bytes: usize,
}

impl Default for ModelCatalogConfig {
    fn default() -> Self {
        Self {
            source_url: DEFAULT_SOURCE_URL.to_string(),
            ttl: Duration::from_secs(24 * 60 * 60),
            request_timeout: Duration::from_secs(8),
            max_response_bytes: 5 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CatalogLoadResult {
    pub(super) entries: Arc<BTreeMap<String, CatalogEntry>>,
    pub status: CatalogStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteModelSyncResult {
    pub candidates: Vec<ModelSyncCandidate>,
    pub catalog: CatalogStatus,
}
