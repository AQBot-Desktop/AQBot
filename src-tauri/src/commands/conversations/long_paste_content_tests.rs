mod long_paste_content_tests {
    use super::*;
    use aqbot_core::types::ContextStrategy;

    const TAIL: &str = "🙂TAIL-END";
    const TARGET_BYTES: usize = 61_440;

    fn mixed_utf8_payload(target_bytes: usize, tail: &str) -> String {
        assert!(tail.len() < target_bytes);
        let fillers = ["a", "中", "🙂"];
        let mut prefix = String::new();
        let mut index = 0usize;
        loop {
            let next = fillers[index % fillers.len()];
            if prefix.len() + next.len() + tail.len() > target_bytes {
                break;
            }
            prefix.push_str(next);
            index += 1;
        }
        while prefix.len() + tail.len() < target_bytes {
            prefix.push('x');
        }
        format!("{prefix}{tail}")
    }

    fn assert_same_payload(label: &str, actual: &str, original: &str) {
        assert_eq!(
            actual.len(),
            original.len(),
            "{label} byte length changed"
        );
        assert!(
            actual.ends_with(TAIL),
            "{label} lost tail sentinel"
        );
        assert_eq!(actual, original, "{label} content changed");
    }

    #[tokio::test]
    async fn mixed_utf8_user_message_keeps_tail_through_sqlite_context_and_openai_json() {
        let original = mixed_utf8_payload(TARGET_BYTES, TAIL);
        assert_eq!(original.len(), TARGET_BYTES);
        assert!(original.ends_with(TAIL));

        let pool = aqbot_core::db::create_test_pool().await.unwrap();
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &pool.conn,
            "long-paste",
            "model-1",
            "provider-1",
            None,
        )
        .await
        .unwrap();
        let created = aqbot_core::repo::message::create_message(
            &pool.conn,
            &conversation.id,
            MessageRole::User,
            &original,
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        assert_same_payload("create_message", &created.content, &original);

        let stored = aqbot_core::repo::message::get_message(&pool.conn, &created.id)
            .await
            .unwrap();
        assert_same_payload("sqlite_get", &stored.content, &original);

        let page = aqbot_core::repo::message::list_messages_page(
            &pool.conn,
            &conversation.id,
            10,
            None,
        )
        .await
        .unwrap();
        assert_eq!(page.messages.len(), 1);
        assert_same_payload("display_dto", &page.messages[0].content, &original);
        let display_ipc = serde_json::to_string(&page).unwrap();
        assert!(
            display_ipc.contains(TAIL),
            "display IPC JSON lost tail sentinel"
        );
        assert!(
            display_ipc.contains(&original),
            "display IPC JSON rewrote the user content"
        );

        let file_store = aqbot_core::file_store::FileStore::new();
        let chat_message =
            chat_message_from_message(&file_store, &stored, false, None, false).unwrap();
        let chat_text = chat_content_text(&chat_message.content);
        assert_same_payload("chat_message", &chat_text, &original);

        let context = crate::context_manager::build_context_for_strategy(
            &[],
            &[chat_message.clone()],
            None,
            ContextStrategy::RawTruncate,
            None,
        )
        .unwrap();
        assert!(!context.overflow);
        let context_text = context
            .messages
            .iter()
            .find(|message| message.role == "user")
            .map(|message| chat_content_text(&message.content))
            .expect("context should keep the user message");
        assert_same_payload("context_manager", &context_text, &original);

        let request = ChatRequest {
            model: "gpt-4o".into(),
            messages: context.messages.clone(),
            stream: false,
            temperature: None,
            top_p: None,
            max_tokens: None,
            tools: None,
            thinking_budget: None,
            thinking_level: None,
            reasoning_profile: None,
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        };
        let request_json = serde_json::to_string(&request).unwrap();
        assert!(
            request_json.contains(TAIL),
            "ChatRequest JSON lost tail sentinel"
        );
        assert!(
            request_json.contains(&original),
            "ChatRequest JSON rewrote the user content"
        );

        let openai_json = serde_json::json!({
            "model": request.model,
            "messages": request.messages.iter().map(|message| {
                serde_json::json!({
                    "role": message.role,
                    "content": chat_content_text(&message.content),
                })
            }).collect::<Vec<_>>(),
        });
        let openai_text = openai_json.to_string();
        assert!(
            openai_text.contains(TAIL),
            "OpenAI JSON lost tail sentinel"
        );
        assert!(
            openai_text.contains(&original),
            "OpenAI JSON rewrote the user content"
        );
        let openai_content = openai_json["messages"][0]["content"]
            .as_str()
            .expect("OpenAI user content should be a JSON string");
        assert_same_payload("openai_request", openai_content, &original);
    }
}
