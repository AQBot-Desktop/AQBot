use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

use crate::reasoning::{resolve_reasoning, ReasoningStyle};
use crate::{
    build_http_client, incomplete_stream_error, resolve_chat_url, resolve_models_url,
    spawn_abortable_stream, ProviderAdapter, ProviderRequestContext,
};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAIResponsesAdapter {
    client: reqwest::Client,
}

impl OpenAIResponsesAdapter {
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
        resolve_chat_url(&Self::base_url(ctx), ctx.api_path.as_deref(), "/responses")
    }

    fn get_client(&self, ctx: &ProviderRequestContext) -> Result<reqwest::Client> {
        match &ctx.proxy_config {
            Some(c) if c.proxy_type.as_deref() != Some("none") => build_http_client(Some(c)),
            _ => Ok(self.client.clone()),
        }
    }
}

// --- Responses API request types ---

#[derive(Serialize)]
struct ResponsesRequest {
    model: String,
    input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ResponsesTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ResponsesReasoning>,
}

#[derive(Serialize)]
struct ResponsesTool {
    r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct ResponsesReasoning {
    effort: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

// --- Responses API response types ---

#[derive(Deserialize)]
struct ResponsesResponse {
    id: Option<String>,
    model: Option<String>,
    #[serde(default)]
    output: Vec<serde_json::Value>,
    usage: Option<ResponsesUsage>,
}

#[derive(Deserialize)]
struct ResponsesUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
    #[serde(default)]
    total_tokens: u32,
}

// --- Streaming event types ---

#[derive(Deserialize)]
struct StreamTextDelta {
    delta: Option<String>,
}

#[derive(Deserialize)]
struct StreamTextDeltaEvent {
    #[serde(default)]
    part: Option<StreamTextDelta>,
    // For top-level delta field (some providers)
    #[serde(default)]
    delta: Option<String>,
}

#[derive(Deserialize)]
struct StreamReasoningDeltaEvent {
    #[serde(default)]
    delta: Option<String>,
}

#[derive(Deserialize)]
struct StreamFunctionCallArgsDelta {
    item_id: Option<String>,
    output_index: Option<usize>,
    #[serde(default)]
    delta: Option<String>,
}

#[derive(Deserialize)]
struct StreamFunctionCallArgsDone {
    item_id: Option<String>,
    output_index: Option<usize>,
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct StreamOutputItemAdded {
    item: Option<StreamOutputItem>,
    output_index: Option<usize>,
}

#[derive(Deserialize)]
struct StreamOutputItem {
    id: Option<String>,
    r#type: Option<String>,
    name: Option<String>,
    call_id: Option<String>,
}

#[derive(Deserialize)]
struct StreamCompletedEvent {
    response: ResponsesResponse,
}

// --- Models types (reuse OpenAI format) ---

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

// --- Embedding types (reuse OpenAI format) ---

#[derive(Serialize)]
struct EmbedReq {
    model: String,
    input: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<usize>,
}

#[derive(Deserialize)]
struct EmbedResp {
    data: Vec<EmbedDataItem>,
}

#[derive(Deserialize)]
struct EmbedDataItem {
    embedding: Vec<f32>,
}

// --- Helper functions ---

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

fn convert_content_to_value(content: &ChatContent) -> serde_json::Value {
    match content {
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
    }
}

/// Strip `:::mcp` fenced containers from text to avoid model confusion.
/// These blocks are for frontend rendering only and should not be sent to the API.
fn strip_mcp_blocks(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut in_mcp_block = false;

    for line in text.split('\n') {
        if !in_mcp_block {
            if line.starts_with(":::mcp ") || line == ":::mcp" {
                in_mcp_block = true;
                continue;
            }
            result.push_str(line);
            result.push('\n');
        } else if line.trim() == ":::" {
            in_mcp_block = false;
        }
        // Skip lines inside :::mcp block
    }

    // Remove trailing newline if original didn't have one
    if !text.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }

    // Clean up excessive blank lines left by removed blocks
    while result.contains("\n\n\n") {
        result = result.replace("\n\n\n", "\n\n");
    }

