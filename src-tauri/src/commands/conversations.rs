use crate::AppState;
use aqbot_core::types::*;
use aqbot_providers::{ProviderRequestContext, registry::ProviderRegistry, resolve_base_url};
use base64::Engine;
use sea_orm::*;
use tauri::{Emitter, State};

fn provider_type_to_registry_key(pt: &ProviderType) -> &'static str {
    match pt {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Custom => "openai", // Custom providers use OpenAI-compatible API
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

fn build_message_content(
    file_store: &aqbot_core::file_store::FileStore,
    message: &Message,
) -> aqbot_core::error::Result<ChatContent> {
    let image_attachments = message
        .attachments
        .iter()
        .filter(|attachment| attachment.file_type.starts_with("image/"))
        .collect::<Vec<_>>();

    if image_attachments.is_empty() {
        return Ok(ChatContent::Text(message.content.clone()));
    }

    let mut parts = Vec::new();
    if !message.content.is_empty() {
        parts.push(ContentPart {
            r#type: "text".to_string(),
            text: Some(message.content.clone()),
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
        return Ok(ChatContent::Text(message.content.clone()));
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
        tool_calls,
        tool_call_id: message.tool_call_id.clone(),
    })
}

#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<Conversation>, String> {
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
        &state.sea_db, &title, &model_id, &provider_id,
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
pub async fn delete_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    delete_conversation_with_attachments(&state.sea_db, &id)
        .await
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
    let files = aqbot_core::repo::stored_file::list_stored_files_by_conversation(db, conversation_id)
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
    stream: &mut std::pin::Pin<Box<dyn futures::Stream<Item = aqbot_core::error::Result<ChatStreamChunk>> + Send>>,
    conversation_id: &str,
    message_id: &str,
) -> (String, String, Option<TokenUsage>, Option<Vec<ToolCall>>) {
    use futures::StreamExt;
    let mut full_content = String::new();
    let mut full_thinking = String::new();
    let mut final_usage: Option<TokenUsage> = None;
    let mut final_tool_calls: Option<Vec<ToolCall>> = None;

    while let Some(result) = stream.next().await {
        match result {
            Ok(chunk) => {
                let mut emitted_chunk = chunk.clone();
                if emitted_chunk.done && emitted_chunk.is_final.is_none() {
                    emitted_chunk.is_final = Some(
                        emitted_chunk
                            .tool_calls
                            .as_ref()
                            .is_none_or(|tool_calls| tool_calls.is_empty()),
                    );
                }
                if let Some(ref c) = chunk.content {
                    full_content.push_str(c);
                }
                if let Some(ref t) = chunk.thinking {
                    full_thinking.push_str(t);
                }
                if chunk.usage.is_some() {
                    final_usage.clone_from(&chunk.usage);
                }
                if chunk.tool_calls.is_some() {
                    final_tool_calls.clone_from(&chunk.tool_calls);
                }
                let is_done = chunk.done;

                let _ = app.emit(
                    "chat-stream-chunk",
                    ChatStreamEvent {
                        conversation_id: conversation_id.to_string(),
                        message_id: message_id.to_string(),
                        chunk: emitted_chunk,
                    },
                );

                if is_done {
                    break;
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "chat-stream-error",
                    ChatStreamErrorEvent {
                        conversation_id: conversation_id.to_string(),
                        message_id: message_id.to_string(),
                        error: format!("{}", e),
                    },
                );
                tracing::error!("Stream error: {}", e);
                break;
            }
        }
    }

    (full_content, full_thinking, final_usage, final_tool_calls)
}

async fn execute_tool_call(
    db: &sea_orm::DatabaseConnection,
    tool_call: &ToolCall,
    mcp_server_ids: &[String],
) -> (String, bool) {
    let server_and_tool = aqbot_core::repo::mcp_server::find_server_for_tool(
        db, &tool_call.function.name, mcp_server_ids,
    ).await;

    let (server, _td) = match server_and_tool {
        Ok(Some(pair)) => pair,
        _ => {
            return (
                format!("Error: Tool '{}' not found on any enabled MCP server", tool_call.function.name),
                true,
            );
        }
    };

    let arguments: serde_json::Value = serde_json::from_str(&tool_call.function.arguments)
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

    let result = match server.transport.as_str() {
        "builtin" => {
            aqbot_core::builtin_tools::dispatch(&server.name, &tool_call.function.name, arguments).await
        }
        "stdio" => {
            let command = match &server.command {
                Some(cmd) => cmd.clone(),
                None => return ("Error: stdio server has no command configured".into(), true),
            };
            let args: Vec<String> = server.args_json.as_ref()
                .and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
            let env: std::collections::HashMap<String, String> = server.env_json.as_ref()
                .and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
            aqbot_core::mcp_client::call_tool_stdio(&command, &args, &env, &tool_call.function.name, arguments).await
        }
        "http" => {
            let endpoint = match &server.endpoint {
                Some(ep) => ep.clone(),
                None => return ("Error: HTTP server has no endpoint configured".into(), true),
            };
            aqbot_core::mcp_client::call_tool_http(&endpoint, &tool_call.function.name, arguments).await
        }
        other => return (format!("Error: Unsupported transport '{}'", other), true),
    };

    match result {
        Ok(r) => (r.content, r.is_error),
        Err(e) => (format!("Error executing tool: {}", e), true),
    }
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
    mcp_server_ids: Vec<String>,
    override_created_at: Option<i64>,
) {
    let model_id = conversation.model_id.clone();

    tokio::spawn(async move {
        let registry = ProviderRegistry::create_default();
        let registry_key = provider_type_to_registry_key(&provider.provider_type);
        let adapter: &dyn aqbot_providers::ProviderAdapter = match registry.get(registry_key) {
            Some(a) => a,
            None => {
                let _ = app.emit("chat-stream-error", ChatStreamErrorEvent {
                    conversation_id: conversation_id.clone(),
                    message_id: assistant_message_id.clone(),
                    error: format!("Unsupported provider type: {}", registry_key),
                });
                return;
            }
        };

        const MAX_TOOL_ITERATIONS: usize = 10;
        let mut chat_messages = chat_messages;
        let mut iteration = 0;
        let mut total_content = String::new();
        let mut total_thinking = String::new();
        let mut total_usage: Option<TokenUsage> = None;
        let mut final_tool_calls_json: Option<String> = None;

        loop {
            iteration += 1;
            if iteration > MAX_TOOL_ITERATIONS {
                tracing::warn!("Tool call loop exceeded max iterations ({})", MAX_TOOL_ITERATIONS);
                break;
            }

            let request = ChatRequest {
                model: model_id.clone(),
                messages: chat_messages.clone(),
                stream: true,
                temperature: conversation.temperature.map(|v| v as f64),
                top_p: conversation.top_p.map(|v| v as f64),
                max_tokens: conversation.max_tokens,
                tools: tools.clone(),
                thinking_budget,
            };

            let mut stream = adapter.chat_stream(&ctx, request);
            let (content, thinking, usage, tool_calls) =
                consume_stream(&app, &mut stream, &conversation_id, &assistant_message_id).await;

            total_content.push_str(&content);
            total_thinking.push_str(&thinking);
            if usage.is_some() {
                total_usage = usage;
            }

            // If no tool calls, we're done
            let tool_calls = match tool_calls {
                Some(tc) if !tc.is_empty() => tc,
                _ => break,
            };

            // Determine where MCP blocks belong: if this iteration produced
            // thinking but no content, the tool calls are part of the reasoning
            // phase and should be folded into the thinking section.
            let mcp_in_thinking = content.is_empty() && !thinking.is_empty();

            // Save the tool_calls JSON for the final message
            let tc_json = serde_json::to_string(&tool_calls).ok();
            final_tool_calls_json = tc_json.clone();

            // Add assistant message with tool_calls to chat history for next round
            chat_messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: ChatContent::Text(content.to_string()),
                tool_calls: Some(tool_calls.clone()),
                tool_call_id: None,
            });

            // Persist the intermediate assistant message with tool_calls
            // Returns the generated ID so tool results can reference it as parent
            let intermediate_msg_id = aqbot_core::repo::message::create_assistant_tool_call_message(
                &db,
                &conversation_id,
                &content,
                tc_json.as_deref(),
                &provider.id,
                &model_id,
                &parent_message_id,
            ).await.unwrap_or_else(|_| aqbot_core::utils::gen_id());

            // Execute each tool call
            for tc in &tool_calls {
                // Look up server name for events
                let server_name = match aqbot_core::repo::mcp_server::find_server_for_tool(
                    &db, &tc.function.name, &mcp_server_ids,
                ).await {
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
                if mcp_in_thinking {
                    total_thinking.push_str(&mcp_opener);
                } else {
                    total_content.push_str(&mcp_opener);
                }
                let _ = app.emit("chat-stream-chunk", ChatStreamEvent {
                    conversation_id: conversation_id.clone(),
                    message_id: assistant_message_id.clone(),
                    chunk: ChatStreamChunk {
                        content: if mcp_in_thinking { None } else { Some(mcp_opener.clone()) },
                        thinking: if mcp_in_thinking { Some(mcp_opener.clone()) } else { None },
                        done: false,
                        is_final: None,
                        usage: None,
                        tool_calls: None,
                    },
                });

                // Create execution record
                let server_id_for_exec = match aqbot_core::repo::mcp_server::find_server_for_tool(
                    &db, &tc.function.name, &mcp_server_ids,
                ).await {
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
                ).await;

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
                        if is_error { Some(&result_content) } else { None },
                    ).await;
                }

                // Emit :::mcp result + closer as stream chunk — frontend shows completed state
                let mcp_closer = format!("{}\n:::\n\n", result_content);
                if mcp_in_thinking {
                    total_thinking.push_str(&mcp_closer);
                } else {
                    total_content.push_str(&mcp_closer);
                }
                let _ = app.emit("chat-stream-chunk", ChatStreamEvent {
                    conversation_id: conversation_id.clone(),
                    message_id: assistant_message_id.clone(),
                    chunk: ChatStreamChunk {
                        content: if mcp_in_thinking { None } else { Some(mcp_closer.clone()) },
                        thinking: if mcp_in_thinking { Some(mcp_closer.clone()) } else { None },
                        done: false,
                        is_final: None,
                        usage: None,
                        tool_calls: None,
                    },
                });

                // Persist tool result message to DB (parent is the intermediate assistant message)
                let _ = aqbot_core::repo::message::create_tool_result_message(
                    &db,
                    &conversation_id,
                    &tc.id,
                    &result_content,
                    &intermediate_msg_id,
                ).await;

                // Add tool result to in-memory chat messages for next provider call
                chat_messages.push(ChatMessage {
                    role: "tool".to_string(),
                    content: ChatContent::Text(result_content.to_string()),
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                });
            }
            // Continue loop — will call provider again with tool results
        }

        // After loop: save final assistant message to DB
        let token_count = total_usage.as_ref().map(|u| u.completion_tokens);
        let prompt_tokens = total_usage.as_ref().map(|u| u.prompt_tokens);
        let completion_tokens = total_usage.as_ref().map(|u| u.completion_tokens);
        if let Err(e) = (aqbot_core::entity::messages::ActiveModel {
            id: Set(assistant_message_id.clone()),
            conversation_id: Set(conversation_id.clone()),
            role: Set("assistant".to_string()),
            content: Set(total_content.clone()),
            provider_id: Set(Some(provider.id.clone())),
            model_id: Set(Some(model_id.clone())),
            token_count: Set(token_count.map(|v| v as i64)),
            prompt_tokens: Set(prompt_tokens.map(|v| v as i64)),
            completion_tokens: Set(completion_tokens.map(|v| v as i64)),
            attachments: Set("[]".to_string()),
            thinking: Set(if total_thinking.is_empty() { None } else { Some(total_thinking.clone()) }),
            created_at: Set(override_created_at.unwrap_or_else(aqbot_core::utils::now_ts)),
            branch_id: Set(None),
            parent_message_id: Set(Some(parent_message_id.clone())),
            version_index: Set(version_index),
            is_active: Set(1),
            tool_calls_json: Set(final_tool_calls_json),
            tool_call_id: Set(None),
        })
        .insert(&db)
        .await
        {
            tracing::error!("Failed to save assistant message: {}", e);
        }

        // Increment message count for the assistant message
        if let Err(e) = aqbot_core::repo::conversation::increment_message_count(&db, &conversation_id).await {
            tracing::error!("Failed to increment message count: {}", e);
        }

        // Auto-title: if this is the first user message, set conversation title
        if is_first_message {
            let title = if user_content.chars().count() > 30 {
                format!("{}...", user_content.chars().take(30).collect::<String>())
            } else {
                user_content.clone()
            };

            if let Err(e) = aqbot_core::repo::conversation::update_conversation_title(
                &db, &conversation_id, &title,
            ).await {
                tracing::error!("Failed to auto-update title: {}", e);
            } else {
                let _ = app.emit("conversation-title-updated", ConversationTitleUpdatedEvent {
                    conversation_id: conversation_id.clone(),
                    title,
                });
            }
        }
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
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &conversation.provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row =
        aqbot_core::repo::provider::get_active_key(&state.sea_db, &conversation.provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let decrypted_key =
        aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
            .map_err(|e| e.to_string())?;

    // 4. Build ChatRequest from conversation messages
    let db_messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();

    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    // Prepend system prompt if present
    if let Some(ref sys) = conversation.system_prompt {
        if !sys.is_empty() {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text(sys.clone()),
                tool_calls: None,
                tool_call_id: None,
            });
        }
    }

    // RAG retrieval: search enabled knowledge bases and memory namespaces
    let mut rag_context_parts: Vec<String> = Vec::new();

    let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
    for kb_id in &kb_ids {
        match crate::indexing::search_knowledge(
            &state.sea_db,
            &state.master_key,
            &state.vector_store,
            kb_id,
            &content,
            5,
        )
        .await
        {
            Ok(results) if !results.is_empty() => {
                let snippets: Vec<String> = results
                    .iter()
                    .map(|r| r.content.clone())
                    .collect();
                rag_context_parts.push(format!(
                    "[Knowledge Base Reference]\n{}",
                    snippets.join("\n---\n")
                ));
            }
            Err(e) => {
                tracing::debug!("RAG knowledge search failed for kb {}: {}", kb_id, e);
            }
            _ => {}
        }
    }

    let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
    for ns_id in &mem_ids {
        match crate::indexing::search_memory(
            &state.sea_db,
            &state.master_key,
            &state.vector_store,
            ns_id,
            &content,
            5,
        )
        .await
        {
            Ok(results) if !results.is_empty() => {
                let snippets: Vec<String> = results
                    .iter()
                    .map(|r| r.content.clone())
                    .collect();
                rag_context_parts.push(format!(
                    "[Memory Reference]\n{}",
                    snippets.join("\n---\n")
                ));
            }
            Err(e) => {
                tracing::debug!("RAG memory search failed for ns {}: {}", ns_id, e);
            }
            _ => {}
        }
    }

    if !rag_context_parts.is_empty() {
        chat_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(format!(
                "The following reference materials may be relevant to the user's question. Use them if helpful:\n\n{}",
                rag_context_parts.join("\n\n")
            )),
            tool_calls: None,
            tool_call_id: None,
        });
    }

    // Find last context-clear marker to truncate history
    let clear_idx = db_messages.iter().rposition(|m| {
        m.role == MessageRole::System && m.content == "<!-- context-clear -->"
    });
    let effective_messages = match clear_idx {
        Some(idx) => &db_messages[idx + 1..],
        None => &db_messages[..],
    };

    for m in effective_messages {
        // Skip context-clear markers themselves
        if m.role == MessageRole::System && m.content == "<!-- context-clear -->" {
            continue;
        }
        // Tool results are internal scaffolding — only used in-memory during
        // the same turn's tool-execution loop.  Never reload from DB because
        // the final assistant message already incorporates them.
        if m.role == MessageRole::Tool {
            continue;
        }
        // Intermediate assistant messages with tool_calls are scaffolding too —
        // the final assistant message already contains the complete response.
        if m.role == MessageRole::Assistant && m.tool_calls_json.is_some() {
            continue;
        }
        chat_messages.push(chat_message_from_message(&file_store, m).map_err(|e| e.to_string())?);
    }

    // 5. Generate assistant message ID upfront
    let assistant_message_id = aqbot_core::utils::gen_id();

    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url(&provider.api_host)),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
    };

    // 6. Load MCP tools for enabled servers
    let mcp_ids = enabled_mcp_server_ids.unwrap_or_default();
    let tools: Option<Vec<ChatTool>> = if mcp_ids.is_empty() {
        None
    } else {
        let mut all_tools = Vec::new();
        for server_id in &mcp_ids {
            if let Ok(descriptors) = aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, server_id).await {
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
        if all_tools.is_empty() { None } else { Some(all_tools) }
    };

    // 7. Spawn streaming in background
    let user_msg_id = user_message.id.clone();
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
        mcp_ids,
        None,
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
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &conversation.provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row =
        aqbot_core::repo::provider::get_active_key(&state.sea_db, &conversation.provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let decrypted_key =
        aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
            .map_err(|e| e.to_string())?;

    // 6. Rebuild chat messages (active messages only — old inactive versions excluded)
    let remaining_messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();

    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    if let Some(ref sys) = conversation.system_prompt {
        if !sys.is_empty() {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text(sys.clone()),
                tool_calls: None,
                tool_call_id: None,
            });
        }
    }

    // RAG retrieval for regeneration
    {
        let mut rag_parts: Vec<String> = Vec::new();
        let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
        for kb_id in &kb_ids {
            match crate::indexing::search_knowledge(
                &state.sea_db, &state.master_key, &state.vector_store,
                kb_id, &last_user_msg.content, 5,
            ).await {
                Ok(results) if !results.is_empty() => {
                    let snippets: Vec<String> = results.iter().map(|r| r.content.clone()).collect();
                    rag_parts.push(format!("[Knowledge Base Reference]\n{}", snippets.join("\n---\n")));
                }
                Err(e) => {
                    tracing::debug!("RAG knowledge search failed for kb {}: {}", kb_id, e);
                }
                _ => {}
            }
        }
        let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
        for ns_id in &mem_ids {
            match crate::indexing::search_memory(
                &state.sea_db, &state.master_key, &state.vector_store,
                ns_id, &last_user_msg.content, 5,
            ).await {
                Ok(results) if !results.is_empty() => {
                    let snippets: Vec<String> = results.iter().map(|r| r.content.clone()).collect();
                    rag_parts.push(format!("[Memory Reference]\n{}", snippets.join("\n---\n")));
                }
                Err(e) => {
                    tracing::debug!("RAG memory search failed for ns {}: {}", ns_id, e);
                }
                _ => {}
            }
        }
        if !rag_parts.is_empty() {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text(format!(
                    "The following reference materials may be relevant to the user's question. Use them if helpful:\n\n{}",
                    rag_parts.join("\n\n")
                )),
                tool_calls: None,
                tool_call_id: None,
            });
        }
    }

    // Find the target user message position, then search for context-clear BEFORE it
    let target_pos = remaining_messages.iter().position(|m| m.id == last_user_msg.id);
    let search_range = match target_pos {
        Some(pos) => &remaining_messages[..pos],
        None => &remaining_messages[..],
    };
    let clear_idx = search_range.iter().rposition(|m| {
        m.role == MessageRole::System && m.content == "<!-- context-clear -->"
    });
    let effective_messages = match clear_idx {
        Some(idx) => &remaining_messages[idx + 1..],
        None => &remaining_messages[..],
    };

    for m in effective_messages {
        if m.role == MessageRole::System && m.content == "<!-- context-clear -->" {
            continue;
        }
        // Include messages up to and including the last user message
        chat_messages.push(chat_message_from_message(&file_store, m).map_err(|e| e.to_string())?);
        // Stop after the user message we're regenerating from
        if m.id == last_user_msg.id {
            break;
        }
    }

    // 7. Spawn streaming with new version
    let assistant_message_id = aqbot_core::utils::gen_id();

    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url(&provider.api_host)),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
    };

    // Load MCP tools for enabled servers
    let mcp_ids = enabled_mcp_server_ids.unwrap_or_default();
    let tools: Option<Vec<ChatTool>> = if mcp_ids.is_empty() {
        None
    } else {
        let mut all_tools = Vec::new();
        for server_id in &mcp_ids {
            if let Ok(descriptors) = aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, server_id).await {
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
        if all_tools.is_empty() { None } else { Some(all_tools) }
    };

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
        mcp_ids,
        original_created_at,
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
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
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

    // Deactivate all existing versions
    use aqbot_core::entity::messages as msg_entity;
    use sea_orm::sea_query::Expr;
    msg_entity::Entity::update_many()
        .filter(msg_entity::Column::ConversationId.eq(&conversation_id))
        .filter(msg_entity::Column::ParentMessageId.eq(&user_msg.id))
        .col_expr(msg_entity::Column::IsActive, Expr::value(0))
        .exec(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    // Get conversation, but override model_id
    let mut conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    conversation.model_id = target_model_id;

    // Use target provider instead of conversation's default
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &target_provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row =
        aqbot_core::repo::provider::get_active_key(&state.sea_db, &target_provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let decrypted_key =
        aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
            .map_err(|e| e.to_string())?;

    // Build context messages (same logic as regenerate_message)
    let remaining_messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();
    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    if let Some(ref sys) = conversation.system_prompt {
        if !sys.is_empty() {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text(sys.clone()),
                tool_calls: None,
                tool_call_id: None,
            });
        }
    }

    // RAG retrieval
    {
        let mut rag_parts: Vec<String> = Vec::new();
        let kb_ids = enabled_knowledge_base_ids.unwrap_or_default();
        for kb_id in &kb_ids {
            match crate::indexing::search_knowledge(
                &state.sea_db, &state.master_key, &state.vector_store,
                kb_id, &user_msg.content, 5,
            ).await {
                Ok(results) if !results.is_empty() => {
                    let snippets: Vec<String> = results.iter().map(|r| r.content.clone()).collect();
                    rag_parts.push(format!("[Knowledge Base Reference]\n{}", snippets.join("\n---\n")));
                }
                _ => {}
            }
        }
        let mem_ids = enabled_memory_namespace_ids.unwrap_or_default();
        for ns_id in &mem_ids {
            match crate::indexing::search_memory(
                &state.sea_db, &state.master_key, &state.vector_store,
                ns_id, &user_msg.content, 5,
            ).await {
                Ok(results) if !results.is_empty() => {
                    let snippets: Vec<String> = results.iter().map(|r| r.content.clone()).collect();
                    rag_parts.push(format!("[Memory Reference]\n{}", snippets.join("\n---\n")));
                }
                _ => {}
            }
        }
        if !rag_parts.is_empty() {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text(format!(
                    "The following reference materials may be relevant to the user's question. Use them if helpful:\n\n{}",
                    rag_parts.join("\n\n")
                )),
                tool_calls: None,
                tool_call_id: None,
            });
        }
    }

    // Context building with context-clear handling
    let target_pos = remaining_messages.iter().position(|m| m.id == user_msg.id);
    let search_range = match target_pos {
        Some(pos) => &remaining_messages[..pos],
        None => &remaining_messages[..],
    };
    let clear_idx = search_range.iter().rposition(|m| {
        m.role == MessageRole::System && m.content == "<!-- context-clear -->"
    });
    let effective_messages = match clear_idx {
        Some(idx) => &remaining_messages[idx + 1..],
        None => &remaining_messages[..],
    };
    for m in effective_messages {
        if m.role == MessageRole::System && m.content == "<!-- context-clear -->" {
            continue;
        }
        chat_messages.push(chat_message_from_message(&file_store, m).map_err(|e| e.to_string())?);
        if m.id == user_msg.id {
            break;
        }
    }

    let assistant_message_id = aqbot_core::utils::gen_id();
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url(&provider.api_host)),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
    };

    let mcp_ids = enabled_mcp_server_ids.unwrap_or_default();
    let tools: Option<Vec<ChatTool>> = if mcp_ids.is_empty() {
        None
    } else {
        let mut all_tools = Vec::new();
        for server_id in &mcp_ids {
            if let Ok(descriptors) = aqbot_core::repo::mcp_server::list_tools_for_server(&state.sea_db, server_id).await {
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
        if all_tools.is_empty() { None } else { Some(all_tools) }
    };

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
        mcp_ids,
        original_created_at,
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
        &state.sea_db, &conversation_id, &parent_message_id
    ).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn switch_message_version(
    state: State<'_, AppState>,
    conversation_id: String,
    parent_message_id: String,
    message_id: String,
) -> Result<(), String> {
    aqbot_core::repo::message::set_active_version(
        &state.sea_db, &conversation_id, &parent_message_id, &message_id
    ).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_message_group(
    state: State<'_, AppState>,
    conversation_id: String,
    user_message_id: String,
) -> Result<(), String> {
    let deleted = aqbot_core::repo::message::delete_message_group(
        &state.sea_db, &user_message_id
    ).await.map_err(|e| e.to_string())?;
    // Decrement message count by deleted count
    for _ in 0..deleted {
        aqbot_core::repo::conversation::decrement_message_count(
            &state.sea_db, &conversation_id
        ).await.map_err(|e| e.to_string())?;
    }
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
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::fs;
    use tokio::sync::Mutex;

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
        let temp_dir =
            std::env::temp_dir().join(format!("aqbot-conv-delete-test-{}", aqbot_core::utils::gen_id()));
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
        assert!(physical_path.exists(), "fixture file must exist before deleting the conversation");

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

        let result = delete_conversation_with_attachments_using(&db, &file_store, &conversation.id).await;
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
        let temp_dir =
            std::env::temp_dir().join(format!("aqbot-persist-attachments-test-{}", aqbot_core::utils::gen_id()));
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

        let vector_store = Arc::new(
            aqbot_core::vector_store::VectorStore::new(&temp_dir)
                .await
                .unwrap(),
        );
        let state = crate::AppState {
            sea_db: db.clone(),
            master_key: [0; 32],
            gateway: Arc::new(Mutex::new(None)),
            close_to_tray: Arc::new(AtomicBool::new(false)),
            app_data_dir: temp_dir.clone(),
            db_path: "sqlite::memory:".to_string(),
            auto_backup_handle: Arc::new(Mutex::new(None)),
            vector_store,
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
        let _ = aqbot_core::file_store::FileStore::new()
            .delete_file(&persisted[0].file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
