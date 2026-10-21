use aqbot_core::db::create_test_pool;
use aqbot_core::repo::{
    conversation, conversation_category, message, provider, settings, stored_file,
};
use aqbot_core::types::*;
use aqbot_core::utils::gen_id;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_settings_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    // set + get
    settings::set_setting(db, "theme", "dark").await.unwrap();
    let val = settings::get_setting(db, "theme").await.unwrap();
    assert_eq!(val, Some("dark".to_string()));

    // overwrite
    settings::set_setting(db, "theme", "light").await.unwrap();
    let val = settings::get_setting(db, "theme").await.unwrap();
    assert_eq!(val, Some("light".to_string()));

    // missing key
    let missing = settings::get_setting(db, "nonexistent").await.unwrap();
    assert_eq!(missing, None);
}

#[tokio::test]
async fn test_app_settings_roundtrip() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let mut s = AppSettings::default();
    s.theme_mode = "dark".into();
    s.font_size = 16;

    settings::save_settings(db, &s).await.unwrap();
    let loaded = settings::get_settings(db).await.unwrap();
    assert_eq!(loaded.theme_mode, "dark");
    assert_eq!(loaded.font_size, 16);
}

// ---------------------------------------------------------------------------
// Conversation Category
// ---------------------------------------------------------------------------

fn category_input(name: &str) -> CreateConversationCategoryInput {
    CreateConversationCategoryInput {
        name: name.into(),
        icon_type: None,
        icon_value: None,
        system_prompt: None,
        default_provider_id: None,
        default_model_id: None,
        default_temperature: None,
        default_max_tokens: None,
        default_top_p: None,
        default_frequency_penalty: None,
    }
}

#[tokio::test]
async fn test_conversation_category_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    // create
    let cat = conversation_category::create_conversation_category(db, category_input("Work"))
        .await
        .unwrap();
    assert_eq!(cat.name, "Work");
    assert!(!cat.id.is_empty());

    // list
    let cats = conversation_category::list_conversation_categories(db)
        .await
        .unwrap();
    assert_eq!(cats.len(), 1);
    assert_eq!(cats[0].name, "Work");

    // update
    let update = UpdateConversationCategoryInput {
        name: Some("Personal".into()),
        icon_type: None,
        icon_value: None,
        system_prompt: None,
        default_provider_id: None,
        default_model_id: None,
        default_temperature: None,
        default_max_tokens: None,
        default_top_p: None,
        default_frequency_penalty: None,
    };
    let updated = conversation_category::update_conversation_category(db, &cat.id, update)
        .await
        .unwrap();
    assert_eq!(updated.name, "Personal");

    // delete
    conversation_category::delete_conversation_category(db, &cat.id)
        .await
        .unwrap();
    let cats = conversation_category::list_conversation_categories(db)
        .await
        .unwrap();
    assert!(cats.is_empty());
}

