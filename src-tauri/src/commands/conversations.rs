use crate::AppState;
use aqbot_core::types::*;
use aqbot_providers::{
    registry::ProviderRegistry, resolve_base_url_for_type, ProviderAdapter, ProviderRequestContext,
};
use base64::Engine;
use sea_orm::*;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, State};

const RAG_CONTEXT_TIMEOUT: Duration = Duration::from_secs(60);
const RAG_RETRIEVAL_FAILED_PREFIX: &str = "检索失败";
const SYSTEM_PROMPT_LOG_EXCERPT_BYTES: usize = 80;
const SEARCH_QUERY_HISTORY_LIMIT: usize = 6;
const SEARCH_QUERY_MESSAGE_CHAR_LIMIT: usize = 500;
const SEARCH_QUERY_CURRENT_CHAR_LIMIT: usize = 500;
const SEARCH_QUERY_MAX_TOKENS: u32 = 96;
const SEARCH_QUERY_RETRY_MAX_TOKENS: u32 = 1024;
const MCP_TOOL_RESULT_MAX_BYTES: usize = 50_000;
const MCP_TOOL_LOOP_MIN_ITERATIONS: u32 = 1;
const MCP_TOOL_LOOP_MAX_ITERATIONS: u32 = 100;

fn system_prompt_log_excerpt(prompt: &str) -> &str {
    let end = prompt.floor_char_boundary(prompt.len().min(SYSTEM_PROMPT_LOG_EXCERPT_BYTES));
    &prompt[..end]
}

fn format_rag_failure_message(reason: &str) -> String {
    let reason = reason.trim();
    if reason.is_empty() {
        return RAG_RETRIEVAL_FAILED_PREFIX.to_string();
    }
    if reason.starts_with(RAG_RETRIEVAL_FAILED_PREFIX) {
        return reason.to_string();
    }
    format!("{RAG_RETRIEVAL_FAILED_PREFIX}：{reason}")
}

fn rag_timeout_failure_reason() -> String {
    format!("检索超时，已超过 {} 秒", RAG_CONTEXT_TIMEOUT.as_secs())
}

fn provider_type_to_registry_key(pt: &ProviderType) -> &'static str {
    match pt {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::DeepSeek => "deepseek",
        ProviderType::XAI => "xai",
        ProviderType::GLM => "glm",
        ProviderType::SiliconFlow => "siliconflow",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Custom => "custom",
    }
}

async fn resolve_command_provider_id(
    db: &DatabaseConnection,
    provider_id: &str,
) -> Result<String, String> {
    aqbot_core::repo::provider::resolve_provider_id(db, provider_id)
        .await
        .map_err(|e| e.to_string())
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

#[derive(Debug, Clone, Copy, PartialEq)]
struct StreamTimeoutConfig {
    first_packet: Option<Duration>,
    idle: Option<Duration>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ContextBoundary {
    start_index: usize,
    use_summary: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CompressionEvent {
    conversation_id: String,
    marker_message: Message,
    summary: ConversationSummary,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextUsage {
    used_tokens: u32,
    max_tokens: Option<u32>,
    threshold_tokens: Option<u32>,
    has_summary: bool,
    compressed_until_message_id: Option<String>,
    messages_after_boundary: u32,
}

fn stream_timeout_config_from_settings(settings: &AppSettings) -> StreamTimeoutConfig {
    StreamTimeoutConfig {
        first_packet: duration_from_timeout_secs(settings.chat_stream_first_packet_timeout_secs),
        idle: duration_from_timeout_secs(settings.chat_stream_idle_timeout_secs),
    }
}

fn mcp_tool_loop_max_iterations_from_settings(settings: &AppSettings) -> usize {
    settings
        .mcp_tool_loop_max_iterations
        .clamp(MCP_TOOL_LOOP_MIN_ITERATIONS, MCP_TOOL_LOOP_MAX_ITERATIONS) as usize
}

fn duration_from_timeout_secs(seconds: u64) -> Option<Duration> {
    (seconds > 0).then(|| Duration::from_secs(seconds))
}

const ACTIVE_STREAM_EXISTS_ERROR: &str = "当前会话已有回复正在生成，请等待完成或停止后再发送";

async fn has_active_stream_for_conversation(
    cancel_flags: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, crate::StreamCancelEntry>>,
    >,
    conversation_id: &str,
) -> bool {
    let flags = cancel_flags.lock().await;
    flags.values().any(|entry| {
        entry.conversation_id == conversation_id
            && !entry.flag.load(std::sync::atomic::Ordering::Relaxed)
    })
}

async fn register_stream_cancel_flag(
    cancel_flags: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, crate::StreamCancelEntry>>,
    >,
    conversation_id: &str,
    stream_id: &str,
    cancel_flag: Arc<AtomicBool>,
    allow_parallel: bool,
) -> Result<(), String> {
    let mut flags = cancel_flags.lock().await;
    let has_active_stream = flags.values().any(|entry| {
        entry.conversation_id == conversation_id
            && !entry.flag.load(std::sync::atomic::Ordering::Relaxed)
    });
    if has_active_stream && !allow_parallel {
        return Err(ACTIVE_STREAM_EXISTS_ERROR.to_string());
    }

    flags.insert(
        stream_id.to_string(),
        crate::StreamCancelEntry {
            conversation_id: conversation_id.to_string(),
            flag: cancel_flag,
        },
    );
    Ok(())
}

struct RegisteredStreamGuard {
    cancel_flags:
        Arc<tokio::sync::Mutex<std::collections::HashMap<String, crate::StreamCancelEntry>>>,
    stream_id: String,
    cancel_flag: Arc<AtomicBool>,
    released: bool,
}

impl RegisteredStreamGuard {
    async fn register(
        cancel_flags: Arc<
            tokio::sync::Mutex<std::collections::HashMap<String, crate::StreamCancelEntry>>,
        >,
        conversation_id: &str,
        stream_id: &str,
        cancel_flag: Arc<AtomicBool>,
        allow_parallel: bool,
    ) -> Result<Self, String> {
        register_stream_cancel_flag(
            cancel_flags.clone(),
            conversation_id,
            stream_id,
            cancel_flag.clone(),
            allow_parallel,
        )
        .await?;

        Ok(Self {
            cancel_flags,
            stream_id: stream_id.to_string(),
            cancel_flag,
            released: false,
        })
    }

    async fn release(mut self) {
        self.released = true;
        self.cancel_flags.lock().await.remove(&self.stream_id);
    }
}

impl Drop for RegisteredStreamGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }

        self.cancel_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let cancel_flags = self.cancel_flags.clone();
        let stream_id = self.stream_id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                cancel_flags.lock().await.remove(&stream_id);
            });
        }
    }
}

fn build_stream_error_event(
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    error: String,
    kind: &str,
    timeout_secs: Option<u64>,
) -> ChatStreamErrorEvent {
    let safe = aqbot_core::inline_media::filter_complete_inline_data;
    ChatStreamErrorEvent {
        conversation_id: safe(conversation_id),
        message_id: safe(message_id),
        stream_id: Some(safe(stream_id)),
        model_id: Some(safe(model_id)),
        provider_id: Some(safe(provider_id)),
        error: safe(&error),
        kind: Some(safe(kind)),
        timeout_secs,
    }
}

fn build_tool_loop_exceeded_error_event(
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    max_iterations: usize,
) -> ChatStreamErrorEvent {
    build_stream_error_event(
        conversation_id,
        message_id,
        stream_id,
        model_id,
        provider_id,
        format!("MCP tool loop exceeded {} iterations", max_iterations),
        "tool_loop_exceeded",
        None,
    )
}

fn build_stream_timeout_error_event(
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    received_stream_packet: bool,
    timeout: Duration,
) -> ChatStreamErrorEvent {
    let timeout_secs = timeout.as_secs();
    let (kind, error) = if received_stream_packet {
        (
            "idle_timeout",
            format!("模型响应空闲超时，已超过 {} 秒未收到新内容", timeout_secs),
        )
    } else {
        (
            "first_packet_timeout",
            format!("模型首包超时，已超过 {} 秒未收到响应", timeout_secs),
        )
    };

    build_stream_error_event(
        conversation_id,
        message_id,
        stream_id,
        model_id,
        provider_id,
        error,
        kind,
        Some(timeout_secs),
    )
}

fn build_stream_done_event(
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    usage: Option<TokenUsage>,
) -> ChatStreamEvent {
    let safe = aqbot_core::inline_media::filter_complete_inline_data;
    ChatStreamEvent {
        conversation_id: safe(conversation_id),
        message_id: safe(message_id),
        stream_id: Some(safe(stream_id)),
        model_id: Some(safe(model_id)),
        provider_id: Some(safe(provider_id)),
        chunk: ChatStreamChunk {
            content: None,
            thinking: None,
            done: true,
            is_final: Some(true),
            usage,
            tool_calls: None,
        },
    }
}

fn pre_persist_stream_chunk(chunk: &ChatStreamChunk) -> Option<ChatStreamChunk> {
    if !chunk.done {
        return Some(chunk.clone());
    }

    let has_tool_calls = chunk
        .tool_calls
        .as_ref()
        .is_some_and(|tool_calls| !tool_calls.is_empty());
    if has_tool_calls {
        let mut non_final = chunk.clone();
        non_final.is_final = Some(false);
        return Some(non_final);
    }

    if chunk.content.is_none() && chunk.thinking.is_none() && chunk.usage.is_none() {
        return None;
    }

    let mut delta = chunk.clone();
    delta.done = false;
    delta.is_final = None;
    Some(delta)
}

fn filter_inline_data_stream_event_content(
    filter: &mut aqbot_core::inline_media::InlineDataStreamFilter,
    content: &str,
    is_done: bool,
) -> String {
    let mut filtered = filter.push(content);
    if is_done {
        filtered.push_str(&filter.finish());
    }
    filtered
}

fn filter_complete_inline_data_event_text(content: &str) -> String {
    let mut filter = aqbot_core::inline_media::InlineDataStreamFilter::default();
    filter_inline_data_stream_event_content(&mut filter, content, true)
}

fn filter_tool_calls_for_event(tool_calls: Option<&[ToolCall]>) -> Option<Vec<ToolCall>> {
    tool_calls.map(|tool_calls| {
        tool_calls
            .iter()
            .cloned()
            .map(|mut tool_call| {
                tool_call.id = filter_complete_inline_data_event_text(&tool_call.id);
                tool_call.call_type =
                    filter_complete_inline_data_event_text(&tool_call.call_type);
                tool_call.function.name =
                    filter_complete_inline_data_event_text(&tool_call.function.name);
                tool_call.function.arguments =
                    filter_complete_inline_data_event_text(&tool_call.function.arguments);
                tool_call
            })
            .collect()
    })
}

const STREAM_ERROR_CONTENT_MARKER: &str = "<!-- aqbot-stream-error -->";

fn append_stream_error_to_content(content: &str, error: &str) -> String {
    let trimmed_content = content.trim_end();
    let trimmed_error = error.trim();
    if trimmed_content.trim().is_empty() {
        return trimmed_error.to_string();
    }

    if let Some((prefix, _)) = trimmed_content.split_once(STREAM_ERROR_CONTENT_MARKER) {
        return format!(
            "{}\n\n{}\n{}",
            prefix.trim_end(),
            STREAM_ERROR_CONTENT_MARKER,
            trimmed_error
        );
    }

    format!(
        "{}\n\n{}\n{}",
        trimmed_content, STREAM_ERROR_CONTENT_MARKER, trimmed_error
    )
}

fn resolve_chat_model_params(
    conversation: &Conversation,
    model_param_overrides: Option<&ModelParamOverrides>,
    settings: &AppSettings,
    _use_max_completion_tokens: Option<bool>,
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
    let max_tokens = match conversation.max_tokens {
        Some(max_tokens) => Some(max_tokens),
        None if force_max_tokens == Some(true) => model_param_overrides
            .and_then(|p| p.max_tokens)
            .or(settings.default_max_tokens)
            .or(Some(4096)),
        None => settings.default_max_tokens,
    };

    EffectiveChatModelParams {
        temperature,
        top_p,
        max_tokens,
    }
}

fn model_extra_body_from_overrides(
    model_param_overrides: Option<&ModelParamOverrides>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    model_param_overrides.and_then(|params| params.extra_body.clone())
}

pub(crate) async fn persist_attachments(
    state: &AppState,
    conversation_id: &str,
    attachments: &[AttachmentInput],
) -> aqbot_core::error::Result<Vec<Attachment>> {
    for (index, attachment) in attachments.iter().enumerate() {
        if aqbot_core::inline_media::contains_inline_image_data(&attachment.file_name)
            || aqbot_core::inline_media::contains_inline_image_data(&attachment.file_type)
        {
            return Err(aqbot_core::error::AQBotError::Validation(format!(
                "Attachment {index} metadata contains inline image data"
            )));
        }
    }
    aqbot_core::storage_paths::ensure_documents_dirs()?;
    let file_store = aqbot_core::file_store::FileStore::new();
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let txn = state.sea_db.begin().await?;
    let mut created_paths = Vec::new();
    let operation = async {
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
            let saved =
                file_store.save_file(&data, &attachment.file_name, &attachment.file_type)?;
            if saved.created {
                created_paths.push(saved.storage_path.clone());
            }
            let stored_file_id = aqbot_core::utils::gen_id();
            aqbot_core::entity::stored_files::ActiveModel {
                id: Set(stored_file_id.clone()),
                hash: Set(saved.hash),
                original_name: Set(attachment.file_name.clone()),
                mime_type: Set(attachment.file_type.clone()),
                size_bytes: Set(saved.size_bytes),
                storage_path: Set(saved.storage_path.clone()),
                conversation_id: Set(Some(conversation_id.to_string())),
                ..Default::default()
            }
            .insert(&txn)
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
        Ok::<_, aqbot_core::error::AQBotError>(persisted)
    }
    .await;

    let persisted = match operation {
        Ok(persisted) => persisted,
        Err(error) => {
            let rollback_error = txn.rollback().await.err();
            let cleanup_errors =
                cleanup_created_attachment_paths(&state.sea_db, &file_store, &created_paths).await;
            return Err(attachment_persistence_failure(
                error,
                rollback_error,
                cleanup_errors,
            ));
        }
    };
    if let Err(error) = txn.commit().await {
        let cleanup_errors =
            cleanup_created_attachment_paths(&state.sea_db, &file_store, &created_paths).await;
        return Err(attachment_persistence_failure(
            error.into(),
            None,
            cleanup_errors,
        ));
    }
    Ok(persisted)
}

async fn cleanup_created_attachment_paths(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    paths: &[String],
) -> Vec<String> {
    let mut errors = Vec::new();
    for path in paths {
        match aqbot_core::repo::stored_file::count_stored_files_with_storage_path(db, path).await {
            Ok(0) => {
                if let Err(error) = file_store.delete_file(path) {
                    errors.push(format!("failed to remove {path}: {error}"));
                }
            }
            Ok(_) => {}
            Err(error) => errors.push(format!("failed to inspect {path}: {error}")),
        }
    }
    errors
}

fn attachment_persistence_failure(
    primary: aqbot_core::error::AQBotError,
    rollback: Option<sea_orm::DbErr>,
    cleanup: Vec<String>,
) -> aqbot_core::error::AQBotError {
    if rollback.is_none() && cleanup.is_empty() {
        return primary;
    }
    aqbot_core::error::AQBotError::Validation(format!(
        "{primary}; rollback error: {}; cleanup errors: {}",
        rollback
            .map(|error| error.to_string())
            .unwrap_or_else(|| "none".to_string()),
        if cleanup.is_empty() {
            "none".to_string()
        } else {
            cleanup.join(", ")
        }
    ))
}

pub(crate) async fn cleanup_new_message_attachments(
    db: &DatabaseConnection,
    attachments: &[Attachment],
) -> Vec<String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    let mut ids = attachments
        .iter()
        .map(|attachment| attachment.id.as_str())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    let mut errors = Vec::new();
    for id in ids {
        if let Err(error) =
            crate::commands::file_cleanup::delete_attachment_reference(db, &file_store, id).await
        {
            errors.push(format!("failed to clean attachment {id}: {error}"));
        }
    }
    errors
}

pub(crate) async fn rollback_new_message(
    db: &DatabaseConnection,
    message_id: &str,
    attachments: &[Attachment],
) -> Vec<String> {
    if let Err(error) = aqbot_core::repo::message::delete_message(db, message_id).await {
        return vec![format!(
            "failed to remove message {message_id}; attachments were retained: {error}"
        )];
    }
    cleanup_new_message_attachments(db, attachments).await
}

pub(crate) fn format_new_message_failure(
    message_id: &str,
    stage: &str,
    primary: impl std::fmt::Display,
    rollback_errors: Vec<String>,
) -> String {
    let rollback = if rollback_errors.is_empty() {
        "none".to_string()
    } else {
        rollback_errors.join(", ")
    };
    format!("Message {message_id} {stage}: {primary}; rollback errors: {rollback}")
}

