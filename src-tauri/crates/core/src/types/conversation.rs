use super::serde_helpers::deserialize_double_option;
use serde::{Deserialize, Serialize};

// === Conversation & Message ===

pub const MAX_COMPRESSION_KEEP_LAST_N: u32 = 1000;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MultiModelContinuationMode {
    #[default]
    Selected,
    PerModel,
}

impl MultiModelContinuationMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Selected => "selected",
            Self::PerModel => "per_model",
        }
    }
}

impl std::str::FromStr for MultiModelContinuationMode {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "selected" => Ok(Self::Selected),
            "per_model" => Ok(Self::PerModel),
            _ => Err(format!("unsupported multi-model continuation mode: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelTarget {
    pub provider_id: String,
    pub model_id: String,
}

pub fn validate_multi_model_targets(targets: &[MultiModelTarget]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for target in targets {
        if target.provider_id.trim().is_empty() || target.model_id.trim().is_empty() {
            return Err("multi_model_targets entries require providerId and modelId".to_string());
        }
        let key = format!("{}:{}", target.provider_id, target.model_id);
        if !seen.insert(key) {
            return Err(
                "multi_model_targets must not contain duplicate provider/model pairs".to_string(),
            );
        }
    }
    Ok(())
}

pub fn resolve_regenerate_version_index(
    existing_max: Option<i32>,
    companion: bool,
    target_version_index: Option<i32>,
) -> Result<i32, String> {
    if let Some(target_version_index) = target_version_index {
        if !companion {
            return Err("target_version_index is only allowed for companion regenerations".to_string());
        }
        if target_version_index <= 0 {
            return Err("target_version_index must be greater than 0".to_string());
        }
        return Ok(target_version_index);
    }
    Ok(existing_max.unwrap_or(-1) + 1)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MultiModelDisplayMode {
    Tabs,
    SideBySide,
    Stacked,
}

impl MultiModelDisplayMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tabs => "tabs",
            Self::SideBySide => "side-by-side",
            Self::Stacked => "stacked",
        }
    }
}

impl std::str::FromStr for MultiModelDisplayMode {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "tabs" => Ok(Self::Tabs),
            "side-by-side" => Ok(Self::SideBySide),
            "stacked" => Ok(Self::Stacked),
            _ => Err(format!("unsupported multi-model display mode: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextStrategy {
    SmartSummary,
    #[default]
    RawTruncate,
    RawStrict,
}

impl ContextStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SmartSummary => "smart_summary",
            Self::RawTruncate => "raw_truncate",
            Self::RawStrict => "raw_strict",
        }
    }
}

