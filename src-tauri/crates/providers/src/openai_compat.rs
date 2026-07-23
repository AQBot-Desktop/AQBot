use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use futures::StreamExt;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::pin::Pin;

use crate::reasoning::{resolve_reasoning, ReasoningStyle, ResolvedReasoning};
use crate::{
    build_http_client, resolve_chat_url, resolve_models_url, ProviderAdapter,
    ProviderRequestContext,
};

pub(crate) trait OpenAICompatPolicy: Clone + Send + Sync + 'static {
    fn default_base_url(&self) -> &'static str {
        "https://api.openai.com/v1"
    }

    fn error_label(&self) -> &'static str {
        "OpenAI API"
    }

    fn default_reasoning_style(&self, _request: &ChatRequest) -> ReasoningStyle {
        ReasoningStyle::OpenAIReasoningEffort
    }

    fn normalize_reasoning_effort(
        &self,
        _request: &ChatRequest,
        level: &str,
        effort: String,
    ) -> Option<String> {
        active_reasoning_level(level).then_some(effort)
    }

    fn use_max_completion_tokens(&self, request: &ChatRequest) -> bool {
        request.use_max_completion_tokens == Some(true)
            || request.model.starts_with("o1")
            || request.model.starts_with("o3")
            || request.model.starts_with("o4")
            || request.model.starts_with("gpt-5")
    }

    fn max_completion_tokens_cap(&self, _request: &ChatRequest) -> Option<u32> {
        None
    }

    fn suppress_sampling_params(&self, reasoning: Option<&ResolvedReasoning>) -> bool {
        reasoning.is_some_and(|r| active_reasoning_level(&r.level) && r.suppress_sampling_params)
    }

    fn extra_body_fields(&self, _reasoning: Option<&ResolvedReasoning>) -> Map<String, Value> {
        Map::new()
    }

    fn include_assistant_reasoning_content(
        &self,
        _messages: &[ChatMessage],
        _tools: &Option<Vec<ChatTool>>,
    ) -> bool {
        false
    }

    fn format_error(&self, status: reqwest::StatusCode, text: &str) -> String {
        format_openai_compat_error(self.error_label(), status, text)
    }
}

pub(crate) struct OpenAICompatAdapter<P> {
    client: reqwest::Client,
    policy: P,
}

impl<P> OpenAICompatAdapter<P>
where
    P: OpenAICompatPolicy,
{
    pub(crate) fn new(policy: P) -> Self {
        Self {
            client: crate::build_default_http_client()
                .expect("Failed to build default HTTP client"),
            policy,
        }
    }

    fn base_url(&self, ctx: &ProviderRequestContext) -> String {
        ctx.base_url
            .clone()
            .unwrap_or_else(|| self.policy.default_base_url().to_string())
    }

    fn chat_url(&self, ctx: &ProviderRequestContext) -> String {
        resolve_chat_url(
            &self.base_url(ctx),
            ctx.api_path.as_deref(),
            "/chat/completions",
        )
    }

    fn get_client(&self, ctx: &ProviderRequestContext) -> Result<reqwest::Client> {
        match &ctx.proxy_config {
            Some(c) if c.proxy_type.as_deref() != Some("none") => build_http_client(Some(c)),
            _ => Ok(self.client.clone()),
        }
    }
}

// --- Internal request/response types ---

#[derive(Serialize)]
struct OpenAIRequest {
    model: String,
    messages: Vec<OpenAIMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u32>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ChatTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

const RESERVED_EXTRA_BODY_FIELDS: &[&str] = &[
    "model",
    "messages",
    "stream",
    "stream_options",
    "tools",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
];

#[derive(Serialize)]
struct OpenAIMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIResponse {
    id: Option<String>,
    model: Option<String>,
    #[serde(default)]
    choices: Vec<OpenAIChoice>,
    usage: Option<OpenAIUsage>,
}

#[derive(Deserialize)]
struct OpenAIChoice {
    message: Option<OpenAIMessageResp>,
    delta: Option<OpenAIDelta>,
}

#[derive(Deserialize)]
struct OpenAIMessageResp {
    #[serde(default, deserialize_with = "deserialize_optional_text")]
    content: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_text")]
    reasoning_content: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_text")]
    reasoning: Option<String>,
    reasoning_details: Option<Vec<ReasoningDetail>>,
    tool_calls: Option<Vec<OpenAIToolCallDelta>>,
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct OpenAIDelta {
    #[serde(default, deserialize_with = "deserialize_optional_text")]
    content: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_text")]
    reasoning_content: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_text")]
    reasoning: Option<String>,
    reasoning_details: Option<Vec<ReasoningDetail>>,
    tool_calls: Option<Vec<OpenAIToolCallDelta>>,
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct ReasoningDetail {
    #[serde(default, deserialize_with = "deserialize_optional_text")]
    text: Option<String>,
}

/// Extract thinking text from delta/message fields.
/// Priority: reasoning_content > reasoning > reasoning_details[0].text
fn extract_thinking(
    reasoning_content: &Option<String>,
    reasoning: &Option<String>,
    reasoning_details: &Option<Vec<ReasoningDetail>>,
) -> Option<String> {
    if reasoning_content.is_some() {
        return reasoning_content.clone();
    }
    if reasoning.is_some() {
        return reasoning.clone();
    }
    reasoning_details
        .as_ref()
        .and_then(|details| details.first())
        .and_then(|d| d.text.clone())
}

fn deserialize_optional_text<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|raw| extract_text_from_json(&raw)))
}

fn deserialize_optional_json_string<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.map(|raw| match raw {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    }))
}

