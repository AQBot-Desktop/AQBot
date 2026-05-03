use crate::AppState;
use aqbot_core::types::*;
use aqbot_providers::{
    registry::ProviderRegistry, resolve_base_url_for_type, ProviderAdapter, ProviderRequestContext,
};
use base64::Engine;
use sea_orm::*;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{Emitter, State};

fn provider_type_to_registry_key(pt: &ProviderType) -> &'static str {
    match pt {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Custom => "openai", // Custom providers use OpenAI-compatible API
    }
}

/// Resolve effective system prompt with priority: Conversation → Category → Global Default
async fn resolve_system_prompt(
    db: &DatabaseConnection,
    conversation: &Conversation,
) -> Option<String> {
    // 1. Conversation-level system prompt (highest priority)
    if let Some(s) = &conversation.system_prompt {
        if !s.is_empty() {
            return Some(s.clone());
        }
    }

    // 2. Category-level system prompt (middle priority)
    if let Some(ref cat_id) = conversation.category_id {
        if let Ok(categories) =
            aqbot_core::repo::conversation_category::list_conversation_categories(db).await
        {
            if let Some(cat) = categories.iter().find(|c| &c.id == cat_id) {
                if let Some(ref s) = cat.system_prompt {
                    if !s.is_empty() {
                        return Some(s.clone());
                    }
                }
            }
        }
    }

    // 3. Global default system prompt (lowest priority)
    let settings = aqbot_core::repo::settings::get_settings(db)
        .await
        .unwrap_or_default();
    settings.default_system_prompt.filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct EffectiveChatModelParams {
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_tokens: Option<u32>,
}

fn resolve_chat_model_params(
    conversation: &Conversation,
    model_param_overrides: Option<&ModelParamOverrides>,
    settings: &AppSettings,
    force_max_tokens: Option<bool>,
) -> EffectiveChatModelParams {
    let temperature = conversation
        .temperature
        .or_else(|| model_param_overrides.and_then(|p| p.temperature))
        .or(settings.default_temperature)
        .map(|v| v as f64);
    let top_p = conversation
        .top_p
        .or_else(|| model_param_overrides.and_then(|p| p.top_p))
        .or(settings.default_top_p)
        .map(|v| v as f64);
    let max_tokens = conversation
        .max_tokens
        .or_else(|| model_param_overrides.and_then(|p| p.max_tokens))
        .or(settings.default_max_tokens)
        .or_else(|| (force_max_tokens == Some(true)).then_some(4096));

    EffectiveChatModelParams {
        temperature,
        top_p,
        max_tokens,
    }
}

async fn persist_attachments(
    state: &AppState,
    conversation_id: &str,
    attachments: &[AttachmentInput],
) -> aqbot_core::error::Result<Vec<Attachment>> {
    aqbot_core::storage_paths::ensure_documents_dirs()?;
    let file_store = aqbot_core::file_store::FileStore::new();

    let mut persisted = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let data = base64::engine::general_purpose::STANDARD
            .decode(&attachment.data)
            .map_err(|e| {
                aqbot_core::error::AQBotError::Validation(format!(
                    "Invalid attachment base64 for {}: {}",
                    attachment.file_name, e
                ))
            })?;
        let saved = file_store.save_file(&data, &attachment.file_name, &attachment.file_type)?;
        let stored_file_id = aqbot_core::utils::gen_id();
        aqbot_core::repo::stored_file::create_stored_file(
            &state.sea_db,
            &stored_file_id,
            &saved.hash,
            &attachment.file_name,
            &attachment.file_type,
            saved.size_bytes,
            &saved.storage_path,
            Some(conversation_id),
        )
        .await?;

        persisted.push(Attachment {
            id: stored_file_id,
            file_type: attachment.file_type.clone(),
            file_name: attachment.file_name.clone(),
            file_path: saved.storage_path,
            file_size: attachment.file_size,
            data: None,
        });
    }

    Ok(persisted)
}

/// Strip `<think ...>...</think>` blocks from content (all variants).
fn strip_think_tags(content: &str) -> String {
    let mut s = content.to_string();
    loop {
        if let Some(start) = s.find("<think") {
            // Ensure it's a tag (next char is '>' or ' ')
            let after_tag = &s[start + 6..];
            let is_tag = after_tag.starts_with('>') || after_tag.starts_with(' ');
            if !is_tag {
                break;
            }
            if let Some(end_offset) = s[start..].find("</think>") {
                let end = start + end_offset + "</think>".len();
                let before = s[..start].trim_end_matches('\n');
                let after = s[end..].trim_start_matches('\n');
                s = format!("{}{}", before, after);
                continue;
            }
        }
        break;
    }
    s
}

fn extract_think_blocks(content: &str) -> Option<String> {
    let mut remaining = content;
    let mut blocks = Vec::new();

    while let Some(start) = remaining.find("<think") {
        let after_tag_name = &remaining[start + 6..];
        let is_tag = after_tag_name.starts_with('>') || after_tag_name.starts_with(' ');
        if !is_tag {
            break;
        }

        let Some(open_end_offset) = remaining[start..].find('>') else {
            break;
        };
        let content_start = start + open_end_offset + 1;
        let Some(close_offset) = remaining[content_start..].find("</think>") else {
            break;
        };

        let block = remaining[content_start..content_start + close_offset].trim();
        if !block.is_empty() {
            blocks.push(block.to_string());
        }
        remaining = &remaining[content_start + close_offset + "</think>".len()..];
    }

    if blocks.is_empty() {
        None
    } else {
        Some(blocks.join("\n\n"))
    }
}

#[derive(Default)]
struct DisabledThinkingStripState {
    in_think_block: bool,
    trailing_fragment: String,
}

fn think_tag_partial_suffix_len(input: &str, tag: &str) -> usize {
    let max_len = input.len().min(tag.len().saturating_sub(1));
    for len in (1..=max_len).rev() {
        if input.ends_with(&tag[..len]) {
            return len;
        }
    }
    0
}

fn strip_disabled_thinking_content(content: &str) -> String {
    strip_think_tags(content)
}

fn strip_disabled_thinking_delta(delta: &str, state: &mut DisabledThinkingStripState) -> String {
    if delta.is_empty() && state.trailing_fragment.is_empty() {
        return String::new();
    }

    let mut combined = std::mem::take(&mut state.trailing_fragment);
    combined.push_str(delta);

    const THINK_OPEN: &str = "<think";
    const THINK_CLOSE: &str = "</think>";

    let mut stripped = String::with_capacity(combined.len());
    let mut cursor = 0usize;

    loop {
        if cursor >= combined.len() {
            return stripped;
        }

        if state.in_think_block {
            if let Some(end_offset) = combined[cursor..].find(THINK_CLOSE) {
                cursor += end_offset + THINK_CLOSE.len();
                state.in_think_block = false;
                continue;
            }

            let remaining = &combined[cursor..];
            let suffix_len = think_tag_partial_suffix_len(remaining, THINK_CLOSE);
            if suffix_len > 0 {
                state.trailing_fragment = remaining[remaining.len() - suffix_len..].to_string();
            }
            return stripped;
        }

        if let Some(start_offset) = combined[cursor..].find(THINK_OPEN) {
            let start = cursor + start_offset;
            stripped.push_str(&combined[cursor..start]);

            let after_tag = &combined[start + THINK_OPEN.len()..];
            let is_tag = after_tag.starts_with('>') || after_tag.starts_with(' ');
            if !is_tag {
                stripped.push_str(THINK_OPEN);
                cursor = start + THINK_OPEN.len();
                continue;
            }

            if let Some(close_offset) = combined[start..].find('>') {
                cursor = start + close_offset + 1;
                state.in_think_block = true;
                continue;
            }

            state.trailing_fragment = combined[start..].to_string();
            return stripped;
        }

        let remaining = &combined[cursor..];
        let suffix_len = think_tag_partial_suffix_len(remaining, THINK_OPEN);
        if suffix_len > 0 {
            let safe_len = remaining.len() - suffix_len;
            stripped.push_str(&remaining[..safe_len]);
            state.trailing_fragment = remaining[safe_len..].to_string();
        } else {
            stripped.push_str(remaining);
        }
        return stripped;
    }
}

/// Strip display-only tags from assistant message content so they aren't sent to the AI.
/// Strips: `<knowledge-retrieval data-aqbot="1">` and `<memory-retrieval data-aqbot="1">` tags,
/// `:::mcp ... :::` fenced blocks, and `<think>...</think>` blocks.
fn strip_display_tags(content: &str) -> String {
    // Strip <think> blocks first
    let content = strip_think_tags(content);
    // Strip knowledge-retrieval and memory-retrieval tags with data-aqbot attribute
    let content = {
        let mut s = content.to_string();
        for tag_name in &["knowledge-retrieval", "memory-retrieval"] {
            let tag_start = format!("<{} ", tag_name);
            let tag_end = format!("</{}>", tag_name);
            while let Some(start_pos) = s.find(&tag_start) {
                let rest = &s[start_pos + tag_start.len()..];
                if rest.contains("data-aqbot=") {
                    if let Some(end_offset) = s[start_pos..].find(&tag_end) {
                        let after = &s[start_pos + end_offset + tag_end.len()..];
                        let before = &s[..start_pos];
                        s = format!(
                            "{}{}",
                            before.trim_end_matches('\n'),
                            after.trim_start_matches('\n')
                        );
                        continue;
                    }
                }
                break;
            }
        }
        s
    };

    // Strip :::mcp blocks
    let mut result = String::with_capacity(content.len());
    let mut remaining = content.as_str();
    while let Some(start) = remaining.find(":::mcp ") {
        // Only match at start of line
        let at_line_start = start == 0 || remaining.as_bytes().get(start - 1) == Some(&b'\n');
        if !at_line_start {
            result.push_str(&remaining[..start + 7]);
            remaining = &remaining[start + 7..];
            continue;
        }
        result.push_str(remaining[..start].trim_end_matches('\n'));
        // Find the closing :::
        if let Some(end_offset) = remaining[start..].find("\n:::\n") {
            remaining = &remaining[start + end_offset + 4..]; // skip past \n:::\n
        } else if remaining[start..].ends_with("\n:::") {
            remaining = "";
        } else {
            // No closing fence found — keep the content
            result.push_str(&remaining[start..]);
            remaining = "";
        }
    }
    result.push_str(remaining);
    let trimmed = result.trim().to_string();
    if trimmed.is_empty() && !content.trim().is_empty() {
        // If stripping removed everything, return empty (content was all display tags)
        String::new()
    } else {
        trimmed
    }
}

fn build_message_content(
    file_store: &aqbot_core::file_store::FileStore,
    message: &Message,
) -> aqbot_core::error::Result<ChatContent> {
    // Strip display-only tags from assistant messages
    let content = if message.role == MessageRole::Assistant {
        strip_display_tags(&message.content)
    } else {
        message.content.clone()
    };

    let image_attachments = message
        .attachments
        .iter()
        .filter(|attachment| attachment.file_type.starts_with("image/"))
        .collect::<Vec<_>>();

    if image_attachments.is_empty() {
        return Ok(ChatContent::Text(content));
    }

    let mut parts = Vec::new();
    if !content.is_empty() {
        parts.push(ContentPart {
            r#type: "text".to_string(),
            text: Some(content.clone()),
            image_url: None,
        });
    }

    for attachment in image_attachments {
        let data_url = if attachment.file_path.is_empty() {
            let base64_data = attachment.data.as_ref().ok_or_else(|| {
                aqbot_core::error::AQBotError::Validation(format!(
                    "Attachment {} is missing both file_path and inline data",
                    attachment.file_name
                ))
            })?;
            format!("data:{};base64,{}", attachment.file_type, base64_data)
        } else {
            match file_store.read_file(&attachment.file_path) {
                Ok(data) => format!(
                    "data:{};base64,{}",
                    attachment.file_type,
                    base64::engine::general_purpose::STANDARD.encode(data)
                ),
                Err(_) => continue, // skip deleted/missing attachments
            }
        };
        parts.push(ContentPart {
            r#type: "image_url".to_string(),
            text: None,
            image_url: Some(ImageUrl { url: data_url }),
        });
    }

    // If only text part remains (all images were missing), simplify to Text
    if parts.len() <= 1 && parts.iter().all(|p| p.r#type == "text") {
        return Ok(ChatContent::Text(content));
    }

    Ok(ChatContent::Multipart(parts))
}

