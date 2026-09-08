use super::conversations::{
    append_stream_error_to_content, build_stream_terminal_event, emit_stream_terminal,
    ChatStreamTerminalOutcome,
};
use crate::conversation_run::ConversationRunGuard;
use aqbot_core::repo::{agent_session, message};

pub(crate) fn agent_terminal_outcome(
    cancelled: bool,
    sdk_error: Option<&str>,
    persist_error: Option<&str>,
) -> (ChatStreamTerminalOutcome, Option<String>) {
    if let Some(error) = persist_error.filter(|value| !value.is_empty()) {
        return (ChatStreamTerminalOutcome::Error, Some(error.to_string()));
    }
    if let Some(error) = sdk_error.filter(|value| !value.is_empty() && *value != "Agent cancelled")
    {
        return (ChatStreamTerminalOutcome::Error, Some(error.to_string()));
    }
    if cancelled || sdk_error == Some("Agent cancelled") {
        return (ChatStreamTerminalOutcome::Cancelled, None);
    }
    (ChatStreamTerminalOutcome::Complete, None)
}

#[derive(Default)]
pub(crate) struct AgentRunCompletion<'a> {
    pub session_id: &'a str,
    pub assistant_message_id: Option<&'a str>,
    pub content: Option<&'a str>,
    pub sdk_context: Option<&'a [open_agent_sdk::Message]>,
    pub usage: Option<&'a open_agent_sdk::Usage>,
    pub cost_usd: f64,
    pub cancelled: bool,
    pub error: Option<&'a str>,
}

/// Persist the authoritative terminal state before allowing the next turn.
/// Both initialization failures and background SDK completion use this path.
pub(crate) async fn persist_and_release_agent_run(
    db: &sea_orm::DatabaseConnection,
    input: AgentRunCompletion<'_>,
    running_guard: ConversationRunGuard,
) -> (ChatStreamTerminalOutcome, Option<String>) {
    let (mut outcome, mut error) = agent_terminal_outcome(input.cancelled, input.error, None);
    let mut failures = Vec::new();
    let context = input.sdk_context.map(serde_json::to_string).transpose();
    let context = match context {
        Ok(context) => context,
        Err(error) => {
            failures.push(format!("Failed to serialize Agent context: {error}"));
            None
        }
    };
    let tokens = input
        .usage
        .map(|usage| (usage.input_tokens + usage.output_tokens) as i32)
        .unwrap_or(0);
    if let Err(error) = agent_session::update_agent_session_after_query(
        db,
        input.session_id,
        "idle",
        context.as_deref(),
        tokens,
        input.cost_usd,
    )
    .await
    {
        failures.push(format!("Failed to save Agent session: {error}"));
    }
    if let Some(message_id) = input.assistant_message_id {
        if let Some(usage) = input.usage {
            if let Err(error) = message::update_message_usage(
                db,
                message_id,
                Some(usage.input_tokens as i64),
                Some(usage.output_tokens as i64),
            )
            .await
            {
                failures.push(format!("Failed to save Agent usage: {error}"));
            }
        }
        let diagnostic = join_agent_errors(error.as_deref(), &failures);
        let content = match input.content {
            Some(content) => Some(content.to_string()),
            None if diagnostic.is_some() => match message::get_message(db, message_id).await {
                Ok(message) => Some(message.content),
                Err(error) => {
                    failures.push(format!("Failed to read Agent message: {error}"));
                    None
                }
            },
            None => None,
        };
        if let Some(content) = content {
            let content = diagnostic
                .as_deref()
                .map(|error| append_stream_error_to_content(&content, error))
                .unwrap_or(content);
            if let Err(error) = message::update_message_content(db, message_id, &content).await {
                failures.push(format!("Failed to save Agent message: {error}"));
            }
        }
        let status = if !failures.is_empty() || outcome == ChatStreamTerminalOutcome::Error {
            "error"
        } else if outcome == ChatStreamTerminalOutcome::Cancelled {
            "partial"
        } else {
            "complete"
        };
        if let Err(error) = message::update_message_status(db, message_id, status).await {
            failures.push(format!("Failed to save Agent message status: {error}"));
        }
    }
    if !failures.is_empty() {
        outcome = ChatStreamTerminalOutcome::Error;
        error = join_agent_errors(error.as_deref(), &failures);
        tracing::error!(run_id = running_guard.run_id(), error = ?error, "Agent final persistence failed");
    }
    drop(running_guard);
    (outcome, error)
}

fn join_agent_errors(original: Option<&str>, failures: &[String]) -> Option<String> {
    let errors: Vec<&str> = original
        .into_iter()
        .chain(failures.iter().map(String::as_str))
        .collect();
    (!errors.is_empty()).then(|| errors.join("; "))
}

pub(crate) fn emit_agent_run_terminal(
    app: &tauri::AppHandle,
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    outcome: ChatStreamTerminalOutcome,
    error: Option<String>,
) {
    emit_stream_terminal(
        app,
        build_stream_terminal_event(conversation_id, message_id, stream_id, outcome, error),
    );
}