#[tokio::test]
async fn test_conversation_category_reorder() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let mut created = Vec::new();
    for name in ["A", "B", "C"] {
        created.push(
            conversation_category::create_conversation_category(db, category_input(name))
                .await
                .unwrap(),
        );
    }

    // reverse order
    let ids: Vec<String> = created.iter().rev().map(|c| c.id.clone()).collect();
    conversation_category::reorder_conversation_categories(db, &ids)
        .await
        .unwrap();

    let cats = conversation_category::list_conversation_categories(db)
        .await
        .unwrap();
    let listed: Vec<String> = cats.into_iter().map(|c| c.id).collect();
    assert_eq!(listed, ids);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_provider_gateway_prefix_validation() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;
    let create = |name: &str| CreateProviderInput {
        name: name.into(),
        provider_type: ProviderType::OpenAI,
        api_host: "https://api.openai.com".into(),
        api_path: None,
        aws_region: None,
        enabled: true,
        builtin_id: None,
    };
    let set_prefix = |prefix: Option<&str>| UpdateProviderInput {
        gateway_prefix: Some(prefix.map(str::to_string)),
        ..Default::default()
    };
    let a = provider::create_provider(db, create("A")).await.unwrap();
    let b = provider::create_provider(db, create("B")).await.unwrap();
    assert_eq!(a.gateway_prefix, None);

    // Normalised to lowercase and trimmed.
    let a = provider::update_provider(db, &a.id, set_prefix(Some("  My-DS ")))
        .await
        .unwrap();
    assert_eq!(a.gateway_prefix.as_deref(), Some("my-ds"));
    // Re-saving the same prefix on the same provider is allowed.
    provider::update_provider(db, &a.id, set_prefix(Some("my-ds")))
        .await
        .unwrap();

    // Duplicate on another provider is rejected.
    assert!(
        provider::update_provider(db, &b.id, set_prefix(Some("MY-DS")))
            .await
            .is_err()
    );
    // Invalid formats are rejected.
    for bad in ["a/b", "-ds", "ds--x", "深度", &"x".repeat(33)] {
        assert!(
            provider::update_provider(db, &b.id, set_prefix(Some(bad)))
                .await
                .is_err(),
            "{bad} should be rejected"
        );
    }

    // Blank clears the prefix; omitting the field keeps it.
    let a = provider::update_provider(db, &a.id, UpdateProviderInput::default())
        .await
        .unwrap();
    assert_eq!(a.gateway_prefix.as_deref(), Some("my-ds"));
    let a = provider::update_provider(db, &a.id, set_prefix(Some("  ")))
        .await
        .unwrap();
    assert_eq!(a.gateway_prefix, None);
}

#[tokio::test]
async fn test_provider_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    // count built-in seed providers
    let seed_count = provider::list_providers(db).await.unwrap().len();

    // create
    let input = CreateProviderInput {
        name: "OpenAI".into(),
        provider_type: ProviderType::OpenAI,
        api_host: "https://api.openai.com".into(),
        api_path: None,
        aws_region: None,
        enabled: true,
        builtin_id: None,
    };
    let prov = provider::create_provider(db, input).await.unwrap();
    assert_eq!(prov.name, "OpenAI");
    assert_eq!(prov.provider_type, ProviderType::OpenAI);
    assert!(prov.enabled);

    // list
    let provs = provider::list_providers(db).await.unwrap();
    assert_eq!(provs.len(), seed_count + 1);

    // update
    let update = UpdateProviderInput {
        name: Some("OpenAI v2".into()),
        provider_type: None,
        api_host: None,
        api_path: None,
        aws_region: None,
        enabled: None,
        proxy_config: None,
        custom_headers: None,
        icon: None,
        gateway_prefix: None,
        sort_order: None,
    };
    let updated = provider::update_provider(db, &prov.id, update)
        .await
        .unwrap();
    assert_eq!(updated.name, "OpenAI v2");

    // toggle
    provider::toggle_provider(db, &prov.id, false)
        .await
        .unwrap();
    let fetched = provider::get_provider(db, &prov.id).await.unwrap();
    assert!(!fetched.enabled);

    // delete
    provider::delete_provider(db, &prov.id).await.unwrap();
    let provs = provider::list_providers(db).await.unwrap();
    assert_eq!(provs.len(), seed_count);
}

#[tokio::test]
async fn test_provider_key_operations() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let prov = provider::create_provider(
        db,
        CreateProviderInput {
            name: "Test".into(),
            provider_type: ProviderType::Custom,
            api_host: "https://example.com".into(),
            api_path: None,
            aws_region: None,
            enabled: true,
            builtin_id: None,
        },
    )
    .await
    .unwrap();

    // add key
    let key = provider::add_provider_key(db, &prov.id, "enc_key_data", "sk-abc")
        .await
        .unwrap();
    assert_eq!(key.provider_id, prov.id);
    assert_eq!(key.key_prefix, "sk-abc");
    assert!(key.enabled);

    // list keys
    let keys = provider::list_keys_for_provider(db, &prov.id)
        .await
        .unwrap();
    assert_eq!(keys.len(), 1);

    // get key
    let fetched = provider::get_provider_key(db, &key.id).await.unwrap();
    assert_eq!(fetched.id, key.id);

    // toggle key
    provider::toggle_provider_key(db, &key.id, false)
        .await
        .unwrap();
    let fetched = provider::get_provider_key(db, &key.id).await.unwrap();
    assert!(!fetched.enabled);

    // delete key
    provider::delete_provider_key(db, &key.id).await.unwrap();
    let keys = provider::list_keys_for_provider(db, &prov.id)
        .await
        .unwrap();
    assert!(keys.is_empty());
}

