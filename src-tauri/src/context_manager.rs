//! Context manager for conversation history compression.
//!
//! Two modes:
//! - **Sliding window** (compression OFF): trims oldest messages to fit the token budget.
//! - **Compression** (manual or auto): all messages are compressed into an LLM summary,
//!   a `<!-- context-compressed -->` marker is inserted, and subsequent sends use
//!   the summary + only messages after the marker.

use aqbot_core::token_counter;
use aqbot_core::types::{ChatContent, ChatMessage};

/// Fraction of context window that triggers auto-compression (70%).
const THRESHOLD_RATIO: f64 = 0.70;

/// Content string for the compression marker message.
pub const COMPRESSION_MARKER: &str = "<!-- context-compressed -->";

/// Estimate the token count of a single `ChatMessage`.
pub fn message_tokens(msg: &ChatMessage) -> usize {
    let text = match &msg.content {
        ChatContent::Text(s) => s.as_str(),
        ChatContent::Multipart(parts) => {
            return token_counter::estimate_tokens(
                &parts
                    .iter()
                    .filter_map(|p| p.text.as_deref())
                    .collect::<Vec<_>>()
                    .join(" "),
            ) + parts.iter().filter(|p| p.image_url.is_some()).count() * 85
                + 4;
        }
    };
    token_counter::estimate_message_tokens(&msg.role, text)
}

/// Check whether the current context exceeds the auto-compression threshold.
///
/// Returns `true` if total tokens (system + history) > model_context_window * 0.70.
///
/// When `model_context_window` is `None` (model has no configured limit), always
/// returns `false` — we never auto-compress without a known budget.
pub fn should_auto_compress(
    system_messages: &[ChatMessage],
    history_messages: &[ChatMessage],
    model_context_window: Option<u32>,
) -> bool {
    let context_window = match model_context_window {
        Some(v) => v as usize,
        None => return false,
    };
    let threshold = (context_window as f64 * THRESHOLD_RATIO) as usize;

    let total: usize = system_messages
        .iter()
        .chain(history_messages.iter())
        .map(|m| message_tokens(m))
        .sum();

    total > threshold
}

/// Build the final context for LLM from system messages + optional summary + history.
///
/// If a summary exists, it is prepended as a system message.
/// Sliding window is applied only when `model_context_window` is `Some`.
/// When the model has no configured limit, all history messages are included.
pub fn build_context(
    system_messages: &[ChatMessage],
    history_messages: &[ChatMessage],
    existing_summary: Option<&str>,
    model_context_window: Option<u32>,
) -> Vec<ChatMessage> {
    let mut out = system_messages.to_vec();

    // Insert summary as a system message if present
    if let Some(summary_text) = existing_summary {
        out.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(format!(
                "[对话历史摘要 / Conversation History Summary]\n{}",
                summary_text
            )),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }

    match model_context_window {
        Some(ctx_window) => {
            let budget = (ctx_window as f64 * THRESHOLD_RATIO) as usize;
            let system_tokens: usize = out.iter().map(|m| message_tokens(m)).sum();
            let available = budget.saturating_sub(system_tokens);
            let trimmed = sliding_window(history_messages, available);
            out.extend(trimmed);
        }
        None => {
            // No known context limit — include all history messages
            out.extend(history_messages.iter().cloned());
        }
    }

    out
}

/// Sliding window: keep as many recent messages as fit within `budget` tokens.
/// Always includes at least the last message to prevent the current user input
/// from being silently dropped.
fn sliding_window(history: &[ChatMessage], budget: usize) -> Vec<ChatMessage> {
    if history.is_empty() {
        return Vec::new();
    }

    let mut total = 0usize;
    let mut start_idx = history.len();

    for (i, msg) in history.iter().enumerate().rev() {
        let tokens = message_tokens(msg);
        if total + tokens > budget {
            break;
        }
        total += tokens;
        start_idx = i;
    }

    // Always include at least the last message
    if start_idx == history.len() {
        start_idx = history.len() - 1;
    }

    history[start_idx..].to_vec()
}

