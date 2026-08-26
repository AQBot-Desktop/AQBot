use super::{
    is_valid_selection_toolbar_icon, is_valid_selection_toolbar_search_url,
    render_selection_toolbar_search_url, AppSettings, ContextStrategy,
    ModelCatalogSourcePreference, MultiModelExecutionMode, SelectionToolbarAiConfig,
    SelectionToolbarAppEntry, SelectionToolbarAppFilterMode, SelectionToolbarBuiltinAiKey,
    SelectionToolbarDisplayMode, SelectionToolbarSettings, SelectionToolbarTool,
    SelectionToolbarTriggerMode, SettingsSidebarDensity, DEFAULT_EXPLAIN_PROMPT,
    DEFAULT_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS, DEFAULT_SELECTION_TOOLBAR_SEARCH_URL,
    DEFAULT_SELECTION_TOOLBAR_SHORTCUT, DEFAULT_TRANSLATE_PROMPT,
};
use serde_json::json;

#[test]
fn context_strategy_uses_snake_case_and_defaults_to_raw_truncate() {
    assert_eq!(ContextStrategy::default(), ContextStrategy::RawTruncate);
    assert_eq!(
        serde_json::to_value(ContextStrategy::SmartSummary).unwrap(),
        json!("smart_summary")
    );
    assert_eq!(
        serde_json::from_value::<ContextStrategy>(json!("raw_strict")).unwrap(),
        ContextStrategy::RawStrict
    );
    assert_eq!(
        serde_json::from_value::<AppSettings>(json!({}))
            .unwrap()
            .default_context_strategy,
        ContextStrategy::RawTruncate
    );
}

#[test]
fn release_webview_on_tray_defaults_to_disabled() {
    let settings = AppSettings::default();
    assert!(!settings.release_webview_on_tray);
}

#[test]
fn proxy_defaults_to_system_while_explicit_none_remains_disabled() {
    let settings = AppSettings::default();
    assert_eq!(settings.proxy_type.as_deref(), Some("system"));

    let missing: AppSettings =
        serde_json::from_value(json!({})).expect("missing proxy setting should deserialize");
    assert_eq!(missing.proxy_type.as_deref(), Some("system"));

    let disabled: AppSettings = serde_json::from_value(json!({ "proxy_type": null }))
        .expect("explicitly disabled proxy should deserialize");
    assert_eq!(disabled.proxy_type, None);
}

#[test]
fn settings_sidebar_density_defaults_and_remains_backward_compatible() {
    let settings = AppSettings::default();
    assert_eq!(
        settings.settings_sidebar_density,
        SettingsSidebarDensity::Standard
    );

    let legacy: AppSettings =
        serde_json::from_value(json!({})).expect("legacy settings should deserialize");
    assert_eq!(
        legacy.settings_sidebar_density,
        SettingsSidebarDensity::Standard
    );
}

#[test]
fn settings_sidebar_density_roundtrips_all_variants() {
    for (density, serialized_name) in [
        (SettingsSidebarDensity::Compact, "compact"),
        (SettingsSidebarDensity::Standard, "standard"),
        (SettingsSidebarDensity::Spacious, "spacious"),
    ] {
        let mut settings = AppSettings::default();
        settings.settings_sidebar_density = density;

        let serialized = serde_json::to_value(settings).expect("settings should serialize");
        assert_eq!(
            serialized["settings_sidebar_density"],
            json!(serialized_name)
        );

        let roundtrip: AppSettings =
            serde_json::from_value(serialized).expect("settings should deserialize");
        assert_eq!(roundtrip.settings_sidebar_density, density);
    }
}

#[test]
fn settings_sidebar_density_rejects_unknown_values() {
    let result = serde_json::from_value::<AppSettings>(json!({
        "settings_sidebar_density": "extra_spacious"
    }));

    assert!(result.is_err(), "unknown density must fail deserialization");
}