fn chat_message_from_message(
    file_store: &aqbot_core::file_store::FileStore,
    message: &Message,
) -> aqbot_core::error::Result<ChatMessage> {
    let tool_calls: Option<Vec<ToolCall>> = message
        .tool_calls_json
        .as_ref()
        .and_then(|s| serde_json::from_str(s).ok());

    Ok(ChatMessage {
        role: match message.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::System => "system",
            MessageRole::Tool => "tool",
        }
        .to_string(),
        content: build_message_content(file_store, message)?,
        reasoning_content: if message.role == MessageRole::Assistant {
            extract_think_blocks(&message.content)
        } else {
            None
        },
        tool_calls,
        tool_call_id: message.tool_call_id.clone(),
    })
}

#[tauri::command]
pub async fn list_conversations(state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    aqbot_core::repo::conversation::list_conversations(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    title: String,
    model_id: String,
    provider_id: String,
    system_prompt: Option<String>,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::create_conversation(
        &state.sea_db,
        &title,
        &model_id,
        &provider_id,
        system_prompt.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation(
    state: State<'_, AppState>,
    id: String,
    input: UpdateConversationInput,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::update_conversation(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    delete_conversation_with_attachments(&state.sea_db, &id).await
}

#[tauri::command]
pub async fn branch_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    until_message_id: String,
    as_child: bool,
    title: Option<String>,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::branch_conversation(
        &state.sea_db,
        &conversation_id,
        &until_message_id,
        as_child,
        title.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

async fn delete_conversation_with_attachments(
    db: &sea_orm::DatabaseConnection,
    conversation_id: &str,
) -> Result<(), String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    delete_conversation_with_attachments_using(db, &file_store, conversation_id).await
}

async fn delete_conversation_with_attachments_using(
    db: &sea_orm::DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    conversation_id: &str,
) -> Result<(), String> {
    let files =
        aqbot_core::repo::stored_file::list_stored_files_by_conversation(db, conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    for file in files {
        super::file_cleanup::delete_attachment_reference(db, file_store, &file.id).await?;
    }

    aqbot_core::repo::conversation::delete_conversation(db, conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_conversations(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<ConversationSearchResult>, String> {
    aqbot_core::repo::conversation::search_conversations(&state.sea_db, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_pin_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::toggle_pin(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_archive_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::toggle_archive(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_archived_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<Conversation>, String> {
    aqbot_core::repo::conversation::list_archived_conversations(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

async fn consume_stream(
    app: &tauri::AppHandle,
    stream: &mut std::pin::Pin<
        Box<dyn futures::Stream<Item = aqbot_core::error::Result<ChatStreamChunk>> + Send>,
    >,
    conversation_id: &str,
    message_id: &str,
    model_id: &str,
    provider_id: &str,
    cancel_flag: &AtomicBool,
    suppress_thinking: bool,
) -> (
    String, // full_content (includes <think> blocks)
    Option<TokenUsage>,
    Option<Vec<ToolCall>>,
    Option<String>, // stream_error
    Option<f64>,    // tokens_per_second
    Option<i64>,    // first_token_latency_ms
) {
    use futures::StreamExt;
    let mut full_content = String::new();
    let mut final_usage: Option<TokenUsage> = None;
    let mut final_tool_calls: Option<Vec<ToolCall>> = None;
    let mut stream_error: Option<String> = None;

    let stream_start = std::time::Instant::now();
    let mut first_token_time: Option<std::time::Instant> = None;

    // Track <think> block state for merging thinking into content
    let mut in_thinking_block = false;
    let mut thinking_block_start: Option<std::time::Instant> = None;
    let mut thinking_durations: Vec<u64> = Vec::new();
    let mut disabled_thinking_strip_state = DisabledThinkingStripState::default();

    while let Some(result) = stream.next().await {
        // Check for cancellation
        if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
            tracing::info!("[consume_stream] Cancelled by user");
            break;
        }
        match result {
            Ok(chunk) => {
                let is_done = chunk.done;
                let content_delta = chunk.content.as_deref().map(|content| {
                    if suppress_thinking {
                        strip_disabled_thinking_delta(content, &mut disabled_thinking_strip_state)
                    } else {
                        content.to_string()
                    }
                });
                let thinking_delta = if suppress_thinking {
                    None
                } else {
                    chunk.thinking.clone()
                };

                // Build the emitted chunk with thinking merged into content
                let mut emit_content = String::new();
                let mut emit_thinking_signal: Option<String> = None;

                // Handle thinking chunks → merge into content with <think> tags
                // Uses <think data-aq> to distinguish our injected blocks from
                // upstream <think> tags (e.g. DeepSeek returns <think> in content)
                if let Some(ref t) = thinking_delta {
                    if !t.is_empty() {
                        if first_token_time.is_none() {
                            first_token_time = Some(std::time::Instant::now());
                        }
                        if !in_thinking_block {
                            // Ensure blank line before <think> so markdown parser treats it as a separate block
                            if !full_content.is_empty() {
                                emit_content.push_str("\n\n");
                            }
                            emit_content.push_str("<think data-aqbot=\"1\">\n");
                            in_thinking_block = true;
                            thinking_block_start = Some(std::time::Instant::now());
                        }
                        emit_content.push_str(t);
                        emit_thinking_signal = Some(String::new()); // signal: thinking active
                    }
                }

                // Handle content chunks → close any open <think> block first
                if let Some(ref c) = content_delta {
                    if !c.is_empty() {
                        if first_token_time.is_none() {
                            first_token_time = Some(std::time::Instant::now());
                        }
                        if in_thinking_block {
                            let total_ms = thinking_block_start
                                .map(|s| s.elapsed().as_millis() as u64)
                                .unwrap_or(0);
                            thinking_durations.push(total_ms);
                            emit_content.push_str("\n</think>\n\n");
                            in_thinking_block = false;
                            thinking_block_start = None;
                        }
                        emit_content.push_str(c);
                    }
                }

                // On done: close any still-open <think> block
                if is_done && in_thinking_block {
                    let total_ms = thinking_block_start
                        .map(|s| s.elapsed().as_millis() as u64)
                        .unwrap_or(0);
                    thinking_durations.push(total_ms);
                    emit_content.push_str("\n</think>\n\n");
                    in_thinking_block = false;
                    thinking_block_start = None;
                }

                full_content.push_str(&emit_content);

                if chunk.usage.is_some() {
                    final_usage.clone_from(&chunk.usage);
                }
                if chunk.tool_calls.is_some() {
                    final_tool_calls.clone_from(&chunk.tool_calls);
                }

                // Detect empty response
                if is_done
                    && full_content.is_empty()
                    && final_tool_calls.as_ref().is_none_or(|tc| tc.is_empty())
                {
                    let err_msg = "Provider returned empty response".to_string();
                    let _ = app.emit(
                        "chat-stream-error",
                        ChatStreamErrorEvent {
                            conversation_id: conversation_id.to_string(),
                            message_id: message_id.to_string(),
                            model_id: Some(model_id.to_string()),
                            provider_id: Some(provider_id.to_string()),
                            error: err_msg.clone(),
                        },
                    );
                    tracing::warn!("[consume_stream] Empty response from provider");
                    stream_error = Some(err_msg);
                    break;
                }

                let mut emitted_chunk = ChatStreamChunk {
                    content: if emit_content.is_empty() {
                        None
                    } else {
                        Some(emit_content)
                    },
                    thinking: emit_thinking_signal,
                    done: is_done,
                    is_final: None,
                    usage: chunk.usage.clone(),
                    tool_calls: chunk.tool_calls.clone(),
                };
                if emitted_chunk.done && emitted_chunk.is_final.is_none() {
                    emitted_chunk.is_final = Some(
                        emitted_chunk
                            .tool_calls
                            .as_ref()
                            .is_none_or(|tool_calls| tool_calls.is_empty()),
                    );
                }

                let _ = app.emit(
                    "chat-stream-chunk",
                    ChatStreamEvent {
                        conversation_id: conversation_id.to_string(),
                        message_id: message_id.to_string(),
                        model_id: Some(model_id.to_string()),
                        provider_id: Some(provider_id.to_string()),
                        chunk: emitted_chunk,
                    },
                );

                if is_done {
                    break;
                }
            }
            Err(e) => {
                let err_msg = format!("{}", e);
                let _ = app.emit(
                    "chat-stream-error",
                    ChatStreamErrorEvent {
                        conversation_id: conversation_id.to_string(),
                        message_id: message_id.to_string(),
                        model_id: Some(model_id.to_string()),
                        provider_id: Some(provider_id.to_string()),
                        error: err_msg.clone(),
                    },
                );
                tracing::error!("Stream error: {}", e);
                stream_error = Some(err_msg);
                break;
            }
        }
    }

    // Close any dangling <think> block (e.g. stream cancelled mid-thinking)
    if in_thinking_block {
        let total_ms = thinking_block_start
            .map(|s| s.elapsed().as_millis() as u64)
            .unwrap_or(0);
        thinking_durations.push(total_ms);
        full_content.push_str("\n</think>\n\n");
    }

    if suppress_thinking
        && !disabled_thinking_strip_state.in_think_block
        && !disabled_thinking_strip_state.trailing_fragment.is_empty()
        && !"<think".starts_with(&disabled_thinking_strip_state.trailing_fragment)
    {
        full_content.push_str(&disabled_thinking_strip_state.trailing_fragment);
    }

    // Post-process: replace each <think data-aq> with <think totalMs="N">
    full_content = fixup_think_tags(&full_content, &thinking_durations);
    if suppress_thinking {
        full_content = strip_disabled_thinking_content(&full_content);
    }

    // Compute timing metrics
    let first_token_latency_ms = first_token_time.map(|t| (t - stream_start).as_millis() as i64);
    let tokens_per_second = match (final_usage.as_ref(), first_token_time) {
        (Some(usage), Some(ft)) if usage.completion_tokens > 0 => {
            let gen_duration =
                stream_start.elapsed().as_secs_f64() - (ft - stream_start).as_secs_f64();
            if gen_duration > 0.0 {
                Some(usage.completion_tokens as f64 / gen_duration)
            } else {
                None
            }
        }
        _ => None,
    };

    (
        full_content,
        final_usage,
        final_tool_calls,
        stream_error,
        tokens_per_second,
        first_token_latency_ms,
    )
}

/// Replace each `<think data-aqbot="1">` marker with `<think totalMs="N">` using
/// the collected duration values. Upstream `<think>` tags (without `data-aqbot`)
/// are left unchanged.
fn fixup_think_tags(content: &str, durations: &[u64]) -> String {
    const MARKER: &str = "<think data-aqbot=\"1\">";
    let mut result = String::with_capacity(content.len());
    let mut remaining = content;
    let mut dur_iter = durations.iter();
    while let Some(pos) = remaining.find(MARKER) {
        result.push_str(&remaining[..pos]);
        if let Some(ms) = dur_iter.next() {
            result.push_str(&format!("<think totalMs=\"{}\">", ms));
        } else {
            result.push_str("<think>");
        }
        remaining = &remaining[pos + MARKER.len()..];
    }
    result.push_str(remaining);
    result
}

async fn execute_tool_call(
    db: &sea_orm::DatabaseConnection,
    tool_call: &ToolCall,
    mcp_server_ids: &[String],
) -> (String, bool) {
    let server_and_tool = aqbot_core::repo::mcp_server::find_server_for_tool(
        db,
        &tool_call.function.name,
        mcp_server_ids,
    )
    .await;

    let (server, _td) = match server_and_tool {
        Ok(Some(pair)) => pair,
        _ => {
            return (
                format!(
                    "Error: Tool '{}' not found on any enabled MCP server",
                    tool_call.function.name
                ),
                true,
            );
        }
    };

    let arguments: serde_json::Value = serde_json::from_str(&tool_call.function.arguments)
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

    let timeout_secs = server.execute_timeout_secs.unwrap_or(30) as u64;
    let timeout_duration = std::time::Duration::from_secs(timeout_secs);

    let result = match server.transport.as_str() {
        "builtin" => {
            match tokio::time::timeout(
                timeout_duration,
                aqbot_core::builtin_tools::dispatch(
                    &server.name,
                    &tool_call.function.name,
                    arguments,
                ),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => {
                    return (
                        format!("Error: Tool execution timed out after {}s", timeout_secs),
                        true,
                    )
                }
            }
        }
        "stdio" => {
            let command = match &server.command {
                Some(cmd) => cmd.clone(),
                None => return ("Error: stdio server has no command configured".into(), true),
            };
            let args: Vec<String> = server
                .args_json
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            let env: std::collections::HashMap<String, String> = server
                .env_json
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            match tokio::time::timeout(
                timeout_duration,
                aqbot_core::mcp_client::call_tool_stdio(
                    &command,
                    &args,
                    &env,
                    &tool_call.function.name,
                    arguments,
                ),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => {
                    return (
                        format!("Error: Tool execution timed out after {}s", timeout_secs),
                        true,
                    )
                }
            }
        }
        "http" => {
            let endpoint = match &server.endpoint {
                Some(ep) => ep.clone(),
                None => return ("Error: HTTP server has no endpoint configured".into(), true),
            };
            match tokio::time::timeout(
                timeout_duration,
                aqbot_core::mcp_client::call_tool_http(
                    &endpoint,
                    &tool_call.function.name,
                    arguments,
                ),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => {
                    return (
                        format!("Error: Tool execution timed out after {}s", timeout_secs),
                        true,
                    )
                }
            }
        }
        "sse" => {
            let endpoint = match &server.endpoint {
                Some(ep) => ep.clone(),
                None => return ("Error: SSE server has no endpoint configured".into(), true),
            };
            match tokio::time::timeout(
                timeout_duration,
                aqbot_core::mcp_client::call_tool_sse(
                    &endpoint,
                    &tool_call.function.name,
                    arguments,
                ),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => {
                    return (
                        format!("Error: Tool execution timed out after {}s", timeout_secs),
                        true,
                    )
                }
            }
        }
        other => return (format!("Error: Unsupported transport '{}'", other), true),
    };

    match result {
        Ok(r) => (r.content, r.is_error),
        Err(e) => (format!("Error executing tool: {}", e), true),
    }
}

const DEFAULT_TITLE_PROMPT: &str = "You are a title generator. Based on the conversation below, generate a concise and descriptive title (maximum 30 characters). Reply with the title only, no quotes or extra text.";
const DEFAULT_TITLE_SUMMARY_MAX_TOKENS: u32 = 1024;
const RETRY_TITLE_SUMMARY_MAX_TOKENS: u32 = 4096;

fn title_summary_max_tokens(settings: &AppSettings) -> u32 {
    settings
        .title_summary_max_tokens
        .unwrap_or(DEFAULT_TITLE_SUMMARY_MAX_TOKENS)
}

fn clean_generated_title(content: &str) -> String {
    content
        .trim()
        .trim_matches('"')
        .trim_matches('「')
        .trim_matches('」')
        .trim_matches('《')
        .trim_matches('》')
        .to_string()
}

async fn call_title_chat(
    adapter: &dyn ProviderAdapter,
    ctx: &ProviderRequestContext,
    request: ChatRequest,
) -> Result<ChatResponse, String> {
    adapter.chat(ctx, request).await.map_err(|e| {
        let err = format!("Chat API error: {}", e);
        tracing::error!("[title-gen] {}", err);
        err
    })
}

/// Generate an AI-powered conversation title using the configured title summary model.
/// Returns Err with the actual error message if generation fails.
pub async fn generate_ai_title(
    db: &sea_orm::DatabaseConnection,
    user_content: &str,
    assistant_content: &str,
    fallback_provider: &ProviderConfig,
    fallback_ctx: &ProviderRequestContext,
    fallback_model_id: &str,
    settings: &AppSettings,
    master_key: &[u8; 32],
) -> Result<String, String> {
    // Helper: look up use_max_completion_tokens from model param_overrides
    let lookup_umc = |provider_id: &str, model_id: &str, db: &sea_orm::DatabaseConnection| {
        let pid = provider_id.to_string();
        let mid = model_id.to_string();
        let db = db.clone();
        async move {
            aqbot_core::repo::provider::get_model(&db, &pid, &mid)
                .await
                .ok()
                .and_then(|m| m.param_overrides)
                .and_then(|po| po.use_max_completion_tokens)
        }
    };

    // Resolve title summary provider/model: settings override → fallback to conversation model
    if let (Some(ref pid), Some(ref mid)) = (
        &settings.title_summary_provider_id,
        &settings.title_summary_model_id,
    ) {
        // Try to use the configured title summary provider
        let provider = match aqbot_core::repo::provider::get_provider(db, pid).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("Title summary provider not found, falling back: {}", e);
                let umc = lookup_umc(&fallback_ctx.provider_id, fallback_model_id, db).await;
                return generate_ai_title_with(
                    fallback_provider,
                    fallback_ctx,
                    fallback_model_id,
                    user_content,
                    assistant_content,
                    settings,
                    umc,
                )
                .await;
            }
        };
        let key_row = match aqbot_core::repo::provider::get_active_key(db, pid).await {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(
                    "Title summary provider has no active key, falling back: {}",
                    e
                );
                let umc = lookup_umc(&fallback_ctx.provider_id, fallback_model_id, db).await;
                return generate_ai_title_with(
                    fallback_provider,
                    fallback_ctx,
                    fallback_model_id,
                    user_content,
                    assistant_content,
                    settings,
                    umc,
                )
                .await;
            }
        };
        let dk = match aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, master_key) {
            Ok(dk) => dk,
            Err(e) => {
                tracing::warn!("Title summary key decrypt failed, falling back: {}", e);
                let umc = lookup_umc(&fallback_ctx.provider_id, fallback_model_id, db).await;
                return generate_ai_title_with(
                    fallback_provider,
                    fallback_ctx,
                    fallback_model_id,
                    user_content,
                    assistant_content,
                    settings,
                    umc,
                )
                .await;
            }
        };
        let proxy = ProviderProxyConfig::resolve(&provider.proxy_config, settings);
        let ctx = ProviderRequestContext {
            api_key: dk,
            key_id: key_row.id.clone(),
            provider_id: provider.id.clone(),
            base_url: Some(resolve_base_url_for_type(
                &provider.api_host,
                &provider.provider_type,
            )),
            api_path: provider.api_path.clone(),
            proxy_config: proxy,
            custom_headers: provider
                .custom_headers
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok()),
        };
        let umc = lookup_umc(pid, mid, db).await;
        generate_ai_title_with(
            &provider,
            &ctx,
            mid,
            user_content,
            assistant_content,
            settings,
            umc,
        )
        .await
    } else {
        // No title summary provider configured, use conversation model
        let umc = lookup_umc(&fallback_ctx.provider_id, fallback_model_id, db).await;
        generate_ai_title_with(
            fallback_provider,
            fallback_ctx,
            fallback_model_id,
            user_content,
            assistant_content,
            settings,
            umc,
        )
        .await
    }
}

async fn generate_ai_title_with(
    provider: &ProviderConfig,
    ctx: &ProviderRequestContext,
    model_id: &str,
    user_content: &str,
    assistant_content: &str,
    settings: &AppSettings,
    use_max_completion_tokens: Option<bool>,
) -> Result<String, String> {
    let prompt = settings
        .title_summary_prompt
        .as_deref()
        .unwrap_or(DEFAULT_TITLE_PROMPT);

    // Build conversation context for title generation
    let mut conversation_text = format!("User: {}", user_content);
    if !assistant_content.is_empty() {
        // Include a truncated assistant response for better context
        let assistant_preview: String = assistant_content.chars().take(500).collect();
        conversation_text.push_str(&format!("\n\nAssistant: {}", assistant_preview));
    }

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(prompt.to_string()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: ChatContent::Text(conversation_text),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let mut request = ChatRequest {
        model: model_id.to_string(),
        messages,
        stream: false,
        temperature: settings
            .title_summary_temperature
            .map(|v| v as f64)
            .or(Some(0.3)),
        top_p: settings.title_summary_top_p.map(|v| v as f64),
        max_tokens: Some(title_summary_max_tokens(settings)),
        tools: None,
        thinking_budget: None,
        thinking_level: None,
        reasoning_profile: None,
        use_max_completion_tokens,
        thinking_param_style: None,
    };

    let registry = ProviderRegistry::create_default();
    let registry_key = provider_type_to_registry_key(&provider.provider_type);
    let adapter = match registry.get(registry_key) {
        Some(a) => a,
        None => {
            let err = format!("Adapter not found for provider type: {}", registry_key);
            tracing::error!("[title-gen] {}", err);
            return Err(err);
        }
    };

    let mut response = call_title_chat(adapter, ctx, request.clone()).await?;
    let mut title = clean_generated_title(&response.content);
    if title.is_empty()
        && request
            .max_tokens
            .is_some_and(|tokens| tokens < RETRY_TITLE_SUMMARY_MAX_TOKENS)
    {
        request.max_tokens = Some(RETRY_TITLE_SUMMARY_MAX_TOKENS);
        tracing::warn!(
            "[title-gen] Empty title returned with a small output budget; retrying with {} tokens",
            RETRY_TITLE_SUMMARY_MAX_TOKENS
        );
        response = call_title_chat(adapter, ctx, request).await?;
        title = clean_generated_title(&response.content);
    }

    if title.is_empty() {
        let err = "AI returned empty title".to_string();
        tracing::error!("[title-gen] {}", err);
        Err(err)
    } else {
        tracing::info!("[title-gen] Generated title: {}", title);
        Ok(title)
    }
}

#[tauri::command]
pub async fn regenerate_conversation_title(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    let db = state.sea_db.clone();
    let master_key = state.master_key;

    // Load conversation
    let conversation = aqbot_core::repo::conversation::get_conversation(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    // Load messages to get first user + assistant content
    let messages = aqbot_core::repo::message::list_messages(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    let user_content = messages
        .iter()
        .find(|m| m.role == MessageRole::User)
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let assistant_content = messages
        .iter()
        .find(|m| m.role == MessageRole::Assistant)
        .map(|m| m.content.clone())
        .unwrap_or_default();

    if user_content.is_empty() {
        return Err("No user message found to generate title from".to_string());
    }

    // Load provider for fallback
    let provider = aqbot_core::repo::provider::get_provider(&db, &conversation.provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row = aqbot_core::repo::provider::get_active_key(&db, &provider.id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &master_key)
        .map_err(|e| e.to_string())?;

    let global_settings = aqbot_core::repo::settings::get_settings(&db)
        .await
        .map_err(|e| e.to_string())?;

    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    // Emit generating event
    let _ = app.emit(
        "conversation-title-generating",
        ConversationTitleGeneratingEvent {
            conversation_id: conversation_id.clone(),
            generating: true,
            error: None,
        },
    );

    // Spawn async task for title generation
    let app_clone = app.clone();
    let conv_id = conversation_id.clone();
    let conv_model_id = conversation.model_id.clone();
    tokio::spawn(async move {
        let ai_title = generate_ai_title(
            &db,
            &user_content,
            &assistant_content,
            &provider,
            &ctx,
            &conv_model_id,
            &global_settings,
            &master_key,
        )
        .await;

        match ai_title {
            Ok(title) => {
                if let Err(e) =
                    aqbot_core::repo::conversation::update_conversation_title(&db, &conv_id, &title)
                        .await
                {
                    tracing::error!("Failed to save regenerated title: {}", e);
                    let _ = app_clone.emit(
                        "conversation-title-generating",
                        ConversationTitleGeneratingEvent {
                            conversation_id: conv_id,
                            generating: false,
                            error: Some(format!("Failed to save title: {}", e)),
                        },
                    );
                } else {
                    let _ = app_clone.emit(
                        "conversation-title-updated",
                        ConversationTitleUpdatedEvent {
                            conversation_id: conv_id.clone(),
                            title,
                        },
                    );
                    let _ = app_clone.emit(
                        "conversation-title-generating",
                        ConversationTitleGeneratingEvent {
                            conversation_id: conv_id,
                            generating: false,
                            error: None,
                        },
                    );
                }
            }
            Err(err) => {
                tracing::warn!("Title regeneration failed: {}", err);
                let _ = app_clone.emit(
                    "conversation-title-generating",
                    ConversationTitleGeneratingEvent {
                        conversation_id: conv_id,
                        generating: false,
                        error: Some(err),
                    },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_stream(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    let flags = state.stream_cancel_flags.lock().await;
    if let Some(flag) = flags.get(&conversation_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        tracing::info!(
            "[cancel_stream] Cancel requested for conversation {}",
            conversation_id
        );
    }
    Ok(())
}

/// Build separate `<knowledge-retrieval>` and `<memory-retrieval>` HTML tags
/// from RAG source results for persistence, split by source type.
fn build_memory_retrieval_tag(sources: &[RagSourceResult]) -> String {
    if sources.is_empty() {
        return String::new();
    }
    let knowledge: Vec<&RagSourceResult> = sources
        .iter()
        .filter(|s| s.source_type == "knowledge")
        .collect();
    let memory: Vec<&RagSourceResult> = sources
        .iter()
        .filter(|s| s.source_type != "knowledge")
        .collect();
    let mut result = String::new();
    if !knowledge.is_empty() {
        let json = serde_json::to_string(&knowledge).unwrap_or_default();
        result.push_str(&format!("<knowledge-retrieval status=\"done\" data-aqbot=\"1\">\n{}\n</knowledge-retrieval>\n\n", json));
    }
    if !memory.is_empty() {
        let json = serde_json::to_string(&memory).unwrap_or_default();
        result.push_str(&format!(
            "<memory-retrieval status=\"done\" data-aqbot=\"1\">\n{}\n</memory-retrieval>\n\n",
            json
        ));
    }
    result
}

/// Spawn the streaming background task shared by send_message and regenerate_message.
/// Returns the assistant message_id that will be populated as chunks arrive.
fn spawn_stream_task(
    app: tauri::AppHandle,
    db: sea_orm::DatabaseConnection,
    conversation_id: String,
    assistant_message_id: String,
    conversation: Conversation,
    provider: ProviderConfig,
    ctx: ProviderRequestContext,
    chat_messages: Vec<ChatMessage>,
    is_first_message: bool,
    user_content: String,
    parent_message_id: String,
    version_index: i32,
    tools: Option<Vec<ChatTool>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    mcp_server_ids: Vec<String>,
    override_created_at: Option<i64>,
    use_max_completion_tokens: Option<bool>,
    force_max_tokens: Option<bool>,
    thinking_param_style: Option<String>,
    reasoning_profile: Option<String>,
    model_param_overrides: Option<ModelParamOverrides>,
    settings: AppSettings,
    master_key: [u8; 32],
    cancel_flag: Arc<AtomicBool>,
    cancel_flags: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    content_prefix: String,
    create_inactive: bool,
    skip_placeholder_create: bool,
) {
    let model_id = conversation.model_id.clone();

    tokio::spawn(async move {
        let effective_chat_params = resolve_chat_model_params(
            &conversation,
            model_param_overrides.as_ref(),
            &settings,
            force_max_tokens,
        );
        let registry = ProviderRegistry::create_default();
        let registry_key = provider_type_to_registry_key(&provider.provider_type);
        let adapter: &dyn aqbot_providers::ProviderAdapter = match registry.get(registry_key) {
            Some(a) => a,
            None => {
                let _ = app.emit(
                    "chat-stream-error",
                    ChatStreamErrorEvent {
                        conversation_id: conversation_id.clone(),
                        message_id: assistant_message_id.clone(),
                        model_id: Some(model_id.clone()),
                        provider_id: Some(provider.id.clone()),
                        error: format!("Unsupported provider type: {}", registry_key),
                    },
                );
                return;
            }
        };

        const MAX_TOOL_ITERATIONS: usize = 10;
        let mut chat_messages = chat_messages;
        let mut iteration = 0;
        let mut total_content = String::new();
        let mut total_usage: Option<TokenUsage> = None;
        let mut final_tool_calls_json: Option<String> = None;
        let mut had_stream_error = false;
        let mut last_stream_error: Option<String> = None;
        let mut final_tokens_per_second: Option<f64> = None;
        let mut final_first_token_latency_ms: Option<i64> = None;

        // Early create: persist a placeholder message so it survives crash/refresh
        // Skip if the caller already created the placeholder before spawning.
        if !skip_placeholder_create {
            if let Err(e) = (aqbot_core::entity::messages::ActiveModel {
                id: Set(assistant_message_id.clone()),
                conversation_id: Set(conversation_id.clone()),
                role: Set("assistant".to_string()),
                content: Set(String::new()),
                provider_id: Set(Some(provider.id.clone())),
                model_id: Set(Some(model_id.clone())),
                token_count: Set(None),
                prompt_tokens: Set(None),
                completion_tokens: Set(None),
                attachments: Set("[]".to_string()),
                thinking: Set(None),
                created_at: Set(override_created_at.unwrap_or_else(aqbot_core::utils::now_ts)),
                branch_id: Set(None),
                parent_message_id: Set(Some(parent_message_id.clone())),
                version_index: Set(version_index),
                is_active: Set(if create_inactive { 0 } else { 1 }),
                tool_calls_json: Set(None),
                tool_call_id: Set(None),
                status: Set("partial".to_string()),
                tokens_per_second: Set(None),
                first_token_latency_ms: Set(None),
            })
            .insert(&db)
            .await
            {
                tracing::error!("Failed to create placeholder assistant message: {}", e);
            }
        }

        loop {
            iteration += 1;
            if iteration > MAX_TOOL_ITERATIONS {
                tracing::warn!(
                    "Tool call loop exceeded max iterations ({})",
                    MAX_TOOL_ITERATIONS
                );
                break;
            }

            // Check cancellation before starting a new iteration
            if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                tracing::info!(
                    "[spawn_stream_task] Cancelled by user before iteration {}",
                    iteration
                );
                break;
            }

            let request = ChatRequest {
                model: model_id.clone(),
                messages: chat_messages.clone(),
                stream: true,
                temperature: effective_chat_params.temperature,
                top_p: effective_chat_params.top_p,
                max_tokens: effective_chat_params.max_tokens,
                tools: tools.clone(),
                thinking_budget,
                thinking_level: thinking_level.clone(),
                reasoning_profile: reasoning_profile.clone(),
                use_max_completion_tokens,
                thinking_param_style: thinking_param_style.clone(),
            };

            let mut stream = adapter.chat_stream(&ctx, request);
            let suppress_thinking = thinking_budget == Some(0)
                || matches!(thinking_level.as_deref(), Some("off" | "none"));
            let (content, usage, tool_calls, stream_error, iter_tps, iter_ttft) = consume_stream(
                &app,
                &mut stream,
                &conversation_id,
                &assistant_message_id,
                &model_id,
                &provider.id,
                &cancel_flag,
                suppress_thinking,
            )
            .await;

            total_content.push_str(&content);
            if usage.is_some() {
                total_usage = usage;
            }
            // Keep first iteration's TTFT, last iteration's TPS
            if final_first_token_latency_ms.is_none() {
                final_first_token_latency_ms = iter_ttft;
            }
            if iter_tps.is_some() {
                final_tokens_per_second = iter_tps;
            }

            // If stream errored, save what we have and break
            if stream_error.is_some() {
                last_stream_error = stream_error;
                had_stream_error = true;
                break;
            }

            // If no tool calls, we're done
            let tool_calls = match tool_calls {
                Some(tc) if !tc.is_empty() => tc,
                _ => {
                    // Final iteration has no tool calls — clear any stale value so the
                    // stored message won't carry orphaned tool_calls_json (which would
                    // break context for subsequent requests since the matching tool
                    // response messages are stored as is_active=0 and excluded from
                    // list_messages).
                    final_tool_calls_json = None;
                    break;
                }
            };

            // Save the tool_calls JSON for the final message
            let tc_json = serde_json::to_string(&tool_calls).ok();
            final_tool_calls_json = tc_json.clone();

            // Add assistant message with tool_calls to chat history for next round
            // Strip <think> tags from the assistant content sent to the provider
            let stripped_content = strip_think_tags(&content);
            chat_messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: ChatContent::Text(stripped_content),
                reasoning_content: extract_think_blocks(&content),
                tool_calls: Some(tool_calls.clone()),
                tool_call_id: None,
            });

            // Persist the intermediate assistant message with tool_calls
            // Returns the generated ID so tool results can reference it as parent
            let intermediate_msg_id =
                aqbot_core::repo::message::create_assistant_tool_call_message(
                    &db,
                    &conversation_id,
                    &content,
                    tc_json.as_deref(),
                    &provider.id,
                    &model_id,
                    &parent_message_id,
                )
                .await
                .unwrap_or_else(|_| aqbot_core::utils::gen_id());

            // Execute each tool call
            for tc in &tool_calls {
                // Look up server name for events
                let server_name = match aqbot_core::repo::mcp_server::find_server_for_tool(
                    &db,
                    &tc.function.name,
                    &mcp_server_ids,
                )
                .await
                {
                    Ok(Some((srv, _))) => srv.name.clone(),
                    _ => "unknown".to_string(),
                };

                // Emit :::mcp opener as stream chunk — frontend shows loading state
                let metadata = serde_json::json!({
                    "name": server_name,
                    "tool": tc.function.name,
                    "id": tc.id,
                    "arguments": tc.function.arguments,
                });
                let mcp_opener = format!("\n\n:::mcp {}\n", metadata);
                total_content.push_str(&mcp_opener);
                let _ = app.emit(
                    "chat-stream-chunk",
                    ChatStreamEvent {
                        conversation_id: conversation_id.clone(),
                        message_id: assistant_message_id.clone(),
                        model_id: Some(model_id.clone()),
                        provider_id: Some(provider.id.clone()),
                        chunk: ChatStreamChunk {
                            content: Some(mcp_opener.clone()),
                            thinking: None,
                            done: false,
                            is_final: None,
                            usage: None,
                            tool_calls: None,
                        },
                    },
                );

                // Create execution record
                let server_id_for_exec = match aqbot_core::repo::mcp_server::find_server_for_tool(
                    &db,
                    &tc.function.name,
                    &mcp_server_ids,
                )
                .await
                {
                    Ok(Some((srv, _))) => srv.id.clone(),
                    _ => String::new(),
                };
                let exec = aqbot_core::repo::tool_execution::create_tool_execution(
                    &db,
                    &conversation_id,
                    Some(&assistant_message_id),
                    &server_id_for_exec,
                    &tc.function.name,
                    Some(&tc.function.arguments),
                    None,
                )
                .await;

                // Execute the tool
                let start = std::time::Instant::now();
                let (result_content, is_error) = execute_tool_call(&db, tc, &mcp_server_ids).await;
                let _duration_ms = start.elapsed().as_millis() as i64;

                // Update execution record
                if let Ok(ref exec) = exec {
                    let _ = aqbot_core::repo::tool_execution::update_tool_execution_status(
                        &db,
                        &exec.id,
                        if is_error { "failed" } else { "success" },
                        Some(&result_content),
                        if is_error {
                            Some(&result_content)
                        } else {
                            None
                        },
                    )
                    .await;
                }

                // Emit :::mcp result + closer as stream chunk — frontend shows completed state
                let mcp_closer = format!("{}\n:::\n\n", result_content);
                total_content.push_str(&mcp_closer);
                let _ = app.emit(
                    "chat-stream-chunk",
                    ChatStreamEvent {
                        conversation_id: conversation_id.clone(),
                        message_id: assistant_message_id.clone(),
                        model_id: Some(model_id.clone()),
                        provider_id: Some(provider.id.clone()),
                        chunk: ChatStreamChunk {
                            content: Some(mcp_closer.clone()),
                            thinking: None,
                            done: false,
                            is_final: None,
                            usage: None,
                            tool_calls: None,
                        },
                    },
                );

                // Persist tool result message to DB (parent is the intermediate assistant message)
                let _ = aqbot_core::repo::message::create_tool_result_message(
                    &db,
                    &conversation_id,
                    &tc.id,
                    &result_content,
                    &intermediate_msg_id,
                )
                .await;

                // Add tool result to in-memory chat messages for next provider call
                chat_messages.push(ChatMessage {
                    role: "tool".to_string(),
                    content: ChatContent::Text(result_content.to_string()),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                });
            }
            // Continue loop — will call provider again with tool results
        }

        // After loop: update the placeholder message with final content and status
        let was_cancelled = cancel_flag.load(std::sync::atomic::Ordering::Relaxed);
        let final_status = if had_stream_error {
            "error"
        } else if was_cancelled {
            "partial"
        } else {
            "complete"
        };

        // If the stream errored and produced no content, persist the error
        // details (URL, model, provider) so the user sees diagnostic info
        // even after a page refresh.
        if had_stream_error && total_content.is_empty() {
            let err = last_stream_error.as_deref().unwrap_or("Unknown error");
            let base_url = ctx.base_url.as_deref().unwrap_or("(not set)");
            let api_path_display = ctx.api_path.as_deref().unwrap_or("(default)");
            total_content = format!(
                "{}\n\nBase URL: {}\nAPI Path: {}\nModel: {}\nProvider: {} ({:?})",
                err, base_url, api_path_display, model_id, provider.name, provider.provider_type,
            );
        }
        let token_count = total_usage.as_ref().map(|u| u.completion_tokens);
        let prompt_tokens = total_usage.as_ref().map(|u| u.prompt_tokens);
        let completion_tokens = total_usage.as_ref().map(|u| u.completion_tokens);
        // Prepend memory retrieval tag (if any) so it persists in DB
        let saved_content = if content_prefix.is_empty() {
            total_content.clone()
        } else {
            format!("{}{}", content_prefix, total_content)
        };
        if let Err(e) = aqbot_core::entity::messages::Entity::update(
            aqbot_core::entity::messages::ActiveModel {
                id: Set(assistant_message_id.clone()),
                content: Set(saved_content),
                token_count: Set(token_count.map(|v| v as i64)),
                prompt_tokens: Set(prompt_tokens.map(|v| v as i64)),
                completion_tokens: Set(completion_tokens.map(|v| v as i64)),
                thinking: Set(None), // thinking is now embedded in content as <think> tags
                tool_calls_json: Set(final_tool_calls_json),
                status: Set(final_status.to_string()),
                tokens_per_second: Set(final_tokens_per_second),
                first_token_latency_ms: Set(final_first_token_latency_ms),
                ..Default::default()
            },
        )
        .exec(&db)
        .await
        {
            tracing::error!("Failed to update assistant message: {}", e);
        }

        // Increment message count for the assistant message
        if let Err(e) =
            aqbot_core::repo::conversation::increment_message_count(&db, &conversation_id).await
        {
            tracing::error!("Failed to increment message count: {}", e);
        }

        // Auto-title: if this is the first user message, set conversation title
        if is_first_message {
            // Set truncated title immediately for instant feedback
            let fallback_title = if user_content.chars().count() > 30 {
                format!("{}...", user_content.chars().take(30).collect::<String>())
            } else {
                user_content.clone()
            };

            if let Err(e) = aqbot_core::repo::conversation::update_conversation_title(
                &db,
                &conversation_id,
                &fallback_title,
            )
            .await
            {
                tracing::error!("Failed to auto-update title: {}", e);
            } else {
                let _ = app.emit(
                    "conversation-title-updated",
                    ConversationTitleUpdatedEvent {
                        conversation_id: conversation_id.clone(),
                        title: fallback_title,
                    },
                );
            }

            // Notify frontend that title generation is starting
            let _ = app.emit(
                "conversation-title-generating",
                ConversationTitleGeneratingEvent {
                    conversation_id: conversation_id.clone(),
                    generating: true,
                    error: None,
                },
            );

            // Try AI-powered title generation
            let ai_title = generate_ai_title(
                &db,
                &user_content,
                &total_content,
                &provider,
                &ctx,
                &model_id,
                &settings,
                &master_key,
            )
            .await;

            match ai_title {
                Ok(title) => {
                    if let Err(e) = aqbot_core::repo::conversation::update_conversation_title(
                        &db,
                        &conversation_id,
                        &title,
                    )
                    .await
                    {
                        tracing::error!("Failed to update AI-generated title: {}", e);
                        let _ = app.emit(
                            "conversation-title-generating",
                            ConversationTitleGeneratingEvent {
                                conversation_id: conversation_id.clone(),
                                generating: false,
                                error: Some(format!("Failed to save title: {}", e)),
                            },
                        );
                    } else {
                        let _ = app.emit(
                            "conversation-title-updated",
                            ConversationTitleUpdatedEvent {
                                conversation_id: conversation_id.clone(),
                                title,
                            },
                        );
                        let _ = app.emit(
                            "conversation-title-generating",
                            ConversationTitleGeneratingEvent {
                                conversation_id: conversation_id.clone(),
                                generating: false,
                                error: None,
                            },
                        );
                    }
                }
                Err(err) => {
                    tracing::warn!("Auto title generation failed: {}", err);
                    let _ = app.emit(
                        "conversation-title-generating",
                        ConversationTitleGeneratingEvent {
                            conversation_id: conversation_id.clone(),
                            generating: false,
                            error: Some(err),
                        },
                    );
                }
            }
        }

        // Clean up cancel flag
        cancel_flags.lock().await.remove(&conversation_id);
    });
}

#[tauri::command]
pub async fn send_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    content: String,
    attachments: Vec<AttachmentInput>,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
) -> Result<Message, String> {
    let persisted_attachments = persist_attachments(&state, &conversation_id, &attachments)
        .await
        .map_err(|e| e.to_string())?;

    // 1. Save user message to DB
    let user_message = aqbot_core::repo::message::create_message(
        &state.sea_db,
        &conversation_id,
        MessageRole::User,
        &content,
        &persisted_attachments,
        None,
        0,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Increment the persisted message count
    aqbot_core::repo::conversation::increment_message_count(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    // 2. Get conversation details (provider_id, model_id)
    let conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

    // Check if this is the first message (message_count was 0 before we incremented)
    let is_first_message = conversation.message_count <= 1;

    // 3. Get provider config + decrypt key
    let provider =
        aqbot_core::repo::provider::get_provider(&state.sea_db, &conversation.provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let key_row =
        aqbot_core::repo::provider::get_active_key(&state.sea_db, &conversation.provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;

    // Get model info for param overrides and token budget
    let resolved_model = aqbot_core::repo::provider::get_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .ok();
    let model_param_overrides = resolved_model
        .as_ref()
        .and_then(|m| m.param_overrides.clone());
    let no_system_role = model_param_overrides
        .as_ref()
        .and_then(|p| p.no_system_role)
        .unwrap_or(false);
    let use_max_completion_tokens = model_param_overrides
        .as_ref()
        .and_then(|p| p.use_max_completion_tokens);
    let force_max_tokens = model_param_overrides
        .as_ref()
        .and_then(|p| p.force_max_tokens);
    let thinking_param_style = model_param_overrides
        .as_ref()
        .and_then(|p| p.thinking_param_style.clone());
    let reasoning_profile = model_param_overrides
        .as_ref()
        .and_then(|p| p.reasoning_profile.clone());

    // 4. Build ChatRequest from conversation messages
    let db_messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();

    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    // Resolve effective system prompt: conversation → category → global default
    let effective_system_prompt = resolve_system_prompt(&state.sea_db, &conversation).await;

    // Prepend system prompt if present
    if let Some(ref sys) = effective_system_prompt {
        tracing::info!(
            "[send_message] model={} effective_system_prompt='{}'",
            &conversation.model_id,
            &sys[..sys.len().min(80)]
        );
        chat_messages.push(ChatMessage {
            role: if no_system_role {
                "user".to_string()
            } else {
                "system".to_string()
            },
            content: ChatContent::Text(sys.clone()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    } else {
        tracing::info!(
            "[send_message] model={} NO system prompt",
            &conversation.model_id
        );
    }

    // 5. Generate assistant message ID upfront so early RAG events can target
    // the same assistant row that the stream will later update.
    let assistant_message_id = aqbot_core::utils::gen_id();

    // RAG retrieval: search enabled knowledge bases and memory namespaces
    let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
    let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
    let rag_result = crate::indexing::collect_rag_context(
        &state.sea_db,
        &state.master_key,
        &state.vector_store,
        &kb_ids,
        &mem_ids,
        &content,
        5,
    )
    .await;

    // Build memory retrieval tag for persistence before moving source_results
    let memory_tag = build_memory_retrieval_tag(&rag_result.source_results);

    // Always emit RAG results to frontend so it can replace the searching indicator
    let _ = app.emit(
        "rag-context-retrieved",
        RagContextRetrievedEvent {
            conversation_id: conversation_id.clone(),
            message_id: Some(assistant_message_id.clone()),
            sources: rag_result.source_results,
        },
    );

    if !rag_result.context_parts.is_empty() {
        chat_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(format!(
                "The following reference materials may be relevant to the user's question. Use them if helpful:\n\n{}",
                rag_result.context_parts.join("\n\n")
            )),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }

    // Find last context-clear or context-compressed marker to truncate history
    let marker_idx = db_messages.iter().rposition(|m| {
        m.role == MessageRole::System
            && (m.content == "<!-- context-clear -->"
                || m.content == crate::context_manager::COMPRESSION_MARKER)
    });
    let effective_messages = match marker_idx {
        Some(idx) => &db_messages[idx + 1..],
        None => &db_messages[..],
    };

    let mut history_messages: Vec<ChatMessage> = Vec::new();
    for m in effective_messages {
        if m.role == MessageRole::System
            && (m.content == "<!-- context-clear -->"
                || m.content == crate::context_manager::COMPRESSION_MARKER)
        {
            continue;
        }
        if m.role == MessageRole::Tool {
            continue;
        }
        if m.role == MessageRole::Assistant && m.tool_calls_json.is_some() {
            continue;
        }
        // Skip error messages — they should not be sent as context
        if m.status == "error" {
            continue;
        }
        history_messages
            .push(chat_message_from_message(&file_store, m).map_err(|e| e.to_string())?);
    }

    // Resolve proxy config early (needed for both summary generation and main request)
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    // Get model info for token budget and param overrides
    // Get model context window for token budget (resolved_model fetched earlier)
    let model_context_window = resolved_model.as_ref().and_then(|m| m.max_tokens);

    // Load existing summary for this conversation
    let existing_summary =
        aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
            .await
            .ok()
            .flatten();

    // Auto-compression: if enabled and tokens exceed threshold, compress now
    if conversation.context_compression
        && !history_messages.is_empty()
        && crate::context_manager::should_auto_compress(
            &chat_messages,
            &history_messages,
            model_context_window,
        )
    {
        // Perform synchronous compression before sending
        if let Ok(summary_text) = do_compress(
            &state.sea_db,
            &conversation_id,
            &history_messages,
            existing_summary.as_ref().map(|s| s.summary_text.as_str()),
            &provider,
            &decrypted_key,
            &key_row.id,
            &resolved_proxy,
            &conversation.model_id,
            use_max_completion_tokens,
            &global_settings,
            &state.master_key,
        )
        .await
        {
            // Insert compression marker
            let _ = aqbot_core::repo::message::create_message(
                &state.sea_db,
                &conversation_id,
                MessageRole::System,
                crate::context_manager::COMPRESSION_MARKER,
                &[],
                None,
                0,
            )
            .await;

            // Emit marker to frontend
            let _ = app.emit(
                &format!("conversation:compressed:{}", conversation_id),
                &summary_text,
            );

            // After compression, history is now empty (marker splits it)
            // Context = system + summary + current user message only
            chat_messages = crate::context_manager::build_context(
                &chat_messages,
                &[],
                Some(&summary_text),
                model_context_window,
            );
        } else {
            // Compression failed — fall back to sliding window
            chat_messages = crate::context_manager::build_context(
                &chat_messages,
                &history_messages,
                existing_summary.as_ref().map(|s| s.summary_text.as_str()),
                model_context_window,
            );
        }
    } else {
        // No auto-compression: use existing summary (if any) + sliding window
        chat_messages = crate::context_manager::build_context(
            &chat_messages,
            &history_messages,
            existing_summary.as_ref().map(|s| s.summary_text.as_str()),
            model_context_window,
        );
    }

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    // 6. Load MCP tools for enabled servers
    let mcp_ids = enabled_mcp_server_ids.unwrap_or_default();
    let tools: Option<Vec<ChatTool>> = if mcp_ids.is_empty() {
        None
    } else {
        let mut all_tools = Vec::new();
        for server_id in &mcp_ids {
            if let Ok(descriptors) =
                aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, server_id).await
            {
                for td in descriptors {
                    let parameters: Option<serde_json::Value> = td
                        .input_schema_json
                        .as_ref()
                        .and_then(|s| serde_json::from_str(s).ok());
                    all_tools.push(ChatTool {
                        r#type: "function".to_string(),
                        function: ChatToolFunction {
                            name: td.name,
                            description: td.description,
                            parameters,
                        },
                    });
                }
            }
        }
        if all_tools.is_empty() {
            None
        } else {
            Some(all_tools)
        }
    };

    // 7. Spawn streaming in background
    // Convert all remaining system messages to user messages if model doesn't support system role
    if no_system_role {
        for msg in &mut chat_messages {
            if msg.role == "system" {
                msg.role = "user".to_string();
            }
        }
    }

    let user_msg_id = user_message.id.clone();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .stream_cancel_flags
        .lock()
        .await
        .insert(conversation_id.clone(), cancel_flag.clone());
    spawn_stream_task(
        app,
        state.sea_db.clone(),
        conversation_id.clone(),
        assistant_message_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        is_first_message,
        content,
        user_msg_id,
        0,
        tools,
        thinking_budget,
        thinking_level,
        mcp_ids,
        Some(user_message.created_at + 1),
        use_max_completion_tokens,
        force_max_tokens,
        thinking_param_style,
        reasoning_profile,
        model_param_overrides,
        global_settings,
        state.master_key,
        cancel_flag,
        state.stream_cancel_flags.clone(),
        memory_tag,
        false,
        false,
    );

    // Return the user message immediately
    Ok(user_message)
}

#[tauri::command]
pub async fn regenerate_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    user_message_id: Option<String>,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
) -> Result<(), String> {
    // 1. Get all active messages for the conversation
    let messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    // Find target user message: use provided ID or fall back to last user message
    let last_user_msg = if let Some(ref uid) = user_message_id {
        messages
            .iter()
            .find(|m| m.id == *uid && m.role == MessageRole::User)
            .ok_or_else(|| format!("User message {} not found", uid))?
            .clone()
    } else {
        messages
            .iter()
            .rev()
            .find(|m| m.role == MessageRole::User)
            .ok_or("No user message found to regenerate from")?
            .clone()
    };

    // 2. Count existing AI reply versions for this user message
    let existing_versions = aqbot_core::repo::message::list_message_versions(
        &state.sea_db,
        &conversation_id,
        &last_user_msg.id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let new_version_index = existing_versions.len() as i32;

    // Preserve original created_at from first version to maintain message position
    let original_created_at = existing_versions.first().map(|v| v.created_at);

    // Find the currently active version's model to regenerate with the same model
    let active_version = existing_versions.iter().find(|v| v.is_active);
    let active_model_id = active_version.and_then(|v| v.model_id.clone());
    let active_provider_id = active_version.and_then(|v| v.provider_id.clone());

    // 3. Deactivate all existing AI reply versions for this user message
    use aqbot_core::entity::messages as msg_entity;
    use sea_orm::sea_query::Expr;
    msg_entity::Entity::update_many()
        .filter(msg_entity::Column::ConversationId.eq(&conversation_id))
        .filter(msg_entity::Column::ParentMessageId.eq(&last_user_msg.id))
        .col_expr(msg_entity::Column::IsActive, Expr::value(0))
        .exec(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    // 4. Get conversation details
    let mut conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

    // Override conversation model_id/provider_id so spawn_stream_task uses the correct model
    if let Some(ref mid) = active_model_id {
        conversation.model_id = mid.clone();
    }
    if let Some(ref pid) = active_provider_id {
        conversation.provider_id = pid.clone();
    }

    // 5. Get provider config + decrypt key
    let provider =
        aqbot_core::repo::provider::get_provider(&state.sea_db, &conversation.provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let key_row =
        aqbot_core::repo::provider::get_active_key(&state.sea_db, &conversation.provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;

    // 6. Rebuild chat messages (active messages only — old inactive versions excluded)
    let remaining_messages =
        aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();

    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    // Resolve effective system prompt: conversation → category → global default
    let effective_system_prompt = resolve_system_prompt(&state.sea_db, &conversation).await;

    if let Some(ref sys) = effective_system_prompt {
        chat_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(sys.clone()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }

    // 7. Spawn streaming with new version
    let assistant_message_id = aqbot_core::utils::gen_id();

    // RAG retrieval for regeneration
    let memory_tag = {
        let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
        let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
        let rag_result = crate::indexing::collect_rag_context(
            &state.sea_db,
            &state.master_key,
            &state.vector_store,
            &kb_ids,
            &mem_ids,
            &last_user_msg.content,
            5,
        )
        .await;

        let tag = build_memory_retrieval_tag(&rag_result.source_results);

        // Always emit so frontend can replace the searching indicator
        let _ = app.emit(
            "rag-context-retrieved",
            RagContextRetrievedEvent {
                conversation_id: conversation_id.clone(),
                message_id: Some(assistant_message_id.clone()),
                sources: rag_result.source_results,
            },
        );

        if !rag_result.context_parts.is_empty() {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text(format!(
                    "The following reference materials may be relevant to the user's question. Use them if helpful:\n\n{}",
                    rag_result.context_parts.join("\n\n")
                )),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            });
        }
        tag
    };

    // Find the target user message position, then search for context-clear/compressed BEFORE it
    let target_pos = remaining_messages
        .iter()
        .position(|m| m.id == last_user_msg.id);
    let search_range = match target_pos {
        Some(pos) => &remaining_messages[..pos],
        None => &remaining_messages[..],
    };
    let clear_idx = search_range.iter().rposition(|m| {
        m.role == MessageRole::System
            && (m.content == "<!-- context-clear -->"
                || m.content == crate::context_manager::COMPRESSION_MARKER)
    });
    let effective_messages = match clear_idx {
        Some(idx) => &remaining_messages[idx + 1..],
        None => &remaining_messages[..],
    };

    for m in effective_messages {
        if m.role == MessageRole::System
            && (m.content == "<!-- context-clear -->"
                || m.content == crate::context_manager::COMPRESSION_MARKER)
        {
            continue;
        }
        // Skip error messages — they should not be sent as context
        if m.status == "error" {
            continue;
        }
        // Include messages up to and including the last user message
        chat_messages.push(chat_message_from_message(&file_store, m).map_err(|e| e.to_string())?);
        // Stop after the user message we're regenerating from
        if m.id == last_user_msg.id {
            break;
        }
    }

    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    // Load MCP tools for enabled servers
    let mcp_ids = enabled_mcp_server_ids.unwrap_or_default();
    let tools: Option<Vec<ChatTool>> = if mcp_ids.is_empty() {
        None
    } else {
        let mut all_tools = Vec::new();
        for server_id in &mcp_ids {
            if let Ok(descriptors) =
                aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, server_id).await
            {
                for td in descriptors {
                    let parameters: Option<serde_json::Value> = td
                        .input_schema_json
                        .as_ref()
                        .and_then(|s| serde_json::from_str(s).ok());
                    all_tools.push(ChatTool {
                        r#type: "function".to_string(),
                        function: ChatToolFunction {
                            name: td.name,
                            description: td.description,
                            parameters,
                        },
                    });
                }
            }
        }
        if all_tools.is_empty() {
            None
        } else {
            Some(all_tools)
        }
    };

    let regen_model_overrides = aqbot_core::repo::provider::get_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .ok()
    .and_then(|m| m.param_overrides);
    let use_max_completion_tokens = regen_model_overrides
        .as_ref()
        .and_then(|p| p.use_max_completion_tokens);
    let force_max_tokens = regen_model_overrides
        .as_ref()
        .and_then(|p| p.force_max_tokens);
    let no_system_role = regen_model_overrides
        .as_ref()
        .and_then(|p| p.no_system_role)
        .unwrap_or(false);
    let thinking_param_style = regen_model_overrides
        .as_ref()
        .and_then(|p| p.thinking_param_style.clone());
    let reasoning_profile = regen_model_overrides
        .as_ref()
        .and_then(|p| p.reasoning_profile.clone());

    // Convert system messages to user messages if model doesn't support system role
    if no_system_role {
        for msg in &mut chat_messages {
            if msg.role == "system" {
                msg.role = "user".to_string();
            }
        }
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .stream_cancel_flags
        .lock()
        .await
        .insert(conversation_id.clone(), cancel_flag.clone());
    spawn_stream_task(
        app,
        state.sea_db.clone(),
        conversation_id,
        assistant_message_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        false,
        last_user_msg.content,
        last_user_msg.id,
        new_version_index,
        tools,
        thinking_budget,
        thinking_level,
        mcp_ids,
        original_created_at,
        use_max_completion_tokens,
        force_max_tokens,
        thinking_param_style,
        reasoning_profile,
        regen_model_overrides,
        global_settings,
        state.master_key,
        cancel_flag,
        state.stream_cancel_flags.clone(),
        memory_tag,
        false,
        false,
    );

    Ok(())
}

#[tauri::command]
pub async fn regenerate_with_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    user_message_id: String,
    target_provider_id: String,
    target_model_id: String,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
    is_companion: Option<bool>,
) -> Result<(), String> {
    let messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    let user_msg = messages
        .iter()
        .find(|m| m.id == user_message_id && m.role == MessageRole::User)
        .ok_or_else(|| format!("User message {} not found", user_message_id))?
        .clone();

    // Count existing versions and preserve original created_at
    let existing_versions = aqbot_core::repo::message::list_message_versions(
        &state.sea_db,
        &conversation_id,
        &user_msg.id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let new_version_index = existing_versions.len() as i32;
    let original_created_at = existing_versions.first().map(|v| v.created_at);

    let companion = is_companion.unwrap_or(false);

    // Deactivate all existing versions (skip for companion models in multi-model mode)
    use aqbot_core::entity::messages as msg_entity;
    use sea_orm::sea_query::Expr;
    if !companion {
        msg_entity::Entity::update_many()
            .filter(msg_entity::Column::ConversationId.eq(&conversation_id))
            .filter(msg_entity::Column::ParentMessageId.eq(&user_msg.id))
            .col_expr(msg_entity::Column::IsActive, Expr::value(0))
            .exec(&state.sea_db)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Get conversation, but override model_id and provider_id to target values
    let mut conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    conversation.model_id = target_model_id;
    conversation.provider_id = target_provider_id.clone();

    // Use target provider instead of conversation's default
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &target_provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row = aqbot_core::repo::provider::get_active_key(&state.sea_db, &target_provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;

    // Build context messages (same logic as regenerate_message)
    let remaining_messages =
        aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();
    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    // Resolve effective system prompt: conversation → category → global default
    let effective_system_prompt = resolve_system_prompt(&state.sea_db, &conversation).await;

    if let Some(ref sys) = effective_system_prompt {
        tracing::info!(
            "[regenerate_with_model] model={} provider={} effective_system_prompt='{}'",
            &conversation.model_id,
            &conversation.provider_id,
            &sys[..sys.len().min(80)]
        );
        chat_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(sys.clone()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    } else {
        tracing::info!(
            "[regenerate_with_model] model={} provider={} NO system prompt",
            &conversation.model_id,
            &conversation.provider_id
        );
    }

    let assistant_message_id = aqbot_core::utils::gen_id();

    // RAG retrieval
    let memory_tag = {
        let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
        let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
        let rag_result = crate::indexing::collect_rag_context(
            &state.sea_db,
            &state.master_key,
            &state.vector_store,
            &kb_ids,
            &mem_ids,
            &user_msg.content,
            5,
        )
        .await;

        let tag = build_memory_retrieval_tag(&rag_result.source_results);

        // Always emit so frontend can replace the searching indicator
        let _ = app.emit(
            "rag-context-retrieved",
            RagContextRetrievedEvent {
                conversation_id: conversation_id.clone(),
                message_id: Some(assistant_message_id.clone()),
                sources: rag_result.source_results,
            },
        );

        if !rag_result.context_parts.is_empty() {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text(format!(
                    "The following reference materials may be relevant to the user's question. Use them if helpful:\n\n{}",
                    rag_result.context_parts.join("\n\n")
                )),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            });
        }
        tag
    };

    // Context building with context-clear/compressed handling
    let target_pos = remaining_messages.iter().position(|m| m.id == user_msg.id);
    let search_range = match target_pos {
        Some(pos) => &remaining_messages[..pos],
        None => &remaining_messages[..],
    };
    let clear_idx = search_range.iter().rposition(|m| {
        m.role == MessageRole::System
            && (m.content == "<!-- context-clear -->"
                || m.content == crate::context_manager::COMPRESSION_MARKER)
    });
    let effective_messages = match clear_idx {
        Some(idx) => &remaining_messages[idx + 1..],
        None => &remaining_messages[..],
    };
    for m in effective_messages {
        if m.role == MessageRole::System
            && (m.content == "<!-- context-clear -->"
                || m.content == crate::context_manager::COMPRESSION_MARKER)
        {
            continue;
        }
        // Skip error messages — they should not be sent as context
        if m.status == "error" {
            continue;
        }
        chat_messages.push(chat_message_from_message(&file_store, m).map_err(|e| e.to_string())?);
        if m.id == user_msg.id {
            break;
        }
    }

    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    let mcp_ids = enabled_mcp_server_ids.unwrap_or_default();
    let tools: Option<Vec<ChatTool>> = if mcp_ids.is_empty() {
        None
    } else {
        let mut all_tools = Vec::new();
        for server_id in &mcp_ids {
            if let Ok(descriptors) =
                aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, server_id).await
            {
                for td in descriptors {
                    let parameters: Option<serde_json::Value> = td
                        .input_schema_json
                        .as_ref()
                        .and_then(|s| serde_json::from_str(s).ok());
                    all_tools.push(ChatTool {
                        r#type: "function".to_string(),
                        function: ChatToolFunction {
                            name: td.name,
                            description: td.description,
                            parameters,
                        },
                    });
                }
            }
        }
        if all_tools.is_empty() {
            None
        } else {
            Some(all_tools)
        }
    };

    let rwm_overrides = aqbot_core::repo::provider::get_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .ok()
    .and_then(|m| m.param_overrides);
    let use_max_completion_tokens = rwm_overrides
        .as_ref()
        .and_then(|p| p.use_max_completion_tokens);
    let force_max_tokens = rwm_overrides.as_ref().and_then(|p| p.force_max_tokens);
    let no_system_role = rwm_overrides
        .as_ref()
        .and_then(|p| p.no_system_role)
        .unwrap_or(false);
    let thinking_param_style = rwm_overrides
        .as_ref()
        .and_then(|p| p.thinking_param_style.clone());
    let reasoning_profile = rwm_overrides
        .as_ref()
        .and_then(|p| p.reasoning_profile.clone());

    if no_system_role {
        for msg in &mut chat_messages {
            if msg.role == "system" {
                msg.role = "user".to_string();
            }
        }
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .stream_cancel_flags
        .lock()
        .await
        .insert(conversation_id.clone(), cancel_flag.clone());

    // Pre-create the placeholder message BEFORE spawning the stream task so that
    // the frontend can immediately discover it via listMessageVersions and enable
    // model switching in ModelTags without waiting for the first stream chunk.
    {
        use sea_orm::ActiveValue::Set;
        if let Err(e) = (aqbot_core::entity::messages::ActiveModel {
            id: Set(assistant_message_id.clone()),
            conversation_id: Set(conversation_id.clone()),
            role: Set("assistant".to_string()),
            content: Set(String::new()),
            provider_id: Set(Some(provider.id.clone())),
            model_id: Set(Some(conversation.model_id.clone())),
            token_count: Set(None),
            prompt_tokens: Set(None),
            completion_tokens: Set(None),
            attachments: Set("[]".to_string()),
            thinking: Set(None),
            created_at: Set(original_created_at.unwrap_or_else(aqbot_core::utils::now_ts)),
            branch_id: Set(None),
            parent_message_id: Set(Some(user_msg.id.clone())),
            version_index: Set(new_version_index),
            is_active: Set(if companion { 0 } else { 1 }),
            tool_calls_json: Set(None),
            tool_call_id: Set(None),
            status: Set("partial".to_string()),
            tokens_per_second: Set(None),
            first_token_latency_ms: Set(None),
        })
        .insert(&state.sea_db)
        .await
        {
            tracing::error!("Failed to pre-create placeholder message: {}", e);
        }
    }

    tracing::info!(
        "[regenerate_with_model] spawning stream: model={} total_messages={} has_system_prompt={}",
        &conversation.model_id,
        chat_messages.len(),
        chat_messages
            .first()
            .map(|m| m.role == "system")
            .unwrap_or(false)
    );
    spawn_stream_task(
        app,
        state.sea_db.clone(),
        conversation_id,
        assistant_message_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        false,
        user_msg.content,
        user_msg.id,
        new_version_index,
        tools,
        thinking_budget,
        thinking_level,
        mcp_ids,
        original_created_at,
        use_max_completion_tokens,
        force_max_tokens,
        thinking_param_style,
        reasoning_profile,
        rwm_overrides,
        global_settings,
        state.master_key,
        cancel_flag,
        state.stream_cancel_flags.clone(),
        memory_tag,
        companion,
        true,
    );
    Ok(())
}

#[tauri::command]
pub async fn list_message_versions(
    state: State<'_, AppState>,
    conversation_id: String,
    parent_message_id: String,
) -> Result<Vec<Message>, String> {
    aqbot_core::repo::message::list_message_versions(
        &state.sea_db,
        &conversation_id,
        &parent_message_id,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn switch_message_version(
    state: State<'_, AppState>,
    conversation_id: String,
    parent_message_id: String,
    message_id: String,
) -> Result<(), String> {
    aqbot_core::repo::message::set_active_version(
        &state.sea_db,
        &conversation_id,
        &parent_message_id,
        &message_id,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_message_group(
    state: State<'_, AppState>,
    conversation_id: String,
    user_message_id: String,
) -> Result<(), String> {
    let deleted = aqbot_core::repo::message::delete_message_group(&state.sea_db, &user_message_id)
        .await
        .map_err(|e| e.to_string())?;
    // Decrement message count by deleted count
    for _ in 0..deleted {
        aqbot_core::repo::conversation::decrement_message_count(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Internal helper: call LLM to compress messages into a summary and persist it.
async fn do_compress(
    db: &sea_orm::DatabaseConnection,
    conversation_id: &str,
    history_messages: &[ChatMessage],
    existing_summary: Option<&str>,
    provider: &ProviderConfig,
    decrypted_key: &str,
    key_id: &str,
    proxy_config: &Option<ProviderProxyConfig>,
    model_id: &str,
    use_max_completion_tokens: Option<bool>,
    settings: &AppSettings,
    master_key: &[u8; 32],
) -> Result<String, String> {
    // Resolve compression model: settings override → fallback to conversation model
    let (comp_provider, comp_key, comp_key_id, comp_proxy, comp_model_id, comp_use_max) = if let (
        Some(ref pid),
        Some(ref mid),
    ) = (
        &settings.compression_provider_id,
        &settings.compression_model_id,
    ) {
        match aqbot_core::repo::provider::get_provider(db, pid).await {
            Ok(p) => {
                match p.keys.first() {
                    Some(k) => {
                        let dk = aqbot_core::crypto::decrypt_key(&k.key_encrypted, master_key)
                            .map_err(|e| e.to_string())?;
                        let kid = k.id.clone();
                        let proxy = ProviderProxyConfig::resolve(&p.proxy_config, settings);
                        let override_umc = aqbot_core::repo::provider::get_model(db, pid, mid)
                            .await
                            .ok()
                            .and_then(|m| m.param_overrides)
                            .and_then(|po| po.use_max_completion_tokens);
                        (p, dk, kid, proxy, mid.clone(), override_umc)
                    }
                    None => {
                        tracing::warn!("Compression model provider has no key, falling back to conversation model");
                        (
                            provider.clone(),
                            decrypted_key.to_string(),
                            key_id.to_string(),
                            proxy_config.clone(),
                            model_id.to_string(),
                            use_max_completion_tokens,
                        )
                    }
                }
            }
            Err(_) => {
                tracing::warn!(
                    "Compression model provider not found, falling back to conversation model"
                );
                (
                    provider.clone(),
                    decrypted_key.to_string(),
                    key_id.to_string(),
                    proxy_config.clone(),
                    model_id.to_string(),
                    use_max_completion_tokens,
                )
            }
        }
    } else {
        (
            provider.clone(),
            decrypted_key.to_string(),
            key_id.to_string(),
            proxy_config.clone(),
            model_id.to_string(),
            use_max_completion_tokens,
        )
    };

    let sum_req = crate::context_manager::SummarizationRequest {
        existing_summary: existing_summary.map(|s| s.to_string()),
        messages_to_compress: history_messages.to_vec(),
    };

    let custom_prompt = settings.compression_prompt.as_deref();
    let summary_messages = if let Some(prompt) = custom_prompt {
        crate::context_manager::build_summary_prompt_with_custom(&sum_req, prompt)
    } else {
        crate::context_manager::build_summary_prompt(&sum_req)
    };

    let request = ChatRequest {
        model: comp_model_id.clone(),
        messages: summary_messages,
        stream: false,
        temperature: settings
            .compression_temperature
            .map(|v| v as f64)
            .or(Some(0.3)),
        top_p: settings.compression_top_p.map(|v| v as f64),
        max_tokens: settings.compression_max_tokens.or(Some(1024)),
        tools: None,
        thinking_budget: None,
        thinking_level: None,
        reasoning_profile: None,
        use_max_completion_tokens: comp_use_max,
        thinking_param_style: None,
    };

    let ctx = ProviderRequestContext {
        api_key: comp_key,
        key_id: comp_key_id,
        provider_id: comp_provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &comp_provider.api_host,
            &comp_provider.provider_type,
        )),
        api_path: comp_provider.api_path.clone(),
        proxy_config: comp_proxy,
        custom_headers: comp_provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    let registry = ProviderRegistry::create_default();
    let registry_key = provider_type_to_registry_key(&comp_provider.provider_type);
    let adapter = registry
        .get(registry_key)
        .ok_or_else(|| "Provider adapter not found".to_string())?;

    let response = adapter
        .chat(&ctx, request)
        .await
        .map_err(|e| format!("Summary generation failed: {}", e))?;

    let token_count = aqbot_core::token_counter::estimate_tokens(&response.content);
    aqbot_core::repo::conversation::upsert_summary(
        db,
        conversation_id,
        &response.content,
        None,
        Some(token_count as u32),
        Some(&comp_model_id),
    )
    .await
    .map_err(|e| format!("Failed to save summary: {}", e))?;

    tracing::debug!(
        "Compressed context for {} ({} tokens)",
        conversation_id,
        token_count
    );
    Ok(response.content)
}

/// Tauri command: manually compress the current conversation context.
///
/// Returns the generated summary text and inserts a compression marker.
#[tauri::command]
pub async fn compress_context(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ConversationSummary, String> {
    let conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

    // Get provider + key
    let provider =
        aqbot_core::repo::provider::get_provider(&state.sea_db, &conversation.provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let key_row = provider
        .keys
        .first()
        .ok_or_else(|| "No API key configured".to_string())?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;

    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    // Load messages after last marker
    let db_messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    let file_store = aqbot_core::file_store::FileStore::new();

    // For manual compression: try messages after last marker first,
    // fall back to ALL messages if nothing after marker
    let marker_idx = db_messages.iter().rposition(|m| {
        m.role == MessageRole::System
            && (m.content == "<!-- context-clear -->"
                || m.content == crate::context_manager::COMPRESSION_MARKER)
    });

    let collect_messages = |msgs: &[Message]| -> Result<Vec<ChatMessage>, String> {
        let mut out = Vec::new();
        for m in msgs {
            if m.role == MessageRole::System
                && (m.content == "<!-- context-clear -->"
                    || m.content == crate::context_manager::COMPRESSION_MARKER)
            {
                continue;
            }
            if m.role == MessageRole::Tool {
                continue;
            }
            if m.role == MessageRole::Assistant && m.tool_calls_json.is_some() {
                continue;
            }
            out.push(chat_message_from_message(&file_store, m).map_err(|e| e.to_string())?);
        }
        Ok(out)
    };

    let mut history_messages = match marker_idx {
        Some(idx) => collect_messages(&db_messages[idx + 1..])?,
        None => collect_messages(&db_messages)?,
    };

    // If nothing after the last marker, try all messages
    if history_messages.is_empty() && marker_idx.is_some() {
        history_messages = collect_messages(&db_messages)?;
    }

    if history_messages.is_empty() {
        return Err("No messages to compress".to_string());
    }

    // Load existing summary
    let existing_summary =
        aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
            .await
            .ok()
            .flatten();

    // Compress
    let use_max_completion_tokens = aqbot_core::repo::provider::get_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .ok()
    .and_then(|m| m.param_overrides)
    .and_then(|p| p.use_max_completion_tokens);

    do_compress(
        &state.sea_db,
        &conversation_id,
        &history_messages,
        existing_summary.as_ref().map(|s| s.summary_text.as_str()),
        &provider,
        &decrypted_key,
        &key_row.id,
        &resolved_proxy,
        &conversation.model_id,
        use_max_completion_tokens,
        &global_settings,
        &state.master_key,
    )
    .await?;

    // Insert compression marker message
    let marker_msg = aqbot_core::repo::message::create_message(
        &state.sea_db,
        &conversation_id,
        MessageRole::System,
        crate::context_manager::COMPRESSION_MARKER,
        &[],
        None,
        0,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Emit events to frontend
    let _ = app.emit(
        &format!("conversation:compressed:{}", conversation_id),
        &marker_msg,
    );

    // Return the updated summary
    let summary = aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Summary not found after compression".to_string())?;

    Ok(summary)
}

/// Tauri command: get the compression summary for a conversation.
#[tauri::command]
pub async fn get_compression_summary(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<ConversationSummary>, String> {
    aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

/// Tauri command: delete the compression summary and all marker messages.
#[tauri::command]
pub async fn delete_compression(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    // Delete the summary
    aqbot_core::repo::conversation::delete_summary(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    // Delete all compression marker messages
    aqbot_core::entity::messages::Entity::delete_many()
        .filter(aqbot_core::entity::messages::Column::ConversationId.eq(&conversation_id))
        .filter(
            aqbot_core::entity::messages::Column::Content
                .eq(crate::context_manager::COMPRESSION_MARKER),
        )
        .exec(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn send_system_message(
    state: State<'_, AppState>,
    conversation_id: String,
    content: String,
) -> Result<Message, String> {
    let msg = aqbot_core::repo::message::create_message(
        &state.sea_db,
        &conversation_id,
        MessageRole::System,
        &content,
        &[],
        None,
        0,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn test_conversation(
        temperature: Option<f32>,
        max_tokens: Option<u32>,
        top_p: Option<f32>,
    ) -> Conversation {
        Conversation {
            id: "conv-1".to_string(),
            title: "Conversation".to_string(),
            model_id: "model-1".to_string(),
            provider_id: "provider-1".to_string(),
            system_prompt: None,
            temperature,
            max_tokens,
            top_p,
            frequency_penalty: None,
            search_enabled: false,
            search_provider_id: None,
            thinking_budget: None,
            thinking_level: None,
            enabled_mcp_server_ids: Vec::new(),
            enabled_knowledge_base_ids: Vec::new(),
            enabled_memory_namespace_ids: Vec::new(),
            message_count: 0,
            is_pinned: false,
            is_archived: false,
            context_compression: false,
            category_id: None,
            parent_conversation_id: None,
            mode: "chat".to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn test_param_overrides(
        temperature: Option<f32>,
        max_tokens: Option<u32>,
        top_p: Option<f32>,
    ) -> ModelParamOverrides {
        ModelParamOverrides {
            temperature,
            max_tokens,
            top_p,
            frequency_penalty: None,
            use_max_completion_tokens: None,
            no_system_role: None,
            force_max_tokens: None,
            thinking_param_style: None,
            reasoning_profile: None,
            reasoning_options: None,
            reasoning_default: None,
        }
    }

    #[test]
    fn title_summary_uses_reasoning_safe_default_max_tokens() {
        let mut settings = AppSettings::default();
        assert_eq!(
            title_summary_max_tokens(&settings),
            DEFAULT_TITLE_SUMMARY_MAX_TOKENS
        );

        settings.title_summary_max_tokens = Some(128);
        assert_eq!(title_summary_max_tokens(&settings), 128);
    }

    #[test]
    fn clean_generated_title_trims_common_quote_wrappers() {
        assert_eq!(
            clean_generated_title("  「项目排期讨论」  "),
            "项目排期讨论"
        );
        assert_eq!(clean_generated_title("\"API 调试记录\""), "API 调试记录");
    }

    #[test]
    fn assistant_history_extracts_thinking_into_reasoning_content() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let message = Message {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            role: MessageRole::Assistant,
            content: "<think totalMs=\"123\">\nhidden thinking\n</think>\n\nfinal answer".into(),
            provider_id: None,
            model_id: None,
            token_count: None,
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            first_token_latency_ms: None,
            attachments: Vec::new(),
            thinking: None,
            tool_calls_json: None,
            tool_call_id: None,
            created_at: 0,
            parent_message_id: None,
            version_index: 0,
            is_active: true,
            status: "complete".into(),
        };

        let chat_message = chat_message_from_message(&file_store, &message).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        assert_eq!(serialized["content"], "final answer");
        assert_eq!(serialized["reasoning_content"], "hidden thinking");
    }

    #[test]
    fn model_params_override_global_defaults_when_conversation_params_are_unset() {
        let mut settings = AppSettings::default();
        settings.default_temperature = Some(0.875);
        settings.default_top_p = Some(0.9375);
        settings.default_max_tokens = Some(32768);

        let params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(Some(0.25), Some(4096), Some(0.75))),
            &settings,
            None,
        );

        assert_eq!(params.temperature, Some(0.25));
        assert_eq!(params.top_p, Some(0.75));
        assert_eq!(params.max_tokens, Some(4096));
    }

    #[test]
    fn conversation_params_override_model_and_global_defaults() {
        let mut settings = AppSettings::default();
        settings.default_temperature = Some(0.875);
        settings.default_top_p = Some(0.9375);
        settings.default_max_tokens = Some(32768);

        let params = resolve_chat_model_params(
            &test_conversation(Some(0.5), Some(8192), Some(0.625)),
            Some(&test_param_overrides(Some(0.25), Some(4096), Some(0.75))),
            &settings,
            None,
        );

        assert_eq!(params.temperature, Some(0.5));
        assert_eq!(params.top_p, Some(0.625));
        assert_eq!(params.max_tokens, Some(8192));
    }

    #[test]
    fn force_max_tokens_uses_specific_defaults_before_falling_back_to_4096() {
        let mut settings = AppSettings::default();
        settings.default_max_tokens = Some(32768);

        let model_params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(None, Some(4096), None)),
            &settings,
            Some(true),
        );
        assert_eq!(model_params.max_tokens, Some(4096));

        settings.default_max_tokens = None;
        let fallback_params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            None,
            &settings,
            Some(true),
        );
        assert_eq!(fallback_params.max_tokens, Some(4096));
    }

    #[test]
    fn build_message_content_turns_images_into_multipart_data_urls() {
        let temp_dir =
            std::env::temp_dir().join(format!("aqbot-vision-test-{}", aqbot_core::utils::gen_id()));
        fs::create_dir_all(&temp_dir).unwrap();

        let result = (|| {
            let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
            let saved = file_store
                .save_file(b"abc", "image.png", "image/png")
                .unwrap();
            let message = Message {
                id: "msg-1".into(),
                conversation_id: "conv-1".into(),
                role: MessageRole::User,
                content: "Describe this image".into(),
                provider_id: None,
                model_id: None,
                token_count: None,
                prompt_tokens: None,
                completion_tokens: None,
                tokens_per_second: None,
                first_token_latency_ms: None,
                attachments: vec![Attachment {
                    id: "att-1".into(),
                    file_type: "image/png".into(),
                    file_name: "image.png".into(),
                    file_path: saved.storage_path,
                    file_size: 3,
                    data: None,
                }],
                thinking: None,
                tool_calls_json: None,
                tool_call_id: None,
                created_at: 0,
                parent_message_id: None,
                version_index: 0,
                is_active: true,
                status: "done".into(),
            };

            build_message_content(&file_store, &message).unwrap()
        })();

        fs::remove_dir_all(&temp_dir).unwrap();

        match result {
            ChatContent::Multipart(parts) => {
                assert_eq!(parts.len(), 2);
                assert_eq!(parts[0].text.as_deref(), Some("Describe this image"));
                assert_eq!(
                    parts[1].image_url.as_ref().map(|img| img.url.as_str()),
                    Some("data:image/png;base64,YWJj")
                );
            }
            ChatContent::Text(_) => panic!("expected multipart content"),
        }
    }

    #[test]
    fn build_message_content_uses_inline_attachment_data_when_file_path_is_missing() {
        let temp_dir =
            std::env::temp_dir().join(format!("aqbot-vision-test-{}", aqbot_core::utils::gen_id()));
        fs::create_dir_all(&temp_dir).unwrap();

        let result = (|| {
            let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
            let message = Message {
                id: "msg-1".into(),
                conversation_id: "conv-1".into(),
                role: MessageRole::User,
                content: "Old attachment".into(),
                provider_id: None,
                model_id: None,
                token_count: None,
                prompt_tokens: None,
                completion_tokens: None,
                tokens_per_second: None,
                first_token_latency_ms: None,
                attachments: vec![Attachment {
                    id: String::new(),
                    file_type: "image/png".into(),
                    file_name: "image.png".into(),
                    file_path: String::new(),
                    file_size: 3,
                    data: Some("YWJj".into()),
                }],
                thinking: None,
                tool_calls_json: None,
                tool_call_id: None,
                created_at: 0,
                parent_message_id: None,
                version_index: 0,
                is_active: true,
                status: "done".into(),
            };

            build_message_content(&file_store, &message).unwrap()
        })();

        fs::remove_dir_all(&temp_dir).unwrap();

        match result {
            ChatContent::Multipart(parts) => {
                assert_eq!(
                    parts[1].image_url.as_ref().map(|img| img.url.as_str()),
                    Some("data:image/png;base64,YWJj")
                );
            }
            ChatContent::Text(_) => panic!("expected multipart content"),
        }
    }

    #[tokio::test]
    async fn delete_conversation_removes_attached_files_and_records() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-conv-delete-test-{}",
            aqbot_core::utils::gen_id()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Files cleanup",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();

        let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
        let saved = file_store
            .save_file(b"cleanup me", "cleanup.png", "image/png")
            .unwrap();
        let physical_path = temp_dir.join(&saved.storage_path);
        assert!(
            physical_path.exists(),
            "fixture file must exist before deleting the conversation"
        );

        aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "file-1",
            &saved.hash,
            "cleanup.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&conversation.id),
        )
        .await
        .unwrap();

        let result =
            delete_conversation_with_attachments_using(&db, &file_store, &conversation.id).await;
        assert!(
            result.is_ok(),
            "deleting a conversation should clean up its attached files, got: {result:?}"
        );
        assert!(
            aqbot_core::repo::conversation::get_conversation(&db, &conversation.id)
                .await
                .is_err(),
            "conversation must be deleted"
        );
        assert!(
            aqbot_core::repo::stored_file::list_stored_files_by_conversation(&db, &conversation.id)
                .await
                .unwrap()
                .is_empty(),
            "conversation attachments must be removed from the database"
        );
        assert!(
            !physical_path.exists(),
            "conversation deletion must remove the backing attachment file from disk"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn persist_attachments_registers_stored_files_for_files_page() {
        use base64::Engine;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-persist-attachments-test-{}",
            aqbot_core::utils::gen_id()
        ));
        fs::create_dir_all(&temp_dir).unwrap();
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Image indexing",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();

        let vector_store = Arc::new(aqbot_core::vector_store::VectorStore::new(db.clone()));
        let state = crate::AppState {
            sea_db: db.clone(),
            master_key: [0; 32],
            gateway: Arc::new(Mutex::new(None)),
            close_to_tray: Arc::new(AtomicBool::new(false)),
            app_data_dir: temp_dir.clone(),
            db_path: "sqlite::memory:".to_string(),
            auto_backup_handle: Arc::new(Mutex::new(None)),
            webdav_sync_handle: Arc::new(Mutex::new(None)),
            vector_store,
            stream_cancel_flags: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_cancel_tokens: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_permission_senders: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_ask_senders: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_always_allowed: Arc::new(Mutex::new(std::collections::HashMap::new())),
        };

        let attachments = vec![AttachmentInput {
            file_name: "screen.png".to_string(),
            file_type: "image/png".to_string(),
            file_size: 3,
            data: base64::engine::general_purpose::STANDARD.encode(b"abc"),
        }];

        let persisted = persist_attachments(&state, &conversation.id, &attachments)
            .await
            .unwrap();
        assert_eq!(persisted.len(), 1);
        assert!(
            persisted[0].file_path.starts_with("images/"),
            "storage path should start with images/ bucket, got: {}",
            persisted[0].file_path
        );

        let stored_files = aqbot_core::repo::stored_file::list_all_stored_files(&db)
            .await
            .unwrap();
        assert_eq!(
            stored_files.len(),
            1,
            "persisted chat attachments must be indexed for the files page"
        );
        assert_eq!(stored_files[0].original_name, "screen.png");
        assert_eq!(stored_files[0].mime_type, "image/png");

        // Cleanup: remove file written to documents root
        let _ = aqbot_core::file_store::FileStore::new().delete_file(&persisted[0].file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