    result
}

/// Convert internal ChatMessage array → Responses API `input` + `instructions`.
fn build_responses_input(messages: &[ChatMessage]) -> (serde_json::Value, Option<String>) {
    let mut instructions: Option<String> = None;
    let mut input_items: Vec<serde_json::Value> = Vec::new();

    for msg in messages {
        match msg.role.as_str() {
            "system" => {
                let text = extract_text_content(&msg.content);
                if !text.is_empty() {
                    match &mut instructions {
                        Some(existing) => {
                            existing.push('\n');
                            existing.push_str(&text);
                        }
                        None => instructions = Some(text),
                    }
                }
            }
            "user" => {
                let mut item = serde_json::Map::new();
                item.insert(
                    "role".to_string(),
                    serde_json::Value::String("user".to_string()),
                );
                item.insert(
                    "content".to_string(),
                    convert_content_to_value(&msg.content),
                );
                input_items.push(serde_json::Value::Object(item));
            }
            "assistant" => {
                if let Some(ref tool_calls) = msg.tool_calls {
                    // Emit text part if present, stripping :::mcp blocks
                    let raw_text = extract_text_content(&msg.content);
                    let text = strip_mcp_blocks(&raw_text);
                    let text = text.trim();
                    if !text.is_empty() {
                        let mut item = serde_json::Map::new();
                        item.insert(
                            "role".to_string(),
                            serde_json::Value::String("assistant".to_string()),
                        );
                        item.insert(
                            "content".to_string(),
                            serde_json::Value::String(text.to_string()),
                        );
                        input_items.push(serde_json::Value::Object(item));
                    }
                    // Emit function_call items for each tool call
                    for tc in tool_calls {
                        let mut item = serde_json::Map::new();
                        item.insert(
                            "type".to_string(),
                            serde_json::Value::String("function_call".to_string()),
                        );
                        // API requires `id` to start with "fc_", `call_id` starts with "call_"
                        // tc.id stores the call_id; derive a synthetic item id
                        let item_id = if tc.id.starts_with("fc_") {
                            tc.id.clone()
                        } else {
                            format!("fc_{}", tc.id.trim_start_matches("call_"))
                        };
                        item.insert("id".to_string(), serde_json::Value::String(item_id));
                        item.insert(
                            "call_id".to_string(),
                            serde_json::Value::String(tc.id.clone()),
                        );
                        item.insert(
                            "name".to_string(),
                            serde_json::Value::String(tc.function.name.clone()),
                        );
                        item.insert(
                            "arguments".to_string(),
                            serde_json::Value::String(tc.function.arguments.clone()),
                        );
                        input_items.push(serde_json::Value::Object(item));
                    }
                } else {
                    // No tool calls — strip :::mcp blocks from content
                    let raw_text = extract_text_content(&msg.content);
                    let text = strip_mcp_blocks(&raw_text);
                    let mut item = serde_json::Map::new();
                    item.insert(
                        "role".to_string(),
                        serde_json::Value::String("assistant".to_string()),
                    );
                    item.insert("content".to_string(), serde_json::Value::String(text));
                    input_items.push(serde_json::Value::Object(item));
                }
            }
            "tool" => {
                let mut item = serde_json::Map::new();
                item.insert(
                    "type".to_string(),
                    serde_json::Value::String("function_call_output".to_string()),
                );
                item.insert(
                    "call_id".to_string(),
                    serde_json::Value::String(msg.tool_call_id.clone().unwrap_or_default()),
                );
                item.insert(
                    "output".to_string(),
                    serde_json::Value::String(extract_text_content(&msg.content)),
                );
                input_items.push(serde_json::Value::Object(item));
            }
            _ => {
                let mut item = serde_json::Map::new();
                item.insert(
                    "role".to_string(),
                    serde_json::Value::String(msg.role.clone()),
                );
                item.insert(
                    "content".to_string(),
                    convert_content_to_value(&msg.content),
                );
                input_items.push(serde_json::Value::Object(item));
            }
        }
    }

    (serde_json::Value::Array(input_items), instructions)
}

fn build_request(request: &ChatRequest, stream: bool) -> ResponsesRequest {
    let (input, instructions) = build_responses_input(&request.messages);

    let reasoning =
        resolve_reasoning(request, ReasoningStyle::OpenAIResponsesReasoning).and_then(|r| {
            let effort = r.reasoning_effort?;
            Some(ResponsesReasoning {
                effort: effort.clone(),
                summary: if effort == "none" {
                    None
                } else {
                    Some("auto".to_string())
                },
            })
        });

    let tools = request.tools.as_ref().map(|tools| {
        tools
            .iter()
            .map(|t| ResponsesTool {
                r#type: "function".to_string(),
                name: Some(t.function.name.clone()),
                description: t.function.description.clone(),
                parameters: t.function.parameters.clone(),
            })
            .collect()
    });

    ResponsesRequest {
        model: request.model.clone(),
        input,
        instructions,
        max_output_tokens: request.max_tokens.map(|v| v.max(16)),
        temperature: if reasoning.is_some() {
            None
        } else {
            request.temperature
        },
        top_p: if reasoning.is_some() {
            None
        } else {
            request.top_p
        },
        stream,
        tools,
        reasoning,
    }
}

/// Extract text + tool_calls from a non-streaming Responses API response.
fn parse_response_output(output: &[serde_json::Value]) -> (String, Option<Vec<ToolCall>>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    for item in output {
        let obj = match item.as_object() {
            Some(o) => o,
            None => continue,
        };
        let item_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or_default();

        match item_type {
            "message" => {
                if let Some(content) = obj.get("content").and_then(|v| v.as_array()) {
                    for part in content {
                        let part_type = part
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if part_type == "output_text" {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                text_parts.push(text.to_string());
                            }
                        }
                    }
                }
            }
            "function_call" => {
                let call_id = obj
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .or_else(|| obj.get("id").and_then(|v| v.as_str()))
                    .unwrap_or_default()
                    .to_string();
                let name = obj
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let arguments = obj
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                tool_calls.push(ToolCall {
                    id: call_id,
                    call_type: "function".to_string(),
                    function: ToolCallFunction { name, arguments },
                });
            }
            _ => {}
        }
    }

