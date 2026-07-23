use super::{ImageAdapterConfig, ImageAdapterRequest};
use aqbot_core::error::{AQBotError, Result};
use base64::Engine;
use serde_json::{Map, Value};

pub fn build_request_body(
    adapter_id: &str,
    request: &ImageAdapterRequest,
    config: &ImageAdapterConfig,
) -> Result<Value> {
    let mut body = match adapter_id {
        "openai_images" => openai_body(request),
        "xai_images" => xai_body(request),
        "glm_images" => glm_body(request),
        "siliconflow_images" => siliconflow_body(request),
        "gemini_images" => gemini_body(request),
        "generic_json" => generic_body(request, config)?,
        other => {
            return Err(AQBotError::Validation(format!(
                "Unknown image adapter: {other}"
            )))
        }
    };
    merge_extra_body(&mut body, &config.extra_body)?;
    Ok(body)
}

fn openai_body(request: &ImageAdapterRequest) -> Value {
    let mut body = base_body(request);
    insert_string(&mut body, "size", &request.size, "auto");
    insert_string(&mut body, "quality", &request.quality, "auto");
    insert_string(&mut body, "output_format", &request.output_format, "");
    insert_optional_string(&mut body, "background", request.background.as_deref());
    if let Some(value) = request.output_compression {
        body.insert("output_compression".into(), value.into());
    }
    Value::Object(body)
}

fn xai_body(request: &ImageAdapterRequest) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), request.model.clone().into());
    body.insert("prompt".into(), request.prompt.clone().into());
    if let Some(aspect_ratio) = request.parameters.get("aspect_ratio") {
        body.insert("aspect_ratio".into(), aspect_ratio.clone());
    }
    if !request.images.is_empty() {
        body.insert("image".into(), upload_data_url(&request.images[0]).into());
    }
    Value::Object(body)
}

fn glm_body(request: &ImageAdapterRequest) -> Value {
    let mut body = base_body(request);
    insert_string(&mut body, "size", &request.size, "auto");
    insert_string(&mut body, "quality", &request.quality, "auto");
    Value::Object(body)
}

fn siliconflow_body(request: &ImageAdapterRequest) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), request.model.clone().into());
    body.insert("prompt".into(), request.prompt.clone().into());
    insert_string(&mut body, "image_size", &request.size, "auto");
    body.insert("batch_size".into(), request.n.into());
    for (key, value) in &request.parameters {
        if key.starts_with("_aqbot_") {
            continue;
        }
        body.insert(key.clone(), value.clone());
    }
    Value::Object(body)
}

fn gemini_body(request: &ImageAdapterRequest) -> Value {
    let mut parts = vec![serde_json::json!({ "text": request.prompt })];
    parts.extend(request.images.iter().map(|image| {
        serde_json::json!({
            "inlineData": {
                "mimeType": image.mime_type,
                "data": base64::engine::general_purpose::STANDARD.encode(&image.bytes),
            }
        })
    }));
    let mut body = serde_json::json!({
        "contents": [{ "parts": parts }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] },
    });
    if let Some(aspect_ratio) = request.parameters.get("aspect_ratio") {
        body["generationConfig"]["imageConfig"]["aspectRatio"] = aspect_ratio.clone();
    }
    body
}

fn generic_body(request: &ImageAdapterRequest, config: &ImageAdapterConfig) -> Result<Value> {
    let values = semantic_values(request);
    let mut body = Value::Object(Map::new());
    let mappings = if config.mapping.request_fields.is_empty() {
        default_generic_mappings()
    } else {
        config.mapping.request_fields.clone()
    };
    for (semantic, target) in mappings {
        if let Some(value) = values.get(&semantic) {
            set_dotted_path(&mut body, &target, value.clone())?;
        }
    }
    Ok(body)
}

fn semantic_values(request: &ImageAdapterRequest) -> Map<String, Value> {
    let mut values = base_body(request);
    values.insert("size".into(), request.size.clone().into());
    values.insert("quality".into(), request.quality.clone().into());
    values.insert("output_format".into(), request.output_format.clone().into());
    if !request.images.is_empty() {
        values.insert(
            "images".into(),
            request
                .images
                .iter()
                .map(upload_data_url)
                .collect::<Vec<_>>()
                .into(),
        );
    }
    if let Some(mask) = &request.mask {
        values.insert("mask".into(), upload_data_url(mask).into());
    }
    values
}

fn base_body(request: &ImageAdapterRequest) -> Map<String, Value> {
    let mut body = Map::new();
    body.insert("model".into(), request.model.clone().into());
    body.insert("prompt".into(), request.prompt.clone().into());
    body.insert("n".into(), request.n.into());
    body
}

fn default_generic_mappings() -> std::collections::BTreeMap<String, String> {
    [
        "model",
        "prompt",
        "n",
        "size",
        "quality",
        "output_format",
        "images",
        "mask",
    ]
    .into_iter()
    .map(|key| (key.to_string(), key.to_string()))
    .collect()
}

fn set_dotted_path(root: &mut Value, path: &str, value: Value) -> Result<()> {
    let segments = path.split('.').collect::<Vec<_>>();
    if segments.is_empty() || segments.iter().any(|segment| segment.is_empty()) {
        return Err(AQBotError::Validation(format!(
            "Invalid generic image field mapping: {path}"
        )));
    }
    let mut current = root;
    for segment in &segments[..segments.len() - 1] {
        current = current
            .as_object_mut()
            .ok_or_else(|| AQBotError::Validation("Image mapping target is not an object".into()))?
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    current
        .as_object_mut()
        .ok_or_else(|| AQBotError::Validation("Image mapping target is not an object".into()))?
        .insert(segments[segments.len() - 1].to_string(), value);
    Ok(())
}

fn merge_extra_body(body: &mut Value, extra: &Map<String, Value>) -> Result<()> {
    let target = body
        .as_object_mut()
        .ok_or_else(|| AQBotError::Validation("Image request body must be an object".into()))?;
    target.extend(extra.clone());
    Ok(())
}

fn insert_string(body: &mut Map<String, Value>, key: &str, value: &str, omitted: &str) {
    if !value.is_empty() && value != omitted {
        body.insert(key.into(), value.into());
    }
}

fn insert_optional_string(body: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty() && *value != "auto") {
        body.insert(key.into(), value.into());
    }
}

fn upload_data_url(upload: &crate::openai_images::ImageUpload) -> String {
    format!(
        "data:{};base64,{}",
        upload.mime_type,
        base64::engine::general_purpose::STANDARD.encode(&upload.bytes)
    )
}
