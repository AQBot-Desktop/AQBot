use crate::AppState;
use aqbot_agent::permission::{classify_tool_risk, decide_permission, PermissionAction};
use aqbot_agent::security::check_path_safety;
use aqbot_core::repo::{agent_session, conversation, message, provider, tool_execution};
use aqbot_core::types::{AgentSession, MessageRole, ProviderProxyConfig, ProviderType};
use aqbot_providers::{resolve_base_url_for_type, ProviderAdapter, ProviderRequestContext};
use open_agent_sdk::{
    Agent, AgentOptions, CanUseToolFn, ContentBlock, PermissionDecision, SDKMessage, Usage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::RwLock;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn provider_type_to_registry_key(pt: &ProviderType) -> &'static str {
    match pt {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Custom => "openai",
    }
}

/// Create an `Arc<dyn ProviderAdapter>` directly (avoids borrow-lifetime issues
/// with the registry returning `&dyn ProviderAdapter`).
fn create_adapter_arc(pt: &ProviderType) -> Result<Arc<dyn ProviderAdapter>, String> {
    match pt {
        ProviderType::OpenAI | ProviderType::Custom => {
            Ok(Arc::new(aqbot_providers::openai::OpenAIAdapter::new()))
        }
        ProviderType::Anthropic => {
            Ok(Arc::new(aqbot_providers::anthropic::AnthropicAdapter::new()))
        }
        ProviderType::Gemini => Ok(Arc::new(aqbot_providers::gemini::GeminiAdapter::new())),
        ProviderType::OpenAIResponses => {
            Err("OpenAI Responses API is not supported in Agent mode".to_string())
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
) -> Result<(), String> {
    // 1. Get agent session (must exist)
    let session =
        agent_session::get_agent_session_by_conversation_id(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Agent session not found. Please switch to Agent mode first.")?;

    // 2. Concurrent check
    if session.runtime_status == "running" || session.runtime_status == "waiting_approval" {
        return Err("Agent is already running".to_string());
    }

    // 3. Set runtime_status to 'running'
    agent_session::update_agent_session_status(&state.sea_db, &session.id, "running")
        .await
        .map_err(|e| e.to_string())?;

    // 4. Save user message
    let user_message = message::create_message(
        &state.sea_db,
        &conversation_id,
        MessageRole::User,
        &prompt,
        &[],
        None,
        0,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Check if first message BEFORE incrementing
    let pre_conv = conversation::get_conversation(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let is_first_message = pre_conv.message_count <= 1;

    conversation::increment_message_count(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    // Auto-title: set fallback + async AI title for first message
    if is_first_message {
        let fallback_title = if prompt.chars().count() > 30 {
            format!("{}...", prompt.chars().take(30).collect::<String>())
        } else {
            prompt.clone()
        };
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
    let prov = provider::get_provider(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row = provider::get_active_key(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted_key =
        aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
            .map_err(|e| e.to_string())?;

    // 6. Build ProviderRequestContext
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
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
        .with_app(app.clone(), conversation_id.clone());

    // 8. Build permission callback (CanUseToolFn)
    let permission_mode = aqbot_agent::permission::PermissionMode::from_str(
        &session.permission_mode,
    );
    let cwd_for_check = session.cwd.clone().unwrap_or_default();
    let always_allowed: Arc<RwLock<HashSet<String>>> = Arc::new(RwLock::new(HashSet::new()));
    let permission_senders = state.agent_permission_senders.clone();
    let app_for_perm = app.clone();
    let conv_id_for_perm = conversation_id.clone();
    let current_assistant_id_for_perm: Arc<RwLock<Option<String>>> =
        Arc::new(RwLock::new(None));
    let assistant_id_for_task = current_assistant_id_for_perm.clone();
    let db_for_perm = state.sea_db.clone();

    let can_use_tool: CanUseToolFn = Arc::new(move |tool_name: &str, input: &Value| {
        let tool_name = tool_name.to_string();
        let input = input.clone();
        let cwd = cwd_for_check.clone();
        let always_allowed = always_allowed.clone();
        let permission_senders = permission_senders.clone();
        let app = app_for_perm.clone();
        let conv_id = conv_id_for_perm.clone();
        let assistant_id = current_assistant_id_for_perm.clone();
        let db = db_for_perm.clone();

        Box::pin(async move {
            // 1. CWD safety check (hard deny, skipped in FullAccess mode)
            if permission_mode != aqbot_agent::permission::PermissionMode::FullAccess
                && !cwd.is_empty()
            {
                if let Some(deny) = check_path_safety(&tool_name, &input, &cwd) {
                    return deny;
                }
            }

            // 2. Check always_allowed cache
            if always_allowed.read().await.contains(&tool_name) {
                return PermissionDecision::Allow;
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
                    let input_str = truncate_preview(
                        &serde_json::to_string(&input).unwrap_or_default(),
                        500,
                    );
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
                            tool_use_id: perm_id.clone(),
                            tool_name: tool_name.clone(),
                            input,
                            risk_level: risk_str.to_string(),
                        },
                    );

                    // Wait for user response (raw decision string)
                    let final_decision = match rx.await {
                        Ok(decision_str) => match decision_str.as_str() {
                            "allow_once" => PermissionDecision::Allow,
                            "allow_always" => {
                                always_allowed.write().await.insert(tool_name.clone());
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
                    };

                    // Persist approval decision to DB
                    if let Some(eid) = &exec_id {
                        let status = match &final_decision {
                            PermissionDecision::Allow
                            | PermissionDecision::AllowWithModifiedInput(_) => "approved",
                            PermissionDecision::Deny(_) => "denied",
                        };
                        let _ = tool_execution::update_tool_execution_approval_status(
                            &db, eid, status,
                        )
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

    let agent_options = AgentOptions {
        model: Some(model_id.clone()),
        provider: Some(Arc::new(bridge)),
        cwd: session.cwd.clone(),
        system_prompt: conv.system_prompt.clone(),
        can_use_tool: Some(can_use_tool),
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

    tracing::info!("[agent] Agent created for conversation {}, model {}", conversation_id, model_id);

    // 10. Spawn background task
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
        tracing::info!("[agent] Background task started for conversation {}", conv_id);
        let (mut rx, handle) = agent.query(&prompt).await;

        let mut result_text = String::new();
        let mut final_usage: Option<Usage> = None;
        let mut num_turns = 0u32;
        let mut cost_usd = 0.0f64;
        let mut sdk_messages: Option<Vec<open_agent_sdk::Message>> = None;
        let mut current_assistant_msg_id: Option<String> = None;
        let mut accumulated_text = String::new();
        let mut got_result_or_error = false;
        // Map SDK tool_use_id → DB tool_execution.id
        let mut tool_exec_map: HashMap<String, String> = HashMap::new();

        while let Some(msg) = rx.recv().await {
            match msg {
                SDKMessage::Assistant { message: msg, .. } => {
                    // Two-pass processing: first create/update the assistant message,
                    // then emit tool_use events with the correct assistant message ID.

                    // Pass 1: collect text and thinking
                    let mut text_parts = Vec::new();
                    for block in &msg.content {
                        match block {
                            ContentBlock::Text { text } => {
                                text_parts.push(text.as_str());
                            }
                            ContentBlock::Thinking { thinking, .. } => {
                                let _ = app.emit(
                                    "agent-stream-thinking",
                                    AgentThinkingPayload {
                                        conversation_id: conv_id.clone(),
                                        assistant_message_id: current_assistant_msg_id
                                            .clone()
                                            .unwrap_or_default(),
                                        thinking: thinking.clone(),
                                    },
                                );
                            }
                            _ => {}
                        }
                    }

                    let new_text: String = text_parts.join("");
                    if !new_text.is_empty() {
                        accumulated_text.push_str(&new_text);
                    }

                    // Create or update assistant message BEFORE emitting tool events
                    if current_assistant_msg_id.is_none() {
                        if let Ok(assist_msg) = message::create_message(
                            &db,
                            &conv_id,
                            MessageRole::Assistant,
                            &accumulated_text,
                            &[],
                            Some(&user_msg_id),
                            0,
                        )
                        .await
                        {
                            current_assistant_msg_id = Some(assist_msg.id.clone());
                            // Sync the shared Arc so CanUseToolFn has the correct assistant ID
                            *assistant_id_for_task.write().await = Some(assist_msg.id.clone());
                            tracing::info!("[agent] Created assistant message: {}", assist_msg.id);
                            // Notify frontend of the real message ID so it can update the temp placeholder
                            let _ = app.emit(
                                "agent-message-id",
                                serde_json::json!({
                                    "conversationId": conv_id,
                                    "assistantMessageId": assist_msg.id,
                                }),
                            );
                            let _ =
                                conversation::increment_message_count(&db, &conv_id).await;
                        }
                    } else if let Some(ref mid) = current_assistant_msg_id {
                        let _ =
                            message::update_message_content(&db, mid, &accumulated_text)
                                .await;
                    }

                    // Pass 2: process tool_use blocks (now current_assistant_msg_id is set)
                    for block in &msg.content {
                        if let ContentBlock::ToolUse { id, name, input } = block {
                            tracing::info!(
                                "[agent] ToolUse in assistant message: {} ({}), assistantMsgId={:?}",
                                name, id, current_assistant_msg_id
                            );
                            let _ = app.emit(
                                "agent-tool-use",
                                AgentToolUsePayload {
                                    conversation_id: conv_id.clone(),
                                    assistant_message_id: current_assistant_msg_id
                                        .clone()
                                        .unwrap_or_default(),
                                    tool_use_id: id.clone(),
                                    tool_name: name.clone(),
                                    input: input.clone(),
                                },
                            );

                            // Create tool_execution record in DB
                            let input_str = truncate_preview(
                                &serde_json::to_string(input).unwrap_or_default(),
                                500,
                            );
                            if let Ok(exec) = tool_execution::create_tool_execution(
                                &db,
                                &conv_id,
                                current_assistant_msg_id.as_deref(),
                                "__agent_sdk__",
                                name,
                                Some(&input_str),
                                None,
                            )
                            .await
                            {
                                tool_exec_map.insert(id.clone(), exec.id);
                            }
                        }
                    }
                }
                SDKMessage::ToolStart {
                    tool_use_id,
                    tool_name,
                    input,
                } => {
                    tracing::info!("[agent] ToolStart: {} ({})", tool_name, tool_use_id);
                    // Emit agent-tool-start
                    let _ = app.emit(
                        "agent-tool-start",
                        AgentToolStartPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id
                                .clone()
                                .unwrap_or_default(),
                            tool_use_id: tool_use_id.clone(),
                            tool_name: tool_name.clone(),
                            input,
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
                    // Emit agent-tool-result
                    let _ = app.emit(
                        "agent-tool-result",
                        AgentToolResultPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id
                                .clone()
                                .unwrap_or_default(),
                            tool_use_id: tool_use_id.clone(),
                            tool_name: tool_name.clone(),
                            content: content.clone(),
                            is_error,
                        },
                    );

                    // Update tool_execution status + output
                    if let Some(exec_id) = tool_exec_map.get(&tool_use_id) {
                        let status = if is_error { "failed" } else { "success" };
                        let output_preview = truncate_preview(&content, 500);
                        let error_msg = if is_error { Some(content.as_str()) } else { None };
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
                    // Emit agent-permission-request
                    let _ = app.emit(
                        "agent-permission-request",
                        AgentPermissionRequestPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id
                                .clone()
                                .unwrap_or_default(),
                            tool_use_id: tool_use_id.clone(),
                            tool_name: tool_name.clone(),
                            input,
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
                SDKMessage::Status { message: status_msg }
                | SDKMessage::Progress {
                    message: status_msg,
                } => {
                    let _ = app.emit(
                        "agent-status",
                        AgentStatusPayload {
                            conversation_id: conv_id.clone(),
                            message: status_msg,
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
                            message: limit_msg,
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
                    result_text = text;
                    final_usage = Some(usage);
                    num_turns = t;
                    cost_usd = c;
                    sdk_messages = Some(messages);
                }
                SDKMessage::Error { message: err_msg } => {
                    tracing::error!("[agent] Error: {}", err_msg);
                    let _ = app.emit(
                        "agent-error",
                        AgentErrorPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id.clone(),
                            message: err_msg,
                        },
                    );
                    let _ = agent_session::update_agent_session_status(
                        &db,
                        &session_id,
                        "error",
                    )
                    .await;
                    return;
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
                    let _ = app.emit(
                        "agent-error",
                        AgentErrorPayload {
                            conversation_id: conv_id.clone(),
                            assistant_message_id: current_assistant_msg_id.clone(),
                            message: "Agent task crashed unexpectedly".to_string(),
                        },
                    );
                    let _ = agent_session::update_agent_session_status(
                        &db,
                        &session_id,
                        "error",
                    )
                    .await;
                    return;
                }
            }
        }

        // If channel closed without Result or Error, emit a fallback error
        if !got_result_or_error {
            tracing::error!("[agent] Channel closed without Result or Error");
            let _ = app.emit(
                "agent-error",
                AgentErrorPayload {
                    conversation_id: conv_id.clone(),
                    assistant_message_id: current_assistant_msg_id.clone(),
                    message: "Agent ended unexpectedly without producing a result".to_string(),
                },
            );
            let _ = agent_session::update_agent_session_status(
                &db,
                &session_id,
                "error",
            )
            .await;
            return;
        }

        // Update assistant message with final result text if we have one
        if !result_text.is_empty() {
            if let Some(ref mid) = current_assistant_msg_id {
                let _ = message::update_message_content(&db, mid, &result_text).await;
            } else {
                // No assistant message was created during streaming — create one now
                if let Ok(assist_msg) = message::create_message(
                    &db,
                    &conv_id,
                    MessageRole::Assistant,
                    &result_text,
                    &[],
                    Some(&user_msg_id),
                    0,
                )
                .await
                {
                    current_assistant_msg_id = Some(assist_msg.id.clone());
                    let _ = conversation::increment_message_count(&db, &conv_id).await;
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

        let _ = app.emit(
            "agent-done",
            AgentDonePayload {
                conversation_id: conv_id.clone(),
                assistant_message_id: current_assistant_msg_id
                    .clone()
                    .unwrap_or_default(),
                text: result_text.clone(),
                usage: usage_payload,
                num_turns: Some(num_turns),
                cost_usd: Some(cost_usd),
            },
        );

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
                    if let Err(e) = conversation::update_conversation_title(
                        &db, &conv_id, &title,
                    ).await {
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
        let _ = agent_session::update_agent_session_after_query(
            &db,
            &session_id,
            "completed",
            sdk_context.as_deref(),
            tokens_delta,
            cost_usd,
        )
        .await;
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
pub async fn agent_cancel(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    let session =
        agent_session::get_agent_session_by_conversation_id(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Agent session not found")?;

    // Reset to idle
    agent_session::update_agent_session_status(&state.sea_db, &session.id, "idle")
        .await
        .map_err(|e| e.to_string())?;

    // TODO: Phase 2 — abort running agent via stored JoinHandle

    Ok(())
}

#[tauri::command]
pub async fn agent_update_session(
    state: State<'_, AppState>,
    conversation_id: String,
    cwd: Option<String>,
    permission_mode: Option<String>,
) -> Result<AgentSession, String> {
    agent_session::upsert_agent_session(
        &state.sea_db,
        &conversation_id,
        cwd.as_deref(),
        permission_mode.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_get_session(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<AgentSession>, String> {
    agent_session::get_agent_session_by_conversation_id(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

/// Create default workspace directory under config home and return its path.
#[tauri::command]
pub async fn agent_ensure_workspace(
    conversation_id: String,
) -> Result<String, String> {
    let workspace_dir = crate::paths::aqbot_home()
        .join("workspace")
        .join(&conversation_id);
    std::fs::create_dir_all(&workspace_dir)
        .map_err(|e| format!("Failed to create workspace: {}", e))?;
    workspace_dir
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path encoding".to_string())
}
