use crate::AppState;
use aqbot_agent::permission::{classify_tool_risk, decide_permission, PermissionAction};
use aqbot_agent::security::check_path_safety;
use aqbot_core::inline_media::{InlineDataStreamCapture, InlineDataStreamFilter};
use aqbot_core::repo::{agent_session, conversation, message, provider, tool_execution};
use aqbot_core::types::{
    AgentSession, AppSettings, Attachment, AttachmentInput, MessageRole, ProviderProxyConfig,
    ProviderType,
};
use aqbot_providers::{resolve_base_url_for_type, ProviderAdapter, ProviderRequestContext};
use open_agent_sdk::{
    Agent, AgentOptions, CanUseToolFn, ContentBlock, PermissionDecision, SDKMessage, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{Emitter, State};
use tokio::sync::RwLock;

/// In-memory map of conversation IDs to actively running agent task IDs.
/// Used as the source of truth for concurrency checks (more reliable than DB status).
static RUNNING_AGENTS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const DEFAULT_AGENT_WORKSPACE_DATETIME_FORMAT: &str = "YYYY-MM-DD-HH-mm-ss";
const MAX_AGENT_WORKSPACE_NAME_LEN: usize = 80;

/// RAII guard that removes a conversation ID from RUNNING_AGENTS on drop.
/// Ensures cleanup even if the spawned task panics.
struct RunningAgentGuard {
    conversation_id: String,
    run_id: String,
}

impl Drop for RunningAgentGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING_AGENTS.lock() {
            if running.get(&self.conversation_id) == Some(&self.run_id) {
                running.remove(&self.conversation_id);
            }
        }
    }
}

struct AgentCancelTokenGuard {
    conversation_id: String,
    tokens: Arc<tokio::sync::Mutex<HashMap<String, open_agent_sdk::CancellationToken>>>,
}

impl Drop for AgentCancelTokenGuard {
    fn drop(&mut self) {
        let conversation_id = self.conversation_id.clone();
        let tokens = self.tokens.clone();
        tokio::spawn(async move {
            tokens.lock().await.remove(&conversation_id);
        });
    }
}

fn agent_workspace_root(settings: &AppSettings) -> PathBuf {
    settings
        .agent_workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::aqbot_home().join("workspace"))
}

fn agent_workspace_dir_name(
    conv: &aqbot_core::types::Conversation,
    settings: &AppSettings,
) -> String {
    let raw = match settings.agent_workspace_name_strategy.as_str() {
        "conversation_id" | "uuid" => conv.id.clone(),
        "created_timestamp" => conv.created_at.to_string(),
        "created_datetime" => {
            let format = settings
                .agent_workspace_datetime_format
                .as_deref()
                .map(str::trim)
                .filter(|format| !format.is_empty())
                .unwrap_or(DEFAULT_AGENT_WORKSPACE_DATETIME_FORMAT);
            format_agent_workspace_datetime(conv.created_at, format)
        }
        _ => conv.id.clone(),
    };

    sanitize_workspace_dir_name(&raw)
}

fn format_agent_workspace_datetime(timestamp: i64, format: &str) -> String {
    use chrono::{Local, TimeZone};

    let dt = Local
        .timestamp_opt(timestamp, 0)
        .single()
        .or_else(|| Local.timestamp_opt(0, 0).single())
        .expect("local epoch timestamp should be valid");

    format
        .replace("YYYY", &dt.format("%Y").to_string())
        .replace("MM", &dt.format("%m").to_string())
        .replace("DD", &dt.format("%d").to_string())
        .replace("HH", &dt.format("%H").to_string())
        .replace("mm", &dt.format("%M").to_string())
        .replace("ss", &dt.format("%S").to_string())
}

fn sanitize_workspace_dir_name(raw: &str) -> String {
    let mut sanitized = String::with_capacity(raw.len().min(MAX_AGENT_WORKSPACE_NAME_LEN));
    let mut last_was_dash = false;

    for ch in raw.chars() {
        let safe = if ch.is_control()
            || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        {
            '-'
        } else {
            ch
        };

        if safe == '-' {
            if !last_was_dash {
                sanitized.push('-');
                last_was_dash = true;
            }
        } else {
            sanitized.push(safe);
            last_was_dash = false;
        }
    }

    let trimmed = sanitized.trim_matches(|ch| matches!(ch, '-' | '.' | ' '));
    let bounded = truncate_workspace_name(
        if trimmed.is_empty() {
            "workspace"
        } else {
            trimmed
        },
        MAX_AGENT_WORKSPACE_NAME_LEN,
    );
    let final_name = bounded
        .trim_matches(|ch| matches!(ch, '-' | '.' | ' '))
        .to_string();

    if final_name.is_empty() {
        "workspace".to_string()
    } else {
        final_name
    }
}

fn truncate_workspace_name(value: &str, max_len: usize) -> String {
    let mut output = String::new();
    for ch in value.chars() {
        if output.len() + ch.len_utf8() > max_len {
            break;
        }
        output.push(ch);
    }
    output
}

fn resolve_agent_workspace_dir(
    settings: &AppSettings,
    conv: &aqbot_core::types::Conversation,
) -> PathBuf {
    let root = agent_workspace_root(settings);
    let base_name = agent_workspace_dir_name(conv, settings);
    let first = root.join(&base_name);
    if !first.exists() {
        return first;
    }

    let id_suffix = short_conversation_id(&conv.id);
    let with_id = root.join(append_workspace_suffix(&base_name, &id_suffix));
    if !with_id.exists() {
        return with_id;
    }

    for index in 2..10_000 {
        let name = append_workspace_suffix(&base_name, &format!("{}-{}", id_suffix, index));
        let path = root.join(name);
        if !path.exists() {
            return path;
        }
    }

    root.join(append_workspace_suffix(
        &base_name,
        &aqbot_core::utils::gen_id()
            .chars()
            .take(8)
            .collect::<String>(),
    ))
}

fn append_workspace_suffix(base: &str, suffix: &str) -> String {
    let safe_suffix = sanitize_workspace_dir_name(suffix);
    let suffix_part = format!("-{}", safe_suffix);
    let max_base_len = MAX_AGENT_WORKSPACE_NAME_LEN.saturating_sub(suffix_part.len());
    let base_part = truncate_workspace_name(base, max_base_len.max(1))
        .trim_matches(|ch| matches!(ch, '-' | '.' | ' '))
        .to_string();
    format!(
        "{}{}",
        if base_part.is_empty() {
            "workspace"
        } else {
            &base_part
        },
        suffix_part
    )
}

fn short_conversation_id(conversation_id: &str) -> String {
    let prefix = conversation_id.chars().take(8).collect::<String>();
    sanitize_workspace_dir_name(if prefix.is_empty() { "conv" } else { &prefix })
}

const INLINE_MEDIA_PENDING_PLACEHOLDER: &str = "[图片接收中]";

fn agent_persistable_snapshot(content: &str) -> &str {
    if content
        .as_bytes()
        .windows(b"data:image/".len())
        .any(|window| window.eq_ignore_ascii_case(b"data:image/"))
    {
        INLINE_MEDIA_PENDING_PLACEHOLDER
    } else {
        content
    }
}

async fn persist_agent_stream_snapshot(
    db: &sea_orm::DatabaseConnection,
    message_id: &str,
    content: &str,
) -> bool {
    match message::update_message_content(db, message_id, agent_persistable_snapshot(content)).await
    {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(
                message_id,
                error = %error,
                "Failed to persist agent stream snapshot"
            );
            false
        }
    }
}

async fn ensure_agent_assistant_message(
    db: &sea_orm::DatabaseConnection,
    app: &tauri::AppHandle,
    conv_id: &str,
    user_msg_id: &str,
    content: &str,
    current_assistant_msg_id: &mut Option<String>,
    assistant_id_for_task: &Arc<RwLock<Option<String>>>,
) -> Option<String> {
    if let Some(message_id) = current_assistant_msg_id.clone() {
        return Some(message_id);
    }

    match message::create_message(
        db,
        conv_id,
        MessageRole::Assistant,
        agent_persistable_snapshot(content),
        &[],
        Some(user_msg_id),
        0,
    )
    .await
    {
        Ok(assist_msg) => {
            let message_id = assist_msg.id.clone();
            *current_assistant_msg_id = Some(message_id.clone());
            *assistant_id_for_task.write().await = Some(message_id.clone());
            tracing::info!("[agent] Created assistant message: {}", message_id);
            let _ = app.emit(
                "agent-message-id",
                serde_json::json!({
                    "conversationId": conv_id,
                    "assistantMessageId": message_id.clone(),
                }),
            );
            let _ = conversation::increment_message_count(db, conv_id).await;
            Some(message_id)
        }
        Err(err) => {
            tracing::warn!("[agent] Failed to create assistant message: {}", err);
            None
        }
    }
}

