// Conversation context compression.

struct GeneratedCompression {
    summary_text: String,
    used_model: String,
    source_text: String,
    token_count: u32,
}

/// Internal helper: call the configured LLM to compress messages without
/// deciding whether the generated summary should be persisted.
async fn generate_compression(
    db: &sea_orm::DatabaseConnection,
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
) -> Result<GeneratedCompression, String> {
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
                        let override_umc = get_optional_model(db, pid, mid)
                            .await?
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
            Err(aqbot_core::error::AQBotError::NotFound(_)) => {
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
            Err(error) => {
                return Err(format!("Failed to load compression provider: {error}"));
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

    let source_text = crate::context_manager::format_compression_source_text(&sum_req);
    let custom_prompt = settings.compression_prompt.as_deref();
    let compression_model_context_window =
        get_optional_model(db, &comp_provider.id, &comp_model_id)
            .await?
            .and_then(|model| model.context_window);
    let compression_input_budget = crate::context_manager::calculate_input_token_budget(
        compression_model_context_window,
        settings.compression_max_tokens.unwrap_or(1024) as usize,
        0,
    );
    let (response_content, used_model) = generate_compression_summary(
        &comp_provider,
        &comp_key,
        &comp_key_id,
        &comp_proxy,
        &comp_model_id,
        comp_use_max,
        history_messages,
        existing_summary,
        custom_prompt,
        compression_input_budget,
        settings,
    )
    .await?;

    Ok(GeneratedCompression {
        token_count: aqbot_core::token_counter::estimate_tokens(&response_content) as u32,
        summary_text: response_content,
        used_model,
        source_text,
    })
}

/// Call the compression LLM and persist the shared conversation summary and
/// marker atomically. This remains the selected-history behavior.
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
) -> Result<(ConversationSummary, Message), String> {
    let generated = generate_compression(
        db,
        history_messages,
        existing_summary,
        provider,
        decrypted_key,
        key_id,
        proxy_config,
        model_id,
        use_max_completion_tokens,
        settings,
        master_key,
    )
    .await?;
    let (summary, marker_message) = aqbot_core::repo::conversation::upsert_summary_with_marker(
        db,
        conversation_id,
        &generated.summary_text,
        compressed_until_message_id,
        Some(generated.token_count),
        Some(&generated.used_model),
        Some(&generated.source_text),
        crate::context_manager::COMPRESSION_MARKER,
    )
    .await
    .map_err(|e| format!("Failed to save summary and marker atomically: {e}"))?;

    tracing::debug!(
        "Compressed context for {} ({} tokens)",
        conversation_id,
        generated.token_count
    );
    Ok((summary, marker_message))
}

/// Per-model continuation summaries are request-local: the shared summary and
/// compression marker must not be updated with a model-specific projection.
async fn do_compress_temporary(
    db: &sea_orm::DatabaseConnection,
    history_messages: &[ChatMessage],
    provider: &ProviderConfig,
    decrypted_key: &str,
    key_id: &str,
    proxy_config: &Option<ProviderProxyConfig>,
    model_id: &str,
    use_max_completion_tokens: Option<bool>,
    settings: &AppSettings,
    master_key: &[u8; 32],
) -> Result<String, String> {
    generate_compression(
        db,
        history_messages,
        None,
        provider,
        decrypted_key,
        key_id,
        proxy_config,
        model_id,
        use_max_completion_tokens,
        settings,
        master_key,
    )
    .await
    .map(|generated| generated.summary_text)
}

async fn generate_compression_summary(
    comp_provider: &ProviderConfig,
    comp_key: &str,
    comp_key_id: &str,
    comp_proxy: &Option<ProviderProxyConfig>,
    comp_model_id: &str,
    comp_use_max: Option<bool>,
    source_messages: &[ChatMessage],
    initial_summary: Option<&str>,
    custom_prompt: Option<&str>,
    compression_input_budget: Option<usize>,
    settings: &AppSettings,
) -> Result<(String, String), String> {
    // Leave ample room for the system/footer framing and the rolling summary.
    // Every concrete prompt is checked below before any provider call.
    let chunk_budget = compression_input_budget
        .map(|budget| budget / 4)
        .unwrap_or(8_192);
    let chunks = crate::context_manager::chunk_messages_for_summary(source_messages, chunk_budget)?;
    if chunks.is_empty() {
        return Err("No messages to compress".to_string());
    }

    let output_cap = settings.compression_max_tokens.unwrap_or(1024) as usize;
    let mut rolling_summary = initial_summary.map(str::to_string);
    let mut used_model = comp_model_id.to_string();
    let mut pending_chunks = VecDeque::from(chunks);
    while let Some(chunk) = pending_chunks.pop_front() {
        let request = crate::context_manager::SummarizationRequest {
            existing_summary: rolling_summary.clone(),
            messages_to_compress: chunk,
        };
        let summary_messages = if let Some(prompt) = custom_prompt {
            crate::context_manager::build_summary_prompt_with_custom(&request, prompt)
        } else {
            crate::context_manager::build_summary_prompt(&request)
        };
        let prompt_tokens = summary_messages
            .iter()
            .map(crate::context_manager::message_tokens)
            .sum::<usize>();
        if let Some(input_budget) = compression_input_budget {
            if prompt_tokens > input_budget {
                let source_tokens = request
                    .messages_to_compress
                    .iter()
                    .map(crate::context_manager::message_tokens)
                    .sum::<usize>();
                if source_tokens <= 1 {
                    return Err(format!(
                        "Compression prompt framing exceeds the model input budget: required {prompt_tokens} tokens, available {input_budget}"
                    ));
                }
                let smaller_chunks = crate::context_manager::chunk_messages_for_summary(
                    &request.messages_to_compress,
                    (source_tokens / 2).max(1),
                )?;
                for smaller_chunk in smaller_chunks.into_iter().rev() {
                    pending_chunks.push_front(smaller_chunk);
                }
                continue;
            }
        }

        let (response_content, response_model, completion_tokens) = run_compression_llm(
            comp_provider,
            comp_key,
            comp_key_id,
            comp_proxy,
            comp_model_id,
            comp_use_max,
            summary_messages,
            settings,
        )
        .await?;
        let measured_output_tokens = if completion_tokens > 0 {
            completion_tokens as usize
        } else {
            aqbot_core::token_counter::estimate_tokens(&response_content)
        };
        if measured_output_tokens > output_cap {
            return Err(format!(
                "Generated summary exceeds the configured output limit: {measured_output_tokens} > {output_cap}"
            ));
        }
        rolling_summary = Some(response_content);
        used_model = response_model;
    }

    rolling_summary
        .map(|summary| (summary, used_model))
        .ok_or_else(|| "Summary generation completed without producing summary content".to_string())
}

/// Shared LLM call for compression / retry.
async fn run_compression_llm(
    comp_provider: &ProviderConfig,
    comp_key: &str,
    comp_key_id: &str,
    comp_proxy: &Option<ProviderProxyConfig>,
    comp_model_id: &str,
    comp_use_max: Option<bool>,
    summary_messages: Vec<ChatMessage>,
    settings: &AppSettings,
) -> Result<(String, String, u32), String> {
    let request = ChatRequest {
        model: comp_model_id.to_string(),
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
        api_key: comp_key.to_string(),
        key_id: comp_key_id.to_string(),
        provider_id: comp_provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &comp_provider.api_host,
            &comp_provider.provider_type,
        )),
        api_path: comp_provider.api_path.clone(),
        aws_region: comp_provider.aws_region.clone(),
        proxy_config: comp_proxy.clone(),
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
    if response.content.trim().is_empty() {
        return Err("Summary generation returned empty content".to_string());
    }

    Ok((
        response.content,
        comp_model_id.to_string(),
        response.usage.completion_tokens,
    ))
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
        .map_err(|error| format!("Failed to load app settings: {error}"))?;
    if effective_context_strategy(&conversation, &global_settings) != ContextStrategy::SmartSummary
    {
        return Err(
            "Manual compression is available only when the conversation uses smart_summary"
                .to_string(),
        );
    }
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
            .map_err(|error| format!("Failed to load context summary: {error}"))?;
    let context_boundary = resolve_context_boundary(&db_messages, existing_summary.as_ref());
    let keep_last_n = crate::context_manager::resolve_compression_keep_last_n(
        conversation.compression_keep_last_n,
        global_settings.default_compression_keep_last_n,
    );

    let mut boundary_start_index = context_boundary.start_index;
    let mut compressed_until_message_id =
        resolve_compressed_until_with_keep(&db_messages, boundary_start_index, keep_last_n, None);

    // Fall back: if nothing remains after the summary boundary, rebuild only
    // from the last explicit clear. Cleared history must never re-enter a new
    // summary.
    if compressed_until_message_id.is_none() && boundary_start_index > 0 {
        boundary_start_index = raw_context_start_index(&db_messages, None);
        compressed_until_message_id = resolve_compressed_until_with_keep(
            &db_messages,
            boundary_start_index,
            keep_last_n,
            None,
        );
    }

    let Some(compressed_until_message_id) = compressed_until_message_id else {
        return Err("No messages to compress (not enough beyond keep-last-N)".to_string());
    };

    let history_messages = build_provider_context_messages_from_index(
        &file_store,
        &db_messages,
        boundary_start_index,
        global_settings.document_attachment_reading_enabled,
        None,
        None,
        Some(&compressed_until_message_id),
    )
    .map_err(|e| e.to_string())?;

    if history_messages.is_empty() {
        return Err("No messages to compress".to_string());
    }

    let effective_existing_summary = existing_summary.as_ref().filter(|_| {
        context_boundary.use_summary && boundary_start_index == context_boundary.start_index
    });

    // Compress
    let use_max_completion_tokens = get_optional_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await?
    .and_then(|m| m.param_overrides)
    .and_then(|p| p.use_max_completion_tokens);

    let (summary, marker_msg) = do_compress(
        &state.sea_db,
        &conversation_id,
        &history_messages,
        effective_existing_summary.map(|s| s.summary_text.as_str()),
        Some(&compressed_until_message_id),
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

/// Tauri command: re-run compression on the stored source text with the current
/// global compression prompt. Does not change the boundary or insert a new marker.
#[tauri::command]
pub async fn retry_compression(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ConversationSummary, String> {
    let conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

    let existing = aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No compression summary to retry".to_string())?;

    let source_text = existing
        .source_text
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            "No compression source text saved (legacy summary). Compress again to enable retry."
                .to_string()
        })?;

    let provider =
        aqbot_core::repo::provider::get_provider(&state.sea_db, &conversation.provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let fallback_key_id = provider
        .keys
        .first()
        .map(|k| k.id.clone())
        .ok_or_else(|| "No API key configured".to_string())?;
    let fallback_key_encrypted = provider
        .keys
        .first()
        .map(|k| k.key_encrypted.clone())
        .ok_or_else(|| "No API key configured".to_string())?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&fallback_key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;

    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|error| format!("Failed to load app settings: {error}"))?;
    if effective_context_strategy(&conversation, &global_settings) != ContextStrategy::SmartSummary
    {
        return Err(
            "Compression retry is available only when the conversation uses smart_summary"
                .to_string(),
        );
    }
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    // Resolve compression model (same cascade as do_compress)
    let (comp_provider, comp_key, comp_key_id, comp_proxy, comp_model_id, comp_use_max) = if let (
        Some(ref pid),
        Some(ref mid),
    ) = (
        &global_settings.compression_provider_id,
        &global_settings.compression_model_id,
    ) {
        match aqbot_core::repo::provider::get_provider(&state.sea_db, pid).await {
            Ok(p) => {
                let first_key = p.keys.first().cloned();
                match first_key {
                    Some(k) => {
                        let dk =
                            aqbot_core::crypto::decrypt_key(&k.key_encrypted, &state.master_key)
                                .map_err(|e| e.to_string())?;
                        let override_umc = get_optional_model(&state.sea_db, pid, mid)
                            .await?
                            .and_then(|m| m.param_overrides)
                            .and_then(|po| po.use_max_completion_tokens);
                        let proxy = ProviderProxyConfig::resolve(&p.proxy_config, &global_settings);
                        (p, dk, k.id, proxy, mid.clone(), override_umc)
                    }
                    None => (
                        provider.clone(),
                        decrypted_key.clone(),
                        fallback_key_id.clone(),
                        resolved_proxy.clone(),
                        conversation.model_id.clone(),
                        get_optional_model(
                            &state.sea_db,
                            &conversation.provider_id,
                            &conversation.model_id,
                        )
                        .await?
                        .and_then(|m| m.param_overrides)
                        .and_then(|po| po.use_max_completion_tokens),
                    ),
                }
            }
            Err(aqbot_core::error::AQBotError::NotFound(_)) => (
                provider.clone(),
                decrypted_key.clone(),
                fallback_key_id.clone(),
                resolved_proxy.clone(),
                conversation.model_id.clone(),
                None,
            ),
            Err(error) => {
                return Err(format!("Failed to load compression provider: {error}"));
            }
        }
    } else {
        let use_max = get_optional_model(
            &state.sea_db,
            &conversation.provider_id,
            &conversation.model_id,
        )
        .await?
        .and_then(|m| m.param_overrides)
        .and_then(|po| po.use_max_completion_tokens);
        (
            provider,
            decrypted_key,
            fallback_key_id,
            resolved_proxy,
            conversation.model_id.clone(),
            use_max,
        )
    };

    let system_prompt = global_settings
        .compression_prompt
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| crate::context_manager::default_compression_instruction(false));

    let compression_model_context_window =
        get_optional_model(&state.sea_db, &comp_provider.id, &comp_model_id)
            .await?
            .and_then(|model| model.context_window);
    let compression_input_budget = crate::context_manager::calculate_input_token_budget(
        compression_model_context_window,
        global_settings.compression_max_tokens.unwrap_or(1024) as usize,
        0,
    );
    let source_message = ChatMessage {
        role: "user".to_string(),
        content: ChatContent::Text(source_text.to_string()),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    };
    let (response_content, used_model) = generate_compression_summary(
        &comp_provider,
        &comp_key,
        &comp_key_id,
        &comp_proxy,
        &comp_model_id,
        comp_use_max,
        &[source_message],
        None,
        Some(system_prompt),
        compression_input_budget,
        &global_settings,
    )
    .await?;

    let token_count = aqbot_core::token_counter::estimate_tokens(&response_content);
    let summary = aqbot_core::repo::conversation::update_summary_text(
        &state.sea_db,
        &conversation_id,
        &response_content,
        Some(token_count as u32),
        Some(&used_model),
    )
    .await
    .map_err(|e| e.to_string())?;

    ensure_conversation_summary_safe_for_ipc(&summary)?;

    let _ = app.emit("conversation:summary-updated", summary.clone());

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
        ("source_text", summary.source_text.as_deref()),
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
    let resolved_model = get_optional_model(
        &state.sea_db,
        &conversation.provider_id,
        &conversation.model_id,
    )
    .await?;
    let model_context_window = resolved_model.as_ref().and_then(|m| m.context_window);
    let model_max_output_tokens = resolved_model
        .as_ref()
        .and_then(|model| model.max_output_tokens);
    let model_param_overrides = resolved_model
        .as_ref()
        .and_then(|model| model.param_overrides.clone());
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|error| format!("Failed to load app settings: {error}"))?;
    let db_messages =
        aqbot_core::repo::message::list_messages_for_model_context(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let context_strategy = effective_context_strategy(&conversation, &global_settings);
    let existing_summary =
        aqbot_core::repo::conversation::get_summary(&state.sea_db, &conversation_id)
            .await
            .map_err(|error| format!("Failed to load context summary: {error}"))?;
    let context_boundary = resolve_context_boundary_for_strategy(
        &db_messages,
        existing_summary.as_ref(),
        context_strategy,
        None,
    );
    let effective_existing_summary = existing_summary.as_ref().filter(|_| {
        context_strategy == ContextStrategy::SmartSummary && context_boundary.use_summary
    });

    let file_store = aqbot_core::file_store::FileStore::new();
    let full_history_messages = build_provider_context_messages_from_index(
        &file_store,
        &db_messages,
        context_boundary.start_index,
        global_settings.document_attachment_reading_enabled,
        model_context_window,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;
    let raw_start_index = raw_context_start_index(&db_messages, None);
    let raw_history_messages = if raw_start_index == context_boundary.start_index {
        full_history_messages.clone()
    } else {
        build_provider_context_messages_from_index(
            &file_store,
            &db_messages,
            raw_start_index,
            global_settings.document_attachment_reading_enabled,
            model_context_window,
            None,
            None,
        )
        .map_err(|e| e.to_string())?
    };
    let summarized_message_count = effective_existing_summary
        .is_some()
        .then(|| {
            raw_history_messages
                .len()
                .saturating_sub(full_history_messages.len())
        })
        .unwrap_or(0);
    let (history_messages, count_excluded) = history_for_context_strategy(
        full_history_messages,
        &conversation,
        &global_settings,
        context_strategy,
    );

    let mut system_messages = Vec::new();
    if let Some(system_prompt) = resolve_system_prompt(&state.sea_db, &conversation).await? {
        system_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(system_prompt),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }
    let (_, tools) = load_mcp_tools_for_model(
        &state.sea_db,
        Some(conversation.enabled_mcp_server_ids.clone()),
        resolved_model.as_ref(),
    )
    .await;
    let output_reserve = resolved_context_output_reserve(
        &conversation,
        model_param_overrides.as_ref(),
        &global_settings,
        model_param_overrides
            .as_ref()
            .and_then(|params| params.use_max_completion_tokens),
        model_param_overrides
            .as_ref()
            .and_then(|params| params.force_max_tokens),
        model_max_output_tokens,
    );
    let tool_schema_tokens = estimate_tool_schema_tokens(tools.as_deref())?;
    let input_budget = output_reserve.and_then(|reserve| {
        crate::context_manager::calculate_input_token_budget(
            model_context_window,
            reserve,
            tool_schema_tokens,
        )
    });
    let raw_tokens = system_messages
        .iter()
        .chain(raw_history_messages.iter())
        .map(crate::context_manager::message_tokens)
        .sum::<usize>();

    let (sent_tokens, mut excluded_message_count, mut exclusion_reason, overflow) =
        if context_strategy == ContextStrategy::RawStrict {
            let overflow = input_budget.is_none_or(|budget| raw_tokens > budget);
            (
                if overflow { 0 } else { raw_tokens },
                0,
                if overflow {
                    Some(if input_budget.is_none() {
                        if model_context_window.is_none() {
                            "context_window_unknown".to_string()
                        } else {
                            "context_budget_unknown".to_string()
                        }
                    } else {
                        "input_budget_exceeded".to_string()
                    })
                } else {
                    None
                },
                overflow,
            )
        } else {
            let result = crate::context_manager::build_context_for_strategy(
                &system_messages,
                &history_messages,
                effective_existing_summary.map(|summary| summary.summary_text.as_str()),
                context_strategy,
                input_budget,
            )?;
            (
                result.sent_tokens,
                result.excluded_message_count,
                result.exclusion_reason,
                result.overflow,
            )
        };
    excluded_message_count += summarized_message_count + count_excluded;
    if !overflow {
        if summarized_message_count > 0 {
            exclusion_reason = Some(crate::context_manager::EXCLUSION_REASON_SMART_SUMMARY.into());
        } else if count_excluded > 0 && exclusion_reason.is_none() {
            exclusion_reason = Some("message_limit".to_string());
        }
    }
    let threshold_tokens = input_budget.map(|budget| budget.min(u32::MAX as usize) as u32);

    Ok(ContextUsage {
        used_tokens: sent_tokens.min(u32::MAX as usize) as u32,
        context_window: model_context_window,
        threshold_tokens,
        has_summary: effective_existing_summary.is_some(),
        compressed_until_message_id: effective_existing_summary
            .and_then(|summary| summary.compressed_until_message_id.clone()),
        messages_after_boundary: count_compressible_messages_from_start(
            &db_messages,
            context_boundary.start_index,
        ),
        effective_strategy: context_strategy,
        raw_tokens: raw_tokens.min(u32::MAX as usize) as u32,
        sent_tokens: sent_tokens.min(u32::MAX as usize) as u32,
        excluded_message_count: excluded_message_count.min(u32::MAX as usize) as u32,
        exclusion_reason,
        overflow,
    })
}

/// Tauri command: delete the compression summary and all marker messages.
#[tauri::command]
pub async fn delete_compression(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    aqbot_core::repo::conversation::delete_summary_and_markers(
        &state.sea_db,
        &conversation_id,
        crate::context_manager::COMPRESSION_MARKER,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_system_message(
    state: State<'_, AppState>,
    conversation_id: String,
    content: String,
) -> Result<Message, String> {
    let prepared_inline_media = aqbot_core::inline_media::prepare_message_inline_images(&content)
        .map_err(|error| {
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
