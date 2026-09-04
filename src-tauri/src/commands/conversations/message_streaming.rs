// Message send and regeneration orchestration.

/// Spawn the streaming background task shared by send_message and regenerate_message.
/// Returns an internal handle whose terminal fires after content is persisted and the stream guard is released.
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
    context_policy: StreamContextPolicy,
    is_first_message: bool,
    user_content: String,
    parent_message_id: String,
    version_index: i32,
    tools: Option<Vec<ChatTool>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    mcp_server_ids: Vec<String>,
    memory_tool_scope: Option<aqbot_core::context_engine::MemoryToolScope>,
    override_created_at: Option<i64>,
    use_max_completion_tokens: Option<bool>,
    force_max_tokens: Option<bool>,
    thinking_param_style: Option<String>,
    reasoning_profile: Option<String>,
    max_output_tokens: Option<u32>,
    model_param_overrides: Option<ModelParamOverrides>,
    settings: AppSettings,
    master_key: [u8; 32],
    cancel_flag: Arc<AtomicBool>,
    mut stream_guard: RegisteredStreamGuard,
    content_prefix: String,
    create_inactive: bool,
    skip_placeholder_create: bool,
) -> crate::multi_model_run::StreamHandle {
    let model_id = conversation.model_id.clone();
    let mcp_stdio_clients = app.state::<AppState>().mcp_stdio_clients.clone();
    let handle_stream_id = stream_id.clone();
    let handle_message_id = assistant_message_id.clone();
    let (terminal_tx, terminal_rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        let mut terminal_tx = Some(terminal_tx);
        let send_terminal =
            |tx: &mut Option<
                tokio::sync::oneshot::Sender<crate::multi_model_run::StreamTerminal>,
            >,
             terminal: crate::multi_model_run::StreamTerminal| {
                if let Some(sender) = tx.take() {
                    let _ = sender.send(terminal);
                }
            };
        let effective_chat_params = resolve_chat_model_params(
            &conversation,
            model_param_overrides.as_ref(),
            &settings,
            use_max_completion_tokens,
            force_max_tokens,
            max_output_tokens,
        );
        let stream_timeouts = stream_timeout_config_from_settings(&settings);

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

        let registry = ProviderRegistry::create_default();
        let registry_key = provider_type_to_registry_key(&provider.provider_type);
        let adapter: &dyn aqbot_providers::ProviderAdapter = match registry.get(registry_key) {
            Some(a) => a,
            None => {
                let provider_error = format!("Unsupported provider type: {}", registry_key);
                let persistence_error = persist_terminal_assistant_error(
                    &db,
                    TerminalAssistantErrorPersistence {
                        conversation_id: &conversation_id,
                        message_id: &assistant_message_id,
                        error: &provider_error,
                    },
                )
                .await
                .err();
                let (error_message, error_kind) = if let Some(error) = persistence_error {
                    (
                        format!("{provider_error}; {error}"),
                        "message_persistence_error",
                    )
                } else {
                    (provider_error, "provider_error")
                };
                let error_event = build_stream_error_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    &model_id,
                    &provider.id,
                    error_message.clone(),
                    error_kind,
                    None,
                );
                let terminal_event = build_stream_terminal_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    ChatStreamTerminalOutcome::Error,
                    Some(error_event.error.clone()),
                );
                stream_guard
                    .release_then_finalize(
                        (
                            crate::multi_model_run::StreamTerminal::Error {
                                message: error_message,
                            },
                            error_event,
                            terminal_event,
                        ),
                        |(terminal, error_event, terminal_event)| {
                            send_terminal(&mut terminal_tx, terminal);
                            emit_stream_error(&app, error_event);
                            emit_stream_terminal(&app, terminal_event);
                        },
                    )
                    .await;
                return;
            }
        };

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

            let context_result = match apply_stream_context_policy(&chat_messages, context_policy) {
                Ok(result) if !result.overflow => result,
                Ok(result) => {
                    had_stream_error = true;
                    last_stream_error = Some(build_stream_error_event(
                        &conversation_id,
                        &assistant_message_id,
                        &stream_id,
                        &model_id,
                        &provider.id,
                        format!(
                            "Context exceeds the model input budget during tool iteration {iteration}: required {} tokens",
                            result.sent_tokens
                        ),
                        "context_budget_exceeded",
                        None,
                    ));
                    break;
                }
                Err(error) => {
                    had_stream_error = true;
                    last_stream_error = Some(build_stream_error_event(
                        &conversation_id,
                        &assistant_message_id,
                        &stream_id,
                        &model_id,
                        &provider.id,
                        error,
                        "context_budget_exceeded",
                        None,
                    ));
                    break;
                }
            };
            if context_result.excluded_message_count > 0 {
                tracing::warn!(
                    conversation_id,
                    iteration,
                    strategy = ?context_policy.strategy,
                    excluded_message_count = context_result.excluded_message_count,
                    "Tool iteration context excludes earlier messages"
                );
            }
            chat_messages = context_result.messages;

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
                let (result_content, is_error) = execute_tool_call(
                    &db,
                    &mcp_stdio_clients,
                    tc,
                    &mcp_server_ids,
                    &cancel_flag,
                    memory_tool_scope.as_ref(),
                )
                .await;
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
        let mut persistence_errors = Vec::new();
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
            persistence_errors.push(format!("Failed to persist assistant message: {e}"));
        }

        // Increment message count for the assistant message
        if let Err(e) =
            aqbot_core::repo::conversation::increment_message_count(&db, &conversation_id).await
        {
            tracing::error!("Failed to increment message count: {}", e);
            persistence_errors.push(format!("Failed to persist assistant message count: {e}"));
        }

        let terminal_error_event =
            if let Some(error) = combine_stream_persistence_errors(&persistence_errors) {
                Some(build_stream_error_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    &model_id,
                    &provider.id,
                    error,
                    "message_persistence_error",
                    None,
                ))
            } else if let Some(error) = media_error {
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

        let public_terminal_event = if let Some(error_event) = terminal_error_event.as_ref() {
            build_stream_terminal_event(
                &conversation_id,
                &assistant_message_id,
                &stream_id,
                ChatStreamTerminalOutcome::Error,
                Some(error_event.error.clone()),
            )
        } else if was_cancelled {
            build_stream_terminal_event(
                &conversation_id,
                &assistant_message_id,
                &stream_id,
                ChatStreamTerminalOutcome::Cancelled,
                None,
            )
        } else {
            build_stream_terminal_event(
                &conversation_id,
                &assistant_message_id,
                &stream_id,
                ChatStreamTerminalOutcome::Complete,
                None,
            )
        };

        let terminal = if terminal_error_event.is_some() {
            crate::multi_model_run::StreamTerminal::Error {
                message: terminal_error_event
                    .as_ref()
                    .map(|event| event.error.clone())
                    .unwrap_or_else(|| "Unknown stream error".to_string()),
            }
        } else if was_cancelled {
            crate::multi_model_run::StreamTerminal::Cancelled
        } else {
            crate::multi_model_run::StreamTerminal::Complete
        };
        stream_guard
            .release_then_finalize(
                (terminal, terminal_error_event, public_terminal_event),
                |(terminal, terminal_error_event, public_terminal_event)| {
                    send_terminal(&mut terminal_tx, terminal);

                    if let Some(error_event) = terminal_error_event {
                        emit_stream_error(&app, error_event);
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
                    emit_stream_terminal(&app, public_terminal_event);
                },
            )
            .await;

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

    crate::multi_model_run::StreamHandle {
        stream_id: handle_stream_id,
        message_id: handle_message_id,
        terminal: terminal_rx,
    }
}

#[tauri::command]
pub async fn send_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    stream_id: String,
    history_mode: Option<MultiModelContinuationMode>,
    content: String,
    content_prefix: Option<String>,
    attachments: Vec<AttachmentInput>,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
) -> Result<Message, String> {
    let history_mode = history_mode.unwrap_or_default();
    if has_active_stream_for_conversation(state.stream_cancel_flags.clone(), &conversation_id).await
        || state.multi_model_runs.has_active(&conversation_id).await
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
        aqbot_core::inline_media::prepare_message_inline_images(&content)
            .map_err(|error| format!("Message content rejected before persistence: {error}"))?;
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
    let user_message =
        finalize_new_message_for_ipc(&state.sea_db, user_message, prepared_inline_media.as_ref())
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

    let rollback_message_id = user_message.id.clone();
    let rollback_attachments = user_message.attachments.clone();
    let prepared_send: Result<Message, String> = async {

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
    let resolved_model = get_optional_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await?;
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
    let model_context_window = resolved_model.as_ref().and_then(|m| m.context_window);
    let model_max_output_tokens = resolved_model
        .as_ref()
        .and_then(|model| model.max_output_tokens);
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|error| format!("Failed to load app settings: {error}"))?;
    let document_attachment_reading_enabled = global_settings.document_attachment_reading_enabled;

    // 4. Build ChatRequest from conversation messages
    let db_messages = aqbot_core::repo::message::list_messages_for_continuation(
        &state.sea_db,
        &conversation_id,
        history_mode,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();

    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    // Resolve effective system prompt: conversation → category → global default
    let effective_system_prompt = resolve_system_prompt(&state.sea_db, &conversation).await?;

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

    let prepared_turn = prepare_chat_turn(
        &state.sea_db,
        enabled_knowledge_base_ids.clone(),
        enabled_memory_namespace_ids.clone(),
        resolved_model.as_ref(),
    )
    .await?;
    push_l1_system_message(&mut chat_messages, &prepared_turn);

    // 5. Generate assistant message ID upfront so early RAG events can target
    // the same assistant row that the stream will later update.
    let assistant_message_id = aqbot_core::utils::gen_id();
    let mut stream_guard = RegisteredStreamGuard::register(
        state.stream_cancel_flags.clone(),
        &conversation_id,
        &stream_id,
        cancel_flag.clone(),
        false,
    )
    .await?;
    let setup_failure = StreamSetupFailure::ReleaseOnly;

    let user_query_content = strip_search_enrichment(&user_message.content);

    // RAG retrieval: automatic knowledge + auto-mode semantic memory only.
    let (rag_result, rag_cancelled) = collect_and_emit_rag_context(
        &app,
        &state.sea_db,
        &state.master_key,
        state.vector_store.as_ref(),
        &conversation_id,
        &assistant_message_id,
        &stream_id,
        &user_query_content,
        prepared_turn.knowledge_ids.clone(),
        prepared_turn.auto_memory_ids.clone(),
        &cancel_flag,
        &prepared_turn.diagnostics,
    )
    .await;

    // Build display tags for persistence before moving source_results. Search
    // display is generated before send_message; RAG display is generated here.
    let memory_tag = build_memory_retrieval_tag(&rag_result.source_results);
    let assistant_content_prefix = format!("{}{}", content_prefix.unwrap_or_default(), memory_tag);

    if rag_cancelled {
        let persistence_error_event = persist_assistant_placeholder(
            &state.sea_db,
            AssistantPlaceholderPersistence {
                conversation_id: &conversation_id,
                message_id: &assistant_message_id,
                parent_message_id: &user_message.id,
                provider_id: &provider.id,
                model_id: &conversation.model_id,
                content: &assistant_content_prefix,
                version_index: 0,
                created_at: user_message.created_at + 1,
                deactivate_existing_versions: false,
                increment_message_count: true,
                is_active: true,
            },
        )
        .await
        .err()
        .map(|error| {
            build_stream_error_event(
                &conversation_id,
                &assistant_message_id,
                &stream_id,
                &conversation.model_id,
                &provider.id,
                error,
                "message_persistence_error",
                None,
            )
        });
        let terminal_event = if let Some(error_event) = persistence_error_event.as_ref() {
            build_stream_terminal_event(
                &conversation_id,
                &assistant_message_id,
                &stream_id,
                ChatStreamTerminalOutcome::Error,
                Some(error_event.error.clone()),
            )
        } else {
            build_stream_terminal_event(
                &conversation_id,
                &assistant_message_id,
                &stream_id,
                ChatStreamTerminalOutcome::Cancelled,
                None,
            )
        };
        stream_guard
            .release_then_finalize(
                (persistence_error_event, terminal_event),
                |(persistence_error_event, terminal_event)| {
                    if let Some(error_event) = persistence_error_event {
                        emit_stream_error(&app, error_event);
                    }
                    emit_stream_terminal(&app, terminal_event);
                },
            )
            .await;
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

    let context_strategy = effective_context_strategy(&conversation, &global_settings);
    let existing_summary_result =
        load_continuation_summary(&state.sea_db, &conversation_id, history_mode).await;
    let existing_summary = settle_registered_stream_setup(
        &mut stream_guard,
        existing_summary_result,
        setup_failure,
    )
    .await?;
    let context_boundary = resolve_context_boundary_for_strategy(
        &db_messages,
        existing_summary.as_ref(),
        context_strategy,
        None,
    );
    let effective_existing_summary = existing_summary.as_ref().filter(|_| {
        context_strategy == ContextStrategy::SmartSummary && context_boundary.use_summary
    });

    let full_history_result = build_provider_context_messages_with_sources_from_index(
        &file_store,
        &db_messages,
        context_boundary.start_index,
        document_attachment_reading_enabled,
        model_context_window,
        Some(&user_message.id),
        None,
    )
    .map_err(|e| e.to_string());
    let full_history = settle_registered_stream_setup(
        &mut stream_guard,
        full_history_result,
        setup_failure,
    )
    .await?;
    // Resolve proxy config early (needed for both summary generation and main request)
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    // Tool schemas participate in the context budget, so load them before
    // deciding whether history fits or needs summarization.
    let (mcp_ids, tools) = load_mcp_tools_for_model(
        &state.sea_db,
        enabled_mcp_server_ids,
        resolved_model.as_ref(),
    )
    .await;
    let tools = merge_memory_tool(tools, &prepared_turn);
    let output_reserve = resolved_context_output_reserve(
        &conversation,
        model_param_overrides.as_ref(),
        &global_settings,
        use_max_completion_tokens,
        force_max_tokens,
        model_max_output_tokens,
    );
    let tool_schema_tokens_result = estimate_tool_schema_tokens(tools.as_deref());
    let tool_schema_tokens = settle_registered_stream_setup(
        &mut stream_guard,
        tool_schema_tokens_result,
        setup_failure,
    )
    .await?;
    let input_budget = output_reserve.and_then(|reserve| {
        crate::context_manager::calculate_input_token_budget(
            model_context_window,
            reserve,
            tool_schema_tokens,
        )
    });

    // Message-count limiting happens inside the shared preparation path before
    // it decides whether smart summary needs a persistent compression update.
    let context_result = prepare_context_with_auto_summary(AutoSummaryContextParams {
        app: &app,
        db: &state.sea_db,
        master_key: &state.master_key,
        conversation_id: &conversation_id,
        conversation: &conversation,
        settings: &global_settings,
        strategy: context_strategy,
        db_messages: &db_messages,
        file_store: &file_store,
        history: full_history,
        base_messages: &chat_messages,
        current_user_message_id: &user_message.id,
        stop_after_message_id: None,
        context_boundary,
        existing_summary: effective_existing_summary,
        document_attachment_reading_enabled,
        model_context_window,
        input_budget,
        provider: &provider,
        decrypted_key: &decrypted_key,
        key_id: &key_row.id,
        proxy_config: &resolved_proxy,
        model_id: &conversation.model_id,
        use_max_completion_tokens,
        persist_generated_summary: should_persist_generated_summary(history_mode),
    })
    .await;
    let context_result = settle_registered_stream_setup(
        &mut stream_guard,
        context_result,
        setup_failure,
    )
    .await?;

    if context_result.overflow {
        return settle_registered_stream_setup(
            &mut stream_guard,
            Err(format!(
                "Context still exceeds the model input budget after applying {:?}: required {} tokens",
                context_strategy, context_result.sent_tokens
            )),
            setup_failure,
        )
        .await;
    }
    if context_result.excluded_message_count > 0 {
        tracing::warn!(
            conversation_id,
            strategy = ?context_strategy,
            raw_tokens = context_result.raw_tokens,
            sent_tokens = context_result.sent_tokens,
            excluded_message_count = context_result.excluded_message_count,
            exclusion_reason = ?context_result.exclusion_reason,
            "Provider context excludes earlier messages"
        );
    }
    chat_messages = context_result.messages;
    let stream_context_policy =
        StreamContextPolicy::new(context_strategy, input_budget, &chat_messages);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        aws_region: provider.aws_region.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
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
    let _ = spawn_stream_task(
        app,
        state.sea_db.clone(),
        conversation_id.clone(),
        assistant_message_id,
        stream_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        stream_context_policy,
        is_first_message,
        user_query_content,
        user_msg_id,
        0,
        tools,
        thinking_budget,
        thinking_level,
        mcp_ids,
        prepared_turn.memory_tool.as_ref().map(|binding| binding.scope.clone()),
        Some(user_message.created_at + 1),
        use_max_completion_tokens,
        force_max_tokens,
        thinking_param_style,
        reasoning_profile,
        model_max_output_tokens,
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
    .await;

    match prepared_send {
        Ok(message) => Ok(message),
        Err(error) => {
            let rollback_errors = rollback_counted_new_message(
                &state.sea_db,
                &conversation_id,
                &rollback_message_id,
                &rollback_attachments,
            )
            .await;
            Err(format_new_message_failure(
                &rollback_message_id,
                "send preparation failed",
                error,
                rollback_errors,
            ))
        }
    }
}

async fn deactivate_assistant_versions(
    db: &DatabaseConnection,
    conversation_id: &str,
    parent_message_id: &str,
    preserved_message_id: Option<&str>,
) -> Result<(), String> {
    use aqbot_core::entity::messages as msg_entity;
    use sea_orm::sea_query::Expr;

    let mut update = msg_entity::Entity::update_many()
        .filter(msg_entity::Column::ConversationId.eq(conversation_id))
        .filter(msg_entity::Column::ParentMessageId.eq(parent_message_id));
    if let Some(message_id) = preserved_message_id {
        update = update.filter(msg_entity::Column::Id.ne(message_id));
    }
    update
        .col_expr(msg_entity::Column::IsActive, Expr::value(0))
        .exec(db)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn regenerate_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    stream_id: String,
    history_mode: Option<MultiModelContinuationMode>,
    user_message_id: Option<String>,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let history_mode = history_mode.unwrap_or_default();
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

    // 3. Get conversation details. Existing versions stay active until the
    // complete replacement context has passed strategy and budget validation.
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
        .map_err(|error| format!("Failed to load app settings: {error}"))?;
    let resolved_regen_model = get_optional_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await?;
    let model_context_window = resolved_regen_model.as_ref().and_then(|m| m.context_window);
    let model_max_output_tokens = resolved_regen_model
        .as_ref()
        .and_then(|model| model.max_output_tokens);
    let document_attachment_reading_enabled = global_settings.document_attachment_reading_enabled;

    // 6. Rebuild chat messages from the selected or per-model projected history.
    let remaining_messages = aqbot_core::repo::message::list_messages_for_continuation(
        &state.sea_db,
        &conversation_id,
        history_mode,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();

    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    // Resolve effective system prompt: conversation → category → global default
    let effective_system_prompt = resolve_system_prompt(&state.sea_db, &conversation).await?;

    if let Some(ref sys) = effective_system_prompt {
        chat_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(sys.clone()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }

    let prepared_turn = prepare_chat_turn(
        &state.sea_db,
        enabled_knowledge_base_ids.clone(),
        enabled_memory_namespace_ids.clone(),
        resolved_regen_model.as_ref(),
    )
    .await?;
    push_l1_system_message(&mut chat_messages, &prepared_turn);

    // 7. Spawn streaming with new version
    let assistant_message_id = aqbot_core::utils::gen_id();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let mut stream_guard = RegisteredStreamGuard::register(
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
        let (rag_result, rag_cancelled) = collect_and_emit_rag_context(
            &app,
            &state.sea_db,
            &state.master_key,
            state.vector_store.as_ref(),
            &conversation_id,
            &assistant_message_id,
            &stream_id,
            &target_user_content,
            prepared_turn.knowledge_ids.clone(),
            prepared_turn.auto_memory_ids.clone(),
            &cancel_flag,
            &prepared_turn.diagnostics,
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
            let persistence_error_event = persist_assistant_placeholder(
                &state.sea_db,
                AssistantPlaceholderPersistence {
                    conversation_id: &conversation_id,
                    message_id: &assistant_message_id,
                    parent_message_id: &last_user_msg.id,
                    provider_id: &provider.id,
                    model_id: &conversation.model_id,
                    content: &tag,
                    version_index: new_version_index,
                    created_at: original_created_at.unwrap_or_else(aqbot_core::utils::now_ts),
                    deactivate_existing_versions: true,
                    increment_message_count: true,
                    is_active: true,
                },
            )
            .await
            .err()
            .map(|error| {
                build_stream_error_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    &conversation.model_id,
                    &provider.id,
                    error,
                    "message_persistence_error",
                    None,
                )
            });
            let terminal_event = if let Some(error_event) = persistence_error_event.as_ref() {
                build_stream_terminal_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    ChatStreamTerminalOutcome::Error,
                    Some(error_event.error.clone()),
                )
            } else {
                build_stream_terminal_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    ChatStreamTerminalOutcome::Cancelled,
                    None,
                )
            };
            stream_guard
                .release_then_finalize(
                    (persistence_error_event, terminal_event),
                    |(persistence_error_event, terminal_event)| {
                        if let Some(error_event) = persistence_error_event {
                            emit_stream_error(&app, error_event);
                        }
                        emit_stream_terminal(&app, terminal_event);
                    },
                )
                .await;
            return Ok(());
        }
        tag
    };

    let placeholder_result = persist_assistant_placeholder(
        &state.sea_db,
        AssistantPlaceholderPersistence {
            conversation_id: &conversation_id,
            message_id: &assistant_message_id,
            parent_message_id: &last_user_msg.id,
            provider_id: &provider.id,
            model_id: &conversation.model_id,
            content: &memory_tag,
            version_index: new_version_index,
            created_at: original_created_at.unwrap_or_else(aqbot_core::utils::now_ts),
            deactivate_existing_versions: true,
            increment_message_count: false,
            is_active: true,
        },
    )
    .await;
    settle_registered_stream_setup(
        &mut stream_guard,
        placeholder_result,
        StreamSetupFailure::ReleaseOnly,
    )
    .await?;
    let setup_failure = StreamSetupFailure::EmitTerminal(StreamSetupTerminalContext {
        app: &app,
        db: &state.sea_db,
        conversation_id: &conversation_id,
        message_id: &assistant_message_id,
        stream_id: &stream_id,
        model_id: &conversation.model_id,
        provider_id: &provider.id,
        persist_assistant_error: true,
    });

    let regen_model_overrides = resolved_regen_model
        .as_ref()
        .and_then(|model| model.param_overrides.clone());
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

    let context_strategy = effective_context_strategy(&conversation, &global_settings);
    let existing_summary_result =
        load_continuation_summary(&state.sea_db, &conversation_id, history_mode).await;
    let existing_summary =
        settle_registered_stream_setup(&mut stream_guard, existing_summary_result, setup_failure)
            .await?;
    let context_boundary = resolve_context_boundary_for_strategy(
        &remaining_messages,
        existing_summary.as_ref(),
        context_strategy,
        Some(&last_user_msg.id),
    );
    let effective_existing_summary = existing_summary.as_ref().filter(|_| {
        context_strategy == ContextStrategy::SmartSummary && context_boundary.use_summary
    });
    let full_history_result = build_provider_context_messages_with_sources_from_index(
        &file_store,
        &remaining_messages,
        context_boundary.start_index,
        document_attachment_reading_enabled,
        model_context_window,
        Some(&last_user_msg.id),
        Some(&last_user_msg.id),
    )
    .map_err(|e| e.to_string());
    let full_history =
        settle_registered_stream_setup(&mut stream_guard, full_history_result, setup_failure)
            .await?;

    let (mcp_ids, tools) = load_mcp_tools_for_model(
        &state.sea_db,
        enabled_mcp_server_ids,
        resolved_regen_model.as_ref(),
    )
    .await;
    let tools = merge_memory_tool(tools, &prepared_turn);
    let output_reserve = resolved_context_output_reserve(
        &conversation,
        regen_model_overrides.as_ref(),
        &global_settings,
        use_max_completion_tokens,
        force_max_tokens,
        model_max_output_tokens,
    );
    let tool_schema_tokens_result = estimate_tool_schema_tokens(tools.as_deref());
    let tool_schema_tokens =
        settle_registered_stream_setup(&mut stream_guard, tool_schema_tokens_result, setup_failure)
            .await?;
    let input_budget = output_reserve.and_then(|reserve| {
        crate::context_manager::calculate_input_token_budget(
            model_context_window,
            reserve,
            tool_schema_tokens,
        )
    });
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let context_result = prepare_context_with_auto_summary(AutoSummaryContextParams {
        app: &app,
        db: &state.sea_db,
        master_key: &state.master_key,
        conversation_id: &conversation_id,
        conversation: &conversation,
        settings: &global_settings,
        strategy: context_strategy,
        db_messages: &remaining_messages,
        file_store: &file_store,
        history: full_history,
        base_messages: &chat_messages,
        current_user_message_id: &last_user_msg.id,
        stop_after_message_id: Some(&last_user_msg.id),
        context_boundary,
        existing_summary: effective_existing_summary,
        document_attachment_reading_enabled,
        model_context_window,
        input_budget,
        provider: &provider,
        decrypted_key: &decrypted_key,
        key_id: &key_row.id,
        proxy_config: &resolved_proxy,
        model_id: &conversation.model_id,
        use_max_completion_tokens,
        persist_generated_summary: should_persist_generated_summary(history_mode),
    })
    .await;
    let context_result =
        settle_registered_stream_setup(&mut stream_guard, context_result, setup_failure).await?;
    if context_result.overflow {
        let context_error = format!(
            "Context still exceeds the model input budget after applying {:?}: required {} tokens",
            context_strategy, context_result.sent_tokens
        );
        return settle_registered_stream_setup(
            &mut stream_guard,
            Err(context_error),
            setup_failure,
        )
        .await;
    }
    chat_messages = context_result.messages;
    let stream_context_policy =
        StreamContextPolicy::new(context_strategy, input_budget, &chat_messages);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        aws_region: provider.aws_region.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    // Convert system messages to user messages if model doesn't support system role
    if no_system_role {
        for msg in &mut chat_messages {
            if msg.role == "system" {
                msg.role = "user".to_string();
            }
        }
    }

    let _ = spawn_stream_task(
        app,
        state.sea_db.clone(),
        conversation_id,
        assistant_message_id,
        stream_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        stream_context_policy,
        false,
        target_user_content,
        last_user_msg.id,
        new_version_index,
        tools,
        thinking_budget,
        thinking_level,
        mcp_ids,
        prepared_turn
            .memory_tool
            .as_ref()
            .map(|binding| binding.scope.clone()),
        original_created_at,
        use_max_completion_tokens,
        force_max_tokens,
        thinking_param_style,
        reasoning_profile,
        model_max_output_tokens,
        regen_model_overrides,
        global_settings,
        state.master_key,
        cancel_flag,
        stream_guard,
        memory_tag,
        false,
        true,
    );

    Ok(())
}

#[tauri::command]
pub async fn regenerate_with_model(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    conversation_id: String,
    stream_id: String,
    history_mode: Option<MultiModelContinuationMode>,
    user_message_id: String,
    target_provider_id: String,
    target_model_id: String,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
    is_companion: Option<bool>,
    target_version_index: Option<i32>,
) -> Result<(), String> {
    let _ = start_target_stream(
        app,
        conversation_id,
        stream_id,
        history_mode,
        user_message_id,
        target_provider_id,
        target_model_id,
        enabled_mcp_server_ids,
        thinking_budget,
        thinking_level,
        enabled_knowledge_base_ids,
        enabled_memory_namespace_ids,
        is_companion.unwrap_or(false),
        target_version_index,
        None,
        None,
    )
    .await?;
    Ok(())
}

async fn start_target_stream(
    app: tauri::AppHandle,
    conversation_id: String,
    stream_id: String,
    history_mode: Option<MultiModelContinuationMode>,
    user_message_id: String,
    target_provider_id: String,
    target_model_id: String,
    enabled_mcp_server_ids: Option<Vec<String>>,
    thinking_budget: Option<u32>,
    thinking_level: Option<String>,
    enabled_knowledge_base_ids: Option<Vec<String>>,
    enabled_memory_namespace_ids: Option<Vec<String>>,
    companion: bool,
    target_version_index: Option<i32>,
    forced_version_index: Option<i32>,
    allow_parallel: Option<bool>,
) -> Result<crate::multi_model_run::StreamHandle, String> {
    let state = app.state::<AppState>();
    let history_mode = history_mode.unwrap_or_default();
    let allow_parallel = allow_parallel.unwrap_or(companion);
    if !allow_parallel
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

    let existing_versions = aqbot_core::repo::message::list_message_versions(
        &state.sea_db,
        &conversation_id,
        &user_msg.id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let existing_max = aqbot_core::repo::message::max_assistant_version_index(
        &state.sea_db,
        &conversation_id,
        &user_msg.id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let new_version_index = if let Some(forced_version_index) = forced_version_index {
        forced_version_index
    } else {
        aqbot_core::types::resolve_regenerate_version_index(
            existing_max,
            companion,
            target_version_index,
        )?
    };
    let original_created_at = existing_versions.first().map(|v| v.created_at);
    let assistant_message_id = aqbot_core::utils::gen_id();
    // Get conversation, but override model_id and provider_id to target values
    let mut conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let is_first_message =
        should_auto_generate_title_for_target(conversation.message_count, forced_version_index);
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
        .map_err(|error| format!("Failed to load app settings: {error}"))?;
    let resolved_target_model = get_optional_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await?;
    let model_context_window = resolved_target_model
        .as_ref()
        .and_then(|m| m.context_window);
    let model_max_output_tokens = resolved_target_model
        .as_ref()
        .and_then(|model| model.max_output_tokens);
    let document_attachment_reading_enabled = global_settings.document_attachment_reading_enabled;

    // Build context messages (same logic as regenerate_message)
    let remaining_messages = aqbot_core::repo::message::list_messages_for_continuation(
        &state.sea_db,
        &conversation_id,
        history_mode,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await
    .map_err(|e| e.to_string())?;
    let file_store = aqbot_core::file_store::FileStore::new();
    let mut chat_messages: Vec<ChatMessage> = Vec::new();

    // Resolve effective system prompt: conversation → category → global default
    let effective_system_prompt = resolve_system_prompt(&state.sea_db, &conversation).await?;

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

    let prepared_turn = prepare_chat_turn(
        &state.sea_db,
        enabled_knowledge_base_ids.clone(),
        enabled_memory_namespace_ids.clone(),
        resolved_target_model.as_ref(),
    )
    .await?;
    push_l1_system_message(&mut chat_messages, &prepared_turn);

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let mut stream_guard = RegisteredStreamGuard::register(
        state.stream_cancel_flags.clone(),
        &conversation_id,
        &stream_id,
        cancel_flag.clone(),
        allow_parallel,
    )
    .await?;
    let placeholder_result = persist_assistant_placeholder(
        &state.sea_db,
        AssistantPlaceholderPersistence {
            conversation_id: &conversation_id,
            message_id: &assistant_message_id,
            parent_message_id: &user_msg.id,
            provider_id: &provider.id,
            model_id: &conversation.model_id,
            content: "",
            version_index: new_version_index,
            created_at: original_created_at.unwrap_or_else(aqbot_core::utils::now_ts),
            deactivate_existing_versions: !companion,
            increment_message_count: false,
            is_active: !companion,
        },
    )
    .await;
    settle_registered_stream_setup(
        &mut stream_guard,
        placeholder_result,
        StreamSetupFailure::ReleaseOnly,
    )
    .await?;
    let setup_failure = StreamSetupFailure::EmitTerminal(StreamSetupTerminalContext {
        app: &app,
        db: &state.sea_db,
        conversation_id: &conversation_id,
        message_id: &assistant_message_id,
        stream_id: &stream_id,
        model_id: &conversation.model_id,
        provider_id: &provider.id,
        persist_assistant_error: true,
    });

    let target_user_content = strip_search_enrichment(&user_msg.content);

    // RAG retrieval
    let memory_tag = {
        let (rag_result, rag_cancelled) = collect_and_emit_rag_context(
            &app,
            &state.sea_db,
            &state.master_key,
            state.vector_store.as_ref(),
            &conversation_id,
            &assistant_message_id,
            &stream_id,
            &target_user_content,
            prepared_turn.knowledge_ids.clone(),
            prepared_turn.auto_memory_ids.clone(),
            &cancel_flag,
            &prepared_turn.diagnostics,
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
            let persistence_error_event = persist_terminal_assistant_error(
                &state.sea_db,
                TerminalAssistantErrorPersistence {
                    conversation_id: &conversation_id,
                    message_id: &assistant_message_id,
                    error: "Cancelled",
                },
            )
            .await
            .err()
            .map(|error| {
                tracing::error!(
                    message_id = %assistant_message_id,
                    error = %error,
                    "Failed to persist cancelled target stream"
                );
                build_stream_error_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    &conversation.model_id,
                    &provider.id,
                    error,
                    "message_persistence_error",
                    None,
                )
            });
            let terminal_event = if let Some(error_event) = persistence_error_event.as_ref() {
                build_stream_terminal_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    ChatStreamTerminalOutcome::Error,
                    Some(error_event.error.clone()),
                )
            } else {
                build_stream_terminal_event(
                    &conversation_id,
                    &assistant_message_id,
                    &stream_id,
                    ChatStreamTerminalOutcome::Cancelled,
                    None,
                )
            };
            let internal_terminal = if let Some(error_event) = persistence_error_event.as_ref() {
                crate::multi_model_run::StreamTerminal::Error {
                    message: error_event.error.clone(),
                }
            } else {
                crate::multi_model_run::StreamTerminal::Cancelled
            };

            stream_guard
                .release_then_finalize(
                    (persistence_error_event, terminal_event),
                    |(persistence_error_event, terminal_event)| {
                        if let Some(error_event) = persistence_error_event {
                            emit_stream_error(&app, error_event);
                        }
                        emit_stream_terminal(&app, terminal_event);
                    },
                )
                .await;
            return Ok(crate::multi_model_run::StreamHandle::immediate(
                stream_id,
                assistant_message_id,
                internal_terminal,
            ));
        }
        tag
    };

    let rwm_overrides = resolved_target_model
        .as_ref()
        .and_then(|model| model.param_overrides.clone());
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

    let context_strategy = effective_context_strategy(&conversation, &global_settings);
    let existing_summary_result =
        load_continuation_summary(&state.sea_db, &conversation_id, history_mode).await;
    let existing_summary =
        settle_registered_stream_setup(&mut stream_guard, existing_summary_result, setup_failure)
            .await?;
    let context_boundary = resolve_context_boundary_for_strategy(
        &remaining_messages,
        existing_summary.as_ref(),
        context_strategy,
        Some(&user_msg.id),
    );
    let effective_existing_summary = existing_summary.as_ref().filter(|_| {
        context_strategy == ContextStrategy::SmartSummary && context_boundary.use_summary
    });
    let full_history_result = build_provider_context_messages_with_sources_from_index(
        &file_store,
        &remaining_messages,
        context_boundary.start_index,
        document_attachment_reading_enabled,
        model_context_window,
        Some(&user_msg.id),
        Some(&user_msg.id),
    )
    .map_err(|e| e.to_string());
    let full_history =
        settle_registered_stream_setup(&mut stream_guard, full_history_result, setup_failure)
            .await?;

    let (mcp_ids, tools) = load_mcp_tools_for_model(
        &state.sea_db,
        enabled_mcp_server_ids,
        resolved_target_model.as_ref(),
    )
    .await;
    let tools = merge_memory_tool(tools, &prepared_turn);
    let output_reserve = resolved_context_output_reserve(
        &conversation,
        rwm_overrides.as_ref(),
        &global_settings,
        use_max_completion_tokens,
        force_max_tokens,
        model_max_output_tokens,
    );
    let tool_schema_tokens_result = estimate_tool_schema_tokens(tools.as_deref());
    let tool_schema_tokens =
        settle_registered_stream_setup(&mut stream_guard, tool_schema_tokens_result, setup_failure)
            .await?;
    let input_budget = output_reserve.and_then(|reserve| {
        crate::context_manager::calculate_input_token_budget(
            model_context_window,
            reserve,
            tool_schema_tokens,
        )
    });
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let context_result = prepare_context_with_auto_summary(AutoSummaryContextParams {
        app: &app,
        db: &state.sea_db,
        master_key: &state.master_key,
        conversation_id: &conversation_id,
        conversation: &conversation,
        settings: &global_settings,
        strategy: context_strategy,
        db_messages: &remaining_messages,
        file_store: &file_store,
        history: full_history,
        base_messages: &chat_messages,
        current_user_message_id: &user_msg.id,
        stop_after_message_id: Some(&user_msg.id),
        context_boundary,
        existing_summary: effective_existing_summary,
        document_attachment_reading_enabled,
        model_context_window,
        input_budget,
        provider: &provider,
        decrypted_key: &decrypted_key,
        key_id: &key_row.id,
        proxy_config: &resolved_proxy,
        model_id: &conversation.model_id,
        use_max_completion_tokens,
        persist_generated_summary: should_persist_generated_summary(history_mode),
    })
    .await;
    let context_result =
        settle_registered_stream_setup(&mut stream_guard, context_result, setup_failure).await?;
    if context_result.overflow {
        let context_error = format!(
            "Context still exceeds the target model input budget after applying {:?}: required {} tokens",
            context_strategy, context_result.sent_tokens
        );
        let error = settle_registered_stream_setup::<()>(
            &mut stream_guard,
            Err(context_error),
            setup_failure,
        )
        .await
        .unwrap_err();
        return Ok(crate::multi_model_run::StreamHandle::immediate(
            stream_id,
            assistant_message_id,
            crate::multi_model_run::StreamTerminal::Error { message: error },
        ));
    }
    chat_messages = context_result.messages;
    let stream_context_policy =
        StreamContextPolicy::new(context_strategy, input_budget, &chat_messages);

    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        aws_region: provider.aws_region.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    if no_system_role {
        for msg in &mut chat_messages {
            if msg.role == "system" {
                msg.role = "user".to_string();
            }
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
    Ok(spawn_stream_task(
        app.clone(),
        state.sea_db.clone(),
        conversation_id,
        assistant_message_id,
        stream_id,
        conversation,
        provider,
        ctx,
        chat_messages,
        stream_context_policy,
        is_first_message,
        target_user_content,
        user_msg.id,
        new_version_index,
        tools,
        thinking_budget,
        thinking_level,
        mcp_ids,
        prepared_turn
            .memory_tool
            .as_ref()
            .map(|binding| binding.scope.clone()),
        original_created_at,
        use_max_completion_tokens,
        force_max_tokens,
        thinking_param_style,
        reasoning_profile,
        model_max_output_tokens,
        rwm_overrides,
        global_settings,
        state.master_key,
        cancel_flag,
        stream_guard,
        memory_tag,
        companion,
        true,
    ))
}

fn should_auto_generate_title_for_target(
    message_count: u32,
    forced_version_index: Option<i32>,
) -> bool {
    message_count <= 1 && forced_version_index == Some(0)
}

#[cfg(test)]
mod message_streaming_activation_tests {
    use super::*;

    #[test]
    fn multi_model_first_target_is_the_only_fallback_title_trigger() {
        assert!(should_auto_generate_title_for_target(1, Some(0)));
        assert!(!should_auto_generate_title_for_target(1, Some(1)));
        assert!(!should_auto_generate_title_for_target(2, Some(0)));
        assert!(!should_auto_generate_title_for_target(1, None));
    }

    #[tokio::test]
    async fn new_active_version_survives_deactivating_older_versions() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Stopped stream",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let user = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::User,
            "question",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let previous = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "previous reply",
            &[],
            Some(&user.id),
            0,
        )
        .await
        .unwrap();
        let current = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "partial reply",
            &[],
            Some(&user.id),
            1,
        )
        .await
        .unwrap();

        deactivate_assistant_versions(&db, &conversation.id, &user.id, Some(&current.id))
            .await
            .unwrap();

        let versions =
            aqbot_core::repo::message::list_message_versions(&db, &conversation.id, &user.id)
                .await
                .unwrap();
        assert!(
            !versions
                .iter()
                .find(|message| message.id == previous.id)
                .unwrap()
                .is_active
        );
        assert!(
            versions
                .iter()
                .find(|message| message.id == current.id)
                .unwrap()
                .is_active
        );
    }
}