#[test]
fn selection_toolbar_defaults_are_backward_compatible_and_valid() {
    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("legacy settings should deserialize");

    assert!(!settings.selection_toolbar.enabled);
    assert!(!settings.selection_toolbar.theme_follow);
    assert_eq!(
        settings.selection_toolbar.display_mode,
        SelectionToolbarDisplayMode::Full
    );
    assert_eq!(
        settings.selection_toolbar.trigger_mode,
        SelectionToolbarTriggerMode::Selection
    );
    assert_eq!(
        settings.selection_toolbar.trigger_shortcut,
        DEFAULT_SELECTION_TOOLBAR_SHORTCUT
    );
    assert_eq!(
        settings.selection_toolbar.app_filter_mode,
        SelectionToolbarAppFilterMode::Off
    );
    assert!(settings.selection_toolbar.app_filter.is_empty());
    assert_eq!(settings.selection_toolbar.tools.len(), 6);
    assert_eq!(settings.selection_toolbar.tools[1].id(), "explain");
    assert_eq!(settings.selection_toolbar.tools[5].id(), "search");
    assert_eq!(
        settings.selection_toolbar.search_url,
        DEFAULT_SELECTION_TOOLBAR_SEARCH_URL
    );
    settings
        .selection_toolbar
        .validate()
        .expect("default selection toolbar settings should be valid");
}

#[test]
fn selection_toolbar_app_filter_allows_matches_mode_semantics() {
    let chrome = SelectionToolbarAppEntry {
        id: "com.google.Chrome".into(),
        name: "Google Chrome".into(),
    };
    let notepad = SelectionToolbarAppEntry {
        id: "notepad.exe".into(),
        name: "Notepad".into(),
    };

    let mut off = SelectionToolbarSettings::default();
    off.app_filter = vec![chrome.clone()];
    assert!(off.allows_source_app("com.google.Chrome"));
    assert!(off.allows_source_app("com.apple.TextEdit"));

    let mut allow = SelectionToolbarSettings::default();
    allow.app_filter_mode = SelectionToolbarAppFilterMode::Allowlist;
    allow.app_filter = vec![chrome.clone(), notepad.clone()];
    assert!(allow.allows_source_app("com.google.Chrome"));
    assert!(allow.allows_source_app("NOTEPAD.EXE"));
    assert!(!allow.allows_source_app("com.apple.TextEdit"));
    assert!(!allow.allows_source_app(""));

    let mut empty_allow = SelectionToolbarSettings::default();
    empty_allow.app_filter_mode = SelectionToolbarAppFilterMode::Allowlist;
    assert!(!empty_allow.allows_source_app("com.google.Chrome"));

    let mut block = SelectionToolbarSettings::default();
    block.app_filter_mode = SelectionToolbarAppFilterMode::Blocklist;
    block.app_filter = vec![chrome];
    assert!(!block.allows_source_app("com.google.Chrome"));
    assert!(block.allows_source_app("com.apple.TextEdit"));
    // Secondary match by display name (Linux AT-SPI fallback).
    let mut block_by_name = SelectionToolbarSettings::default();
    block_by_name.app_filter_mode = SelectionToolbarAppFilterMode::Blocklist;
    block_by_name.app_filter = vec![notepad];
    assert!(!block_by_name.allows_source_app("Notepad"));
    assert!(block_by_name.allows_source_app("Other App"));
}

#[test]
fn selection_toolbar_rejects_invalid_app_filter_entries() {
    let duplicate = SelectionToolbarSettings {
        app_filter: vec![
            SelectionToolbarAppEntry {
                id: "app.a".into(),
                name: "A".into(),
            },
            SelectionToolbarAppEntry {
                id: "app.a".into(),
                name: "A again".into(),
            },
        ],
        ..SelectionToolbarSettings::default()
    };
    assert!(duplicate.validate().is_err());

    let empty_id = SelectionToolbarSettings {
        app_filter: vec![SelectionToolbarAppEntry {
            id: "  ".into(),
            name: "A".into(),
        }],
        ..SelectionToolbarSettings::default()
    };
    assert!(empty_id.validate().is_err());
}

