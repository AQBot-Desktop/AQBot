//! Normalization for the LiteLLM model metadata catalog.
//! Source: model_prices_and_context_window.json from BerriAI/LiteLLM,
//! distributed under the MIT license; see THIRD_PARTY_NOTICES.md.

use aqbot_core::types::{ModelType, ProviderType};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const MIN_CONTEXT_WINDOW: u64 = 1_024;
pub(super) const MAX_CONTEXT_WINDOW: u64 = 10_000_000;
pub(super) const MIN_OUTPUT_TOKENS: u64 = 1;
pub(super) const MAX_OUTPUT_TOKENS: u64 = 10_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct CatalogEntry {
    pub provider: String,
    pub mode: String,
    pub max_input_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub supports_vision: Option<bool>,
    pub supports_function_calling: Option<bool>,
    pub supports_reasoning: Option<bool>,
    pub supports_system_messages: Option<bool>,
    pub supports_sampling_params: Option<bool>,
    pub supported_modalities: Option<Vec<String>>,
    pub reasoning_options: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct RawCatalogEntry {
    litellm_provider: Option<String>,
    mode: Option<String>,
    max_input_tokens: Option<u64>,
    max_output_tokens: Option<u64>,
    supports_vision: Option<bool>,
    supports_function_calling: Option<bool>,
    supports_reasoning: Option<bool>,
    supports_system_messages: Option<bool>,
    supports_sampling_params: Option<bool>,
    supported_modalities: Option<serde_json::Value>,
    supports_none_reasoning_effort: Option<bool>,
    supports_minimal_reasoning_effort: Option<bool>,
    supports_low_reasoning_effort: Option<bool>,
    supports_xhigh_reasoning_effort: Option<bool>,
    supports_max_reasoning_effort: Option<bool>,
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
    if key == "sample_spec" {
        return None;
    }
    let raw = serde_json::from_value::<RawCatalogEntry>(value.clone()).ok()?;
    let reasoning_options = normalize_reasoning_options(&raw);
    let provider = non_empty(raw.litellm_provider?)?;
    let mode = non_empty(raw.mode?)?;
    if !mode
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return None;
    }
    Some((
        key.to_string(),
        CatalogEntry {
            provider,
            mode,
            max_input_tokens: valid_token_count(
                raw.max_input_tokens,
                MIN_CONTEXT_WINDOW,
                MAX_CONTEXT_WINDOW,
            ),
            max_output_tokens: valid_token_count(
                raw.max_output_tokens,
                MIN_OUTPUT_TOKENS,
                MAX_OUTPUT_TOKENS,
            ),
            supports_vision: raw.supports_vision,
            supports_function_calling: raw.supports_function_calling,
            supports_reasoning: raw.supports_reasoning,
            supports_system_messages: raw.supports_system_messages,
            supports_sampling_params: raw.supports_sampling_params,
            supported_modalities: normalize_modalities(raw.supported_modalities),
            reasoning_options,
        },
    ))
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn valid_token_count(value: Option<u64>, minimum: u64, maximum: u64) -> Option<u32> {
    value
        .filter(|value| (minimum..=maximum).contains(value))
        .map(|value| value as u32)
}

fn normalize_modalities(value: Option<serde_json::Value>) -> Option<Vec<String>> {
    let mut modalities: Vec<String> = value?
        .as_array()?
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_ascii_lowercase)
        .collect();
    modalities.sort();
    modalities.dedup();
    (!modalities.is_empty()).then_some(modalities)
}

fn normalize_reasoning_options(raw: &RawCatalogEntry) -> Option<Vec<String>> {
    let flags = [
        ("none", raw.supports_none_reasoning_effort),
        ("minimal", raw.supports_minimal_reasoning_effort),
        ("low", raw.supports_low_reasoning_effort),
        ("xhigh", raw.supports_xhigh_reasoning_effort),
        ("max", raw.supports_max_reasoning_effort),
    ];
    if flags.iter().all(|(_, value)| value.is_none()) {
        return None;
    }
    let mut options = vec![
        "default".to_string(),
        "medium".to_string(),
        "high".to_string(),
    ];
    options.extend(
        flags
            .iter()
            .filter(|(_, value)| *value == Some(true))
            .map(|(key, _)| (*key).to_string()),
    );
    options.sort();
    Some(options)
}

pub(super) fn model_type_for_mode(mode: &str) -> Option<ModelType> {
    match mode {
        "chat" | "responses" | "completion" => Some(ModelType::Chat),
        "embedding" => Some(ModelType::Embedding),
        "image_generation" | "image_edit" => Some(ModelType::Image),
        "audio_transcription" | "audio_speech" | "realtime" => Some(ModelType::Voice),
        "rerank" => Some(ModelType::Rerank),
        _ => None,
    }
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

#[cfg(test)]
pub(super) fn find_context_window(
    entries: &BTreeMap<String, CatalogEntry>,
    provider: Option<&str>,
    model_id: &str,
) -> Option<u32> {
    find_catalog_entry(entries, provider, model_id).and_then(|(_, entry)| entry.max_input_tokens)
}

pub(super) fn find_catalog_entry<'a>(
    entries: &'a BTreeMap<String, CatalogEntry>,
    provider: Option<&str>,
    model_id: &str,
) -> Option<(&'a str, &'a CatalogEntry)> {
    if let Some(provider) = provider {
        for key in [model_id.to_string(), format!("{provider}/{model_id}")] {
            if let Some(entry) = entries
                .get_key_value(&key)
                .filter(|(_, entry)| entry.provider == provider)
            {
                return Some((entry.0.as_str(), entry.1));
            }
        }
        return None;
    }
    let (key, entry) = entries.get_key_value(model_id)?;
    let key_provider = model_id.split_once('/')?.0;
    (key_provider == entry.provider).then_some((key.as_str(), entry))
}
