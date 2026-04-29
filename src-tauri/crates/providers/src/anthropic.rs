use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

use crate::{
    build_http_client, parse_base64_data_url, resolve_chat_url, ProviderAdapter,
    ProviderRequestContext,
};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicAdapter {
    client: reqwest::Client,
}

impl AnthropicAdapter {
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
        resolve_chat_url(&Self::base_url(ctx), ctx.api_path.as_deref(), "/messages")
    }

    fn get_client(&self, ctx: &ProviderRequestContext) -> Result<reqwest::Client> {
        match &ctx.proxy_config {
            Some(c) if c.proxy_type.as_deref() != Some("none") => build_http_client(Some(c)),
            _ => Ok(self.client.clone()),
        }
    }
}

// --- Internal types ---

#[derive(Serialize)]
struct AnthropicRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<AnthropicTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<AnthropicThinking>,
}

#[derive(Serialize)]
struct AnthropicThinking {
    r#type: String,
    budget_tokens: u32,
}

#[derive(Serialize)]
struct AnthropicTool {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    input_schema: serde_json::Value,
}

#[derive(Serialize)]
struct AnthropicMessage {
    role: String,
    content: serde_json::Value,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    id: String,
    model: String,
    content: Vec<AnthropicContentBlock>,
    usage: AnthropicUsage,
}

#[derive(Deserialize)]
struct AnthropicContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
    thinking: Option<String>,
    id: Option<String>,
    name: Option<String>,
    input: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[derive(Deserialize)]
struct AnthropicModelsResponse {
    data: Vec<AnthropicModelInfo>,
}

#[derive(Deserialize)]
struct AnthropicModelInfo {
    id: String,
    display_name: Option<String>,
}

/// Separate system messages from conversation messages and convert to Anthropic format.
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

fn convert_messages(messages: &[ChatMessage]) -> (Option<String>, Vec<AnthropicMessage>) {
    let mut system = None;
    let mut result = Vec::new();

    for msg in messages {
        if msg.role == "system" {
            if let ChatContent::Text(text) = &msg.content {
                system = Some(text.clone());
            }
            continue;
        }

        match msg.role.as_str() {
            "tool" => {
                // Anthropic expects tool_result as user message with content blocks
                result.push(AnthropicMessage {
                    role: "user".to_string(),
                    content: serde_json::json!([{
                        "type": "tool_result",
                        "tool_use_id": msg.tool_call_id.as_deref().unwrap_or(""),
                        "content": extract_text_content(&msg.content)
                    }]),
                });
            }
            "assistant" if msg.tool_calls.is_some() => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                let text = extract_text_content(&msg.content);
                if !text.is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": text }));
                }
                if let Some(ref tcs) = msg.tool_calls {
                    for tc in tcs {
                        let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.function.name,
                            "input": args
                        }));
                    }
                }
                result.push(AnthropicMessage {
                    role: "assistant".to_string(),
                    content: serde_json::json!(blocks),
                });
            }
            _ => {
                let content = match &msg.content {
                    ChatContent::Text(text) => serde_json::Value::String(text.clone()),
                    ChatContent::Multipart(parts) => {
                        let blocks: Vec<serde_json::Value> = parts
                            .iter()
                            .map(|p| {
                                if let Some(text) = &p.text {
                                    serde_json::json!({"type": "text", "text": text})
                                } else if let Some(img) = &p.image_url {
                                    if let Some((media_type, data)) =
                                        parse_base64_data_url(&img.url)
                                    {
                                        serde_json::json!({
                                            "type": "image",
                                            "source": {
                                                "type": "base64",
                                                "media_type": media_type,
                                                "data": data
                                            }
                                        })
                                    } else {
                                        serde_json::json!({
                                            "type": "image",
                                            "source": { "type": "url", "url": img.url }
                                        })
                                    }
                                } else {
                                    serde_json::json!({"type": "text", "text": ""})
                                }
                            })
                            .collect();
                        serde_json::Value::Array(blocks)
                    }
                };

                result.push(AnthropicMessage {
                    role: msg.role.clone(),
                    content,
                });
            }
        }
    }

    (system, result)
}