#[test]
fn selection_toolbar_rejects_invalid_ai_configuration() {
    let invalid_provider_pair = SelectionToolbarSettings {
        tools: vec![SelectionToolbarTool::BuiltinAi {
            builtin_key: SelectionToolbarBuiltinAiKey::Translate,
            enabled: true,
            ai: SelectionToolbarAiConfig {
                prompt: "Translate {selection}".into(),
                provider_id: Some("provider".into()),
                model_id: None,
                temperature: None,
                top_p: None,
                max_tokens: None,
            },
        }],
        ..SelectionToolbarSettings::default()
    };
    assert!(invalid_provider_pair.validate().is_err());

    let missing_placeholder: SelectionToolbarSettings = serde_json::from_value(json!({
        "enabled": true,
        "theme_follow": true,
        "tools": [
            {
                "kind": "builtin_ai",
                "builtin_key": "translate",
                "enabled": true,
                "ai": {
                    "prompt": "Translate this text",
                    "provider_id": null,
                    "model_id": null,
                    "temperature": 0.7,
                    "top_p": 1.0,
                    "max_tokens": 1024
                }
            },
            {
                "kind": "builtin_ai",
                "builtin_key": "polish",
                "enabled": true,
                "ai": {
                    "prompt": "Polish {selection}",
                    "provider_id": null,
                    "model_id": null
                }
            },
            {
                "kind": "builtin_ai",
                "builtin_key": "summarize",
                "enabled": true,
                "ai": {
                    "prompt": "Summarize {selection}",
                    "provider_id": null,
                    "model_id": null
                }
            },
            {
                "kind": "builtin_action",
                "builtin_key": "copy",
                "enabled": true
            }
        ]
    }))
    .expect("settings shape should deserialize");
    assert!(missing_placeholder.validate().is_err());

    let mut invalid_custom_id = SelectionToolbarSettings::default();
    invalid_custom_id
        .tools
        .push(SelectionToolbarTool::CustomAi {
            id: "not-a-uuid".into(),
            name: "Explain".into(),
            icon: "sparkles".into(),
            enabled: true,
            ai: SelectionToolbarAiConfig {
                prompt: "Explain {selection}".into(),
                provider_id: None,
                model_id: None,
                temperature: None,
                top_p: None,
                max_tokens: None,
            },
        });
    assert!(invalid_custom_id.validate().is_err());

    let mut empty_model_id = SelectionToolbarSettings::default();
    let SelectionToolbarTool::BuiltinAi { ai, .. } = &mut empty_model_id.tools[0] else {
        panic!("first default tool must be builtin AI");
    };
    ai.provider_id = Some("provider".into());
    ai.model_id = Some("  ".into());
    assert!(empty_model_id.validate().is_err());
}

#[test]
fn selection_toolbar_requires_each_builtin_tool_exactly_once() {
    let mut missing_copy = SelectionToolbarSettings::default();
    missing_copy.tools.retain(|tool| tool.id() != "copy");
    assert!(missing_copy.validate().is_err());

    let mut missing_search = SelectionToolbarSettings::default();
    missing_search.tools.retain(|tool| tool.id() != "search");
    assert!(missing_search.validate().is_err());

    let mut duplicate_translate = SelectionToolbarSettings::default();
    duplicate_translate
        .tools
        .push(duplicate_translate.tools[0].clone());
    assert!(duplicate_translate.validate().is_err());
}

#[test]
fn selection_toolbar_validates_and_renders_search_url() {
    assert!(is_valid_selection_toolbar_search_url(
        DEFAULT_SELECTION_TOOLBAR_SEARCH_URL
    ));
    assert!(!is_valid_selection_toolbar_search_url(
        "ftp://example.com/%s"
    ));
    assert!(!is_valid_selection_toolbar_search_url(
        "https://example.com/q="
    ));
    assert!(!is_valid_selection_toolbar_search_url(""));

    let rendered =
        render_selection_toolbar_search_url("https://www.baidu.com/s?wd=%s", "hello 世界")
            .expect("valid template should render");
    assert_eq!(
        rendered,
        format!(
            "https://www.baidu.com/s?wd={}",
            urlencoding::encode("hello 世界")
        )
    );

    let mut settings = SelectionToolbarSettings::default();
    settings.search_url = "not-a-url".into();
    assert!(settings.validate().is_err());
}

