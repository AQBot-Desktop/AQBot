mod cache;
mod metadata;
mod snapshot;
mod types;

use aqbot_core::types::ModelCatalogSourcePreference;
use cache::{read_cache, write_cache_atomic, CatalogCache};
pub use metadata::enrich_models;
use metadata::{parse_catalog, CatalogEntry};
use reqwest::header::{ETAG, IF_NONE_MATCH, USER_AGENT};
pub(crate) use snapshot::build_snapshot;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
pub use types::{
    CatalogFreshness, CatalogLoadResult, CatalogSource, CatalogStatus, ModelCatalogConfig,
    RemoteModelSyncResult,
};

const CACHE_FILE_NAME: &str = "litellm.json";
pub const DEFAULT_SOURCE_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

pub struct ModelCatalogService {
    cache_path: PathBuf,
    config: ModelCatalogConfig,
    builtin_entries: Result<Arc<BTreeMap<String, CatalogEntry>>, String>,
    memory: RwLock<Option<CatalogCache>>,
    last_refresh: RwLock<Option<CatalogLoadResult>>,
    refresh_generation: AtomicU64,
    refresh_lock: Mutex<()>,
}

enum FetchResult {
    Modified {
        entries: BTreeMap<String, CatalogEntry>,
        etag: Option<String>,
    },
    NotModified,
}

impl ModelCatalogService {
    pub fn new(cache_dir: impl AsRef<Path>, config: ModelCatalogConfig) -> Self {
        let builtin_entries = snapshot::load_builtin_entries()
            .map(Arc::new)
            .map_err(|error| format!("Failed to load built-in LiteLLM catalog: {error}"));
        Self::new_with_builtin(cache_dir, config, builtin_entries)
    }

    fn new_with_builtin(
        cache_dir: impl AsRef<Path>,
        config: ModelCatalogConfig,
        builtin_entries: Result<Arc<BTreeMap<String, CatalogEntry>>, String>,
    ) -> Self {
        Self {
            cache_path: cache_dir.as_ref().join(CACHE_FILE_NAME),
            config,
            builtin_entries,
            memory: RwLock::new(None),
            last_refresh: RwLock::new(None),
            refresh_generation: AtomicU64::new(0),
            refresh_lock: Mutex::new(()),
        }
    }

    pub fn load_builtin(&self) -> CatalogLoadResult {
        self.builtin_result(ModelCatalogSourcePreference::Builtin, None)
    }

    pub async fn load_online(&self, client: &reqwest::Client, now: i64) -> CatalogLoadResult {
        let observed_generation = self.refresh_generation.load(Ordering::Acquire);
        let (cached, first_warning) = self.load_cached().await;
        if let Some(cache) = cached.as_ref().filter(|cache| self.is_fresh(cache, now)) {
            return result_from_cache(cache, CatalogFreshness::Fresh, first_warning);
        }

        let _refresh_guard = self.refresh_lock.lock().await;
        let (cached, second_warning) = self.load_cached().await;
        if let Some(cache) = cached.as_ref().filter(|cache| self.is_fresh(cache, now)) {
            return result_from_cache(cache, CatalogFreshness::Fresh, second_warning);
        }
        if self.refresh_generation.load(Ordering::Acquire) != observed_generation {
            if let Some(result) = self.last_refresh.read().await.clone() {
                return result;
            }
        }

        let etag = cached.as_ref().and_then(|cache| cache.etag.as_deref());
        let result = match self.fetch(client, etag).await {
            Ok(result) => self.apply_fetch_result(result, cached, now).await,
            Err(error) => match cached {
                Some(cache) => result_from_cache(&cache, CatalogFreshness::Stale, Some(error)),
                None => self.builtin_result(
                    ModelCatalogSourcePreference::Online,
                    combine_warnings(first_warning.or(second_warning), Some(error)),
                ),
            },
        };
        *self.last_refresh.write().await = Some(result.clone());
        self.refresh_generation.fetch_add(1, Ordering::Release);
        result
    }

    pub async fn load_cached_only(&self, now: i64, warning: String) -> CatalogLoadResult {
        let (cached, cache_warning) = self.load_cached().await;
        let warning = combine_warnings(cache_warning, Some(warning));
        let Some(cache) = cached else {
            return self.builtin_result(ModelCatalogSourcePreference::Online, warning);
        };
        let freshness = if self.is_fresh(&cache, now) {
            CatalogFreshness::Fresh
        } else {
            CatalogFreshness::Stale
        };
        result_from_cache(&cache, freshness, warning)
    }

    async fn apply_fetch_result(
        &self,
        result: FetchResult,
        cached: Option<CatalogCache>,
        now: i64,
    ) -> CatalogLoadResult {
        let (cache, source) = match result {
            FetchResult::Modified { entries, etag } => (
                CatalogCache::new(entries, etag, now),
                CatalogSource::Network,
            ),
            FetchResult::NotModified => {
                let Some(mut cache) = cached else {
                    return self.builtin_result(
                        ModelCatalogSourcePreference::Online,
                        Some("LiteLLM returned 304 without a local cache".to_string()),
                    );
                };
                cache.checked_at = now;
                (cache, CatalogSource::Cache)
            }
        };
        let warning = self.store_cache(cache.clone()).await.err();
        *self.memory.write().await = Some(cache.clone());
        result_from_valid_cache(&cache, source, CatalogFreshness::Fresh, warning)
    }

