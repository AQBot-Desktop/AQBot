use super::{ImageAdapterConfig, PendingImageSubmission};
use aqbot_core::error::{AQBotError, Result};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedImageSource {
    Base64(String),
    Url(String),
}

#[derive(Debug, Clone)]
pub struct ParsedImage {
    pub source: ParsedImageSource,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompletedResponsePayload {
    pub response_id: Option<String>,
    pub usage_json: Option<String>,
    pub images: Vec<ParsedImage>,
}

#[derive(Debug)]
pub enum ParsedResponsePayload {
    Completed(CompletedResponsePayload),
    Pending(PendingImageSubmission),
}

pub fn parse_response_payload(
    adapter_id: &str,
    value: &Value,
    config: &ImageAdapterConfig,
) -> Result<ParsedResponsePayload> {
    match adapter_id {
        "gemini_images" => completed(gemini_images(value), value),
        "siliconflow_images" => {
            completed(array_images(value, "/images", "/url", "/b64_json"), value)
        }
        "generic_json" => parse_generic(value, config),
        "openai_images" | "xai_images" | "glm_images" => {
            completed(array_images(value, "/data", "/url", "/b64_json"), value)
        }
        other => Err(AQBotError::Validation(format!(
            "Unknown image adapter: {other}"
        ))),
    }
}

fn parse_generic(value: &Value, config: &ImageAdapterConfig) -> Result<ParsedResponsePayload> {
    let mapping = &config.mapping;
    let status = mapping
        .status_path
        .as_deref()
        .and_then(|path| pointer_string(value, path));
    if status
        .as_ref()
        .is_some_and(|status| mapping.failure_statuses.iter().any(|item| item == status))
    {
        return Err(AQBotError::Provider(format!(
            "Image task failed with status {}",
            status.unwrap_or_default()
        )));
    }

    let images_path = mapping.images_path.as_deref().unwrap_or("/data");
    let url_path = mapping.image_url_path.as_deref().unwrap_or("/url");
    let base64_path = mapping.image_base64_path.as_deref().unwrap_or("/b64_json");
    let images = array_images(value, images_path, url_path, base64_path);
    let is_success = status
        .as_ref()
        .is_some_and(|status| mapping.success_statuses.iter().any(|item| item == status));
    if !images.is_empty() && (status.is_none() || is_success) {
        return completed(images, value);
    }

    let remote_task_id = mapping
        .task_id_path
        .as_deref()
        .and_then(|path| pointer_string(value, path));
    if let Some(remote_task_id) = remote_task_id {
        if status.as_ref().is_some_and(|status| {
            !mapping.pending_statuses.is_empty()
                && !mapping.pending_statuses.iter().any(|item| item == status)
        }) {
            return Err(AQBotError::Provider(format!(
                "Unknown image task status: {}",
                status.unwrap_or_default()
            )));
        }
        return Ok(ParsedResponsePayload::Pending(PendingImageSubmission {
            remote_task_id,
            remote_status: status,
            opaque_state: Some(value.clone()),
        }));
    }
    if let Some(status) = status {
        return Err(AQBotError::Provider(format!(
            "Unknown image task status: {status}"
        )));
    }
    Err(AQBotError::Provider(
        "Image response contained no images or task identifier".into(),
    ))
}

fn completed(images: Vec<ParsedImage>, value: &Value) -> Result<ParsedResponsePayload> {
    if images.is_empty() {
        return Err(AQBotError::Provider(
            "Image response contained no images".into(),
        ));
    }
    Ok(ParsedResponsePayload::Completed(CompletedResponsePayload {
        response_id: value.get("id").and_then(Value::as_str).map(str::to_string),
        usage_json: value.get("usage").map(Value::to_string),
        images,
    }))
}

fn array_images(
    value: &Value,
    images_path: &str,
    url_path: &str,
    base64_path: &str,
) -> Vec<ParsedImage> {
    value
        .pointer(images_path)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let source = pointer_string(item, base64_path)
                .map(ParsedImageSource::Base64)
                .or_else(|| pointer_string(item, url_path).map(ParsedImageSource::Url))?;
            let revised_prompt = item
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(ParsedImage {
                source,
                revised_prompt,
            })
        })
        .collect()
}

fn gemini_images(value: &Value) -> Vec<ParsedImage> {
    value
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|candidate| {
            candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|part| {
            let data = part
                .pointer("/inlineData/data")
                .or_else(|| part.pointer("/inline_data/data"))
                .and_then(Value::as_str)?;
            Some(ParsedImage {
                source: ParsedImageSource::Base64(data.to_string()),
                revised_prompt: None,
            })
        })
        .collect()
}

fn pointer_string(value: &Value, path: &str) -> Option<String> {
    value.pointer(path).and_then(|item| match item {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}
