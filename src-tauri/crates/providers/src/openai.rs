use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use futures::StreamExt;
use serde::{Deserialize, Deserializer, Serialize};
use std::pin::Pin;

use crate::reasoning::{resolve_reasoning, ReasoningStyle};
use crate::{build_http_client, resolve_chat_url, ProviderAdapter, ProviderRequestContext};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAIAdapter {
    client: reqwest::Client,
}

impl OpenAIAdapter {
    pub fn new() -> Self {
        Self {
            client: crate::build_default_http_client()
                .expect("Failed to build default HTTP client"),
        }
    }

    fn base_url(ctx: &ProviderRequestContext) -> String {
        ctx.base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    }

    fn chat_url(ctx: &ProviderRequestContext) -> String {
        resolve_chat_url(
            &Self::base_url(ctx),
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
    /// SiliconFlow-style thinking toggle
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_thinking: Option<bool>,
    /// SiliconFlow-style thinking token budget
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_budget: Option<u32>,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

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

fn is_deepseek_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("deepseek")
}

fn convert_messages(
    messages: &[ChatMessage],
    include_reasoning_content: bool,
) -> Vec<OpenAIMessage> {
    messages
        .iter()
        .map(|msg| {
            let reasoning_content = if include_reasoning_content && msg.role == "assistant" {
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
                "assistant" if msg.tool_calls.is_some() => {
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
                        tool_calls: msg.tool_calls.as_ref().map(|tcs| {
                            tcs.iter().map(|tc| serde_json::json!({
                                "id": tc.id,
                                "type": tc.call_type,
                                "function": { "name": tc.function.name, "arguments": tc.function.arguments }
                            })).collect()
                        }),
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

fn build_request(request: &ChatRequest, messages: &[ChatMessage], stream: bool) -> OpenAIRequest {
    let default_style = match request.thinking_param_style.as_deref() {
        Some("enable_thinking") => ReasoningStyle::SiliconFlowEnableThinking,
        Some("none") => ReasoningStyle::None,
        _ => ReasoningStyle::OpenAIReasoningEffort,
    };
    let reasoning = resolve_reasoning(request, default_style);
    let reasoning_effort = reasoning.as_ref().and_then(|r| {
        if matches!(r.level.as_str(), "off" | "none") {
            None
        } else {
            r.reasoning_effort.clone()
        }
    });
    let enable_thinking = reasoning.as_ref().and_then(|r| r.enable_thinking);
    let sf_thinking_budget = reasoning
        .as_ref()
        .and_then(|r| r.budget_tokens)
        .filter(|v| *v > 0);
    let has_active_thinking = reasoning
        .as_ref()
        .is_some_and(|r| r.suppress_sampling_params || enable_thinking == Some(true));

    // Use max_completion_tokens only when the model/request contract requires it.
    let use_completion_tokens = request.use_max_completion_tokens == Some(true)
        || request.model.starts_with("o1")
        || request.model.starts_with("o3")
        || request.model.starts_with("o4")
        || request.model.starts_with("gpt-5");

    let (max_tokens, max_completion_tokens) = if use_completion_tokens {
        (None, request.max_tokens.filter(|&v| v > 0))
    } else {
        (request.max_tokens.filter(|&v| v > 0), None)
    };

    OpenAIRequest {
        model: request.model.clone(),
        messages: convert_messages(
            messages,
            is_deepseek_model(&request.model) && has_active_thinking,
        ),
        temperature: if has_active_thinking {
            None
        } else {
            request.temperature
        },
        top_p: if has_active_thinking {
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
        enable_thinking,
        thinking_budget: sf_thinking_budget,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        }
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

    #[test]
    fn deepseek_thinking_keeps_max_tokens_when_completion_tokens_not_enabled() {
        let mut request = base_chat_request("deepseek-v4");
        request.thinking_level = Some("high".to_string());
        request.use_max_completion_tokens = Some(false);

        let body = build_request(&request, &request.messages, true);

        assert_eq!(body.max_tokens, Some(300_000));
        assert_eq!(body.max_completion_tokens, None);
        assert_eq!(body.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(body.temperature, None);
        assert_eq!(body.top_p, None);
    }

    #[test]
    fn deepseek_none_omits_reasoning_effort_and_keeps_sampling_params() {
        let mut request = base_chat_request("deepseek-v4-flash");
        request.thinking_level = Some("none".to_string());

        let body = build_request(&request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized.get("reasoning_effort").is_none());
        assert_eq!(serialized["max_tokens"], json!(300_000));
        assert!(serialized.get("max_completion_tokens").is_none());
        assert_eq!(serialized["temperature"], json!(0.7));
        assert_eq!(serialized["top_p"], json!(1.0));
    }

    #[test]
    fn explicit_completion_tokens_override_still_uses_max_completion_tokens() {
        let mut request = base_chat_request("deepseek-v4");
        request.use_max_completion_tokens = Some(true);

        let body = build_request(&request, &request.messages, true);

        assert_eq!(body.max_tokens, None);
        assert_eq!(body.max_completion_tokens, Some(300_000));
    }

    #[test]
    fn openai_reasoning_models_still_use_max_completion_tokens() {
        let request = base_chat_request("o3-mini");

        let body = build_request(&request, &request.messages, true);

        assert_eq!(body.max_tokens, None);
        assert_eq!(body.max_completion_tokens, Some(300_000));
    }

    #[test]
    fn deepseek_thinking_serializes_assistant_reasoning_content() {
        let assistant: ChatMessage = serde_json::from_value(json!({
            "role": "assistant",
            "content": "final answer",
            "reasoning_content": "hidden thinking"
        }))
        .expect("chat message");
        let mut request = base_chat_request("deepseek-v4");
        request.thinking_level = Some("high".to_string());
        request.messages = vec![assistant];

        let body = build_request(&request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(
            serialized["messages"][0]["reasoning_content"],
            json!("hidden thinking")
        );
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

        let body = build_request(&request, &request.messages, true);
        let serialized = serde_json::to_value(body).expect("request json");

        assert!(serialized["messages"][0].get("reasoning_content").is_none());
    }
}

#[async_trait]
impl ProviderAdapter for OpenAIAdapter {
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse> {
        let url = Self::chat_url(ctx);
        let body = build_request(&request, &request.messages, false);

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
            return Err(AQBotError::Provider(format!(
                "OpenAI API error {status}: {text}"
            )));
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

        let tool_calls = msg.tool_calls.as_ref().map(|tcs| {
            tcs.iter()
                .map(|tc| aqbot_core::types::ToolCall {
                    id: tc.id.clone().unwrap_or_default(),
                    call_type: tc.call_type.clone().unwrap_or_else(|| "function".into()),
                    function: aqbot_core::types::ToolCallFunction {
                        name: tc
                            .function
                            .as_ref()
                            .and_then(|f| f.name.clone())
                            .unwrap_or_default(),
                        arguments: tc
                            .function
                            .as_ref()
                            .and_then(|f| f.arguments.clone())
                            .unwrap_or_default(),
                    },
                })
                .collect()
        });

        Ok(ChatResponse {
            id: oai.id.unwrap_or_default(),
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
        let url = Self::chat_url(ctx);
        let body = build_request(&request, &request.messages, true);

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
                    let _ = tx.unbounded_send(Err(AQBotError::Provider(format!(
                        "OpenAI API error {s}: {t}"
                    ))));
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
                    let tool_calls = if pending_tool_calls.is_empty() {
                        None
                    } else {
                        Some(
                            pending_tool_calls
                                .iter()
                                .map(|(id, ct, name, args)| aqbot_core::types::ToolCall {
                                    id: id.clone(),
                                    call_type: ct.clone(),
                                    function: aqbot_core::types::ToolCallFunction {
                                        name: name.clone(),
                                        arguments: args.clone(),
                                    },
                                })
                                .collect(),
                        )
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
                            let idx = tc.index;
                            while pending_tool_calls.len() <= idx {
                                pending_tool_calls.push((
                                    String::new(),
                                    String::from("function"),
                                    String::new(),
                                    String::new(),
                                ));
                            }
                            if let Some(ref id) = tc.id {
                                pending_tool_calls[idx].0 = id.clone();
                            }
                            if let Some(ref ct) = tc.call_type {
                                pending_tool_calls[idx].1 = ct.clone();
                            }
                            if let Some(ref f) = tc.function {
                                if let Some(ref name) = f.name {
                                    pending_tool_calls[idx].2 = name.clone();
                                }
                                if let Some(ref args) = f.arguments {
                                    pending_tool_calls[idx].3.push_str(args);
                                }
                            }
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
        let url = format!("{}/models", Self::base_url(ctx));

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
            return Err(AQBotError::Provider(format!("OpenAI API error {s}: {t}")));
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
        let url = format!("{}/models", Self::base_url(ctx));
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
        let url = format!("{}/embeddings", Self::base_url(ctx));
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
                "OpenAI embed API error {s}: {t}"
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