/// Convert OpenAI-format tools to Anthropic-format tools.
fn convert_tools_to_anthropic(tools: &Option<Vec<ChatTool>>) -> Option<Vec<AnthropicTool>> {
    tools.as_ref().map(|ts| {
        ts.iter()
            .map(|t| AnthropicTool {
                name: t.function.name.clone(),
                description: t.function.description.clone(),
                input_schema: t
                    .function
                    .parameters
                    .clone()
                    .unwrap_or(serde_json::json!({"type": "object"})),
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn convert_messages_turns_data_url_images_into_base64_blocks() {
        let (_, messages) = convert_messages(&[ChatMessage {
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
            tool_calls: None,
            tool_call_id: None,
        }]);

        assert_eq!(
            messages[0].content,
            json!([
                { "type": "text", "text": "Describe this image" },
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "YWJj"
                    }
                }
            ])
        );
    }
}

#[async_trait]
impl ProviderAdapter for AnthropicAdapter {
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse> {
        let url = Self::chat_url(ctx);
        let (system, messages) = convert_messages(&request.messages);

        let thinking = request.thinking_budget.and_then(|b| {
            if b == 0 {
                None
            } else {
                Some(AnthropicThinking {
                    r#type: "enabled".to_string(),
                    budget_tokens: b,
                })
            }
        });
        let body = AnthropicRequest {
            model: request.model.clone(),
            messages,
            max_tokens: request
                .max_tokens
                .unwrap_or(if thinking.is_some() { 16000 } else { 4096 }),
            system,
            temperature: if thinking.is_some() {
                None
            } else {
                request.temperature
            },
            top_p: if thinking.is_some() {
                None
            } else {
                request.top_p
            },
            stream: None,
            tools: convert_tools_to_anthropic(&request.tools),
            thinking,
        };

        let resp = crate::apply_request_headers(
            self.get_client(ctx)?
                .post(&url)
                .header("x-api-key", &ctx.api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("content-type", "application/json")
                .json(&body),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "Anthropic API error {s}: {t}"
            )));
        }

        let ar: AnthropicResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        let mut content = String::new();
        let mut thinking = None;
        let mut tool_calls: Vec<aqbot_core::types::ToolCall> = Vec::new();

        for block in &ar.content {
            match block.block_type.as_str() {
                "text" => {
                    if let Some(t) = &block.text {
                        content.push_str(t);
                    }
                }
                "thinking" => {
                    if let Some(t) = &block.thinking {
                        let prev = thinking.unwrap_or_default();
                        thinking = Some(format!("{prev}{t}"));
                    }
                }
                "tool_use" => {
                    if let (Some(id), Some(name)) = (&block.id, &block.name) {
                        let arguments = block
                            .input
                            .as_ref()
                            .map(|v| serde_json::to_string(v).unwrap_or_default())
                            .unwrap_or_default();
                        tool_calls.push(aqbot_core::types::ToolCall {
                            id: id.clone(),
                            call_type: "function".to_string(),
                            function: aqbot_core::types::ToolCallFunction {
                                name: name.clone(),
                                arguments,
                            },
                        });
                    }
                }
                _ => {}
            }
        }

        Ok(ChatResponse {
            id: ar.id,
            model: ar.model,
            content,
            thinking,
            usage: TokenUsage {
                prompt_tokens: ar.usage.input_tokens,
                completion_tokens: ar.usage.output_tokens,
                total_tokens: ar.usage.input_tokens + ar.usage.output_tokens,
            },
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
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

        let (system, messages) = convert_messages(&request.messages);
        let thinking = request.thinking_budget.and_then(|b| {
            if b == 0 {
                None
            } else {
                Some(AnthropicThinking {
                    r#type: "enabled".to_string(),
                    budget_tokens: b,
                })
            }
        });
        let body = AnthropicRequest {
            model: request.model.clone(),
            messages,
            max_tokens: request
                .max_tokens
                .unwrap_or(if thinking.is_some() { 16000 } else { 4096 }),
            system,
            temperature: if thinking.is_some() {
                None
            } else {
                request.temperature
            },
            top_p: if thinking.is_some() {
                None
            } else {
                request.top_p
            },
            stream: Some(true),
            tools: convert_tools_to_anthropic(&request.tools),
            thinking,
        };

        let (tx, rx) = futures::channel::mpsc::unbounded();

        tokio::spawn(async move {
            let resp = match crate::apply_stream_headers_to_request(
                client
                    .post(&url)
                    .header("x-api-key", &api_key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .header("content-type", "application/json")
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
                        "Anthropic API error {s}: {t}"
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

            struct PendingToolUse {
                id: String,
                name: String,
                arguments: String,
            }
            let mut pending_tool_uses: Vec<PendingToolUse> = Vec::new();
            let mut current_tool_use: Option<PendingToolUse> = None;
            let mut accumulated_prompt_tokens: u32 = 0;
            let mut accumulated_completion_tokens: u32 = 0;

            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end().to_string();
                            buf = buf[pos + 1..].to_string();

                            if line.is_empty() || line.starts_with("event:") {
                                continue;
                            }

                            let data = if let Some(d) = line.strip_prefix("data: ") {
                                d
                            } else if let Some(d) = line.strip_prefix("data:") {
                                d
                            } else {
                                continue;
                            };

                            let json: serde_json::Value = match serde_json::from_str(data) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };

                            let event_type =
                                json.get("type").and_then(|t| t.as_str()).unwrap_or("");

                            match event_type {
                                "message_start" => {
                                    if let Some(input) = json
                                        .get("message")
                                        .and_then(|m| m.get("usage"))
                                        .and_then(|u| u.get("input_tokens"))
                                        .and_then(|v| v.as_u64())
                                    {
                                        accumulated_prompt_tokens = input as u32;
                                    }
                                }
                                "content_block_start" => {
                                    if let Some(cb) = json.get("content_block") {
                                        if cb.get("type").and_then(|t| t.as_str())
                                            == Some("tool_use")
                                        {
                                            let id = cb
                                                .get("id")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("")
                                                .to_string();
                                            let name = cb
                                                .get("name")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("")
                                                .to_string();
                                            current_tool_use = Some(PendingToolUse {
                                                id,
                                                name,
                                                arguments: String::new(),
                                            });
                                        }
                                    }
                                }
                                "content_block_delta" => {
                                    if let Some(delta) = json.get("delta") {
                                        let dt = delta
                                            .get("type")
                                            .and_then(|t| t.as_str())
                                            .unwrap_or("");
                                        let chunk = match dt {
                                            "text_delta" => ChatStreamChunk {
                                                content: delta
                                                    .get("text")
                                                    .and_then(|v| v.as_str())
                                                    .map(String::from),
                                                thinking: None,
                                                done: false,
                                                is_final: None,
                                                usage: None,
                                                tool_calls: None,
                                            },
                                            "thinking_delta" => ChatStreamChunk {
                                                content: None,
                                                thinking: delta
                                                    .get("thinking")
                                                    .and_then(|v| v.as_str())
                                                    .map(String::from),
                                                done: false,
                                                is_final: None,
                                                usage: None,
                                                tool_calls: None,
                                            },
                                            "input_json_delta" => {
                                                if let Some(ref mut tu) = current_tool_use {
                                                    if let Some(partial) = delta
                                                        .get("partial_json")
                                                        .and_then(|v| v.as_str())
                                                    {
                                                        tu.arguments.push_str(partial);
                                                    }
                                                }
                                                continue; // Don't send a ChatStreamChunk for JSON delta
                                            }
                                            _ => continue,
                                        };
                                        let _ = tx.unbounded_send(Ok(chunk));
                                    }
                                }
                                "content_block_stop" => {
                                    if let Some(tu) = current_tool_use.take() {
                                        pending_tool_uses.push(tu);
                                    }
                                }
                                "message_delta" => {
                                    if let Some(u) = json.get("usage") {
                                        let out = u
                                            .get("output_tokens")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0)
                                            as u32;
                                        accumulated_completion_tokens = out;
                                        let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                            content: None,
                                            thinking: None,
                                            done: false,
                                            is_final: None,
                                            usage: Some(TokenUsage {
                                                prompt_tokens: accumulated_prompt_tokens,
                                                completion_tokens: out,
                                                total_tokens: accumulated_prompt_tokens + out,
                                            }),
                                            tool_calls: None,
                                        }));
                                    }
                                }
                                "message_stop" => {
                                    let tool_calls = if pending_tool_uses.is_empty() {
                                        None
                                    } else {
                                        Some(
                                            pending_tool_uses
                                                .iter()
                                                .map(|tu| aqbot_core::types::ToolCall {
                                                    id: tu.id.clone(),
                                                    call_type: "function".to_string(),
                                                    function: aqbot_core::types::ToolCallFunction {
                                                        name: tu.name.clone(),
                                                        arguments: tu.arguments.clone(),
                                                    },
                                                })
                                                .collect(),
                                        )
                                    };
                                    let final_usage = if accumulated_prompt_tokens > 0
                                        || accumulated_completion_tokens > 0
                                    {
                                        Some(TokenUsage {
                                            prompt_tokens: accumulated_prompt_tokens,
                                            completion_tokens: accumulated_completion_tokens,
                                            total_tokens: accumulated_prompt_tokens
                                                + accumulated_completion_tokens,
                                        })
                                    } else {
                                        None
                                    };
                                    let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                        content: None,
                                        thinking: None,
                                        done: true,
                                        is_final: None,
                                        usage: final_usage,
                                        tool_calls,
                                    }));
                                    return;
                                }
                                _ => {}
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
                .header("x-api-key", &ctx.api_key)
                .header("anthropic-version", ANTHROPIC_VERSION),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "Anthropic API error {s}: {t}"
            )));
        }

        let models: AnthropicModelsResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        Ok(models
            .data
            .into_iter()
            .map(|m| {
                let model_type = ModelType::detect(&m.id);
                let mut caps = match model_type {
                    ModelType::Chat => vec![ModelCapability::TextChat],
                    ModelType::Embedding => vec![],
                    ModelType::Image => vec![],
                    ModelType::Voice => vec![ModelCapability::RealtimeVoice],
                };
                let id_lower = m.id.to_lowercase();
                if id_lower.contains("claude") && !id_lower.contains("haiku") {
                    caps.push(ModelCapability::Vision);
                }
                if id_lower.contains("opus")
                    || id_lower.contains("sonnet-4")
                    || id_lower.contains("3-7")
                    || id_lower.contains("3.7")
                {
                    caps.push(ModelCapability::Reasoning);
                }
                let name = m.display_name.unwrap_or_else(|| m.id.clone());
                Model {
                    provider_id: ctx.provider_id.clone(),
                    model_id: m.id,
                    name,
                    group_name: None,
                    model_type,
                    capabilities: caps,
                    max_tokens: None,
                    enabled: true,
                    param_overrides: None,
                }
            })
            .collect())
    }

    async fn validate_key(&self, ctx: &ProviderRequestContext) -> Result<bool> {
        // Try list_models first (works with official Anthropic API)
        if self.list_models(ctx).await.is_ok() {
            return Ok(true);
        }
        // Fallback: probe the /messages endpoint with an empty body.
        // Valid key → 400 (bad request); invalid key → 401/403.
        // This avoids token consumption and works with proxy services
        // that don't support the /models endpoint.
        let url = Self::chat_url(ctx);
        let resp = crate::apply_request_headers(
            self.get_client(ctx)?
                .post(&url)
                .header("x-api-key", &ctx.api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("content-type", "application/json")
                .body("{}"),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Validation request failed: {e}")))?;
        let status = resp.status().as_u16();
        Ok(status != 401 && status != 403)
    }

    async fn embed(
        &self,
        _ctx: &ProviderRequestContext,
        _request: EmbedRequest,
    ) -> Result<EmbedResponse> {
        Err(AQBotError::Provider("Anthropic does not support embedding API. Please use an OpenAI-compatible or Gemini provider for embeddings.".into()))
    }
}
