use serde::{Deserialize, Serialize};

// === Chat Streaming Types ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ChatTool>>,
    /// Optional thinking/reasoning token budget. Mapped to provider-specific fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budget: Option<u32>,
    /// Optional model-specific reasoning level key, e.g. none/minimal/low/high/xhigh/max.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    /// Optional model/provider reasoning profile for payload serialization.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_profile: Option<String>,
    /// When true, send `max_completion_tokens` instead of `max_tokens` (OpenAI o-series).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_max_completion_tokens: Option<bool>,
    /// Thinking parameter format: "reasoning_effort" (default) or "enable_thinking" (SiliconFlow).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_param_style: Option<String>,
    /// Extra JSON body fields flattened into OpenAI-compatible chat requests.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_body: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTool {
    pub r#type: String,
    pub function: ChatToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolFunction {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
}

/// A single tool call requested by the AI model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    /// Provider-assigned ID (e.g., "call_abc123")
    pub id: String,
    /// Always "function" for now
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    /// JSON-encoded arguments string
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: ChatContent,
    /// Provider-native reasoning/thinking content for APIs that require it in history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    /// For assistant messages: tool calls the model wants to make
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// For tool-result messages: the ID of the tool call this responds to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatContent {
    Text(String),
    Multipart(Vec<ContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentPart {
    pub r#type: String,
    pub text: Option<String>,
    pub image_url: Option<ImageUrl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub id: String,
    pub model: String,
    pub content: String,
    pub thinking: Option<String>,
    pub usage: TokenUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatFinishReason {
    Stop,
    ToolCalls,
    OutputLimit,
    ContentFilter,
    Other,
}

impl ChatFinishReason {
    pub fn from_openai(reason: &str) -> Self {
        match reason {
            "stop" => Self::Stop,
            "length" => Self::OutputLimit,
            "content_filter" => Self::ContentFilter,
            "tool_calls" | "function_call" => Self::ToolCalls,
            _ => Self::Other,
        }
    }

    pub fn from_gemini(reason: &str) -> Self {
        match reason {
            "STOP" => Self::Stop,
            "MAX_TOKENS" => Self::OutputLimit,
            "SAFETY" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "RECITATION" => {
                Self::ContentFilter
            }
            _ => Self::Other,
        }
    }

    pub fn from_anthropic(reason: &str) -> Self {
        match reason {
            "end_turn" | "stop_sequence" => Self::Stop,
            "max_tokens" => Self::OutputLimit,
            "tool_use" => Self::ToolCalls,
            "refusal" => Self::ContentFilter,
            _ => Self::Other,
        }
    }

    pub fn from_bedrock(reason: &str) -> Self {
        match reason {
            "end_turn" | "stop_sequence" => Self::Stop,
            "max_tokens" => Self::OutputLimit,
            "tool_use" => Self::ToolCalls,
            "content_filtered" | "guardrail_intervened" => Self::ContentFilter,
            _ => Self::Other,
        }
    }

    pub fn as_openai_str(self) -> Option<&'static str> {
        Some(match self {
            Self::Stop => "stop",
            Self::ToolCalls => "tool_calls",
            Self::OutputLimit => "length",
            Self::ContentFilter => "content_filter",
            Self::Other => return None,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatStreamChunk {
    pub content: Option<String>,
    pub thinking: Option<String>,
    /// The provider protocol terminated and trailing usage has been consumed.
    /// Output limits still end the protocol; callers decide whether output is complete.
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_final: Option<bool>,
    pub usage: Option<TokenUsage>,
    /// Tool calls requested by the model (populated on the final content chunk or a dedicated chunk)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// Normalized provider reason, carried only by the terminal chunk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<ChatFinishReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStreamEvent {
    pub conversation_id: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub chunk: ChatStreamChunk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStreamErrorEvent {
    pub conversation_id: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationTitleUpdatedEvent {
    pub conversation_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationTitleGeneratingEvent {
    pub conversation_id: String,
    pub generating: bool,
    /// Error message if generation failed
    pub error: Option<String>,
}