async fn persist_agent_partial_content(
    db: &sea_orm::DatabaseConnection,
    app: &tauri::AppHandle,
    conv_id: &str,
    user_msg_id: &str,
    content: &str,
    current_assistant_msg_id: &mut Option<String>,
    assistant_id_for_task: &Arc<RwLock<Option<String>>>,
) -> Option<String> {
    let message_id = ensure_agent_assistant_message(
        db,
        app,
        conv_id,
        user_msg_id,
        content,
        current_assistant_msg_id,
        assistant_id_for_task,
    )
    .await?;
    persist_agent_stream_snapshot(db, &message_id, content).await;
    Some(message_id)
}

fn filtered_agent_stream_chunk(filter: &mut InlineDataStreamFilter, chunk: &str) -> Option<String> {
    let filtered = filter.push(chunk);
    (!filtered.is_empty()).then_some(filtered)
}

fn filtered_agent_stream_tail(filter: &mut InlineDataStreamFilter) -> Option<String> {
    let filtered = filter.finish();
    (!filtered.is_empty()).then_some(filtered)
}

fn filter_complete_agent_event_text(text: &str) -> String {
    let mut filter = InlineDataStreamFilter::default();
    let mut filtered = filter.push(text);
    filtered.push_str(&filter.finish());
    filtered
}

fn filter_agent_tool_identity(tool_use_id: &str, tool_name: &str) -> (String, String) {
    (
        filter_complete_agent_event_text(tool_use_id),
        filter_complete_agent_event_text(tool_name),
    )
}

fn append_captured_agent_text(
    capture: &mut InlineDataStreamCapture,
    target: &mut String,
    text: &str,
) -> aqbot_core::error::Result<()> {
    let delta = capture.push(text)?;
    target.push_str(&delta.content);
    Ok(())
}

fn filter_agent_event_json(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(filter_complete_agent_event_text(text)),
        Value::Array(values) => Value::Array(values.iter().map(filter_agent_event_json).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    (
                        filter_complete_agent_event_text(key),
                        filter_agent_event_json(value),
                    )
                })
                .collect(),
        ),
        value => value.clone(),
    }
}

fn flush_agent_stream_filters(
    app: &tauri::AppHandle,
    conversation_id: &str,
    assistant_message_id: Option<&str>,
    text_filter: &mut InlineDataStreamFilter,
    thinking_filter: &mut InlineDataStreamFilter,
) {
    let assistant_message_id = assistant_message_id.unwrap_or_default().to_string();
    if let Some(text) = filtered_agent_stream_tail(text_filter) {
        let _ = app.emit(
            "agent-stream-text",
            AgentTextPayload {
                conversation_id: conversation_id.to_string(),
                assistant_message_id: assistant_message_id.clone(),
                text,
            },
        );
    }
    if let Some(thinking) = filtered_agent_stream_tail(thinking_filter) {
        let _ = app.emit(
            "agent-stream-thinking",
            AgentThinkingPayload {
                conversation_id: conversation_id.to_string(),
                assistant_message_id,
                thinking,
            },
        );
    }
}

// ---------------------------------------------------------------------------
// Payload types for Tauri events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDonePayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId")]
    pub assistant_message_id: String,
    pub text: String,
    pub usage: Option<AgentUsagePayload>,
    #[serde(rename = "numTurns")]
    pub num_turns: Option<u32>,
    #[serde(rename = "costUsd")]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentUsagePayload {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentErrorPayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId")]
    pub assistant_message_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolStartPayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId")]
    pub assistant_message_id: String,
    #[serde(rename = "toolUseId")]
    pub tool_use_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolUsePayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId")]
    pub assistant_message_id: String,
    #[serde(rename = "toolUseId")]
    pub tool_use_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub input: Value,
    #[serde(rename = "executionId")]
    pub execution_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolResultPayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId")]
    pub assistant_message_id: String,
    #[serde(rename = "toolUseId")]
    pub tool_use_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub content: String,
    #[serde(rename = "isError")]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPermissionRequestPayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId")]
    pub assistant_message_id: String,
    #[serde(rename = "toolUseId")]
    pub tool_use_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub input: Value,
    #[serde(rename = "riskLevel")]
    pub risk_level: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentAskUserPayload {
    conversation_id: String,
    assistant_message_id: String,
    ask_id: String,
    question: String,
    options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatusPayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRateLimitPayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "retryAfterMs")]
    pub retry_after_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentThinkingPayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId")]
    pub assistant_message_id: String,
    pub thinking: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTextPayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "assistantMessageId")]
    pub assistant_message_id: String,
    pub text: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/// Create an `Arc<dyn ProviderAdapter>` directly (avoids borrow-lifetime issues
/// with the registry returning `&dyn ProviderAdapter`).
fn create_adapter_arc(pt: &ProviderType) -> Result<Arc<dyn ProviderAdapter>, String> {
    match pt {
        ProviderType::OpenAI => Ok(Arc::new(aqbot_providers::openai::OpenAIAdapter::new())),
        ProviderType::Custom => Ok(Arc::new(
            aqbot_providers::custom_openai::CustomOpenAIAdapter::new(),
        )),
        ProviderType::DeepSeek => Ok(Arc::new(aqbot_providers::deepseek::DeepSeekAdapter::new())),
        ProviderType::XAI => Ok(Arc::new(aqbot_providers::xai::XAIAdapter::new())),
        ProviderType::GLM => Ok(Arc::new(aqbot_providers::glm::GLMAdapter::new())),
        ProviderType::SiliconFlow => Ok(Arc::new(
            aqbot_providers::siliconflow::SiliconFlowAdapter::new(),
        )),
        ProviderType::Anthropic => {
            Ok(Arc::new(aqbot_providers::anthropic::AnthropicAdapter::new()))
        }
        ProviderType::Gemini => Ok(Arc::new(aqbot_providers::gemini::GeminiAdapter::new())),
        ProviderType::OpenAIResponses => Ok(Arc::new(
            aqbot_providers::openai_responses::OpenAIResponsesAdapter::new(),
        )),
        ProviderType::Jina | ProviderType::Cohere | ProviderType::Voyage => {
            Err("Rerank-only providers cannot be used as agent chat providers".to_string())
        }
    }
}

/// Truncate a string to a maximum byte length for DB preview fields.
fn truncate_preview(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}…", &s[..max_len.min(s.len())])
    }
}

