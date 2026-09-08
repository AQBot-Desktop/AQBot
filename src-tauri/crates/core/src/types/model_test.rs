use serde::{Deserialize, Serialize};

use super::ModelType;

pub const MODEL_TEST_DEFAULT_PROMPT: &str = "Say 1";
pub const MODEL_TEST_MAX_PROMPT_CHARS: usize = 2000;
pub const MODEL_TEST_TIMEOUT_SECS: u64 = 120;
pub const MODEL_TEST_PREVIEW_CHARS: usize = 500;
pub const MODEL_TEST_ERROR_DETAIL_CHARS: usize = 2000;
pub const MODEL_TEST_EMBED_INPUT: &str = "AQBot model test";
pub const MODEL_TEST_RERANK_QUERY: &str = "AQBot model test";
pub const MODEL_TEST_RERANK_DOCUMENT: &str = "AQBot model test";

pub const MODEL_TEST_REASONING_LEVELS: &[&str] = &[
    "default", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTestKind {
    Chat,
    Embedding,
    Rerank,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTestStatus {
    Passed,
    Incomplete,
    Failed,
    Timeout,
    Cancelled,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelTestConfig {
    pub default_prompt: String,
    pub max_prompt_chars: u32,
    pub timeout_secs: u64,
    pub adapter_kinds: Vec<AdapterTestKinds>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterTestKinds {
    pub provider_type: String,
    pub kinds: Vec<ModelTestKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelTestResult {
    pub test_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub status: ModelTestStatus,
    pub first_text_ms: Option<u64>,
    pub total_ms: Option<u64>,
    pub checked_at: i64,
    pub response_preview: Option<String>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelTestProgressEvent {
    Registered { test_id: String },
    RequestStarted { test_id: String },
    FirstText { test_id: String, first_text_ms: u64 },
}

pub fn normalize_model_test_prompt(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed: String = raw.trim().chars().collect();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MODEL_TEST_MAX_PROMPT_CHARS {
        return Err(format!(
            "model test prompt exceeds {} characters",
            MODEL_TEST_MAX_PROMPT_CHARS
        ));
    }
    Ok(Some(trimmed))
}

pub fn effective_model_test_prompt(stored: Option<&str>) -> Result<String, String> {
    Ok(normalize_model_test_prompt(stored)?
        .unwrap_or_else(|| MODEL_TEST_DEFAULT_PROMPT.to_string()))
}

pub fn validate_reasoning_level(level: Option<&str>) -> Result<Option<String>, String> {
    let Some(level) = level.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if MODEL_TEST_REASONING_LEVELS.contains(&level) {
        return Ok(Some(level.to_string()));
    }
    Err(format!("unsupported reasoning level: {level}"))
}

pub fn truncate_chars(input: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (index, ch) in input.chars().enumerate() {
        if index >= max_chars {
            break;
        }
        out.push(ch);
    }
    out
}

pub fn test_kind_for_model_type(model_type: &ModelType) -> Option<ModelTestKind> {
    match model_type {
        ModelType::Chat => Some(ModelTestKind::Chat),
        ModelType::Embedding => Some(ModelTestKind::Embedding),
        ModelType::Rerank => Some(ModelTestKind::Rerank),
        ModelType::Image | ModelType::Voice => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_prompt_uses_official_default() {
        assert_eq!(normalize_model_test_prompt(Some("  \n")).unwrap(), None);
        assert_eq!(
            effective_model_test_prompt(None).unwrap(),
            "Say 1"
        );
    }

    #[test]
    fn prompt_rejects_overlong_unicode() {
        let overlong: String = "测".repeat(MODEL_TEST_MAX_PROMPT_CHARS + 1);
        assert!(normalize_model_test_prompt(Some(&overlong)).is_err());
    }

    #[test]
    fn reasoning_level_is_a_closed_set() {
        assert_eq!(
            validate_reasoning_level(Some("medium")).unwrap(),
            Some("medium".into())
        );
        assert!(validate_reasoning_level(Some("turbo")).is_err());
    }
}
