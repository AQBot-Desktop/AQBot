use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

use crate::{build_http_client, resolve_chat_url, ProviderAdapter, ProviderRequestContext};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAIAdapter {
    client: reqwest::Client,
}

impl OpenAIAdapter {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder().no_proxy().build().expect("Failed to build default HTTP client"),
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
    tool_calls: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIResponse {
    id: Option<String>,
    model: Option<String>,
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
    content: Option<String>,
    reasoning_content: Option<String>,
    tool_calls: Option<Vec<OpenAIToolCallDelta>>,
}

#[derive(Deserialize)]
struct OpenAIDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
    tool_calls: Option<Vec<OpenAIToolCallDelta>>,
}

#[derive(Deserialize)]
struct OpenAIUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
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

fn convert_messages(messages: &[ChatMessage]) -> Vec<OpenAIMessage> {
    messages
        .iter()
        .map(|msg| {
            match msg.role.as_str() {
                "tool" => OpenAIMessage {
                    role: "tool".to_string(),
                    content: Some(serde_json::Value::String(extract_text_content(&msg.content))),
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
                        tool_calls: None,
                        tool_call_id: None,
                    }
                }
            }
        })
        .collect()
}

fn build_request(request: &ChatRequest, messages: &[ChatMessage], stream: bool) -> OpenAIRequest {
    let reasoning_effort = request.thinking_budget.map(|b| match b {
        0 => "none".to_string(),
        1..=2048 => "low".to_string(),
        2049..=6144 => "medium".to_string(),
        6145..=12288 => "high".to_string(),
        _ => "xhigh".to_string(),
    });

    // Use max_completion_tokens when: model config says so, reasoning mode,
    // o-series models, or gpt-5+ (which deprecate max_tokens)
    let use_completion_tokens = request.use_max_completion_tokens == Some(true)
        || reasoning_effort.is_some()
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
        messages: convert_messages(messages),
        temperature: if reasoning_effort.is_some() {
            None
        } else {
            request.temperature
        },
        top_p: if reasoning_effort.is_some() {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn convert_messages_omits_null_fields_for_openai_compatible_requests() {
        let messages = convert_messages(&[ChatMessage {
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
        }]);

        assert_eq!(
            messages[0].content,
            json!([
                { "type": "text", "text": "Describe this image" },
                {
                    "type": "image_url",
                    "image_url": { "url": "data:image/png;base64,YWJj" }
                }
            ])
        );
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
            content: msg.content.clone().unwrap_or_default(),
            thinking: msg.reasoning_content.clone(),
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
            let resp = match crate::apply_headers_to_request(
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
            // (id, type, name, arguments) — indexed by position

            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end().to_string();
                            buf = buf[pos + 1..].to_string();

                            if line.is_empty() || line.starts_with(':') {
                                continue;
                            }

                            let data = if let Some(d) = line.strip_prefix("data: ") {
                                d
                            } else if let Some(d) = line.strip_prefix("data:") {
                                d
                            } else {
                                continue;
                            };

                            if data.trim() == "[DONE]" {
                                let tool_calls = if pending_tool_calls.is_empty() {
                                    None
                                } else {
                                    Some(
                                        pending_tool_calls
                                            .iter()
                                            .map(|(id, ct, name, args)| {
                                                aqbot_core::types::ToolCall {
                                                    id: id.clone(),
                                                    call_type: ct.clone(),
                                                    function: aqbot_core::types::ToolCallFunction {
                                                        name: name.clone(),
                                                        arguments: args.clone(),
                                                    },
                                                }
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
                                return;
                            }

                            if let Ok(parsed) = serde_json::from_str::<OpenAIResponse>(data) {
                                if let Some(choice) = parsed.choices.first() {
                                    if let Some(delta) = &choice.delta {
                                        // Handle tool call deltas
                                        if let Some(ref tc_deltas) = delta.tool_calls {
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
                                        let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                            content: delta.content.clone(),
                                            thinking: delta.reasoning_content.clone(),
                                            done: false,
                                            is_final: None,
                                            usage,
                                            tool_calls: None,
                                        }));
                                    }
                                } else if let Some(u) = parsed.usage {
                                    // Usage-only chunk (empty choices) sent when stream_options.include_usage is true
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
            if body.len() > 200 { &body[..200] } else { &body }
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