    fn is_fresh(&self, cache: &CatalogCache, now: i64) -> bool {
        cache_freshness(
            cache.checked_at,
            now,
            self.config.ttl.as_secs().min(i64::MAX as u64) as i64,
        ) == CatalogFreshness::Fresh
    }

    async fn load_cached(&self) -> (Option<CatalogCache>, Option<String>) {
        if let Some(cache) = self.memory.read().await.clone() {
            return (Some(cache), None);
        }
        if !self.cache_path.exists() {
            return (None, None);
        }
        let path = self.cache_path.clone();
        match tokio::task::spawn_blocking(move || read_cache(&path)).await {
            Ok(Ok(cache)) => {
                *self.memory.write().await = Some(cache.clone());
                (Some(cache), None)
            }
            Ok(Err(error)) => (None, Some(error)),
            Err(error) => (None, Some(format!("Failed to read LiteLLM cache: {error}"))),
        }
    }

    async fn store_cache(&self, cache: CatalogCache) -> Result<(), String> {
        let path = self.cache_path.clone();
        tokio::task::spawn_blocking(move || write_cache_atomic(&path, &cache))
            .await
            .map_err(|error| format!("Failed to join LiteLLM cache writer: {error}"))?
    }

    async fn fetch(
        &self,
        client: &reqwest::Client,
        etag: Option<&str>,
    ) -> Result<FetchResult, String> {
        let mut request = client
            .get(&self.config.source_url)
            .header(USER_AGENT, aqbot_providers::default_user_agent())
            .timeout(self.config.request_timeout);
        if let Some(etag) = etag {
            request = request.header(IF_NONE_MATCH, etag);
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("Failed to refresh LiteLLM catalog: {error}"))?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(FetchResult::NotModified);
        }
        validate_response_size(&response, self.config.max_response_bytes)?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = read_limited_body(&mut response, self.config.max_response_bytes).await?;
        let entries = parse_catalog(&body)?;
        if entries.is_empty() {
            return Err("LiteLLM catalog did not contain valid chat models".to_string());
        }
        Ok(FetchResult::Modified { entries, etag })
    }

    fn builtin_result(
        &self,
        configured_source: ModelCatalogSourcePreference,
        warning: Option<String>,
    ) -> CatalogLoadResult {
        match &self.builtin_entries {
            Ok(entries) => {
                log_warning(CatalogSource::Builtin, warning.as_deref());
                CatalogLoadResult {
                    entries: entries.clone(),
                    status: CatalogStatus {
                        configured_source,
                        source: CatalogSource::Builtin,
                        freshness: CatalogFreshness::Unknown,
                        matched_context_windows: 0,
                        total_chat_models: 0,
                        checked_at: None,
                        warning,
                    },
                }
            }
            Err(error) => unavailable_result(
                configured_source,
                combine_warnings(warning, Some(error.clone())),
            ),
        }
    }
}

fn validate_response_size(response: &reqwest::Response, limit: usize) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(format!(
            "LiteLLM catalog returned HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("LiteLLM catalog response exceeds the 5 MiB limit".to_string());
    }
    Ok(())
}

async fn read_limited_body(
    response: &mut reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Failed to read LiteLLM catalog: {error}"))?
    {
        if body.len() + chunk.len() > limit {
            return Err("LiteLLM catalog response exceeds the 5 MiB limit".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn cache_freshness(checked_at: i64, now: i64, ttl_seconds: i64) -> CatalogFreshness {
    if now <= checked_at || now - checked_at < ttl_seconds {
        CatalogFreshness::Fresh
    } else {
        CatalogFreshness::Stale
    }
}

fn result_from_cache(
    cache: &CatalogCache,
    freshness: CatalogFreshness,
    warning: Option<String>,
) -> CatalogLoadResult {
    result_from_valid_cache(cache, CatalogSource::Cache, freshness, warning)
}

fn result_from_valid_cache(
    cache: &CatalogCache,
    source: CatalogSource,
    freshness: CatalogFreshness,
    warning: Option<String>,
) -> CatalogLoadResult {
    log_warning(source, warning.as_deref());
    CatalogLoadResult {
        entries: Arc::new(cache.entries.clone()),
        status: CatalogStatus {
            configured_source: ModelCatalogSourcePreference::Online,
            source,
            freshness,
            matched_context_windows: 0,
            total_chat_models: 0,
            checked_at: Some(cache.checked_at),
            warning,
        },
    }
}

fn unavailable_result(
    configured_source: ModelCatalogSourcePreference,
    warning: Option<String>,
) -> CatalogLoadResult {
    log_warning(CatalogSource::Unavailable, warning.as_deref());
    CatalogLoadResult {
        entries: Arc::new(BTreeMap::new()),
        status: CatalogStatus {
            configured_source,
            source: CatalogSource::Unavailable,
            freshness: CatalogFreshness::Unknown,
            matched_context_windows: 0,
            total_chat_models: 0,
            checked_at: None,
            warning,
        },
    }
}

fn log_warning(source: CatalogSource, warning: Option<&str>) {
    if let Some(warning) = warning {
        tracing::warn!(catalog_source = ?source, %warning, "Model catalog loaded with a warning");
    }
}

fn combine_warnings(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(first), Some(second)) => Some(format!("{first}; {second}")),
        (Some(warning), None) | (None, Some(warning)) => Some(warning),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests;