pub(crate) async fn abort_agent_receiver(
    rx: &mut tokio::sync::mpsc::Receiver<open_agent_sdk::SDKMessage>,
    handle: tokio::task::JoinHandle<()>,
    cancel_token: &open_agent_sdk::CancellationToken,
) -> Result<(), String> {
    if !cancel_token.is_cancelled() {
        cancel_token.cancel();
    }
    rx.close();
    handle
        .await
        .map_err(|error| format!("Agent task crashed unexpectedly: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation_run::{ConversationRunMode, ConversationRunRegistry};

    #[test]
    fn persist_failure_cannot_emit_success() {
        let (outcome, error) =
            agent_terminal_outcome(false, None, Some("Failed to update session after query"));
        assert_eq!(outcome, ChatStreamTerminalOutcome::Error);
        assert_eq!(
            error.as_deref(),
            Some("Failed to update session after query")
        );
    }

    #[test]
    fn sdk_cancel_emits_cancelled_without_error() {
        let (outcome, error) = agent_terminal_outcome(true, Some("Agent cancelled"), None);
        assert_eq!(outcome, ChatStreamTerminalOutcome::Cancelled);
        assert!(error.is_none());
    }

    #[test]
    fn sdk_error_keeps_original_message() {
        let (outcome, error) =
            agent_terminal_outcome(false, Some("Failed to prepare skills: junction"), None);
        assert_eq!(outcome, ChatStreamTerminalOutcome::Error);
        assert_eq!(error.as_deref(), Some("Failed to prepare skills: junction"));
    }

    #[tokio::test]
    async fn aborting_a_failed_sdk_task_keeps_the_original_error() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let cancel_token = open_agent_sdk::CancellationToken::new();
        let task_token = cancel_token.clone();
        let handle = tokio::spawn(async move {
            tx.send(open_agent_sdk::SDKMessage::Error {
                message: "Provider rejected the request".to_string(),
            })
            .await
            .unwrap();
            task_token.cancelled().await;
        });
        let Some(open_agent_sdk::SDKMessage::Error { message }) = rx.recv().await else {
            panic!("expected the provider error");
        };
        abort_agent_receiver(&mut rx, handle, &cancel_token)
            .await
            .unwrap();
        let (outcome, error) =
            agent_terminal_outcome(cancel_token.is_cancelled(), Some(&message), None);
        assert_eq!(outcome, ChatStreamTerminalOutcome::Error);
        assert_eq!(error.as_deref(), Some("Provider rejected the request"));
    }

    #[test]
    fn complete_when_no_errors() {
        let (outcome, error) = agent_terminal_outcome(false, None, None);
        assert_eq!(outcome, ChatStreamTerminalOutcome::Complete);
        assert!(error.is_none());
    }

    async fn fixture() -> (
        sea_orm::DatabaseConnection,
        aqbot_core::types::AgentSession,
        aqbot_core::types::Message,
    ) {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "agent lifecycle",
            "model",
            "provider",
            None,
        )
        .await
        .unwrap();
        let session = agent_session::upsert_agent_session(&db, &conversation.id, None, None)
            .await
            .unwrap();
        agent_session::update_agent_session_after_query(
            &db,
            &session.id,
            "running",
            Some("[]"),
            0,
            0.0,
        )
        .await
        .unwrap();
        let message = message::create_message(
            &db,
            &conversation.id,
            aqbot_core::types::MessageRole::Assistant,
            "Already streamed",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        (db, session, message)
    }

    #[tokio::test]
    async fn completion_persists_context_before_releasing_for_the_next_turn() {
        let (db, session, message) = fixture().await;
        let registry = ConversationRunRegistry::new();
        let first = registry
            .admit(
                &session.conversation_id,
                "run-1",
                Some("run-1"),
                ConversationRunMode::Agent,
            )
            .unwrap();
        let context = vec![open_agent_sdk::Message {
            role: open_agent_sdk::MessageRole::Assistant,
            content: vec![open_agent_sdk::ContentBlock::Text {
                text: "Final answer".into(),
            }],
        }];
        let usage = open_agent_sdk::Usage {
            input_tokens: 5,
            output_tokens: 8,
            ..Default::default()
        };
        let (outcome, error) = persist_and_release_agent_run(
            &db,
            AgentRunCompletion {
                session_id: &session.id,
                assistant_message_id: Some(&message.id),
                content: Some("Final answer"),
                sdk_context: Some(&context),
                usage: Some(&usage),
                ..Default::default()
            },
            first,
        )
        .await;
        assert_eq!(outcome, ChatStreamTerminalOutcome::Complete);
        assert!(error.is_none());
        let next = registry
            .admit(
                &session.conversation_id,
                "run-2",
                Some("run-2"),
                ConversationRunMode::Agent,
            )
            .unwrap();
        let persisted =
            agent_session::get_agent_session_by_conversation_id(&db, next.conversation_id())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(persisted.runtime_status, "idle");
        assert_eq!(
            persisted.sdk_context_json,
            Some(serde_json::to_string(&context).unwrap())
        );
        assert_eq!(persisted.total_tokens, 13);
        let persisted_message = message::get_message(&db, &message.id).await.unwrap();
        assert_eq!(persisted_message.content, "Final answer");
        assert_eq!(persisted_message.status, "complete");
        assert_eq!(persisted_message.completion_tokens, Some(8));
    }

    #[tokio::test]
    async fn error_and_cancel_preserve_partial_content_with_the_correct_status() {
        for (cancelled, sdk_error, expected) in [
            (
                true,
                "Provider rejected the request",
                ChatStreamTerminalOutcome::Error,
            ),
            (
                true,
                "Agent cancelled",
                ChatStreamTerminalOutcome::Cancelled,
            ),
            (
                false,
                "Failed to prepare skills: junction",
                ChatStreamTerminalOutcome::Error,
            ),
        ] {
            let (db, session, message) = fixture().await;
            let registry = ConversationRunRegistry::new();
            let guard = registry
                .admit(
                    &session.conversation_id,
                    "run-1",
                    None,
                    ConversationRunMode::Agent,
                )
                .unwrap();
            let (outcome, error) = persist_and_release_agent_run(
                &db,
                AgentRunCompletion {
                    session_id: &session.id,
                    assistant_message_id: Some(&message.id),
                    cancelled,
                    error: Some(sdk_error),
                    ..Default::default()
                },
                guard,
            )
            .await;
            assert_eq!(outcome, expected);
            let saved = message::get_message(&db, &message.id).await.unwrap();
            if expected == ChatStreamTerminalOutcome::Error {
                assert_eq!(error.as_deref(), Some(sdk_error));
                assert_eq!(saved.status, "error");
                assert_eq!(
                    saved.content,
                    format!("Already streamed\n\n<!-- aqbot-stream-error -->\n{sdk_error}")
                );
            } else {
                assert!(error.is_none());
                assert_eq!(saved.status, "partial");
                assert_eq!(saved.content, "Already streamed");
            }
            let saved_session =
                agent_session::get_agent_session_by_conversation_id(&db, &session.conversation_id)
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(saved_session.runtime_status, "idle");
            assert_eq!(saved_session.sdk_context_json.as_deref(), Some("[]"));
            assert!(registry.list_active().is_empty());
        }
    }

    #[tokio::test]
    async fn failed_context_persistence_is_visible_in_the_message_and_terminal() {
        let (db, session, message) = fixture().await;
        let registry = ConversationRunRegistry::new();
        let guard = registry
            .admit(
                &session.conversation_id,
                "run-1",
                None,
                ConversationRunMode::Agent,
            )
            .unwrap();
        let (outcome, error) = persist_and_release_agent_run(
            &db,
            AgentRunCompletion {
                session_id: "missing-session",
                assistant_message_id: Some(&message.id),
                ..Default::default()
            },
            guard,
        )
        .await;
        assert_eq!(outcome, ChatStreamTerminalOutcome::Error);
        assert!(error.unwrap().contains("Failed to save Agent session"));
        let saved = message::get_message(&db, &message.id).await.unwrap();
        assert_eq!(saved.status, "error");
        assert!(saved
            .content
            .starts_with("Already streamed\n\n<!-- aqbot-stream-error -->"));
        assert!(saved.content.contains("Failed to save Agent session"));
        assert!(registry.list_active().is_empty());
    }

    #[tokio::test]
    async fn abort_reports_a_task_panic() {
        let (_tx, mut rx) = tokio::sync::mpsc::channel(1);
        let token = open_agent_sdk::CancellationToken::new();
        let handle = tokio::spawn(async { panic!("SDK panic") });
        let error = abort_agent_receiver(&mut rx, handle, &token)
            .await
            .unwrap_err();
        assert!(error.contains("SDK panic"));
        assert_eq!(
            agent_terminal_outcome(true, Some(&error), None).0,
            ChatStreamTerminalOutcome::Error
        );
    }

    #[tokio::test]
    async fn initialization_failure_without_an_assistant_still_releases_the_run() {
        let (db, session, _) = fixture().await;
        let registry = ConversationRunRegistry::new();
        let guard = registry
            .admit(
                &session.conversation_id,
                "run-1",
                None,
                ConversationRunMode::Agent,
            )
            .unwrap();
        let (outcome, error) = persist_and_release_agent_run(
            &db,
            AgentRunCompletion {
                session_id: &session.id,
                error: Some("Failed to load provider"),
                ..Default::default()
            },
            guard,
        )
        .await;
        assert_eq!(outcome, ChatStreamTerminalOutcome::Error);
        assert_eq!(error.as_deref(), Some("Failed to load provider"));
        let session =
            agent_session::get_agent_session_by_conversation_id(&db, &session.conversation_id)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(session.runtime_status, "idle");
        assert!(registry.list_active().is_empty());
    }
}