#[test]
fn selection_toolbar_accepts_any_kebab_case_lucide_icon() {
    for icon in ["wand-sparkles", "a-arrow-down", "axis-3d", "badge-1"] {
        assert!(is_valid_selection_toolbar_icon(icon), "{icon}");
    }
    for icon in [
        "",
        "-leading",
        "trailing-",
        "double--dash",
        "Upper-Case",
        "with space",
        "emoji-💡",
    ] {
        assert!(!is_valid_selection_toolbar_icon(icon), "{icon}");
    }

    let mut custom = SelectionToolbarSettings::default();
    custom.tools.push(SelectionToolbarTool::CustomAi {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Explain".into(),
        icon: "circle-fading-arrow-up".into(),
        enabled: true,
        ai: SelectionToolbarAiConfig {
            prompt: "Explain {selection}".into(),
            provider_id: None,
            model_id: None,
            temperature: None,
            top_p: None,
            max_tokens: None,
        },
    });
    custom
        .validate()
        .expect("icons outside the legacy fixed set should validate");
}

#[test]
fn selection_toolbar_validates_translate_target_language() {
    let mut settings = SelectionToolbarSettings::default();
    settings.translate_target_language = Some("zh-CN".into());
    settings.validate().expect("language codes should validate");

    settings.translate_target_language = Some("   ".into());
    assert!(settings.validate().is_err());
}

#[test]
fn selection_toolbar_display_mode_roundtrips_and_rejects_unknown_values() {
    let mut settings = SelectionToolbarSettings::default();
    settings.display_mode = SelectionToolbarDisplayMode::Compact;
    let serialized = serde_json::to_value(&settings).expect("display mode should serialize");
    let roundtrip: SelectionToolbarSettings =
        serde_json::from_value(serialized).expect("display mode should deserialize");
    assert_eq!(roundtrip.display_mode, SelectionToolbarDisplayMode::Compact);

    let invalid = serde_json::from_value::<SelectionToolbarSettings>(json!({
        "display_mode": "icons_and_labels"
    }));
    assert!(invalid.is_err(), "unknown display modes must be rejected");
}

#[test]
fn selection_toolbar_upgrades_only_the_untouched_legacy_translate_prompt() {
    let mut legacy = SelectionToolbarSettings::default();
    let SelectionToolbarTool::BuiltinAi { ai, .. } = &mut legacy.tools[0] else {
        panic!("first default tool must be translate");
    };
    ai.prompt = super::LEGACY_TRANSLATE_PROMPT.into();
    legacy.upgrade_legacy_defaults();
    let SelectionToolbarTool::BuiltinAi { ai, .. } = &legacy.tools[0] else {
        panic!("first default tool must be translate");
    };
    assert_eq!(ai.prompt, DEFAULT_TRANSLATE_PROMPT);

    let mut customized = SelectionToolbarSettings::default();
    let SelectionToolbarTool::BuiltinAi { ai, .. } = &mut customized.tools[0] else {
        panic!("first default tool must be translate");
    };
    ai.prompt = "My own translate prompt {selection}".into();
    customized.upgrade_legacy_defaults();
    let SelectionToolbarTool::BuiltinAi { ai, .. } = &customized.tools[0] else {
        panic!("first default tool must be translate");
    };
    assert_eq!(ai.prompt, "My own translate prompt {selection}");
}

#[test]
fn selection_toolbar_upgrade_inserts_explain_after_translate() {
    let mut legacy_json =
        serde_json::to_value(SelectionToolbarSettings::default()).expect("serialize defaults");
    let object = legacy_json
        .as_object_mut()
        .expect("selection toolbar settings should be an object");
    object.remove("trigger_mode");
    object.remove("trigger_shortcut");
    object.remove("display_mode");
    let tools = object
        .get_mut("tools")
        .and_then(serde_json::Value::as_array_mut)
        .expect("tools should be an array");
    tools.retain(|tool| tool["builtin_key"] != "explain");
    tools[0]["enabled"] = serde_json::Value::Bool(false);

    let mut legacy: SelectionToolbarSettings =
        serde_json::from_value(legacy_json).expect("legacy settings should deserialize");
    legacy.upgrade_legacy_defaults();

    let ids: Vec<_> = legacy.tools.iter().map(SelectionToolbarTool::id).collect();
    assert_eq!(
        ids,
        [
            "translate",
            "explain",
            "polish",
            "summarize",
            "copy",
            "search"
        ]
    );
    assert_eq!(legacy.trigger_mode, SelectionToolbarTriggerMode::Selection);
    assert_eq!(legacy.display_mode, SelectionToolbarDisplayMode::Full);
    assert_eq!(legacy.trigger_shortcut, DEFAULT_SELECTION_TOOLBAR_SHORTCUT);
    assert!(!legacy.tools[0].enabled());
    let SelectionToolbarTool::BuiltinAi { ai, enabled, .. } = &legacy.tools[1] else {
        panic!("explain should be a builtin AI tool");
    };
    assert!(*enabled);
    assert_eq!(ai.prompt, DEFAULT_EXPLAIN_PROMPT);
    legacy
        .validate()
        .expect("upgraded settings should validate");
}