#[tokio::test]
async fn test_provider_model_operations() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let prov = provider::create_provider(
        db,
        CreateProviderInput {
            name: "Anthropic".into(),
            provider_type: ProviderType::Anthropic,
            api_host: "https://api.anthropic.com".into(),
            api_path: None,
            aws_region: None,
            enabled: true,
            builtin_id: None,
        },
    )
    .await
    .unwrap();

    let models = vec![Model {
        provider_id: prov.id.clone(),
        model_id: "claude-3".into(),
        name: "Claude 3".into(),
        group_name: Some("claude-3".into()),
        model_type: ModelType::Chat,
        capabilities: vec![ModelCapability::TextChat],
        context_window: Some(4096),
        max_output_tokens: None,
        enabled: true,
        param_overrides: None,
        image_config: None,
        metadata_state: None,
        aliases: Vec::new(),
        icon: Some("emoji:★".into()),
    }];

    // save models
    provider::save_models(db, &prov.id, &models).await.unwrap();

    // list models
    let listed = provider::list_models_for_provider(db, &prov.id)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].model_id, "claude-3");
    assert_eq!(listed[0].group_name.as_deref(), Some("claude-3"));

    // get model
    let m = provider::get_model(db, &prov.id, "claude-3").await.unwrap();
    assert_eq!(m.name, "Claude 3");
    assert_eq!(m.group_name.as_deref(), Some("claude-3"));
    assert_eq!(m.icon.as_deref(), Some("emoji:★"));

    // toggle model
    let toggled = provider::toggle_model(db, &prov.id, "claude-3", false)
        .await
        .unwrap();
    assert!(!toggled.enabled);
    assert_eq!(toggled.icon.as_deref(), Some("emoji:★"));
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_conversation_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    // create
    let conv = conversation::create_conversation(db, "Hello World", "gpt-4", "openai-1", None)
        .await
        .unwrap();
    assert_eq!(conv.title, "Hello World");
    assert_eq!(conv.model_id, "gpt-4");
    assert_eq!(conv.provider_id, "openai-1");

    // list
    let convs = conversation::list_conversations(db).await.unwrap();
    assert_eq!(convs.len(), 1);

    // get
    let fetched = conversation::get_conversation(db, &conv.id).await.unwrap();
    assert_eq!(fetched.id, conv.id);

    // update title
    conversation::update_conversation_title(db, &conv.id, "Updated Title")
        .await
        .unwrap();
    let fetched = conversation::get_conversation(db, &conv.id).await.unwrap();
    assert_eq!(fetched.title, "Updated Title");

    // pin toggle
    let pinned = conversation::toggle_pin(db, &conv.id).await.unwrap();
    assert!(pinned.is_pinned);
    let unpinned = conversation::toggle_pin(db, &conv.id).await.unwrap();
    assert!(!unpinned.is_pinned);

    // message count
    conversation::increment_message_count(db, &conv.id)
        .await
        .unwrap();
    conversation::increment_message_count(db, &conv.id)
        .await
        .unwrap();
    let fetched = conversation::get_conversation(db, &conv.id).await.unwrap();
    assert_eq!(fetched.message_count, 2);

    conversation::decrement_message_count(db, &conv.id)
        .await
        .unwrap();
    let fetched = conversation::get_conversation(db, &conv.id).await.unwrap();
    assert_eq!(fetched.message_count, 1);

    // delete
    conversation::delete_conversation(db, &conv.id)
        .await
        .unwrap();
    let convs = conversation::list_conversations(db).await.unwrap();
    assert!(convs.is_empty());
}

