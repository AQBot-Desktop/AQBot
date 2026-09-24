use serde::{Deserialize, Serialize};

// === Model System ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub group_name: Option<String>,
    pub model_type: ModelType,
    pub capabilities: Vec<ModelCapability>,
    #[serde(alias = "max_tokens")]
    pub context_window: Option<u32>,
    /// Maximum output tokens supported by the model. This is a hard cap, not a
    /// request default.
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    pub enabled: bool,
    pub param_overrides: Option<ModelParamOverrides>,
    #[serde(default)]
    pub image_config: Option<serde_json::Value>,
    /// `None` marks a legacy record whose existing values must be preserved
    /// until the user explicitly restores automatic detection.
    #[serde(default)]
    pub metadata_state: Option<ModelMetadataState>,
    /// Gateway request aliases. Clients may send an alias as `model`; the gateway
    /// rewrites the upstream request to the real `model_id`. Empty by default.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Packed custom icon: `emoji:`, `url:`, `file:`, `model:Id`, or `provider:Id`.
    #[serde(default)]
    pub icon: Option<String>,
}

/// Maximum length of a single model alias.
pub const MODEL_ALIAS_MAX_LEN: usize = 128;

/// Normalize aliases: trim, drop empty, de-duplicate while preserving order.
pub fn normalize_model_aliases(aliases: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for alias in aliases {
        let trimmed = alias.as_ref().trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            out.push(trimmed.to_string());
        }
    }
    out
}

/// Validate aliases for a model within one provider's model list.
///
/// Rules:
/// - each alias non-empty after trim, length ≤ [`MODEL_ALIAS_MAX_LEN`]
/// - alias ≠ own `model_id`
/// - unique among other models' `model_id` and aliases on the same provider
pub fn validate_model_aliases(
    model_id: &str,
    aliases: &[String],
    sibling_models: &[(String, Vec<String>)],
) -> Result<(), String> {
    let normalized = normalize_model_aliases(aliases.iter().map(|s| s.as_str()));
    for alias in &normalized {
        if alias.len() > MODEL_ALIAS_MAX_LEN {
            return Err(format!(
                "Alias '{}' exceeds max length of {}",
                alias, MODEL_ALIAS_MAX_LEN
            ));
        }
        if alias == model_id {
            return Err(format!(
                "Alias '{}' must not equal the model's own model_id",
                alias
            ));
        }
        for (other_id, other_aliases) in sibling_models {
            if other_id == model_id {
                continue;
            }
            if other_id == alias {
                return Err(format!(
                    "Alias '{}' conflicts with another model's model_id on this provider",
                    alias
                ));
            }
            if other_aliases.iter().any(|a| a == alias) {
                return Err(format!(
                    "Alias '{}' is already used by another model on this provider",
                    alias
                ));
            }
        }
    }
    Ok(())
}

/// Whether a model is addressable by the given request name (real id or alias).
pub fn model_matches_request_name(model: &Model, name: &str) -> bool {
    model.model_id == name || model.aliases.iter().any(|a| a == name)
}

#[cfg(test)]
mod model_alias_tests {
    use super::*;

    #[test]
    fn normalize_trims_and_dedups() {
        assert_eq!(
            normalize_model_aliases(["  a ", "a", "", "b"]),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn validate_rejects_own_model_id_and_sibling_conflict() {
        let siblings = vec![
            ("gpt-5.5".to_string(), vec!["5.5".to_string()]),
            ("other".to_string(), vec![]),
        ];
        assert!(validate_model_aliases("gpt-5.5", &["gpt-5.5".into()], &siblings).is_err());
        assert!(validate_model_aliases("other", &["5.5".into()], &siblings).is_err());
        assert!(validate_model_aliases("other", &["fast".into()], &siblings).is_ok());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ModelType {
    Chat,
    Voice,
    Embedding,
    Image,
    Rerank,
}

impl Default for ModelType {
    fn default() -> Self {
        ModelType::Chat
    }
}

impl ModelType {
    /// Conservatively infer a model type from a model identifier.
    pub fn detect(model_id: &str) -> Self {
        infer_model_type_and_capabilities(model_id, "").0
    }
}

impl std::fmt::Display for ModelType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelType::Chat => write!(f, "chat"),
            ModelType::Voice => write!(f, "voice"),
            ModelType::Embedding => write!(f, "embedding"),
            ModelType::Image => write!(f, "image"),
            ModelType::Rerank => write!(f, "rerank"),
        }
    }
}

impl std::str::FromStr for ModelType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "chat" => Ok(ModelType::Chat),
            "voice" => Ok(ModelType::Voice),
            "embedding" => Ok(ModelType::Embedding),
            "image" => Ok(ModelType::Image),
            "rerank" => Ok(ModelType::Rerank),
            _ => Ok(ModelType::Chat),
        }
    }
}