#[test]
fn selection_toolbar_upgrade_inserts_search_after_copy() {
    let mut legacy = SelectionToolbarSettings::default();
    legacy.tools.retain(|tool| tool.id() != "search");
    legacy.search_url = String::new();
    legacy.upgrade_legacy_defaults();

    let ids: Vec<_> = legacy.tools.iter().map(SelectionToolbarTool::id).collect();
    assert_eq!(
        ids,
        [
            "translate",
            "explain",
            "polish",
            "summarize",
            "copy",
            "search"
        ]
    );
    assert_eq!(legacy.search_url, DEFAULT_SELECTION_TOOLBAR_SEARCH_URL);
    legacy
        .validate()
        .expect("upgraded search tool should validate");
}

#[test]
fn model_catalog_source_defaults_to_builtin_and_roundtrips_online() {
    let settings = AppSettings::default();
    assert_eq!(
        settings.model_catalog_source,
        ModelCatalogSourcePreference::Builtin
    );

    let settings: AppSettings = serde_json::from_value(json!({
        "model_catalog_source": "online"
    }))
    .expect("settings should deserialize");
    assert_eq!(
        settings.model_catalog_source,
        ModelCatalogSourcePreference::Online
    );

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("missing setting should use default");
    assert_eq!(
        settings.model_catalog_source,
        ModelCatalogSourcePreference::Builtin
    );
}

#[test]
fn release_webview_on_tray_roundtrips_and_defaults_when_missing() {
    let settings: AppSettings = serde_json::from_value(json!({
        "release_webview_on_tray": true
    }))
    .expect("settings should deserialize");
    assert!(settings.release_webview_on_tray);

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert!(!settings.release_webview_on_tray);
}

#[test]
fn document_attachment_reading_defaults_to_false_for_missing_settings() {
    let settings = AppSettings::default();
    assert!(!settings.document_attachment_reading_enabled);

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert!(!settings.document_attachment_reading_enabled);
}

#[test]
fn multi_model_execution_defaults_to_parallel_with_three_second_interval() {
    let settings = AppSettings::default();
    assert_eq!(
        settings.multi_model_execution_mode,
        MultiModelExecutionMode::Parallel
    );
    assert_eq!(
        settings.multi_model_sequential_interval_seconds,
        DEFAULT_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS
    );

    let legacy: AppSettings =
        serde_json::from_value(json!({})).expect("missing schedule settings should deserialize");
    assert_eq!(
        legacy.multi_model_execution_mode,
        MultiModelExecutionMode::Parallel
    );
    assert_eq!(
        legacy.multi_model_sequential_interval_seconds,
        DEFAULT_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS
    );
}

#[test]
fn multi_model_execution_mode_roundtrips_snake_case() {
    let mut settings = AppSettings::default();
    settings.multi_model_execution_mode = MultiModelExecutionMode::Sequential;
    settings.multi_model_sequential_interval_seconds = 0;

    let serialized = serde_json::to_value(&settings).expect("settings should serialize");
    assert_eq!(serialized["multi_model_execution_mode"], json!("sequential"));
    assert_eq!(serialized["multi_model_sequential_interval_seconds"], json!(0));

    let restored: AppSettings =
        serde_json::from_value(serialized).expect("settings should roundtrip");
    assert_eq!(
        restored.multi_model_execution_mode,
        MultiModelExecutionMode::Sequential
    );
    assert_eq!(restored.multi_model_sequential_interval_seconds, 0);
}