#[tokio::test]
async fn test_conversation_update_input() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let conv = conversation::create_conversation(db, "Chat", "gpt-4", "p1", None)
        .await
        .unwrap();

    let input = UpdateConversationInput {
        title: Some("New Chat".into()),
        provider_id: Some("p2".into()),
        model_id: Some("gpt-4o".into()),
        is_pinned: Some(true),
        is_archived: None,
        system_prompt: None,
        temperature: None,
        max_tokens: None,
        top_p: None,
        frequency_penalty: None,
        search_enabled: Some(true),
        search_provider_id: Some(Some("search-1".into())),
        thinking_budget: Some(Some(4096)),
        thinking_level: Some(Some("high".into())),
        enabled_mcp_server_ids: Some(vec!["mcp-a".into(), "mcp-b".into()]),
        enabled_knowledge_base_ids: Some(vec!["kb-a".into()]),
        enabled_memory_namespace_ids: Some(vec!["mem-a".into()]),
        context_compression: None,
        context_message_limit: Some(Some(3)),
        compression_keep_last_n: None,
        context_strategy_override: None,
        multi_model_display_mode_override: None,
        multi_model_targets: None,
        multi_model_continuation_mode: None,
        category_id: None,
        parent_conversation_id: None,
        mode: None,
    };
    let updated = conversation::update_conversation(db, &conv.id, input)
        .await
        .unwrap();
    assert_eq!(updated.title, "New Chat");
    assert_eq!(updated.provider_id, "p2");
    assert_eq!(updated.model_id, "gpt-4o");
    assert!(updated.is_pinned);
    assert!(updated.search_enabled);
    assert_eq!(updated.search_provider_id.as_deref(), Some("search-1"));
    assert_eq!(updated.thinking_budget, Some(4096));
    assert_eq!(updated.thinking_level.as_deref(), Some("high"));
    assert_eq!(
        updated.enabled_mcp_server_ids,
        vec!["mcp-a".to_string(), "mcp-b".to_string()]
    );
    assert_eq!(updated.enabled_knowledge_base_ids, vec!["kb-a".to_string()]);
    assert_eq!(
        updated.enabled_memory_namespace_ids,
        vec!["mem-a".to_string()]
    );
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_message_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let conv = conversation::create_conversation(db, "Test Chat", "model-1", "prov-1", None)
        .await
        .unwrap();

    // create message (no attachments)
    let msg = message::create_message(db, &conv.id, MessageRole::User, "Hello!", &[], None, 0)
        .await
        .unwrap();
    assert_eq!(msg.conversation_id, conv.id);
    assert_eq!(msg.role, MessageRole::User);
    assert_eq!(msg.content, "Hello!");

    // create assistant reply
    let reply = message::create_message(
        db,
        &conv.id,
        MessageRole::Assistant,
        "Hi there!",
        &[],
        None,
        0,
    )
    .await
    .unwrap();
    assert_eq!(reply.role, MessageRole::Assistant);

    // list messages
    let msgs = message::list_messages(db, &conv.id).await.unwrap();
    assert_eq!(msgs.len(), 2);

    // update content
    let updated = message::update_message_content(db, &msg.id, "Hello, World!")
        .await
        .unwrap();
    assert_eq!(updated.content, "Hello, World!");

    // delete single message
    message::delete_message(db, &reply.id).await.unwrap();
    let msgs = message::list_messages(db, &conv.id).await.unwrap();
    assert_eq!(msgs.len(), 1);
}

#[tokio::test]
async fn test_message_with_attachments() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let conv = conversation::create_conversation(db, "Attach Chat", "m1", "p1", None)
        .await
        .unwrap();

    let attachments = vec![Attachment {
        id: "att-1".into(),
        file_type: "application/pdf".into(),
        file_name: "doc.pdf".into(),
        file_path: "files/abc123_doc.pdf".into(),
        file_size: 1024,
        data: None,
    }];

    let msg = message::create_message(
        db,
        &conv.id,
        MessageRole::User,
        "See attached",
        &attachments,
        None,
        0,
    )
    .await
    .unwrap();

    assert_eq!(msg.content, "See attached");
    assert_eq!(msg.role, MessageRole::User);
    assert_eq!(msg.attachments.len(), 1);
    assert_eq!(msg.attachments[0].file_name, "doc.pdf");
    assert_eq!(msg.attachments[0].file_path, "files/abc123_doc.pdf");
}