async fn finalize_new_message_for_ipc(
    db: &DatabaseConnection,
    message: Message,
    prepared: Option<&aqbot_core::inline_media::PreparedInlineMedia>,
) -> Result<Message, String> {
    let message_id = message.id.clone();
    let mut rollback_attachments = message.attachments.clone();
    let finalized = match prepared {
        Some(prepared) => {
            let file_store = aqbot_core::file_store::FileStore::new();
            match aqbot_core::inline_media::materialize_prepared_message_inline_images(
                db,
                &file_store,
                &message_id,
                prepared,
            )
            .await
            {
                Ok(message) => message,
                Err(error) => {
                    let rollback_errors =
                        rollback_new_message(db, &message_id, &rollback_attachments).await;
                    return Err(format_new_message_failure(
                        &message_id,
                        "inline media persistence failed",
                        error,
                        rollback_errors,
                    ));
                }
            }
        }
        None => message,
    };
    rollback_attachments = finalized.attachments.clone();
    if let Err(error) = crate::commands::messages::ensure_message_safe_for_ipc(&finalized) {
        let rollback_errors =
            rollback_new_message(db, &message_id, &rollback_attachments).await;
        return Err(format_new_message_failure(
            &message_id,
            "IPC validation failed",
            error,
            rollback_errors,
        ));
    }
    Ok(finalized)
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

const SEARCH_MARKER_START: &str = "<!-- search:";
const SEARCH_MARKER_END: &str = " -->";
const SEARCH_SEPARATOR: &str = "\n---\n\n";

fn strip_search_enrichment(content: &str) -> String {
    let trimmed_start = content.trim_start();
    if !trimmed_start.starts_with(SEARCH_MARKER_START) {
        return content.to_string();
    }

    let Some(marker_end) = trimmed_start.find(SEARCH_MARKER_END) else {
        return content.to_string();
    };
    let after_marker = &trimmed_start[marker_end + SEARCH_MARKER_END.len()..];
    let Some(separator) = after_marker.find(SEARCH_SEPARATOR) else {
        return content.to_string();
    };

    after_marker[separator + SEARCH_SEPARATOR.len()..]
        .trim()
        .to_string()
}

fn strip_search_metadata_marker(content: &str) -> String {
    let trimmed_start = content.trim_start();
    if !trimmed_start.starts_with(SEARCH_MARKER_START) {
        return content.to_string();
    }

    let Some(marker_end) = trimmed_start.find(SEARCH_MARKER_END) else {
        return content.to_string();
    };

    trimmed_start[marker_end + SEARCH_MARKER_END.len()..]
        .trim_start_matches('\n')
        .to_string()
}

/// Strip display-only tags from assistant message content so they aren't sent to the AI.
/// Strips: `<web-search-query data-aqbot="1">`, `<web-search data-aqbot="1">`, `<knowledge-retrieval data-aqbot="1">`,
/// and `<memory-retrieval data-aqbot="1">` tags,
/// `:::mcp ... :::` fenced blocks, and `<think>...</think>` blocks.
fn strip_display_tags(content: &str) -> String {
    // Strip <think> blocks first
    let content = strip_think_tags(content);
    // Strip AQBot display tags with data-aqbot attribute
    let content = {
        let mut s = content.to_string();
        for tag_name in &[
            "web-search-query",
            "web-search",
            "knowledge-retrieval",
            "memory-retrieval",
        ] {
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

const DOCUMENT_ATTACHMENT_UNKNOWN_CONTEXT_CHAR_LIMIT: usize = 48_000;
const DOCUMENT_ATTACHMENT_MIN_CONTEXT_CHAR_LIMIT: usize = 12_000;
const DOCUMENT_ATTACHMENT_MAX_CONTEXT_CHAR_LIMIT: usize = 96_000;

fn document_attachment_char_limit(model_context_window: Option<u32>) -> usize {
    model_context_window
        .map(|tokens| (tokens as usize).saturating_mul(2))
        .unwrap_or(DOCUMENT_ATTACHMENT_UNKNOWN_CONTEXT_CHAR_LIMIT)
        .clamp(
            DOCUMENT_ATTACHMENT_MIN_CONTEXT_CHAR_LIMIT,
            DOCUMENT_ATTACHMENT_MAX_CONTEXT_CHAR_LIMIT,
        )
}

fn attachment_effective_mime_type(attachment: &Attachment) -> String {
    if !attachment.file_type.is_empty() && attachment.file_type != "application/octet-stream" {
        return attachment.file_type.clone();
    }
    aqbot_core::document_parser::mime_from_extension(std::path::Path::new(&attachment.file_name))
        .to_string()
}

fn is_supported_document_attachment(attachment: &Attachment) -> bool {
    matches!(
        attachment_effective_mime_type(attachment).as_str(),
        "application/pdf"
            | "application/msword"
            | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
}

fn truncate_to_char_limit(text: &str, limit: usize) -> (String, bool) {
    let mut out = String::new();
    for (idx, ch) in text.chars().enumerate() {
        if idx >= limit {
            return (out, true);
        }
        out.push(ch);
    }
    (out, false)
}

fn read_document_attachment_text(
    file_store: &aqbot_core::file_store::FileStore,
    attachment: &Attachment,
) -> aqbot_core::error::Result<Option<String>> {
    let mime_type = attachment_effective_mime_type(attachment);
    if attachment.file_path.is_empty() {
        let Some(data) = attachment.data.as_ref() else {
            return Ok(None);
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| {
                aqbot_core::error::AQBotError::Validation(format!(
                    "Invalid attachment base64 for {}: {}",
                    attachment.file_name, e
                ))
            })?;
        let extension = std::path::Path::new(&attachment.file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("tmp");
        let temp_path = std::env::temp_dir().join(format!(
            "aqbot-doc-{}.{}",
            aqbot_core::utils::gen_id(),
            extension
        ));
        std::fs::write(&temp_path, bytes)?;
        let result = aqbot_core::document_parser::extract_text(&temp_path, &mime_type);
        let _ = std::fs::remove_file(&temp_path);
        return result.map(Some);
    }

    let path = file_store.validated_path(&attachment.file_path)?;
    if !path.exists() {
        return Ok(None);
    }
    aqbot_core::document_parser::extract_text(&path, &mime_type).map(Some)
}

pub(crate) fn append_document_attachment_context(
    file_store: &aqbot_core::file_store::FileStore,
    content: &str,
    attachments: &[Attachment],
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
) -> aqbot_core::error::Result<String> {
    if !document_attachment_reading_enabled {
        return Ok(content.to_string());
    }

    let document_attachments = attachments
        .iter()
        .filter(|attachment| is_supported_document_attachment(attachment))
        .collect::<Vec<_>>();
    if document_attachments.is_empty() {
        return Ok(content.to_string());
    }

    let mut remaining_chars = document_attachment_char_limit(model_context_window);
    let mut blocks = Vec::new();
    for attachment in document_attachments {
        if remaining_chars == 0 {
            break;
        }
        let Some(text) = read_document_attachment_text(file_store, attachment)? else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (excerpt, truncated) = truncate_to_char_limit(trimmed, remaining_chars);
        remaining_chars = remaining_chars.saturating_sub(excerpt.chars().count());
        let mut quoted = excerpt
            .lines()
            .map(|line| format!("> {}", line))
            .collect::<Vec<_>>()
            .join("\n");
        if truncated {
            quoted.push_str("\n> [Document text truncated for model context budget.]");
        }
        blocks.push(format!(
            "Document attachment \"{}\":\n{}",
            attachment.file_name, quoted
        ));
    }

    if blocks.is_empty() {
        return Ok(content.to_string());
    }

    let mut result = content.trim_end().to_string();
    if !result.is_empty() {
        result.push_str("\n\n");
    }
    result.push_str("[Parsed document attachments]\n\n");
    result.push_str(&blocks.join("\n\n"));
    Ok(result)
}

fn build_message_content(
    file_store: &aqbot_core::file_store::FileStore,
    message: &Message,
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    preserve_user_search_context: bool,
) -> aqbot_core::error::Result<ChatContent> {
    let content = match message.role {
        MessageRole::Assistant => strip_display_tags(&message.content),
        MessageRole::User if preserve_user_search_context => {
            strip_search_metadata_marker(&message.content)
        }
        MessageRole::User if !preserve_user_search_context => {
            strip_search_enrichment(&message.content)
        }
        _ => message.content.clone(),
    };
    let content = append_document_attachment_context(
        file_store,
        &content,
        &message.attachments,
        document_attachment_reading_enabled,
        model_context_window,
    )?;

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
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    preserve_user_search_context: bool,
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
        content: build_message_content(
            file_store,
            message,
            document_attachment_reading_enabled,
            model_context_window,
            preserve_user_search_context,
        )?,
        reasoning_content: if message.role == MessageRole::Assistant {
            extract_think_blocks(&message.content)
        } else {
            None
        },
        tool_calls,
        tool_call_id: message.tool_call_id.clone(),
    })
}

fn is_context_boundary_marker(message: &Message) -> bool {
    message.role == MessageRole::System
        && (message.content == "<!-- context-clear -->"
            || message.content == crate::context_manager::COMPRESSION_MARKER)
}

fn is_context_clear_marker(message: &Message) -> bool {
    message.role == MessageRole::System && message.content == "<!-- context-clear -->"
}

fn is_context_compression_marker(message: &Message) -> bool {
    message.role == MessageRole::System
        && message.content == crate::context_manager::COMPRESSION_MARKER
}

fn legacy_context_start_index(
    db_messages: &[Message],
    stop_after_message_id: Option<&str>,
) -> usize {
    let stop_index = stop_after_message_id.and_then(|message_id| {
        db_messages
            .iter()
            .position(|message| message.id == message_id)
    });
    let marker_search_end = stop_index.unwrap_or(db_messages.len());
    db_messages[..marker_search_end]
        .iter()
        .rposition(is_context_boundary_marker)
        .map(|idx| idx + 1)
        .unwrap_or(0)
}

fn resolve_context_boundary(
    db_messages: &[Message],
    existing_summary: Option<&ConversationSummary>,
) -> ContextBoundary {
    let Some(summary) = existing_summary else {
        return ContextBoundary {
            start_index: legacy_context_start_index(db_messages, None),
            use_summary: false,
        };
    };

    if let Some(boundary_id) = summary.compressed_until_message_id.as_deref() {
        if let Some(boundary_idx) = db_messages
            .iter()
            .position(|message| message.id == boundary_id)
        {
            if let Some(clear_idx) = db_messages
                .iter()
                .enumerate()
                .skip(boundary_idx + 1)
                .filter_map(|(idx, message)| is_context_clear_marker(message).then_some(idx))
                .last()
            {
                return ContextBoundary {
                    start_index: clear_idx + 1,
                    use_summary: false,
                };
            }

            return ContextBoundary {
                start_index: boundary_idx + 1,
                use_summary: true,
            };
        }
    }

    let marker_idx = db_messages.iter().rposition(is_context_boundary_marker);
    ContextBoundary {
        start_index: marker_idx.map(|idx| idx + 1).unwrap_or(0),
        use_summary: marker_idx
            .map(|idx| is_context_compression_marker(&db_messages[idx]))
            .unwrap_or(true),
    }
}

fn is_compressible_boundary_message(message: &Message) -> bool {
    message.is_active
        && message.status != "error"
        && !is_context_boundary_marker(message)
        && message.role != MessageRole::Tool
}

fn last_compressible_message_id_before(
    db_messages: &[Message],
    start_index: usize,
    before_message_id: &str,
) -> Option<String> {
    let end_index = db_messages
        .iter()
        .position(|message| message.id == before_message_id)
        .unwrap_or(db_messages.len());
    db_messages
        .iter()
        .skip(start_index)
        .take(end_index.saturating_sub(start_index))
        .filter(|message| is_compressible_boundary_message(message))
        .last()
        .map(|message| message.id.clone())
}

fn last_compressible_message_id_from_start(
    db_messages: &[Message],
    start_index: usize,
) -> Option<String> {
    db_messages
        .iter()
        .skip(start_index)
        .filter(|message| is_compressible_boundary_message(message))
        .last()
        .map(|message| message.id.clone())
}

fn count_compressible_messages_from_start(db_messages: &[Message], start_index: usize) -> u32 {
    db_messages
        .iter()
        .skip(start_index)
        .filter(|message| is_compressible_boundary_message(message))
        .count() as u32
}

fn is_valid_provider_tool_call(tool_call: &ToolCall) -> bool {
    !tool_call.id.trim().is_empty()
        && !tool_call.call_type.trim().is_empty()
        && !tool_call.function.name.trim().is_empty()
}

fn extract_mcp_display_tool_call_ids(content: &str) -> HashSet<String> {
    let mut ids = HashSet::new();
    let mut remaining = content;

    while let Some(start) = remaining.find(":::mcp ") {
        let metadata_start = start + ":::mcp ".len();
        let after_marker = &remaining[metadata_start..];
        let line_end = after_marker.find('\n').unwrap_or(after_marker.len());
        let metadata = after_marker[..line_end].trim();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(metadata) {
            if let Some(id) = value.get("id").and_then(|id| id.as_str()) {
                if !id.trim().is_empty() {
                    ids.insert(id.to_string());
                }
            }
        }
        remaining = &after_marker[line_end..];
    }

    ids
}

fn visible_history_chat_message(
    file_store: &aqbot_core::file_store::FileStore,
    message: &Message,
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    preserve_user_search_context: bool,
) -> aqbot_core::error::Result<ChatMessage> {
    let mut chat_message = chat_message_from_message(
        file_store,
        message,
        document_attachment_reading_enabled,
        model_context_window,
        preserve_user_search_context,
    )?;

    if message.role == MessageRole::Assistant {
        chat_message.reasoning_content = None;
        chat_message.tool_calls = None;
    }

    Ok(chat_message)
}

fn complete_tool_call_group_messages(
    file_store: &aqbot_core::file_store::FileStore,
    assistant_message: &Message,
    tool_messages_by_parent: &HashMap<&str, Vec<&Message>>,
    allowed_tool_call_ids: Option<&HashSet<String>>,
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
) -> aqbot_core::error::Result<Option<Vec<ChatMessage>>> {
    if assistant_message.role != MessageRole::Assistant
        || assistant_message.version_index != -1
        || assistant_message.is_active
    {
        return Ok(None);
    }

    let Some(tool_calls_json) = assistant_message.tool_calls_json.as_deref() else {
        return Ok(None);
    };
    let Ok(tool_calls) = serde_json::from_str::<Vec<ToolCall>>(tool_calls_json) else {
        return Ok(None);
    };
    if tool_calls.is_empty() || !tool_calls.iter().all(is_valid_provider_tool_call) {
        return Ok(None);
    }
    if let Some(allowed_tool_call_ids) = allowed_tool_call_ids {
        if allowed_tool_call_ids.is_empty()
            || !tool_calls
                .iter()
                .all(|tool_call| allowed_tool_call_ids.contains(&tool_call.id))
        {
            return Ok(None);
        }
    }

    let tool_messages = tool_messages_by_parent
        .get(assistant_message.id.as_str())
        .cloned()
        .unwrap_or_default();
    let tool_messages_by_call_id = tool_messages
        .iter()
        .filter_map(|message| message.tool_call_id.as_deref().map(|id| (id, *message)))
        .collect::<HashMap<_, _>>();

    let mut group = Vec::with_capacity(1 + tool_calls.len());
    let mut assistant_chat_message = chat_message_from_message(
        file_store,
        assistant_message,
        document_attachment_reading_enabled,
        model_context_window,
        false,
    )?;
    assistant_chat_message.tool_calls = Some(tool_calls.clone());
    group.push(assistant_chat_message);

    let mut seen_tool_call_ids = HashSet::new();
    for tool_call in tool_calls {
        let Some(tool_message) = tool_messages_by_call_id.get(tool_call.id.as_str()) else {
            return Ok(None);
        };
        if !seen_tool_call_ids.insert(tool_call.id.clone()) {
            return Ok(None);
        }
        let tool_chat_message = chat_message_from_message(
            file_store,
            tool_message,
            document_attachment_reading_enabled,
            model_context_window,
            false,
        )?;
        group.push(tool_chat_message);
    }

    Ok(Some(group))
}

fn build_provider_context_messages(
    file_store: &aqbot_core::file_store::FileStore,
    db_messages: &[Message],
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    current_user_message_id: Option<&str>,
    stop_after_message_id: Option<&str>,
) -> aqbot_core::error::Result<Vec<ChatMessage>> {
    let effective_start = legacy_context_start_index(db_messages, stop_after_message_id);
    build_provider_context_messages_from_index(
        file_store,
        db_messages,
        effective_start,
        document_attachment_reading_enabled,
        model_context_window,
        current_user_message_id,
        stop_after_message_id,
    )
}

fn build_provider_context_messages_from_index(
    file_store: &aqbot_core::file_store::FileStore,
    db_messages: &[Message],
    effective_start: usize,
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    current_user_message_id: Option<&str>,
    stop_after_message_id: Option<&str>,
) -> aqbot_core::error::Result<Vec<ChatMessage>> {
    let mut tool_assistants_by_parent: HashMap<&str, Vec<&Message>> = HashMap::new();
    let mut tool_messages_by_parent: HashMap<&str, Vec<&Message>> = HashMap::new();
    let mut active_tool_call_ids_by_parent: HashMap<&str, HashSet<String>> = HashMap::new();
    for message in &db_messages[effective_start..] {
        if message.is_active && message.role == MessageRole::Assistant {
            if let Some(parent_id) = message.parent_message_id.as_deref() {
                let ids = extract_mcp_display_tool_call_ids(&message.content);
                if !ids.is_empty() {
                    active_tool_call_ids_by_parent
                        .entry(parent_id)
                        .or_default()
                        .extend(ids);
                }
            }
        }
        if message.version_index != -1 || message.is_active {
            continue;
        }
        match message.role {
            MessageRole::Assistant => {
                if let Some(parent_id) = message.parent_message_id.as_deref() {
                    tool_assistants_by_parent
                        .entry(parent_id)
                        .or_default()
                        .push(message);
                }
            }
            MessageRole::Tool => {
                if let Some(parent_id) = message.parent_message_id.as_deref() {
                    tool_messages_by_parent
                        .entry(parent_id)
                        .or_default()
                        .push(message);
                }
            }
            _ => {}
        }
    }

    let mut out = Vec::new();
    for message in &db_messages[effective_start..] {
        if is_context_boundary_marker(message) || message.status == "error" {
            continue;
        }
        if !message.is_active || message.role == MessageRole::Tool {
            continue;
        }

        out.push(visible_history_chat_message(
            file_store,
            message,
            document_attachment_reading_enabled,
            model_context_window,
            current_user_message_id == Some(message.id.as_str()),
        )?);

        if stop_after_message_id == Some(message.id.as_str()) {
            break;
        }

        if message.role == MessageRole::User {
            if let Some(tool_assistants) = tool_assistants_by_parent.get(message.id.as_str()) {
                for assistant_message in tool_assistants {
                    if let Some(group) = complete_tool_call_group_messages(
                        file_store,
                        assistant_message,
                        &tool_messages_by_parent,
                        active_tool_call_ids_by_parent.get(message.id.as_str()),
                        document_attachment_reading_enabled,
                        model_context_window,
                    )? {
                        out.extend(group);
                    }
                }
            }
        }
    }

    Ok(out)
}

fn split_auto_compression_history(
    history_messages: &[ChatMessage],
    current_user_index: Option<usize>,
) -> (Vec<ChatMessage>, Vec<ChatMessage>) {
    let Some(current_index) = current_user_index else {
        return (history_messages.to_vec(), Vec::new());
    };
    if current_index >= history_messages.len() {
        return (history_messages.to_vec(), Vec::new());
    }

    let messages_to_compress = history_messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            if index == current_index {
                None
            } else {
                Some(message.clone())
            }
        })
        .collect();
    let post_compression_history = vec![history_messages[current_index].clone()];

    (messages_to_compress, post_compression_history)
}

#[tauri::command]
pub async fn list_conversations(state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    aqbot_core::repo::conversation::list_conversations(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_conversation_snapshot(
    state: State<'_, AppState>,
    id: String,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::get_conversation(&state.sea_db, &id)
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
    let real_provider_id = resolve_command_provider_id(&state.sea_db, &provider_id).await?;

    aqbot_core::repo::conversation::create_conversation(
        &state.sea_db,
        &title,
        &model_id,
        &real_provider_id,
        system_prompt.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation(
    state: State<'_, AppState>,
    id: String,
    mut input: UpdateConversationInput,
) -> Result<Conversation, String> {
    if let Some(provider_id) = input.provider_id.as_deref() {
        let real_provider_id = resolve_command_provider_id(&state.sea_db, provider_id).await?;
        input.provider_id = Some(real_provider_id);
    }

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
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let files =
        aqbot_core::repo::stored_file::list_stored_files_by_conversation(db, conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let candidate_ids = files
        .iter()
        .map(|file| file.id.clone())
        .collect::<HashSet<_>>();
    let txn = db.begin().await.map_err(|error| error.to_string())?;
    let deleted = aqbot_core::entity::conversations::Entity::delete_by_id(conversation_id)
        .exec(&txn)
        .await
        .map_err(|error| error.to_string())?;
    if deleted.rows_affected == 0 {
        return Err(format!("Conversation {conversation_id} not found"));
    }
    let storage_paths = aqbot_core::repo::stored_file::delete_unreferenced_candidates(
        &txn,
        &candidate_ids,
    )
    .await
    .map_err(|error| error.to_string())?;
    txn.commit().await.map_err(|error| error.to_string())?;

    for storage_path in storage_paths {
        file_store.delete_file(&storage_path).map_err(|error| {
            format!(
                "Conversation was deleted but backing file cleanup failed for {storage_path}: {error}"
            )
        })?;
    }
    Ok(())
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
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    cancel_flag: &AtomicBool,
    suppress_thinking: bool,
    stream_timeouts: StreamTimeoutConfig,
) -> (
    String, // full_content (includes <think> blocks)
    Option<TokenUsage>,
    Option<Vec<ToolCall>>,
    Option<ChatStreamErrorEvent>,
    Option<f64>, // tokens_per_second
    Option<i64>, // first_token_latency_ms
    Vec<aqbot_core::inline_media::CapturedInlineImage>,
) {
    use futures::StreamExt;
    let mut full_content = String::new();
    let mut final_usage: Option<TokenUsage> = None;
    let mut final_tool_calls: Option<Vec<ToolCall>> = None;
    let mut stream_error: Option<ChatStreamErrorEvent> = None;

    let stream_start = std::time::Instant::now();
    let mut first_token_time: Option<std::time::Instant> = None;

    // Track <think> block state for merging thinking into content
    let mut in_thinking_block = false;
    let mut thinking_block_start: Option<std::time::Instant> = None;
    let mut thinking_durations: Vec<u64> = Vec::new();
    let mut disabled_thinking_strip_state = DisabledThinkingStripState::default();
    let mut inline_data_capture = aqbot_core::inline_media::InlineDataStreamCapture::default();

    let mut received_stream_packet = false;
    loop {
        let current_timeout = if received_stream_packet {
            stream_timeouts.idle
        } else {
            stream_timeouts.first_packet
        };
        let next_result = match current_timeout {
            Some(timeout) => match tokio::time::timeout(timeout, stream.next()).await {
                Ok(result) => result,
                Err(_) => {
                    let error_event = build_stream_timeout_error_event(
                        conversation_id,
                        message_id,
                        stream_id,
                        model_id,
                        provider_id,
                        received_stream_packet,
                        timeout,
                    );
                    let err_msg = error_event.error.clone();
                    tracing::error!("[consume_stream] {}", err_msg);
                    stream_error = Some(error_event);
                    break;
                }
            },
            None => stream.next().await,
        };
        let Some(result) = next_result else {
            break;
        };
        received_stream_packet = true;

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

                let mut captured_delta = match inline_data_capture.push(&emit_content) {
                    Ok(delta) => delta,
                    Err(error) => {
                        stream_error = Some(build_stream_error_event(
                            conversation_id,
                            message_id,
                            stream_id,
                            model_id,
                            provider_id,
                            format!("Failed to stage generated image: {error}"),
                            "media_stream_capture_error",
                            None,
                        ));
                        break;
                    }
                };
                if is_done {
                    match inline_data_capture.finish() {
                        Ok(trailing) => {
                            captured_delta.content.push_str(&trailing.content);
                            captured_delta
                                .event_content
                                .push_str(&trailing.event_content);
                        }
                        Err(error) => {
                            stream_error = Some(build_stream_error_event(
                                conversation_id,
                                message_id,
                                stream_id,
                                model_id,
                                provider_id,
                                format!("Failed to finish generated image: {error}"),
                                "media_stream_capture_error",
                                None,
                            ));
                            break;
                        }
                    }
                }
                full_content.push_str(&captured_delta.content);
                let filtered_emit_content = captured_delta.event_content;

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
                    let error_event = build_stream_error_event(
                        conversation_id,
                        message_id,
                        stream_id,
                        model_id,
                        provider_id,
                        err_msg.clone(),
                        "empty_response",
                        None,
                    );
                    tracing::warn!("[consume_stream] Empty response from provider");
                    stream_error = Some(error_event);
                    break;
                }

                let mut emitted_chunk = ChatStreamChunk {
                    content: if filtered_emit_content.is_empty() {
                        None
                    } else {
                        Some(filtered_emit_content)
                    },
                    thinking: emit_thinking_signal,
                    done: is_done,
                    is_final: None,
                    usage: chunk.usage.clone(),
                    tool_calls: filter_tool_calls_for_event(chunk.tool_calls.as_deref()),
                };
                if emitted_chunk.done && emitted_chunk.is_final.is_none() {
                    emitted_chunk.is_final = Some(
                        emitted_chunk
                            .tool_calls
                            .as_ref()
                            .is_none_or(|tool_calls| tool_calls.is_empty()),
                    );
                }

                if let Some(pre_persist_chunk) = pre_persist_stream_chunk(&emitted_chunk) {
                    let _ = app.emit(
                        "chat-stream-chunk",
                        ChatStreamEvent {
                            conversation_id: conversation_id.to_string(),
                            message_id: message_id.to_string(),
                            stream_id: Some(stream_id.to_string()),
                            model_id: Some(model_id.to_string()),
                            provider_id: Some(provider_id.to_string()),
                            chunk: pre_persist_chunk,
                        },
                    );
                }

                if is_done {
                    break;
                }
            }
            Err(e) => {
                let err_msg = format!("{}", e);
                let error_event = build_stream_error_event(
                    conversation_id,
                    message_id,
                    stream_id,
                    model_id,
                    provider_id,
                    err_msg.clone(),
                    "provider_error",
                    None,
                );
                tracing::error!("Stream error: {}", e);
                stream_error = Some(error_event);
                break;
            }
        }
    }

    let capture_can_commit = stream_error.is_none()
        && !cancel_flag.load(std::sync::atomic::Ordering::Relaxed);
    let streamed_images = if capture_can_commit {
        match inline_data_capture.finish() {
            Ok(trailing) => {
                full_content.push_str(&trailing.content);
                if !trailing.event_content.is_empty() {
                    let _ = app.emit(
                        "chat-stream-chunk",
                        ChatStreamEvent {
                            conversation_id: conversation_id.to_string(),
                            message_id: message_id.to_string(),
                            stream_id: Some(stream_id.to_string()),
                            model_id: Some(model_id.to_string()),
                            provider_id: Some(provider_id.to_string()),
                            chunk: ChatStreamChunk {
                                content: Some(trailing.event_content),
                                thinking: None,
                                done: false,
                                is_final: None,
                                usage: None,
                                tool_calls: None,
                            },
                        },
                    );
                }
                inline_data_capture.take_images()
            }
            Err(error) => {
                stream_error = Some(build_stream_error_event(
                    conversation_id,
                    message_id,
                    stream_id,
                    model_id,
                    provider_id,
                    format!("Failed to finish generated image: {error}"),
                    "media_stream_capture_error",
                    None,
                ));
                full_content = aqbot_core::inline_media::replace_pending_inline_media_tokens(
                    &full_content,
                    "[图片接收失败]",
                );
                Vec::new()
            }
        }
    } else {
        full_content = aqbot_core::inline_media::replace_pending_inline_media_tokens(
            &full_content,
            "[图片接收失败]",
        );
        Vec::new()
    };

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
        streamed_images,
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

fn truncate_mcp_tool_result_content(content: &str, max_bytes: usize) -> String {
    if content.len() <= max_bytes {
        return content.to_string();
    }

    let end = content.floor_char_boundary(max_bytes);
    format!(
        "{}\n\n[MCP tool output truncated: showing first {} bytes of {} bytes]",
        &content[..end],
        end,
        content.len()
    )
}

async fn execute_tool_future<F>(
    future: F,
    timeout_secs: u64,
    timeout_duration: Duration,
    cancel_flag: &AtomicBool,
) -> (String, bool)
where
    F: Future<Output = aqbot_core::error::Result<aqbot_core::mcp_client::McpToolResult>>,
{
    if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
        return ("Error: Tool execution cancelled".to_string(), true);
    }

    tokio::select! {
        result = future => match result {
            Ok(result) => (
                truncate_mcp_tool_result_content(&result.content, MCP_TOOL_RESULT_MAX_BYTES),
                result.is_error,
            ),
            Err(e) => (format!("Error executing tool: {}", e), true),
        },
        _ = tokio::time::sleep(timeout_duration) => (
            format!("Error: Tool execution timed out after {}s", timeout_secs),
            true,
        ),
        _ = wait_for_cancel(cancel_flag) => (
            "Error: Tool execution cancelled".to_string(),
            true,
        ),
    }
}

async fn execute_tool_call(
    db: &sea_orm::DatabaseConnection,
    tool_call: &ToolCall,
    mcp_server_ids: &[String],
    cancel_flag: &AtomicBool,
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

    match server.transport.as_str() {
        "builtin" => {
            execute_tool_future(
                aqbot_core::builtin_tools::dispatch(
                    &server.name,
                    &tool_call.function.name,
                    arguments,
                ),
                timeout_secs,
                timeout_duration,
                cancel_flag,
            )
            .await
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
            execute_tool_future(
                aqbot_core::mcp_client::call_tool_stdio(
                    &command,
                    &args,
                    &env,
                    &tool_call.function.name,
                    arguments,
                ),
                timeout_secs,
                timeout_duration,
                cancel_flag,
            )
            .await
        }
        "http" => {
            let endpoint = match &server.endpoint {
                Some(ep) => ep.clone(),
                None => return ("Error: HTTP server has no endpoint configured".into(), true),
            };
            execute_tool_future(
                aqbot_core::mcp_client::call_tool_http(
                    &endpoint,
                    server.headers_json.as_deref(),
                    &tool_call.function.name,
                    arguments,
                ),
                timeout_secs,
                timeout_duration,
                cancel_flag,
            )
            .await
        }
        "sse" => {
            let endpoint = match &server.endpoint {
                Some(ep) => ep.clone(),
                None => return ("Error: SSE server has no endpoint configured".into(), true),
            };
            execute_tool_future(
                aqbot_core::mcp_client::call_tool_sse(
                    &endpoint,
                    server.headers_json.as_deref(),
                    &tool_call.function.name,
                    arguments,
                ),
                timeout_secs,
                timeout_duration,
                cancel_flag,
            )
            .await
        }
        other => return (format!("Error: Unsupported transport '{}'", other), true),
    }
}

const DEFAULT_TITLE_PROMPT: &str = "You are a title generator. Based on the conversation below, generate a concise and descriptive title (maximum 30 characters). Reply with the title only, no quotes or extra text.";
const AUTO_TITLE_CHAR_LIMIT: usize = 30;
const DEFAULT_TITLE_SUMMARY_MAX_TOKENS: u32 = 1024;
const RETRY_TITLE_SUMMARY_MAX_TOKENS: u32 = 4096;

fn title_summary_max_tokens(settings: &AppSettings) -> u32 {
    settings
        .title_summary_max_tokens
        .unwrap_or(DEFAULT_TITLE_SUMMARY_MAX_TOKENS)
}

fn clean_generated_title(content: &str) -> String {
    normalize_auto_conversation_title(content)
}

fn validated_generated_title(content: &str) -> Result<String, String> {
    let title = clean_generated_title(content);
    if aqbot_core::inline_media::contains_inline_image_data(&title) {
        return Err("AI-generated title contains inline image data".to_string());
    }
    Ok(title)
}

pub(crate) fn normalize_auto_conversation_title(content: &str) -> String {
    let cleaned = content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('“')
        .trim_matches('”')
        .trim_matches('「')
        .trim_matches('」')
        .trim_matches('《')
        .trim_matches('》')
        .trim()
        .to_string();
    truncate_auto_title(&cleaned)
}

fn truncate_auto_title(text: &str) -> String {
    let mut chars = text.chars();
    let truncated = chars
        .by_ref()
        .take(AUTO_TITLE_CHAR_LIMIT)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn should_auto_generate_title(is_first_message: bool, conversation_mode: &str) -> bool {
    is_first_message && conversation_mode != "role"
}

fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn chat_content_text(content: &ChatContent) -> String {
    match content {
        ChatContent::Text(text) => text.clone(),
        ChatContent::Multipart(parts) => parts
            .iter()
            .filter_map(|part| part.text.as_deref())
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn clean_generated_search_query(content: &str) -> String {
    let mut cleaned = content.trim().to_string();
    if cleaned.starts_with("```") {
        cleaned = cleaned
            .trim_start_matches("```text")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string();
    }

    let first_line = cleaned
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let mut query = first_line.trim().to_string();
    for prefix in [
        "搜索查询：",
        "搜索查询:",
        "查询：",
        "查询:",
        "Search query:",
        "Query:",
    ] {
        if query.to_lowercase().starts_with(&prefix.to_lowercase()) {
            query = query[prefix.len()..].trim().to_string();
            break;
        }
    }
    query
        .trim_matches(|c| matches!(c, '"' | '\'' | '“' | '”' | '「' | '」' | '`'))
        .trim()
        .to_string()
}

fn clean_generated_search_query_response(response: &ChatResponse) -> Result<String, String> {
    let query = clean_generated_search_query(&response.content);
    if query.is_empty() {
        let thinking_state = if response
            .thinking
            .as_deref()
            .is_some_and(|thinking| !thinking.trim().is_empty())
        {
            "thinking present"
        } else {
            "thinking absent"
        };
        return Err(format!(
            "empty content ({thinking_state}, content_chars={}, completion_tokens={}, total_tokens={})",
            response.content.chars().count(),
            response.usage.completion_tokens,
            response.usage.total_tokens,
        ));
    }
    if aqbot_core::inline_media::contains_inline_image_data(&query) {
        return Err("generated search query contains inline image data".to_string());
    }
    Ok(truncate_chars(&query, SEARCH_QUERY_CURRENT_CHAR_LIMIT))
}

fn build_search_query_generation_messages_for_attempt(
    history_messages: &[ChatMessage],
    current_content: &str,
    retry: bool,
) -> Vec<ChatMessage> {
    let history = history_messages
        .iter()
        .rev()
        .take(SEARCH_QUERY_HISTORY_LIMIT)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| {
            let role = if message.role == "assistant" {
                "Assistant"
            } else {
                "User"
            };
            let text = truncate_chars(
                &chat_content_text(&message.content).replace(char::is_whitespace, " "),
                SEARCH_QUERY_MESSAGE_CHAR_LIMIT,
            );
            format!("{role}: {text}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let current = truncate_chars(
        &current_content.replace(char::is_whitespace, " "),
        SEARCH_QUERY_CURRENT_CHAR_LIMIT,
    );
    let user_prompt = format!(
        "Conversation history:\n{}\n\nLatest user message:\n{}\n\n{}",
        if history.trim().is_empty() {
            "(none)"
        } else {
            history.as_str()
        },
        current,
        if retry {
            "You must return exactly one non-empty search query. If uncertain, copy the latest user message and resolve missing product names, people, versions, platforms, and subjects from the conversation history."
        } else {
            "Return only the search query."
        },
    );

    vec![
        ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(
                if retry {
                    "You generate web search queries. The previous attempt returned empty visible content. You must immediately return one concise non-empty plain search-engine query. Do not explain, do not use markdown, do not return labels, and do not leave the answer blank."
                } else {
                    "You generate web search queries. Rewrite the latest user message into one concise search-engine query using the conversation history. Resolve pronouns and follow-up requests from history. If the latest message only grants permission, says to continue, or says you may search/open pages, use the previous unresolved user search intent. Keep important product names, versions, platforms, error text, and proper nouns. Return only the query, with no explanation, quotes, markdown, or labels."
                }
                    .to_string(),
            ),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: ChatContent::Text(user_prompt),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        },
    ]
}

fn build_search_query_generation_messages(
    history_messages: &[ChatMessage],
    current_content: &str,
) -> Vec<ChatMessage> {
    build_search_query_generation_messages_for_attempt(history_messages, current_content, false)
}

fn build_retry_search_query_generation_messages(
    history_messages: &[ChatMessage],
    current_content: &str,
) -> Vec<ChatMessage> {
    build_search_query_generation_messages_for_attempt(history_messages, current_content, true)
}

fn apply_no_system_role(messages: &mut [ChatMessage], no_system_role: bool) {
    if !no_system_role {
        return;
    }
    for message in messages {
        if message.role == "system" {
            message.role = "user".to_string();
        }
    }
}

fn search_query_prompt_char_count(messages: &[ChatMessage]) -> usize {
    messages
        .iter()
        .map(|message| chat_content_text(&message.content).chars().count())
        .sum()
}

fn build_search_query_request(
    model_id: &str,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    use_max_completion_tokens: Option<bool>,
) -> ChatRequest {
    ChatRequest {
        model: model_id.to_string(),
        messages,
        stream: false,
        temperature: Some(0.0),
        top_p: None,
        max_tokens: Some(max_tokens),
        tools: None,
        thinking_budget: Some(0),
        thinking_level: Some("off".to_string()),
        reasoning_profile: None,
        use_max_completion_tokens,
        thinking_param_style: None,
        extra_body: None,
    }
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
        extra_body: None,
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
    let mut title = validated_generated_title(&response.content)?;
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
        title = validated_generated_title(&response.content)?;
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
pub async fn generate_search_query(
    state: State<'_, AppState>,
    conversation_id: String,
    content: String,
) -> Result<String, String> {
    let conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
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
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_model = aqbot_core::repo::provider::get_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .ok();
    let model_param_overrides = resolved_model.and_then(|model| model.param_overrides);
    let no_system_role = model_param_overrides
        .as_ref()
        .and_then(|params| params.no_system_role)
        .unwrap_or(false);
    let use_max_completion_tokens = model_param_overrides
        .as_ref()
        .and_then(|params| params.use_max_completion_tokens);

    let messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let marker_idx = messages.iter().rposition(|message| {
        message.role == MessageRole::System
            && (message.content == "<!-- context-clear -->"
                || message.content == crate::context_manager::COMPRESSION_MARKER)
    });
    let effective_messages = match marker_idx {
        Some(idx) => &messages[idx + 1..],
        None => &messages[..],
    };
    let file_store = aqbot_core::file_store::FileStore::new();
    let mut history_messages = Vec::new();
    for message in effective_messages {
        if !matches!(message.role, MessageRole::User | MessageRole::Assistant) {
            continue;
        }
        if message.status == "error" || message.status == "partial" {
            continue;
        }
        history_messages.push(
            chat_message_from_message(&file_store, message, false, None, false)
                .map_err(|e| e.to_string())?,
        );
    }

    let current_content = strip_search_enrichment(&content);
    let mut prompt_messages =
        build_search_query_generation_messages(&history_messages, &current_content);
    apply_no_system_role(&mut prompt_messages, no_system_role);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: ProviderProxyConfig::resolve(&provider.proxy_config, &settings),
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|headers| serde_json::from_str(headers).ok()),
    };
    let registry = ProviderRegistry::create_default();
    let registry_key = provider_type_to_registry_key(&provider.provider_type);
    let adapter = registry
        .get(registry_key)
        .ok_or_else(|| format!("Adapter not found for provider type: {}", registry_key))?;
    let prompt_chars = search_query_prompt_char_count(&prompt_messages);
    let request = build_search_query_request(
        &conversation.model_id,
        prompt_messages,
        SEARCH_QUERY_MAX_TOKENS,
        use_max_completion_tokens,
    );
    let response = adapter
        .chat(&ctx, request)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(
        "[search-query-gen] attempt=initial provider={} model={} prompt_chars={} content_chars={} thinking_present={} completion_tokens={} total_tokens={}",
        provider.id,
        conversation.model_id,
        prompt_chars,
        response.content.chars().count(),
        response.thinking.as_deref().is_some_and(|thinking| !thinking.trim().is_empty()),
        response.usage.completion_tokens,
        response.usage.total_tokens,
    );
    match clean_generated_search_query_response(&response) {
        Ok(query) => return Ok(query),
        Err(first_reason) => {
            tracing::warn!(
                "[search-query-gen] attempt=initial empty provider={} model={} reason={}",
                provider.id,
                conversation.model_id,
                first_reason
            );

            let mut retry_messages =
                build_retry_search_query_generation_messages(&history_messages, &current_content);
            apply_no_system_role(&mut retry_messages, no_system_role);
            let retry_prompt_chars = search_query_prompt_char_count(&retry_messages);
            let retry_request = build_search_query_request(
                &conversation.model_id,
                retry_messages,
                SEARCH_QUERY_RETRY_MAX_TOKENS,
                use_max_completion_tokens,
            );
            let retry_response = adapter
                .chat(&ctx, retry_request)
                .await
                .map_err(|e| e.to_string())?;
            tracing::info!(
                "[search-query-gen] attempt=retry provider={} model={} prompt_chars={} content_chars={} thinking_present={} completion_tokens={} total_tokens={}",
                provider.id,
                conversation.model_id,
                retry_prompt_chars,
                retry_response.content.chars().count(),
                retry_response.thinking.as_deref().is_some_and(|thinking| !thinking.trim().is_empty()),
                retry_response.usage.completion_tokens,
                retry_response.usage.total_tokens,
            );

            match clean_generated_search_query_response(&retry_response) {
                Ok(query) => Ok(query),
                Err(retry_reason) => Err(format!(
                    "AI returned empty search query after retry: initial {first_reason}; retry {retry_reason}"
                )),
            }
        }
    }
}

#[tauri::command]
pub async fn cancel_stream(
    state: State<'_, AppState>,
    conversation_id: String,
    stream_id: Option<String>,
) -> Result<(), String> {
    let flags = state.stream_cancel_flags.lock().await;
    let mut cancelled_count = 0usize;
    if let Some(entry) = stream_id.as_deref().and_then(|id| flags.get(id)) {
        entry.flag.store(true, std::sync::atomic::Ordering::Relaxed);
        cancelled_count += 1;
    } else {
        for entry in flags
            .values()
            .filter(|entry| entry.conversation_id == conversation_id)
        {
            entry.flag.store(true, std::sync::atomic::Ordering::Relaxed);
            cancelled_count += 1;
        }
    }

    if cancelled_count > 0 {
        tracing::info!(
            "[cancel_stream] Cancel requested for conversation {} ({} stream(s))",
            conversation_id,
            cancelled_count
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

fn sanitize_rag_context_result(mut result: RagContextResult) -> RagContextResult {
    let safe = aqbot_core::inline_media::filter_complete_inline_data;
    for part in &mut result.context_parts {
        *part = safe(part);
    }
    for source in &mut result.source_results {
        source.source_type = safe(&source.source_type);
        source.container_id = safe(&source.container_id);
        for item in &mut source.items {
            item.content = safe(&item.content);
            item.document_id = safe(&item.document_id);
            item.id = safe(&item.id);
            item.document_name = item.document_name.as_deref().map(safe);
        }
    }
    for error in &mut result.errors {
        error.source_type = safe(&error.source_type);
        error.container_id = safe(&error.container_id);
        error.message = safe(&error.message);
    }
    for empty in &mut result.empty_results {
        empty.source_type = safe(&empty.source_type);
        empty.container_id = safe(&empty.container_id);
        empty.reason = safe(&empty.reason);
    }
    result
}

fn rag_source_errors(kb_ids: &[String], mem_ids: &[String], message: &str) -> Vec<RagSourceError> {
    let mut errors = Vec::with_capacity(kb_ids.len() + mem_ids.len());
    let message = format_rag_failure_message(message);
    for id in kb_ids {
        errors.push(RagSourceError {
            source_type: "knowledge".to_string(),
            container_id: id.clone(),
            message: message.clone(),
        });
    }
    for id in mem_ids {
        errors.push(RagSourceError {
            source_type: "memory".to_string(),
            container_id: id.clone(),
            message: message.clone(),
        });
    }
    errors
}

fn failed_rag_context(kb_ids: &[String], mem_ids: &[String], message: &str) -> RagContextResult {
    RagContextResult {
        context_parts: Vec::new(),
        source_results: Vec::new(),
        errors: rag_source_errors(kb_ids, mem_ids, message),
        empty_results: Vec::new(),
    }
}

async fn wait_for_cancel(cancel_flag: &AtomicBool) {
    while !cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn collect_rag_context_with_timeout<F>(
    future: F,
    timeout: Duration,
    kb_ids: &[String],
    mem_ids: &[String],
) -> RagContextResult
where
    F: Future<Output = RagContextResult>,
{
    match tokio::time::timeout(timeout, future).await {
        Ok(result) => result,
        Err(_) => {
            tracing::warn!("RAG context collection timed out after {:?}", timeout);
            let reason = rag_timeout_failure_reason();
            failed_rag_context(kb_ids, mem_ids, &reason)
        }
    }
}

async fn collect_rag_context_with_timeout_or_cancel<F>(
    future: F,
    timeout: Duration,
    cancel_flag: &AtomicBool,
    kb_ids: &[String],
    mem_ids: &[String],
) -> (RagContextResult, bool)
where
    F: Future<Output = RagContextResult>,
{
    tokio::select! {
        result = collect_rag_context_with_timeout(future, timeout, kb_ids, mem_ids) => (result, false),
        _ = wait_for_cancel(cancel_flag) => (
            failed_rag_context(kb_ids, mem_ids, "已停止生成"),
            true,
        ),
    }
}

async fn collect_and_emit_rag_context(
    app: &tauri::AppHandle,
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &aqbot_core::vector_store::VectorStore,
    conversation_id: &str,
    assistant_message_id: &str,
    stream_id: &str,
    query: &str,
    kb_ids: Vec<String>,
    mem_ids: Vec<String>,
    cancel_flag: &AtomicBool,
) -> (RagContextResult, bool) {
    let future = crate::indexing::collect_rag_context(
        db,
        master_key,
        vector_store,
        &kb_ids,
        &mem_ids,
        query,
        5,
    );
    let (rag_result, cancelled) = collect_rag_context_with_timeout_or_cancel(
        future,
        RAG_CONTEXT_TIMEOUT,
        cancel_flag,
        &kb_ids,
        &mem_ids,
    )
    .await;
    let rag_result = sanitize_rag_context_result(rag_result);
    let safe = aqbot_core::inline_media::filter_complete_inline_data;

    let _ = app.emit(
        "rag-context-retrieved",
        RagContextRetrievedEvent {
            conversation_id: safe(conversation_id),
            message_id: Some(safe(assistant_message_id)),
            stream_id: Some(safe(stream_id)),
            sources: rag_result.source_results.clone(),
            errors: rag_result.errors.clone(),
            empty_results: rag_result.empty_results.clone(),
        },
    );

    (rag_result, cancelled)
}

/// Spawn the streaming background task shared by send_message and regenerate_message.
/// Returns the assistant message_id that will be populated as chunks arrive.
fn spawn_stream_task(
    app: tauri::AppHandle,
    db: sea_orm::DatabaseConnection,
    conversation_id: String,
    assistant_message_id: String,
    stream_id: String,
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
    stream_guard: RegisteredStreamGuard,
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
            use_max_completion_tokens,
            force_max_tokens,
        );
        let stream_timeouts = stream_timeout_config_from_settings(&settings);
        let registry = ProviderRegistry::create_default();
        let registry_key = provider_type_to_registry_key(&provider.provider_type);
        let adapter: &dyn aqbot_providers::ProviderAdapter = match registry.get(registry_key) {
            Some(a) => a,
            None => {
                let _ = app.emit(
                    "chat-stream-error",
                    build_stream_error_event(
                        &conversation_id,
                        &assistant_message_id,
                        &stream_id,
                        &model_id,
                        &provider.id,
                        format!("Unsupported provider type: {}", registry_key),
                        "provider_error",
                        None,
                    ),
                );
                stream_guard.release().await;
                return;
            }
        };

        let max_tool_iterations = mcp_tool_loop_max_iterations_from_settings(&settings);
        let mut chat_messages = chat_messages;
        let mut iteration = 0;
        let mut total_content = String::new();
        let mut total_usage: Option<TokenUsage> = None;
        let mut final_tool_calls_json: Option<String> = None;
        let mut had_stream_error = false;
        let mut last_stream_error: Option<ChatStreamErrorEvent> = None;
        let mut final_tokens_per_second: Option<f64> = None;
        let mut final_first_token_latency_ms: Option<i64> = None;
        let mut streamed_inline_images = Vec::new();

        // Early create: persist a placeholder message so it survives crash/refresh
        // Skip if the caller already created the placeholder before spawning.
        if !skip_placeholder_create {
            if let Err(e) = (aqbot_core::entity::messages::ActiveModel {
                id: Set(assistant_message_id.clone()),
                conversation_id: Set(conversation_id.clone()),
                role: Set("assistant".to_string()),
                content: Set(content_prefix.clone()),
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
            if iteration > max_tool_iterations {
                tracing::warn!(
                    "Tool call loop exceeded max iterations ({})",
                    max_tool_iterations
                );
                had_stream_error = true;
                let error_event = build_tool_loop_exceeded_error_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    &model_id,
                    &provider.id,
                    max_tool_iterations,
                );
                last_stream_error = Some(error_event);
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
                extra_body: model_extra_body_from_overrides(model_param_overrides.as_ref()),
            };

            let mut stream = adapter.chat_stream(&ctx, request);
            let suppress_thinking = thinking_budget == Some(0)
                || matches!(thinking_level.as_deref(), Some("off" | "none"));
            let (
                content,
                usage,
                tool_calls,
                stream_error,
                iter_tps,
                iter_ttft,
                mut iteration_inline_images,
            ) = consume_stream(
                &app,
                &mut stream,
                &conversation_id,
                &assistant_message_id,
                &stream_id,
                &model_id,
                &provider.id,
                &cancel_flag,
                suppress_thinking,
                stream_timeouts,
            )
            .await;

            total_content.push_str(&content);
            streamed_inline_images.append(&mut iteration_inline_images);
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
            if let Some(error_event) = stream_error {
                last_stream_error = Some(error_event);
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
            let safe_tool_calls =
                filter_tool_calls_for_event(Some(&tool_calls)).unwrap_or_default();
            let tc_json = serde_json::to_string(&safe_tool_calls).ok();
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
                if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }

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
                    "name": filter_complete_inline_data_event_text(&server_name),
                    "tool": filter_complete_inline_data_event_text(&tc.function.name),
                    "id": filter_complete_inline_data_event_text(&tc.id),
                    "arguments": filter_complete_inline_data_event_text(&tc.function.arguments),
                });
                let mcp_opener = format!("\n\n:::mcp {}\n", metadata);
                total_content.push_str(&mcp_opener);
                let _ = app.emit(
                    "chat-stream-chunk",
                    ChatStreamEvent {
                        conversation_id: conversation_id.clone(),
                        message_id: assistant_message_id.clone(),
                        stream_id: Some(stream_id.clone()),
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
                let (result_content, is_error) =
                    execute_tool_call(&db, tc, &mcp_server_ids, &cancel_flag).await;
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
                let safe_mcp_closer = format!(
                    "{}\n:::\n\n",
                    filter_complete_inline_data_event_text(&result_content)
                );
                total_content.push_str(&safe_mcp_closer);
                let _ = app.emit(
                    "chat-stream-chunk",
                    ChatStreamEvent {
                        conversation_id: conversation_id.clone(),
                        message_id: assistant_message_id.clone(),
                        stream_id: Some(stream_id.clone()),
                        model_id: Some(model_id.clone()),
                        provider_id: Some(provider.id.clone()),
                        chunk: ChatStreamChunk {
                            content: Some(safe_mcp_closer),
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
                    &filter_complete_inline_data_event_text(&tc.id),
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
            let err = last_stream_error
                .as_ref()
                .map(|event| event.error.as_str())
                .unwrap_or("Unknown error");
            let base_url = ctx.base_url.as_deref().unwrap_or("(not set)");
            let api_path_display = ctx.api_path.as_deref().unwrap_or("(default)");
            total_content = format!(
                "{}\n\nBase URL: {}\nAPI Path: {}\nModel: {}\nProvider: {} ({:?})",
                err, base_url, api_path_display, model_id, provider.name, provider.provider_type,
            );
        } else if had_stream_error {
            let err = last_stream_error
                .as_ref()
                .map(|event| event.error.as_str())
                .unwrap_or("Unknown error");
            total_content = append_stream_error_to_content(&total_content, err);
        }
        if had_stream_error || was_cancelled {
            final_tool_calls_json = None;
        }
        let token_count = total_usage.as_ref().map(|u| u.completion_tokens);
        let prompt_tokens = total_usage.as_ref().map(|u| u.prompt_tokens);
        let completion_tokens = total_usage.as_ref().map(|u| u.completion_tokens);
        // Prepend memory retrieval tag (if any) so it persists in DB
        let mut saved_content = if content_prefix.is_empty() {
            total_content.clone()
        } else {
            format!("{}{}", content_prefix, total_content)
        };
        if had_stream_error || was_cancelled {
            streamed_inline_images.clear();
            saved_content = aqbot_core::inline_media::replace_pending_inline_media_tokens(
                &saved_content,
                "[图片接收失败]",
            );
        }
        let file_store = aqbot_core::file_store::FileStore::new();
        let media_result = if streamed_inline_images.is_empty() {
            aqbot_core::inline_media::materialize_message_inline_images(
                &db,
                &file_store,
                &assistant_message_id,
                &saved_content,
            )
            .await
        } else {
            aqbot_core::inline_media::materialize_streamed_inline_images(
                &db,
                &file_store,
                &assistant_message_id,
                &saved_content,
                &streamed_inline_images,
            )
            .await
        };
        let media_error = media_result.err().map(|error| error.to_string());
        let persisted_status = if media_error.is_none() {
            final_status
        } else {
            "error"
        };
        if let Some(error) = media_error.as_deref() {
            tracing::error!(
                message_id = %assistant_message_id,
                error = %error,
                "Failed to materialize assistant inline media; original message content was preserved"
            );
        }
        if let Err(e) = aqbot_core::entity::messages::Entity::update(
            aqbot_core::entity::messages::ActiveModel {
                id: Set(assistant_message_id.clone()),
                token_count: Set(token_count.map(|v| v as i64)),
                prompt_tokens: Set(prompt_tokens.map(|v| v as i64)),
                completion_tokens: Set(completion_tokens.map(|v| v as i64)),
                thinking: Set(None), // thinking is now embedded in content as <think> tags
                tool_calls_json: Set(final_tool_calls_json),
                status: Set(persisted_status.to_string()),
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

        let terminal_error_event = if let Some(error) = media_error {
            Some(build_stream_error_event(
                &conversation_id,
                &assistant_message_id,
                &stream_id,
                &model_id,
                &provider.id,
                format!("Failed to store generated image: {error}"),
                "media_persistence_error",
                None,
            ))
        } else if had_stream_error {
            Some(last_stream_error.unwrap_or_else(|| {
                build_stream_error_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    &model_id,
                    &provider.id,
                    "Unknown stream error".to_string(),
                    "provider_error",
                    None,
                )
            }))
        } else {
            None
        };

        stream_guard.release().await;

        if let Some(error_event) = terminal_error_event {
            let _ = app.emit("chat-stream-error", error_event);
        } else if !was_cancelled {
            let _ = app.emit(
                "chat-stream-chunk",
                build_stream_done_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    &model_id,
                    &provider.id,
                    total_usage.clone(),
                ),
            );
        }

        // Auto-title: if this is the first user message, set conversation title
        if should_auto_generate_title(is_first_message, &conversation.mode) {
            // Set truncated title immediately for instant feedback
            let fallback_title = normalize_auto_conversation_title(&user_content);

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
    });
}

#[tauri::command]
pub async fn send_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    stream_id: String,
    content: String,
    content_prefix: Option<String>,
    attachments: Vec<AttachmentInput>,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
) -> Result<Message, String> {
    if has_active_stream_for_conversation(state.stream_cancel_flags.clone(), &conversation_id).await
    {
        return Err(ACTIVE_STREAM_EXISTS_ERROR.to_string());
    }
    if content_prefix
        .as_deref()
        .is_some_and(aqbot_core::inline_media::contains_inline_image_data)
    {
        return Err("Assistant content prefix contains inline image data".to_string());
    }
    let prepared_inline_media =
        aqbot_core::inline_media::prepare_message_inline_images(&content).map_err(|error| {
            format!("Message content rejected before persistence: {error}")
        })?;
    let cancel_flag = Arc::new(AtomicBool::new(false));

    let persisted_attachments = persist_attachments(&state, &conversation_id, &attachments)
        .await
        .map_err(|e| e.to_string())?;
    let safe_content = prepared_inline_media
        .as_ref()
        .map(|prepared| prepared.safe_content())
        .unwrap_or(&content);

    // 1. Save user message to DB
    let user_message = match aqbot_core::repo::message::create_message(
        &state.sea_db,
        &conversation_id,
        MessageRole::User,
        safe_content,
        &persisted_attachments,
        None,
        0,
    )
    .await
    {
        Ok(message) => message,
        Err(error) => {
            let cleanup_errors =
                cleanup_new_message_attachments(&state.sea_db, &persisted_attachments).await;
            return Err(format!(
                "Message creation failed: {error}; attachment rollback errors: {}",
                if cleanup_errors.is_empty() {
                    "none".to_string()
                } else {
                    cleanup_errors.join(", ")
                }
            ));
        }
    };
    let user_message = finalize_new_message_for_ipc(
        &state.sea_db,
        user_message,
        prepared_inline_media.as_ref(),
    )
    .await?;

    // Increment the persisted message count
    if let Err(error) =
        aqbot_core::repo::conversation::increment_message_count(&state.sea_db, &conversation_id)
            .await
    {
        let rollback_errors =
            rollback_new_message(&state.sea_db, &user_message.id, &user_message.attachments).await;
        return Err(format_new_message_failure(
            &user_message.id,
            "message-count update failed",
            error,
            rollback_errors,
        ));
    }

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
    let model_context_window = resolved_model.as_ref().and_then(|m| m.max_tokens);
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let document_attachment_reading_enabled = global_settings.document_attachment_reading_enabled;

    // 4. Build ChatRequest from conversation messages
    let db_messages =
        aqbot_core::repo::message::list_messages_for_model_context(&state.sea_db, &conversation_id)
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
            system_prompt_log_excerpt(sys)
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
    let stream_guard = RegisteredStreamGuard::register(
        state.stream_cancel_flags.clone(),
        &conversation_id,
        &stream_id,
        cancel_flag.clone(),
        false,
    )
    .await?;

    let user_query_content = strip_search_enrichment(&user_message.content);

    // RAG retrieval: search enabled knowledge bases and memory namespaces
    let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
    let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
    let (rag_result, rag_cancelled) = collect_and_emit_rag_context(
        &app,
        &state.sea_db,
        &state.master_key,
        state.vector_store.as_ref(),
        &conversation_id,
        &assistant_message_id,
        &stream_id,
        &user_query_content,
        kb_ids,
        mem_ids,
        &cancel_flag,
    )
    .await;

    // Build display tags for persistence before moving source_results. Search
    // display is generated before send_message; RAG display is generated here.
    let memory_tag = build_memory_retrieval_tag(&rag_result.source_results);
    let assistant_content_prefix = format!("{}{}", content_prefix.unwrap_or_default(), memory_tag);

    if rag_cancelled {
        stream_guard.release().await;
        return Ok(user_message);
    }

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

    // Load existing summary and resolve the real context boundary before
    // building provider-facing history. New summaries use
    // compressed_until_message_id; legacy summaries still fall back to marker
    // placement.
    let existing_summary =
        aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
            .await
            .ok()
            .flatten();
    let context_boundary = resolve_context_boundary(&db_messages, existing_summary.as_ref());
    let effective_existing_summary = existing_summary
        .as_ref()
        .filter(|_| context_boundary.use_summary);

    let history_messages = build_provider_context_messages_from_index(
        &file_store,
        &db_messages,
        context_boundary.start_index,
        document_attachment_reading_enabled,
        model_context_window,
        Some(&user_message.id),
        None,
    )
    .map_err(|e| e.to_string())?;
    let current_user_history_index = history_messages
        .iter()
        .rposition(|message| message.role == "user");

    // Resolve proxy config early (needed for both summary generation and main request)
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    // Auto-compression: if enabled and tokens exceed threshold, compress now
    if conversation.context_compression
        && !history_messages.is_empty()
        && crate::context_manager::should_auto_compress(
            &chat_messages,
            &history_messages,
            model_context_window,
        )
    {
        let (messages_to_compress, post_compression_history) =
            split_auto_compression_history(&history_messages, current_user_history_index);
        let compressed_until_message_id = last_compressible_message_id_before(
            &db_messages,
            context_boundary.start_index,
            &user_message.id,
        );
        // Perform synchronous compression before sending
        let compression_result = if messages_to_compress.is_empty() {
            None
        } else {
            do_compress(
                &state.sea_db,
                &conversation_id,
                &messages_to_compress,
                effective_existing_summary.map(|s| s.summary_text.as_str()),
                compressed_until_message_id.as_deref(),
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
            .ok()
        };

        if let Some(summary) = compression_result {
            // Insert compression marker
            let marker_message = aqbot_core::repo::message::create_message(
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
            if let Ok(marker_message) = marker_message {
                let _ = app.emit(
                    "conversation:compressed",
                    CompressionEvent {
                        conversation_id: conversation_id.clone(),
                        marker_message,
                        summary: summary.clone(),
                    },
                );
            }

            // After compression, history is now empty (marker splits it)
            // Context = system + summary + current user message only
            chat_messages = crate::context_manager::build_context(
                &chat_messages,
                &post_compression_history,
                Some(&summary.summary_text),
                model_context_window,
            );
        } else {
            // Compression failed — fall back to sliding window
            chat_messages = crate::context_manager::build_context(
                &chat_messages,
                &history_messages,
                effective_existing_summary.map(|s| s.summary_text.as_str()),
                model_context_window,
            );
        }
    } else {
        // No auto-compression: use existing summary (if any) + sliding window
        chat_messages = crate::context_manager::build_context(
            &chat_messages,
            &history_messages,
            effective_existing_summary.map(|s| s.summary_text.as_str()),
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
    spawn_stream_task(
        app,
        state.sea_db.clone(),
        conversation_id.clone(),
        assistant_message_id,
        stream_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        is_first_message,
        user_query_content,
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
        stream_guard,
        assistant_content_prefix,
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
    stream_id: String,
    user_message_id: Option<String>,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
) -> Result<(), String> {
    if has_active_stream_for_conversation(state.stream_cancel_flags.clone(), &conversation_id).await
    {
        return Err(ACTIVE_STREAM_EXISTS_ERROR.to_string());
    }

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
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_regen_model = aqbot_core::repo::provider::get_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .ok();
    let model_context_window = resolved_regen_model.as_ref().and_then(|m| m.max_tokens);
    let document_attachment_reading_enabled = global_settings.document_attachment_reading_enabled;

    // 6. Rebuild chat messages (active messages only — old inactive versions excluded)
    let remaining_messages =
        aqbot_core::repo::message::list_messages_for_model_context(&state.sea_db, &conversation_id)
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
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let stream_guard = RegisteredStreamGuard::register(
        state.stream_cancel_flags.clone(),
        &conversation_id,
        &stream_id,
        cancel_flag.clone(),
        false,
    )
    .await?;

    let target_user_content = strip_search_enrichment(&last_user_msg.content);

    // RAG retrieval for regeneration
    let memory_tag = {
        let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
        let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
        let (rag_result, rag_cancelled) = collect_and_emit_rag_context(
            &app,
            &state.sea_db,
            &state.master_key,
            state.vector_store.as_ref(),
            &conversation_id,
            &assistant_message_id,
            &stream_id,
            &target_user_content,
            kb_ids,
            mem_ids,
            &cancel_flag,
        )
        .await;

        let tag = build_memory_retrieval_tag(&rag_result.source_results);

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
        if rag_cancelled {
            stream_guard.release().await;
            return Ok(());
        }
        tag
    };

    let existing_summary =
        aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
            .await
            .ok()
            .flatten();
    let context_boundary = resolve_context_boundary(&remaining_messages, existing_summary.as_ref());
    let effective_existing_summary = existing_summary
        .as_ref()
        .filter(|_| context_boundary.use_summary);
    let history_messages = build_provider_context_messages_from_index(
        &file_store,
        &remaining_messages,
        context_boundary.start_index,
        document_attachment_reading_enabled,
        model_context_window,
        Some(&last_user_msg.id),
        Some(&last_user_msg.id),
    )
    .map_err(|e| e.to_string())?;
    chat_messages = crate::context_manager::build_context(
        &chat_messages,
        &history_messages,
        effective_existing_summary.map(|s| s.summary_text.as_str()),
        model_context_window,
    );

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

    let regen_model_overrides = resolved_regen_model.and_then(|m| m.param_overrides);
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

    spawn_stream_task(
        app,
        state.sea_db.clone(),
        conversation_id,
        assistant_message_id,
        stream_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        false,
        target_user_content,
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
        stream_guard,
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
    stream_id: String,
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
    let companion = is_companion.unwrap_or(false);
    if !companion
        && has_active_stream_for_conversation(state.stream_cancel_flags.clone(), &conversation_id)
            .await
    {
        return Err(ACTIVE_STREAM_EXISTS_ERROR.to_string());
    }

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
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_target_model = aqbot_core::repo::provider::get_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .ok();
    let model_context_window = resolved_target_model.as_ref().and_then(|m| m.max_tokens);
    let document_attachment_reading_enabled = global_settings.document_attachment_reading_enabled;

    // Build context messages (same logic as regenerate_message)
    let remaining_messages =
        aqbot_core::repo::message::list_messages_for_model_context(&state.sea_db, &conversation_id)
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
            system_prompt_log_excerpt(sys)
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
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let stream_guard = RegisteredStreamGuard::register(
        state.stream_cancel_flags.clone(),
        &conversation_id,
        &stream_id,
        cancel_flag.clone(),
        companion,
    )
    .await?;

    let target_user_content = strip_search_enrichment(&user_msg.content);

    // RAG retrieval
    let memory_tag = {
        let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
        let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
        let (rag_result, rag_cancelled) = collect_and_emit_rag_context(
            &app,
            &state.sea_db,
            &state.master_key,
            state.vector_store.as_ref(),
            &conversation_id,
            &assistant_message_id,
            &stream_id,
            &target_user_content,
            kb_ids,
            mem_ids,
            &cancel_flag,
        )
        .await;

        let tag = build_memory_retrieval_tag(&rag_result.source_results);

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
        if rag_cancelled {
            stream_guard.release().await;
            return Ok(());
        }
        tag
    };

    let existing_summary =
        aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
            .await
            .ok()
            .flatten();
    let context_boundary = resolve_context_boundary(&remaining_messages, existing_summary.as_ref());
    let effective_existing_summary = existing_summary
        .as_ref()
        .filter(|_| context_boundary.use_summary);
    let history_messages = build_provider_context_messages_from_index(
        &file_store,
        &remaining_messages,
        context_boundary.start_index,
        document_attachment_reading_enabled,
        model_context_window,
        Some(&user_msg.id),
        Some(&user_msg.id),
    )
    .map_err(|e| e.to_string())?;
    chat_messages = crate::context_manager::build_context(
        &chat_messages,
        &history_messages,
        effective_existing_summary.map(|s| s.summary_text.as_str()),
        model_context_window,
    );

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

    let rwm_overrides = resolved_target_model.and_then(|m| m.param_overrides);
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
        stream_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        false,
        target_user_content,
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
        stream_guard,
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
    let messages = aqbot_core::repo::message::list_message_versions(
        &state.sea_db,
        &conversation_id,
        &parent_message_id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let messages = crate::commands::messages::materialize_messages_for_ipc(
        &state.sea_db,
        messages,
    )
    .await?;
    Ok(messages)
}

#[tauri::command]
pub async fn list_message_versions_batch(
    state: State<'_, AppState>,
    conversation_id: String,
    parent_message_ids: Vec<String>,
) -> Result<HashMap<String, Vec<Message>>, String> {
    let mut versions = aqbot_core::repo::message::list_message_versions_batch(
        &state.sea_db,
        &conversation_id,
        &parent_message_ids,
    )
    .await
    .map_err(|e| e.to_string())?;
    for messages in versions.values_mut() {
        *messages = crate::commands::messages::materialize_messages_for_ipc(
            &state.sea_db,
            std::mem::take(messages),
        )
        .await?;
    }
    Ok(versions)
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
    let file_store = aqbot_core::file_store::FileStore::new();
    let deleted = crate::commands::messages::delete_message_group_with_media_cleanup(
        &state.sea_db,
        &file_store,
        &user_message_id,
    )
    .await?;
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
    compressed_until_message_id: Option<&str>,
    provider: &ProviderConfig,
    decrypted_key: &str,
    key_id: &str,
    proxy_config: &Option<ProviderProxyConfig>,
    model_id: &str,
    use_max_completion_tokens: Option<bool>,
    settings: &AppSettings,
    master_key: &[u8; 32],
) -> Result<ConversationSummary, String> {
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
        extra_body: None,
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
    if aqbot_core::inline_media::contains_inline_image_data(&response.content) {
        return Err("Summary generation returned inline image data".to_string());
    }

    let token_count = aqbot_core::token_counter::estimate_tokens(&response.content);
    let summary = aqbot_core::repo::conversation::upsert_summary(
        db,
        conversation_id,
        &response.content,
        compressed_until_message_id,
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
    Ok(summary)
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
    let db_messages =
        aqbot_core::repo::message::list_messages_for_model_context(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

    let file_store = aqbot_core::file_store::FileStore::new();

    // For manual compression: try messages after the effective summary/marker
    // boundary first, then fall back to all visible messages if nothing remains.
    let existing_summary =
        aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
            .await
            .ok()
            .flatten();
    let context_boundary = resolve_context_boundary(&db_messages, existing_summary.as_ref());
    let mut boundary_start_index = context_boundary.start_index;
    let mut history_messages = build_provider_context_messages_from_index(
        &file_store,
        &db_messages,
        boundary_start_index,
        global_settings.document_attachment_reading_enabled,
        None,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;

    // If nothing after the last boundary, try all messages.
    if history_messages.is_empty() && boundary_start_index > 0 {
        let all_without_markers = db_messages
            .iter()
            .filter(|message| !is_context_boundary_marker(message))
            .cloned()
            .collect::<Vec<_>>();
        boundary_start_index = 0;
        history_messages = build_provider_context_messages(
            &file_store,
            &all_without_markers,
            global_settings.document_attachment_reading_enabled,
            None,
            None,
            None,
        )
        .map_err(|e| e.to_string())?;
    }

    if history_messages.is_empty() {
        return Err("No messages to compress".to_string());
    }
    let compressed_until_message_id =
        last_compressible_message_id_from_start(&db_messages, boundary_start_index);
    let effective_existing_summary = existing_summary
        .as_ref()
        .filter(|_| context_boundary.use_summary);

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

    let summary = do_compress(
        &state.sea_db,
        &conversation_id,
        &history_messages,
        effective_existing_summary.map(|s| s.summary_text.as_str()),
        compressed_until_message_id.as_deref(),
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
        "conversation:compressed",
        CompressionEvent {
            conversation_id: conversation_id.clone(),
            marker_message: marker_msg,
            summary: summary.clone(),
        },
    );

    Ok(summary)
}

/// Tauri command: get the compression summary for a conversation.
#[tauri::command]
pub async fn get_compression_summary(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<ConversationSummary>, String> {
    let summary = aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(summary) = &summary {
        ensure_conversation_summary_safe_for_ipc(summary)?;
    }
    Ok(summary)
}

fn ensure_conversation_summary_safe_for_ipc(summary: &ConversationSummary) -> Result<(), String> {
    let has_inline = aqbot_core::inline_media::contains_inline_image_data;
    let unsafe_field = [
        ("id", Some(summary.id.as_str())),
        ("conversation_id", Some(summary.conversation_id.as_str())),
        ("summary_text", Some(summary.summary_text.as_str())),
        (
            "compressed_until_message_id",
            summary.compressed_until_message_id.as_deref(),
        ),
        ("model_used", summary.model_used.as_deref()),
    ]
    .into_iter()
    .find_map(|(field, value)| value.is_some_and(has_inline).then_some(field));
    if let Some(field) = unsafe_field {
        let safe_id = if has_inline(&summary.id) {
            "<unsafe-id>"
        } else {
            &summary.id
        };
        return Err(format!(
            "Conversation summary {safe_id} cannot be returned over IPC: unresolved inline media remains in {field}"
        ));
    }
    Ok(())
}

/// Tauri command: return server-side context usage for a conversation.
#[tauri::command]
pub async fn get_context_usage(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ContextUsage, String> {
    let conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let resolved_model = aqbot_core::repo::provider::get_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .ok();
    let model_context_window = resolved_model.as_ref().and_then(|m| m.max_tokens);
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let db_messages =
        aqbot_core::repo::message::list_messages_for_model_context(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let existing_summary =
        aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
            .await
            .ok()
            .flatten();
    let context_boundary = resolve_context_boundary(&db_messages, existing_summary.as_ref());
    let effective_existing_summary = existing_summary
        .as_ref()
        .filter(|_| context_boundary.use_summary);

    let file_store = aqbot_core::file_store::FileStore::new();
    let history_messages = build_provider_context_messages_from_index(
        &file_store,
        &db_messages,
        context_boundary.start_index,
        global_settings.document_attachment_reading_enabled,
        model_context_window,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;

    let mut system_messages = Vec::new();
    if let Some(system_prompt) = resolve_system_prompt(&state.sea_db, &conversation).await {
        system_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(system_prompt),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }
    let context_messages = crate::context_manager::build_context(
        &system_messages,
        &history_messages,
        effective_existing_summary.map(|s| s.summary_text.as_str()),
        model_context_window,
    );
    let used_tokens = context_messages
        .iter()
        .map(crate::context_manager::message_tokens)
        .sum::<usize>() as u32;
    let threshold_tokens = model_context_window.map(|window| (window as f64 * 0.70) as u32);

    Ok(ContextUsage {
        used_tokens,
        max_tokens: model_context_window,
        threshold_tokens,
        has_summary: effective_existing_summary.is_some(),
        compressed_until_message_id: effective_existing_summary
            .and_then(|summary| summary.compressed_until_message_id.clone()),
        messages_after_boundary: count_compressible_messages_from_start(
            &db_messages,
            context_boundary.start_index,
        ),
    })
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
    let prepared_inline_media =
        aqbot_core::inline_media::prepare_message_inline_images(&content).map_err(|error| {
            format!("System message content rejected before persistence: {error}")
        })?;
    let safe_content = prepared_inline_media
        .as_ref()
        .map(|prepared| prepared.safe_content())
        .unwrap_or(&content);
    let msg = aqbot_core::repo::message::create_message(
        &state.sea_db,
        &conversation_id,
        MessageRole::System,
        safe_content,
        &[],
        None,
        0,
    )
    .await
    .map_err(|e| e.to_string())?;

    finalize_new_message_for_ipc(&state.sea_db, msg, prepared_inline_media.as_ref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::future::pending;
    use std::io::{Cursor, Write};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Mutex;

    fn test_app_state(db: DatabaseConnection) -> crate::AppState {
        let vector_store = Arc::new(aqbot_core::vector_store::VectorStore::new(db.clone()));
        crate::AppState {
            sea_db: db,
            master_key: [0; 32],
            gateway: Arc::new(Mutex::new(None)),
            close_to_tray: Arc::new(AtomicBool::new(false)),
            release_webview_on_tray: Arc::new(AtomicBool::new(false)),
            main_window_released_to_tray: Arc::new(AtomicBool::new(false)),
            main_window_restoring: Arc::new(AtomicBool::new(false)),
            is_quitting: Arc::new(AtomicBool::new(false)),
            app_data_dir: std::env::temp_dir(),
            db_path: "sqlite::memory:".to_string(),
            auto_backup_handle: Arc::new(Mutex::new(None)),
            webdav_sync_handle: Arc::new(Mutex::new(None)),
            s3_sync_handle: Arc::new(Mutex::new(None)),
            vector_store,
            knowledge_index_scheduler: Arc::new(
                crate::knowledge_index_scheduler::KnowledgeIndexScheduler::default(),
            ),
            stream_cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            agent_cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
            agent_permission_senders: Arc::new(Mutex::new(HashMap::new())),
            agent_ask_senders: Arc::new(Mutex::new(HashMap::new())),
            agent_always_allowed: Arc::new(Mutex::new(HashMap::new())),
        }
    }

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
            extra_body: None,
        }
    }

    #[test]
    fn model_extra_body_is_cloned_from_model_param_overrides() {
        let extra_body = serde_json::json!({
            "enable_thinking": true,
            "thinking": {
                "type": "enabled"
            }
        })
        .as_object()
        .expect("object")
        .clone();
        let mut overrides = test_param_overrides(None, None, None);
        overrides.extra_body = Some(extra_body.clone());

        assert_eq!(
            model_extra_body_from_overrides(Some(&overrides)),
            Some(extra_body)
        );
        assert_eq!(model_extra_body_from_overrides(None), None);
    }

    fn test_docx_bytes(text: &str) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("word/document.xml", options).unwrap();
        write!(
            archive,
            r#"<w:document><w:body><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:body></w:document>"#,
            text
        )
        .unwrap();
        archive.finish().unwrap().into_inner()
    }

    fn test_message(
        id: &str,
        role: MessageRole,
        content: &str,
        parent_message_id: Option<&str>,
        version_index: i32,
        is_active: bool,
        tool_calls_json: Option<&str>,
        tool_call_id: Option<&str>,
    ) -> Message {
        Message {
            id: id.to_string(),
            conversation_id: "conv-1".into(),
            role,
            content: content.to_string(),
            provider_id: None,
            model_id: None,
            token_count: None,
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            first_token_latency_ms: None,
            attachments: Vec::new(),
            thinking: None,
            tool_calls_json: tool_calls_json.map(str::to_string),
            tool_call_id: tool_call_id.map(str::to_string),
            created_at: 0,
            parent_message_id: parent_message_id.map(str::to_string),
            version_index,
            is_active,
            status: "complete".into(),
        }
    }

    fn test_summary(boundary_message_id: Option<&str>) -> ConversationSummary {
        ConversationSummary {
            id: "summary-1".to_string(),
            conversation_id: "conv-1".to_string(),
            summary_text: "compressed old context".to_string(),
            compressed_until_message_id: boundary_message_id.map(str::to_string),
            token_count: Some(12),
            model_used: Some("summary-model".to_string()),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[tokio::test]
    async fn rag_context_timeout_returns_failure_errors() {
        let result = collect_rag_context_with_timeout(
            pending(),
            Duration::from_millis(1),
            &["kb-1".to_string()],
            &["mem-1".to_string()],
        )
        .await;

        assert!(result.context_parts.is_empty());
        assert!(result.source_results.is_empty());
        assert_eq!(result.errors.len(), 2);
        assert_eq!(result.errors[0].source_type, "knowledge");
        assert_eq!(result.errors[0].container_id, "kb-1");
        assert_eq!(result.errors[0].message, "检索失败：检索超时，已超过 60 秒");
        assert_eq!(result.errors[1].source_type, "memory");
        assert_eq!(result.errors[1].container_id, "mem-1");
        assert_eq!(result.errors[1].message, "检索失败：检索超时，已超过 60 秒");
    }

    #[test]
    fn rag_event_and_persisted_display_tag_never_contain_inline_image_data() {
        let raw = "data:image/png;base64,RAG_SECRET";
        let result = sanitize_rag_context_result(RagContextResult {
            context_parts: vec![raw.to_string()],
            source_results: vec![RagSourceResult {
                source_type: raw.to_string(),
                container_id: raw.to_string(),
                items: vec![RagRetrievedItem {
                    content: raw.to_string(),
                    score: 1.0,
                    rerank_score: None,
                    document_id: raw.to_string(),
                    id: raw.to_string(),
                    document_name: Some(raw.to_string()),
                }],
            }],
            errors: vec![RagSourceError {
                source_type: raw.to_string(),
                container_id: raw.to_string(),
                message: raw.to_string(),
            }],
            empty_results: vec![RagSourceEmptyResult {
                source_type: raw.to_string(),
                container_id: raw.to_string(),
                reason: raw.to_string(),
            }],
        });
        let event = RagContextRetrievedEvent {
            conversation_id: "conversation".to_string(),
            message_id: Some("message".to_string()),
            stream_id: Some("stream".to_string()),
            sources: result.source_results.clone(),
            errors: result.errors.clone(),
            empty_results: result.empty_results.clone(),
        };
        let serialized = serde_json::to_string(&event).unwrap();
        let tag = build_memory_retrieval_tag(&result.source_results);

        assert!(!serialized.to_ascii_lowercase().contains("data:image/"));
        assert!(!tag.to_ascii_lowercase().contains("data:image/"));
        assert!(!serialized.contains("RAG_SECRET"));
        assert!(!tag.contains("RAG_SECRET"));
    }

    #[test]
    fn compression_summary_ipc_gate_checks_every_string_field() {
        let mut summary = test_summary(None);
        summary.summary_text = "data:image/png;base64,SUMMARY_SECRET".to_string();

        let error = ensure_conversation_summary_safe_for_ipc(&summary).unwrap_err();

        assert!(error.contains(&summary.id));
        assert!(!error.contains("SUMMARY_SECRET"));
    }

    #[tokio::test]
    async fn command_provider_resolution_materializes_builtin_provider() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;

        let real_id = resolve_command_provider_id(&db, "builtin_deepseek")
            .await
            .unwrap();

        assert_ne!(real_id, "builtin_deepseek");
        let provider = aqbot_core::repo::provider::get_provider(&db, &real_id)
            .await
            .unwrap();
        assert_eq!(provider.builtin_id.as_deref(), Some("deepseek"));
        assert_eq!(provider.provider_type, ProviderType::DeepSeek);
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
    fn stream_timeout_config_uses_global_settings_and_zero_disables() {
        let mut settings = AppSettings::default();
        settings.chat_stream_first_packet_timeout_secs = 45;
        settings.chat_stream_idle_timeout_secs = 12;

        let config = stream_timeout_config_from_settings(&settings);
        assert_eq!(config.first_packet, Some(Duration::from_secs(45)));
        assert_eq!(config.idle, Some(Duration::from_secs(12)));

        settings.chat_stream_first_packet_timeout_secs = 0;
        settings.chat_stream_idle_timeout_secs = 0;

        let config = stream_timeout_config_from_settings(&settings);
        assert_eq!(config.first_packet, None);
        assert_eq!(config.idle, None);
    }

    #[test]
    fn mcp_tool_loop_limit_clamps_global_settings() {
        let mut settings = AppSettings::default();
        assert_eq!(mcp_tool_loop_max_iterations_from_settings(&settings), 100);

        settings.mcp_tool_loop_max_iterations = 0;
        assert_eq!(mcp_tool_loop_max_iterations_from_settings(&settings), 1);

        settings.mcp_tool_loop_max_iterations = 25;
        assert_eq!(mcp_tool_loop_max_iterations_from_settings(&settings), 25);

        settings.mcp_tool_loop_max_iterations = 1_000;
        assert_eq!(mcp_tool_loop_max_iterations_from_settings(&settings), 100);
    }

    #[test]
    fn mcp_tool_loop_error_event_includes_configured_limit() {
        let event = build_tool_loop_exceeded_error_event(
            "conv-1",
            "msg-1",
            "stream-1",
            "model-1",
            "provider-1",
            25,
        );

        assert_eq!(event.error, "MCP tool loop exceeded 25 iterations");
        assert_eq!(event.kind.as_deref(), Some("tool_loop_exceeded"));
    }

    #[test]
    fn stream_timeout_error_event_identifies_first_packet_timeout() {
        let event = build_stream_timeout_error_event(
            "conv-1",
            "msg-1",
            "stream-1",
            "model-1",
            "provider-1",
            false,
            Duration::from_secs(45),
        );

        assert_eq!(event.error, "模型首包超时，已超过 45 秒未收到响应");
        assert_eq!(event.kind.as_deref(), Some("first_packet_timeout"));
        assert_eq!(event.timeout_secs, Some(45));
    }

    #[test]
    fn stream_timeout_error_event_identifies_idle_timeout() {
        let event = build_stream_timeout_error_event(
            "conv-1",
            "msg-1",
            "stream-1",
            "model-1",
            "provider-1",
            true,
            Duration::from_secs(12),
        );

        assert_eq!(event.error, "模型响应空闲超时，已超过 12 秒未收到新内容");
        assert_eq!(event.kind.as_deref(), Some("idle_timeout"));
        assert_eq!(event.timeout_secs, Some(12));
    }

    #[tokio::test]
    async fn register_stream_cancel_flag_rejects_overlapping_plain_stream_without_overwriting() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let first_flag = Arc::new(AtomicBool::new(false));
        let second_flag = Arc::new(AtomicBool::new(false));

        register_stream_cancel_flag(
            flags.clone(),
            "conv-1",
            "stream-a",
            first_flag.clone(),
            false,
        )
        .await
        .unwrap();

        let err =
            register_stream_cancel_flag(flags.clone(), "conv-1", "stream-b", second_flag, false)
                .await
                .unwrap_err();

        assert!(err.contains("已有回复正在生成"));
        let guard = flags.lock().await;
        assert!(guard.contains_key("stream-a"));
        assert!(!guard.contains_key("stream-b"));
        assert_eq!(guard.get("stream-a").unwrap().conversation_id, "conv-1");
    }

    #[tokio::test]
    async fn register_stream_cancel_flag_allows_parallel_companion_streams() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));

        register_stream_cancel_flag(
            flags.clone(),
            "conv-1",
            "stream-a",
            Arc::new(AtomicBool::new(false)),
            false,
        )
        .await
        .unwrap();

        register_stream_cancel_flag(
            flags.clone(),
            "conv-1",
            "stream-b",
            Arc::new(AtomicBool::new(false)),
            true,
        )
        .await
        .unwrap();

        let guard = flags.lock().await;
        assert!(guard.contains_key("stream-a"));
        assert!(guard.contains_key("stream-b"));
    }

    #[tokio::test]
    async fn registered_stream_guard_releases_active_stream_when_dropped_before_spawn() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let cancel_flag = Arc::new(AtomicBool::new(false));

        let guard = RegisteredStreamGuard::register(
            flags.clone(),
            "conv-1",
            "stream-a",
            cancel_flag.clone(),
            false,
        )
        .await
        .unwrap();

        assert!(has_active_stream_for_conversation(flags.clone(), "conv-1").await);

        drop(guard);
        tokio::time::sleep(Duration::from_millis(10)).await;

        assert!(cancel_flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!has_active_stream_for_conversation(flags, "conv-1").await);
    }

    #[test]
    fn terminal_provider_done_chunk_is_emitted_as_delta_until_persisted() {
        let provider_chunk = ChatStreamChunk {
            content: Some("final text".to_string()),
            thinking: None,
            done: true,
            is_final: None,
            usage: None,
            tool_calls: None,
        };

        let emitted = pre_persist_stream_chunk(&provider_chunk).expect("chunk emitted");

        assert_eq!(emitted.content.as_deref(), Some("final text"));
        assert!(!emitted.done);
        assert_eq!(emitted.is_final, None);
    }

    #[test]
    fn terminal_stream_chunk_flushes_retained_text_before_done() {
        let mut filter = aqbot_core::inline_media::InlineDataStreamFilter::default();

        let first = filter_inline_data_stream_event_content(&mut filter, "before da", false);
        let terminal = filter_inline_data_stream_event_content(&mut filter, "ta", true);

        assert_eq!(first, "before ");
        assert_eq!(terminal, "data");
        assert!(filter.finish().is_empty());
    }

    #[test]
    fn terminal_stream_chunk_suppresses_data_uri_before_done() {
        let mut filter = aqbot_core::inline_media::InlineDataStreamFilter::default();

        let first = filter_inline_data_stream_event_content(
            &mut filter,
            "![image](data:image/png;base64,iVBOR",
            false,
        );
        let terminal = filter_inline_data_stream_event_content(&mut filter, "w0KGgo=)", true);

        let emitted = format!("{first}{terminal}");
        assert_eq!(emitted, "![image]([图片接收中])");
        assert!(!emitted.contains("data:image"));
        assert!(!emitted.contains("iVBOR"));
    }

    #[test]
    fn streamed_tool_call_arguments_are_sanitized_without_mutating_backend_value() {
        let raw = ToolCall {
            id: "call-data:image/png;base64,ID".to_string(),
            call_type: "function-data:image/png;base64,TYPE".to_string(),
            function: ToolCallFunction {
                name: "inspect-data:image/png;base64,NAME".to_string(),
                arguments: r#"{"image":"data:image/png;base64,iVBORw0KGgo="}"#.to_string(),
            },
        };

        let emitted = filter_tool_calls_for_event(Some(std::slice::from_ref(&raw))).unwrap();

        assert!(!serde_json::to_string(&emitted).unwrap().contains("data:image"));
        assert!(!serde_json::to_string(&emitted).unwrap().contains("iVBOR"));
        assert!(raw.function.arguments.contains("data:image"));
        assert!(raw.id.contains("data:image"));
        assert!(raw.function.name.contains("data:image"));
    }

    #[test]
    fn complete_mcp_result_filter_preserves_wrapper_after_placeholder() {
        let filtered = format!(
            "{}\n:::\n\n",
            filter_complete_inline_data_event_text("data:image/png;base64,iVBORw0KGgo=")
        );

        assert_eq!(filtered, "[图片接收中]\n:::\n\n");
        assert!(!filtered.contains("data:image"));
    }

    #[test]
    fn append_stream_error_keeps_partial_content_visible() {
        let content = append_stream_error_to_content(
            "已生成的前半段",
            "模型响应空闲超时，已超过 90 秒未收到新内容",
        );

        assert!(content.contains("已生成的前半段"));
        assert!(content.contains("<!-- aqbot-stream-error -->"));
        assert!(content.contains("模型响应空闲超时"));
    }

    #[test]
    fn truncate_mcp_tool_result_keeps_small_outputs() {
        let content = "short MCP result";

        assert_eq!(truncate_mcp_tool_result_content(content, 50), content);
    }

    #[test]
    fn truncate_mcp_tool_result_marks_large_outputs_without_splitting_utf8() {
        let content = format!("{}终", "好".repeat(20));

        let truncated = truncate_mcp_tool_result_content(&content, 25);

        assert!(truncated.starts_with("好好好"));
        assert!(truncated.contains("MCP tool output truncated"));
        assert!(truncated.is_char_boundary(truncated.len()));
        assert!(!truncated.contains("终"));
    }

    #[tokio::test]
    async fn execute_tool_future_returns_cancelled_without_waiting_for_timeout() {
        let cancel_flag = AtomicBool::new(true);
        let started = std::time::Instant::now();

        let (content, is_error) = execute_tool_future(
            pending::<aqbot_core::error::Result<aqbot_core::mcp_client::McpToolResult>>(),
            60,
            Duration::from_secs(60),
            &cancel_flag,
        )
        .await;

        assert_eq!(content, "Error: Tool execution cancelled");
        assert!(is_error);
        assert!(started.elapsed() < Duration::from_secs(1));
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
    fn clean_generated_title_truncates_long_auto_titles() {
        let title = "这是一个用于测试自动会话标题截断逻辑的超长用户问题内容，需要继续追加更多文字";

        assert_eq!(
            clean_generated_title(title),
            title.chars().take(30).collect::<String>() + "..."
        );
    }

    #[test]
    fn generated_title_rejects_inline_media_without_echoing_payload() {
        let error = validated_generated_title("data:image/png;base64,TITLE_SECRET").unwrap_err();

        assert!(error.contains("inline image data"));
        assert!(!error.contains("TITLE_SECRET"));
    }

    #[test]
    fn stream_error_event_sanitizes_every_string_field() {
        let raw = "data:image/png;base64,EVENT_SECRET";
        let event = build_stream_error_event(raw, raw, raw, raw, raw, raw.to_string(), raw, None);
        let serialized = serde_json::to_string(&event).unwrap();

        assert!(!serialized.to_ascii_lowercase().contains("data:image/"));
        assert!(!serialized.contains("EVENT_SECRET"));
    }

    #[test]
    fn should_auto_generate_title_skips_role_conversations() {
        assert!(!should_auto_generate_title(true, "role"));
        assert!(should_auto_generate_title(true, "chat"));
        assert!(should_auto_generate_title(true, "agent"));
        assert!(!should_auto_generate_title(false, "chat"));
    }

    #[test]
    fn system_prompt_log_excerpt_does_not_split_multibyte_characters() {
        let prompt = format!("{}小后续", "a".repeat(79));
        let excerpt = system_prompt_log_excerpt(&prompt);

        assert_eq!(excerpt, "a".repeat(79));
        assert!(prompt.is_char_boundary(excerpt.len()));
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

        let chat_message =
            chat_message_from_message(&file_store, &message, false, None, false).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        assert_eq!(serialized["content"], "final answer");
        assert_eq!(serialized["reasoning_content"], "hidden thinking");
    }

    #[test]
    fn provider_context_reconstructs_complete_tool_call_groups() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "user-1",
                MessageRole::User,
                "please read",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "tool-assistant-1",
                MessageRole::Assistant,
                "<think totalMs=\"3\">need file</think>",
                Some("user-1"),
                -1,
                false,
                Some(
                    r#"[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]"#,
                ),
                None,
            ),
            test_message(
                "tool-1",
                MessageRole::Tool,
                "file content",
                Some("tool-assistant-1"),
                -1,
                false,
                None,
                Some("call-1"),
            ),
            test_message(
                "assistant-1",
                MessageRole::Assistant,
                "<think totalMs=\"7\">final thinking</think>\n\n:::mcp {\"id\":\"call-1\",\"tool\":\"read_file\"}\nfile content\n:::\n\nread done",
                Some("user-1"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "user-2",
                MessageRole::User,
                "next question",
                None,
                0,
                true,
                None,
                None,
            ),
        ];

        let context = build_provider_context_messages(
            &file_store,
            &messages,
            false,
            None,
            Some("user-2"),
            None,
        )
        .unwrap();

        assert_eq!(
            context
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "assistant", "user"]
        );
        assert_eq!(context[1].reasoning_content.as_deref(), Some("need file"));
        assert_eq!(context[1].tool_calls.as_ref().unwrap()[0].id, "call-1");
        assert_eq!(context[2].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(context[3].reasoning_content, None);
    }

    #[test]
    fn summary_boundary_keeps_messages_after_compressed_until_even_when_marker_is_later() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "old-user",
                MessageRole::User,
                "old user",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "old-assistant",
                MessageRole::Assistant,
                "old assistant",
                Some("old-user"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "current-user",
                MessageRole::User,
                "current user that triggered compression",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "compression-marker",
                MessageRole::System,
                crate::context_manager::COMPRESSION_MARKER,
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "current-assistant",
                MessageRole::Assistant,
                "answer after compression",
                Some("current-user"),
                0,
                true,
                None,
                None,
            ),
        ];
        let summary = test_summary(Some("old-assistant"));
        let boundary = resolve_context_boundary(&messages, Some(&summary));

        assert!(boundary.use_summary);
        let context = build_provider_context_messages_from_index(
            &file_store,
            &messages,
            boundary.start_index,
            false,
            None,
            Some("current-user"),
            None,
        )
        .unwrap();

        let text = context
            .iter()
            .filter_map(|message| match &message.content {
                ChatContent::Text(content) => Some(content.as_str()),
                ChatContent::Multipart(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            text,
            vec![
                "current user that triggered compression",
                "answer after compression"
            ]
        );
    }

    #[test]
    fn context_clear_after_summary_boundary_disables_old_summary() {
        let messages = vec![
            test_message(
                "old-user",
                MessageRole::User,
                "old user",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "old-assistant",
                MessageRole::Assistant,
                "old assistant",
                Some("old-user"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "clear-marker",
                MessageRole::System,
                "<!-- context-clear -->",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "new-user",
                MessageRole::User,
                "new user",
                None,
                0,
                true,
                None,
                None,
            ),
        ];
        let summary = test_summary(Some("old-assistant"));
        let boundary = resolve_context_boundary(&messages, Some(&summary));

        assert!(!boundary.use_summary);
        assert_eq!(boundary.start_index, 3);
    }

    #[test]
    fn provider_context_ignores_stale_tool_scaffolding_from_inactive_versions() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "user-1",
                MessageRole::User,
                "please read",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "old-tool-assistant",
                MessageRole::Assistant,
                "<think>old tool</think>",
                Some("user-1"),
                -1,
                false,
                Some(
                    r#"[{"id":"call-old","type":"function","function":{"name":"read_file","arguments":"{}"}}]"#,
                ),
                None,
            ),
            test_message(
                "old-tool",
                MessageRole::Tool,
                "old file content",
                Some("old-tool-assistant"),
                -1,
                false,
                None,
                Some("call-old"),
            ),
            test_message(
                "new-tool-assistant",
                MessageRole::Assistant,
                "<think>new tool</think>",
                Some("user-1"),
                -1,
                false,
                Some(
                    r#"[{"id":"call-new","type":"function","function":{"name":"read_file","arguments":"{}"}}]"#,
                ),
                None,
            ),
            test_message(
                "new-tool",
                MessageRole::Tool,
                "new file content",
                Some("new-tool-assistant"),
                -1,
                false,
                None,
                Some("call-new"),
            ),
            test_message(
                "assistant-1",
                MessageRole::Assistant,
                ":::mcp {\"id\":\"call-new\",\"tool\":\"read_file\"}\nnew file content\n:::\n\nread done",
                Some("user-1"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "user-2",
                MessageRole::User,
                "next question",
                None,
                0,
                true,
                None,
                None,
            ),
        ];

        let context = build_provider_context_messages(
            &file_store,
            &messages,
            false,
            None,
            Some("user-2"),
            None,
        )
        .unwrap();
        let tool_call_ids = context
            .iter()
            .filter_map(|message| message.tool_calls.as_ref())
            .flat_map(|tool_calls| tool_calls.iter().map(|tool_call| tool_call.id.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(tool_call_ids, vec!["call-new"]);
        assert!(!context.iter().any(|message| {
            matches!(&message.content, ChatContent::Text(content) if content.contains("old file content"))
        }));
    }

    #[test]
    fn provider_context_downgrades_malformed_tool_call_groups() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "user-1",
                MessageRole::User,
                "please read",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "tool-assistant-1",
                MessageRole::Assistant,
                "<think totalMs=\"3\">need file</think>",
                Some("user-1"),
                -1,
                false,
                Some(
                    r#"[{"id":"","type":"function","function":{"name":"read_file","arguments":"{}"}}]"#,
                ),
                None,
            ),
            test_message(
                "tool-1",
                MessageRole::Tool,
                "file content",
                Some("tool-assistant-1"),
                -1,
                false,
                None,
                Some("call-1"),
            ),
            test_message(
                "assistant-1",
                MessageRole::Assistant,
                "<think totalMs=\"7\">final thinking</think>\n\nread done",
                Some("user-1"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "user-2",
                MessageRole::User,
                "next question",
                None,
                0,
                true,
                None,
                None,
            ),
        ];

        let context = build_provider_context_messages(
            &file_store,
            &messages,
            false,
            None,
            Some("user-2"),
            None,
        )
        .unwrap();

        assert_eq!(
            context
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            vec!["user", "assistant", "user"]
        );
        assert!(context.iter().all(|message| message.tool_calls.is_none()));
        assert!(context.iter().all(|message| message.tool_call_id.is_none()));
        assert!(context
            .iter()
            .filter(|message| message.role == "assistant")
            .all(|message| message.reasoning_content.is_none()));
    }

    #[test]
    fn historical_user_search_context_is_stripped_from_model_history() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let message = Message {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            role: MessageRole::User,
            content: concat!(
                "<!-- search:{\"sources\":[{\"title\":\"A\",\"url\":\"https://example.com\"}]} -->\n",
                "以下是与问题相关的网络搜索结果，请参考回答：\n\n",
                "1. **A** - https://example.com\n   search body\n\n",
                "---\n\n",
                "用户原始问题"
            )
            .into(),
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

        let chat_message =
            chat_message_from_message(&file_store, &message, false, None, false).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        assert_eq!(serialized["content"], "用户原始问题");
    }

    #[test]
    fn current_user_search_context_is_preserved_for_model_request() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let content = concat!(
            "<!-- search:{\"sources\":[{\"title\":\"A\",\"url\":\"https://example.com\"}],\"query\":\"AQBot 产品详情\",\"queryStatus\":\"error\",\"queryError\":\"搜索语句总结失败：AI returned empty search query\"} -->\n",
            "以下是与问题相关的网络搜索结果，请参考回答：\n\n",
            "1. **A** - https://example.com\n   search body\n\n",
            "---\n\n",
            "用户原始问题"
        );
        let message = Message {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            role: MessageRole::User,
            content: content.into(),
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

        let chat_message =
            chat_message_from_message(&file_store, &message, false, None, true).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        let content = serialized["content"].as_str().unwrap();
        assert!(content.contains("search body"));
        assert!(content.contains("用户原始问题"));
        assert!(!content.contains("<!-- search:"));
        assert!(!content.contains("搜索语句总结失败"));
    }

    #[test]
    fn assistant_history_strips_web_search_display_tags() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let message = Message {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            role: MessageRole::Assistant,
            content: concat!(
                "<web-search-query status=\"done\" query=\"AQBot 产品详情\" data-aqbot=\"1\">",
                "</web-search-query>\n\n",
                "<web-search status=\"done\" data-aqbot=\"1\">\n",
                "[{\"title\":\"A\",\"url\":\"https://example.com\",\"content\":\"search body\"}]\n",
                "</web-search>\n\n",
                "final answer"
            )
            .into(),
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

        let chat_message =
            chat_message_from_message(&file_store, &message, false, None, false).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        assert_eq!(serialized["content"], "final answer");
    }

    #[test]
    fn auto_compression_excludes_current_user_from_summary_and_keeps_it_for_request() {
        let history_messages = vec![
            ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("old user message".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: ChatContent::Text("old assistant message".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("current user message with search body".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
        ];

        let (messages_to_compress, post_compression_history) =
            split_auto_compression_history(&history_messages, Some(2));

        assert_eq!(messages_to_compress.len(), 2);
        assert_eq!(post_compression_history.len(), 1);
        assert!(matches!(
            &post_compression_history[0].content,
            ChatContent::Text(content) if content == "current user message with search body"
        ));
        assert!(!messages_to_compress.iter().any(|message| {
            matches!(
                &message.content,
                ChatContent::Text(content) if content.contains("current user message")
            )
        }));
    }

    #[test]
    fn clean_generated_search_query_keeps_only_plain_query_text() {
        assert_eq!(
            clean_generated_search_query("搜索查询：\"AQBot Windows 0.0.76 下载\""),
            "AQBot Windows 0.0.76 下载"
        );
        assert_eq!(
            clean_generated_search_query("```text\nChrome 网站权限 设置\n```"),
            "Chrome 网站权限 设置"
        );
    }

    #[test]
    fn search_query_prompt_uses_latest_user_message_and_history() {
        let messages = build_search_query_generation_messages(
            &[
                ChatMessage {
                    role: "user".to_string(),
                    content: ChatContent::Text(
                        "帮我搜索 AQBot Desktop Windows 下载地址".to_string(),
                    ),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "assistant".to_string(),
                    content: ChatContent::Text("需要联网搜索确认。".to_string()),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                },
            ],
            "没事，给你权限了，你可以搜索和打开任何网页了",
        );
        let prompt = match &messages[1].content {
            ChatContent::Text(content) => content,
            ChatContent::Multipart(_) => panic!("expected text prompt"),
        };

        assert!(prompt.contains("AQBot Desktop Windows 下载地址"));
        assert!(prompt.contains("没事，给你权限了"));
        assert!(prompt.contains("Return only the search query"));
    }

    #[test]
    fn empty_search_query_response_requires_retry_without_using_thinking() {
        let response = ChatResponse {
            id: "resp-1".to_string(),
            model: "mimo-v2.5".to_string(),
            content: String::new(),
            thinking: Some("AQBot 产品详情".to_string()),
            usage: TokenUsage {
                prompt_tokens: 100,
                completion_tokens: 96,
                total_tokens: 196,
            },
            tool_calls: None,
        };

        let err = clean_generated_search_query_response(&response)
            .expect_err("empty content should fail");

        assert!(err.contains("empty content"));
        assert!(err.contains("thinking present"));
        assert!(!err.contains("AQBot 产品详情"));
    }

    #[test]
    fn generated_search_query_rejects_inline_media_without_echoing_it() {
        let response = ChatResponse {
            id: "resp-media".to_string(),
            model: "model".to_string(),
            content: "data:image/png;base64,SEARCH_SECRET".to_string(),
            thinking: None,
            usage: TokenUsage {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
            },
            tool_calls: None,
        };

        let error = clean_generated_search_query_response(&response).unwrap_err();

        assert!(error.contains("inline image data"));
        assert!(!error.contains("SEARCH_SECRET"));
    }

    #[test]
    fn retry_search_query_prompt_requires_a_non_empty_query() {
        let messages = build_retry_search_query_generation_messages(
            &[
                ChatMessage {
                    role: "user".to_string(),
                    content: ChatContent::Text("licoy 的最新开源项目".to_string()),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "assistant".to_string(),
                    content: ChatContent::Text("第一个产品是 AQBot。".to_string()),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                },
            ],
            "给我第一个产品的详情",
        );
        let prompt = match &messages[1].content {
            ChatContent::Text(content) => content,
            ChatContent::Multipart(_) => panic!("expected text prompt"),
        };

        assert!(prompt.contains("must return exactly one non-empty search query"));
        assert!(prompt.contains("给我第一个产品的详情"));
        assert!(prompt.contains("AQBot"));
    }

    #[test]
    fn retry_search_query_request_uses_enough_tokens_for_thinking_models() {
        assert!(
            SEARCH_QUERY_RETRY_MAX_TOKENS >= 1024,
            "retry query generation needs enough output budget for models that emit reasoning before visible content"
        );
    }

    #[test]
    fn model_sampling_params_override_global_defaults_when_conversation_params_are_unset() {
        let mut settings = AppSettings::default();
        settings.default_temperature = Some(0.875);
        settings.default_top_p = Some(0.9375);
        settings.default_max_tokens = Some(32768);

        let params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(Some(0.25), Some(4096), Some(0.75))),
            &settings,
            None,
            None,
        );

        assert_eq!(params.temperature, Some(0.25));
        assert_eq!(params.top_p, Some(0.75));
        assert_eq!(params.max_tokens, Some(32768));
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
            None,
        );

        assert_eq!(params.temperature, Some(0.5));
        assert_eq!(params.top_p, Some(0.625));
        assert_eq!(params.max_tokens, Some(8192));
    }

    #[test]
    fn model_max_tokens_is_not_sent_when_force_max_tokens_is_disabled() {
        let settings = AppSettings::default();

        let params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(None, Some(1_048_576), None)),
            &settings,
            None,
            Some(false),
        );

        assert_eq!(params.max_tokens, None);
    }

    #[test]
    fn model_max_tokens_does_not_apply_just_because_max_completion_tokens_is_enabled() {
        let mut settings = AppSettings::default();
        settings.default_max_tokens = Some(32768);

        let params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(None, Some(2048), None)),
            &settings,
            Some(true),
            None,
        );

        assert_eq!(params.max_tokens, Some(32768));
    }

    #[test]
    fn force_max_tokens_uses_specific_defaults_before_falling_back_to_4096() {
        let mut settings = AppSettings::default();
        settings.default_max_tokens = Some(32768);

        let model_params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(None, Some(4096), None)),
            &settings,
            None,
            Some(true),
        );
        assert_eq!(model_params.max_tokens, Some(4096));

        settings.default_max_tokens = None;
        let fallback_params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            None,
            &settings,
            None,
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

            build_message_content(&file_store, &message, false, None, false).unwrap()
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

            build_message_content(&file_store, &message, false, None, false).unwrap()
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

    #[test]
    fn build_message_content_appends_document_text_when_enabled() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-document-attachment-test-{}",
            aqbot_core::utils::gen_id()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let result = (|| {
            let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
            let docx = test_docx_bytes("Alpha project requirements");
            let saved = file_store
                .save_file(
                    &docx,
                    "requirements.docx",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                .unwrap();
            let message = Message {
                id: "msg-1".into(),
                conversation_id: "conv-1".into(),
                role: MessageRole::User,
                content: "Summarize this".into(),
                provider_id: None,
                model_id: None,
                token_count: None,
                prompt_tokens: None,
                completion_tokens: None,
                tokens_per_second: None,
                first_token_latency_ms: None,
                attachments: vec![Attachment {
                    id: "att-1".into(),
                    file_type:
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            .into(),
                    file_name: "requirements.docx".into(),
                    file_path: saved.storage_path,
                    file_size: docx.len() as u64,
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

            build_message_content(&file_store, &message, true, Some(4096), false).unwrap()
        })();

        fs::remove_dir_all(&temp_dir).unwrap();

        match result {
            ChatContent::Text(text) => {
                assert!(text.contains("Summarize this"));
                assert!(text.contains("requirements.docx"));
                assert!(text.contains("Alpha project requirements"));
            }
            ChatContent::Multipart(_) => panic!("expected text content"),
        }
    }

    #[test]
    fn build_message_content_ignores_document_text_when_disabled() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-document-disabled-test-{}",
            aqbot_core::utils::gen_id()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let result = (|| {
            let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
            let docx = test_docx_bytes("Hidden project requirements");
            let saved = file_store
                .save_file(
                    &docx,
                    "requirements.docx",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                .unwrap();
            let message = Message {
                id: "msg-1".into(),
                conversation_id: "conv-1".into(),
                role: MessageRole::User,
                content: "Summarize this".into(),
                provider_id: None,
                model_id: None,
                token_count: None,
                prompt_tokens: None,
                completion_tokens: None,
                tokens_per_second: None,
                first_token_latency_ms: None,
                attachments: vec![Attachment {
                    id: "att-1".into(),
                    file_type:
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            .into(),
                    file_name: "requirements.docx".into(),
                    file_path: saved.storage_path,
                    file_size: docx.len() as u64,
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

            build_message_content(&file_store, &message, false, Some(4096), false).unwrap()
        })();

        fs::remove_dir_all(&temp_dir).unwrap();

        match result {
            ChatContent::Text(text) => assert_eq!(text, "Summarize this"),
            ChatContent::Multipart(_) => panic!("expected text content"),
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
    async fn branched_media_survives_source_deletion_until_last_reference() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let temp_dir = tempfile::tempdir().unwrap();
        let file_store =
            aqbot_core::file_store::FileStore::with_root(temp_dir.path().to_path_buf());
        let source = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Media source",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let saved = file_store
            .save_file(b"shared media", "inline.png", "image/png")
            .unwrap();
        let physical_path = temp_dir.path().join(&saved.storage_path);
        aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "source-file",
            &saved.hash,
            "inline.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&source.id),
        )
        .await
        .unwrap();
        let source_message = aqbot_core::repo::message::create_message(
            &db,
            &source.id,
            MessageRole::Assistant,
            "![preview](aqbot-media://stored/source-file)",
            &[Attachment {
                id: "source-file".to_string(),
                file_type: "image/png".to_string(),
                file_name: "inline.png".to_string(),
                file_path: saved.storage_path.clone(),
                file_size: saved.size_bytes as u64,
                data: None,
            }],
            None,
            0,
        )
        .await
        .unwrap();

        let branch = aqbot_core::repo::conversation::branch_conversation(
            &db,
            &source.id,
            &source_message.id,
            false,
            None,
        )
        .await
        .unwrap();
        let branch_files =
            aqbot_core::repo::stored_file::list_stored_files_by_conversation(&db, &branch.id)
                .await
                .unwrap();
        assert_eq!(branch_files.len(), 1);
        assert_ne!(branch_files[0].id, "source-file");
        assert_eq!(branch_files[0].storage_path, saved.storage_path);
        assert_eq!(branch_files[0].hash, saved.hash);
        let branch_messages = aqbot_core::repo::message::list_messages(&db, &branch.id)
            .await
            .unwrap();
        assert_eq!(branch_messages.len(), 1);
        assert_eq!(branch_messages[0].attachments[0].id, branch_files[0].id);
        assert_eq!(
            branch_messages[0].content,
            format!("![preview](aqbot-media://stored/{})", branch_files[0].id)
        );

        delete_conversation_with_attachments_using(&db, &file_store, &source.id)
            .await
            .unwrap();
        assert!(physical_path.exists());
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, &branch_files[0].id)
                .await
                .is_ok()
        );

        delete_conversation_with_attachments_using(&db, &file_store, &branch.id)
            .await
            .unwrap();
        assert!(!physical_path.exists());
    }

    #[tokio::test]
    async fn deleting_conversation_preserves_media_referenced_by_drawing() {
        use aqbot_core::repo::drawing::NewDrawingGeneration;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let temp_dir = tempfile::tempdir().unwrap();
        let file_store =
            aqbot_core::file_store::FileStore::with_root(temp_dir.path().to_path_buf());
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Drawing reference owner",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let saved = file_store
            .save_file(b"drawing reference", "reference.png", "image/png")
            .unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "drawing-reference-file",
            &saved.hash,
            "reference.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&conversation.id),
        )
        .await
        .unwrap();
        let generation = aqbot_core::repo::drawing::create_generation(
            &db,
            NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "provider-1".into(),
                key_id: "key-1".into(),
                model_id: "gpt-image-2".into(),
                action: "edit".into(),
                prompt: "preserve".into(),
                parameters_json: "{}".into(),
                reference_file_ids_json: serde_json::to_string(&vec![stored.id.clone()]).unwrap(),
                source_image_ids_json: "[]".into(),
                mask_file_id: None,
            },
        )
        .await
        .unwrap();

        delete_conversation_with_attachments_using(&db, &file_store, &conversation.id)
            .await
            .unwrap();

        assert!(aqbot_core::repo::conversation::get_conversation(&db, &conversation.id)
            .await
            .is_err());
        assert!(aqbot_core::repo::stored_file::get_stored_file(&db, &stored.id)
            .await
            .is_ok());
        assert!(file_store.read_file(&stored.storage_path).is_ok());
        let fetched = aqbot_core::repo::drawing::get_generation(&db, &generation.id)
            .await
            .unwrap();
        assert_eq!(fetched.reference_files[0].id, stored.id);
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
            release_webview_on_tray: Arc::new(AtomicBool::new(false)),
            main_window_released_to_tray: Arc::new(AtomicBool::new(false)),
            main_window_restoring: Arc::new(AtomicBool::new(false)),
            is_quitting: Arc::new(AtomicBool::new(false)),
            app_data_dir: temp_dir.clone(),
            db_path: "sqlite::memory:".to_string(),
            auto_backup_handle: Arc::new(Mutex::new(None)),
            webdav_sync_handle: Arc::new(Mutex::new(None)),
            s3_sync_handle: Arc::new(Mutex::new(None)),
            vector_store,
            knowledge_index_scheduler: Arc::new(
                crate::knowledge_index_scheduler::KnowledgeIndexScheduler::default(),
            ),
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

    #[tokio::test]
    async fn persist_attachments_rolls_back_rows_and_new_files_on_batch_failure() {
        use base64::Engine;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Attachment rollback",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let state = test_app_state(db.clone());
        let bytes = format!("unique-{}", aqbot_core::utils::gen_id()).into_bytes();
        let file_name = format!("rollback-{}.png", aqbot_core::utils::gen_id());
        let expected_path = aqbot_core::storage_paths::build_relative_path(
            &file_name,
            "image/png",
            &aqbot_core::file_store::FileStore::hash_bytes(&bytes),
        );
        let attachments = vec![
            AttachmentInput {
                file_name,
                file_type: "image/png".to_string(),
                file_size: bytes.len() as u64,
                data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            },
            AttachmentInput {
                file_name: "invalid.png".to_string(),
                file_type: "image/png".to_string(),
                file_size: 1,
                data: "%%%not-base64%%%".to_string(),
            },
        ];

        let result = persist_attachments(&state, &conversation.id, &attachments).await;

        assert!(result.is_err());
        assert!(
            aqbot_core::repo::stored_file::list_stored_files_by_conversation(
                &db,
                &conversation.id,
            )
            .await
            .unwrap()
            .is_empty()
        );
        assert!(!aqbot_core::file_store::FileStore::new()
            .resolve_path(&expected_path)
            .exists());
    }

    #[tokio::test]
    async fn attachment_metadata_is_rejected_before_any_file_or_row_is_created() {
        use base64::Engine;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Attachment preflight",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let state = test_app_state(db.clone());
        let bytes = format!("preflight-{}", aqbot_core::utils::gen_id()).into_bytes();
        let expected_path = aqbot_core::storage_paths::build_relative_path(
            "safe.png",
            "image/png",
            &aqbot_core::file_store::FileStore::hash_bytes(&bytes),
        );
        let attachments = vec![AttachmentInput {
            file_name: "data:image/png;base64,SECRET".to_string(),
            file_type: "image/png".to_string(),
            file_size: bytes.len() as u64,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        }];

        let error = persist_attachments(&state, &conversation.id, &attachments)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("Attachment 0 metadata"));
        assert!(!error.to_string().contains("SECRET"));
        assert!(aqbot_core::repo::stored_file::list_stored_files_by_conversation(
            &db,
            &conversation.id,
        )
        .await
        .unwrap()
        .is_empty());
        assert!(aqbot_core::repo::message::list_messages(&db, &conversation.id)
            .await
            .unwrap()
            .is_empty());
        assert!(!aqbot_core::file_store::FileStore::new()
            .resolve_path(&expected_path)
            .exists());
    }

    #[tokio::test]
    async fn new_message_ipc_failure_removes_the_unreturnable_row() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "IPC rollback",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let message = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::User,
            "plain data:image/png;base64,SECRET",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let error = finalize_new_message_for_ipc(&db, message.clone(), None)
            .await
            .unwrap_err();

        assert!(error.contains(&message.id));
        assert!(!error.contains("SECRET"));
        assert!(aqbot_core::repo::message::get_message(&db, &message.id)
            .await
            .is_err());
    }
}
