use super::metadata::{
    CatalogEntry, MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MIN_CONTEXT_WINDOW, MIN_OUTPUT_TOKENS,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

const CACHE_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct CatalogCache {
    pub schema_version: u32,
    pub etag: Option<String>,
    pub fetched_at: i64,
    pub checked_at: i64,
    pub entries: BTreeMap<String, CatalogEntry>,
}

impl CatalogCache {
    pub fn new(entries: BTreeMap<String, CatalogEntry>, etag: Option<String>, now: i64) -> Self {
        Self {
            schema_version: CACHE_SCHEMA_VERSION,
            etag,
            fetched_at: now,
            checked_at: now,
            entries,
        }
    }
}

pub(super) fn read_cache(path: &Path) -> Result<CatalogCache, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read LiteLLM cache {}: {error}", path.display()))?;
    let cache: CatalogCache = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid LiteLLM cache {}: {error}", path.display()))?;
    validate_cache(&cache)?;
    Ok(cache)
}

fn validate_cache(cache: &CatalogCache) -> Result<(), String> {
    if cache.schema_version != CACHE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported LiteLLM cache schema {}",
            cache.schema_version
        ));
    }
    validate_entries(&cache.entries)
}

pub(super) fn validate_entries(entries: &BTreeMap<String, CatalogEntry>) -> Result<(), String> {
    if entries.is_empty() {
        return Err("LiteLLM cache contains no model entries".to_string());
    }
    if entries.values().any(invalid_entry) {
        return Err("LiteLLM cache contains invalid model metadata".to_string());
    }
    Ok(())
}

fn invalid_entry(entry: &CatalogEntry) -> bool {
    entry.provider.is_empty()
        || entry.mode.is_empty()
        || entry.max_input_tokens.is_some_and(|value| {
            !(MIN_CONTEXT_WINDOW..=MAX_CONTEXT_WINDOW).contains(&(value as u64))
        })
        || entry
            .max_output_tokens
            .is_some_and(|value| !(MIN_OUTPUT_TOKENS..=MAX_OUTPUT_TOKENS).contains(&(value as u64)))
}

pub(super) fn write_cache_atomic(path: &Path, cache: &CatalogCache) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("LiteLLM cache path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create LiteLLM cache directory: {error}"))?;
    let bytes = serde_json::to_vec(cache)
        .map_err(|error| format!("Failed to serialize LiteLLM cache: {error}"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create LiteLLM cache staging file: {error}"))?;
    temp.write_all(&bytes)
        .map_err(|error| format!("Failed to write LiteLLM cache staging file: {error}"))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|error| format!("Failed to sync LiteLLM cache staging file: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("Failed to replace LiteLLM cache: {error}"))?;
    Ok(())
}