/// Messages that need to be summarized (passed to LLM).
pub struct SummarizationRequest {
    /// Existing summary to merge with, if any.
    pub existing_summary: Option<String>,
    /// Messages to incorporate into the summary.
    pub messages_to_compress: Vec<ChatMessage>,
}

/// Build the LLM prompt for generating a conversation summary.
pub fn build_summary_prompt(request: &SummarizationRequest) -> Vec<ChatMessage> {
    let mut messages = Vec::new();

    let instruction = if request.existing_summary.is_some() {
        "你是一个对话摘要助手。请将以下新增对话内容合并到已有摘要中。\n\n\
         要求：\n\
         1. 保留所有用户明确表达的需求、偏好和决策\n\
         2. 保留关键技术细节（代码片段、配置、错误信息等）\n\
         3. 保留待办事项和未解决的问题\n\
         4. 用简洁的要点形式组织\n\
         5. 如果有冲突信息，以最新的为准\n\
         6. 保持摘要简洁，不超过 500 字"
    } else {
        "你是一个对话摘要助手。请将以下对话历史压缩为简洁摘要。\n\n\
         要求：\n\
         1. 保留所有用户明确表达的需求、偏好和决策\n\
         2. 保留关键技术细节（代码片段、配置、错误信息等）\n\
         3. 保留待办事项和未解决的问题\n\
         4. 用简洁的要点形式组织\n\
         5. 保持摘要简洁，不超过 500 字"
    };

    messages.push(ChatMessage {
        role: "system".to_string(),
        content: ChatContent::Text(instruction.to_string()),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    });

    if let Some(ref summary) = request.existing_summary {
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: ChatContent::Text(format!("已有摘要：\n{}", summary)),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }

    let conversation_text: Vec<String> = request
        .messages_to_compress
        .iter()
        .map(|m| {
            let content_text = match &m.content {
                ChatContent::Text(s) => s.clone(),
                ChatContent::Multipart(parts) => parts
                    .iter()
                    .filter_map(|p| p.text.as_deref())
                    .collect::<Vec<_>>()
                    .join(" "),
            };
            let truncated = if content_text.len() > 2000 {
                format!("{}...[已截断]", &content_text[..2000])
            } else {
                content_text
            };
            format!("{}: {}", m.role, truncated)
        })
        .collect();

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: ChatContent::Text(format!(
            "{}对话内容：\n{}",
            if request.existing_summary.is_some() {
                "新增"
            } else {
                ""
            },
            conversation_text.join("\n")
        )),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    });

    messages
}

/// Build summary prompt with a custom system instruction (from settings).
pub fn build_summary_prompt_with_custom(
    request: &SummarizationRequest,
    custom_prompt: &str,
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();

    messages.push(ChatMessage {
        role: "system".to_string(),
        content: ChatContent::Text(custom_prompt.to_string()),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    });

    if let Some(ref summary) = request.existing_summary {
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: ChatContent::Text(format!("已有摘要：\n{}", summary)),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }

    let conversation_text: Vec<String> = request
        .messages_to_compress
        .iter()
        .map(|m| {
            let content_text = match &m.content {
                ChatContent::Text(s) => s.clone(),
                ChatContent::Multipart(parts) => parts
                    .iter()
                    .filter_map(|p| p.text.as_deref())
                    .collect::<Vec<_>>()
                    .join(" "),
            };
            let truncated = if content_text.len() > 2000 {
                format!("{}...[已截断]", &content_text[..2000])
            } else {
                content_text
            };
            format!("{}: {}", m.role, truncated)
        })
        .collect();

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: ChatContent::Text(format!(
            "{}对话内容：\n{}",
            if request.existing_summary.is_some() {
                "新增"
            } else {
                ""
            },
            conversation_text.join("\n")
        )),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    });

    messages
}
