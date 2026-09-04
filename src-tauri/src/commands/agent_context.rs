use aqbot_core::context_engine::PreparedTurn;
use aqbot_core::types::{
    ContextDiagnostic, RagContextResult, RagContextRetrievedEvent, RagSourceError,
};
use aqbot_core::vector_store::VectorStore;
use open_agent_sdk::CancellationToken;
use sea_orm::DatabaseConnection;
use std::time::Duration;
use tauri::Emitter;

use super::conversations::{sanitize_context_diagnostics, sanitize_rag_context_result};

const RAG_CONTEXT_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) const AGENT_BLOCKING_DIAGNOSTIC_CODES: &[&str] = &[
    "MEMORY_NAMESPACE_MISSING",
    "MEMORY_MIGRATION_REVIEW_REQUIRED",
    "MEMORY_NEEDS_ENGINE",
];

pub(crate) fn resolve_turn_resource_ids(
    request: Option<Vec<String>>,
    conversation: &[String],
) -> Vec<String> {
    request.unwrap_or_else(|| conversation.to_vec())
}

pub(crate) fn first_blocking_diagnostic(
    diagnostics: &[ContextDiagnostic],
) -> Option<&ContextDiagnostic> {
    diagnostics
        .iter()
        .find(|item| AGENT_BLOCKING_DIAGNOSTIC_CODES.contains(&item.code.as_str()))
}

pub(crate) fn build_append_system_prompt(
    l1: Option<&str>,
    rag_parts: &[String],
) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(text) = l1.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(text.to_string());
    }
    for part in rag_parts {
        let trimmed = part.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

pub(crate) fn model_supports_function_calling(
    capabilities: Option<&[aqbot_core::types::ModelCapability]>,
) -> bool {
    capabilities
        .map(|items| items.contains(&aqbot_core::types::ModelCapability::FunctionCalling))
        .unwrap_or(true)
}

#[derive(Debug)]
pub(crate) enum AgentRagOutcome {
    Ready(RagContextResult),
    Cancelled,
}

pub(crate) async fn collect_agent_rag_context(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    vector_store: &VectorStore,
    query: &str,
    kb_ids: &[String],
    mem_ids: &[String],
    cancel: &CancellationToken,
) -> AgentRagOutcome {
    let collect = crate::indexing::collect_rag_context(
        db,
        master_key,
        vector_store,
        kb_ids,
        mem_ids,
        query,
        5,
    );
    tokio::select! {
        _ = cancel.cancelled() => AgentRagOutcome::Cancelled,
        timed = tokio::time::timeout(RAG_CONTEXT_TIMEOUT, collect) => match timed {
            Ok(result) => AgentRagOutcome::Ready(sanitize_rag_context_result(result)),
            Err(_) => AgentRagOutcome::Ready(timeout_rag_context(kb_ids, mem_ids)),
        },
    }
}

pub(crate) fn emit_agent_rag_context(
    app: &tauri::AppHandle,
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    rag: &RagContextResult,
    diagnostics: &[ContextDiagnostic],
) {
    let safe = aqbot_core::inline_media::filter_complete_inline_data;
    let _ = app.emit(
        "rag-context-retrieved",
        RagContextRetrievedEvent {
            conversation_id: safe(conversation_id),
            message_id: Some(safe(message_id)),
            stream_id: Some(safe(stream_id)),
            sources: rag.source_results.clone(),
            errors: rag.errors.clone(),
            empty_results: rag.empty_results.clone(),
            diagnostics: sanitize_context_diagnostics(diagnostics),
        },
    );
}

pub(crate) fn prepared_turn_has_retrieval(prepared: &PreparedTurn) -> bool {
    !prepared.knowledge_ids.is_empty() || !prepared.auto_memory_ids.is_empty()
}

fn timeout_rag_context(kb_ids: &[String], mem_ids: &[String]) -> RagContextResult {
    let message = format!("检索超时，已超过 {} 秒", RAG_CONTEXT_TIMEOUT.as_secs());
    let mut errors = Vec::with_capacity(kb_ids.len() + mem_ids.len());
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
    sanitize_rag_context_result(RagContextResult {
        context_parts: Vec::new(),
        source_results: Vec::new(),
        errors,
        empty_results: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn omitted_request_uses_conversation_snapshot() {
        let conversation = vec!["kb-1".to_string()];
        assert_eq!(
            resolve_turn_resource_ids(None, &conversation),
            vec!["kb-1".to_string()]
        );
    }

    #[test]
    fn explicit_empty_request_clears_resources() {
        let conversation = vec!["kb-1".to_string()];
        assert!(resolve_turn_resource_ids(Some(Vec::new()), &conversation).is_empty());
    }

    #[test]
    fn append_prompt_joins_l1_and_rag() {
        let prompt = build_append_system_prompt(Some("L1 facts"), &["RAG chunk".to_string()]);
        assert_eq!(prompt.as_deref(), Some("L1 facts\n\nRAG chunk"));
    }

    #[test]
    fn missing_memory_blocks_agent() {
        let diagnostic = ContextDiagnostic {
            code: "MEMORY_NAMESPACE_MISSING".into(),
            source_type: "memory".into(),
            container_id: Some("ns-1".into()),
            args: json!({}),
        };
        assert_eq!(
            first_blocking_diagnostic(&[diagnostic.clone()])
                .map(|item| item.code.as_str()),
            Some("MEMORY_NAMESPACE_MISSING")
        );
    }
}
