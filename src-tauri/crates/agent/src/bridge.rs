//! AQBotProviderBridge: adapts AQBot's ProviderAdapter to the SDK's LLMProvider trait.

use async_trait::async_trait;
use futures::StreamExt;
use open_agent_sdk::api::provider::ProviderRequest;
use open_agent_sdk::api::ApiError;
use open_agent_sdk::types::{ImageContentSource, ToolResultContentBlock};
use open_agent_sdk::{
    ApiType, ContentBlock, LLMProvider, Message, MessageRole, ProviderResponse, SDKMessage, Usage,
};

use aqbot_core::types::{
    ChatContent, ChatMessage, ChatRequest, ChatTool, ChatToolFunction, ContentPart, ImageUrl,
    ModelParamOverrides, TokenUsage, ToolCall, ToolCallFunction,
};
use aqbot_providers::{ProviderAdapter, ProviderRequestContext};
use serde_json::Value;
use std::sync::Arc;

/// Bridge between AQBot providers and the open-agent-sdk LLMProvider interface.
pub struct AQBotProviderBridge {
    adapter: Arc<dyn ProviderAdapter>,
    ctx: ProviderRequestContext,
    api_type: ApiType,
    model_param_overrides: Option<ModelParamOverrides>,
    app: Option<tauri::AppHandle>,
    conversation_id: Option<String>,
}

impl AQBotProviderBridge {
    pub fn new(
        adapter: Arc<dyn ProviderAdapter>,
        ctx: ProviderRequestContext,
        provider_type: &str,
    ) -> Result<Self, String> {
        let api_type = match provider_type {
            "anthropic" => ApiType::AnthropicMessages,
            "openai" => ApiType::OpenAICompletions,
            "gemini" => ApiType::OpenAICompletions,
            "custom" => ApiType::OpenAICompletions,
            "openai_responses" => ApiType::OpenAICompletions,
            "deepseek" => ApiType::OpenAICompletions,
            "xai" => ApiType::OpenAICompletions,
            "glm" => ApiType::OpenAICompletions,
            "siliconflow" => ApiType::OpenAICompletions,
            other => {
                tracing::warn!(
                    "Unknown provider type '{}', defaulting to OpenAI compat",
                    other
                );
                ApiType::OpenAICompletions
            }
        };

        Ok(Self {
            adapter,
            ctx,
            api_type,
            model_param_overrides: None,
            app: None,
            conversation_id: None,
        })
    }

    pub fn with_model_param_overrides(mut self, overrides: Option<ModelParamOverrides>) -> Self {
        self.model_param_overrides = overrides;
        self
    }

    /// Attach a Tauri AppHandle for streaming text chunks to the frontend.
    pub fn with_app(mut self, app: tauri::AppHandle, conversation_id: String) -> Self {
        self.app = Some(app);
        self.conversation_id = Some(conversation_id);
        self
    }
}

#[async_trait]
impl LLMProvider for AQBotProviderBridge {
    fn api_type(&self) -> ApiType {
        self.api_type.clone()
    }