    let tool_calls = if tool_calls.is_empty() {
        None
    } else {
        Some(tool_calls)
    };
    (text_parts.join(""), tool_calls)
}

#[derive(Default)]
struct ResponsesStreamState {
    // item_id -> (call_id, name, arguments)
    tools: std::collections::BTreeMap<String, (String, String, String)>,
    output_indices: std::collections::HashMap<usize, String>,
    saw_text: bool,
}

fn parse_stream_event<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|error| AQBotError::Provider(format!("Malformed Responses stream event: {error}")))
}

impl ResponsesStreamState {
    fn apply(&mut self, event: crate::SseEvent) -> Result<Option<ChatStreamChunk>> {
        let data = event.data.trim();
        if data.is_empty() {
            return Ok(None);
        }
        if data == "[DONE]" {
            return Err(incomplete_stream_error());
        }
        let json: serde_json::Value = serde_json::from_str(data).map_err(|error| {
            AQBotError::Provider(format!("Malformed Responses stream event: {error}"))
        })?;
        let event_type = if event.event.is_empty() {
            json.get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("")
        } else {
            event.event.as_str()
        };
        if event_type == "error"
            || event_type == "response.failed"
            || json.get("error").is_some_and(|error| !error.is_null())
        {
            let message = json
                .pointer("/response/error/message")
                .or_else(|| json.pointer("/response/status_details/error/message"))
                .or_else(|| json.pointer("/error/message"))
                .or_else(|| json.get("message"))
                .and_then(|value| value.as_str())
                .unwrap_or("Responses stream error");
            return Err(AQBotError::Provider(message.to_string()));
        }
        let chunk = match event_type {
            "response.output_text.delta" => {
                let evt: StreamTextDeltaEvent = parse_stream_event(json)?;
                let content = evt
                    .part
                    .and_then(|part| part.delta)
                    .or(evt.delta)
                    .ok_or_else(|| AQBotError::Provider("Missing Responses text delta".into()))?;
                self.saw_text |= !content.is_empty();
                ChatStreamChunk {
                    content: Some(content),
                    thinking: None,
                    done: false,
                    is_final: None,
                    usage: None,
                    tool_calls: None,
                    finish_reason: None,
                }
            }
            "response.reasoning.delta" | "response.reasoning_summary_text.delta" => {
                let evt: StreamReasoningDeltaEvent = parse_stream_event(json)?;
                let thinking = evt.delta.ok_or_else(|| {
                    AQBotError::Provider("Missing Responses reasoning delta".into())
                })?;
                ChatStreamChunk {
                    content: None,
                    thinking: Some(thinking),
                    done: false,
                    is_final: None,
                    usage: None,
                    tool_calls: None,
                    finish_reason: None,
                }
            }
            "response.output_item.added" => {
                let evt: StreamOutputItemAdded = parse_stream_event(json)?;
                let item = evt
                    .item
                    .ok_or_else(|| AQBotError::Provider("Missing Responses output item".into()))?;
                if item.r#type.as_deref() == Some("function_call") {
                    let item_id = item.id.ok_or_else(|| {
                        AQBotError::Provider("Missing Responses tool item ID".into())
                    })?;
                    let call_id = item.call_id.unwrap_or_else(|| item_id.clone());
                    let name = item.name.ok_or_else(|| {
                        AQBotError::Provider("Missing Responses tool name".into())
                    })?;
                    if let Some(index) = evt.output_index {
                        self.output_indices.insert(index, item_id.clone());
                    }
                    self.tools.insert(item_id, (call_id, name, String::new()));
                }
                return Ok(None);
            }
            "response.function_call_arguments.delta" => {
                let evt: StreamFunctionCallArgsDelta = parse_stream_event(json)?;
                let arguments = evt
                    .delta
                    .ok_or_else(|| AQBotError::Provider("Missing Responses tool delta".into()))?;
                self.tool_mut(evt.item_id, evt.output_index)?
                    .2
                    .push_str(&arguments);
                return Ok(None);
            }
            "response.function_call_arguments.done" => {
                let evt: StreamFunctionCallArgsDone = parse_stream_event(json)?;
                let arguments = evt.arguments.ok_or_else(|| {
                    AQBotError::Provider("Missing Responses tool arguments".into())
                })?;
                self.tool_mut(evt.item_id, evt.output_index)?.2 = arguments;
                return Ok(None);
            }
            "response.completed" | "response.incomplete" => {
                let reason = if event_type == "response.completed" {
                    ChatFinishReason::Stop
                } else {
                    match json
                        .pointer("/response/incomplete_details/reason")
                        .and_then(|value| value.as_str())
                    {
                        Some("max_output_tokens") => ChatFinishReason::OutputLimit,
                        Some("content_filter") => ChatFinishReason::ContentFilter,
                        _ => {
                            return Err(AQBotError::Provider(
                                "Unknown Responses incomplete reason".into(),
                            ))
                        }
                    }
                };
                return self.finish(parse_stream_event(json)?, reason).map(Some);
            }
            _ => return Ok(None),
        };
        Ok(Some(chunk))
    }

    fn tool_mut(
        &mut self,
        item_id: Option<String>,
        index: Option<usize>,
    ) -> Result<&mut (String, String, String)> {
        let id =
            item_id.or_else(|| index.and_then(|index| self.output_indices.get(&index).cloned()));
        id.as_ref()
            .and_then(|id| self.tools.get_mut(id))
            .ok_or_else(|| {
                AQBotError::Provider("Responses tool arguments arrived before tool item".into())
            })
    }

    fn finish(
        &mut self,
        event: StreamCompletedEvent,
        reason: ChatFinishReason,
    ) -> Result<ChatStreamChunk> {
        let (text, final_tools) = parse_response_output(&event.response.output);
        let mut tools: Vec<ToolCall> = std::mem::take(&mut self.tools)
            .into_values()
            .map(|(id, name, arguments)| ToolCall {
                id,
                call_type: "function".into(),
                function: ToolCallFunction { name, arguments },
            })
            .collect();
        for tool in final_tools.into_iter().flatten() {
            if let Some(existing) = tools.iter_mut().find(|existing| existing.id == tool.id) {
                *existing = tool;
            } else {
                tools.push(tool);
            }
        }
        let finish_reason = if reason == ChatFinishReason::Stop && !tools.is_empty() {
            ChatFinishReason::ToolCalls
        } else {
            reason
        };
        Ok(ChatStreamChunk {
            content: (!self.saw_text && !text.is_empty()).then_some(text),
            thinking: None,
            done: true,
            is_final: None,
            usage: event.response.usage.map(|usage| TokenUsage {
                prompt_tokens: usage.input_tokens,
                completion_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
            }),
            tool_calls: (!tools.is_empty()).then_some(tools),
            finish_reason: Some(finish_reason),
        })
    }
}

