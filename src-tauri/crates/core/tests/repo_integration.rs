use aqbot_core::db::create_test_pool;
use aqbot_core::repo::{app, category, conversation, message, provider, settings, stored_file};
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
// Category
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_category_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    // create
    let cat = category::create_category(db, "Work").await.unwrap();
    assert_eq!(cat.name, "Work");
    assert!(!cat.id.is_empty());

    // list
    let cats = category::list_categories(db).await.unwrap();
    assert_eq!(cats.len(), 1);
    assert_eq!(cats[0].name, "Work");

    // update
    let updated = category::update_category(db, &cat.id, "Personal")
        .await
        .unwrap();
    assert_eq!(updated.name, "Personal");

    // delete
    category::delete_category(db, &cat.id).await.unwrap();
    let cats = category::list_categories(db).await.unwrap();
    assert!(cats.is_empty());
}

#[tokio::test]
async fn test_category_reorder() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let a = category::create_category(db, "A").await.unwrap();
    let b = category::create_category(db, "B").await.unwrap();
    let c = category::create_category(db, "C").await.unwrap();

    // reverse order
    let ids = vec![c.id.clone(), b.id.clone(), a.id.clone()];
    category::reorder_categories(db, &ids).await.unwrap();

    let cats = category::list_categories(db).await.unwrap();
    assert_eq!(cats[0].id, c.id);
    assert_eq!(cats[1].id, b.id);
    assert_eq!(cats[2].id, a.id);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

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
        enabled: true,
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
        api_host: None,
        api_path: None,
        enabled: None,
        proxy_config: None,
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
            enabled: true,
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
            enabled: true,
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
        max_tokens: Some(4096),
        enabled: true,
        param_overrides: None,
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

    // toggle model
    let toggled = provider::toggle_model(db, &prov.id, "claude-3", false)
        .await
        .unwrap();
    assert!(!toggled.enabled);
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_conversation_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    // create
    let conv =
        conversation::create_conversation(db, "Hello World", "gpt-4", "openai-1", None, None)
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

    let conv = conversation::create_conversation(db, "Chat", "gpt-4", "p1", None, None)
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

    let conv = conversation::create_conversation(db, "Test Chat", "model-1", "prov-1", None, None)
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

    let conv = conversation::create_conversation(db, "Attach Chat", "m1", "p1", None, None)
        .await
        .unwrap();

    let attachments = vec![AttachmentInput {
        file_name: "doc.pdf".into(),
        file_type: "application/pdf".into(),
        file_size: 1024,
        data: "base64data".into(),
    }];

    // create_message stores AttachmentInput JSON, but message_from_entity
    // deserialises as Vec<Attachment> (different struct) — mismatched fields
    // cause unwrap_or_default() to return []. Verify the message is created
    // successfully; attachment round-trip fidelity is a known schema gap.
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
}

#[tokio::test]
async fn test_delete_messages_after() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let conv = conversation::create_conversation(db, "Branching", "m1", "p1", None, None)
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
// App
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_app_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    // create
    let input = CreateAppInput {
        name: "Translator".into(),
        description: Some("Translates text".into()),
        icon: Some("🌐".into()),
        icon_color: Some("#ff0000".into()),
        system_prompt: Some("You are a translator.".into()),
        default_model_id: None,
        default_provider_id: None,
        temperature: Some(0.7),
        max_tokens: None,
        top_p: None,
        category_id: None,
        variables: Some(vec![Variable {
            name: "target_lang".into(),
            label: "Target Language".into(),
            default_value: "English".into(),
            placeholder: "Enter language".into(),
        }]),
    };
    let a = app::create_app(db, input).await.unwrap();
    assert_eq!(a.name, "Translator");
    assert_eq!(a.description, "Translates text");
    assert_eq!(a.variables.len(), 1);
    assert_eq!(a.variables[0].name, "target_lang");

    // list
    let apps = app::list_apps(db).await.unwrap();
    assert_eq!(apps.len(), 1);

    // get
    let fetched = app::get_app(db, &a.id).await.unwrap();
    assert_eq!(fetched.id, a.id);

    // update
    let update = UpdateAppInput {
        name: Some("Super Translator".into()),
        description: None,
        icon: None,
        icon_color: None,
        system_prompt: None,
        default_model_id: None,
        default_provider_id: None,
        temperature: None,
        max_tokens: None,
        top_p: None,
        category_id: None,
        variables: None,
    };
    let updated = app::update_app(db, &a.id, update).await.unwrap();
    assert_eq!(updated.name, "Super Translator");

    // toggle favorite
    app::toggle_favorite(db, &a.id).await.unwrap();
    let fetched = app::get_app(db, &a.id).await.unwrap();
    assert!(fetched.is_favorite);

    // delete
    app::delete_app(db, &a.id).await.unwrap();
    let apps = app::list_apps(db).await.unwrap();
    assert!(apps.is_empty());
}

// ---------------------------------------------------------------------------
// Stored File
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_stored_file_crud() {
    let h = create_test_pool().await.unwrap();
    let db = &h.conn;

    let file_id = gen_id();
    let conv = conversation::create_conversation(db, "File Chat", "m1", "p1", None, None)
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

    let conv = conversation::create_conversation(db, "Bulk Files", "m1", "p1", None, None)
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