/// Extract a short human-readable summary from tool input JSON for inline rendering.
fn get_tool_input_summary(tool_name: &str, input: &Value) -> String {
    let try_key = |key: &str| {
        input
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    if let Some(cmd) = try_key("command") {
        return cmd.chars().take(80).collect();
    }
    if let Some(path) = try_key("path").or_else(|| try_key("file_path")) {
        return path;
    }
    if let Some(pattern) = try_key("pattern") {
        return pattern.chars().take(80).collect();
    }
    if let Some(query) = try_key("query") {
        return query.chars().take(80).collect();
    }
    if let Some(content) = try_key("content") {
        return content.chars().take(60).collect();
    }
    // Fallback: first string value
    if let Some(obj) = input.as_object() {
        for val in obj.values() {
            if let Some(s) = val.as_str() {
                return s.chars().take(80).collect();
            }
        }
    }
    tool_name.to_string()
}

async fn resolve_agent_provider_id(
    db: &sea_orm::DatabaseConnection,
    provider_id: &str,
) -> Result<String, String> {
    provider::resolve_provider_id(db, provider_id)
        .await
        .map_err(|e| e.to_string())
}

fn build_agent_prompt_with_attachments(
    file_store: &aqbot_core::file_store::FileStore,
    prompt: &str,
    attachments: &[Attachment],
    settings: &AppSettings,
) -> aqbot_core::error::Result<String> {
    super::conversations::append_document_attachment_context(
        file_store,
        prompt,
        attachments,
        settings.document_attachment_reading_enabled,
        None,
    )
}

fn ensure_agent_prompt_safe_for_persistence(prompt: &str) -> Result<(), String> {
    if aqbot_core::inline_media::contains_inline_image_data(prompt) {
        return Err(
            "Agent prompt contains inline image data; attach the image as a file instead"
                .to_string(),
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn agent_query(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    prompt: String,
    provider_id: String,
    model_id: String,
    attachments: Option<Vec<AttachmentInput>>,
) -> Result<(), String> {
    // 1. Get agent session (must exist)
    let session =
        agent_session::get_agent_session_by_conversation_id(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Agent session not found. Please switch to Agent mode first.")?;

    ensure_agent_prompt_safe_for_persistence(&prompt)?;
    // 2. Atomically reserve this conversation before any persistence or SDK
    // initialization so concurrent queries cannot both pass a separate check.
    let run_id = aqbot_core::utils::gen_id();
    {
        let mut running = RUNNING_AGENTS.lock().unwrap();
        if running.contains_key(&conversation_id) {
            return Err("Agent is already running".to_string());
        }
        running.insert(conversation_id.clone(), run_id.clone());
    }
    let running_guard = RunningAgentGuard {
        conversation_id: conversation_id.clone(),
        run_id,
    };
    let cancel_token = open_agent_sdk::CancellationToken::new();
    state
        .agent_cancel_tokens
        .lock()
        .await
        .insert(conversation_id.clone(), cancel_token.clone());
    let cancel_guard = AgentCancelTokenGuard {
        conversation_id: conversation_id.clone(),
        tokens: state.agent_cancel_tokens.clone(),
    };

    let real_provider_id = resolve_agent_provider_id(&state.sea_db, &provider_id).await?;
    let pre_conv = conversation::get_conversation(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let is_first_message = pre_conv.message_count <= 1;
    let attachment_inputs = attachments.unwrap_or_default();
    let persisted_attachments =
        super::conversations::persist_attachments(&state, &conversation_id, &attachment_inputs)
            .await
            .map_err(|e| e.to_string())?;

    // 3. Save user message. The session is not marked running until every
    // fallible provider/SDK initialization step below has succeeded.
    let user_message = match message::create_message(
        &state.sea_db,
        &conversation_id,
        MessageRole::User,
        &prompt,
        &persisted_attachments,
        None,
        0,
    )
    .await
    {
        Ok(message) => message,
        Err(error) => {
            let cleanup_errors = super::conversations::cleanup_new_message_attachments(
                &state.sea_db,
                &persisted_attachments,
            )
            .await;
            return Err(format!(
                "Agent message creation failed: {error}; attachment rollback errors: {}",
                if cleanup_errors.is_empty() {
                    "none".to_string()
                } else {
                    cleanup_errors.join(", ")
                }
            ));
        }
    };

    if let Err(error) = conversation::increment_message_count(&state.sea_db, &conversation_id).await
    {
        let rollback_errors = super::conversations::rollback_new_message(
            &state.sea_db,
            &user_message.id,
            &user_message.attachments,
        )
        .await;
        return Err(super::conversations::format_new_message_failure(
            &user_message.id,
            "agent message-count update failed",
            error,
            rollback_errors,
        ));
    }

    // Auto-title: set fallback + async AI title for first message
    if is_first_message {
        let fallback_title =
            crate::commands::conversations::normalize_auto_conversation_title(&prompt);
        if let Err(e) = conversation::update_conversation_title(
            &state.sea_db,
            &conversation_id,
            &fallback_title,
        )
        .await
        {
            tracing::error!("[agent] Failed to set fallback title: {}", e);
        } else {
            let _ = app.emit(
                "conversation-title-updated",
                aqbot_core::types::ConversationTitleUpdatedEvent {
                    conversation_id: conversation_id.clone(),
                    title: fallback_title,
                },
            );
        }
    }

    // 5. Get provider + key
    let prov = provider::get_provider(&state.sea_db, &real_provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row = provider::get_active_key(&state.sea_db, &real_provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;
    let model_param_overrides = provider::get_model(&state.sea_db, &real_provider_id, &model_id)
        .await
        .ok()
        .and_then(|model| model.param_overrides);

    // 6. Build ProviderRequestContext
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let file_store = aqbot_core::file_store::FileStore::new();
    let agent_prompt = build_agent_prompt_with_attachments(
        &file_store,
        &prompt,
        &persisted_attachments,
        &global_settings,
    )
    .map_err(|e| e.to_string())?;
    let resolved_proxy = ProviderProxyConfig::resolve(&prov.proxy_config, &global_settings);
    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: prov.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &prov.api_host,
            &prov.provider_type,
        )),
        api_path: prov.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: prov
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    // 7. Create bridge
    let title_ctx = ctx.clone();
    let adapter = create_adapter_arc(&prov.provider_type)?;
    let provider_type_str = provider_type_to_registry_key(&prov.provider_type);
    let bridge = aqbot_agent::bridge::AQBotProviderBridge::new(adapter, ctx, provider_type_str)
        .map_err(|e| e.to_string())?
        .with_model_param_overrides(model_param_overrides)
        .with_app(app.clone(), conversation_id.clone());

    // 8. Build permission callback (CanUseToolFn)
    let permission_mode =
        aqbot_agent::permission::PermissionMode::from_str(&session.permission_mode);
    let cwd_for_check = session.cwd.clone().unwrap_or_default();
    let always_allowed_map = state.agent_always_allowed.clone();
    let conv_id_for_allowed = conversation_id.clone();
    let permission_senders = state.agent_permission_senders.clone();
    let app_for_perm = app.clone();
    let conv_id_for_perm = conversation_id.clone();
    let current_assistant_id_for_perm: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));
    let assistant_id_for_task = current_assistant_id_for_perm.clone();
    let db_for_perm = state.sea_db.clone();
    let cancel_token_for_perm = cancel_token.clone();

    let can_use_tool: CanUseToolFn = Arc::new(move |tool_name: &str, input: &Value| {
        let tool_name = tool_name.to_string();
        let input = input.clone();
        let cwd = cwd_for_check.clone();
        let always_allowed_map = always_allowed_map.clone();
        let conv_id = conv_id_for_perm.clone();
        let conv_id_allowed = conv_id_for_allowed.clone();
        let permission_senders = permission_senders.clone();
        let app = app_for_perm.clone();
        let assistant_id = current_assistant_id_for_perm.clone();
        let db = db_for_perm.clone();
        let cancel_token = cancel_token_for_perm.clone();

        Box::pin(async move {
            if cancel_token.is_cancelled() {
                return PermissionDecision::Deny("Agent cancelled".to_string());
            }

            // 1. CWD safety check (hard deny, skipped in FullAccess mode)
            if permission_mode != aqbot_agent::permission::PermissionMode::FullAccess
                && !cwd.is_empty()
            {
                if let Some(deny) = check_path_safety(&tool_name, &input, &cwd) {
                    return deny;
                }
            }

            // 2. Check conversation-level always_allowed cache
            {
                let map = always_allowed_map.lock().await;
                if let Some(set) = map.get(&conv_id_allowed) {
                    if set.contains(&tool_name) {
                        return PermissionDecision::Allow;
                    }
                }
            }

            // 3. Decision matrix
            let risk = classify_tool_risk(&tool_name);
            match decide_permission(permission_mode, risk, false) {
                PermissionAction::AutoAllow => PermissionDecision::Allow,
                PermissionAction::RequireApproval => {
                    // Create oneshot channel
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let perm_id = format!("perm_{}", aqbot_core::utils::gen_id());

                    // Store sender
                    permission_senders.lock().await.insert(perm_id.clone(), tx);

                    // Create a tool_execution record for the permission request
                    let input_str =
                        truncate_preview(&serde_json::to_string(&input).unwrap_or_default(), 500);
                    let exec_id = tool_execution::create_tool_execution(
                        &db,
                        &conv_id,
                        assistant_id.read().await.as_deref(),
                        "__agent_sdk__",
                        &tool_name,
                        Some(&input_str),
                        Some("pending"),
                    )
                    .await
                    .ok()
                    .map(|e| e.id);

                    // Emit permission request event
                    let risk_str = match risk {
                        aqbot_agent::permission::RiskLevel::ReadOnly => "read_only",
                        aqbot_agent::permission::RiskLevel::Write => "write",
                        aqbot_agent::permission::RiskLevel::Execute => "execute",
                    };
                    let _ = app.emit(
                        "agent-permission-request",
                        AgentPermissionRequestPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: assistant_id
                                .read()
                                .await
                                .clone()
                                .unwrap_or_default(),
                            tool_use_id: filter_complete_agent_event_text(&perm_id),
                            tool_name: filter_complete_agent_event_text(&tool_name),
                            input: filter_agent_event_json(&input),
                            risk_level: risk_str.to_string(),
                        },
                    );

                    // Wait for user response (raw decision string)
                    let final_decision = tokio::select! {
                        result = rx => match result {
                            Ok(decision_str) => match decision_str.as_str() {
                                "allow_once" => PermissionDecision::Allow,
                                "allow_always" => {
                                    always_allowed_map.lock().await
                                        .entry(conv_id_allowed.clone())
                                        .or_default()
                                        .insert(tool_name.clone());
                                    PermissionDecision::Allow
                                }
                                "deny" => PermissionDecision::Deny(
                                    "User denied permission".to_string(),
                                ),
                                other => PermissionDecision::Deny(
                                    format!("Unknown decision: {}", other),
                                ),
                            },
                            Err(_) => {
                                PermissionDecision::Deny("Permission request cancelled".to_string())
                            }
                        },
                        _ = cancel_token.cancelled() => {
                            permission_senders.lock().await.remove(&perm_id);
                            PermissionDecision::Deny("Agent cancelled".to_string())
                        }
                    };

                    // Persist approval decision to DB
                    if let Some(eid) = &exec_id {
                        let status = match &final_decision {
                            PermissionDecision::Allow
                            | PermissionDecision::AllowWithModifiedInput(_) => "approved",
                            PermissionDecision::Deny(_) => "denied",
                        };
                        let _ =
                            tool_execution::update_tool_execution_approval_status(&db, eid, status)
                                .await;
                    }

                    final_decision
                }
                PermissionAction::HardDeny => {
                    PermissionDecision::Deny("Operation not permitted".to_string())
                }
            }
        })
    });

    // 9. Build AgentOptions with our custom provider + permission callback
    let conv = conversation::get_conversation(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    // Load enabled skills, build context summary, and create SkillTool
    let home = dirs::home_dir().unwrap_or_default();
    let all_skills = open_agent_sdk::skills::load_all_global(&home);
    let disabled = aqbot_core::repo::skill::get_disabled_skills(&state.sea_db)
        .await
        .unwrap_or_default();
    let mut registry = open_agent_sdk::skills::SkillRegistry::new();
    for skill in all_skills {
        registry.register(skill);
    }
    registry.set_disabled(disabled);
    let skills_summary = {
        let summary = registry.generate_context_summary();
        if summary.is_empty() {
            None
        } else {
            Some(summary)
        }
    };
    let skill_registry = Arc::new(tokio::sync::RwLock::new(registry));
    let skill_tool: Arc<dyn open_agent_sdk::types::Tool> = Arc::new(
        open_agent_sdk::tools::skill_tool::SkillTool::new(skill_registry),
    );

    // Build ask_fn for AskUserQuestion tool
    let ask_senders = state.agent_ask_senders.clone();
    let app_for_ask = app.clone();
    let conv_id_for_ask = conversation_id.clone();
    let assistant_id_for_ask = assistant_id_for_task.clone();
    let cancel_token_for_ask = cancel_token.clone();

    let ask_fn: open_agent_sdk::tools::askuser::AskUserFn = Arc::new(
        move |request: open_agent_sdk::tools::askuser::AskUserRequest| {
            let question = request.question;
            let options = request.options;
            let ask_senders = ask_senders.clone();
            let app = app_for_ask.clone();
            let conv_id = conv_id_for_ask.clone();
            let assistant_id = assistant_id_for_ask.clone();
            let cancel_token = cancel_token_for_ask.clone();
            Box::pin(async move {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let ask_id = format!("ask_{}", aqbot_core::utils::gen_id());

                ask_senders.lock().await.insert(ask_id.clone(), tx);

                let _ = app.emit(
                    "agent-ask-user",
                    AgentAskUserPayload {
                        conversation_id: conv_id,
                        assistant_message_id: assistant_id.read().await.clone().unwrap_or_default(),
                        ask_id: ask_id.clone(),
                        question: filter_complete_agent_event_text(&question),
                        options: options.map(|values| {
                            values
                                .into_iter()
                                .map(|value| filter_complete_agent_event_text(&value))
                                .collect()
                        }),
                    },
                );

                tokio::select! {
                    result = rx => result.map_err(|_| "Ask user channel closed".to_string()),
                    _ = cancel_token.cancelled() => {
                        ask_senders.lock().await.remove(&ask_id);
                        Err("Agent cancelled".to_string())
                    }
                }
            })
        },
    );

    let agent_options = AgentOptions {
        model: Some(model_id.clone()),
        provider: Some(Arc::new(bridge)),
        cwd: session.cwd.clone(),
        system_prompt: conv.system_prompt.clone(),
        skills_summary,
        ask_fn: Some(ask_fn),
        can_use_tool: Some(can_use_tool),
        custom_tools: vec![skill_tool],
        abort_signal: Some(cancel_token.clone()),
        shell_binary: global_settings.agent_bash_path.clone(),
        ..Default::default()
    };

    let mut agent = Agent::new(agent_options).await.map_err(|e| e.to_string())?;

    // Restore previous conversation context from the agent session
    if let Some(ref ctx_json) = session.sdk_context_json {
        match serde_json::from_str::<Vec<open_agent_sdk::Message>>(ctx_json) {
            Ok(prev_messages) => {
                tracing::info!(
                    "[agent] Restored {} messages from previous session",
                    prev_messages.len()
                );
                agent.messages = prev_messages;
            }
            Err(e) => {
                tracing::warn!("[agent] Failed to deserialize sdk_context_json: {}", e);
            }
        }
    }

    tracing::info!(
        "[agent] Agent created for conversation {}, model {}",
        conversation_id,
        model_id
    );

    // 10. All fallible initialization is complete. Mark the persisted and
    // in-memory runtime state immediately before spawning the background task.
    if cancel_token.is_cancelled() {
        return Err("Agent cancelled during initialization".to_string());
    }
    agent_session::update_agent_session_status(&state.sea_db, &session.id, "running")
        .await
        .map_err(|e| e.to_string())?;

    let db = state.sea_db.clone();
    let session_id = session.id.clone();
    let conv_id = conversation_id.clone();
    let user_msg_id = user_message.id.clone();
    let master_key = state.master_key;
    let title_prov = prov.clone();
    let title_model_id = model_id.clone();
    let title_settings = global_settings.clone();
    let title_prompt = prompt.clone();

    tokio::spawn(async move {
        // RAII guard: ensures conv_id is removed from RUNNING_AGENTS on exit (even panic)
        let _running_guard = running_guard;
        let _cancel_guard = cancel_guard;

        tracing::info!(
            "[agent] Background task started for conversation {}",
            conv_id
        );
        let (mut rx, handle) = agent.query(&agent_prompt).await;

        let mut result_text = String::new();
        let mut final_usage: Option<Usage> = None;
        let mut num_turns = 0u32;
        let mut cost_usd = 0.0f64;
        let mut sdk_messages: Option<Vec<open_agent_sdk::Message>> = None;
        let mut current_assistant_msg_id: Option<String> = None;
        let mut accumulated_text = String::new();
        let mut in_thinking_block = false;
        let mut has_streamed_deltas = false;
        let mut has_agent_content = false;
        let mut got_result_or_error = false;
        let mut text_ipc_filter = InlineDataStreamFilter::default();
        let mut thinking_ipc_filter = InlineDataStreamFilter::default();
        let mut inline_data_capture = InlineDataStreamCapture::default();
        let mut inline_capture_error: Option<String> = None;
        // Map SDK tool_use_id → DB tool_execution.id
        let mut tool_exec_map: HashMap<String, String> = HashMap::new();

        macro_rules! append_captured {
            ($label:lifetime, $text:expr) => {
                if let Err(error) = append_captured_agent_text(
                    &mut inline_data_capture,
                    &mut accumulated_text,
                    $text,
                ) {
                    inline_capture_error = Some(error.to_string());
                    break $label;
                }
            };
        }

        'agent_messages: while let Some(msg) = rx.recv().await {
            match msg {
                SDKMessage::Assistant { message: msg, .. } => {
                    // Ordered processing: collect text/thinking in order,
                    // collect tool_use blocks for processing after message creation.
                    let mut pending_tool_uses: Vec<(String, String, Value)> = Vec::new();

                    if !has_streamed_deltas {
                        // Process content blocks in order to preserve interleaving
                        for block in &msg.content {
                            match block {
                                ContentBlock::Thinking { thinking, .. } => {
                                    if !in_thinking_block {
                                        if !accumulated_text.is_empty() {
                                            append_captured!('agent_messages, "\n\n");
                                        }
                                        append_captured!('agent_messages, "<think data-aqbot=\"1\">\n");
                                        in_thinking_block = true;
                                    }
                                    append_captured!('agent_messages, thinking);
                                    has_agent_content = true;

                                    if let Some(thinking) = filtered_agent_stream_chunk(
                                        &mut thinking_ipc_filter,
                                        thinking,
                                    ) {
                                        let _ = app.emit(
                                            "agent-stream-thinking",
                                            AgentThinkingPayload {
                                                conversation_id: conv_id.clone(),
                                                assistant_message_id: current_assistant_msg_id
                                                    .clone()
                                                    .unwrap_or_default(),
                                                thinking,
                                            },
                                        );
                                    }
                                }
                                ContentBlock::Text { text } => {
                                    if in_thinking_block {
                                        append_captured!('agent_messages, "\n</think>\n\n");
                                        in_thinking_block = false;
                                    }
                                    append_captured!('agent_messages, text);
                                    has_agent_content = true;

                                    if let Some(text) =
                                        filtered_agent_stream_chunk(&mut text_ipc_filter, text)
                                    {
                                        let _ = app.emit(
                                            "agent-stream-text",
                                            AgentTextPayload {
                                                conversation_id: conv_id.clone(),
                                                assistant_message_id: current_assistant_msg_id
                                                    .clone()
                                                    .unwrap_or_default(),
                                                text,
                                            },
                                        );
                                    }
                                }
                                ContentBlock::ToolUse { id, name, input } => {
                                    pending_tool_uses.push((
                                        id.clone(),
                                        name.clone(),
                                        input.clone(),
                                    ));
                                }
                                _ => {}
                            }
                        }
                    } else {
                        // Deltas already streamed text/thinking; only collect tool_use blocks
                        for block in &msg.content {
                            if let ContentBlock::ToolUse { id, name, input } = block {
                                pending_tool_uses.push((id.clone(), name.clone(), input.clone()));
                            }
                        }
                    }
                    // Reset delta flag for next turn
                    has_streamed_deltas = false;

                    // Create or update assistant message BEFORE processing tool events
                    if current_assistant_msg_id.is_none() {
                        let _ = ensure_agent_assistant_message(
                            &db,
                            &app,
                            &conv_id,
                            &user_msg_id,
                            &accumulated_text,
                            &mut current_assistant_msg_id,
                            &assistant_id_for_task,
                        )
                        .await;
                    } else if let Some(ref mid) = current_assistant_msg_id {
                        persist_agent_stream_snapshot(&db, mid, &accumulated_text).await;
                    }

                    // Process tool_use blocks: create DB records, insert inline markers
                    if !pending_tool_uses.is_empty() {
                        // Close any open thinking block before tool markers
                        if in_thinking_block {
                            append_captured!('agent_messages, "\n</think>\n\n");
                            in_thinking_block = false;
                        }

                        for (sdk_id, name, input) in &pending_tool_uses {
                            let (safe_sdk_id, safe_name) =
                                filter_agent_tool_identity(sdk_id, name);
                            tracing::info!(
                                "[agent] ToolUse in assistant message: {} ({}), assistantMsgId={:?}",
                                safe_name, safe_sdk_id, current_assistant_msg_id
                            );

                            // Create tool_execution record in DB
                            let input_str = truncate_preview(
                                &serde_json::to_string(input).unwrap_or_default(),
                                500,
                            );
                            let exec_id = if let Ok(exec) = tool_execution::create_tool_execution(
                                &db,
                                &conv_id,
                                current_assistant_msg_id.as_deref(),
                                "__agent_sdk__",
                                &name,
                                Some(&input_str),
                                None,
                            )
                            .await
                            {
                                let eid = exec.id.clone();
                                tool_exec_map.insert(sdk_id.clone(), eid.clone());
                                Some(eid)
                            } else {
                                None
                            };

                            // Build inline <tool-call> marker with DB execution ID
                            let summary = filter_complete_agent_event_text(
                                &get_tool_input_summary(name, input),
                            );
                            let tag_id = exec_id.as_deref().unwrap_or(&safe_sdk_id);
                            let marker = format!(
                                "\n\n<tool-call data-aqbot=\"1\" id=\"{}\" name=\"{}\">{}</tool-call>\n\n",
                                tag_id, safe_name, summary
                            );
                            append_captured!('agent_messages, &marker);

                            // Emit agent-stream-text so frontend content updates in real-time
                            if let Some(marker) =
                                filtered_agent_stream_chunk(&mut text_ipc_filter, &marker)
                            {
                                let _ = app.emit(
                                    "agent-stream-text",
                                    AgentTextPayload {
                                        conversation_id: conv_id.clone(),
                                        assistant_message_id: current_assistant_msg_id
                                            .clone()
                                            .unwrap_or_default(),
                                        text: marker,
                                    },
                                );
                            }

                            // Emit agent-tool-use event for agentStore
                            let _ = app.emit(
                                "agent-tool-use",
                                AgentToolUsePayload {
                                    conversation_id: conv_id.clone(),
                                    assistant_message_id: current_assistant_msg_id
                                        .clone()
                                        .unwrap_or_default(),
                                    tool_use_id: safe_sdk_id,
                                    tool_name: safe_name,
                                    input: filter_agent_event_json(input),
                                    execution_id: exec_id,
                                },
                            );
                        }

                        // Update message content with tool-call markers
                        if let Some(ref mid) = current_assistant_msg_id {
                            persist_agent_stream_snapshot(&db, mid, &accumulated_text).await;
                        }
                    }
                }
                SDKMessage::ToolStart {
                    tool_use_id,
                    tool_name,
                    input,
                } => {
                    tracing::info!("[agent] ToolStart: {} ({})", tool_name, tool_use_id);
                    let (safe_tool_use_id, safe_tool_name) =
                        filter_agent_tool_identity(&tool_use_id, &tool_name);
                    // Emit agent-tool-start
                    let _ = app.emit(
                        "agent-tool-start",
                        AgentToolStartPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id
                                .clone()
                                .unwrap_or_default(),
                            tool_use_id: safe_tool_use_id,
                            tool_name: safe_tool_name,
                            input: filter_agent_event_json(&input),
                        },
                    );

                    // Update tool_execution status to 'running'
                    if let Some(exec_id) = tool_exec_map.get(&tool_use_id) {
                        let _ = tool_execution::update_tool_execution_status(
                            &db, exec_id, "running", None, None,
                        )
                        .await;
                    }
                }
                SDKMessage::ToolResult {
                    tool_use_id,
                    tool_name,
                    content,
                    is_error,
                } => {
                    let (safe_tool_use_id, safe_tool_name) =
                        filter_agent_tool_identity(&tool_use_id, &tool_name);
                    // Emit agent-tool-result
                    let _ = app.emit(
                        "agent-tool-result",
                        AgentToolResultPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id
                                .clone()
                                .unwrap_or_default(),
                            tool_use_id: safe_tool_use_id,
                            tool_name: safe_tool_name,
                            content: filter_complete_agent_event_text(&content),
                            is_error,
                        },
                    );

                    // Update tool_execution status + output
                    if let Some(exec_id) = tool_exec_map.get(&tool_use_id) {
                        let status = if is_error { "failed" } else { "success" };
                        let output_preview = truncate_preview(&content, 500);
                        let error_msg = if is_error {
                            Some(content.as_str())
                        } else {
                            None
                        };
                        let _ = tool_execution::update_tool_execution_status(
                            &db,
                            exec_id,
                            status,
                            Some(&output_preview),
                            error_msg,
                        )
                        .await;
                    }
                }
                SDKMessage::PermissionRequest {
                    tool_use_id,
                    tool_name,
                    input,
                    ..
                } => {
                    let (safe_tool_use_id, safe_tool_name) =
                        filter_agent_tool_identity(&tool_use_id, &tool_name);
                    // Emit agent-permission-request
                    let _ = app.emit(
                        "agent-permission-request",
                        AgentPermissionRequestPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id
                                .clone()
                                .unwrap_or_default(),
                            tool_use_id: safe_tool_use_id,
                            tool_name: safe_tool_name,
                            input: filter_agent_event_json(&input),
                            risk_level: "execute".to_string(),
                        },
                    );

                    // Update tool_execution approval_status to 'pending'
                    if let Some(exec_id) = tool_exec_map.get(&tool_use_id) {
                        let _ = tool_execution::update_tool_execution_approval_status(
                            &db, exec_id, "pending",
                        )
                        .await;
                    }
                }
                SDKMessage::Status {
                    message: status_msg,
                }
                | SDKMessage::Progress {
                    message: status_msg,
                } => {
                    let _ = app.emit(
                        "agent-status",
                        AgentStatusPayload {
                            conversation_id: conv_id.clone(),
                            message: filter_complete_agent_event_text(&status_msg),
                        },
                    );
                }
                SDKMessage::RateLimit {
                    retry_after_ms,
                    message: limit_msg,
                } => {
                    let _ = app.emit(
                        "agent-rate-limit",
                        AgentRateLimitPayload {
                            conversation_id: conv_id.clone(),
                            retry_after_ms,
                            message: filter_complete_agent_event_text(&limit_msg),
                        },
                    );
                }
                SDKMessage::Result {
                    text,
                    usage,
                    num_turns: t,
                    cost_usd: c,
                    messages,
                    ..
                } => {
                    tracing::info!("[agent] Result: {} turns, cost ${:.4}", t, c);
                    got_result_or_error = true;
                    result_text = filter_complete_agent_event_text(&text);
                    if !has_agent_content && !text.is_empty() {
                        append_captured!('agent_messages, &text);
                        has_agent_content = true;
                    }
                    final_usage = Some(usage);
                    num_turns = t;
                    cost_usd = c;
                    sdk_messages = Some(messages);
                }
                SDKMessage::Error { message: err_msg } => {
                    tracing::error!("[agent] Error: {}", err_msg);
                    flush_agent_stream_filters(
                        &app,
                        &conv_id,
                        current_assistant_msg_id.as_deref(),
                        &mut text_ipc_filter,
                        &mut thinking_ipc_filter,
                    );
                    let _ = app.emit(
                        "agent-error",
                        AgentErrorPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id.clone(),
                            message: filter_complete_agent_event_text(&err_msg),
                        },
                    );
                    if let Some(message_id) = current_assistant_msg_id.as_deref() {
                        let failed_content =
                            aqbot_core::inline_media::replace_pending_inline_media_tokens(
                                &accumulated_text,
                                "[图片接收失败]",
                            );
                        persist_agent_stream_snapshot(&db, message_id, &failed_content).await;
                        let _ = message::update_message_status(&db, message_id, "error").await;
                    }
                    let _ =
                        agent_session::update_agent_session_status(&db, &session_id, "idle").await;
                    return;
                }
                SDKMessage::ThinkingDelta { thinking } => {
                    // Real-time thinking token from API stream
                    has_streamed_deltas = true;
                    if !in_thinking_block {
                        if !accumulated_text.is_empty() {
                            append_captured!('agent_messages, "\n\n");
                        }
                        append_captured!('agent_messages, "<think data-aqbot=\"1\">\n");
                        in_thinking_block = true;
                    }
                    append_captured!('agent_messages, &thinking);
                    has_agent_content = true;
                    let assistant_message_id = persist_agent_partial_content(
                        &db,
                        &app,
                        &conv_id,
                        &user_msg_id,
                        &accumulated_text,
                        &mut current_assistant_msg_id,
                        &assistant_id_for_task,
                    )
                    .await
                    .unwrap_or_default();

                    if let Some(thinking) =
                        filtered_agent_stream_chunk(&mut thinking_ipc_filter, &thinking)
                    {
                        let _ = app.emit(
                            "agent-stream-thinking",
                            AgentThinkingPayload {
                                conversation_id: conv_id.clone(),
                                assistant_message_id,
                                thinking,
                            },
                        );
                    }
                }
                SDKMessage::TextDelta { text } => {
                    // Real-time text token from API stream
                    has_streamed_deltas = true;
                    if in_thinking_block {
                        append_captured!('agent_messages, "\n</think>\n\n");
                        in_thinking_block = false;
                    }
                    append_captured!('agent_messages, &text);
                    has_agent_content = true;
                    let assistant_message_id = persist_agent_partial_content(
                        &db,
                        &app,
                        &conv_id,
                        &user_msg_id,
                        &accumulated_text,
                        &mut current_assistant_msg_id,
                        &assistant_id_for_task,
                    )
                    .await
                    .unwrap_or_default();

                    if let Some(text) = filtered_agent_stream_chunk(&mut text_ipc_filter, &text) {
                        let _ = app.emit(
                            "agent-stream-text",
                            AgentTextPayload {
                                conversation_id: conv_id.clone(),
                                assistant_message_id,
                                text,
                            },
                        );
                    }
                }
                _ => {
                    tracing::debug!("[agent] unhandled SDKMessage: {:?}", msg);
                }
            }
        }

        // Bug 4: panic protection — check if inner task panicked
        match handle.await {
            Ok(()) => {}
            Err(join_err) => {
                tracing::error!("[agent] Agent inner task failed: {}", join_err);
                if !got_result_or_error {
                    flush_agent_stream_filters(
                        &app,
                        &conv_id,
                        current_assistant_msg_id.as_deref(),
                        &mut text_ipc_filter,
                        &mut thinking_ipc_filter,
                    );
                    let _ = app.emit(
                        "agent-error",
                        AgentErrorPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id.clone(),
                            message: "Agent task crashed unexpectedly".to_string(),
                        },
                    );
                    let _ =
                        agent_session::update_agent_session_status(&db, &session_id, "idle").await;
                    return;
                }
            }
        }

        if let Some(error) = inline_capture_error {
            let failed_content = aqbot_core::inline_media::replace_pending_inline_media_tokens(
                &accumulated_text,
                "[图片接收失败]",
            );
            if let Some(message_id) = current_assistant_msg_id.as_deref() {
                persist_agent_stream_snapshot(&db, message_id, &failed_content).await;
                let _ = message::update_message_status(&db, message_id, "error").await;
            }
            let _ = app.emit(
                "agent-error",
                AgentErrorPayload {
                    conversation_id: conv_id.clone(),
                    assistant_message_id: current_assistant_msg_id.clone(),
                    message: format!("Failed to stage generated image: {error}"),
                },
            );
            let _ = agent_session::update_agent_session_status(&db, &session_id, "idle").await;
            return;
        }

        // If channel closed without Result or Error, emit a fallback error
        if !got_result_or_error {
            tracing::error!("[agent] Channel closed without Result or Error");
            flush_agent_stream_filters(
                &app,
                &conv_id,
                current_assistant_msg_id.as_deref(),
                &mut text_ipc_filter,
                &mut thinking_ipc_filter,
            );
            let _ = app.emit(
                "agent-error",
                AgentErrorPayload {
                    conversation_id: conv_id.clone(),
                    assistant_message_id: current_assistant_msg_id.clone(),
                    message: "Agent ended unexpectedly without producing a result".to_string(),
                },
            );
            let _ = agent_session::update_agent_session_status(&db, &session_id, "idle").await;
            return;
        }

        flush_agent_stream_filters(
            &app,
            &conv_id,
            current_assistant_msg_id.as_deref(),
            &mut text_ipc_filter,
            &mut thinking_ipc_filter,
        );

        let mut final_media_error: Option<String> = None;
        if in_thinking_block {
            if let Err(error) = append_captured_agent_text(
                &mut inline_data_capture,
                &mut accumulated_text,
                "\n</think>\n\n",
            ) {
                final_media_error = Some(format!(
                    "Failed to stage generated image for message {}: {error}",
                    current_assistant_msg_id.as_deref().unwrap_or("unknown")
                ));
            }
        }
        let streamed_inline_images = if final_media_error.is_none() {
            match inline_data_capture.finish() {
                Ok(trailing) => {
                    accumulated_text.push_str(&trailing.content);
                    inline_data_capture.take_images()
                }
                Err(error) => {
                    final_media_error = Some(format!(
                        "Failed to finish generated image for message {}: {error}",
                        current_assistant_msg_id.as_deref().unwrap_or("unknown")
                    ));
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        if final_media_error.is_some() {
            accumulated_text = aqbot_core::inline_media::replace_pending_inline_media_tokens(
                &accumulated_text,
                "[图片接收失败]",
            );
        }
        let final_content = accumulated_text.clone();
        let mut final_event_content = filter_complete_agent_event_text(&final_content);

        // Update assistant message with final content (including <think> blocks)
        if !final_content.is_empty() {
            if let Some(ref mid) = current_assistant_msg_id {
                let file_store = aqbot_core::file_store::FileStore::new();
                let media_result = if streamed_inline_images.is_empty() {
                    aqbot_core::inline_media::materialize_message_inline_images(
                        &db,
                        &file_store,
                        mid,
                        &final_content,
                    )
                    .await
                } else {
                    aqbot_core::inline_media::materialize_streamed_inline_images(
                        &db,
                        &file_store,
                        mid,
                        &final_content,
                        &streamed_inline_images,
                    )
                    .await
                };
                match media_result {
                    Ok(message) => final_event_content = message.content,
                    Err(error) => {
                        final_media_error = Some(format!(
                            "Failed to store generated image for message {mid}: {error}"
                        ));
                        tracing::error!(
                            message_id = %mid,
                            error = %error,
                            "Failed to materialize final agent inline media"
                        );
                    }
                }
            } else {
                // No assistant message was created during streaming — create one now
                match message::create_message(
                    &db,
                    &conv_id,
                    MessageRole::Assistant,
                    agent_persistable_snapshot(&final_content),
                    &[],
                    Some(&user_msg_id),
                    0,
                )
                .await
                {
                    Ok(assist_msg) => {
                        current_assistant_msg_id = Some(assist_msg.id.clone());
                        let file_store = aqbot_core::file_store::FileStore::new();
                        let media_result = if streamed_inline_images.is_empty() {
                            aqbot_core::inline_media::materialize_message_inline_images(
                                &db,
                                &file_store,
                                &assist_msg.id,
                                &final_content,
                            )
                            .await
                        } else {
                            aqbot_core::inline_media::materialize_streamed_inline_images(
                                &db,
                                &file_store,
                                &assist_msg.id,
                                &final_content,
                                &streamed_inline_images,
                            )
                            .await
                        };
                        match media_result {
                            Ok(message) => final_event_content = message.content,
                            Err(error) => {
                                final_media_error = Some(format!(
                                    "Failed to store generated image for message {}: {error}",
                                    assist_msg.id
                                ));
                                tracing::error!(
                                    message_id = %assist_msg.id,
                                    error = %error,
                                    "Failed to materialize final agent inline media"
                                );
                            }
                        }
                        let _ = conversation::increment_message_count(&db, &conv_id).await;
                    }
                    Err(error) => {
                        final_media_error =
                            Some(format!("Failed to create final agent message: {error}"));
                        tracing::error!(
                            error = %error,
                            "Failed to create final agent message"
                        );
                    }
                }
            }
        }

        if final_media_error.is_some() {
            if let Some(message_id) = current_assistant_msg_id.as_deref() {
                if let Err(error) = message::update_message_status(&db, message_id, "error").await {
                    tracing::error!(
                        message_id,
                        error = %error,
                        "Failed to mark agent message after media persistence error"
                    );
                }
            }
        }

        let usage_payload = final_usage.as_ref().map(|u| AgentUsagePayload {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
        });

        // Persist token usage on the assistant message so the standard footer renders it
        if let (Some(ref mid), Some(ref usage)) = (&current_assistant_msg_id, &final_usage) {
            let _ = message::update_message_usage(
                &db,
                mid,
                Some(usage.input_tokens as i64),
                Some(usage.output_tokens as i64),
            )
            .await;
        }

        if let Some(error) = final_media_error {
            let _ = app.emit(
                "agent-error",
                AgentErrorPayload {
                    conversation_id: conv_id.clone(),
                    assistant_message_id: current_assistant_msg_id.clone(),
                    message: filter_complete_agent_event_text(&error),
                },
            );
        } else {
            let _ = app.emit(
                "agent-done",
                AgentDonePayload {
                    conversation_id: conv_id.clone(),
                    assistant_message_id: current_assistant_msg_id.clone().unwrap_or_default(),
                    text: final_event_content,
                    usage: usage_payload,
                    num_turns: Some(num_turns),
                    cost_usd: Some(cost_usd),
                },
            );
        }

        // Auto-title: generate AI title after agent completes (first message only)
        if is_first_message {
            let _ = app.emit(
                "conversation-title-generating",
                aqbot_core::types::ConversationTitleGeneratingEvent {
                    conversation_id: conv_id.clone(),
                    generating: true,
                    error: None,
                },
            );

            let ai_title = crate::commands::conversations::generate_ai_title(
                &db,
                &title_prompt,
                &result_text,
                &title_prov,
                &title_ctx,
                &title_model_id,
                &title_settings,
                &master_key,
            )
            .await;

            match ai_title {
                Ok(title) => {
                    if let Err(e) =
                        conversation::update_conversation_title(&db, &conv_id, &title).await
                    {
                        tracing::error!("[agent] Failed to update AI title: {}", e);
                        let _ = app.emit(
                            "conversation-title-generating",
                            aqbot_core::types::ConversationTitleGeneratingEvent {
                                conversation_id: conv_id.clone(),
                                generating: false,
                                error: Some(format!("Failed to save title: {}", e)),
                            },
                        );
                    } else {
                        let _ = app.emit(
                            "conversation-title-updated",
                            aqbot_core::types::ConversationTitleUpdatedEvent {
                                conversation_id: conv_id.clone(),
                                title,
                            },
                        );
                        let _ = app.emit(
                            "conversation-title-generating",
                            aqbot_core::types::ConversationTitleGeneratingEvent {
                                conversation_id: conv_id.clone(),
                                generating: false,
                                error: None,
                            },
                        );
                    }
                }
                Err(err) => {
                    tracing::warn!("[agent] Auto title generation failed: {}", err);
                    let _ = app.emit(
                        "conversation-title-generating",
                        aqbot_core::types::ConversationTitleGeneratingEvent {
                            conversation_id: conv_id.clone(),
                            generating: false,
                            error: Some(err),
                        },
                    );
                }
            }
        }

        // Update session
        let tokens_delta = final_usage
            .as_ref()
            .map(|u| (u.input_tokens + u.output_tokens) as i32)
            .unwrap_or(0);
        // Serialize SDK messages context for future resume
        let sdk_context = sdk_messages
            .as_ref()
            .and_then(|msgs| serde_json::to_string(msgs).ok());
        if let Err(e) = agent_session::update_agent_session_after_query(
            &db,
            &session_id,
            "idle",
            sdk_context.as_deref(),
            tokens_delta,
            cost_usd,
        )
        .await
        {
            tracing::error!("[agent] Failed to update session after query: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn agent_approve(
    state: State<'_, AppState>,
    _conversation_id: String,
    tool_use_id: String,
    decision: String,
) -> Result<(), String> {
    if !["allow_once", "allow_always", "deny"].contains(&decision.as_str()) {
        return Err(format!("Invalid decision: {}", decision));
    }

    // Look up the stored oneshot sender for this tool_use_id
    let sender = state
        .agent_permission_senders
        .lock()
        .await
        .remove(&tool_use_id);

    match sender {
        Some(tx) => {
            tx.send(decision)
                .map_err(|_| "Permission channel closed".to_string())?;
            Ok(())
        }
        None => Err(format!(
            "No pending permission request for tool_use_id: {}",
            tool_use_id
        )),
    }
}

#[tauri::command]
pub async fn agent_respond_ask(
    state: State<'_, AppState>,
    ask_id: String,
    answer: String,
) -> Result<(), String> {
    let sender = state.agent_ask_senders.lock().await.remove(&ask_id);

    match sender {
        Some(tx) => {
            tx.send(answer)
                .map_err(|_| "Ask user channel closed".to_string())?;
            Ok(())
        }
        None => Err(format!("No pending ask request for ask_id: {}", ask_id)),
    }
}

#[tauri::command]
pub async fn agent_cancel(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    let session =
        agent_session::get_agent_session_by_conversation_id(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Agent session not found")?;

    // Reset DB status to idle
    agent_session::update_agent_session_status(&state.sea_db, &session.id, "idle")
        .await
        .map_err(|e| e.to_string())?;

    if let Some(token) = state
        .agent_cancel_tokens
        .lock()
        .await
        .remove(&conversation_id)
    {
        token.cancel();
    }

    // Remove from in-memory running set
    if let Ok(mut running) = RUNNING_AGENTS.lock() {
        running.remove(&conversation_id);
    }

    Ok(())
}

#[tauri::command]
pub async fn agent_update_session(
    state: State<'_, AppState>,
    conversation_id: String,
    cwd: Option<String>,
    permission_mode: Option<String>,
) -> Result<AgentSession, String> {
    let session = agent_session::upsert_agent_session(
        &state.sea_db,
        &conversation_id,
        cwd.as_deref(),
        permission_mode.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(agent_session_for_ipc(session))
}

#[tauri::command]
pub async fn agent_get_session(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<AgentSession>, String> {
    let session = agent_session::get_agent_session_by_conversation_id(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(session.map(agent_session_for_ipc))
}

fn agent_session_for_ipc(mut session: AgentSession) -> AgentSession {
    // SDK context is backend resume state and may contain full tool/image
    // payloads. It is never required by the renderer.
    session.sdk_context_json = None;
    session.sdk_context_backup_json = None;
    session
}

/// Create default workspace directory under config home and return its path.
#[tauri::command]
pub async fn agent_ensure_workspace(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<String, String> {
    let mut settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    settings.agent_workspace_root =
        aqbot_core::path_vars::decode_path_opt(&settings.agent_workspace_root);

    let conv = conversation::get_conversation(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    let workspace_dir = resolve_agent_workspace_dir(&settings, &conv);
    std::fs::create_dir_all(&workspace_dir)
        .map_err(|e| format!("Failed to create workspace: {}", e))?;
    workspace_dir
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path encoding".to_string())
}

/// Backup and clear SDK context when a context-clear marker is inserted.
#[tauri::command]
pub async fn agent_backup_and_clear_sdk_context(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    agent_session::backup_and_clear_sdk_context_by_conversation_id(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

/// Restore SDK context from backup when a context-clear marker is removed.
#[tauri::command]
pub async fn agent_restore_sdk_context_from_backup(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    agent_session::restore_sdk_context_from_backup_by_conversation_id(
        &state.sea_db,
        &conversation_id,
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Cursor, Write};

    #[test]
    fn complete_agent_events_never_include_inline_image_payloads() {
        let filtered = filter_complete_agent_event_text(
            "before <img src=\"data:image/png;base64,iVBORw0KGgo=\"> after",
        );

        assert_eq!(filtered, "before <img src=\"[图片接收中]\"> after");
        assert!(!filtered.contains("data:image"));
        assert!(!filtered.contains("iVBOR"));
    }

    #[test]
    fn agent_prompt_rejects_inline_data_before_persistence_without_echoing_payload() {
        let error = ensure_agent_prompt_safe_for_persistence(
            "before data:image/png;base64,PROMPT_SECRET after",
        )
        .unwrap_err();

        assert!(error.contains("attach the image as a file"));
        assert!(!error.contains("PROMPT_SECRET"));
    }

    #[test]
    fn nested_agent_event_json_is_sanitized() {
        let input = serde_json::json!({
            "image": "data:image/png;base64,iVBORw0KGgo=",
            "key-data:image/png;base64,KEY": "safe",
            "nested": ["safe", "data:image/gif;base64,R0lGODlh"]
        });

        let filtered = filter_agent_event_json(&input).to_string();

        assert!(!filtered.contains("data:image"));
        assert!(!filtered.contains("iVBOR"));
        assert!(!filtered.contains("R0lGODlh"));
        assert!(!filtered.contains("KEY"));
    }

    #[test]
    fn agent_tool_event_identity_fields_are_safe_when_serialized() {
        let (tool_use_id, tool_name) = filter_agent_tool_identity(
            "call-data:image/png;base64,ID",
            "tool-data:image/png;base64,NAME",
        );
        let payloads = [
            serde_json::to_string(&AgentToolStartPayload {
                conversation_id: "conversation".to_string(),
                assistant_message_id: "message".to_string(),
                tool_use_id: tool_use_id.clone(),
                tool_name: tool_name.clone(),
                input: filter_agent_event_json(
                    &serde_json::json!({"data:image/png;base64,KEY": "safe"}),
                ),
            })
            .unwrap(),
            serde_json::to_string(&AgentToolResultPayload {
                conversation_id: "conversation".to_string(),
                assistant_message_id: "message".to_string(),
                tool_use_id,
                tool_name,
                content: filter_complete_agent_event_text("data:image/png;base64,CONTENT"),
                is_error: false,
            })
            .unwrap(),
        ];

        for payload in payloads {
            assert!(!payload.contains("data:image"));
            assert!(!payload.contains("base64"));
        }
    }

    fn test_conversation(id: &str, created_at: i64) -> aqbot_core::types::Conversation {
        aqbot_core::types::Conversation {
            id: id.to_string(),
            title: "Agent test".to_string(),
            model_id: "model".to_string(),
            provider_id: "provider".to_string(),
            system_prompt: None,
            temperature: None,
            max_tokens: None,
            top_p: None,
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
            mode: "agent".to_string(),
            created_at,
            updated_at: created_at,
        }
    }

    fn test_docx_bytes(text: &str) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("word/document.xml", options).unwrap();
        write!(
            zip,
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:body></w:document>"#,
            text
        )
        .unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[tokio::test]
    async fn agent_provider_resolution_materializes_builtin_provider() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;

        let real_id = resolve_agent_provider_id(&db, "builtin_deepseek")
            .await
            .unwrap();

        assert_ne!(real_id, "builtin_deepseek");
        let provider = provider::get_provider(&db, &real_id).await.unwrap();
        assert_eq!(provider.builtin_id.as_deref(), Some("deepseek"));
        assert_eq!(provider.provider_type, ProviderType::DeepSeek);
    }

    #[test]
    fn agent_prompt_obeys_document_attachment_reading_setting() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-agent-document-test-{}",
            aqbot_core::utils::gen_id()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let result = (|| {
            let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
            let docx = test_docx_bytes("Agent document context");
            let saved = file_store
                .save_file(
                    &docx,
                    "agent-notes.docx",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                .unwrap();
            let attachments = vec![Attachment {
                id: "att-agent".into(),
                file_type:
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into(),
                file_name: "agent-notes.docx".into(),
                file_path: saved.storage_path,
                file_size: docx.len() as u64,
                data: None,
            }];
            let mut settings = AppSettings::default();

            let disabled = build_agent_prompt_with_attachments(
                &file_store,
                "Inspect this",
                &attachments,
                &settings,
            )
            .unwrap();
            settings.document_attachment_reading_enabled = true;
            let enabled = build_agent_prompt_with_attachments(
                &file_store,
                "Inspect this",
                &attachments,
                &settings,
            )
            .unwrap();

            (disabled, enabled)
        })();

        fs::remove_dir_all(&temp_dir).unwrap();

        assert_eq!(result.0, "Inspect this");
        assert!(result.1.contains("Inspect this"));
        assert!(result.1.contains("agent-notes.docx"));
        assert!(result.1.contains("Agent document context"));
    }

    #[test]
    fn agent_workspace_name_uses_selected_strategy() {
        let conv = test_conversation("conv-12345678", 1_700_000_000);
        let mut settings = AppSettings::default();

        assert_eq!(agent_workspace_dir_name(&conv, &settings), "conv-12345678");

        settings.agent_workspace_name_strategy = "conversation_id".to_string();
        assert_eq!(agent_workspace_dir_name(&conv, &settings), "conv-12345678");

        settings.agent_workspace_name_strategy = "created_timestamp".to_string();
        assert_eq!(agent_workspace_dir_name(&conv, &settings), "1700000000");

        settings.agent_workspace_name_strategy = "created_datetime".to_string();
        settings.agent_workspace_datetime_format = Some("YYYY-MM-DD-HH:mm:ss".to_string());
        let expected = {
            use chrono::{Local, TimeZone};
            Local
                .timestamp_opt(1_700_000_000, 0)
                .single()
                .unwrap()
                .format("%Y-%m-%d-%H-%M-%S")
                .to_string()
        };
        assert_eq!(agent_workspace_dir_name(&conv, &settings), expected);
    }

    #[test]
    fn agent_workspace_name_is_filesystem_safe_and_bounded() {
        let raw = format!("bad/name:with*chars?{}", "x".repeat(120));

        let sanitized = sanitize_workspace_dir_name(&raw);

        assert!(!sanitized.contains('/'));
        assert!(!sanitized.contains(':'));
        assert!(!sanitized.contains('*'));
        assert!(!sanitized.contains('?'));
        assert!(sanitized.len() <= 80);
    }

    #[test]
    fn agent_workspace_path_uses_collision_suffixes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let conv = test_conversation("abcdef12-3456-7890-abcd-ef1234567890", 1_700_000_000);
        let mut settings = AppSettings::default();
        settings.agent_workspace_root = Some(temp_dir.path().to_string_lossy().to_string());
        settings.agent_workspace_name_strategy = "created_timestamp".to_string();

        fs::create_dir_all(temp_dir.path().join("1700000000")).unwrap();
        fs::create_dir_all(temp_dir.path().join("1700000000-abcdef12")).unwrap();

        let workspace = resolve_agent_workspace_dir(&settings, &conv);

        assert_eq!(
            workspace.file_name().and_then(|name| name.to_str()),
            Some("1700000000-abcdef12-2")
        );
    }

    #[test]
    fn agent_session_ipc_omits_backend_sdk_context() {
        let session = agent_session_for_ipc(AgentSession {
            id: "session-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            cwd: None,
            permission_mode: "ask".to_string(),
            runtime_status: "idle".to_string(),
            sdk_context_json: Some("data:image/png;base64,SECRET".to_string()),
            sdk_context_backup_json: Some("DATA:IMAGE/PNG;base64,BACKUP".to_string()),
            total_tokens: 0,
            total_cost_usd: 0.0,
            created_at: "2026-07-15 00:00:00".to_string(),
            updated_at: "2026-07-15 00:00:00".to_string(),
        });
        let ipc_json = serde_json::to_string(&session).unwrap();

        assert!(!ipc_json.to_ascii_lowercase().contains("data:image/"));
        assert!(session.sdk_context_json.is_none());
        assert!(session.sdk_context_backup_json.is_none());
    }
}