    async fn create_message(
        &self,
        request: ProviderRequest<'_>,
        stream_tx: Option<tokio::sync::mpsc::Sender<SDKMessage>>,
    ) -> Result<ProviderResponse, ApiError> {
        let chat_request = convert_request(request, self.model_param_overrides.as_ref());

        let mut stream = self.adapter.chat_stream(&self.ctx, chat_request);
        let mut accumulated_text = String::new();
        let mut accumulated_thinking = String::new();
        let mut final_tool_calls: Option<Vec<ToolCall>> = None;
        let mut final_usage: Option<TokenUsage> = None;

        while let Some(result) = stream.next().await {
            match result {
                Ok(chunk) => {
                    if let Some(ref text) = chunk.content {
                        if !text.is_empty() {
                            accumulated_text.push_str(text);

                            // Emit streaming text delta via SDK channel
                            // (agent.rs will forward to frontend as agent-stream-text)
                            if let Some(ref tx) = stream_tx {
                                let _ = tx.try_send(SDKMessage::TextDelta { text: text.clone() });
                            }
                        }
                    }

                    if let Some(ref thinking) = chunk.thinking {
                        if !thinking.is_empty() {
                            accumulated_thinking.push_str(thinking);

                            // Emit streaming thinking delta via SDK channel
                            // (agent.rs will forward to frontend as agent-stream-thinking)
                            if let Some(ref tx) = stream_tx {
                                let _ = tx.try_send(SDKMessage::ThinkingDelta {
                                    thinking: thinking.clone(),
                                });
                            }
                        }
                    }

                    if chunk.tool_calls.is_some() {
                        final_tool_calls.clone_from(&chunk.tool_calls);
                    }

                    if chunk.usage.is_some() {
                        final_usage.clone_from(&chunk.usage);
                    }

                    if chunk.done {
                        break;
                    }
                }
                Err(e) => {
                    return Err(classify_provider_error(e));
                }
            }
        }

        let usage = final_usage.unwrap_or(TokenUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        });

        let response = aqbot_core::types::ChatResponse {
            id: String::new(),
            model: String::new(),
            content: accumulated_text,
            thinking: if accumulated_thinking.is_empty() {
                None
            } else {
                Some(accumulated_thinking)
            },
            usage,
            tool_calls: final_tool_calls,
        };

        Ok(convert_response(response))
    }
}

// ---------------------------------------------------------------------------
// SDK ProviderRequest → AQBot ChatRequest
// ---------------------------------------------------------------------------

fn convert_request(
    request: ProviderRequest<'_>,
    model_param_overrides: Option<&ModelParamOverrides>,
) -> ChatRequest {
    let messages: Vec<ChatMessage> = request
        .messages
        .iter()
        .flat_map(convert_sdk_message_to_chat_messages)
        .collect();

    let tools: Option<Vec<ChatTool>> = request.tools.as_ref().map(|tools| {
        tools
            .iter()
            .map(|t| ChatTool {
                r#type: "function".to_string(),
                function: ChatToolFunction {
                    name: t.name.clone(),
                    description: Some(t.description.clone()),
                    parameters: Some(t.input_schema.clone()),
                },
            })
            .collect()
    });

    let system_text: Option<String> = request.system.as_ref().map(|blocks| {
        blocks
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    });

    let mut final_messages = Vec::new();
    if let Some(sys) = system_text {
        final_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(sys),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }
    final_messages.extend(messages);

    let max_tokens = if request.max_tokens > 0 {
        Some(request.max_tokens as u32)
    } else {
        model_param_overrides.and_then(|overrides| {
            overrides.max_tokens.or_else(|| {
                overrides
                    .force_max_tokens
                    .filter(|force| *force)
                    .map(|_| 4096)
            })
        })
    };

    ChatRequest {
        model: request.model.to_string(),
        messages: final_messages,
        stream: true,
        temperature: None,
        top_p: None,
        max_tokens,
        tools,
        thinking_budget: request
            .thinking
            .as_ref()
            .and_then(|t| t.budget_tokens.map(|b| b as u32)),
        thinking_level: None,
        reasoning_profile: model_param_overrides
            .and_then(|overrides| overrides.reasoning_profile.clone()),
        use_max_completion_tokens: model_param_overrides
            .and_then(|overrides| overrides.use_max_completion_tokens),
        thinking_param_style: model_param_overrides
            .and_then(|overrides| overrides.thinking_param_style.clone()),
    }
}

