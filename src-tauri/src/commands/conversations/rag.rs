// Stream cancellation and RAG context retrieval.

pub(crate) fn apply_cancel_flags(
    flags: &std::collections::HashMap<String, crate::StreamCancelEntry>,
    conversation_id: &str,
    stream_id: Option<&str>,
) -> Vec<std::sync::Arc<AtomicBool>> {
    match stream_id {
        Some(id) => flags
            .get(id)
            .filter(|entry| entry.conversation_id == conversation_id)
            .map(|entry| vec![entry.flag.clone()])
            .unwrap_or_default(),
        None => flags
            .values()
            .filter(|entry| entry.conversation_id == conversation_id)
            .map(|entry| entry.flag.clone())
            .collect(),
    }
}

#[tauri::command]
pub async fn cancel_stream(
    state: State<'_, AppState>,
    conversation_id: String,
    stream_id: Option<String>,
) -> Result<(), String> {
    let flags = state.stream_cancel_flags.lock().await;
    let to_cancel = apply_cancel_flags(&flags, &conversation_id, stream_id.as_deref());
    let cancelled_count = to_cancel.len();
    for flag in to_cancel {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    if cancelled_count == 0 {
        return Err(format!(
            "No active stream matched the cancellation request for conversation {conversation_id}"
        ));
    }

    tracing::info!(
        "[cancel_stream] Cancel requested for conversation {} ({} stream(s))",
        conversation_id,
        cancelled_count
    );
    Ok(())
}

/// Build separate `<knowledge-retrieval>` and `<memory-retrieval>` HTML tags
/// from RAG source results for persistence, split by source type.
pub(crate) fn build_memory_retrieval_tag(sources: &[RagSourceResult]) -> String {
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

pub(crate) fn sanitize_rag_context_result(mut result: RagContextResult) -> RagContextResult {
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

pub(crate) fn sanitize_context_diagnostics(
    diagnostics: &[aqbot_core::types::ContextDiagnostic],
) -> Vec<aqbot_core::types::ContextDiagnostic> {
    let safe = aqbot_core::inline_media::filter_complete_inline_data;
    diagnostics
        .iter()
        .map(|item| aqbot_core::types::ContextDiagnostic {
            code: safe(&item.code),
            source_type: safe(&item.source_type),
            container_id: item.container_id.as_deref().map(safe),
            args: item.args.clone(),
        })
        .collect()
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
    diagnostics: &[aqbot_core::types::ContextDiagnostic],
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
            diagnostics: sanitize_context_diagnostics(diagnostics),
        },
    );

    (rag_result, cancelled)
}