#[test]
fn chat_stream_timeouts_have_safe_defaults_and_roundtrip() {
    let settings = AppSettings::default();
    assert_eq!(settings.chat_stream_first_packet_timeout_secs, 180);
    assert_eq!(settings.chat_stream_idle_timeout_secs, 90);

    let settings: AppSettings = serde_json::from_value(json!({
        "chat_stream_first_packet_timeout_secs": 45,
        "chat_stream_idle_timeout_secs": 12
    }))
    .expect("settings should deserialize");

    assert_eq!(settings.chat_stream_first_packet_timeout_secs, 45);
    assert_eq!(settings.chat_stream_idle_timeout_secs, 12);
}

#[test]
fn chat_typography_defaults_and_roundtrips() {
    let settings = AppSettings::default();
    assert_eq!(settings.chat_font_size, 15);
    assert_eq!(settings.chat_line_height, 1.7);
    assert_eq!(settings.chat_font_family, "");
    assert_eq!(settings.chat_font_weight, 400);
    assert_eq!(settings.chat_user_message_area_style, "none");
    assert_eq!(
        settings.chat_user_message_area_light_color,
        "rgba(0, 0, 0, 0)"
    );
    assert_eq!(
        settings.chat_user_message_area_dark_color,
        "rgba(0, 0, 0, 0)"
    );
    assert_eq!(settings.chat_user_message_area_border_width, 1);
    assert_eq!(settings.chat_ai_message_area_style, "none");
    assert_eq!(settings.chat_ai_message_area_light_color, "#f5f5f5");
    assert_eq!(
        settings.chat_ai_message_area_dark_color,
        "rgba(255, 255, 255, 0.06)"
    );
    assert_eq!(settings.chat_ai_message_area_border_width, 1);

    let settings: AppSettings = serde_json::from_value(json!({
        "chat_font_size": 18,
        "chat_line_height": 1.8,
        "chat_font_family": "Inter",
        "chat_font_weight": 500,
        "chat_user_message_area_style": "border",
        "chat_user_message_area_light_color": "rgba(1, 2, 3, 0.4)",
        "chat_user_message_area_dark_color": "rgba(4, 5, 6, 0.5)",
        "chat_user_message_area_border_width": 3,
        "chat_ai_message_area_style": "background",
        "chat_ai_message_area_light_color": "#eeeeee",
        "chat_ai_message_area_dark_color": "rgba(255, 255, 255, 0.1)",
        "chat_ai_message_area_border_width": 2
    }))
    .expect("settings should deserialize");

    assert_eq!(settings.chat_font_size, 18);
    assert_eq!(settings.chat_line_height, 1.8);
    assert_eq!(settings.chat_font_family, "Inter");
    assert_eq!(settings.chat_font_weight, 500);
    assert_eq!(settings.chat_user_message_area_style, "border");
    assert_eq!(
        settings.chat_user_message_area_light_color,
        "rgba(1, 2, 3, 0.4)"
    );
    assert_eq!(
        settings.chat_user_message_area_dark_color,
        "rgba(4, 5, 6, 0.5)"
    );
    assert_eq!(settings.chat_user_message_area_border_width, 3);
    assert_eq!(settings.chat_ai_message_area_style, "background");
    assert_eq!(settings.chat_ai_message_area_light_color, "#eeeeee");
    assert_eq!(
        settings.chat_ai_message_area_dark_color,
        "rgba(255, 255, 255, 0.1)"
    );
    assert_eq!(settings.chat_ai_message_area_border_width, 2);

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert_eq!(settings.chat_font_size, 15);
    assert_eq!(settings.chat_line_height, 1.7);
    assert_eq!(settings.chat_font_family, "");
    assert_eq!(settings.chat_font_weight, 400);
    assert_eq!(settings.chat_user_message_area_style, "none");
    assert_eq!(
        settings.chat_user_message_area_light_color,
        "rgba(0, 0, 0, 0)"
    );
    assert_eq!(
        settings.chat_user_message_area_dark_color,
        "rgba(0, 0, 0, 0)"
    );
    assert_eq!(settings.chat_user_message_area_border_width, 1);
    assert_eq!(settings.chat_ai_message_area_style, "none");
    assert_eq!(settings.chat_ai_message_area_light_color, "#f5f5f5");
    assert_eq!(
        settings.chat_ai_message_area_dark_color,
        "rgba(255, 255, 255, 0.06)"
    );
    assert_eq!(settings.chat_ai_message_area_border_width, 1);
}