fn extract_text_from_json(value: &serde_json::Value) -> Option<String> {
    fn collect_text(value: &serde_json::Value, out: &mut String) {
        match value {
            serde_json::Value::String(text) => out.push_str(text),
            serde_json::Value::Array(items) => {
                for item in items {
                    collect_text(item, out);
                }
            }
            serde_json::Value::Object(map) => {
                for key in [
                    "text",
                    "content",
                    "delta",
                    "parts",
                    "part",
                    "value",
                    "output_text",
                ] {
                    if let Some(child) = map.get(key) {
                        let before = out.len();
                        collect_text(child, out);
                        if out.len() > before {
                            return;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut text = String::new();
    collect_text(value, &mut text);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn extract_primary_content(
    content: &Option<String>,
    extra: &std::collections::BTreeMap<String, serde_json::Value>,
) -> Option<String> {
    if content.is_some() {
        return content.clone();
    }

    for key in ["text", "part", "parts", "value", "output_text"] {
        if let Some(value) = extra.get(key) {
            if let Some(text) = extract_text_from_json(value) {
                return Some(text);
            }
        }
    }

    None
}

fn extract_gemini_compat_chunk(data: &str) -> Option<ChatStreamChunk> {
    let parsed = serde_json::from_str::<GeminiCompatChunk>(data).ok()?;
    let content = parsed
        .candidates
        .as_ref()
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.content.as_ref())
        .map(|content| {
            content
                .parts
                .iter()
                .filter_map(|part| part.text.as_ref())
                .cloned()
                .collect::<String>()
        })
        .filter(|text| !text.is_empty());

    let usage = parsed.usage_metadata.map(|usage| TokenUsage {
        prompt_tokens: usage.prompt_token_count.unwrap_or(0),
        completion_tokens: usage.candidates_token_count.unwrap_or(0),
        total_tokens: usage.total_token_count.unwrap_or(0),
    });

    if content.is_none() && usage.is_none() {
        return None;
    }

    Some(ChatStreamChunk {
        content,
        thinking: None,
        done: false,
        is_final: None,
        usage,
        tool_calls: None,
    })
}

#[derive(Deserialize)]
struct OpenAIUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: u32,
}

#[derive(Deserialize, Debug, Clone)]
struct OpenAIToolCallDelta {
    #[serde(default)]
    index: usize,
    id: Option<String>,
    #[serde(rename = "type")]
    call_type: Option<String>,
    function: Option<OpenAIToolCallFunctionDelta>,
}

#[derive(Deserialize, Debug, Clone)]
struct OpenAIToolCallFunctionDelta {
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_json_string")]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModel>,
}

// Wrapped format used by API gateways (OneAPI/NewAPI etc.): {"code":0,"data":{"data":[...]}}
#[derive(Deserialize)]
struct WrappedModelsResponse {
    data: OpenAIModelsResponse,
}

#[derive(Deserialize)]
struct OpenAIModel {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCompatChunk {
    candidates: Option<Vec<GeminiCompatCandidate>>,
    usage_metadata: Option<GeminiCompatUsageMetadata>,
}

#[derive(Deserialize)]
struct GeminiCompatCandidate {
    content: Option<GeminiCompatContent>,
}

#[derive(Deserialize)]
struct GeminiCompatContent {
    parts: Vec<GeminiCompatPart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCompatPart {
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCompatUsageMetadata {
    prompt_token_count: Option<u32>,
    candidates_token_count: Option<u32>,
    total_token_count: Option<u32>,
}

// --- Embedding types ---

#[derive(Serialize)]
struct OpenAIEmbedRequest {
    model: String,
    input: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<usize>,
}

#[derive(Deserialize)]
struct OpenAIEmbedResponse {
    data: Vec<OpenAIEmbedData>,
}

#[derive(Deserialize)]
struct OpenAIEmbedData {
    embedding: Vec<f32>,
}

fn extract_text_content(content: &ChatContent) -> String {
    match content {
        ChatContent::Text(text) => text.clone(),
        ChatContent::Multipart(parts) => parts
            .iter()
            .filter_map(|part| part.text.as_ref())
            .cloned()
            .collect::<Vec<String>>()
            .join(" "),
    }
}

fn is_valid_outbound_tool_call(tc: &ToolCall) -> bool {
    !tc.id.trim().is_empty()
        && !tc.call_type.trim().is_empty()
        && !tc.function.name.trim().is_empty()
}

fn serialize_tool_calls(tool_calls: Option<&[ToolCall]>) -> Option<Vec<serde_json::Value>> {
    let tool_calls = tool_calls?;
    if tool_calls.is_empty() || !tool_calls.iter().all(is_valid_outbound_tool_call) {
        return None;
    }

    Some(
        tool_calls
            .iter()
            .map(|tc| {
                serde_json::json!({
                    "id": tc.id,
                    "type": tc.call_type,
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments
                    }
                })
            })
            .collect(),
    )
}

fn local_tool_call_id(response_id: Option<&str>, index: usize) -> String {
    let prefix = response_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| {
            id.chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
                .take(48)
                .collect::<String>()
        })
        .filter(|id| !id.is_empty());

    match prefix {
        Some(prefix) => format!("call_aqbot_{prefix}_{index}"),
        None => format!("call_aqbot_{index}"),
    }
}

fn normalize_response_tool_call_id(id: Option<&str>, response_id: Option<&str>, index: usize) -> String {
    id.map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| local_tool_call_id(response_id, index))
}

fn normalize_response_tool_calls(
    tool_calls: &[OpenAIToolCallDelta],
    response_id: Option<&str>,
) -> Result<Vec<ToolCall>> {
    tool_calls
        .iter()
        .enumerate()
        .map(|(fallback_index, tc)| {
            let index = tc.index.max(fallback_index);
            let function = tc.function.as_ref().ok_or_else(|| {
                AQBotError::Provider("Tool call response missing function payload".into())
            })?;
            let name = function
                .name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| {
                    AQBotError::Provider("Tool call response missing function.name".into())
                })?;
            let call_type = tc
                .call_type
                .as_deref()
                .map(str::trim)
                .filter(|call_type| !call_type.is_empty())
                .unwrap_or("function");

            Ok(ToolCall {
                id: normalize_response_tool_call_id(tc.id.as_deref(), response_id, index),
                call_type: call_type.to_string(),
                function: ToolCallFunction {
                    name: name.to_string(),
                    arguments: function.arguments.clone().unwrap_or_default(),
                },
            })
        })
        .collect()
}

fn normalize_stream_tool_calls(
    pending_tool_calls: &[(String, String, String, String)],
) -> Result<Option<Vec<ToolCall>>> {
    if pending_tool_calls.is_empty() {
        return Ok(None);
    }

    let mut tool_calls = Vec::with_capacity(pending_tool_calls.len());
    for (index, (id, call_type, name, arguments)) in pending_tool_calls.iter().enumerate() {
        let name = name.trim();
        if name.is_empty() {
            return Err(AQBotError::Provider(
                "Tool call stream missing function.name".into(),
            ));
        }
        let call_type = call_type.trim();
        tool_calls.push(ToolCall {
            id: normalize_response_tool_call_id(Some(id), None, index),
            call_type: if call_type.is_empty() {
                "function".to_string()
            } else {
                call_type.to_string()
            },
            function: ToolCallFunction {
                name: name.to_string(),
                arguments: arguments.clone(),
            },
        });
    }

    Ok(Some(tool_calls))
}

fn merge_stream_tool_call_delta(
    pending_tool_calls: &mut Vec<(String, String, String, String)>,
    tc: &OpenAIToolCallDelta,
) {
    let idx = tc.index;
    while pending_tool_calls.len() <= idx {
        pending_tool_calls.push((
            String::new(),
            String::from("function"),
            String::new(),
            String::new(),
        ));
    }

    if let Some(id) = tc.id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        pending_tool_calls[idx].0 = id.to_string();
    }
    if let Some(call_type) = tc
        .call_type
        .as_deref()
        .map(str::trim)
        .filter(|call_type| !call_type.is_empty())
    {
        pending_tool_calls[idx].1 = call_type.to_string();
    }
    if let Some(function) = &tc.function {
        if let Some(name) = function
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            pending_tool_calls[idx].2 = name.to_string();
        }
        if let Some(args) = &function.arguments {
            pending_tool_calls[idx].3.push_str(args);
        }
    }
}

fn convert_messages(
    messages: &[ChatMessage],
    include_reasoning_content: bool,
) -> Vec<OpenAIMessage> {
    messages
        .iter()
        .map(|msg| {
            let serialized_tool_calls = if msg.role == "assistant" {
                serialize_tool_calls(msg.tool_calls.as_deref())
            } else {
                None
            };
            let include_reasoning = msg.role == "assistant"
                && include_reasoning_content
                && serialized_tool_calls.is_some();
            let reasoning_content = if include_reasoning {
                msg.reasoning_content.clone()
            } else {
                None
            };

            match msg.role.as_str() {
                "tool" => OpenAIMessage {
                    role: "tool".to_string(),
                    content: Some(serde_json::Value::String(extract_text_content(&msg.content))),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: msg.tool_call_id.clone(),
                },
                "assistant" if serialized_tool_calls.is_some() => {
                    let content_text = extract_text_content(&msg.content);
                    let content = if content_text.is_empty() {
                        None
                    } else {
                        Some(match &msg.content {
                            ChatContent::Text(text) => serde_json::Value::String(text.clone()),
                            ChatContent::Multipart(parts) => serde_json::Value::Array(
                                parts
                                    .iter()
                                    .map(|part| {
                                        let mut value = serde_json::Map::new();
                                        value.insert(
                                            "type".to_string(),
                                            serde_json::Value::String(part.r#type.clone()),
                                        );
                                        if let Some(text) = &part.text {
                                            value.insert("text".to_string(), serde_json::Value::String(text.clone()));
                                        }
                                        if let Some(image_url) = &part.image_url {
                                            value.insert(
                                                "image_url".to_string(),
                                                serde_json::to_value(image_url).unwrap_or(serde_json::Value::Null),
                                            );
                                        }
                                        serde_json::Value::Object(value)
                                    })
                                    .collect(),
                            ),
                        })
                    };
                    OpenAIMessage {
                        role: "assistant".to_string(),
                        content,
                        reasoning_content,
                        tool_calls: serialized_tool_calls,
                        tool_call_id: None,
                    }
                },
                _ => {
                    let content = match &msg.content {
                        ChatContent::Text(text) => serde_json::Value::String(text.clone()),
                        ChatContent::Multipart(parts) => serde_json::Value::Array(
                            parts
                                .iter()
                                .map(|part| {
                                    let mut value = serde_json::Map::new();
                                    value.insert(
                                        "type".to_string(),
                                        serde_json::Value::String(part.r#type.clone()),
                                    );
                                    if let Some(text) = &part.text {
                                        value.insert("text".to_string(), serde_json::Value::String(text.clone()));
                                    }
                                    if let Some(image_url) = &part.image_url {
                                        value.insert(
                                            "image_url".to_string(),
                                            serde_json::to_value(image_url).unwrap_or(serde_json::Value::Null),
                                        );
                                    }
                                    serde_json::Value::Object(value)
                                })
                                .collect(),
                        ),
                    };
                    OpenAIMessage {
                        role: msg.role.clone(),
                        content: Some(content),
                        reasoning_content,
                        tool_calls: None,
                        tool_call_id: None,
                    }
                }
            }
        })
        .collect()
}

fn active_reasoning_level(level: &str) -> bool {
    !matches!(level, "off" | "none")
}

fn normalized_max_completion_tokens<P: OpenAICompatPolicy>(
    policy: &P,
    request: &ChatRequest,
) -> Option<u32> {
    let requested = request.max_tokens.filter(|&v| v > 0)?;
    Some(match policy.max_completion_tokens_cap(request) {
        Some(cap) => requested.min(cap),
        None => requested,
    })
}

fn merge_model_extra_body(
    extra: &mut Map<String, Value>,
    custom: Option<&Map<String, Value>>,
) {
    let Some(custom) = custom else {
        return;
    };

    for (key, value) in custom {
        if RESERVED_EXTRA_BODY_FIELDS.contains(&key.as_str()) {
            continue;
        }
        extra.insert(key.clone(), value.clone());
    }
}

fn build_request<P: OpenAICompatPolicy>(
    policy: &P,
    request: &ChatRequest,
    messages: &[ChatMessage],
    stream: bool,
) -> OpenAIRequest {
    let default_style = policy.default_reasoning_style(request);
    let reasoning = resolve_reasoning(request, default_style);
    let suppress_sampling_params = policy.suppress_sampling_params(reasoning.as_ref());
    let reasoning_effort = reasoning.as_ref().and_then(|r| {
        let effort = r.reasoning_effort.clone()?;
        policy.normalize_reasoning_effort(request, &r.level, effort)
    });
    let mut extra = policy.extra_body_fields(reasoning.as_ref());
    merge_model_extra_body(&mut extra, request.extra_body.as_ref());

    // Use max_completion_tokens only when the model/request contract requires it.
    let use_completion_tokens = policy.use_max_completion_tokens(request);

    let (max_tokens, max_completion_tokens) = if use_completion_tokens {
        (None, normalized_max_completion_tokens(policy, request))
    } else {
        (request.max_tokens.filter(|&v| v > 0), None)
    };

    let include_reasoning_content =
        policy.include_assistant_reasoning_content(messages, &request.tools);

    OpenAIRequest {
        model: request.model.clone(),
        messages: convert_messages(messages, include_reasoning_content),
        temperature: if suppress_sampling_params {
            None
        } else {
            request.temperature
        },
        top_p: if suppress_sampling_params {
            None
        } else {
            request.top_p
        },
        max_tokens,
        max_completion_tokens,
        stream,
        stream_options: if stream {
            Some(StreamOptions {
                include_usage: true,
            })
        } else {
            None
        },
        tools: request.tools.clone(),
        reasoning_effort,
        extra,
    }
}

fn extract_error_message(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn format_openai_compat_error(
    error_label: &str,
    status: reqwest::StatusCode,
    text: &str,
) -> String {
    let upstream_message = extract_error_message(text).unwrap_or_else(|| text.to_string());
    if upstream_message.contains("max_completion_tokens is too large") {
        return format!(
            "{error_label} error {status}: The requested max_completion_tokens is too large. Lower the model Max Tokens parameter to the provider-supported value shown by upstream, or disable Use max_completion_tokens. Do not use the context window size as the output token limit. Upstream: {upstream_message}"
        );
    }

    format!("{error_label} error {status}: {text}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deepseek::DeepSeekPolicy;
    use crate::glm::GLMPolicy;
    use crate::openai::OpenAIPolicy;
    use crate::siliconflow::SiliconFlowPolicy;
    use crate::xai::XAIPolicy;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn base_chat_request(model: &str) -> ChatRequest {
        ChatRequest {
            model: model.to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hi".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: true,
            temperature: Some(0.7),
            top_p: Some(1.0),
            max_tokens: Some(300_000),
            tools: None,
            thinking_budget: None,
            thinking_level: None,
            reasoning_profile: None,
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        }
    }

    fn dummy_tool() -> ChatTool {
        ChatTool {
            r#type: "function".to_string(),
            function: ChatToolFunction {
                name: "write_file".to_string(),
                description: Some("Write a file".to_string()),
                parameters: Some(json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    }
                })),
            },
        }
    }

    async fn spawn_models_response() -> (std::net::SocketAddr, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let addr = listener.local_addr().expect("server addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            loop {
                let read = socket.read(&mut buffer).await.expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let body = r#"{"data":[{"id":"gpt-test"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write response");

            String::from_utf8_lossy(&request).into_owned()
        });
        (addr, server)
    }

    #[test]
    fn convert_messages_omits_null_fields_for_openai_compatible_requests() {
        let messages = convert_messages(
            &[ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Multipart(vec![
                    ContentPart {
                        r#type: "text".to_string(),
                        text: Some("Describe this image".to_string()),
                        image_url: None,
                    },
                    ContentPart {
                        r#type: "image_url".to_string(),
                        text: None,
                        image_url: Some(ImageUrl {
                            url: "data:image/png;base64,YWJj".to_string(),
                        }),
                    },
                ]),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            }],
            false,
        );

        assert_eq!(
            messages[0].content,
            Some(json!([
                { "type": "text", "text": "Describe this image" },
                {
                    "type": "image_url",
                    "image_url": { "url": "data:image/png;base64,YWJj" }
                }
            ]))
        );
    }

    #[tokio::test]
    async fn list_models_uses_resolved_base_models_url() {
        let (addr, server) = spawn_models_response().await;
        let base_url =
            crate::resolve_base_url_for_type(&format!("http://{}", addr), &ProviderType::OpenAI);
        let ctx = ProviderRequestContext {
            api_key: "sk-test".to_string(),
            key_id: "key-1".to_string(),
            provider_id: "provider-1".to_string(),
            base_url: Some(base_url),
            api_path: Some("/v1/chat/completions".to_string()),
            proxy_config: None,
            custom_headers: None,
        };
        let adapter = OpenAICompatAdapter::new(OpenAIPolicy);

        let models = adapter.list_models(&ctx).await.expect("list models");
        let request = server.await.expect("server request");

        assert_eq!(models[0].model_id, "gpt-test");
        assert!(request.starts_with("GET /v1/models HTTP/1.1"), "{request}");
    }

    #[test]
    fn deepseek_thinking_keeps_max_tokens_when_completion_tokens_not_enabled() {
        let mut request = base_chat_request("deepseek-v4");
        request.thinking_level = Some("high".to_string());
        request.use_max_completion_tokens = Some(false);

        let body = build_request(&DeepSeekPolicy, &request, &request.messages, true);

        assert_eq!(body.max_tokens, Some(300_000));
        assert_eq!(body.max_completion_tokens, None);
        assert_eq!(body.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(body.temperature, None);
        assert_eq!(body.top_p, None);
    }

    #[test]
    fn deepseek_normalizes_reasoning_effort_to_supported_levels() {
        let cases = [
            ("low", Some("high")),
            ("medium", Some("high")),
            ("high", Some("high")),
            ("xhigh", Some("max")),
            ("max", Some("max")),
            ("none", None),
        ];

        for (level, expected) in cases {
            let mut request = base_chat_request("deepseek-v4-flash");
            request.thinking_level = Some(level.to_string());

            let body = build_request(&DeepSeekPolicy, &request, &request.messages, true);

            assert_eq!(
                body.reasoning_effort.as_deref(),
                expected,
                "thinking_level={level}"
            );
        }
    }

    #[test]
    fn deepseek_none_omits_reasoning_effort_and_keeps_sampling_params() {
        let mut request = base_chat_request("deepseek-v4-flash");
        request.thinking_level = Some("none".to_string());

        let body = build_request(&DeepSeekPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized.get("reasoning_effort").is_none());
        assert_eq!(serialized["thinking"], json!({ "type": "disabled" }));
        assert_eq!(serialized["max_tokens"], json!(300_000));
        assert!(serialized.get("max_completion_tokens").is_none());
        assert_eq!(serialized["temperature"], json!(0.7));
        assert_eq!(serialized["top_p"], json!(1.0));
    }

    #[test]
    fn explicit_completion_tokens_override_still_uses_max_completion_tokens() {
        let mut request = base_chat_request("gpt-4o");
        request.use_max_completion_tokens = Some(true);

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);

        assert_eq!(body.max_tokens, None);
        assert_eq!(body.max_completion_tokens, Some(300_000));
    }

    #[test]
    fn openai_provider_deepseek_v4_clamps_oversized_completion_tokens() {
        let mut request = base_chat_request("deepseek-ai/deepseek-v4-pro");
        request.use_max_completion_tokens = Some(true);

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);

        assert_eq!(body.max_tokens, None);
        assert_eq!(body.max_completion_tokens, Some(262_144));
    }

    #[test]
    fn oversized_completion_token_error_is_actionable() {
        let message = OpenAIPolicy.format_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"max_completion_tokens is too large: 300000.This model supports at most 262144 completion tokens.","type":"BadRequestError","param":"","code":400}}"#,
        );

        assert!(message.contains("max_completion_tokens is too large"));
        assert!(message.contains("Max Tokens"));
        assert!(message.contains("Use max_completion_tokens"));
        assert!(message.contains("262144"));
    }

    #[test]
    fn openai_reasoning_models_still_use_max_completion_tokens() {
        let request = base_chat_request("o3-mini");

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);

        assert_eq!(body.max_tokens, None);
        assert_eq!(body.max_completion_tokens, Some(300_000));
    }

    #[test]
    fn openai_policy_ignores_nonofficial_thinking_param_style_body_fields() {
        let mut request = base_chat_request("gpt-4o");
        request.thinking_level = Some("high".to_string());
        request.thinking_param_style = Some("enable_thinking".to_string());

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(serialized["reasoning_effort"], json!("high"));
        assert!(serialized.get("enable_thinking").is_none());
        assert!(serialized.get("thinking_budget").is_none());
        assert!(serialized.get("thinking").is_none());
    }

    #[test]
    fn openai_policy_ignores_nonofficial_reasoning_profile_body_fields() {
        let mut request = base_chat_request("gpt-4o");
        request.thinking_level = Some("high".to_string());
        request.reasoning_profile = Some("enable_thinking".to_string());

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized.get("reasoning_effort").is_none());
        assert!(serialized.get("enable_thinking").is_none());
        assert!(serialized.get("thinking_budget").is_none());
        assert!(serialized.get("thinking").is_none());
        assert_eq!(serialized["temperature"], json!(0.7));
        assert_eq!(serialized["top_p"], json!(1.0));
    }

    #[test]
    fn deepseek_plain_assistant_reasoning_content_is_not_replayed() {
        let assistant: ChatMessage = serde_json::from_value(json!({
            "role": "assistant",
            "content": "final answer",
            "reasoning_content": "hidden thinking"
        }))
        .expect("chat message");
        let mut request = base_chat_request("deepseek-v4");
        request.thinking_level = Some("high".to_string());
        request.tools = Some(vec![dummy_tool()]);
        request.messages = vec![assistant];

        let body = build_request(&DeepSeekPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized["messages"][0].get("reasoning_content").is_none());
        assert!(serialized["messages"][0].get("tool_calls").is_none());
    }

    #[test]
    fn deepseek_tool_call_serializes_reasoning_content_without_explicit_thinking_level() {
        let assistant = ChatMessage {
            role: "assistant".to_string(),
            content: ChatContent::Text(String::new()),
            reasoning_content: Some("hidden thinking".to_string()),
            tool_calls: Some(vec![aqbot_core::types::ToolCall {
                id: "call-1".to_string(),
                call_type: "function".to_string(),
                function: aqbot_core::types::ToolCallFunction {
                    name: "write_file".to_string(),
                    arguments: "{\"path\":\"index.html\"}".to_string(),
                },
            }]),
            tool_call_id: None,
        };
        let mut request = base_chat_request("deepseek-v4-flash");
        request.tools = Some(vec![dummy_tool()]);
        request.messages = vec![assistant];

        let body = build_request(&DeepSeekPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(
            serialized["messages"][0]["reasoning_content"],
            json!("hidden thinking")
        );
        assert_eq!(serialized["messages"][0]["tool_calls"][0]["id"], json!("call-1"));
    }

    #[test]
    fn deepseek_malformed_tool_call_does_not_replay_tool_calls_or_reasoning() {
        let assistant = ChatMessage {
            role: "assistant".to_string(),
            content: ChatContent::Text("visible answer".to_string()),
            reasoning_content: Some("hidden thinking".to_string()),
            tool_calls: Some(vec![aqbot_core::types::ToolCall {
                id: String::new(),
                call_type: "function".to_string(),
                function: aqbot_core::types::ToolCallFunction {
                    name: "write_file".to_string(),
                    arguments: "{\"path\":\"index.html\"}".to_string(),
                },
            }]),
            tool_call_id: None,
        };
        let mut request = base_chat_request("deepseek-v4-pro");
        request.tools = Some(vec![dummy_tool()]);
        request.messages = vec![assistant];

        let body = build_request(&DeepSeekPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(serialized["messages"][0]["content"], json!("visible answer"));
        assert!(serialized["messages"][0].get("reasoning_content").is_none());
        assert!(serialized["messages"][0].get("tool_calls").is_none());
    }

    #[test]
    fn stream_tool_call_delta_missing_id_gets_local_id() {
        let tool_calls = normalize_stream_tool_calls(&[(
            String::new(),
            "function".into(),
            "read_file".into(),
            "{\"path\":\"a.txt\"}".into(),
        )])
        .unwrap()
        .unwrap();

        assert_eq!(tool_calls[0].id, "call_aqbot_0");
        assert_eq!(tool_calls[0].function.name, "read_file");
    }

    #[test]
    fn stream_tool_call_delta_keeps_metadata_when_later_chunks_are_empty() {
        let chunks: Vec<OpenAIToolCallDelta> = vec![
            serde_json::from_value(json!({
                "index": 0,
                "id": "call-1",
                "type": "function",
                "function": {
                    "name": "read_file",
                    "arguments": "{\"path\":"
                }
            }))
            .expect("initial tool call delta"),
            serde_json::from_value(json!({
                "index": 0,
                "id": "",
                "type": "",
                "function": {
                    "name": "",
                    "arguments": "\"a.txt\"}"
                }
            }))
            .expect("arguments delta"),
        ];
        let mut pending_tool_calls = Vec::new();

        for chunk in chunks {
            merge_stream_tool_call_delta(&mut pending_tool_calls, &chunk);
        }
        let tool_calls = normalize_stream_tool_calls(&pending_tool_calls)
            .unwrap()
            .unwrap();

        assert_eq!(tool_calls[0].id, "call-1");
        assert_eq!(tool_calls[0].call_type, "function");
        assert_eq!(tool_calls[0].function.name, "read_file");
        assert_eq!(tool_calls[0].function.arguments, "{\"path\":\"a.txt\"}");
    }

    #[test]
    fn response_tool_call_missing_id_gets_response_scoped_local_id() {
        let response: OpenAIResponse = serde_json::from_value(json!({
            "id": "resp-abc",
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{}"
                        }
                    }]
                }
            }]
        }))
        .expect("response");
        let message = response.choices[0].message.as_ref().unwrap();

        let tool_calls =
            normalize_response_tool_calls(message.tool_calls.as_ref().unwrap(), response.id.as_deref())
                .unwrap();

        assert_eq!(tool_calls[0].id, "call_aqbot_resp-abc_0");
        assert_eq!(tool_calls[0].function.name, "read_file");
    }

    #[test]
    fn stream_tool_call_delta_missing_name_returns_local_error() {
        let err = normalize_stream_tool_calls(&[(
            String::new(),
            "function".into(),
            String::new(),
            "{}".into(),
        )])
        .unwrap_err();

        assert!(err.to_string().contains("function.name"));
    }

    #[test]
    fn deepseek_without_tools_does_not_replay_reasoning_content() {
        let assistant: ChatMessage = serde_json::from_value(json!({
            "role": "assistant",
            "content": "final answer",
            "reasoning_content": "hidden thinking"
        }))
        .expect("chat message");
        let mut request = base_chat_request("deepseek-v4-flash");
        request.messages = vec![assistant];

        let body = build_request(&DeepSeekPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized["messages"][0].get("reasoning_content").is_none());
    }

    #[test]
    fn non_deepseek_models_do_not_serialize_assistant_reasoning_content() {
        let assistant: ChatMessage = serde_json::from_value(json!({
            "role": "assistant",
            "content": "final answer",
            "reasoning_content": "hidden thinking"
        }))
        .expect("chat message");
        let mut request = base_chat_request("gpt-4o");
        request.thinking_level = Some("high".to_string());
        request.messages = vec![assistant];

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized["messages"][0].get("reasoning_content").is_none());
    }

    #[test]
    fn openai_adapter_does_not_apply_deepseek_reasoning_policy_by_model_name() {
        let assistant: ChatMessage = serde_json::from_value(json!({
            "role": "assistant",
            "content": "final answer",
            "reasoning_content": "hidden thinking"
        }))
        .expect("chat message");
        let mut request = base_chat_request("deepseek-v4");
        request.thinking_level = Some("high".to_string());
        request.messages = vec![assistant];

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized["messages"][0].get("reasoning_content").is_none());
    }

    #[test]
    fn xai_omits_reasoning_request_fields() {
        let mut request = base_chat_request("grok-3-mini");
        request.thinking_level = Some("high".to_string());

        let body = build_request(&XAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized.get("reasoning_effort").is_none());
        assert!(serialized.get("enable_thinking").is_none());
        assert!(serialized.get("thinking_budget").is_none());
        assert!(serialized.get("max_tokens").is_none());
        assert_eq!(serialized["max_completion_tokens"], json!(300_000));
        assert_eq!(serialized["temperature"], json!(0.7));
        assert_eq!(serialized["top_p"], json!(1.0));
    }

    #[test]
    fn xai_ignores_stale_openai_reasoning_profile_without_suppressing_sampling() {
        let mut request = base_chat_request("grok-3-mini");
        request.thinking_level = Some("high".to_string());
        request.reasoning_profile = Some("openai_reasoning_effort".to_string());

        let body = build_request(&XAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized.get("reasoning_effort").is_none());
        assert_eq!(serialized["temperature"], json!(0.7));
        assert_eq!(serialized["top_p"], json!(1.0));
    }

    #[test]
    fn xai_grok_43_sends_supported_reasoning_effort() {
        let mut request = base_chat_request("grok-4.3");
        request.thinking_level = Some("medium".to_string());

        let body = build_request(&XAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(serialized["reasoning_effort"], json!("medium"));
    }

    #[test]
    fn glm_uses_thinking_object_without_openai_reasoning_fields() {
        let mut request = base_chat_request("glm-4.6");
        request.thinking_level = Some("high".to_string());

        let body = build_request(&GLMPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(
            serialized["thinking"],
            json!({ "type": "enabled", "clear_thinking": true })
        );
        assert!(serialized.get("reasoning_effort").is_none());
        assert!(serialized.get("enable_thinking").is_none());
        assert!(serialized.get("max_completion_tokens").is_none());
        assert_eq!(serialized["max_tokens"], json!(300_000));
        assert!(serialized.get("temperature").is_none());
        assert!(serialized.get("top_p").is_none());
    }

    #[test]
    fn glm_none_disables_thinking_object_and_keeps_sampling_params() {
        let mut request = base_chat_request("glm-4.6");
        request.thinking_level = Some("none".to_string());

        let body = build_request(&GLMPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(
            serialized["thinking"],
            json!({ "type": "disabled", "clear_thinking": true })
        );
        assert_eq!(serialized["temperature"], json!(0.7));
        assert_eq!(serialized["top_p"], json!(1.0));
    }

    #[test]
    fn siliconflow_uses_enable_thinking_and_budget_only() {
        let mut request = base_chat_request("Qwen/Qwen3-235B-A22B");
        request.thinking_level = Some("high".to_string());

        let body = build_request(&SiliconFlowPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(serialized["enable_thinking"], json!(true));
        assert_eq!(serialized["thinking_budget"], json!(8192));
        assert!(serialized.get("reasoning_effort").is_none());
        assert!(serialized.get("max_completion_tokens").is_none());
        assert_eq!(serialized["max_tokens"], json!(300_000));
        assert!(serialized.get("temperature").is_none());
        assert!(serialized.get("top_p").is_none());
    }

    #[test]
    fn openai_compat_flattens_model_extra_body_fields() {
        let mut request = base_chat_request("gpt-4o");
        request.extra_body = Some(
            serde_json::json!({
                "enable_thinking": true,
                "vendor_options": {
                    "trace": "enabled"
                }
            })
            .as_object()
            .expect("object")
            .clone(),
        );

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(serialized["enable_thinking"], json!(true));
        assert_eq!(serialized["vendor_options"]["trace"], json!("enabled"));
        assert!(serialized.get("extra_body").is_none());
    }

    #[test]
    fn openai_compat_extra_body_cannot_override_core_fields() {
        let mut request = base_chat_request("gpt-4o");
        request.extra_body = Some(
            serde_json::json!({
                "model": "other-model",
                "stream": false,
                "max_tokens": 1,
                "enable_thinking": true
            })
            .as_object()
            .expect("object")
            .clone(),
        );

        let body = build_request(&OpenAIPolicy, &request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(serialized["model"], json!("gpt-4o"));
        assert_eq!(serialized["stream"], json!(true));
        assert_eq!(serialized["max_tokens"], json!(300_000));
        assert_eq!(serialized["enable_thinking"], json!(true));
    }
}

#[async_trait]
impl<P> ProviderAdapter for OpenAICompatAdapter<P>
where
    P: OpenAICompatPolicy,
{
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse> {
        let url = self.chat_url(ctx);
        let body = build_request(&self.policy, &request, &request.messages, false);

        let resp = crate::apply_request_headers(
            self.get_client(ctx)?
                .post(&url)
                .header("Authorization", format!("Bearer {}", ctx.api_key))
                .json(&body),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(
                self.policy.format_error(status, &text),
            ));
        }

        let oai: OpenAIResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        let choice = oai
            .choices
            .first()
            .ok_or_else(|| AQBotError::Provider("No choices in response".into()))?;
        let msg = choice
            .message
            .as_ref()
            .ok_or_else(|| AQBotError::Provider("No message in choice".into()))?;

        let usage = oai
            .usage
            .map(|u| TokenUsage {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
                total_tokens: u.total_tokens,
            })
            .unwrap_or(TokenUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            });

        let response_id = oai.id.clone();
        let tool_calls = msg
            .tool_calls
            .as_ref()
            .map(|tcs| normalize_response_tool_calls(tcs, response_id.as_deref()))
            .transpose()?;

        Ok(ChatResponse {
            id: response_id.unwrap_or_default(),
            model: oai.model.unwrap_or_else(|| request.model.clone()),
            content: extract_primary_content(&msg.content, &msg.extra).unwrap_or_default(),
            thinking: extract_thinking(
                &msg.reasoning_content,
                &msg.reasoning,
                &msg.reasoning_details,
            ),
            usage,
            tool_calls,
        })
    }

    fn chat_stream(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>> {
        let client = self.get_client(ctx).unwrap_or_else(|_| self.client.clone());
        let api_key = ctx.api_key.clone();
        let custom_headers = ctx.custom_headers.clone();
        let url = self.chat_url(ctx);
        let body = build_request(&self.policy, &request, &request.messages, true);
        let policy = self.policy.clone();

        let (tx, rx) = futures::channel::mpsc::unbounded();

        tokio::spawn(async move {
            let resp = match crate::apply_stream_headers_to_request(
                client
                    .post(&url)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .json(&body),
                &custom_headers,
            )
            .send()
            .await
            {
                Ok(r) if r.status().is_success() => r,
                Ok(r) => {
                    let s = r.status();
                    let t = r.text().await.unwrap_or_default();
                    let _ =
                        tx.unbounded_send(Err(AQBotError::Provider(policy.format_error(s, &t))));
                    return;
                }
                Err(e) => {
                    let _ = tx
                        .unbounded_send(Err(AQBotError::Provider(format!("Request failed: {e}"))));
                    return;
                }
            };

            let mut byte_stream = resp.bytes_stream();
            let mut buf = String::new();
            let mut pending_tool_calls: Vec<(String, String, String, String)> = Vec::new();
            let mut event_data_lines: Vec<String> = Vec::new();
            // (id, type, name, arguments) — indexed by position

            let mut process_event = |data: &str| -> bool {
                if data.trim() == "[DONE]" {
                    let tool_calls = match normalize_stream_tool_calls(&pending_tool_calls) {
                        Ok(tool_calls) => tool_calls,
                        Err(err) => {
                            let _ = tx.unbounded_send(Err(err));
                            return true;
                        }
                    };
                    let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                        content: None,
                        thinking: None,
                        done: true,
                        is_final: None,
                        usage: None,
                        tool_calls,
                    }));
                    return true;
                }

                let parsed = match serde_json::from_str::<OpenAIResponse>(data) {
                    Ok(value) => value,
                    Err(_) => return false,
                };

                if let Some(choice) = parsed.choices.first() {
                    let tool_call_deltas = choice
                        .delta
                        .as_ref()
                        .and_then(|delta| delta.tool_calls.as_ref())
                        .or_else(|| {
                            choice
                                .message
                                .as_ref()
                                .and_then(|message| message.tool_calls.as_ref())
                    });
                    if let Some(tc_deltas) = tool_call_deltas {
                        for tc in tc_deltas {
                            merge_stream_tool_call_delta(&mut pending_tool_calls, tc);
                        }
                    }

                    let usage = parsed.usage.map(|u| TokenUsage {
                        prompt_tokens: u.prompt_tokens,
                        completion_tokens: u.completion_tokens,
                        total_tokens: u.total_tokens,
                    });
                    let content = choice
                        .delta
                        .as_ref()
                        .and_then(|delta| extract_primary_content(&delta.content, &delta.extra))
                        .or_else(|| {
                            choice.message.as_ref().and_then(|message| {
                                extract_primary_content(&message.content, &message.extra)
                            })
                        });
                    let thinking = choice
                        .delta
                        .as_ref()
                        .and_then(|delta| {
                            extract_thinking(
                                &delta.reasoning_content,
                                &delta.reasoning,
                                &delta.reasoning_details,
                            )
                        })
                        .or_else(|| {
                            choice.message.as_ref().and_then(|message| {
                                extract_thinking(
                                    &message.reasoning_content,
                                    &message.reasoning,
                                    &message.reasoning_details,
                                )
                            })
                        });

                    if content.is_some() || thinking.is_some() || usage.is_some() {
                        let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                            content,
                            thinking,
                            done: false,
                            is_final: None,
                            usage,
                            tool_calls: None,
                        }));
                    }
                    return false;
                }

                if let Some(u) = parsed.usage {
                    let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                        content: None,
                        thinking: None,
                        done: false,
                        is_final: None,
                        usage: Some(TokenUsage {
                            prompt_tokens: u.prompt_tokens,
                            completion_tokens: u.completion_tokens,
                            total_tokens: u.total_tokens,
                        }),
                        tool_calls: None,
                    }));
                }

                if let Some(chunk) = extract_gemini_compat_chunk(data) {
                    let _ = tx.unbounded_send(Ok(chunk));
                }

                false
            };

            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end_matches('\r').to_string();
                            buf = buf[pos + 1..].to_string();

                            if line.is_empty() {
                                if event_data_lines.is_empty() {
                                    continue;
                                }
                                let data = event_data_lines.join("\n");
                                event_data_lines.clear();
                                if process_event(&data) {
                                    return;
                                }
                                continue;
                            }

                            if line.starts_with(':') {
                                continue;
                            }

                            if let Some(d) = line.strip_prefix("data: ") {
                                event_data_lines.push(d.to_string());
                            } else if let Some(d) = line.strip_prefix("data:") {
                                event_data_lines.push(d.to_string());
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.unbounded_send(Err(AQBotError::Provider(format!(
                            "Stream error: {e}"
                        ))));
                        return;
                    }
                }
            }

            let trailing_line = buf.trim_end_matches('\r');
            if let Some(d) = trailing_line.strip_prefix("data: ") {
                event_data_lines.push(d.to_string());
            } else if let Some(d) = trailing_line.strip_prefix("data:") {
                event_data_lines.push(d.to_string());
            }

            if !event_data_lines.is_empty() {
                let data = event_data_lines.join("\n");
                if process_event(&data) {
                    return;
                }
            }

            // Stream ended without explicit [DONE]
            let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                content: None,
                thinking: None,
                done: true,
                is_final: None,
                usage: None,
                tool_calls: None,
            }));
        });

        Box::pin(rx)
    }

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>> {
        let url = resolve_models_url(&self.base_url(ctx));

        let resp = crate::apply_request_headers(
            self.get_client(ctx)?
                .get(&url)
                .header("Authorization", format!("Bearer {}", ctx.api_key)),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "{} error {s}: {t}",
                self.policy.error_label()
            )));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| AQBotError::Provider(format!("Read error: {e}")))?;

        let convert = |models: Vec<OpenAIModel>| -> Vec<Model> {
            models
                .into_iter()
                .map(|m| {
                    let model_type = ModelType::detect(&m.id);
                    let mut caps = match model_type {
                        ModelType::Chat => vec![ModelCapability::TextChat],
                        ModelType::Embedding => vec![],
                        ModelType::Image => vec![],
                        ModelType::Rerank => vec![],
                        ModelType::Voice => vec![ModelCapability::RealtimeVoice],
                    };
                    let id_lower = m.id.to_lowercase();
                    if id_lower.contains("gpt-4o")
                        || id_lower.contains("gpt-4-turbo")
                        || id_lower.contains("claude")
                        || id_lower.contains("vision")
                    {
                        caps.push(ModelCapability::Vision);
                    }
                    if id_lower.starts_with("o1")
                        || id_lower.starts_with("o3")
                        || id_lower.starts_with("o4")
                    {
                        caps.push(ModelCapability::Reasoning);
                    }
                    Model {
                        provider_id: ctx.provider_id.clone(),
                        model_id: m.id.clone(),
                        name: m.id,
                        group_name: None,
                        model_type,
                        capabilities: caps,
                        max_tokens: None,
                        enabled: true,
                        param_overrides: None,
                        image_config: None,
                    }
                })
                .collect()
        };

        // Try standard OpenAI format: {"data": [...]}
        if let Ok(r) = serde_json::from_str::<OpenAIModelsResponse>(&body) {
            return Ok(convert(r.data));
        }

        // Try wrapped gateway format: {"code":0,"data":{"data":[...]}}
        if let Ok(r) = serde_json::from_str::<WrappedModelsResponse>(&body) {
            return Ok(convert(r.data.data));
        }

        // Try bare array: [{"id": "model-1"}, ...]
        if let Ok(models) = serde_json::from_str::<Vec<OpenAIModel>>(&body) {
            return Ok(convert(models));
        }

        Err(AQBotError::Provider(format!(
            "Unsupported models response format (body: {})",
            if body.len() > 200 {
                &body[..200]
            } else {
                &body
            }
        )))
    }

    async fn validate_key(&self, ctx: &ProviderRequestContext) -> Result<bool> {
        // Try list_models first
        if self.list_models(ctx).await.is_ok() {
            return Ok(true);
        }
        // Fallback: probe /models endpoint, valid key → 200/400, invalid → 401/403
        let url = resolve_models_url(&self.base_url(ctx));
        let resp = crate::apply_request_headers(
            self.get_client(ctx)?
                .get(&url)
                .header("Authorization", format!("Bearer {}", ctx.api_key)),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;
        let status = resp.status().as_u16();
        Ok(status != 401 && status != 403)
    }

    async fn embed(
        &self,
        ctx: &ProviderRequestContext,
        request: EmbedRequest,
    ) -> Result<EmbedResponse> {
        let url = format!("{}/embeddings", self.base_url(ctx));
        let body = OpenAIEmbedRequest {
            model: request.model,
            input: request.input,
            dimensions: request.dimensions,
        };

        let resp = crate::apply_request_headers(
            self.get_client(ctx)?
                .post(&url)
                .header("Authorization", format!("Bearer {}", ctx.api_key))
                .json(&body),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Embed request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "{} embed error {s}: {t}",
                self.policy.error_label()
            )));
        }

        let result: OpenAIEmbedResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Embed parse error: {e}")))?;

        let dimensions = result.data.first().map(|d| d.embedding.len()).unwrap_or(0);
        let embeddings: Vec<Vec<f32>> = result.data.into_iter().map(|d| d.embedding).collect();

        Ok(EmbedResponse {
            embeddings,
            dimensions,
        })
    }
}
