use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

use crate::{build_http_client, resolve_chat_url, ProviderAdapter, ProviderRequestContext};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAIResponsesAdapter {
    client: reqwest::Client,
}

impl OpenAIResponsesAdapter {
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
    input_tokens: u32,
    output_tokens: u32,
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
    response: Option<ResponsesResponse>,
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
                    item.insert(
                        "content".to_string(),
                        serde_json::Value::String(text),
                    );
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

    let reasoning = request.thinking_budget.map(|b| {
        let effort = match b {
            0 => "none",
            1..=2048 => "low",
            2049..=6144 => "medium",
            6145..=12288 => "high",
            _ => "xhigh",
        };
        ResponsesReasoning {
            effort: effort.to_string(),
            summary: if effort == "none" { None } else { Some("auto".to_string()) },
        }
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
        let item_type = obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

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
        let client = self.get_client(ctx).unwrap_or_else(|_| self.client.clone());
        let api_key = ctx.api_key.clone();
        let custom_headers = ctx.custom_headers.clone();
        let url = Self::chat_url(ctx);
        let body = build_request(&request, true);

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

            let mut byte_stream = resp.bytes_stream();
            let mut buf = String::new();
            let mut current_event_type = String::new();
            // Track function calls: item_id → (call_id, name, arguments)
            let mut pending_tool_calls: std::collections::HashMap<
                String,
                (String, String, String),
            > = std::collections::HashMap::new();
            // Track output_index → item_id for fallback when item_id is missing from delta events
            let mut index_to_item_id: std::collections::HashMap<usize, String> =
                std::collections::HashMap::new();

            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end().to_string();
                            buf = buf[pos + 1..].to_string();

                            if line.is_empty() {
                                current_event_type.clear();
                                continue;
                            }

                            if let Some(event_type) = line.strip_prefix("event: ") {
                                current_event_type = event_type.trim().to_string();
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
                                            .values()
                                            .map(|(call_id, name, args)| ToolCall {
                                                id: call_id.clone(),
                                                call_type: "function".to_string(),
                                                function: ToolCallFunction {
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
                                return;
                            }

                            match current_event_type.as_str() {
                                "response.output_text.delta" => {
                                    if let Ok(evt) =
                                        serde_json::from_str::<StreamTextDeltaEvent>(data)
                                    {
                                        let delta_text =
                                            evt.part.and_then(|p| p.delta).or(evt.delta);
                                        if delta_text.is_some() {
                                            let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                                content: delta_text,
                                                thinking: None,
                                                done: false,
                                                is_final: None,
                                                usage: None,
                                                tool_calls: None,
                                            }));
                                        }
                                    }
                                }
                                "response.reasoning.delta"
                                | "response.reasoning_summary_text.delta" => {
                                    if let Ok(evt) =
                                        serde_json::from_str::<StreamReasoningDeltaEvent>(data)
                                    {
                                        if evt.delta.is_some() {
                                            let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                                content: None,
                                                thinking: evt.delta,
                                                done: false,
                                                is_final: None,
                                                usage: None,
                                                tool_calls: None,
                                            }));
                                        }
                                    }
                                }
                                "response.output_item.added" => {
                                    if let Ok(evt) =
                                        serde_json::from_str::<StreamOutputItemAdded>(data)
                                    {
                                        if let Some(item) = evt.item {
                                            if item.r#type.as_deref() == Some("function_call") {
                                                let item_id = item.id.unwrap_or_default();
                                                let call_id =
                                                    item.call_id.unwrap_or_else(|| item_id.clone());
                                                let name = item.name.unwrap_or_default();
                                                if let Some(idx) = evt.output_index {
                                                    index_to_item_id
                                                        .insert(idx, item_id.clone());
                                                }
                                                pending_tool_calls.insert(
                                                    item_id,
                                                    (call_id, name, String::new()),
                                                );
                                            }
                                        }
                                    }
                                }
                                "response.function_call_arguments.delta" => {
                                    if let Ok(evt) =
                                        serde_json::from_str::<StreamFunctionCallArgsDelta>(data)
                                    {
                                        // Resolve item_id: prefer explicit, fallback to output_index mapping
                                        let resolved_id = evt.item_id.clone().or_else(|| {
                                            evt.output_index
                                                .and_then(|idx| index_to_item_id.get(&idx).cloned())
                                        });
                                        if let Some(item_id) = &resolved_id {
                                            if let Some(entry) = pending_tool_calls.get_mut(item_id)
                                            {
                                                if let Some(ref d) = evt.delta {
                                                    entry.2.push_str(d);
                                                }
                                            }
                                        }
                                    }
                                }
                                "response.function_call_arguments.done" => {
                                    if let Ok(evt) =
                                        serde_json::from_str::<StreamFunctionCallArgsDone>(data)
                                    {
                                        let resolved_id = evt.item_id.clone().or_else(|| {
                                            evt.output_index
                                                .and_then(|idx| index_to_item_id.get(&idx).cloned())
                                        });
                                        if let (Some(item_id), Some(args)) =
                                            (&resolved_id, &evt.arguments)
                                        {
                                            if let Some(entry) = pending_tool_calls.get_mut(item_id)
                                            {
                                                entry.2 = args.clone();
                                            }
                                        }
                                    }
                                }
                                "response.completed" => {
                                    // Try full deserialization first
                                    let (usage, mut extra_tool_calls) =
                                        if let Ok(evt) =
                                            serde_json::from_str::<StreamCompletedEvent>(data)
                                        {
                                            let usage =
                                                evt.response.as_ref().and_then(|r| r.usage.as_ref()).map(
                                                    |u| TokenUsage {
                                                        prompt_tokens: u.input_tokens,
                                                        completion_tokens: u.output_tokens,
                                                        total_tokens: u.total_tokens,
                                                    },
                                                );
                                            // Extract function_call items from response.output as fallback
                                            let fc_from_output: Vec<ToolCall> = evt
                                                .response
                                                .as_ref()
                                                .map(|r| {
                                                    r.output
                                                        .iter()
                                                        .filter_map(|item| {
                                                            let obj = item.as_object()?;
                                                            if obj.get("type")?.as_str()? != "function_call" {
                                                                return None;
                                                            }
                                                            let call_id = obj
                                                                .get("call_id")
                                                                .and_then(|v| v.as_str())
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
                                                            Some(ToolCall {
                                                                id: call_id,
                                                                call_type: "function".to_string(),
                                                                function: ToolCallFunction {
                                                                    name,
                                                                    arguments,
                                                                },
                                                            })
                                                        })
                                                        .collect()
                                                })
                                                .unwrap_or_default();
                                            (usage, fc_from_output)
                                        } else {
                                            tracing::warn!(
                                                "[responses] Failed to deserialize response.completed event"
                                            );
                                            (None, Vec::new())
                                        };

                                    // Merge: pending_tool_calls (from streaming) take priority,
                                    // then fill from response.output for any missed ones
                                    let tool_calls = if !pending_tool_calls.is_empty() {
                                        let mut tcs: Vec<ToolCall> = pending_tool_calls
                                            .drain()
                                            .map(|(_, (call_id, name, args))| ToolCall {
                                                id: call_id,
                                                call_type: "function".to_string(),
                                                function: ToolCallFunction {
                                                    name,
                                                    arguments: args,
                                                },
                                            })
                                            .collect();
                                        // Add any from response.output not already present
                                        for fc in extra_tool_calls.drain(..) {
                                            if !tcs.iter().any(|t| t.id == fc.id) {
                                                tcs.push(fc);
                                            }
                                        }
                                        Some(tcs)
                                    } else if !extra_tool_calls.is_empty() {
                                        Some(extra_tool_calls)
                                    } else {
                                        None
                                    };

                                    let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                        content: None,
                                        thinking: None,
                                        done: true,
                                        is_final: None,
                                        usage,
                                        tool_calls,
                                    }));
                                    return;
                                }
                                "response.failed" | "response.incomplete" => {
                                    // Extract error message if possible
                                    let err_msg = serde_json::from_str::<serde_json::Value>(data)
                                        .ok()
                                        .and_then(|v| {
                                            v.get("response")
                                                .and_then(|r| r.get("status_details"))
                                                .and_then(|sd| sd.get("error"))
                                                .and_then(|e| e.get("message"))
                                                .and_then(|m| m.as_str())
                                                .map(|s| s.to_string())
                                        })
                                        .unwrap_or_else(|| {
                                            format!("Response {}", current_event_type.replace("response.", ""))
                                        });
                                    tracing::error!(
                                        "[responses] {}: {}",
                                        current_event_type,
                                        err_msg
                                    );
                                    let _ = tx.unbounded_send(Err(AQBotError::Provider(err_msg)));
                                    return;
                                }
                                // Known event types we intentionally skip
                                "response.created"
                                | "response.in_progress"
                                | "response.output_item.done"
                                | "response.output_text.done"
                                | "response.content_part.added"
                                | "response.content_part.done"
                                | "response.reasoning.done"
                                | "response.reasoning_summary_text.done"
                                | "response.reasoning_summary_part.added"
                                | "response.reasoning_summary_part.done"
                                | "response.function_call_arguments.delta.done" => {}
                                _ => {
                                    if !current_event_type.is_empty() {
                                        tracing::debug!(
                                            "[responses] Unhandled event type: {}",
                                            current_event_type
                                        );
                                    }
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

            // Stream ended without explicit completion event
            let tool_calls = if pending_tool_calls.is_empty() {
                None
            } else {
                Some(
                    pending_tool_calls
                        .drain()
                        .map(|(_, (call_id, name, args))| ToolCall {
                            id: call_id,
                            call_type: "function".to_string(),
                            function: ToolCallFunction {
                                name,
                                arguments: args,
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

        let models: ModelsResponse = resp
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
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("Hello".to_string()),
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
            ResponsesOutputItem {
                r#type: "message".to_string(),
                content: vec![ResponsesContentPart {
                    r#type: "output_text".to_string(),
                    text: Some("Hello!".to_string()),
                }],
                id: None,
                call_id: None,
                name: None,
                arguments: None,
            },
            ResponsesOutputItem {
                r#type: "function_call".to_string(),
                content: vec![],
                id: Some("fc_1".to_string()),
                call_id: Some("call_1".to_string()),
                name: Some("search".to_string()),
                arguments: Some(r#"{"q":"test"}"#.to_string()),
            },
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
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: Some(0.7),
            top_p: None,
            max_tokens: Some(100),
            tools: None,
            thinking_budget: None,
            use_max_completion_tokens: None,
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
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: None,
            top_p: None,
            max_tokens: Some(1),
            tools: None,
            thinking_budget: None,
            use_max_completion_tokens: None,
        };
        let built = build_request(&request, false);
        assert_eq!(built.max_output_tokens, Some(16));
    }
}
