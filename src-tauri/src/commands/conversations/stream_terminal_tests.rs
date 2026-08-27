#[cfg(test)]
mod stream_terminal_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn cancelled_stream_remains_busy_until_guard_release() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let mut guard = RegisteredStreamGuard::register(
            flags.clone(),
            "conv-1",
            "stream-a",
            cancel_flag.clone(),
            false,
        )
        .await
        .unwrap();

        cancel_flag.store(true, Ordering::Relaxed);

        assert!(has_active_stream_for_conversation(flags.clone(), "conv-1").await);
        let error = RegisteredStreamGuard::register(
            flags.clone(),
            "conv-1",
            "stream-b",
            Arc::new(AtomicBool::new(false)),
            false,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error, ACTIVE_STREAM_EXISTS_ERROR);

        guard.release().await;

        assert!(!has_active_stream_for_conversation(flags, "conv-1").await);
    }

    #[tokio::test]
    async fn parallel_stream_can_join_cancelled_stream_before_release() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let cancel_flag = Arc::new(AtomicBool::new(true));
        let mut first_guard = RegisteredStreamGuard::register(
            flags.clone(),
            "conv-1",
            "stream-a",
            cancel_flag,
            false,
        )
        .await
        .unwrap();

        let mut parallel_guard = RegisteredStreamGuard::register(
            flags.clone(),
            "conv-1",
            "stream-b",
            Arc::new(AtomicBool::new(false)),
            true,
        )
        .await
        .unwrap();

        assert_eq!(flags.lock().await.len(), 2);
        first_guard.release().await;
        parallel_guard.release().await;
    }

    #[tokio::test]
    async fn terminal_finalizer_runs_once_after_registry_release_for_every_outcome() {
        for (index, outcome) in [
            ChatStreamTerminalOutcome::Complete,
            ChatStreamTerminalOutcome::Error,
            ChatStreamTerminalOutcome::Cancelled,
        ]
        .into_iter()
        .enumerate()
        {
            let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));
            let mut guard = RegisteredStreamGuard::register(
                flags.clone(),
                "conv-1",
                &format!("stream-{index}"),
                Arc::new(AtomicBool::new(false)),
                false,
            )
            .await
            .unwrap();
            let finalizer_calls = Arc::new(AtomicUsize::new(0));
            let flags_in_finalizer = flags.clone();
            let calls_in_finalizer = finalizer_calls.clone();

            guard
                .release_then_finalize(outcome, move |received| {
                    assert_eq!(received, outcome);
                    assert!(flags_in_finalizer.try_lock().unwrap().is_empty());
                    calls_in_finalizer.fetch_add(1, Ordering::SeqCst);
                })
                .await;

            let calls_in_duplicate = finalizer_calls.clone();
            guard
                .release_then_finalize(outcome, move |_| {
                    calls_in_duplicate.fetch_add(1, Ordering::SeqCst);
                })
                .await;

            assert_eq!(finalizer_calls.load(Ordering::SeqCst), 1);
            assert!(flags.lock().await.is_empty());
        }
    }

    #[tokio::test]
    async fn setup_failure_releases_registry_synchronously_without_cancelling() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let mut guard = RegisteredStreamGuard::register(
            flags.clone(),
            "conv-1",
            "stream-setup-error",
            cancel_flag.clone(),
            false,
        )
        .await
        .unwrap();

        let error = settle_registered_stream_setup::<()>(
            &mut guard,
            Err("setup failed".to_string()),
            StreamSetupFailure::ReleaseOnly,
        )
        .await
        .unwrap_err();

        assert_eq!(error, "setup failed");
        assert!(flags.lock().await.is_empty());
        assert!(!cancel_flag.load(Ordering::Relaxed));
    }

    #[test]
    fn terminal_payload_serializes_outcome_and_error() {
        let complete = build_stream_terminal_event(
            "conv-1",
            "msg-1",
            "stream-1",
            ChatStreamTerminalOutcome::Complete,
            None,
        );
        let cancelled = build_stream_terminal_event(
            "conv-1",
            "msg-1",
            "stream-1",
            ChatStreamTerminalOutcome::Cancelled,
            None,
        );
        let failed = build_stream_terminal_event(
            "conv-1",
            "msg-1",
            "stream-1",
            ChatStreamTerminalOutcome::Error,
            Some("provider failed".to_string()),
        );

        let complete_json = serde_json::to_value(complete).unwrap();
        let cancelled_json = serde_json::to_value(cancelled).unwrap();
        let failed_json = serde_json::to_value(failed).unwrap();

        assert_eq!(complete_json["outcome"], "complete");
        assert!(complete_json["error"].is_null());
        assert_eq!(cancelled_json["outcome"], "cancelled");
        assert!(cancelled_json["error"].is_null());
        assert_eq!(failed_json["outcome"], "error");
        assert_eq!(failed_json["error"], "provider failed");
    }

    #[test]
    fn persistence_errors_are_combined_for_terminal_failure() {
        assert_eq!(combine_stream_persistence_errors(&[]), None);
        assert_eq!(
            combine_stream_persistence_errors(&[
                "assistant update failed".to_string(),
                "message count failed".to_string(),
            ]),
            Some("assistant update failed; message count failed".to_string())
        );
    }

    #[tokio::test]
    async fn terminal_assistant_error_is_persisted_before_message_count() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Terminal persistence",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let user_message = aqbot_core::repo::message::create_message(
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
        let assistant_message = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "",
            &[],
            Some(&user_message.id),
            0,
        )
        .await
        .unwrap();

        persist_terminal_assistant_error(
            &db,
            TerminalAssistantErrorPersistence {
                conversation_id: &conversation.id,
                message_id: &assistant_message.id,
                error: "provider unavailable",
            },
        )
        .await
        .unwrap();

        let stored_message = aqbot_core::repo::message::get_message(&db, &assistant_message.id)
            .await
            .unwrap();
        let stored_conversation =
            aqbot_core::repo::conversation::get_conversation(&db, &conversation.id)
                .await
                .unwrap();
        assert_eq!(stored_message.status, "error");
        assert_eq!(stored_message.content, "provider unavailable");
        assert_eq!(stored_conversation.message_count, 1);
    }

    #[tokio::test]
    async fn missing_terminal_assistant_does_not_increment_message_count() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Missing terminal message",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();

        let error = persist_terminal_assistant_error(
            &db,
            TerminalAssistantErrorPersistence {
                conversation_id: &conversation.id,
                message_id: "missing-message",
                error: "provider unavailable",
            },
        )
        .await
        .unwrap_err();

        let stored_conversation =
            aqbot_core::repo::conversation::get_conversation(&db, &conversation.id)
                .await
                .unwrap();
        assert!(error.contains("Failed to load terminal assistant message"));
        assert_eq!(stored_conversation.message_count, 0);
    }

    #[tokio::test]
    async fn rag_cancel_persists_a_readable_partial_assistant_before_terminal() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "RAG cancel persistence",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let user_message = aqbot_core::repo::message::create_message(
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

        persist_assistant_placeholder(
            &db,
            AssistantPlaceholderPersistence {
                conversation_id: &conversation.id,
                message_id: "rag-cancelled-assistant",
                parent_message_id: &user_message.id,
                provider_id: "provider-1",
                model_id: "model-1",
                content: "<memory></memory>",
                version_index: 0,
                created_at: user_message.created_at + 1,
                deactivate_existing_versions: false,
                increment_message_count: true,
                is_active: true,
            },
        )
        .await
        .unwrap();

        let stored_message = aqbot_core::repo::message::get_message(&db, "rag-cancelled-assistant")
            .await
            .unwrap();
        let stored_conversation =
            aqbot_core::repo::conversation::get_conversation(&db, &conversation.id)
                .await
                .unwrap();
        assert_eq!(stored_message.status, "partial");
        assert_eq!(stored_message.content, "<memory></memory>");
        assert!(stored_message.is_active);
        assert_eq!(stored_conversation.message_count, 1);
    }

    #[tokio::test]
    async fn rag_cancelled_regeneration_replaces_the_active_version_atomically() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "RAG regeneration cancel",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let user_message = aqbot_core::repo::message::create_message(
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
        let previous_assistant = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "old answer",
            &[],
            Some(&user_message.id),
            0,
        )
        .await
        .unwrap();

        persist_assistant_placeholder(
            &db,
            AssistantPlaceholderPersistence {
                conversation_id: &conversation.id,
                message_id: "cancelled-regeneration",
                parent_message_id: &user_message.id,
                provider_id: "provider-1",
                model_id: "model-1",
                content: "",
                version_index: 1,
                created_at: previous_assistant.created_at,
                deactivate_existing_versions: true,
                increment_message_count: true,
                is_active: true,
            },
        )
        .await
        .unwrap();

        let previous = aqbot_core::repo::message::get_message(&db, &previous_assistant.id)
            .await
            .unwrap();
        let replacement = aqbot_core::repo::message::get_message(&db, "cancelled-regeneration")
            .await
            .unwrap();
        assert!(!previous.is_active);
        assert!(replacement.is_active);
        assert_eq!(replacement.status, "partial");
        assert_eq!(replacement.version_index, 1);
    }

    #[tokio::test]
    async fn regeneration_setup_error_updates_the_persisted_placeholder_once() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Regeneration setup failure",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let user_message = aqbot_core::repo::message::create_message(
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
        persist_assistant_placeholder(
            &db,
            AssistantPlaceholderPersistence {
                conversation_id: &conversation.id,
                message_id: "setup-error-assistant",
                parent_message_id: &user_message.id,
                provider_id: "provider-1",
                model_id: "model-1",
                content: "",
                version_index: 0,
                created_at: user_message.created_at + 1,
                deactivate_existing_versions: true,
                increment_message_count: false,
                is_active: true,
            },
        )
        .await
        .unwrap();

        persist_terminal_assistant_error(
            &db,
            TerminalAssistantErrorPersistence {
                conversation_id: &conversation.id,
                message_id: "setup-error-assistant",
                error: "context setup failed",
            },
        )
        .await
        .unwrap();

        let stored_message = aqbot_core::repo::message::get_message(&db, "setup-error-assistant")
            .await
            .unwrap();
        let stored_conversation =
            aqbot_core::repo::conversation::get_conversation(&db, &conversation.id)
                .await
                .unwrap();
        assert_eq!(stored_message.status, "error");
        assert_eq!(stored_message.content, "context setup failed");
        assert_eq!(stored_conversation.message_count, 1);
    }
}
