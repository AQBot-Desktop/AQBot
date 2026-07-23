use super::types::{CatalogLoadResult, RemoteModelSyncResult};
use aqbot_core::types::{Model, ModelType, ProviderConfig, ProviderType};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const MIN_CONTEXT_WINDOW: u64 = 1_024;
pub(super) const MAX_CONTEXT_WINDOW: u64 = 10_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct CatalogEntry {
    pub provider: String,
    pub mode: String,
    pub max_input_tokens: u32,
    pub supports_vision: Option<bool>,
    pub supports_function_calling: Option<bool>,
    pub supports_reasoning: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RawCatalogEntry {
    litellm_provider: Option<String>,
    mode: Option<String>,
    max_input_tokens: Option<u64>,
    supports_vision: Option<bool>,
    supports_function_calling: Option<bool>,
    supports_reasoning: Option<bool>,
}

pub(super) fn parse_catalog(bytes: &[u8]) -> Result<BTreeMap<String, CatalogEntry>, String> {
    let root: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| format!("Invalid catalog JSON: {error}"))?;
    let object = root
        .as_object()
        .ok_or_else(|| "Model catalog must be a JSON object".to_string())?;
    let entries = object
        .iter()
        .filter_map(|(key, value)| normalize_entry(key, value))
        .collect();
    Ok(entries)
}

fn normalize_entry(key: &str, value: &serde_json::Value) -> Option<(String, CatalogEntry)> {
    let raw = serde_json::from_value::<RawCatalogEntry>(value.clone()).ok()?;
    let provider = raw.litellm_provider?;
    let mode = raw.mode?;
    let max_input_tokens = raw.max_input_tokens?;
    if provider.is_empty()
        || mode != "chat"
        || !(MIN_CONTEXT_WINDOW..=MAX_CONTEXT_WINDOW).contains(&max_input_tokens)
    {
        return None;
    }
    Some((
        key.to_string(),
        CatalogEntry {
            provider,
            mode,
            max_input_tokens: max_input_tokens as u32,
            supports_vision: raw.supports_vision,
            supports_function_calling: raw.supports_function_calling,
            supports_reasoning: raw.supports_reasoning,
        },
    ))
}

pub(super) fn canonical_provider(
    provider_type: &ProviderType,
    builtin_id: Option<&str>,
    api_host: &str,
) -> Option<&'static str> {
    if is_openrouter_host(api_host) {
        return Some("openrouter");
    }
    if let Some(provider) = builtin_id.and_then(canonical_builtin_provider) {
        return provider;
    }
    canonical_provider_type(provider_type)
}

fn is_openrouter_host(api_host: &str) -> bool {
    reqwest::Url::parse(api_host)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "openrouter.ai" || host.ends_with(".openrouter.ai"))
}

fn canonical_builtin_provider(builtin_id: &str) -> Option<Option<&'static str>> {
    let provider = match builtin_id {
        "openai" | "openai_responses" => Some("openai"),
        "gemini" => Some("gemini"),
        "anthropic" => Some("anthropic"),
        "deepseek" => Some("deepseek"),
        "xai" => Some("xai"),
        "glm" => Some("zai"),
        "minimax" => Some("minimax"),
        "jina" => Some("jina"),
        "cohere" => Some("cohere"),
        "voyage" => Some("voyage"),
        "siliconflow" => None,
        _ => return None,
    };
    Some(provider)
}

fn canonical_provider_type(provider_type: &ProviderType) -> Option<&'static str> {
    match provider_type {
        ProviderType::OpenAI | ProviderType::OpenAIResponses => Some("openai"),
        ProviderType::DeepSeek => Some("deepseek"),
        ProviderType::XAI => Some("xai"),
        ProviderType::GLM => Some("zai"),
        ProviderType::Anthropic => Some("anthropic"),
        ProviderType::Gemini => Some("gemini"),
        ProviderType::Jina => Some("jina"),
        ProviderType::Cohere => Some("cohere"),
        ProviderType::Voyage => Some("voyage"),
        ProviderType::SiliconFlow | ProviderType::Custom => None,
    }
}

pub(super) fn find_context_window(
    entries: &BTreeMap<String, CatalogEntry>,
    provider: Option<&str>,
    model_id: &str,
) -> Option<u32> {
    if let Some(provider) = provider {
        return [model_id.to_string(), format!("{provider}/{model_id}")]
            .iter()
            .find_map(|key| {
                entries
                    .get(key)
                    .filter(|entry| entry.provider == provider)
                    .map(|entry| entry.max_input_tokens)
            });
    }
    let entry = entries.get(model_id)?;
    let key_provider = model_id.split_once('/')?.0;
    (key_provider == entry.provider).then_some(entry.max_input_tokens)
}

pub fn enrich_models(
    provider: &ProviderConfig,
    mut models: Vec<Model>,
    catalog: CatalogLoadResult,
) -> RemoteModelSyncResult {
    let catalog_provider = canonical_provider(
        &provider.provider_type,
        provider.builtin_id.as_deref(),
        &provider.api_host,
    );
    let mut status = catalog.status;
    status.total_chat_models = models
        .iter()
        .filter(|model| model.model_type == ModelType::Chat)
        .count();

    for model in models
        .iter_mut()
        .filter(|model| model.model_type == ModelType::Chat)
    {
        let Some(context_window) =
            find_context_window(&catalog.entries, catalog_provider, &model.model_id)
        else {
            continue;
        };
        status.matched_context_windows += 1;
        if model.context_window.is_none() {
            model.context_window = Some(context_window);
        }
    }

    RemoteModelSyncResult {
        models,
        catalog: status,
    }
}