/// Convert a single SDK Message into one or more AQBot ChatMessages.
/// ToolResult content blocks become separate tool-role messages.
fn convert_sdk_message_to_chat_messages(msg: &Message) -> Vec<ChatMessage> {
    let role = match msg.role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
    };

    let mut text_parts: Vec<String> = Vec::new();
    let mut thinking_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut tool_results: Vec<(String, String)> = Vec::new();
    let mut image_parts: Vec<ImageContentSource> = Vec::new();

    for block in &msg.content {
        match block {
            ContentBlock::Text { text } => {
                text_parts.push(text.clone());
            }
            ContentBlock::ToolUse { id, name, input } => {
                tool_calls.push(ToolCall {
                    id: id.clone(),
                    call_type: "function".to_string(),
                    function: ToolCallFunction {
                        name: name.clone(),
                        arguments: serde_json::to_string(input).unwrap_or_default(),
                    },
                });
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error: _,
            } => {
                let text = content
                    .iter()
                    .filter_map(|c| match c {
                        ToolResultContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                tool_results.push((tool_use_id.clone(), text));
            }
            ContentBlock::Thinking { thinking, .. } => {
                if msg.role == MessageRole::Assistant && !thinking.is_empty() {
                    thinking_parts.push(thinking.clone());
                }
            }
            ContentBlock::Image { source } => {
                image_parts.push(source.clone());
            }
        }
    }

    let mut result = Vec::new();

    if role == "assistant" {
        let content = if text_parts.is_empty() {
            ChatContent::Text(String::new())
        } else {
            ChatContent::Text(text_parts.join(""))
        };

        result.push(ChatMessage {
            role: "assistant".to_string(),
            content,
            reasoning_content: if thinking_parts.is_empty() {
                None
            } else {
                Some(thinking_parts.join(""))
            },
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
            tool_call_id: None,
        });
    } else if !tool_results.is_empty() {
        for (tool_use_id, text) in tool_results {
            result.push(ChatMessage {
                role: "tool".to_string(),
                content: ChatContent::Text(text),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: Some(tool_use_id),
            });
        }
    } else {
        let content = if !image_parts.is_empty() {
            let mut parts: Vec<ContentPart> = text_parts
                .iter()
                .map(|t| ContentPart {
                    r#type: "text".to_string(),
                    text: Some(t.clone()),
                    image_url: None,
                })
                .collect();
            for img in &image_parts {
                parts.push(ContentPart {
                    r#type: "image_url".to_string(),
                    text: None,
                    image_url: Some(ImageUrl {
                        url: format!("data:{};base64,{}", img.media_type, img.data),
                    }),
                });
            }
            ChatContent::Multipart(parts)
        } else {
            ChatContent::Text(text_parts.join(""))
        };

        result.push(ChatMessage {
            role: role.to_string(),
            content,
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }

    result
}

// ---------------------------------------------------------------------------
// AQBot ChatResponse → SDK ProviderResponse
// ---------------------------------------------------------------------------

fn convert_response(response: aqbot_core::types::ChatResponse) -> ProviderResponse {
    let mut content_blocks: Vec<ContentBlock> = Vec::new();

    if let Some(thinking) = &response.thinking {
        if !thinking.is_empty() {
            content_blocks.push(ContentBlock::Thinking {
                thinking: thinking.clone(),
                signature: None,
            });
        }
    }

    if !response.content.is_empty() {
        content_blocks.push(ContentBlock::Text {
            text: response.content.clone(),
        });
    }

    if let Some(tool_calls) = &response.tool_calls {
        for tc in tool_calls {
            let input: Value = serde_json::from_str(&tc.function.arguments).unwrap_or(Value::Null);
            content_blocks.push(ContentBlock::ToolUse {
                id: tc.id.clone(),
                name: tc.function.name.clone(),
                input,
            });
        }
    }

    let stop_reason = if response
        .tool_calls
        .as_ref()
        .map_or(false, |tc| !tc.is_empty())
    {
        Some("tool_use".to_string())
    } else {
        Some("end_turn".to_string())
    };

    ProviderResponse {
        message: Message {
            role: MessageRole::Assistant,
            content: content_blocks,
        },
        usage: Usage {
            input_tokens: response.usage.prompt_tokens as u64,
            output_tokens: response.usage.completion_tokens as u64,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
        stop_reason,
    }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/// Parse an HTTP status code from provider error messages like "OpenAI API error 400 Bad Request: ..."
fn parse_http_status(err: &str) -> Option<u16> {
    for pattern in &["API error ", "error "] {
        if let Some(pos) = err.find(pattern) {
            let after = &err[pos + pattern.len()..];
            if let Some(end) = after.find(|c: char| !c.is_ascii_digit()) {
                if end > 0 {
                    if let Ok(status) = after[..end].parse::<u16>() {
                        if (100..600).contains(&status) {
                            return Some(status);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Classify a provider error into the appropriate SDK ApiError variant,
/// so the retry logic only retries truly transient errors.
fn classify_provider_error(e: aqbot_core::error::AQBotError) -> ApiError {
    let err_str = e.to_string();
    if let Some(status) = parse_http_status(&err_str) {
        if status == 401 || status == 403 {
            ApiError::AuthError(err_str)
        } else if status == 429 {
            ApiError::RateLimitError
        } else if (400..500).contains(&status) {
            // Client errors (400, 404, 422, etc.) are NOT retryable
            ApiError::HttpError {
                status,
                message: err_str,
            }
        } else {
            // 5xx errors are retryable via NetworkError mapping
            ApiError::NetworkError(err_str)
        }
    } else {
        ApiError::NetworkError(err_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use open_agent_sdk::api::provider::ProviderRequest;

    fn param_overrides() -> ModelParamOverrides {
        ModelParamOverrides {
            temperature: None,
            max_tokens: Some(2048),
            top_p: None,
            frequency_penalty: None,
            use_max_completion_tokens: Some(false),
            no_system_role: None,
            force_max_tokens: None,
            thinking_param_style: Some("enable_thinking".to_string()),
            reasoning_profile: Some("siliconflow_enable_thinking".to_string()),
            reasoning_options: None,
            reasoning_default: None,
        }
    }

    #[test]
    fn convert_request_applies_model_param_overrides() {
        let messages = vec![Message {
            role: MessageRole::User,
            content: vec![ContentBlock::Text {
                text: "hello".to_string(),
            }],
        }];
        let request = ProviderRequest {
            model: "deepseek-reasoner",
            max_tokens: 0,
            messages: &messages,
            system: None,
            tools: None,
            thinking: None,
        };

        let converted = convert_request(request, Some(&param_overrides()));

        assert_eq!(converted.max_tokens, Some(2048));
        assert_eq!(
            converted.reasoning_profile.as_deref(),
            Some("siliconflow_enable_thinking")
        );
        assert_eq!(converted.use_max_completion_tokens, Some(false));
        assert_eq!(
            converted.thinking_param_style.as_deref(),
            Some("enable_thinking")
        );
    }

    #[test]
    fn convert_request_prefers_sdk_max_tokens_over_model_default() {
        let messages = vec![Message {
            role: MessageRole::User,
            content: vec![ContentBlock::Text {
                text: "hello".to_string(),
            }],
        }];
        let request = ProviderRequest {
            model: "deepseek-reasoner",
            max_tokens: 8192,
            messages: &messages,
            system: None,
            tools: None,
            thinking: None,
        };

        let converted = convert_request(request, Some(&param_overrides()));

        assert_eq!(converted.max_tokens, Some(8192));
    }

    #[test]
    fn assistant_thinking_block_becomes_reasoning_content() {
        let message = Message {
            role: MessageRole::Assistant,
            content: vec![
                ContentBlock::Thinking {
                    thinking: "hidden reasoning".to_string(),
                    signature: None,
                },
                ContentBlock::Text {
                    text: "final answer".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "call-1".to_string(),
                    name: "read_file".to_string(),
                    input: serde_json::json!({"path": "README.md"}),
                },
            ],
        };

        let converted = convert_sdk_message_to_chat_messages(&message);

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0].reasoning_content.as_deref(),
            Some("hidden reasoning")
        );
        assert!(converted[0].tool_calls.is_some());
    }
}