impl std::str::FromStr for ContextStrategy {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "smart_summary" => Ok(Self::SmartSummary),
            "raw_truncate" => Ok(Self::RawTruncate),
            "raw_strict" => Ok(Self::RawStrict),
            _ => Err(format!("unsupported context strategy: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub model_id: String,
    pub provider_id: String,
    pub system_prompt: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    pub frequency_penalty: Option<f32>,
    pub search_enabled: bool,
    pub search_provider_id: Option<String>,
    pub thinking_budget: Option<i64>,
    pub thinking_level: Option<String>,
    pub enabled_mcp_server_ids: Vec<String>,
    pub enabled_knowledge_base_ids: Vec<String>,
    pub enabled_memory_namespace_ids: Vec<String>,
    pub message_count: u32,
    pub is_pinned: bool,
    pub is_archived: bool,
    /// Legacy compatibility flag. New code should resolve
    /// `context_strategy_override` against `AppSettings::default_context_strategy`.
    pub context_compression: bool,
    /// `None` follows the global default context strategy.
    #[serde(default)]
    pub context_strategy_override: Option<ContextStrategy>,
    /// Per-conversation cap on history messages sent to the model.
    /// `None` falls back to global `default_context_count`. Values ≥ 50 mean unlimited.
    pub context_message_limit: Option<u32>,
    /// Keep the last N compressible messages out of compression.
    /// `None` uses the default (3). `Some(0)` keeps none (compress all eligible).
    pub compression_keep_last_n: Option<u32>,
    /// Per-conversation multi-model response layout override.
    /// `None` follows the global `AppSettings::multi_model_display_mode`.
    #[serde(default)]
    pub multi_model_display_mode_override: Option<MultiModelDisplayMode>,
    #[serde(default)]
    pub multi_model_targets: Vec<MultiModelTarget>,
    #[serde(default)]
    pub multi_model_continuation_mode: MultiModelContinuationMode,
    pub category_id: Option<String>,
    pub parent_conversation_id: Option<String>,
    pub sort_order: i32,
    pub mode: String,
    /// Null means the conversation is not pinned to the top tab bar.
    #[serde(default)]
    pub tab_pin_order: Option<i32>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: MessageRole,
    pub content: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub token_count: Option<u32>,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub attachments: Vec<Attachment>,
    pub thinking: Option<String>,
    pub created_at: i64,
    pub parent_message_id: Option<String>,
    pub version_index: i32,
    pub is_active: bool,
    pub tool_calls_json: Option<String>,
    pub tool_call_id: Option<String>,
    pub status: String,
    pub tokens_per_second: Option<f64>,
    pub first_token_latency_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationStats {
    pub total_messages: u64,
    pub total_user_messages: u64,
    pub total_assistant_messages: u64,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_tokens: u64,
    pub avg_tokens_per_second: Option<f64>,
    pub avg_first_token_latency_ms: Option<f64>,
    pub avg_response_time_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagePage {
    pub messages: Vec<Message>,
    pub has_older: bool,
    pub oldest_message_id: Option<String>,
    pub total_active_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageWindow {
    pub messages: Vec<Message>,
    pub has_older: bool,
    pub has_newer: bool,
    pub oldest_message_id: Option<String>,
    pub newest_message_id: Option<String>,
    pub total_active_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSummary {
    pub id: String,
    pub role: MessageRole,
    pub content_preview: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub created_at: i64,
    pub parent_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    #[serde(default)]
    pub id: String,
    pub file_type: String,
    pub file_name: String,
    #[serde(default)]
    pub file_path: String,
    pub file_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentInput {
    pub file_name: String,
    pub file_type: String,
    pub file_size: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSearchResult {
    pub conversation: Conversation,
    pub matched_message_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub conversation_id: String,
    pub summary_text: String,
    pub compressed_until_message_id: Option<String>,
    /// Compression input text (for viewing and retry). Absent on legacy rows.
    #[serde(default)]
    pub source_text: Option<String>,
    pub token_count: Option<u32>,
    pub model_used: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateConversationInput {
    pub title: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub is_pinned: Option<bool>,
    pub is_archived: Option<bool>,
    pub system_prompt: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub temperature: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub max_tokens: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub top_p: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub frequency_penalty: Option<Option<f64>>,
    pub search_enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub search_provider_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub thinking_budget: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub thinking_level: Option<Option<String>>,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub enabled_knowledge_base_ids: Option<Vec<String>>,
    pub enabled_memory_namespace_ids: Option<Vec<String>>,
    /// Legacy compatibility input. When present without a strategy override it
    /// is persisted as an explicit smart-summary/raw-truncate strategy.
    pub context_compression: Option<bool>,
    /// Set to `Some(None)` to clear the override and follow the global default.
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub context_strategy_override: Option<Option<ContextStrategy>>,
    /// Set to `Some(None)` to clear the override (use global default).
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub context_message_limit: Option<Option<i64>>,
    /// Set to `Some(None)` to clear and use the default keep-last-N (3).
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub compression_keep_last_n: Option<Option<i64>>,
    /// Set to `Some(None)` to clear the override and follow the global layout.
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub multi_model_display_mode_override: Option<Option<MultiModelDisplayMode>>,
    #[serde(default)]
    pub multi_model_targets: Option<Vec<MultiModelTarget>>,
    #[serde(default)]
    pub multi_model_continuation_mode: Option<MultiModelContinuationMode>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub category_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub parent_conversation_id: Option<Option<String>>,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationCategory {
    pub id: String,
    pub name: String,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub system_prompt: Option<String>,
    pub default_provider_id: Option<String>,
    pub default_model_id: Option<String>,
    pub default_temperature: Option<f64>,
    pub default_max_tokens: Option<i64>,
    pub default_top_p: Option<f64>,
    pub default_frequency_penalty: Option<f64>,
    pub sort_order: i32,
    pub is_collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversationCategoryInput {
    pub name: String,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub system_prompt: Option<String>,
    pub default_provider_id: Option<String>,
    pub default_model_id: Option<String>,
    pub default_temperature: Option<f64>,
    pub default_max_tokens: Option<i64>,
    pub default_top_p: Option<f64>,
    pub default_frequency_penalty: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateConversationCategoryInput {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub icon_type: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub icon_value: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub system_prompt: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub default_provider_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub default_model_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub default_temperature: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub default_max_tokens: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub default_top_p: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub default_frequency_penalty: Option<Option<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Role {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub opening_message: Option<String>,
    pub opening_questions: Vec<String>,
    pub tags: Vec<String>,
    pub avatar: Option<String>,
    pub avatar_type: Option<String>,
    pub avatar_value: Option<String>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    #[serde(default)]
    pub enabled_mcp_server_ids: Vec<String>,
    #[serde(default)]
    pub enabled_skill_names: Vec<String>,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRoleInput {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub opening_message: Option<String>,
    pub opening_questions: Vec<String>,
    pub tags: Vec<String>,
    pub avatar: Option<String>,
    pub avatar_type: Option<String>,
    pub avatar_value: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    #[serde(default)]
    pub enabled_mcp_server_ids: Vec<String>,
    #[serde(default)]
    pub enabled_skill_names: Vec<String>,
    pub source_kind: Option<String>,
    pub source_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateRoleInput {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub description: Option<Option<String>>,
    pub system_prompt: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub opening_message: Option<Option<String>>,
    pub opening_questions: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub avatar: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub avatar_type: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub avatar_value: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub temperature: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub top_p: Option<Option<f64>>,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub enabled_skill_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceRole {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub avatar: Option<String>,
    pub avatar_type: Option<String>,
    pub avatar_value: Option<String>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub source_kind: String,
    pub source_ref: String,
    pub marketplace_source: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleMarketplaceSource {
    pub id: String,
    pub name: String,
    pub default: bool,
}

#[cfg(test)]
mod tests {
    use super::MultiModelContinuationMode;

    #[test]
    fn multi_model_continuation_mode_uses_frontend_wire_values() {
        assert_eq!(
            serde_json::to_string(&MultiModelContinuationMode::Selected).unwrap(),
            r#""selected""#
        );
        assert_eq!(
            serde_json::from_str::<MultiModelContinuationMode>(r#""per_model""#).unwrap(),
            MultiModelContinuationMode::PerModel
        );
        assert_eq!(
            MultiModelContinuationMode::default(),
            MultiModelContinuationMode::Selected
        );
        assert_eq!(MultiModelContinuationMode::PerModel.as_str(), "per_model");
        assert_eq!(
            "selected".parse::<MultiModelContinuationMode>().unwrap(),
            MultiModelContinuationMode::Selected
        );
    }

    #[test]
    fn multi_model_targets_use_frontend_camel_case_wire_values() {
        let target: super::MultiModelTarget = serde_json::from_value(serde_json::json!({
            "providerId": "provider-a",
            "modelId": "model-a"
        }))
        .unwrap();
        assert_eq!(target.provider_id, "provider-a");
        assert_eq!(target.model_id, "model-a");
        assert_eq!(
            serde_json::to_value(&target).unwrap(),
            serde_json::json!({
                "providerId": "provider-a",
                "modelId": "model-a"
            })
        );
    }

    #[test]
    fn resolve_regenerate_version_index_uses_explicit_companion_slots_and_max_plus_one() {
        assert_eq!(
            super::resolve_regenerate_version_index(Some(2), true, Some(1)).unwrap(),
            1
        );
        assert_eq!(
            super::resolve_regenerate_version_index(Some(2), false, None).unwrap(),
            3
        );
        assert_eq!(
            super::resolve_regenerate_version_index(None, false, None).unwrap(),
            0
        );
        assert!(super::resolve_regenerate_version_index(Some(2), false, Some(1)).is_err());
        assert!(super::resolve_regenerate_version_index(Some(2), true, Some(0)).is_err());
        assert!(super::resolve_regenerate_version_index(Some(2), true, Some(-1)).is_err());
    }

    #[test]
    fn validate_multi_model_targets_rejects_empty_or_duplicate_ids() {
        assert!(super::validate_multi_model_targets(&[super::MultiModelTarget {
            provider_id: "provider-a".into(),
            model_id: "model-a".into(),
        }])
        .is_ok());
        assert!(super::validate_multi_model_targets(&[super::MultiModelTarget {
            provider_id: "".into(),
            model_id: "model-a".into(),
        }])
        .is_err());
        assert!(super::validate_multi_model_targets(&[
            super::MultiModelTarget {
                provider_id: "provider-a".into(),
                model_id: "model-a".into(),
            },
            super::MultiModelTarget {
                provider_id: "provider-a".into(),
                model_id: "model-a".into(),
            },
        ])
        .is_err());
    }
}