#[test]
fn chat_input_actions_scale_defaults_and_roundtrips() {
    let settings = AppSettings::default();
    assert_eq!(settings.chat_input_actions_scale, 100);

    let missing: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert_eq!(missing.chat_input_actions_scale, 100);

    let mut customized = AppSettings::default();
    customized.chat_input_actions_scale = 150;
    let serialized = serde_json::to_value(customized).expect("settings should serialize");
    let roundtrip: AppSettings =
        serde_json::from_value(serialized).expect("settings should deserialize");
    assert_eq!(roundtrip.chat_input_actions_scale, 150);
}

#[test]
fn mcp_tool_loop_max_iterations_defaults_to_100_and_roundtrips() {
    let settings = AppSettings::default();
    assert_eq!(settings.mcp_tool_loop_max_iterations, 100);

    let settings: AppSettings = serde_json::from_value(json!({
        "mcp_tool_loop_max_iterations": 25
    }))
    .expect("settings should deserialize");

    assert_eq!(settings.mcp_tool_loop_max_iterations, 25);

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert_eq!(settings.mcp_tool_loop_max_iterations, 100);
}

#[test]
fn chat_sidebar_collapsed_defaults_to_false_and_roundtrips() {
    let settings = AppSettings::default();
    assert!(!settings.chat_sidebar_collapsed);

    let settings: AppSettings = serde_json::from_value(json!({
        "chat_sidebar_collapsed": true
    }))
    .expect("settings should deserialize");
    assert!(settings.chat_sidebar_collapsed);

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert!(!settings.chat_sidebar_collapsed);
}

#[test]
fn conversation_tabs_enabled_defaults_to_false_and_roundtrips() {
    let settings = AppSettings::default();
    assert!(!settings.conversation_tabs_enabled);

    let settings: AppSettings = serde_json::from_value(json!({
        "conversation_tabs_enabled": true
    }))
    .expect("settings should deserialize");
    assert!(settings.conversation_tabs_enabled);

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert!(!settings.conversation_tabs_enabled);
}

#[test]
fn inherit_conversation_preferences_on_create_defaults_to_enabled_and_roundtrips() {
    let settings = AppSettings::default();
    assert!(settings.inherit_conversation_preferences_on_create);

    let settings: AppSettings = serde_json::from_value(json!({
        "inherit_conversation_preferences_on_create": false
    }))
    .expect("settings should deserialize");
    assert!(!settings.inherit_conversation_preferences_on_create);

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert!(settings.inherit_conversation_preferences_on_create);
}

#[test]
fn agent_workspace_settings_default_and_roundtrip() {
    let settings = AppSettings::default();
    assert_eq!(settings.agent_workspace_root, None);
    assert_eq!(settings.agent_workspace_name_strategy, "uuid");
    assert_eq!(
        settings.agent_workspace_datetime_format,
        Some("YYYY-MM-DD-HH-mm-ss".to_string())
    );

    let settings: AppSettings = serde_json::from_value(json!({
        "agent_workspace_root": "/tmp/aqbot-agents",
        "agent_workspace_name_strategy": "created_datetime",
        "agent_workspace_datetime_format": "YYYY-MM-DD-HH:mm:ss"
    }))
    .expect("settings should deserialize");

    assert_eq!(
        settings.agent_workspace_root.as_deref(),
        Some("/tmp/aqbot-agents")
    );
    assert_eq!(settings.agent_workspace_name_strategy, "created_datetime");
    assert_eq!(
        settings.agent_workspace_datetime_format.as_deref(),
        Some("YYYY-MM-DD-HH:mm:ss")
    );

    let settings: AppSettings =
        serde_json::from_value(json!({})).expect("settings should default missing fields");
    assert_eq!(settings.agent_workspace_root, None);
    assert_eq!(settings.agent_workspace_name_strategy, "uuid");
}
