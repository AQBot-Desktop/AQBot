// Conversation command tests.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::future::pending;
    use std::io::{Cursor, Write};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Mutex;

    fn test_app_state(db: DatabaseConnection) -> crate::AppState {
        let vector_store = Arc::new(aqbot_core::vector_store::VectorStore::new(db.clone()));
        crate::AppState {
            sea_db: db,
            master_key: [0; 32],
            mcp_stdio_clients: Arc::new(aqbot_core::mcp_client::StdioClientManager::new()),
            gateway: Arc::new(Mutex::new(None)),
            close_to_tray: Arc::new(AtomicBool::new(false)),
            release_webview_on_tray: Arc::new(AtomicBool::new(false)),
            main_window_released_to_tray: Arc::new(AtomicBool::new(false)),
            main_window_restoring: Arc::new(AtomicBool::new(false)),
            is_quitting: Arc::new(AtomicBool::new(false)),
            model_catalog: Arc::new(crate::model_catalog::ModelCatalogService::new(
                std::env::temp_dir().join("aqbot-test-model-metadata"),
                crate::model_catalog::ModelCatalogConfig::default(),
            )),
            app_data_dir: std::env::temp_dir(),
            db_path: "sqlite::memory:".to_string(),
            auto_backup_handle: Arc::new(Mutex::new(None)),
            webdav_sync_handle: Arc::new(Mutex::new(None)),
            s3_sync_handle: Arc::new(Mutex::new(None)),
            vector_store,
            knowledge_index_scheduler: Arc::new(
                crate::knowledge_index_scheduler::KnowledgeIndexScheduler::default(),
            ),
            stream_cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            agent_cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
            agent_permission_senders: Arc::new(Mutex::new(HashMap::new())),
            agent_ask_senders: Arc::new(Mutex::new(HashMap::new())),
            agent_always_allowed: Arc::new(Mutex::new(HashMap::new())),
            selection_toolbar: Arc::new(crate::selection_toolbar::SelectionToolbarRuntime::new()),
            pending_tray_action: Arc::new(std::sync::Mutex::new(None)),
            multi_model_runs: Arc::new(crate::multi_model_run::MultiModelRunManager::new()),
            conversation_runs: crate::conversation_run::ConversationRunRegistry::new(),
            tray_enabled: Arc::new(AtomicBool::new(true)),
            tray_available: Arc::new(AtomicBool::new(true)),
        }
    }

    fn test_conversation(
        temperature: Option<f32>,
        max_tokens: Option<u32>,
        top_p: Option<f32>,
    ) -> Conversation {
        Conversation {
            id: "conv-1".to_string(),
            title: "Conversation".to_string(),
            model_id: "model-1".to_string(),
            provider_id: "provider-1".to_string(),
            system_prompt: None,
            temperature,
            max_tokens,
            top_p,
            frequency_penalty: None,
            search_enabled: false,
            search_provider_id: None,
            thinking_budget: None,
            thinking_level: None,
            enabled_mcp_server_ids: Vec::new(),
            enabled_knowledge_base_ids: Vec::new(),
            enabled_memory_namespace_ids: Vec::new(),
            message_count: 0,
            is_pinned: false,
            is_archived: false,
            context_compression: false,
            context_strategy_override: None,
            context_message_limit: None,
            compression_keep_last_n: None,
            multi_model_display_mode_override: None,
            multi_model_targets: Vec::new(),
            multi_model_continuation_mode: MultiModelContinuationMode::Selected,
            category_id: None,
            parent_conversation_id: None,
            sort_order: 0,
            mode: "chat".to_string(),
            tab_pin_order: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn test_param_overrides(
        temperature: Option<f32>,
        max_tokens: Option<u32>,
        top_p: Option<f32>,
    ) -> ModelParamOverrides {
        ModelParamOverrides {
            temperature,
            max_tokens,
            top_p,
            frequency_penalty: None,
            use_max_completion_tokens: None,
            no_system_role: None,
            omit_sampling_params: None,
            force_max_tokens: None,
            thinking_param_style: None,
            reasoning_profile: None,
            reasoning_options: None,
            reasoning_default: None,
            extra_body: None,
        }
    }

    #[test]
    fn model_extra_body_is_cloned_from_model_param_overrides() {
        let extra_body = serde_json::json!({
            "enable_thinking": true,
            "thinking": {
                "type": "enabled"
            }
        })
        .as_object()
        .expect("object")
        .clone();
        let mut overrides = test_param_overrides(None, None, None);
        overrides.extra_body = Some(extra_body.clone());

        assert_eq!(
            model_extra_body_from_overrides(Some(&overrides)),
            Some(extra_body)
        );
        assert_eq!(model_extra_body_from_overrides(None), None);
    }

    #[test]
    fn context_output_reserve_requires_a_real_request_or_model_limit() {
        let conversation = test_conversation(None, None, None);
        let settings = AppSettings::default();

        assert_eq!(
            resolved_context_output_reserve(&conversation, None, &settings, None, None, None,),
            None
        );
        assert_eq!(
            resolved_context_output_reserve(
                &conversation,
                None,
                &settings,
                None,
                None,
                Some(8_192),
            ),
            Some(8_192)
        );

        let configured = test_conversation(None, Some(2_048), None);
        assert_eq!(
            resolved_context_output_reserve(&configured, None, &settings, None, None, Some(8_192),),
            Some(2_048)
        );
    }

    #[test]
    fn raw_strict_rechecks_budget_before_each_tool_iteration() {
        let system = ChatMessage {
            role: "system".into(),
            content: ChatContent::Text("system".into()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        };
        let user = ChatMessage {
            role: "user".into(),
            content: ChatContent::Text("question".into()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        };
        let initial = vec![system, user];
        let initial_tokens = initial
            .iter()
            .map(crate::context_manager::message_tokens)
            .sum::<usize>();
        let policy = StreamContextPolicy::new(
            ContextStrategy::RawStrict,
            Some(initial_tokens + 4),
            &initial,
        );
        assert!(apply_stream_context_policy(&initial, policy).is_ok());

        let mut next_iteration = initial;
        next_iteration.push(ChatMessage {
            role: "tool".into(),
            content: ChatContent::Text("large tool result ".repeat(100)),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: Some("call-1".into()),
        });

        assert!(apply_stream_context_policy(&next_iteration, policy).is_err());
    }

    #[tokio::test]
    async fn failed_send_preparation_rolls_back_persisted_user_and_count() {
        let pool = aqbot_core::db::create_test_pool().await.unwrap();
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &pool.conn, "rollback", "model", "provider", None,
        )
        .await
        .unwrap();
        let message = aqbot_core::repo::message::create_message(
            &pool.conn,
            &conversation.id,
            MessageRole::User,
            "strict overflow",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        aqbot_core::repo::conversation::increment_message_count(&pool.conn, &conversation.id)
            .await
            .unwrap();

        let errors = rollback_counted_new_message(
            &pool.conn,
            &conversation.id,
            &message.id,
            &message.attachments,
        )
        .await;

        assert!(errors.is_empty());
        assert!(
            aqbot_core::repo::message::get_message(&pool.conn, &message.id)
                .await
                .is_err()
        );
        assert_eq!(
            aqbot_core::repo::conversation::get_conversation(&pool.conn, &conversation.id)
                .await
                .unwrap()
                .message_count,
            0
        );
    }

    #[test]
    fn text_document_attachments_are_supported_and_injected() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-text-document-test-{}",
            aqbot_core::utils::gen_id()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let result = (|| {
            let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
            let body = b"hello from markdown notes";
            let saved = file_store
                .save_file(body, "notes.md", "text/markdown")
                .unwrap();
            let attachments = vec![Attachment {
                id: "att-md".into(),
                file_type: "text/markdown".into(),
                file_name: "notes.md".into(),
                file_path: saved.storage_path,
                file_size: body.len() as u64,
                data: None,
            }];

            assert!(is_supported_document_attachment(&attachments[0]));

            let disabled = append_document_attachment_context(
                &file_store,
                "Summarize this",
                &attachments,
                false,
                Some(8_000),
            )
            .unwrap();
            let enabled = append_document_attachment_context(
                &file_store,
                "Summarize this",
                &attachments,
                true,
                Some(8_000),
            )
            .unwrap();

            (disabled, enabled)
        })();

        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(result.0, "Summarize this");
        assert!(result.1.contains("Summarize this"));
        assert!(result.1.contains("notes.md"));
        assert!(result.1.contains("hello from markdown notes"));
        assert!(result.1.contains("[Parsed document attachments]"));
    }

    fn test_docx_bytes(text: &str) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("word/document.xml", options).unwrap();
        write!(
            archive,
            r#"<w:document><w:body><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:body></w:document>"#,
            text
        )
        .unwrap();
        archive.finish().unwrap().into_inner()
    }

    fn test_message(
        id: &str,
        role: MessageRole,
        content: &str,
        parent_message_id: Option<&str>,
        version_index: i32,
        is_active: bool,
        tool_calls_json: Option<&str>,
        tool_call_id: Option<&str>,
    ) -> Message {
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
            tokens_per_second: None,
            first_token_latency_ms: None,
            attachments: Vec::new(),
            thinking: None,
            tool_calls_json: tool_calls_json.map(str::to_string),
            tool_call_id: tool_call_id.map(str::to_string),
            created_at: 0,
            parent_message_id: parent_message_id.map(str::to_string),
            version_index,
            is_active,
            status: "complete".into(),
        }
    }

    fn test_summary(boundary_message_id: Option<&str>) -> ConversationSummary {
        ConversationSummary {
            id: "summary-1".to_string(),
            conversation_id: "conv-1".to_string(),
            summary_text: "compressed old context".to_string(),
            compressed_until_message_id: boundary_message_id.map(str::to_string),
            source_text: None,
            token_count: Some(12),
            model_used: Some("summary-model".to_string()),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[tokio::test]
    async fn rag_context_timeout_returns_failure_errors() {
        let result = collect_rag_context_with_timeout(
            pending(),
            Duration::from_millis(1),
            &["kb-1".to_string()],
            &["mem-1".to_string()],
        )
        .await;

        assert!(result.context_parts.is_empty());
        assert!(result.source_results.is_empty());
        assert_eq!(result.errors.len(), 2);
        assert_eq!(result.errors[0].source_type, "knowledge");
        assert_eq!(result.errors[0].container_id, "kb-1");
        assert_eq!(result.errors[0].message, "检索失败：检索超时，已超过 60 秒");
        assert_eq!(result.errors[1].source_type, "memory");
        assert_eq!(result.errors[1].container_id, "mem-1");
        assert_eq!(result.errors[1].message, "检索失败：检索超时，已超过 60 秒");
    }

    #[test]
    fn rag_event_and_persisted_display_tag_never_contain_inline_image_data() {
        let raw = "data:image/png;base64,RAG_SECRET";
        let result = sanitize_rag_context_result(RagContextResult {
            context_parts: vec![raw.to_string()],
            source_results: vec![RagSourceResult {
                source_type: raw.to_string(),
                container_id: raw.to_string(),
                items: vec![RagRetrievedItem {
                    content: raw.to_string(),
                    score: 1.0,
                    rerank_score: None,
                    document_id: raw.to_string(),
                    id: raw.to_string(),
                    document_name: Some(raw.to_string()),
                }],
            }],
            errors: vec![RagSourceError {
                source_type: raw.to_string(),
                container_id: raw.to_string(),
                message: raw.to_string(),
            }],
            empty_results: vec![RagSourceEmptyResult {
                source_type: raw.to_string(),
                container_id: raw.to_string(),
                reason: raw.to_string(),
            }],
        });
        let event = RagContextRetrievedEvent {
            conversation_id: "conversation".to_string(),
            message_id: Some("message".to_string()),
            stream_id: Some("stream".to_string()),
            sources: result.source_results.clone(),
            errors: result.errors.clone(),
            empty_results: result.empty_results.clone(),
            diagnostics: Vec::new(),
        };
        let serialized = serde_json::to_string(&event).unwrap();
        let tag = build_memory_retrieval_tag(&result.source_results);

        assert!(!serialized.to_ascii_lowercase().contains("data:image/"));
        assert!(!tag.to_ascii_lowercase().contains("data:image/"));
        assert!(!serialized.contains("RAG_SECRET"));
        assert!(!tag.contains("RAG_SECRET"));
    }

    #[test]
    fn compression_summary_ipc_gate_checks_every_string_field() {
        let mut summary = test_summary(None);
        summary.summary_text = "data:image/png;base64,SUMMARY_SECRET".to_string();

        let error = ensure_conversation_summary_safe_for_ipc(&summary).unwrap_err();

        assert!(error.contains(&summary.id));
        assert!(!error.contains("SUMMARY_SECRET"));
    }

    #[tokio::test]
    async fn command_provider_resolution_materializes_builtin_provider() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;

        let real_id = resolve_command_provider_id(&db, "builtin_deepseek")
            .await
            .unwrap();

        assert_ne!(real_id, "builtin_deepseek");
        let provider = aqbot_core::repo::provider::get_provider(&db, &real_id)
            .await
            .unwrap();
        assert_eq!(provider.builtin_id.as_deref(), Some("deepseek"));
        assert_eq!(provider.provider_type, ProviderType::DeepSeek);
    }

    #[test]
    fn title_summary_uses_reasoning_safe_default_max_tokens() {
        let mut settings = AppSettings::default();
        assert_eq!(
            title_summary_max_tokens(&settings),
            DEFAULT_TITLE_SUMMARY_MAX_TOKENS
        );

        settings.title_summary_max_tokens = Some(128);
        assert_eq!(title_summary_max_tokens(&settings), 128);
    }

    #[test]
    fn stream_timeout_config_uses_global_settings_and_zero_disables() {
        let mut settings = AppSettings::default();
        settings.chat_stream_first_packet_timeout_secs = 45;
        settings.chat_stream_idle_timeout_secs = 12;

        let config = stream_timeout_config_from_settings(&settings);
        assert_eq!(config.first_packet, Some(Duration::from_secs(45)));
        assert_eq!(config.idle, Some(Duration::from_secs(12)));

        settings.chat_stream_first_packet_timeout_secs = 0;
        settings.chat_stream_idle_timeout_secs = 0;

        let config = stream_timeout_config_from_settings(&settings);
        assert_eq!(config.first_packet, None);
        assert_eq!(config.idle, None);
    }

    #[test]
    fn mcp_tool_loop_limit_clamps_global_settings() {
        let mut settings = AppSettings::default();
        assert_eq!(mcp_tool_loop_max_iterations_from_settings(&settings), 100);

        settings.mcp_tool_loop_max_iterations = 0;
        assert_eq!(mcp_tool_loop_max_iterations_from_settings(&settings), 1);

        settings.mcp_tool_loop_max_iterations = 25;
        assert_eq!(mcp_tool_loop_max_iterations_from_settings(&settings), 25);

        settings.mcp_tool_loop_max_iterations = 1_000;
        assert_eq!(mcp_tool_loop_max_iterations_from_settings(&settings), 100);
    }

    #[test]
    fn mcp_tool_loop_error_event_includes_configured_limit() {
        let event = build_tool_loop_exceeded_error_event(
            "conv-1",
            "msg-1",
            "stream-1",
            "model-1",
            "provider-1",
            25,
        );

        assert_eq!(event.error, "MCP tool loop exceeded 25 iterations");
        assert_eq!(event.kind.as_deref(), Some("tool_loop_exceeded"));
    }

    #[test]
    fn stream_timeout_error_event_identifies_first_packet_timeout() {
        let event = build_stream_timeout_error_event(
            "conv-1",
            "msg-1",
            "stream-1",
            "model-1",
            "provider-1",
            false,
            Duration::from_secs(45),
        );

        assert_eq!(event.error, "模型首包超时，已超过 45 秒未收到响应");
        assert_eq!(event.kind.as_deref(), Some("first_packet_timeout"));
        assert_eq!(event.timeout_secs, Some(45));
    }

    #[test]
    fn stream_timeout_error_event_identifies_idle_timeout() {
        let event = build_stream_timeout_error_event(
            "conv-1",
            "msg-1",
            "stream-1",
            "model-1",
            "provider-1",
            true,
            Duration::from_secs(12),
        );

        assert_eq!(event.error, "模型响应空闲超时，已超过 12 秒未收到新内容");
        assert_eq!(event.kind.as_deref(), Some("idle_timeout"));
        assert_eq!(event.timeout_secs, Some(12));
    }

    #[tokio::test]
    async fn register_stream_cancel_flag_rejects_overlapping_plain_stream_without_overwriting() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let first_flag = Arc::new(AtomicBool::new(false));
        let second_flag = Arc::new(AtomicBool::new(false));

        register_stream_cancel_flag(
            flags.clone(),
            "conv-1",
            "stream-a",
            first_flag.clone(),
            false,
        )
        .await
        .unwrap();

        let err =
            register_stream_cancel_flag(flags.clone(), "conv-1", "stream-b", second_flag, false)
                .await
                .unwrap_err();

        assert!(err.contains("已有回复正在生成"));
        let guard = flags.lock().await;
        assert!(guard.contains_key("stream-a"));
        assert!(!guard.contains_key("stream-b"));
        assert_eq!(guard.get("stream-a").unwrap().conversation_id, "conv-1");
    }

    #[tokio::test]
    async fn register_stream_cancel_flag_allows_parallel_companion_streams() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));

        register_stream_cancel_flag(
            flags.clone(),
            "conv-1",
            "stream-a",
            Arc::new(AtomicBool::new(false)),
            false,
        )
        .await
        .unwrap();

        register_stream_cancel_flag(
            flags.clone(),
            "conv-1",
            "stream-b",
            Arc::new(AtomicBool::new(false)),
            true,
        )
        .await
        .unwrap();

        let guard = flags.lock().await;
        assert!(guard.contains_key("stream-a"));
        assert!(guard.contains_key("stream-b"));
    }

    #[tokio::test]
    async fn registered_stream_guard_releases_active_stream_when_dropped_before_spawn() {
        let flags = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let cancel_flag = Arc::new(AtomicBool::new(false));

        let guard = RegisteredStreamGuard::register(
            flags.clone(),
            "conv-1",
            "stream-a",
            cancel_flag.clone(),
            false,
        )
        .await
        .unwrap();

        assert!(has_active_stream_for_conversation(flags.clone(), "conv-1").await);

        drop(guard);
        tokio::time::sleep(Duration::from_millis(10)).await;

        assert!(cancel_flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!has_active_stream_for_conversation(flags, "conv-1").await);
    }

    #[test]
    fn unknown_stream_id_does_not_cancel_the_conversation() {
        let live = Arc::new(AtomicBool::new(false));
        let mut flags = std::collections::HashMap::new();
        flags.insert(
            "live".to_string(),
            crate::StreamCancelEntry {
                conversation_id: "conv-1".to_string(),
                flag: live.clone(),
            },
        );
        let cancelled = apply_cancel_flags(&flags, "conv-1", Some("missing"));
        assert!(cancelled.is_empty());
        assert!(!live.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn explicit_stream_id_cannot_cancel_another_conversation() {
        let other = Arc::new(AtomicBool::new(false));
        let mut flags = std::collections::HashMap::new();
        flags.insert(
            "stream-other".to_string(),
            crate::StreamCancelEntry {
                conversation_id: "conv-2".to_string(),
                flag: other.clone(),
            },
        );

        let cancelled = apply_cancel_flags(&flags, "conv-1", Some("stream-other"));

        assert!(cancelled.is_empty());
        assert!(!other.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn none_stream_id_cancels_all_streams_for_the_conversation() {
        let live = Arc::new(AtomicBool::new(false));
        let other = Arc::new(AtomicBool::new(false));
        let mut flags = std::collections::HashMap::new();
        flags.insert(
            "live".to_string(),
            crate::StreamCancelEntry {
                conversation_id: "conv-1".to_string(),
                flag: live.clone(),
            },
        );
        flags.insert(
            "other".to_string(),
            crate::StreamCancelEntry {
                conversation_id: "conv-2".to_string(),
                flag: other.clone(),
            },
        );
        let cancelled = apply_cancel_flags(&flags, "conv-1", None);
        assert_eq!(cancelled.len(), 1);
        cancelled[0].store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(live.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!other.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn terminal_provider_done_chunk_is_emitted_as_delta_until_persisted() {
        let provider_chunk = ChatStreamChunk {
            content: Some("final text".to_string()),
            thinking: None,
            done: true,
            is_final: None,
            usage: None,
            tool_calls: None,
        };

        let emitted = pre_persist_stream_chunk(&provider_chunk).expect("chunk emitted");

        assert_eq!(emitted.content.as_deref(), Some("final text"));
        assert!(!emitted.done);
        assert_eq!(emitted.is_final, None);
    }

    #[test]
    fn terminal_stream_chunk_flushes_retained_text_before_done() {
        let mut filter = aqbot_core::inline_media::InlineDataStreamFilter::default();

        let first = filter_inline_data_stream_event_content(&mut filter, "before da", false);
        let terminal = filter_inline_data_stream_event_content(&mut filter, "ta", true);

        assert_eq!(first, "before ");
        assert_eq!(terminal, "data");
        assert!(filter.finish().is_empty());
    }

    #[test]
    fn terminal_stream_chunk_suppresses_data_uri_before_done() {
        let mut filter = aqbot_core::inline_media::InlineDataStreamFilter::default();

        let first = filter_inline_data_stream_event_content(
            &mut filter,
            "![image](data:image/png;base64,iVBOR",
            false,
        );
        let terminal = filter_inline_data_stream_event_content(&mut filter, "w0KGgo=)", true);

        let emitted = format!("{first}{terminal}");
        assert_eq!(emitted, "![image]([图片接收中])");
        assert!(!emitted.contains("data:image"));
        assert!(!emitted.contains("iVBOR"));
    }

    #[test]
    fn streamed_tool_call_arguments_are_sanitized_without_mutating_backend_value() {
        let raw = ToolCall {
            id: "call-data:image/png;base64,ID".to_string(),
            call_type: "function-data:image/png;base64,TYPE".to_string(),
            function: ToolCallFunction {
                name: "inspect-data:image/png;base64,NAME".to_string(),
                arguments: r#"{"image":"data:image/png;base64,iVBORw0KGgo="}"#.to_string(),
            },
        };

        let emitted = filter_tool_calls_for_event(Some(std::slice::from_ref(&raw))).unwrap();

        assert!(!serde_json::to_string(&emitted)
            .unwrap()
            .contains("data:image"));
        assert!(!serde_json::to_string(&emitted).unwrap().contains("iVBOR"));
        assert!(raw.function.arguments.contains("data:image"));
        assert!(raw.id.contains("data:image"));
        assert!(raw.function.name.contains("data:image"));
    }

    #[test]
    fn complete_mcp_result_filter_preserves_wrapper_after_placeholder() {
        let filtered = format!(
            "{}\n:::\n\n",
            filter_complete_inline_data_event_text("data:image/png;base64,iVBORw0KGgo=")
        );

        assert_eq!(filtered, "[图片接收中]\n:::\n\n");
        assert!(!filtered.contains("data:image"));
    }

    #[test]
    fn append_stream_error_keeps_partial_content_visible() {
        let content = append_stream_error_to_content(
            "已生成的前半段",
            "模型响应空闲超时，已超过 90 秒未收到新内容",
        );

        assert!(content.contains("已生成的前半段"));
        assert!(content.contains("<!-- aqbot-stream-error -->"));
        assert!(content.contains("模型响应空闲超时"));
    }

    #[tokio::test]
    async fn execute_tool_future_returns_cancelled_without_waiting_for_timeout() {
        let cancel_flag = AtomicBool::new(true);
        let started = std::time::Instant::now();

        let (content, is_error) = execute_tool_future(
            pending::<aqbot_core::error::Result<aqbot_core::mcp_client::McpToolResult>>(),
            60,
            Duration::from_secs(60),
            &cancel_flag,
        )
        .await;

        assert_eq!(content, "Error: Tool execution cancelled");
        assert!(is_error);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn execute_tool_future_keeps_caller_timeout() {
        let cancel_flag = AtomicBool::new(false);
        let (content, is_error) = execute_tool_future(
            pending::<aqbot_core::error::Result<aqbot_core::mcp_client::McpToolResult>>(),
            0,
            Duration::ZERO,
            &cancel_flag,
        )
        .await;

        assert_eq!(content, "Error: Tool execution timed out after 0s");
        assert!(is_error);
    }

    #[test]
    fn clean_generated_title_trims_common_quote_wrappers() {
        assert_eq!(
            clean_generated_title("  「项目排期讨论」  "),
            "项目排期讨论"
        );
        assert_eq!(clean_generated_title("\"API 调试记录\""), "API 调试记录");
    }

    #[test]
    fn clean_generated_title_truncates_long_auto_titles() {
        let title = "这是一个用于测试自动会话标题截断逻辑的超长用户问题内容，需要继续追加更多文字";

        assert_eq!(
            clean_generated_title(title),
            title.chars().take(30).collect::<String>() + "..."
        );
    }

    #[test]
    fn generated_title_rejects_inline_media_without_echoing_payload() {
        let error = validated_generated_title("data:image/png;base64,TITLE_SECRET").unwrap_err();

        assert!(error.contains("inline image data"));
        assert!(!error.contains("TITLE_SECRET"));
    }

    #[test]
    fn stream_error_event_sanitizes_every_string_field() {
        let raw = "data:image/png;base64,EVENT_SECRET";
        let event = build_stream_error_event(raw, raw, raw, raw, raw, raw.to_string(), raw, None);
        let serialized = serde_json::to_string(&event).unwrap();

        assert!(!serialized.to_ascii_lowercase().contains("data:image/"));
        assert!(!serialized.contains("EVENT_SECRET"));
    }

    #[test]
    fn should_auto_generate_title_skips_role_conversations() {
        assert!(!should_auto_generate_title(true, "role"));
        assert!(should_auto_generate_title(true, "chat"));
        assert!(should_auto_generate_title(true, "agent"));
        assert!(!should_auto_generate_title(false, "chat"));
    }

    #[test]
    fn system_prompt_log_excerpt_does_not_split_multibyte_characters() {
        let prompt = format!("{}小后续", "a".repeat(79));
        let excerpt = system_prompt_log_excerpt(&prompt);

        assert_eq!(excerpt, "a".repeat(79));
        assert!(prompt.is_char_boundary(excerpt.len()));
    }

    #[test]
    fn assistant_history_extracts_thinking_into_reasoning_content() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let message = Message {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            role: MessageRole::Assistant,
            content: "<think totalMs=\"123\">\nhidden thinking\n</think>\n\nfinal answer".into(),
            provider_id: None,
            model_id: None,
            token_count: None,
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            first_token_latency_ms: None,
            attachments: Vec::new(),
            thinking: None,
            tool_calls_json: None,
            tool_call_id: None,
            created_at: 0,
            parent_message_id: None,
            version_index: 0,
            is_active: true,
            status: "complete".into(),
        };

        let chat_message =
            chat_message_from_message(&file_store, &message, false, None, false).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        assert_eq!(serialized["content"], "final answer");
        assert_eq!(serialized["reasoning_content"], "hidden thinking");
    }

    #[test]
    fn provider_context_reconstructs_complete_tool_call_groups() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "user-1",
                MessageRole::User,
                "please read",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "tool-assistant-1",
                MessageRole::Assistant,
                "<think totalMs=\"3\">need file</think>",
                Some("user-1"),
                -1,
                false,
                Some(
                    r#"[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]"#,
                ),
                None,
            ),
            test_message(
                "tool-1",
                MessageRole::Tool,
                "file content",
                Some("tool-assistant-1"),
                -1,
                false,
                None,
                Some("call-1"),
            ),
            test_message(
                "assistant-1",
                MessageRole::Assistant,
                "<think totalMs=\"7\">final thinking</think>\n\n:::mcp {\"id\":\"call-1\",\"tool\":\"read_file\"}\nfile content\n:::\n\nread done",
                Some("user-1"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "user-2",
                MessageRole::User,
                "next question",
                None,
                0,
                true,
                None,
                None,
            ),
        ];

        let context = build_provider_context_messages(
            &file_store,
            &messages,
            false,
            None,
            Some("user-2"),
            None,
        )
        .unwrap();

        assert_eq!(
            context
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "assistant", "user"]
        );
        assert_eq!(context[1].reasoning_content.as_deref(), Some("need file"));
        assert_eq!(context[1].tool_calls.as_ref().unwrap()[0].id, "call-1");
        assert_eq!(context[2].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(context[3].reasoning_content, None);
    }

    #[test]
    fn summary_boundary_keeps_messages_after_compressed_until_even_when_marker_is_later() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "old-user",
                MessageRole::User,
                "old user",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "old-assistant",
                MessageRole::Assistant,
                "old assistant",
                Some("old-user"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "current-user",
                MessageRole::User,
                "current user that triggered compression",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "compression-marker",
                MessageRole::System,
                crate::context_manager::COMPRESSION_MARKER,
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "current-assistant",
                MessageRole::Assistant,
                "answer after compression",
                Some("current-user"),
                0,
                true,
                None,
                None,
            ),
        ];
        let summary = test_summary(Some("old-assistant"));
        let boundary = resolve_context_boundary(&messages, Some(&summary));

        assert!(boundary.use_summary);
        let context = build_provider_context_messages_from_index(
            &file_store,
            &messages,
            boundary.start_index,
            false,
            None,
            Some("current-user"),
            None,
        )
        .unwrap();

        let text = context
            .iter()
            .filter_map(|message| match &message.content {
                ChatContent::Text(content) => Some(content.as_str()),
                ChatContent::Multipart(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            text,
            vec![
                "current user that triggered compression",
                "answer after compression"
            ]
        );
    }

    #[test]
    fn raw_strict_provider_context_restores_original_history_and_ignores_summary_marker() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "old-user",
                MessageRole::User,
                "original detail before summary",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "old-assistant",
                MessageRole::Assistant,
                "original answer before summary",
                Some("old-user"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "compression-marker",
                MessageRole::System,
                crate::context_manager::COMPRESSION_MARKER,
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "new-user",
                MessageRole::User,
                "current question",
                None,
                0,
                true,
                None,
                None,
            ),
        ];
        let summary = test_summary(Some("old-assistant"));
        let boundary = resolve_context_boundary_for_strategy(
            &messages,
            Some(&summary),
            ContextStrategy::RawStrict,
            None,
        );
        assert_eq!(boundary.start_index, 0);
        assert!(!boundary.use_summary);

        let history = build_provider_context_messages_from_index(
            &file_store,
            &messages,
            boundary.start_index,
            false,
            None,
            Some("new-user"),
            None,
        )
        .unwrap();
        let final_context = crate::context_manager::build_context_for_strategy(
            &[],
            &history,
            Some("must stay dormant"),
            ContextStrategy::RawStrict,
            Some(usize::MAX),
        )
        .unwrap();
        let text = final_context
            .messages
            .iter()
            .filter_map(|message| match &message.content {
                ChatContent::Text(content) => Some(content.as_str()),
                ChatContent::Multipart(_) => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(
            text,
            vec![
                "original detail before summary",
                "original answer before summary",
                "current question"
            ]
        );
        assert!(!text
            .iter()
            .any(|content| content.contains("must stay dormant")));
    }

    #[test]
    fn raw_provider_boundary_respects_latest_context_clear() {
        let messages = vec![
            test_message(
                "old-user",
                MessageRole::User,
                "old",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "compression-marker",
                MessageRole::System,
                crate::context_manager::COMPRESSION_MARKER,
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "clear-marker",
                MessageRole::System,
                crate::context_manager::CONTEXT_CLEAR_MARKER,
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "new-user",
                MessageRole::User,
                "new",
                None,
                0,
                true,
                None,
                None,
            ),
        ];

        let boundary = resolve_context_boundary_for_strategy(
            &messages,
            None,
            ContextStrategy::RawTruncate,
            None,
        );

        assert_eq!(boundary.start_index, 3);
        assert!(!boundary.use_summary);
    }

    #[test]
    fn historical_regeneration_never_uses_a_summary_that_contains_future_turns() {
        let messages = vec![
            test_message(
                "old-user",
                MessageRole::User,
                "old",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "target-user",
                MessageRole::User,
                "regenerate here",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "future-assistant",
                MessageRole::Assistant,
                "future",
                Some("target-user"),
                0,
                true,
                None,
                None,
            ),
        ];
        let summary = test_summary(Some("future-assistant"));

        let boundary = resolve_context_boundary_for_strategy(
            &messages,
            Some(&summary),
            ContextStrategy::SmartSummary,
            Some("target-user"),
        );

        assert_eq!(boundary.start_index, 0);
        assert!(!boundary.use_summary);
    }

    #[test]
    fn historical_regeneration_ignores_context_clear_markers_after_the_target() {
        let messages = vec![
            test_message(
                "old-user",
                MessageRole::User,
                "old",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "old-assistant",
                MessageRole::Assistant,
                "old answer",
                Some("old-user"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "target-user",
                MessageRole::User,
                "regenerate here",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "future-clear",
                MessageRole::System,
                crate::context_manager::CONTEXT_CLEAR_MARKER,
                None,
                0,
                true,
                None,
                None,
            ),
        ];
        let summary = test_summary(Some("old-assistant"));

        let boundary = resolve_context_boundary_for_strategy(
            &messages,
            Some(&summary),
            ContextStrategy::SmartSummary,
            Some("target-user"),
        );

        assert_eq!(boundary.start_index, 2);
        assert!(boundary.use_summary);
    }

    #[test]
    fn context_clear_after_summary_boundary_disables_old_summary() {
        let messages = vec![
            test_message(
                "old-user",
                MessageRole::User,
                "old user",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "old-assistant",
                MessageRole::Assistant,
                "old assistant",
                Some("old-user"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "clear-marker",
                MessageRole::System,
                "<!-- context-clear -->",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "new-user",
                MessageRole::User,
                "new user",
                None,
                0,
                true,
                None,
                None,
            ),
        ];
        let summary = test_summary(Some("old-assistant"));
        let boundary = resolve_context_boundary(&messages, Some(&summary));

        assert!(!boundary.use_summary);
        assert_eq!(boundary.start_index, 3);
    }

    #[test]
    fn provider_context_ignores_stale_tool_scaffolding_from_inactive_versions() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "user-1",
                MessageRole::User,
                "please read",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "old-tool-assistant",
                MessageRole::Assistant,
                "<think>old tool</think>",
                Some("user-1"),
                -1,
                false,
                Some(
                    r#"[{"id":"call-old","type":"function","function":{"name":"read_file","arguments":"{}"}}]"#,
                ),
                None,
            ),
            test_message(
                "old-tool",
                MessageRole::Tool,
                "old file content",
                Some("old-tool-assistant"),
                -1,
                false,
                None,
                Some("call-old"),
            ),
            test_message(
                "new-tool-assistant",
                MessageRole::Assistant,
                "<think>new tool</think>",
                Some("user-1"),
                -1,
                false,
                Some(
                    r#"[{"id":"call-new","type":"function","function":{"name":"read_file","arguments":"{}"}}]"#,
                ),
                None,
            ),
            test_message(
                "new-tool",
                MessageRole::Tool,
                "new file content",
                Some("new-tool-assistant"),
                -1,
                false,
                None,
                Some("call-new"),
            ),
            test_message(
                "assistant-1",
                MessageRole::Assistant,
                ":::mcp {\"id\":\"call-new\",\"tool\":\"read_file\"}\nnew file content\n:::\n\nread done",
                Some("user-1"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "user-2",
                MessageRole::User,
                "next question",
                None,
                0,
                true,
                None,
                None,
            ),
        ];

        let context = build_provider_context_messages(
            &file_store,
            &messages,
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

        assert_eq!(tool_call_ids, vec!["call-new"]);
        assert!(!context.iter().any(|message| {
            matches!(&message.content, ChatContent::Text(content) if content.contains("old file content"))
        }));
    }

    #[test]
    fn provider_context_downgrades_malformed_tool_call_groups() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let messages = vec![
            test_message(
                "user-1",
                MessageRole::User,
                "please read",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "tool-assistant-1",
                MessageRole::Assistant,
                "<think totalMs=\"3\">need file</think>",
                Some("user-1"),
                -1,
                false,
                Some(
                    r#"[{"id":"","type":"function","function":{"name":"read_file","arguments":"{}"}}]"#,
                ),
                None,
            ),
            test_message(
                "tool-1",
                MessageRole::Tool,
                "file content",
                Some("tool-assistant-1"),
                -1,
                false,
                None,
                Some("call-1"),
            ),
            test_message(
                "assistant-1",
                MessageRole::Assistant,
                "<think totalMs=\"7\">final thinking</think>\n\nread done",
                Some("user-1"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "user-2",
                MessageRole::User,
                "next question",
                None,
                0,
                true,
                None,
                None,
            ),
        ];

        let context = build_provider_context_messages(
            &file_store,
            &messages,
            false,
            None,
            Some("user-2"),
            None,
        )
        .unwrap();

        assert_eq!(
            context
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            vec!["user", "assistant", "user"]
        );
        assert!(context.iter().all(|message| message.tool_calls.is_none()));
        assert!(context.iter().all(|message| message.tool_call_id.is_none()));
        assert!(context
            .iter()
            .filter(|message| message.role == "assistant")
            .all(|message| message.reasoning_content.is_none()));
    }

    #[test]
    fn historical_user_search_context_is_stripped_from_model_history() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let message = Message {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            role: MessageRole::User,
            content: concat!(
                "<!-- search:{\"sources\":[{\"title\":\"A\",\"url\":\"https://example.com\"}]} -->\n",
                "以下是与问题相关的网络搜索结果，请参考回答：\n\n",
                "1. **A** - https://example.com\n   search body\n\n",
                "---\n\n",
                "用户原始问题"
            )
            .into(),
            provider_id: None,
            model_id: None,
            token_count: None,
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            first_token_latency_ms: None,
            attachments: Vec::new(),
            thinking: None,
            tool_calls_json: None,
            tool_call_id: None,
            created_at: 0,
            parent_message_id: None,
            version_index: 0,
            is_active: true,
            status: "complete".into(),
        };

        let chat_message =
            chat_message_from_message(&file_store, &message, false, None, false).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        assert_eq!(serialized["content"], "用户原始问题");
    }

    #[test]
    fn current_user_search_context_is_preserved_for_model_request() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let content = concat!(
            "<!-- search:{\"sources\":[{\"title\":\"A\",\"url\":\"https://example.com\"}],\"query\":\"AQBot 产品详情\",\"queryStatus\":\"error\",\"queryError\":\"搜索语句总结失败：AI returned empty search query\"} -->\n",
            "以下是与问题相关的网络搜索结果，请参考回答：\n\n",
            "1. **A** - https://example.com\n   search body\n\n",
            "---\n\n",
            "用户原始问题"
        );
        let message = Message {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            role: MessageRole::User,
            content: content.into(),
            provider_id: None,
            model_id: None,
            token_count: None,
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            first_token_latency_ms: None,
            attachments: Vec::new(),
            thinking: None,
            tool_calls_json: None,
            tool_call_id: None,
            created_at: 0,
            parent_message_id: None,
            version_index: 0,
            is_active: true,
            status: "complete".into(),
        };

        let chat_message =
            chat_message_from_message(&file_store, &message, false, None, true).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        let content = serialized["content"].as_str().unwrap();
        assert!(content.contains("search body"));
        assert!(content.contains("用户原始问题"));
        assert!(!content.contains("<!-- search:"));
        assert!(!content.contains("搜索语句总结失败"));
    }

    #[test]
    fn assistant_history_strips_web_search_display_tags() {
        let file_store = aqbot_core::file_store::FileStore::new();
        let message = Message {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            role: MessageRole::Assistant,
            content: concat!(
                "<web-search-query status=\"done\" query=\"AQBot 产品详情\" data-aqbot=\"1\">",
                "</web-search-query>\n\n",
                "<web-search status=\"done\" data-aqbot=\"1\">\n",
                "[{\"title\":\"A\",\"url\":\"https://example.com\",\"content\":\"search body\"}]\n",
                "</web-search>\n\n",
                "final answer"
            )
            .into(),
            provider_id: None,
            model_id: None,
            token_count: None,
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            first_token_latency_ms: None,
            attachments: Vec::new(),
            thinking: None,
            tool_calls_json: None,
            tool_call_id: None,
            created_at: 0,
            parent_message_id: None,
            version_index: 0,
            is_active: true,
            status: "complete".into(),
        };

        let chat_message =
            chat_message_from_message(&file_store, &message, false, None, false).unwrap();
        let serialized = serde_json::to_value(chat_message).unwrap();

        assert_eq!(serialized["content"], "final answer");
    }

    #[test]
    fn resolve_compressed_until_with_keep_last_n() {
        let messages = vec![
            test_message("u1", MessageRole::User, "u1", None, 0, true, None, None),
            test_message(
                "a1",
                MessageRole::Assistant,
                "a1",
                Some("u1"),
                0,
                true,
                None,
                None,
            ),
            test_message("u2", MessageRole::User, "u2", None, 0, true, None, None),
            test_message(
                "a2",
                MessageRole::Assistant,
                "a2",
                Some("u2"),
                0,
                true,
                None,
                None,
            ),
            test_message("u3", MessageRole::User, "u3", None, 0, true, None, None),
        ];

        // keep 0 → compress all
        assert_eq!(
            resolve_compressed_until_with_keep(&messages, 0, 0, None).as_deref(),
            Some("u3")
        );
        // keep 3 → compress u1,a1; until a1
        assert_eq!(
            resolve_compressed_until_with_keep(&messages, 0, 3, None).as_deref(),
            Some("a1")
        );
        // keep 2 would split u2 from its answer a2; retain the whole turn.
        assert_eq!(
            resolve_compressed_until_with_keep(&messages, 0, 2, None).as_deref(),
            Some("a1")
        );
        // keep 5 → nothing to compress
        assert_eq!(
            resolve_compressed_until_with_keep(&messages, 0, 5, None),
            None
        );
        // auto: force retain from u3, keep 0 → until a2
        assert_eq!(
            resolve_compressed_until_with_keep(&messages, 0, 0, Some("u3")).as_deref(),
            Some("a2")
        );
        // auto: force u3, keep 3 → retain u2,a2,u3 → until a1
        assert_eq!(
            resolve_compressed_until_with_keep(&messages, 0, 3, Some("u3")).as_deref(),
            Some("a1")
        );
    }

    #[test]
    fn auto_compression_starts_after_messages_excluded_by_count_limit() {
        let messages = vec![
            test_message(
                "u1",
                MessageRole::User,
                "old user",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "a1",
                MessageRole::Assistant,
                "old answer",
                Some("u1"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "u2",
                MessageRole::User,
                "kept user",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "a2",
                MessageRole::Assistant,
                "kept answer",
                Some("u2"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "u3",
                MessageRole::User,
                "current user",
                None,
                0,
                true,
                None,
                None,
            ),
        ];
        let file_store = aqbot_core::file_store::FileStore::new();
        let provider_history = build_provider_context_messages_with_sources_from_index(
            &file_store,
            &messages,
            0,
            false,
            None,
            Some("u3"),
            None,
        )
        .unwrap();
        let limited =
            crate::context_manager::apply_message_count_limit(&provider_history.messages, Some(3));
        let excluded = provider_history.messages.len() - limited.len();
        let boundary = resolve_auto_compression_boundary(
            &messages,
            0,
            &provider_history.source_indices,
            excluded,
            1,
            "u3",
        )
        .unwrap();

        assert_eq!(boundary.start_index, 2);
        assert_eq!(boundary.compressed_until_message_id, "a2");

        let payload = build_provider_context_messages_from_index(
            &file_store,
            &messages,
            boundary.start_index,
            false,
            None,
            None,
            Some(&boundary.compressed_until_message_id),
        )
        .unwrap();
        let payload_text = payload
            .iter()
            .filter_map(|message| match &message.content {
                ChatContent::Text(content) => Some(content.as_str()),
                ChatContent::Multipart(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(payload_text, vec!["kept user", "kept answer"]);
    }

    #[test]
    fn historical_auto_compression_excludes_target_and_future_messages() {
        let messages = vec![
            test_message(
                "u1",
                MessageRole::User,
                "old user",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "a1",
                MessageRole::Assistant,
                "old answer",
                Some("u1"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "u2",
                MessageRole::User,
                "regenerate target",
                None,
                0,
                true,
                None,
                None,
            ),
            test_message(
                "a2",
                MessageRole::Assistant,
                "future answer",
                Some("u2"),
                0,
                true,
                None,
                None,
            ),
            test_message(
                "u3",
                MessageRole::User,
                "future user",
                None,
                0,
                true,
                None,
                None,
            ),
        ];
        let file_store = aqbot_core::file_store::FileStore::new();
        let provider_history = build_provider_context_messages_with_sources_from_index(
            &file_store,
            &messages,
            0,
            false,
            None,
            Some("u2"),
            Some("u2"),
        )
        .unwrap();
        let boundary = resolve_auto_compression_boundary(
            &messages,
            0,
            &provider_history.source_indices,
            0,
            0,
            "u2",
        )
        .unwrap();

        assert_eq!(boundary.compressed_until_message_id, "a1");
        let source = build_provider_context_messages_from_index(
            &file_store,
            &messages,
            boundary.start_index,
            false,
            None,
            None,
            Some(&boundary.compressed_until_message_id),
        )
        .unwrap();
        let retained = build_provider_context_messages_from_index(
            &file_store,
            &messages,
            boundary.compressed_until_index + 1,
            false,
            None,
            Some("u2"),
            Some("u2"),
        )
        .unwrap();

        assert_eq!(
            source
                .iter()
                .map(|message| match &message.content {
                    ChatContent::Text(content) => content.as_str(),
                    ChatContent::Multipart(_) => panic!("unexpected multipart test message"),
                })
                .collect::<Vec<_>>(),
            vec!["old user", "old answer"]
        );
        assert_eq!(
            retained
                .iter()
                .map(|message| match &message.content {
                    ChatContent::Text(content) => content.as_str(),
                    ChatContent::Multipart(_) => panic!("unexpected multipart test message"),
                })
                .collect::<Vec<_>>(),
            vec!["regenerate target"]
        );
    }

    #[test]
    fn auto_compression_excludes_current_user_from_summary_and_keeps_it_for_request() {
        let history_messages = vec![
            ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("old user message".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: ChatContent::Text("old assistant message".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("current user message with search body".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
        ];

        // keep_last_n=0 still retains the current user turn
        let (messages_to_compress, post_compression_history) =
            split_auto_compression_history(&history_messages, Some(2), 0);

        assert_eq!(messages_to_compress.len(), 2);
        assert_eq!(post_compression_history.len(), 1);
        assert!(matches!(
            &post_compression_history[0].content,
            ChatContent::Text(content) if content == "current user message with search body"
        ));
        assert!(!messages_to_compress.iter().any(|message| {
            matches!(
                &message.content,
                ChatContent::Text(content) if content.contains("current user message")
            )
        }));

        // keep_last_n=3 retains last 3 including current user
        let (to_compress_n3, retained_n3) =
            split_auto_compression_history(&history_messages, Some(2), 3);
        assert!(to_compress_n3.is_empty());
        assert_eq!(retained_n3.len(), 3);
    }

    #[test]
    fn clean_generated_search_query_keeps_only_plain_query_text() {
        assert_eq!(
            clean_generated_search_query("搜索查询：\"AQBot Windows 0.0.76 下载\""),
            "AQBot Windows 0.0.76 下载"
        );
        assert_eq!(
            clean_generated_search_query("```text\nChrome 网站权限 设置\n```"),
            "Chrome 网站权限 设置"
        );
    }

    #[test]
    fn search_query_prompt_uses_latest_user_message_and_history() {
        let messages = build_search_query_generation_messages(
            &[
                ChatMessage {
                    role: "user".to_string(),
                    content: ChatContent::Text(
                        "帮我搜索 AQBot Desktop Windows 下载地址".to_string(),
                    ),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "assistant".to_string(),
                    content: ChatContent::Text("需要联网搜索确认。".to_string()),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                },
            ],
            "没事，给你权限了，你可以搜索和打开任何网页了",
        );
        let prompt = match &messages[1].content {
            ChatContent::Text(content) => content,
            ChatContent::Multipart(_) => panic!("expected text prompt"),
        };

        assert!(prompt.contains("AQBot Desktop Windows 下载地址"));
        assert!(prompt.contains("没事，给你权限了"));
        assert!(prompt.contains("Return only the search query"));
    }

    #[test]
    fn empty_search_query_response_requires_retry_without_using_thinking() {
        let response = ChatResponse {
            id: "resp-1".to_string(),
            model: "mimo-v2.5".to_string(),
            content: String::new(),
            thinking: Some("AQBot 产品详情".to_string()),
            usage: TokenUsage {
                prompt_tokens: 100,
                completion_tokens: 96,
                total_tokens: 196,
            },
            tool_calls: None,
        };

        let err = clean_generated_search_query_response(&response)
            .expect_err("empty content should fail");

        assert!(err.contains("empty content"));
        assert!(err.contains("thinking present"));
        assert!(!err.contains("AQBot 产品详情"));
    }

    #[test]
    fn generated_search_query_rejects_inline_media_without_echoing_it() {
        let response = ChatResponse {
            id: "resp-media".to_string(),
            model: "model".to_string(),
            content: "data:image/png;base64,SEARCH_SECRET".to_string(),
            thinking: None,
            usage: TokenUsage {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
            },
            tool_calls: None,
        };

        let error = clean_generated_search_query_response(&response).unwrap_err();

        assert!(error.contains("inline image data"));
        assert!(!error.contains("SEARCH_SECRET"));
    }

    #[test]
    fn retry_search_query_prompt_requires_a_non_empty_query() {
        let messages = build_retry_search_query_generation_messages(
            &[
                ChatMessage {
                    role: "user".to_string(),
                    content: ChatContent::Text("licoy 的最新开源项目".to_string()),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "assistant".to_string(),
                    content: ChatContent::Text("第一个产品是 AQBot。".to_string()),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                },
            ],
            "给我第一个产品的详情",
        );
        let prompt = match &messages[1].content {
            ChatContent::Text(content) => content,
            ChatContent::Multipart(_) => panic!("expected text prompt"),
        };

        assert!(prompt.contains("must return exactly one non-empty search query"));
        assert!(prompt.contains("给我第一个产品的详情"));
        assert!(prompt.contains("AQBot"));
    }

    #[test]
    fn retry_search_query_request_uses_enough_tokens_for_thinking_models() {
        assert!(
            SEARCH_QUERY_RETRY_MAX_TOKENS >= 1024,
            "retry query generation needs enough output budget for models that emit reasoning before visible content"
        );
    }

    #[test]
    fn model_sampling_params_override_global_defaults_when_conversation_params_are_unset() {
        let mut settings = AppSettings::default();
        settings.default_temperature = Some(0.875);
        settings.default_top_p = Some(0.9375);
        settings.default_max_tokens = Some(32768);

        let params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(Some(0.25), Some(4096), Some(0.75))),
            &settings,
            None,
            None,
            None,
        );

        assert_eq!(params.temperature, Some(0.25));
        assert_eq!(params.top_p, Some(0.75));
        assert_eq!(params.max_tokens, Some(32768));
    }

    #[test]
    fn conversation_params_override_model_and_global_defaults() {
        let mut settings = AppSettings::default();
        settings.default_temperature = Some(0.875);
        settings.default_top_p = Some(0.9375);
        settings.default_max_tokens = Some(32768);

        let params = resolve_chat_model_params(
            &test_conversation(Some(0.5), Some(8192), Some(0.625)),
            Some(&test_param_overrides(Some(0.25), Some(4096), Some(0.75))),
            &settings,
            None,
            None,
            None,
        );

        assert_eq!(params.temperature, Some(0.5));
        assert_eq!(params.top_p, Some(0.625));
        assert_eq!(params.max_tokens, Some(8192));
    }

    #[test]
    fn model_max_tokens_is_not_sent_when_force_max_tokens_is_disabled() {
        let settings = AppSettings::default();

        let params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(None, Some(1_048_576), None)),
            &settings,
            None,
            Some(false),
            None,
        );

        assert_eq!(params.max_tokens, None);
    }

    #[test]
    fn model_max_tokens_does_not_apply_just_because_max_completion_tokens_is_enabled() {
        let mut settings = AppSettings::default();
        settings.default_max_tokens = Some(32768);

        let params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(None, Some(2048), None)),
            &settings,
            Some(true),
            None,
            None,
        );

        assert_eq!(params.max_tokens, Some(32768));
    }

    #[test]
    fn force_max_tokens_uses_specific_defaults_before_falling_back_to_4096() {
        let mut settings = AppSettings::default();
        settings.default_max_tokens = Some(32768);

        let model_params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            Some(&test_param_overrides(None, Some(4096), None)),
            &settings,
            None,
            Some(true),
            None,
        );
        assert_eq!(model_params.max_tokens, Some(4096));

        settings.default_max_tokens = None;
        let fallback_params = resolve_chat_model_params(
            &test_conversation(None, None, None),
            None,
            &settings,
            None,
            Some(true),
            None,
        );
        assert_eq!(fallback_params.max_tokens, Some(4096));
    }

    #[test]
    fn model_output_limit_clamps_configured_value_but_is_not_a_default() {
        let mut settings = AppSettings::default();
        settings.default_max_tokens = Some(32_768);
        let clamped = resolve_chat_model_params(
            &test_conversation(None, None, None),
            None,
            &settings,
            None,
            None,
            Some(8_192),
        );
        assert_eq!(clamped.max_tokens, Some(8_192));

        settings.default_max_tokens = None;
        let unset = resolve_chat_model_params(
            &test_conversation(None, None, None),
            None,
            &settings,
            None,
            None,
            Some(8_192),
        );
        assert_eq!(unset.max_tokens, None);
    }

    #[test]
    fn omit_sampling_params_removes_temperature_and_top_p() {
        let mut overrides = test_param_overrides(Some(0.25), None, Some(0.75));
        overrides.omit_sampling_params = Some(true);
        let params = resolve_chat_model_params(
            &test_conversation(Some(0.5), None, Some(0.625)),
            Some(&overrides),
            &AppSettings::default(),
            None,
            None,
            None,
        );
        assert_eq!(params.temperature, None);
        assert_eq!(params.top_p, None);
    }

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
                prompt_tokens: None,
                completion_tokens: None,
                tokens_per_second: None,
                first_token_latency_ms: None,
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
                status: "done".into(),
            };

            build_message_content(&file_store, &message, false, None, false).unwrap()
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
                prompt_tokens: None,
                completion_tokens: None,
                tokens_per_second: None,
                first_token_latency_ms: None,
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
                status: "done".into(),
            };

            build_message_content(&file_store, &message, false, None, false).unwrap()
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

    #[test]
    fn build_message_content_appends_document_text_when_enabled() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-document-attachment-test-{}",
            aqbot_core::utils::gen_id()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let result = (|| {
            let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
            let docx = test_docx_bytes("Alpha project requirements");
            let saved = file_store
                .save_file(
                    &docx,
                    "requirements.docx",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                .unwrap();
            let message = Message {
                id: "msg-1".into(),
                conversation_id: "conv-1".into(),
                role: MessageRole::User,
                content: "Summarize this".into(),
                provider_id: None,
                model_id: None,
                token_count: None,
                prompt_tokens: None,
                completion_tokens: None,
                tokens_per_second: None,
                first_token_latency_ms: None,
                attachments: vec![Attachment {
                    id: "att-1".into(),
                    file_type:
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            .into(),
                    file_name: "requirements.docx".into(),
                    file_path: saved.storage_path,
                    file_size: docx.len() as u64,
                    data: None,
                }],
                thinking: None,
                tool_calls_json: None,
                tool_call_id: None,
                created_at: 0,
                parent_message_id: None,
                version_index: 0,
                is_active: true,
                status: "done".into(),
            };

            build_message_content(&file_store, &message, true, Some(4096), false).unwrap()
        })();

        fs::remove_dir_all(&temp_dir).unwrap();

        match result {
            ChatContent::Text(text) => {
                assert!(text.contains("Summarize this"));
                assert!(text.contains("requirements.docx"));
                assert!(text.contains("Alpha project requirements"));
            }
            ChatContent::Multipart(_) => panic!("expected text content"),
        }
    }

    #[test]
    fn build_message_content_ignores_document_text_when_disabled() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-document-disabled-test-{}",
            aqbot_core::utils::gen_id()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let result = (|| {
            let file_store = aqbot_core::file_store::FileStore::with_root(temp_dir.clone());
            let docx = test_docx_bytes("Hidden project requirements");
            let saved = file_store
                .save_file(
                    &docx,
                    "requirements.docx",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                .unwrap();
            let message = Message {
                id: "msg-1".into(),
                conversation_id: "conv-1".into(),
                role: MessageRole::User,
                content: "Summarize this".into(),
                provider_id: None,
                model_id: None,
                token_count: None,
                prompt_tokens: None,
                completion_tokens: None,
                tokens_per_second: None,
                first_token_latency_ms: None,
                attachments: vec![Attachment {
                    id: "att-1".into(),
                    file_type:
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            .into(),
                    file_name: "requirements.docx".into(),
                    file_path: saved.storage_path,
                    file_size: docx.len() as u64,
                    data: None,
                }],
                thinking: None,
                tool_calls_json: None,
                tool_call_id: None,
                created_at: 0,
                parent_message_id: None,
                version_index: 0,
                is_active: true,
                status: "done".into(),
            };

            build_message_content(&file_store, &message, false, Some(4096), false).unwrap()
        })();

        fs::remove_dir_all(&temp_dir).unwrap();

        match result {
            ChatContent::Text(text) => assert_eq!(text, "Summarize this"),
            ChatContent::Multipart(_) => panic!("expected text content"),
        }
    }

    #[tokio::test]
    async fn delete_conversation_removes_attached_files_and_records() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-conv-delete-test-{}",
            aqbot_core::utils::gen_id()
        ));
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
        assert!(
            physical_path.exists(),
            "fixture file must exist before deleting the conversation"
        );

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

        let result =
            delete_conversation_with_attachments_using(&db, &file_store, &conversation.id).await;
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
    async fn branched_media_survives_source_deletion_until_last_reference() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let temp_dir = tempfile::tempdir().unwrap();
        let file_store =
            aqbot_core::file_store::FileStore::with_root(temp_dir.path().to_path_buf());
        let source = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Media source",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let saved = file_store
            .save_file(b"shared media", "inline.png", "image/png")
            .unwrap();
        let physical_path = temp_dir.path().join(&saved.storage_path);
        aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "source-file",
            &saved.hash,
            "inline.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&source.id),
        )
        .await
        .unwrap();
        let source_message = aqbot_core::repo::message::create_message(
            &db,
            &source.id,
            MessageRole::Assistant,
            "![preview](aqbot-media://stored/source-file)",
            &[Attachment {
                id: "source-file".to_string(),
                file_type: "image/png".to_string(),
                file_name: "inline.png".to_string(),
                file_path: saved.storage_path.clone(),
                file_size: saved.size_bytes as u64,
                data: None,
            }],
            None,
            0,
        )
        .await
        .unwrap();

        let branch = aqbot_core::repo::conversation::branch_conversation(
            &db,
            &source.id,
            &source_message.id,
            false,
            None,
        )
        .await
        .unwrap();
        let branch_files =
            aqbot_core::repo::stored_file::list_stored_files_by_conversation(&db, &branch.id)
                .await
                .unwrap();
        assert_eq!(branch_files.len(), 1);
        assert_ne!(branch_files[0].id, "source-file");
        assert_eq!(branch_files[0].storage_path, saved.storage_path);
        assert_eq!(branch_files[0].hash, saved.hash);
        let branch_messages = aqbot_core::repo::message::list_messages(&db, &branch.id)
            .await
            .unwrap();
        assert_eq!(branch_messages.len(), 1);
        assert_eq!(branch_messages[0].attachments[0].id, branch_files[0].id);
        assert_eq!(
            branch_messages[0].content,
            format!("![preview](aqbot-media://stored/{})", branch_files[0].id)
        );

        delete_conversation_with_attachments_using(&db, &file_store, &source.id)
            .await
            .unwrap();
        assert!(physical_path.exists());
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, &branch_files[0].id)
                .await
                .is_ok()
        );

        delete_conversation_with_attachments_using(&db, &file_store, &branch.id)
            .await
            .unwrap();
        assert!(!physical_path.exists());
    }

    #[tokio::test]
    async fn deleting_conversation_preserves_media_referenced_by_drawing() {
        use aqbot_core::repo::drawing::NewDrawingGeneration;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let temp_dir = tempfile::tempdir().unwrap();
        let file_store =
            aqbot_core::file_store::FileStore::with_root(temp_dir.path().to_path_buf());
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Drawing reference owner",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let saved = file_store
            .save_file(b"drawing reference", "reference.png", "image/png")
            .unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "drawing-reference-file",
            &saved.hash,
            "reference.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&conversation.id),
        )
        .await
        .unwrap();
        let generation = aqbot_core::repo::drawing::create_generation(
            &db,
            NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "provider-1".into(),
                key_id: "key-1".into(),
                model_id: "gpt-image-2".into(),
                action: "edit".into(),
                prompt: "preserve".into(),
                parameters_json: "{}".into(),
                reference_file_ids_json: serde_json::to_string(&vec![stored.id.clone()]).unwrap(),
                source_image_ids_json: "[]".into(),
                mask_file_id: None,
                adapter_id: None,
                adapter_config_snapshot: None,
                deadline_at: None,
            },
        )
        .await
        .unwrap();

        delete_conversation_with_attachments_using(&db, &file_store, &conversation.id)
            .await
            .unwrap();

        assert!(
            aqbot_core::repo::conversation::get_conversation(&db, &conversation.id)
                .await
                .is_err()
        );
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, &stored.id)
                .await
                .is_ok()
        );
        assert!(file_store.read_file(&stored.storage_path).is_ok());
        let fetched = aqbot_core::repo::drawing::get_generation(&db, &generation.id)
            .await
            .unwrap();
        assert_eq!(fetched.reference_files[0].id, stored.id);
    }

    #[tokio::test]
    async fn persist_attachments_registers_stored_files_for_files_page() {
        use base64::Engine;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let temp_dir = std::env::temp_dir().join(format!(
            "aqbot-persist-attachments-test-{}",
            aqbot_core::utils::gen_id()
        ));
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

        let vector_store = Arc::new(aqbot_core::vector_store::VectorStore::new(db.clone()));
        let state = crate::AppState {
            sea_db: db.clone(),
            master_key: [0; 32],
            mcp_stdio_clients: Arc::new(aqbot_core::mcp_client::StdioClientManager::new()),
            gateway: Arc::new(Mutex::new(None)),
            close_to_tray: Arc::new(AtomicBool::new(false)),
            release_webview_on_tray: Arc::new(AtomicBool::new(false)),
            main_window_released_to_tray: Arc::new(AtomicBool::new(false)),
            main_window_restoring: Arc::new(AtomicBool::new(false)),
            is_quitting: Arc::new(AtomicBool::new(false)),
            model_catalog: Arc::new(crate::model_catalog::ModelCatalogService::new(
                temp_dir.join("model_metadata"),
                crate::model_catalog::ModelCatalogConfig::default(),
            )),
            app_data_dir: temp_dir.clone(),
            db_path: "sqlite::memory:".to_string(),
            auto_backup_handle: Arc::new(Mutex::new(None)),
            webdav_sync_handle: Arc::new(Mutex::new(None)),
            s3_sync_handle: Arc::new(Mutex::new(None)),
            vector_store,
            knowledge_index_scheduler: Arc::new(
                crate::knowledge_index_scheduler::KnowledgeIndexScheduler::default(),
            ),
            stream_cancel_flags: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_cancel_tokens: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_permission_senders: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_ask_senders: Arc::new(Mutex::new(std::collections::HashMap::new())),
            agent_always_allowed: Arc::new(Mutex::new(std::collections::HashMap::new())),
            selection_toolbar: Arc::new(crate::selection_toolbar::SelectionToolbarRuntime::new()),
            pending_tray_action: Arc::new(std::sync::Mutex::new(None)),
            multi_model_runs: Arc::new(crate::multi_model_run::MultiModelRunManager::new()),
            conversation_runs: crate::conversation_run::ConversationRunRegistry::new(),
            tray_enabled: Arc::new(AtomicBool::new(true)),
            tray_available: Arc::new(AtomicBool::new(true)),
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
        let _ = aqbot_core::file_store::FileStore::new().delete_file(&persisted[0].file_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn persist_attachments_rolls_back_rows_and_new_files_on_batch_failure() {
        use base64::Engine;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Attachment rollback",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let state = test_app_state(db.clone());
        let bytes = format!("unique-{}", aqbot_core::utils::gen_id()).into_bytes();
        let file_name = format!("rollback-{}.png", aqbot_core::utils::gen_id());
        let expected_path = aqbot_core::storage_paths::build_relative_path(
            &file_name,
            "image/png",
            &aqbot_core::file_store::FileStore::hash_bytes(&bytes),
        );
        let attachments = vec![
            AttachmentInput {
                file_name,
                file_type: "image/png".to_string(),
                file_size: bytes.len() as u64,
                data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            },
            AttachmentInput {
                file_name: "invalid.png".to_string(),
                file_type: "image/png".to_string(),
                file_size: 1,
                data: "%%%not-base64%%%".to_string(),
            },
        ];

        let result = persist_attachments(&state, &conversation.id, &attachments).await;

        assert!(result.is_err());
        assert!(
            aqbot_core::repo::stored_file::list_stored_files_by_conversation(
                &db,
                &conversation.id,
            )
            .await
            .unwrap()
            .is_empty()
        );
        assert!(!aqbot_core::file_store::FileStore::new()
            .resolve_path(&expected_path)
            .exists());
    }

    #[tokio::test]
    async fn attachment_metadata_is_rejected_before_any_file_or_row_is_created() {
        use base64::Engine;

        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Attachment preflight",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let state = test_app_state(db.clone());
        let bytes = format!("preflight-{}", aqbot_core::utils::gen_id()).into_bytes();
        let expected_path = aqbot_core::storage_paths::build_relative_path(
            "safe.png",
            "image/png",
            &aqbot_core::file_store::FileStore::hash_bytes(&bytes),
        );
        let attachments = vec![AttachmentInput {
            file_name: "data:image/png;base64,SECRET".to_string(),
            file_type: "image/png".to_string(),
            file_size: bytes.len() as u64,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        }];

        let error = persist_attachments(&state, &conversation.id, &attachments)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("Attachment 0 metadata"));
        assert!(!error.to_string().contains("SECRET"));
        assert!(aqbot_core::repo::stored_file::list_stored_files_by_conversation(
            &db,
            &conversation.id,
        )
        .await
        .unwrap()
        .is_empty());
        assert!(
            aqbot_core::repo::message::list_messages(&db, &conversation.id)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(!aqbot_core::file_store::FileStore::new()
            .resolve_path(&expected_path)
            .exists());
    }

    #[tokio::test]
    async fn new_message_ipc_failure_removes_the_unreturnable_row() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "IPC rollback",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let message = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::User,
            "plain data:image/png;base64,SECRET",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let error = finalize_new_message_for_ipc(&db, message.clone(), None)
            .await
            .unwrap_err();

        assert!(error.contains(&message.id));
        assert!(!error.contains("SECRET"));
        assert!(aqbot_core::repo::message::get_message(&db, &message.id)
            .await
            .is_err());
    }
}
