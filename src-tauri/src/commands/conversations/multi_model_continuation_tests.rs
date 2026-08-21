mod multi_model_continuation_tests {
    use super::*;

    fn message(id: &str, role: MessageRole, content: &str) -> Message {
        Message {
            id: id.to_string(),
            conversation_id: "conv-1".into(),
            role,
            content: content.to_string(),
            provider_id: None,
            model_id: None,
            token_count: None,
            prompt_tokens: None,
            completion_tokens: None,
            attachments: Vec::new(),
            thinking: None,
            created_at: 0,
            parent_message_id: None,
            version_index: 0,
            is_active: true,
            tool_calls_json: None,
            tool_call_id: None,
            status: "complete".into(),
            tokens_per_second: None,
            first_token_latency_ms: None,
        }
    }

    fn with_parent(mut message: Message, parent_id: &str, version_index: i32) -> Message {
        message.parent_message_id = Some(parent_id.to_string());
        message.version_index = version_index;
        message
    }

    fn with_model(mut message: Message, provider_id: &str, model_id: &str) -> Message {
        message.provider_id = Some(provider_id.to_string());
        message.model_id = Some(model_id.to_string());
        message
    }

    fn inactive(mut message: Message) -> Message {
        message.is_active = false;
        message
    }

    fn tool_scaffold(id: &str, parent_id: &str, call_id: &str) -> Message {
        let mut message = inactive(with_parent(
            message(id, MessageRole::Assistant, ""),
            parent_id,
            -1,
        ));
        message.tool_calls_json = Some(format!(
            r#"[{{"id":"{call_id}","type":"function","function":{{"name":"read_file","arguments":"{{}}"}}}}]"#
        ));
        message
    }

    fn tool_result(parent_id: &str, call_id: &str, content: &str) -> Message {
        let mut message = inactive(with_parent(
            message(&format!("tool-{call_id}"), MessageRole::Tool, content),
            parent_id,
            -1,
        ));
        message.tool_call_id = Some(call_id.to_string());
        message
    }

    #[test]
    fn projection_reconstructs_only_the_selected_models_tool_group() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            message("user-1", MessageRole::User, "please read"),
            with_model(
                tool_scaffold("tool-assistant-a", "user-1", "call-a"),
                "provider-a",
                "model-a",
            ),
            tool_result("tool-assistant-a", "call-a", "file content a"),
            with_model(
                tool_scaffold("tool-assistant-b", "user-1", "call-b"),
                "provider-b",
                "model-b",
            ),
            tool_result("tool-assistant-b", "call-b", "file content b"),
            with_model(
                with_parent(
                    message(
                        "answer-a",
                        MessageRole::Assistant,
                        ":::mcp {\"id\":\"call-a\",\"tool\":\"read_file\"}\nfile content a\n:::\n\ndone a",
                    ),
                    "user-1",
                    0,
                ),
                "provider-a",
                "model-a",
            ),
            inactive(with_model(
                with_parent(
                    message(
                        "answer-b",
                        MessageRole::Assistant,
                        ":::mcp {\"id\":\"call-b\",\"tool\":\"read_file\"}\nfile content b\n:::\n\ndone b",
                    ),
                    "user-1",
                    1,
                ),
                "provider-b",
                "model-b",
            )),
            message("user-2", MessageRole::User, "next"),
        ];
        let projected = aqbot_core::repo::message::project_messages_for_model_continuation(
            messages,
            "provider-b",
            "model-b",
        );

        let context = build_provider_context_messages_from_index(
            &file_store,
            &projected,
            0,
            false,
            None,
            Some("user-2"),
            None,
        )
        .unwrap();
        let tool_call_ids = context
            .iter()
            .filter_map(|message| message.tool_calls.as_ref())
            .flat_map(|tool_calls| tool_calls.iter().map(|tool_call| tool_call.id.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(tool_call_ids, vec!["call-b"]);
        assert!(context.iter().any(|message| {
            matches!(&message.content, ChatContent::Text(content) if content == "file content b")
        }));
        assert!(!context.iter().any(|message| {
            matches!(&message.content, ChatContent::Text(content) if content.contains("file content a"))
        }));
    }

    #[test]
    fn projection_drops_other_models_tools_when_selected_answer_has_no_tool_calls() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            message("user-1", MessageRole::User, "please read"),
            with_model(
                tool_scaffold("tool-assistant-a", "user-1", "call-a"),
                "provider-a",
                "model-a",
            ),
            tool_result("tool-assistant-a", "call-a", "secret from model a"),
            with_model(
                with_parent(
                    message("answer-a", MessageRole::Assistant, "done a"),
                    "user-1",
                    0,
                ),
                "provider-a",
                "model-a",
            ),
            inactive(with_model(
                with_parent(
                    message("answer-b", MessageRole::Assistant, "done b without tools"),
                    "user-1",
                    1,
                ),
                "provider-b",
                "model-b",
            )),
            message("user-2", MessageRole::User, "next"),
        ];
        let projected = aqbot_core::repo::message::project_messages_for_model_continuation(
            messages,
            "provider-b",
            "model-b",
        );
        let context = build_provider_context_messages_from_index(
            &file_store,
            &projected,
            0,
            false,
            None,
            Some("user-2"),
            None,
        )
        .unwrap();

        assert!(context.iter().all(|message| message.tool_calls.is_none()));
        assert!(context.iter().all(|message| message.role != "tool"));
        assert!(!context.iter().any(|message| {
            matches!(&message.content, ChatContent::Text(content) if content.contains("secret from model a"))
        }));
    }

    #[test]
    fn projection_respects_context_clear_and_regeneration_stop() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let answer = |id, parent, content, provider, model, version, active| {
            let message = with_model(
                with_parent(
                    message(id, MessageRole::Assistant, content),
                    parent,
                    version,
                ),
                provider,
                model,
            );
            if active {
                message
            } else {
                inactive(message)
            }
        };
        let messages = vec![
            message("old-user", MessageRole::User, "old"),
            answer(
                "old-a",
                "old-user",
                "old-a",
                "provider-a",
                "model-a",
                0,
                true,
            ),
            answer(
                "old-b",
                "old-user",
                "old-b",
                "provider-b",
                "model-b",
                1,
                false,
            ),
            message(
                "clear",
                MessageRole::System,
                crate::context_manager::CONTEXT_CLEAR_MARKER,
            ),
            message("new-user", MessageRole::User, "new"),
            answer(
                "new-a",
                "new-user",
                "new-a",
                "provider-a",
                "model-a",
                0,
                true,
            ),
            answer(
                "new-b",
                "new-user",
                "new-b",
                "provider-b",
                "model-b",
                1,
                false,
            ),
            message("target-user", MessageRole::User, "target"),
            answer(
                "future-b",
                "target-user",
                "future-b",
                "provider-b",
                "model-b",
                0,
                true,
            ),
        ];
        let projected = aqbot_core::repo::message::project_messages_for_model_continuation(
            messages,
            "provider-b",
            "model-b",
        );
        let boundary = resolve_context_boundary_for_strategy(
            &projected,
            None,
            ContextStrategy::RawTruncate,
            Some("target-user"),
        );
        let context = build_provider_context_messages_from_index(
            &file_store,
            &projected,
            boundary.start_index,
            false,
            None,
            Some("target-user"),
            Some("target-user"),
        )
        .unwrap();
        let text = context
            .iter()
            .filter_map(|message| match &message.content {
                ChatContent::Text(content) => Some(content.as_str()),
                ChatContent::Multipart(_) => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(text, vec!["new", "new-b", "target"]);
    }

    #[tokio::test]
    async fn continuation_ignores_the_shared_summary() {
        let pool = aqbot_core::db::create_test_pool().await.unwrap();
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &pool.conn,
            "summary isolation",
            "model",
            "provider",
            None,
        )
        .await
        .unwrap();
        aqbot_core::repo::conversation::upsert_summary(
            &pool.conn,
            &conversation.id,
            "shared summary",
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(load_continuation_summary(
            &pool.conn,
            &conversation.id,
            MultiModelContinuationMode::Selected,
        )
        .await
        .unwrap()
        .is_some());
        assert!(load_continuation_summary(
            &pool.conn,
            &conversation.id,
            MultiModelContinuationMode::PerModel,
        )
        .await
        .unwrap()
        .is_none());
    }

    #[test]
    fn generated_summary_persistence_is_selected_mode_only() {
        assert!(should_persist_generated_summary(
            MultiModelContinuationMode::Selected
        ));
        assert!(!should_persist_generated_summary(
            MultiModelContinuationMode::PerModel
        ));
    }
}