#[tokio::test]
async fn test_delete_messages_after() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let conv = conversation::create_conversation(db, "Branching", "m1", "p1", None)
        .await
        .unwrap();

    let _m1 = message::create_message(db, &conv.id, MessageRole::User, "first", &[], None, 0)
        .await
        .unwrap();

    // Use a future timestamp so only messages created at or after it are deleted.
    // Since both messages may share the same second-resolution timestamp, we
    // create m2, record its timestamp, then delete from that point onward.
    let m2 = message::create_message(db, &conv.id, MessageRole::Assistant, "second", &[], None, 0)
        .await
        .unwrap();

    // If both messages share the same timestamp, deleting from m2.created_at
    // will remove both. Query first to figure out what we expect.
    let before = message::list_messages(db, &conv.id).await.unwrap();
    let expected_remaining = before
        .iter()
        .filter(|m| m.created_at < m2.created_at)
        .count();

    let deleted = message::delete_messages_after(db, &conv.id, m2.created_at)
        .await
        .unwrap();
    assert!(deleted >= 1);

    let remaining = message::list_messages(db, &conv.id).await.unwrap();
    assert_eq!(remaining.len(), expected_remaining);
}

// ---------------------------------------------------------------------------
// Stored File
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_stored_file_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let file_id = gen_id();
    let conv = conversation::create_conversation(db, "File Chat", "m1", "p1", None)
        .await
        .unwrap();

    // create
    let sf = stored_file::create_stored_file(
        db,
        &file_id,
        "abc123hash",
        "photo.jpg",
        "image/jpeg",
        2048,
        "/storage/photo.jpg",
        Some(&conv.id),
    )
    .await
    .unwrap();
    assert_eq!(sf.id, file_id);
    assert_eq!(sf.original_name, "photo.jpg");
    assert_eq!(sf.size_bytes, 2048);
    assert_eq!(sf.conversation_id.as_deref(), Some(conv.id.as_str()));

    // get
    let fetched = stored_file::get_stored_file(db, &file_id).await.unwrap();
    assert_eq!(fetched.hash, "abc123hash");

    // list by conversation
    let files = stored_file::list_stored_files_by_conversation(db, &conv.id)
        .await
        .unwrap();
    assert_eq!(files.len(), 1);

    // find by hash
    let found = stored_file::find_by_hash(db, "abc123hash").await.unwrap();
    assert!(found.is_some());

    let not_found = stored_file::find_by_hash(db, "nonexistent").await.unwrap();
    assert!(not_found.is_none());

    // delete
    stored_file::delete_stored_file(db, &file_id).await.unwrap();
    let files = stored_file::list_stored_files_by_conversation(db, &conv.id)
        .await
        .unwrap();
    assert!(files.is_empty());
}

#[tokio::test]
async fn test_stored_file_no_conversation() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let file_id = gen_id();
    let sf = stored_file::create_stored_file(
        db,
        &file_id,
        "hash999",
        "standalone.txt",
        "text/plain",
        512,
        "/storage/standalone.txt",
        None,
    )
    .await
    .unwrap();
    assert!(sf.conversation_id.is_none());

    stored_file::delete_stored_file(db, &file_id).await.unwrap();
}

#[tokio::test]
async fn test_delete_stored_files_by_conversation() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let conv = conversation::create_conversation(db, "Bulk Files", "m1", "p1", None)
        .await
        .unwrap();

    for i in 0..3 {
        let id = gen_id();
        stored_file::create_stored_file(
            db,
            &id,
            &format!("hash{i}"),
            &format!("file{i}.txt"),
            "text/plain",
            100,
            &format!("/storage/file{i}.txt"),
            Some(&conv.id),
        )
        .await
        .unwrap();
    }

    let files = stored_file::list_stored_files_by_conversation(db, &conv.id)
        .await
        .unwrap();
    assert_eq!(files.len(), 3);

    stored_file::delete_stored_files_by_conversation(db, &conv.id)
        .await
        .unwrap();
    let files = stored_file::list_stored_files_by_conversation(db, &conv.id)
        .await
        .unwrap();
    assert!(files.is_empty());
}
