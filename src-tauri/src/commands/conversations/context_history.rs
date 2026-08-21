// Conversation history boundaries and provider context construction.

#[cfg(test)]
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

/// Raw context modes deliberately ignore compression markers. A user-created
/// context-clear marker is the only boundary that may hide original messages.
fn raw_context_start_index(db_messages: &[Message], stop_after_message_id: Option<&str>) -> usize {
    let stop_index = stop_after_message_id.and_then(|message_id| {
        db_messages
            .iter()
            .position(|message| message.id == message_id)
    });
    let marker_search_end = stop_index.unwrap_or(db_messages.len());
    db_messages[..marker_search_end]
        .iter()
        .rposition(is_context_clear_marker)
        .map(|idx| idx + 1)
        .unwrap_or(0)
}

fn resolve_context_boundary(
    db_messages: &[Message],
    existing_summary: Option<&ConversationSummary>,
) -> ContextBoundary {
    resolve_smart_context_boundary(db_messages, existing_summary, None)
}

fn resolve_smart_context_boundary(
    db_messages: &[Message],
    existing_summary: Option<&ConversationSummary>,
    stop_after_message_id: Option<&str>,
) -> ContextBoundary {
    let Some(summary) = existing_summary else {
        return ContextBoundary {
            start_index: raw_context_start_index(db_messages, stop_after_message_id),
            use_summary: false,
        };
    };
    let stop_index = stop_after_message_id.and_then(|message_id| {
        db_messages
            .iter()
            .position(|message| message.id == message_id)
    });
    let boundary_search_end = stop_index.unwrap_or(db_messages.len());

    if let Some(boundary_id) = summary.compressed_until_message_id.as_deref() {
        if let Some(boundary_idx) = db_messages
            .iter()
            .position(|message| message.id == boundary_id)
        {
            // A latest summary that reaches the regeneration target (or a
            // later message) contains future context and must stay dormant.
            if boundary_idx >= boundary_search_end {
                return ContextBoundary {
                    start_index: raw_context_start_index(db_messages, stop_after_message_id),
                    use_summary: false,
                };
            }
            if let Some(clear_idx) = db_messages
                .iter()
                .enumerate()
                .skip(boundary_idx + 1)
                .take(boundary_search_end.saturating_sub(boundary_idx + 1))
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

    let marker_idx = db_messages[..boundary_search_end]
        .iter()
        .rposition(is_context_boundary_marker);
    ContextBoundary {
        start_index: marker_idx.map(|idx| idx + 1).unwrap_or(0),
        use_summary: marker_idx
            .map(|idx| is_context_compression_marker(&db_messages[idx]))
            // A legacy summary without a verifiable boundary is unsafe for
            // historical regeneration because it may contain future turns.
            .unwrap_or(stop_after_message_id.is_none()),
    }
}

fn resolve_context_boundary_for_strategy(
    db_messages: &[Message],
    existing_summary: Option<&ConversationSummary>,
    strategy: ContextStrategy,
    stop_after_message_id: Option<&str>,
) -> ContextBoundary {
    if strategy == ContextStrategy::SmartSummary {
        return resolve_smart_context_boundary(
            db_messages,
            existing_summary,
            stop_after_message_id,
        );
    }

    ContextBoundary {
        start_index: raw_context_start_index(db_messages, stop_after_message_id),
        use_summary: false,
    }
}

fn effective_context_strategy(
    conversation: &Conversation,
    settings: &AppSettings,
) -> ContextStrategy {
    crate::context_manager::resolve_context_strategy(
        conversation.context_strategy_override,
        settings.default_context_strategy,
    )
}

fn should_persist_generated_summary(history_mode: MultiModelContinuationMode) -> bool {
    history_mode == MultiModelContinuationMode::Selected
}

async fn load_continuation_summary(
    db: &DatabaseConnection,
    conversation_id: &str,
    history_mode: MultiModelContinuationMode,
) -> Result<Option<ConversationSummary>, String> {
    if !should_persist_generated_summary(history_mode) {
        return Ok(None);
    }

    aqbot_core::repo::conversation::get_summary(db, conversation_id)
        .await
        .map_err(|error| format!("Failed to load context summary: {error}"))
}

fn is_compressible_boundary_message(message: &Message) -> bool {
    message.is_active
        && message.status != "error"
        && !is_context_boundary_marker(message)
        && message.role != MessageRole::Tool
}

/// Pick `compressed_until_message_id` so the last `keep_last_n` compressible
/// messages (and everything from `force_retain_from_id` onward) stay cleartext.
///
/// Returns `None` when there is nothing left to compress.
fn resolve_compressed_until_with_keep(
    db_messages: &[Message],
    start_index: usize,
    keep_last_n: u32,
    force_retain_from_id: Option<&str>,
) -> Option<String> {
    let force_idx =
        force_retain_from_id.and_then(|id| db_messages.iter().position(|message| message.id == id));

    let compressible_indices: Vec<usize> = db_messages
        .iter()
        .enumerate()
        .skip(start_index)
        .filter(|(_, message)| is_compressible_boundary_message(message))
        .map(|(idx, _)| idx)
        .collect();

    if compressible_indices.is_empty() {
        return None;
    }

    let keep_start_by_n = compressible_indices
        .len()
        .saturating_sub(keep_last_n as usize);
    let keep_start_by_force = force_idx
        .and_then(|force| compressible_indices.iter().position(|&idx| idx >= force))
        .unwrap_or(compressible_indices.len());
    let keep_start = keep_start_by_n.min(keep_start_by_force);

    if keep_start == 0 {
        return None;
    }

    let mut boundary_position = keep_start - 1;
    let boundary_message = &db_messages[compressible_indices[boundary_position]];
    let splits_answered_turn = boundary_message.role == MessageRole::User
        && compressible_indices
            .iter()
            .skip(boundary_position + 1)
            .map(|&index| &db_messages[index])
            .take_while(|message| message.role != MessageRole::User)
            .any(|message| {
                message.role == MessageRole::Assistant
                    && message.parent_message_id.as_deref() == Some(boundary_message.id.as_str())
            });
    if splits_answered_turn {
        if boundary_position == 0 {
            return None;
        }
        boundary_position -= 1;
    }

    Some(
        db_messages[compressible_indices[boundary_position]]
            .id
            .clone(),
    )
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

#[cfg(test)]
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

/// Apply the conversation / global message-count cap to provider history.
fn limit_provider_history_with_count(
    history: Vec<ChatMessage>,
    conversation: &Conversation,
    settings: &AppSettings,
) -> (Vec<ChatMessage>, usize) {
    let limit = crate::context_manager::resolve_message_count_limit(
        conversation.context_message_limit,
        settings.default_context_count,
    );
    let original_len = history.len();
    let limited = crate::context_manager::apply_message_count_limit(&history, limit);
    let excluded = original_len.saturating_sub(limited.len());
    (limited, excluded)
}

fn history_for_context_strategy(
    history: Vec<ChatMessage>,
    conversation: &Conversation,
    settings: &AppSettings,
    strategy: ContextStrategy,
) -> (Vec<ChatMessage>, usize) {
    if strategy == ContextStrategy::RawStrict {
        (history, 0)
    } else {
        limit_provider_history_with_count(history, conversation, settings)
    }
}

struct ProviderHistoryWithSources {
    messages: Vec<ChatMessage>,
    source_indices: Vec<usize>,
}

struct AutoSummaryContextParams<'a> {
    app: &'a tauri::AppHandle,
    db: &'a DatabaseConnection,
    master_key: &'a [u8; 32],
    conversation_id: &'a str,
    conversation: &'a Conversation,
    settings: &'a AppSettings,
    strategy: ContextStrategy,
    db_messages: &'a [Message],
    file_store: &'a aqbot_core::file_store::FileStore,
    history: ProviderHistoryWithSources,
    base_messages: &'a [ChatMessage],
    current_user_message_id: &'a str,
    stop_after_message_id: Option<&'a str>,
    context_boundary: ContextBoundary,
    existing_summary: Option<&'a ConversationSummary>,
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    input_budget: Option<usize>,
    provider: &'a ProviderConfig,
    decrypted_key: &'a str,
    key_id: &'a str,
    proxy_config: &'a Option<ProviderProxyConfig>,
    model_id: &'a str,
    use_max_completion_tokens: Option<bool>,
    persist_generated_summary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutoCompressionBoundary {
    start_index: usize,
    compressed_until_index: usize,
    compressed_until_message_id: String,
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
    Ok(build_provider_context_messages_with_sources_from_index(
        file_store,
        db_messages,
        effective_start,
        document_attachment_reading_enabled,
        model_context_window,
        current_user_message_id,
        stop_after_message_id,
    )?
    .messages)
}

fn build_provider_context_messages_with_sources_from_index(
    file_store: &aqbot_core::file_store::FileStore,
    db_messages: &[Message],
    effective_start: usize,
    document_attachment_reading_enabled: bool,
    model_context_window: Option<u32>,
    current_user_message_id: Option<&str>,
    stop_after_message_id: Option<&str>,
) -> aqbot_core::error::Result<ProviderHistoryWithSources> {
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
    let mut source_indices = Vec::new();
    for (relative_index, message) in db_messages[effective_start..].iter().enumerate() {
        if is_context_boundary_marker(message) || message.status == "error" {
            continue;
        }
        if !message.is_active || message.role == MessageRole::Tool {
            continue;
        }

        let source_index = effective_start + relative_index;
        out.push(visible_history_chat_message(
            file_store,
            message,
            document_attachment_reading_enabled,
            model_context_window,
            current_user_message_id == Some(message.id.as_str()),
        )?);
        source_indices.push(source_index);

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
                        source_indices.extend(std::iter::repeat(source_index).take(group.len()));
                        out.extend(group);
                    }
                }
            }
        }
    }

    Ok(ProviderHistoryWithSources {
        messages: out,
        source_indices,
    })
}

