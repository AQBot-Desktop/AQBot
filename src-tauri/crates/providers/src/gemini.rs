use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

use crate::{build_http_client, parse_base64_data_url, ProviderAdapter, ProviderRequestContext};

const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

pub struct GeminiAdapter {
    client: reqwest::Client,
}

impl GeminiAdapter {
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

    fn get_client(&self, ctx: &ProviderRequestContext) -> Result<reqwest::Client> {
        match &ctx.proxy_config {
            Some(c) if c.proxy_type.as_deref() != Some("none") => build_http_client(Some(c)),
            _ => Ok(self.client.clone()),
        }
    }
}

// --- Internal types ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<GeminiGenerationConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<GeminiToolDeclaration>>,
}

#[derive(Serialize, Deserialize)]
struct GeminiContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    parts: Vec<GeminiPart>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inline_data: Option<GeminiInlineData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_call: Option<GeminiFunctionCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_response: Option<GeminiFunctionResponse>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiFunctionCall {
    name: String,
    args: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiFunctionResponse {
    name: String,
    response: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiInlineData {
    mime_type: String,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiGenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_config: Option<GeminiThinkingConfig>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiThinkingConfig {
    thinking_budget: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
    usage_metadata: Option<GeminiUsageMetadata>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiUsageMetadata {
    prompt_token_count: Option<u32>,
    candidates_token_count: Option<u32>,
    total_token_count: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModelsResponse {
    models: Option<Vec<GeminiModel>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModel {
    name: String,
    display_name: Option<String>,
    supported_generation_methods: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiToolDeclaration {
    function_declarations: Vec<GeminiFunctionDeclaration>,
}

#[derive(Serialize)]
struct GeminiFunctionDeclaration {
    name: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<serde_json::Value>,
}

fn convert_tools_to_gemini(tools: &Option<Vec<ChatTool>>) -> Option<Vec<GeminiToolDeclaration>> {
    tools.as_ref().map(|ts| {
        vec![GeminiToolDeclaration {
            function_declarations: ts
                .iter()
                .map(|t| GeminiFunctionDeclaration {
                    name: t.function.name.clone(),
                    description: t.function.description.clone().unwrap_or_default(),
                    parameters: t.function.parameters.clone(),
                })
                .collect(),
        }]
    })
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

fn convert_messages(messages: &[ChatMessage]) -> (Option<GeminiContent>, Vec<GeminiContent>) {
    let mut system_instruction = None;
    let mut contents = Vec::new();

    // Pre-build a map from tool_call_id to function name for Gemini's functionResponse
    let mut tool_id_to_name: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for msg in messages {
        if let Some(ref tcs) = msg.tool_calls {
            for tc in tcs {
                tool_id_to_name.insert(tc.id.clone(), tc.function.name.clone());
            }
        }
    }

    for msg in messages {
        if msg.role == "system" {
            let parts = match &msg.content {
                ChatContent::Text(text) => vec![GeminiPart {
                    text: Some(text.clone()),
                    inline_data: None,
                    function_call: None,
                    function_response: None,
                }],
                ChatContent::Multipart(parts) => parts
                    .iter()
                    .filter_map(|p| {
                        if let Some(text) = &p.text {
                            Some(GeminiPart {
                                text: Some(text.clone()),
                                inline_data: None,
                                function_call: None,
                                function_response: None,
                            })
                        } else if let Some(img) = &p.image_url {
                            parse_base64_data_url(&img.url).map(|(mime_type, data)| GeminiPart {
                                text: None,
                                inline_data: Some(GeminiInlineData { mime_type, data }),
                                function_call: None,
                                function_response: None,
                            })
                        } else {
                            None
                        }
                    })
                    .collect(),
            };
            system_instruction = Some(GeminiContent { role: None, parts });
            continue;
        }

        match msg.role.as_str() {
            "tool" => {
                // Gemini needs the function NAME, not the call ID
                // Look up the actual name from the tool_call_id → name map
                let tool_name = msg
                    .tool_call_id
                    .as_deref()
                    .and_then(|id| tool_id_to_name.get(id).map(|s| s.as_str()))
                    .unwrap_or("unknown");
                let result_value: serde_json::Value = serde_json::from_str(&extract_text_content(
                    &msg.content,
                ))
                .unwrap_or(serde_json::json!({ "result": extract_text_content(&msg.content) }));
                contents.push(GeminiContent {
                    role: Some("user".to_string()),
                    parts: vec![GeminiPart {
                        text: None,
                        inline_data: None,
                        function_call: None,
                        function_response: Some(GeminiFunctionResponse {
                            name: tool_name.to_string(),
                            response: result_value,
                        }),
                    }],
                });
            }
            "assistant" if msg.tool_calls.is_some() => {
                let mut parts = Vec::new();
                let text = extract_text_content(&msg.content);
                if !text.is_empty() {
                    parts.push(GeminiPart {
                        text: Some(text),
                        inline_data: None,
                        function_call: None,
                        function_response: None,
                    });
                }
                if let Some(ref tcs) = msg.tool_calls {
                    for tc in tcs {
                        let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                        parts.push(GeminiPart {
                            text: None,
                            inline_data: None,
                            function_call: Some(GeminiFunctionCall {
                                name: tc.function.name.clone(),
                                args,
                            }),
                            function_response: None,
                        });
                    }
                }
                contents.push(GeminiContent {
                    role: Some("model".to_string()),
                    parts,
                });
            }
            _ => {
                let parts = match &msg.content {
                    ChatContent::Text(text) => vec![GeminiPart {
                        text: Some(text.clone()),
                        inline_data: None,
                        function_call: None,
                        function_response: None,
                    }],
                    ChatContent::Multipart(parts) => parts
                        .iter()
                        .filter_map(|p| {
                            if let Some(text) = &p.text {
                                Some(GeminiPart {
                                    text: Some(text.clone()),
                                    inline_data: None,
                                    function_call: None,
                                    function_response: None,
                                })
                            } else if let Some(img) = &p.image_url {
                                parse_base64_data_url(&img.url).map(|(mime_type, data)| {
                                    GeminiPart {
                                        text: None,
                                        inline_data: Some(GeminiInlineData { mime_type, data }),
                                        function_call: None,
                                        function_response: None,
                                    }
                                })
                            } else {
                                None
                            }
                        })
                        .collect(),
                };

                let role = match msg.role.as_str() {
                    "assistant" => "model",
                    other => other,
                };

                contents.push(GeminiContent {
                    role: Some(role.to_string()),
                    parts,
                });
            }
        }
    }

    (system_instruction, contents)
}

fn make_gen_config(request: &ChatRequest) -> Option<GeminiGenerationConfig> {
    let thinking_config = request.thinking_budget.and_then(|b| {
        if b == 0 {
            None
        } else {
            Some(GeminiThinkingConfig { thinking_budget: b })
        }
    });
    if request.temperature.is_some()
        || request.top_p.is_some()
        || request.max_tokens.is_some()
        || thinking_config.is_some()
    {
        Some(GeminiGenerationConfig {
            temperature: request.temperature,
            top_p: request.top_p,
            max_output_tokens: request.max_tokens,
            thinking_config,
        })
    } else {
        None
    }
}

fn usage_from_meta(meta: Option<GeminiUsageMetadata>) -> TokenUsage {
    meta.map(|u| TokenUsage {
        prompt_tokens: u.prompt_token_count.unwrap_or(0),
        completion_tokens: u.candidates_token_count.unwrap_or(0),
        total_tokens: u.total_token_count.unwrap_or(0),
    })
    .unwrap_or(TokenUsage {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn convert_messages_keeps_inline_image_parts() {
        let (_, contents) = convert_messages(&[ChatMessage {
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
            serde_json::to_value(&contents[0]).unwrap(),
            json!({
                "role": "user",
                "parts": [
                    { "text": "Describe this image" },
                    {
                        "inlineData": {
                            "mimeType": "image/png",
                            "data": "YWJj"
                        }
                    }
                ]
            })
        );
    }
}

fn simple_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("gemini-{ts:x}")
}

#[async_trait]
impl ProviderAdapter for GeminiAdapter {
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse> {
        let base_url = Self::base_url(ctx);
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            base_url, request.model, ctx.api_key
        );

        let (system_instruction, contents) = convert_messages(&request.messages);
        let body = GeminiRequest {
            contents,
            system_instruction,
            generation_config: make_gen_config(&request),
            tools: convert_tools_to_gemini(&request.tools),
        };

        let resp = crate::apply_request_headers(self.get_client(ctx)?.post(&url).json(&body), ctx)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!("Gemini API error {s}: {t}")));
        }

        let gr: GeminiResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        let parts = gr
            .candidates
            .as_ref()
            .and_then(|c| c.first())
            .and_then(|c| c.content.as_ref())
            .map(|c| &c.parts);

        let mut content = String::new();
        let mut tool_calls: Vec<aqbot_core::types::ToolCall> = Vec::new();

        if let Some(parts) = parts {
            for part in parts {
                if let Some(ref text) = part.text {
                    content.push_str(text);
                }
                if let Some(ref fc) = part.function_call {
                    tool_calls.push(aqbot_core::types::ToolCall {
                        id: format!(
                            "gemini_{}",
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_nanos())
                                .unwrap_or(0)
                        ),
                        call_type: "function".to_string(),
                        function: aqbot_core::types::ToolCallFunction {
                            name: fc.name.clone(),
                            arguments: serde_json::to_string(&fc.args).unwrap_or_default(),
                        },
                    });
                }
            }
        }

        Ok(ChatResponse {
            id: simple_id(),
            model: request.model,
            content,
            thinking: None,
            usage: usage_from_meta(gr.usage_metadata),
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
        let base_url = Self::base_url(ctx);
        let url = format!(
            "{}/models/{}:streamGenerateContent?alt=sse&key={}",
            base_url, request.model, api_key
        );

        let (system_instruction, contents) = convert_messages(&request.messages);
        let body = GeminiRequest {
            contents,
            system_instruction,
            generation_config: make_gen_config(&request),
            tools: convert_tools_to_gemini(&request.tools),
        };

        let (tx, rx) = futures::channel::mpsc::unbounded();

        tokio::spawn(async move {
            let resp = match crate::apply_headers_to_request(
                client.post(&url).json(&body),
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
                        "Gemini API error {s}: {t}"
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

                            if let Ok(gr) = serde_json::from_str::<GeminiResponse>(data) {
                                let parts = gr
                                    .candidates
                                    .as_ref()
                                    .and_then(|c| c.first())
                                    .and_then(|c| c.content.as_ref())
                                    .map(|c| &c.parts);

                                let mut content: Option<String> = None;
                                let mut tool_calls_vec: Vec<aqbot_core::types::ToolCall> =
                                    Vec::new();

                                if let Some(parts) = parts {
                                    for part in parts {
                                        if let Some(ref text) = part.text {
                                            content = Some(text.clone());
                                        }
                                        if let Some(ref fc) = part.function_call {
                                            tool_calls_vec.push(aqbot_core::types::ToolCall {
                                                id: format!(
                                                    "gemini_{}",
                                                    std::time::SystemTime::now()
                                                        .duration_since(std::time::UNIX_EPOCH)
                                                        .map(|d| d.as_nanos())
                                                        .unwrap_or(0)
                                                ),
                                                call_type: "function".to_string(),
                                                function: aqbot_core::types::ToolCallFunction {
                                                    name: fc.name.clone(),
                                                    arguments: serde_json::to_string(&fc.args)
                                                        .unwrap_or_default(),
                                                },
                                            });
                                        }
                                    }
                                }

                                let tool_calls = if tool_calls_vec.is_empty() {
                                    None
                                } else {
                                    Some(tool_calls_vec)
                                };

                                let usage = gr.usage_metadata.map(|u| TokenUsage {
                                    prompt_tokens: u.prompt_token_count.unwrap_or(0),
                                    completion_tokens: u.candidates_token_count.unwrap_or(0),
                                    total_tokens: u.total_token_count.unwrap_or(0),
                                });

                                let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                    content,
                                    thinking: None,
                                    done: false,
                                    is_final: None,
                                    usage,
                                    tool_calls,
                                }));
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
        let url = format!("{}/models?key={}", Self::base_url(ctx), ctx.api_key);

        let resp = crate::apply_request_headers(self.get_client(ctx)?.get(&url), ctx)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!("Gemini API error {s}: {t}")));
        }

        let models: GeminiModelsResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        Ok(models
            .models
            .unwrap_or_default()
            .into_iter()
            .map(|m| {
                let model_id = m
                    .name
                    .strip_prefix("models/")
                    .unwrap_or(&m.name)
                    .to_string();
                let name = m.display_name.unwrap_or_else(|| model_id.clone());
                let model_type = ModelType::detect(&model_id);
                let mut caps = match model_type {
                    ModelType::Chat => vec![ModelCapability::TextChat],
                    ModelType::Embedding => vec![],
                    ModelType::Voice => vec![ModelCapability::RealtimeVoice],
                };
                if model_id.contains("pro") || model_id.contains("flash") {
                    caps.push(ModelCapability::Vision);
                }
                Model {
                    provider_id: ctx.provider_id.clone(),
                    model_id: model_id.clone(),
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

    async fn embed(
        &self,
        ctx: &ProviderRequestContext,
        request: EmbedRequest,
    ) -> Result<EmbedResponse> {
        let base_url = Self::base_url(ctx);
        let url = format!(
            "{}/models/{}:batchEmbedContents?key={}",
            base_url, request.model, ctx.api_key
        );

        let requests: Vec<serde_json::Value> = request
            .input
            .iter()
            .map(|text| {
                let mut req = serde_json::json!({
                    "model": format!("models/{}", request.model),
                    "content": { "parts": [{ "text": text }] }
                });
                if let Some(dims) = request.dimensions {
                    req["outputDimensionality"] = serde_json::json!(dims);
                }
                req
            })
            .collect();

        let body = serde_json::json!({ "requests": requests });

        let resp = crate::apply_request_headers(self.get_client(ctx)?.post(&url).json(&body), ctx)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Gemini embed request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "Gemini embed API error {s}: {t}"
            )));
        }

        #[derive(Deserialize)]
        struct GeminiBatchEmbedResponse {
            embeddings: Vec<GeminiEmbedValues>,
        }
        #[derive(Deserialize)]
        struct GeminiEmbedValues {
            values: Vec<f32>,
        }

        let result: GeminiBatchEmbedResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Gemini embed parse error: {e}")))?;

        let dimensions = result
            .embeddings
            .first()
            .map(|e| e.values.len())
            .unwrap_or(0);
        let embeddings: Vec<Vec<f32>> = result.embeddings.into_iter().map(|e| e.values).collect();

        Ok(EmbedResponse {
            embeddings,
            dimensions,
        })
    }
}
