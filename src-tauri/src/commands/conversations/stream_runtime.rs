// Provider stream consumption and MCP tool execution.

#[derive(Debug)]
enum StreamWaitOutcome<T> {
    Cancelled,
    TimedOut,
    Ready(T),
}

async fn await_next_stream_item<S>(
    stream: &mut S,
    cancel_flag: &AtomicBool,
    timeout: Option<Duration>,
) -> StreamWaitOutcome<Option<S::Item>>
where
    S: futures::Stream + Unpin,
{
    use futures::StreamExt;
    match timeout {
        Some(duration) => {
            tokio::select! {
                biased;
                _ = wait_for_cancel(cancel_flag) => StreamWaitOutcome::Cancelled,
                result = tokio::time::timeout(duration, stream.next()) => match result {
                    Ok(item) => StreamWaitOutcome::Ready(item),
                    Err(_) => StreamWaitOutcome::TimedOut,
                },
            }
        }
        None => {
            tokio::select! {
                biased;
                _ = wait_for_cancel(cancel_flag) => StreamWaitOutcome::Cancelled,
                item = stream.next() => StreamWaitOutcome::Ready(item),
            }
        }
    }
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
        let next_result = match await_next_stream_item(stream, cancel_flag, current_timeout).await {
            StreamWaitOutcome::Cancelled => {
                tracing::info!("[consume_stream] Cancelled by user");
                break;
            }
            StreamWaitOutcome::TimedOut => {
                let timeout = current_timeout.unwrap_or(Duration::from_secs(0));
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
            StreamWaitOutcome::Ready(result) => result,
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
                    if let Some(state) = app.try_state::<AppState>() {
                        state.conversation_runs.update(
                            conversation_id,
                            stream_id,
                            |snapshot| {
                                snapshot.phase = crate::conversation_run::ConversationRunPhase::Streaming;
                                snapshot.message_id = Some(message_id.to_string());
                                snapshot.content = full_content.clone();
                            },
                        );
                    }
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

    let capture_can_commit =
        stream_error.is_none() && !cancel_flag.load(std::sync::atomic::Ordering::Relaxed);
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
/// are left unchanged. Also used by the selection toolbar stream merge.
pub(crate) fn fixup_think_tags(content: &str, durations: &[u64]) -> String {
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
                aqbot_core::mcp_client::truncate_mcp_tool_result_content(
                    &result.content,
                    MCP_TOOL_RESULT_MAX_BYTES,
                ),
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
    mcp_stdio_clients: &StdioClientManager,
    tool_call: &ToolCall,
    mcp_server_ids: &[String],
    cancel_flag: &AtomicBool,
    memory_tool_scope: Option<&aqbot_core::context_engine::MemoryToolScope>,
) -> (String, bool) {
    if tool_call.function.name == aqbot_core::context_engine::MEMORY_TOOL_NAME {
        let Some(scope) = memory_tool_scope else {
            return (
                "Error: Memory tool is not bound for this turn".to_string(),
                true,
            );
        };
        let arguments: serde_json::Value = serde_json::from_str(&tool_call.function.arguments)
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
        return match aqbot_core::context_engine::execute_memory_tool(db, scope, arguments).await {
            Ok(content) => (content, false),
            Err(error) => (error.to_string(), true),
        };
    }

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

    execute_tool_future(
        aqbot_core::mcp_client::call_tool_for_server(
            mcp_stdio_clients,
            &server,
            &tool_call.function.name,
            arguments,
        ),
        timeout_secs,
        timeout_duration,
        cancel_flag,
    )
    .await
}