fn limited_history_db_start_index(
    default_start_index: usize,
    source_indices: &[usize],
    excluded_message_count: usize,
) -> Result<usize, String> {
    if excluded_message_count == 0 {
        return Ok(default_start_index);
    }

    source_indices
        .get(excluded_message_count)
        .copied()
        .ok_or_else(|| "Message-limit provenance is inconsistent with provider history".to_string())
}

fn resolve_auto_compression_boundary(
    db_messages: &[Message],
    default_start_index: usize,
    source_indices: &[usize],
    count_excluded: usize,
    keep_last_n: u32,
    current_user_message_id: &str,
) -> Result<AutoCompressionBoundary, String> {
    let start_index =
        limited_history_db_start_index(default_start_index, source_indices, count_excluded)?;
    let compressed_until_message_id = resolve_compressed_until_with_keep(
        db_messages,
        start_index,
        keep_last_n,
        Some(current_user_message_id),
    )
    .ok_or_else(|| {
        "Context exceeds the model budget, but keep-last-N leaves no messages to summarize"
            .to_string()
    })?;
    let compressed_until_index = db_messages
        .iter()
        .position(|message| message.id == compressed_until_message_id)
        .ok_or_else(|| "Compression boundary message disappeared".to_string())?;

    Ok(AutoCompressionBoundary {
        start_index,
        compressed_until_index,
        compressed_until_message_id,
    })
}