#[cfg(test)]
mod model_type_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detect_identifies_rerank_models() {
        assert_eq!(ModelType::detect("jina-reranker-v3"), ModelType::Rerank);
        assert_eq!(ModelType::detect("rerank-v4.0-pro"), ModelType::Rerank);
        assert_eq!(ModelType::detect("voyage-rerank-2.5"), ModelType::Rerank);
        assert_eq!(ModelType::detect("jina-colbert-v2"), ModelType::Rerank);
    }

    #[test]
    fn detection_uses_boundaries_and_stable_precedence() {
        assert_eq!(
            ModelType::detect("amazon.titan-embed-image-v1"),
            ModelType::Embedding
        );
        assert_eq!(ModelType::detect("gpt-image-1"), ModelType::Image);
        assert_eq!(ModelType::detect("grok-imagine-image"), ModelType::Image);
        assert_eq!(ModelType::detect("cogview-4"), ModelType::Image);
        assert_eq!(ModelType::detect("Kolors"), ModelType::Image);
        assert_eq!(
            ModelType::detect("Qwen/Qwen-Image-Edit-2509"),
            ModelType::Image
        );
        assert_eq!(ModelType::detect("x-image"), ModelType::Image);
        assert_eq!(ModelType::detect("foo_image_bar"), ModelType::Image);
        assert_eq!(ModelType::detect("chatgpt-image-latest"), ModelType::Image);
        assert_eq!(ModelType::detect("speech-to-text"), ModelType::Voice);
        assert_eq!(ModelType::detect("imagination-chat"), ModelType::Chat);
        assert_eq!(ModelType::detect("audiofile-chat"), ModelType::Chat);
        assert_eq!(ModelType::detect("grok-3"), ModelType::Chat);
        assert_eq!(ModelType::detect("omni-moderation-latest"), ModelType::Chat);
    }

    #[test]
    fn chat_capabilities_are_conservative() {
        let (_, vision) = infer_model_type_and_capabilities("qwen-vl-max", "");
        assert!(vision.contains(&ModelCapability::Vision));
        let (_, reasoning) = infer_model_type_and_capabilities("deepseek-r1", "");
        assert!(reasoning.contains(&ModelCapability::Reasoning));
        let (_, ordinary) = infer_model_type_and_capabilities("gpt-4o", "");
        assert_eq!(ordinary, vec![ModelCapability::TextChat]);
        assert!(!ordinary.contains(&ModelCapability::FunctionCalling));
    }

    #[test]
    fn model_context_window_serializes_new_name_and_accepts_legacy_alias() {
        let model: Model = serde_json::from_value(json!({
            "provider_id": "provider",
            "model_id": "gpt-4o",
            "name": "GPT-4o",
            "group_name": null,
            "model_type": "Chat",
            "capabilities": [],
            "max_tokens": 128000,
            "enabled": true,
            "param_overrides": null
        }))
        .unwrap();

        assert_eq!(model.context_window, Some(128_000));
        assert_eq!(model.max_output_tokens, None);
        assert_eq!(model.metadata_state, None);
        let serialized = serde_json::to_value(model).unwrap();
        assert_eq!(serialized["context_window"], json!(128_000));
        assert!(serialized.get("max_tokens").is_none());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ModelCapability {
    TextChat,
    Vision,
    FunctionCalling,
    Reasoning,
    RealtimeVoice,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelMetadataSource {
    Catalog,
    Provider,
    Heuristic,
    Default,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelMetadataState {
    pub schema_version: u32,
    pub catalog_key: Option<String>,
    pub catalog_mode: Option<String>,
    pub model_type: ModelMetadataSource,
    pub capabilities: ModelMetadataSource,
    pub context_window: ModelMetadataSource,
    pub max_output_tokens: ModelMetadataSource,
    pub no_system_role: ModelMetadataSource,
    pub omit_sampling_params: ModelMetadataSource,
    pub reasoning_options: ModelMetadataSource,
}

impl Default for ModelMetadataState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            catalog_key: None,
            catalog_mode: None,
            model_type: ModelMetadataSource::Default,
            capabilities: ModelMetadataSource::Default,
            context_window: ModelMetadataSource::Default,
            max_output_tokens: ModelMetadataSource::Default,
            no_system_role: ModelMetadataSource::Default,
            omit_sampling_params: ModelMetadataSource::Default,
            reasoning_options: ModelMetadataSource::Default,
        }
    }
}