#[async_trait]
impl ProviderAdapter for OpenAIResponsesAdapter {
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse> {
        let url = Self::chat_url(ctx);
        let body = build_request(&request, false);

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
                "OpenAI Responses API error {status}: {text}"
            )));
        }

        let oai: ResponsesResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        let (content, tool_calls) = parse_response_output(&oai.output);

        let usage = oai
            .usage
            .map(|u| TokenUsage {
                prompt_tokens: u.input_tokens,
                completion_tokens: u.output_tokens,
                total_tokens: u.total_tokens,
            })
            .unwrap_or(TokenUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            });

        Ok(ChatResponse {
            id: oai.id.unwrap_or_default(),
            model: oai.model.unwrap_or_else(|| request.model.clone()),
            content,
            thinking: None,
            usage,
            tool_calls,
        })
    }

    fn chat_stream(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>> {
        let client = match self.get_client(ctx) {
            Ok(client) => client,
            Err(error) => return Box::pin(futures::stream::once(async move { Err(error) })),
        };
        let api_key = ctx.api_key.clone();
        let custom_headers = ctx.custom_headers.clone();
        let url = Self::chat_url(ctx);
        let body = build_request(&request, true);

        spawn_abortable_stream(move |tx| async move {
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
                        "OpenAI Responses API error {s}: {t}"
                    ))));
                    return;
                }
                Err(e) => {
                    let _ = tx
                        .unbounded_send(Err(AQBotError::Provider(format!("Request failed: {e}"))));
                    return;
                }
            };

            let events = crate::sse::parse_sse_stream(resp.bytes_stream());
            futures::pin_mut!(events);
            let mut state = ResponsesStreamState::default();
            while let Some(event) = events.next().await {
                match event.and_then(|event| state.apply(event)) {
                    Ok(Some(chunk)) => {
                        let done = chunk.done;
                        if tx.unbounded_send(Ok(chunk)).is_err() || done {
                            return;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let _ = tx.unbounded_send(Err(error));
                        return;
                    }
                }
            }
            let _ = tx.unbounded_send(Err(incomplete_stream_error()));
        })
    }

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>> {
        let url = resolve_models_url(&Self::base_url(ctx));

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

        let models: ModelsResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        Ok(models
            .data
            .into_iter()
            .map(|m| {
                let (model_type, capabilities) = infer_model_type_and_capabilities(&m.id, &m.id);
                Model {
                    provider_id: ctx.provider_id.clone(),
                    model_id: m.id.clone(),
                    name: m.id,
                    group_name: None,
                    model_type,
                    capabilities,
                    context_window: None,
                    max_output_tokens: None,
                    enabled: true,
                    param_overrides: None,
                    image_config: None,
                    metadata_state: None,
                    aliases: Vec::new(),
                }
            })
            .collect())
    }

    async fn embed(
        &self,
        ctx: &ProviderRequestContext,
        request: EmbedRequest,
    ) -> Result<EmbedResponse> {
        let url = format!("{}/embeddings", Self::base_url(ctx));
        let body = EmbedReq {
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
        .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!("OpenAI API error {s}: {t}")));
        }

        let result: EmbedResp = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        let dimensions = result.data.first().map(|d| d.embedding.len()).unwrap_or(0);
        let embeddings: Vec<Vec<f32>> = result.data.into_iter().map(|d| d.embedding).collect();

        Ok(EmbedResponse {
            embeddings,
            dimensions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_messages_become_instructions() {
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text("You are helpful.".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("Hello".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
        ];

        let (input, instructions) = build_responses_input(&messages);
        assert_eq!(instructions.as_deref(), Some("You are helpful."));
        let arr = input.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["role"], "user");
        assert_eq!(arr[0]["content"], "Hello");
    }

    #[test]
    fn tool_call_messages_convert_correctly() {
        let messages = vec![
            ChatMessage {
                role: "assistant".to_string(),
                content: ChatContent::Text("".to_string()),
                reasoning_content: None,
                tool_calls: Some(vec![ToolCall {
                    id: "call_1".to_string(),
                    call_type: "function".to_string(),
                    function: ToolCallFunction {
                        name: "get_weather".to_string(),
                        arguments: r#"{"city":"SF"}"#.to_string(),
                    },
                }]),
                tool_call_id: None,
            },
            ChatMessage {
                role: "tool".to_string(),
                content: ChatContent::Text("Sunny, 72F".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: Some("call_1".to_string()),
            },
        ];

        let (input, _) = build_responses_input(&messages);
        let arr = input.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "function_call");
        assert_eq!(arr[0]["name"], "get_weather");
        assert_eq!(arr[1]["type"], "function_call_output");
        assert_eq!(arr[1]["call_id"], "call_1");
        assert_eq!(arr[1]["output"], "Sunny, 72F");
    }

    #[test]
    fn parse_response_extracts_text_and_tool_calls() {
        let output = vec![
            json!({
                "type": "message",
                "content": [
                    { "type": "output_text", "text": "Hello!" }
                ]
            }),
            json!({
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "search",
                "arguments": "{\"q\":\"test\"}"
            }),
        ];

        let (text, tool_calls) = parse_response_output(&output);
        assert_eq!(text, "Hello!");
        let tcs = tool_calls.unwrap();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].function.name, "search");
    }

    #[test]
    fn build_request_maps_max_tokens_to_max_output_tokens() {
        let request = ChatRequest {
            model: "gpt-5".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hi".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: Some(0.7),
            top_p: None,
            max_tokens: Some(100),
            tools: None,
            thinking_budget: None,
            thinking_level: None,
            reasoning_profile: None,
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        };
        let built = build_request(&request, false);
        assert_eq!(built.max_output_tokens, Some(100));
        assert_eq!(built.temperature, Some(0.7));
        assert!(!built.stream);
    }

    #[test]
    fn build_request_enforces_min_max_output_tokens() {
        let request = ChatRequest {
            model: "gpt-5".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hi".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: None,
            top_p: None,
            max_tokens: Some(1),
            tools: None,
            thinking_budget: None,
            thinking_level: None,
            reasoning_profile: None,
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        };
        let built = build_request(&request, false);
        assert_eq!(built.max_output_tokens, Some(16));
    }

    #[test]
    fn build_request_uses_explicit_reasoning_level_over_legacy_budget() {
        let request = ChatRequest {
            model: "gpt-5.5".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hi".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: Some(0.7),
            top_p: Some(0.9),
            max_tokens: Some(100),
            tools: None,
            thinking_budget: Some(4096),
            thinking_level: Some("xhigh".to_string()),
            reasoning_profile: Some("openai_responses_reasoning".to_string()),
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        };
        let built = build_request(&request, false);
        let reasoning = built.reasoning.expect("reasoning should be sent");
        assert_eq!(reasoning.effort, "xhigh");
        assert_eq!(reasoning.summary.as_deref(), Some("auto"));
        assert_eq!(built.temperature, None);
        assert_eq!(built.top_p, None);
    }

    #[test]
    fn gpt_5_6_max_serializes_as_nested_reasoning_with_auto_summary_for_responses() {
        let request = ChatRequest {
            model: "gpt-5.6".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hi".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: Some(0.7),
            top_p: Some(0.9),
            max_tokens: Some(100),
            tools: None,
            thinking_budget: None,
            thinking_level: Some("max".to_string()),
            reasoning_profile: Some("openai_responses_reasoning".to_string()),
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        };

        let body = build_request(&request, false);
        let serialized = serde_json::to_value(body).expect("request json");

        assert_eq!(
            serialized["reasoning"],
            json!({ "effort": "max", "summary": "auto" })
        );
        assert!(serialized.get("reasoning_effort").is_none());
    }
}