fn add_message_limit_metadata(
    mut result: crate::context_manager::ContextBuildResult,
    count_excluded: usize,
) -> crate::context_manager::ContextBuildResult {
    result.excluded_message_count += count_excluded;
    if count_excluded > 0 && result.exclusion_reason.is_none() {
        result.exclusion_reason = Some("message_limit".to_string());
    }
    result
}

async fn prepare_context_with_auto_summary(
    params: AutoSummaryContextParams<'_>,
) -> Result<crate::context_manager::ContextBuildResult, String> {
    let ProviderHistoryWithSources {
        messages: full_history,
        source_indices,
    } = params.history;
    let (budget_history, count_excluded) = history_for_context_strategy(
        full_history,
        params.conversation,
        params.settings,
        params.strategy,
    );
    let preliminary = crate::context_manager::build_context_for_strategy(
        params.base_messages,
        &budget_history,
        params
            .existing_summary
            .map(|summary| summary.summary_text.as_str()),
        params.strategy,
        params.input_budget,
    )?;

    if params.strategy != ContextStrategy::SmartSummary
        || !preliminary.overflow
        || budget_history.is_empty()
    {
        return Ok(add_message_limit_metadata(preliminary, count_excluded));
    }

    let keep_last_n = crate::context_manager::resolve_compression_keep_last_n(
        params.conversation.compression_keep_last_n,
        params.settings.default_compression_keep_last_n,
    );
    let boundary = resolve_auto_compression_boundary(
        params.db_messages,
        params.context_boundary.start_index,
        &source_indices,
        count_excluded,
        keep_last_n,
        params.current_user_message_id,
    )?;
    let messages_to_compress = build_provider_context_messages_from_index(
        params.file_store,
        params.db_messages,
        boundary.start_index,
        params.document_attachment_reading_enabled,
        params.model_context_window,
        None,
        Some(&boundary.compressed_until_message_id),
    )
    .map_err(|error| error.to_string())?;
    if messages_to_compress.is_empty() {
        return Err(
            "Context exceeds the model budget, but keep-last-N leaves no messages to summarize"
                .to_string(),
        );
    }
    let post_compression_history = build_provider_context_messages_from_index(
        params.file_store,
        params.db_messages,
        boundary.compressed_until_index + 1,
        params.document_attachment_reading_enabled,
        params.model_context_window,
        Some(params.current_user_message_id),
        params.stop_after_message_id,
    )
    .map_err(|error| error.to_string())?;

    let generated_summary = if params.persist_generated_summary {
        let (summary, marker_message) = do_compress(
            params.db,
            params.conversation_id,
            &messages_to_compress,
            params
                .existing_summary
                .map(|summary| summary.summary_text.as_str()),
            Some(&boundary.compressed_until_message_id),
            params.provider,
            params.decrypted_key,
            params.key_id,
            params.proxy_config,
            params.model_id,
            params.use_max_completion_tokens,
            params.settings,
            params.master_key,
        )
        .await?;

        if let Err(error) = params.app.emit(
            "conversation:compressed",
            CompressionEvent {
                conversation_id: params.conversation_id.to_string(),
                marker_message,
                summary: summary.clone(),
            },
        ) {
            tracing::warn!(
                conversation_id = params.conversation_id,
                %error,
                "Failed to emit automatic context compression event"
            );
        }
        summary.summary_text
    } else {
        do_compress_temporary(
            params.db,
            &messages_to_compress,
            params.provider,
            params.decrypted_key,
            params.key_id,
            params.proxy_config,
            params.model_id,
            params.use_max_completion_tokens,
            params.settings,
            params.master_key,
        )
        .await?
    };

    let (limited_post_history, post_count_excluded) = limit_provider_history_with_count(
        post_compression_history,
        params.conversation,
        params.settings,
    );
    let result = crate::context_manager::build_context_for_strategy(
        params.base_messages,
        &limited_post_history,
        Some(&generated_summary),
        params.strategy,
        params.input_budget,
    )?;
    Ok(add_message_limit_metadata(result, post_count_excluded))
}

#[cfg(test)]
fn split_auto_compression_history(
    history_messages: &[ChatMessage],
    current_user_index: Option<usize>,
    keep_last_n: u32,
) -> (Vec<ChatMessage>, Vec<ChatMessage>) {
    crate::context_manager::split_history_keep_last(
        history_messages,
        keep_last_n,
        current_user_index,
    )
}