pub fn default_capabilities_for_model_type(model_type: &ModelType) -> Vec<ModelCapability> {
    match model_type {
        ModelType::Chat => vec![ModelCapability::TextChat],
        ModelType::Voice | ModelType::Embedding | ModelType::Image | ModelType::Rerank => {
            Vec::new()
        }
    }
}

pub fn infer_model_type_and_capabilities(
    model_id: &str,
    display_name: &str,
) -> (ModelType, Vec<ModelCapability>) {
    let tokens = identifier_tokens(&format!("{model_id} {display_name}"));
    let has = |candidates: &[&str]| {
        candidates
            .iter()
            .any(|candidate| tokens.iter().any(|token| token == candidate))
    };
    let has_pair = |left: &str, right: &str| {
        tokens
            .windows(2)
            .any(|pair| pair[0] == left && pair[1] == right)
    };

    let model_type = if has(&["rerank", "reranker", "colbert"]) {
        ModelType::Rerank
    } else if has(&["embed", "embedding"]) {
        ModelType::Embedding
    } else if has(&["image", "imagen", "flux", "cogview", "kolors"])
        || has_pair("gpt", "image")
        || has_pair("dall", "e")
        || has_pair("grok", "imagine")
        || has_pair("stable", "diffusion")
    {
        ModelType::Image
    } else if has(&[
        "voice",
        "tts",
        "speech",
        "whisper",
        "transcribe",
        "transcription",
        "stt",
        "asr",
        "audio",
        "realtime",
    ]) {
        ModelType::Voice
    } else {
        ModelType::Chat
    };

    let mut capabilities = default_capabilities_for_model_type(&model_type);
    match model_type {
        ModelType::Chat => capabilities = infer_chat_capabilities(model_id, display_name),
        ModelType::Voice if has(&["realtime"]) => {
            capabilities.push(ModelCapability::RealtimeVoice);
        }
        _ => {}
    }
    (model_type, capabilities)
}

pub fn infer_chat_capabilities(model_id: &str, display_name: &str) -> Vec<ModelCapability> {
    let tokens = identifier_tokens(&format!("{model_id} {display_name}"));
    let has = |candidates: &[&str]| {
        candidates
            .iter()
            .any(|candidate| tokens.iter().any(|token| token == candidate))
    };
    let mut capabilities = vec![ModelCapability::TextChat];
    if has(&["vision", "vl", "multimodal"]) {
        capabilities.push(ModelCapability::Vision);
    }
    if has(&[
        "reason",
        "reasoner",
        "reasoning",
        "thinking",
        "think",
        "o1",
        "o3",
        "o4",
        "r1",
    ]) {
        capabilities.push(ModelCapability::Reasoning);
    }
    capabilities
}

fn identifier_tokens(value: &str) -> Vec<String> {
    value
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelParamOverrides {
    pub temperature: Option<f32>,
    /// Model-specific output token limit. This is only applied to normal chat
    /// requests when `force_max_tokens` is true, or when the model contract uses
    /// `max_completion_tokens`.
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    pub frequency_penalty: Option<f32>,
    /// When true, the provider adapter should send `max_completion_tokens`
    /// instead of `max_tokens` (required by OpenAI o-series models).
    pub use_max_completion_tokens: Option<bool>,
    /// When true, system messages are converted to user messages
    /// (for models that don't support the system role).
    pub no_system_role: Option<bool>,
    /// When true, omit temperature, top-p, and frequency penalty.
    #[serde(default)]
    pub omit_sampling_params: Option<bool>,
    /// When true, include the model-specific max_tokens in chat requests
    /// (falls back to 4096 if neither conversation nor model defaults are set).
    pub force_max_tokens: Option<bool>,
    /// Thinking parameter format for the provider API.
    /// "reasoning_effort" (default/OpenAI) or "enable_thinking" (SiliconFlow).
    pub thinking_param_style: Option<String>,
    /// Model-specific reasoning profile. When set, this overrides legacy
    /// thinking_param_style for reasoning payload serialization.
    pub reasoning_profile: Option<String>,
    /// Optional whitelist of reasoning option keys for this model.
    pub reasoning_options: Option<Vec<String>>,
    /// Optional default reasoning option key for this model.
    pub reasoning_default: Option<String>,
    /// Model-specific extra JSON body fields for OpenAI-compatible chat requests.
    pub extra_body: Option<serde_json::Map<String, serde_json::Value>>,
}
