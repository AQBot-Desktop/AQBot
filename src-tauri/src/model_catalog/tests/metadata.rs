use super::*;
use crate::model_catalog::metadata::model_type_for_mode;
use crate::model_catalog::types::ModelSyncStatus;
use aqbot_core::types::{
    Model, ModelCapability, ModelMetadataSource, ModelMetadataState, ModelParamOverrides,
    ModelType, ProviderConfig, ProviderType,
};

#[test]
fn parser_normalizes_safe_fields_for_all_modes() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).expect("catalog should parse");
    assert_eq!(entries.len(), 13);

    let openai = entries.get("gpt-4o").expect("OpenAI model");
    assert_eq!(openai.max_input_tokens, Some(128_000));
    assert_eq!(openai.max_output_tokens, Some(16_384));
    assert_eq!(openai.supports_system_messages, Some(false));
    assert_eq!(openai.supports_sampling_params, Some(false));
    assert_eq!(
        openai.reasoning_options.as_deref(),
        Some(
            &[
                "default".to_string(),
                "high".to_string(),
                "medium".to_string(),
                "none".to_string(),
                "xhigh".to_string(),
            ][..]
        )
    );

    let output_only = entries.get("output-only").expect("output-only model");
    assert_eq!(output_only.max_input_tokens, None);
    assert_eq!(output_only.max_output_tokens, Some(8_192));
    assert_eq!(
        entries["text-embedding-3-small"].mode,
        "embedding".to_string()
    );
    assert_eq!(entries["web-search-model"].mode, "search".to_string());
    for key in ["invalid-small", "invalid-zero", "invalid-large"] {
        assert_eq!(entries[key].max_input_tokens, None);
    }
    assert!(!entries.contains_key("invalid-type"));
    assert!(!entries.contains_key("sample_spec"));
}

#[test]
fn parser_never_uses_legacy_max_tokens() {
    let entries = parse_catalog(
        br#"{
          "legacy-only": {
            "litellm_provider": "openai",
            "mode": "chat",
            "max_tokens": 999999
          }
        }"#,
    )
    .unwrap();
    let entry = &entries["legacy-only"];
    assert_eq!(entry.max_input_tokens, None);
    assert_eq!(entry.max_output_tokens, None);
}

#[test]
fn mode_mapping_covers_supported_and_unsupported_modes() {
    for (mode, expected) in [
        ("chat", Some(ModelType::Chat)),
        ("responses", Some(ModelType::Chat)),
        ("completion", Some(ModelType::Chat)),
        ("embedding", Some(ModelType::Embedding)),
        ("image_generation", Some(ModelType::Image)),
        ("image_edit", Some(ModelType::Image)),
        ("audio_transcription", Some(ModelType::Voice)),
        ("audio_speech", Some(ModelType::Voice)),
        ("realtime", Some(ModelType::Voice)),
        ("rerank", Some(ModelType::Rerank)),
        ("search", None),
        ("video_generation", None),
    ] {
        assert_eq!(model_type_for_mode(mode), expected, "{mode}");
    }
}

#[test]
fn provider_resolution_handles_special_mappings_and_known_hosts() {
    assert_eq!(
        canonical_provider(
            &ProviderType::OpenAI,
            Some("openai"),
            "https://custom.invalid"
        ),
        Some("openai")
    );
    assert_eq!(
        canonical_provider(&ProviderType::OpenAI, None, "https://openrouter.ai/api/v1"),
        Some("openrouter")
    );
    assert_eq!(
        canonical_provider(
            &ProviderType::GLM,
            Some("glm"),
            "https://open.bigmodel.cn/api/paas"
        ),
        Some("zai")
    );
    assert_eq!(
        canonical_provider(
            &ProviderType::SiliconFlow,
            Some("siliconflow"),
            "https://api.siliconflow.cn"
        ),
        None
    );
    assert_eq!(
        canonical_provider(&ProviderType::Custom, None, "https://example.invalid/v1"),
        None
    );
}

#[test]
fn matching_is_provider_aware_and_exact() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).expect("catalog should parse");
    assert_eq!(
        find_context_window(&entries, Some("openai"), "gpt-4o"),
        Some(128_000)
    );
    assert_eq!(
        find_context_window(&entries, Some("openrouter"), "openai/gpt-4o"),
        Some(64_000)
    );
    assert_eq!(
        find_context_window(&entries, Some("github_copilot"), "gpt-4o"),
        Some(64_000)
    );
    assert_eq!(
        find_context_window(&entries, Some("zai"), "glm-4.6"),
        Some(128_000)
    );
    assert_eq!(
        find_context_window(&entries, Some("openai"), "gpt-4o-latest"),
        None
    );
    assert_eq!(find_context_window(&entries, None, "gpt-4o"), None);
    assert_eq!(
        find_context_window(&entries, None, "openrouter/openai/gpt-4o"),
        Some(64_000)
    );
}

#[test]
fn freshness_uses_checked_at_and_ttl() {
    let ttl_seconds = 24 * 60 * 60;
    assert_eq!(
        cache_freshness(1_000, 1_000 + ttl_seconds - 1, ttl_seconds),
        CatalogFreshness::Fresh
    );
    assert_eq!(
        cache_freshness(1_000, 1_000 + ttl_seconds, ttl_seconds),
        CatalogFreshness::Stale
    );
    assert_eq!(
        cache_freshness(2_000, 1_000, ttl_seconds),
        CatalogFreshness::Fresh
    );
}

fn provider(
    provider_type: ProviderType,
    builtin_id: Option<&str>,
    api_host: &str,
) -> ProviderConfig {
    ProviderConfig {
        id: "provider".into(),
        name: "Provider".into(),
        provider_type,
        api_host: api_host.into(),
        api_path: None,
        enabled: true,
        models: vec![],
        keys: vec![],
        proxy_config: None,
        custom_headers: None,
        icon: None,
        builtin_id: builtin_id.map(str::to_string),
        sort_order: 0,
        created_at: 0,
        updated_at: 0,
    }
}

fn model(model_id: &str) -> Model {
    Model {
        provider_id: "provider".into(),
        model_id: model_id.into(),
        name: model_id.into(),
        group_name: None,
        model_type: ModelType::Chat,
        capabilities: vec![ModelCapability::TextChat],
        context_window: None,
        max_output_tokens: None,
        enabled: true,
        param_overrides: None,
        image_config: None,
        metadata_state: None,
    }
}

fn catalog(entries: BTreeMap<String, CatalogEntry>) -> CatalogLoadResult {
    CatalogLoadResult {
        entries: Arc::new(entries),
        status: CatalogStatus {
            configured_source: ModelCatalogSourcePreference::Online,
            source: CatalogSource::Network,
            freshness: CatalogFreshness::Fresh,
            matched_context_windows: 0,
            total_chat_models: 0,
            matched_models: 0,
            autofilled_fields: 0,
            inferred_types: 0,
            unsupported_models: 0,
            checked_at: Some(1),
            warning: None,
        },
    }
}

#[test]
fn exact_catalog_metadata_beats_name_heuristics() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    let result = infer_remote_models(
        &provider(
            ProviderType::OpenAI,
            Some("openai"),
            "https://api.openai.com",
        ),
        vec![
            model("gpt-4o"),
            model("gpt-4o-audio-preview"),
            model("amazon.titan-embed-image-v1"),
            model("web-search-model"),
        ],
        catalog(entries),
    );

    let by_id: BTreeMap<_, _> = result
        .candidates
        .iter()
        .map(|candidate| (candidate.proposed_model.model_id.as_str(), candidate))
        .collect();
    let gpt = by_id["gpt-4o"];
    assert_eq!(gpt.proposed_model.context_window, Some(128_000));
    assert_eq!(gpt.proposed_model.max_output_tokens, Some(16_384));
    assert!(gpt
        .proposed_model
        .capabilities
        .contains(&ModelCapability::FunctionCalling));
    assert!(!gpt
        .proposed_model
        .capabilities
        .contains(&ModelCapability::Reasoning));
    assert_eq!(
        gpt.proposed_model
            .param_overrides
            .as_ref()
            .and_then(|value| value.no_system_role),
        Some(true)
    );
    assert_eq!(
        gpt.proposed_model
            .param_overrides
            .as_ref()
            .and_then(|value| value.omit_sampling_params),
        Some(true)
    );
    assert_eq!(
        by_id["gpt-4o-audio-preview"].proposed_model.model_type,
        ModelType::Chat
    );
    assert_eq!(
        by_id["amazon.titan-embed-image-v1"]
            .proposed_model
            .model_type,
        ModelType::Embedding
    );
    assert_eq!(
        by_id["web-search-model"].status,
        ModelSyncStatus::Unsupported
    );
    assert_eq!(result.catalog.matched_models, 4);
    assert_eq!(result.catalog.unsupported_models, 1);
}

#[test]
fn legacy_local_values_are_preserved_but_new_output_limit_is_added() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    let mut provider = provider(
        ProviderType::OpenAI,
        Some("openai"),
        "https://api.openai.com",
    );
    let mut local = model("gpt-4o");
    local.context_window = Some(32_000);
    local.capabilities = vec![ModelCapability::TextChat];
    provider.models.push(local);

    let result = infer_remote_models(&provider, vec![model("gpt-4o")], catalog(entries));
    let proposed = &result.candidates[0].proposed_model;

    assert_eq!(proposed.context_window, Some(32_000));
    assert_eq!(proposed.max_output_tokens, Some(16_384));
    assert_eq!(
        proposed.metadata_state.as_ref().unwrap().context_window,
        ModelMetadataSource::User
    );
}

#[test]
fn automatic_only_inference_discards_user_metadata_from_the_seed() {
    let mut manual = model("plain-model");
    manual.model_type = ModelType::Image;
    manual.capabilities = vec![ModelCapability::Vision];
    manual.context_window = Some(32_000);
    manual.max_output_tokens = Some(4_096);
    manual.param_overrides = Some(ModelParamOverrides {
        no_system_role: Some(false),
        omit_sampling_params: Some(false),
        reasoning_options: Some(vec!["high".into()]),
        temperature: Some(0.4),
        ..ModelParamOverrides::default()
    });
    manual.metadata_state = Some(ModelMetadataState {
        model_type: ModelMetadataSource::User,
        capabilities: ModelMetadataSource::User,
        context_window: ModelMetadataSource::User,
        max_output_tokens: ModelMetadataSource::User,
        no_system_role: ModelMetadataSource::User,
        omit_sampling_params: ModelMetadataSource::User,
        reasoning_options: ModelMetadataSource::User,
        ..ModelMetadataState::default()
    });

    let result = infer_single_model(
        &provider(ProviderType::Custom, None, "https://example.invalid"),
        manual,
        catalog(BTreeMap::new()),
        true,
    );
    let proposed = result.proposed_model;

    assert_eq!(proposed.model_type, ModelType::Chat);
    assert_eq!(proposed.capabilities, vec![ModelCapability::TextChat]);
    assert_eq!(proposed.context_window, None);
    assert_eq!(proposed.max_output_tokens, None);
    let params = proposed.param_overrides.expect("request overrides");
    assert_eq!(params.no_system_role, None);
    assert_eq!(params.omit_sampling_params, None);
    assert_eq!(params.reasoning_options, None);
    assert_eq!(params.temperature, Some(0.4));
}

#[test]
fn user_metadata_and_explicit_token_clears_win_over_catalog_updates() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    let mut provider = provider(
        ProviderType::OpenAI,
        Some("openai"),
        "https://api.openai.com",
    );
    let mut local = model("gpt-4o");
    local.capabilities = vec![ModelCapability::TextChat, ModelCapability::Reasoning];
    local.param_overrides = Some(ModelParamOverrides {
        no_system_role: Some(false),
        omit_sampling_params: Some(false),
        reasoning_options: Some(vec!["low".into()]),
        ..ModelParamOverrides::default()
    });
    local.metadata_state = Some(ModelMetadataState {
        capabilities: ModelMetadataSource::User,
        context_window: ModelMetadataSource::User,
        max_output_tokens: ModelMetadataSource::User,
        no_system_role: ModelMetadataSource::User,
        omit_sampling_params: ModelMetadataSource::User,
        reasoning_options: ModelMetadataSource::User,
        ..ModelMetadataState::default()
    });
    provider.models.push(local);

    let result = infer_remote_models(&provider, vec![model("gpt-4o")], catalog(entries));
    let proposed = &result.candidates[0].proposed_model;
    assert_eq!(proposed.context_window, None);
    assert_eq!(proposed.max_output_tokens, None);
    assert!(proposed.capabilities.contains(&ModelCapability::Reasoning));
    let overrides = proposed.param_overrides.as_ref().unwrap();
    assert_eq!(overrides.no_system_role, Some(false));
    assert_eq!(overrides.omit_sampling_params, Some(false));
    assert_eq!(
        overrides.reasoning_options.as_deref(),
        Some(&["low".into()][..])
    );
}

#[test]
fn catalog_explicit_false_removes_only_automatically_inferred_capability() {
    let entries = parse_catalog(
        br#"{
          "reasoning-chat": {
            "litellm_provider": "openai",
            "mode": "chat",
            "supports_reasoning": false
          }
        }"#,
    )
    .unwrap();
    let result = infer_remote_models(
        &provider(
            ProviderType::OpenAI,
            Some("openai"),
            "https://api.openai.com",
        ),
        vec![model("reasoning-chat")],
        catalog(entries),
    );

    assert!(!result.candidates[0]
        .proposed_model
        .capabilities
        .contains(&ModelCapability::Reasoning));
}

#[test]
fn unknown_provider_is_not_guessed_but_qualified_custom_key_matches() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    let silicon = infer_remote_models(
        &provider(
            ProviderType::SiliconFlow,
            Some("siliconflow"),
            "https://api.siliconflow.cn",
        ),
        vec![model("gpt-4o")],
        catalog(entries.clone()),
    );
    let qualified = infer_remote_models(
        &provider(ProviderType::Custom, None, "https://example.invalid/v1"),
        vec![model("openrouter/openai/gpt-4o")],
        catalog(entries),
    );

    assert_eq!(silicon.candidates[0].proposed_model.context_window, None);
    assert_eq!(
        qualified.candidates[0].proposed_model.context_window,
        Some(64_000)
    );
}

#[test]
fn unavailable_catalog_keeps_provider_sync_usable() {
    let input = model("my-voice-model");
    let result = infer_remote_models(
        &provider(
            ProviderType::OpenAI,
            Some("openai"),
            "https://api.openai.com",
        ),
        vec![input],
        CatalogLoadResult {
            entries: Arc::new(Default::default()),
            status: CatalogStatus {
                configured_source: ModelCatalogSourcePreference::Online,
                source: CatalogSource::Unavailable,
                freshness: CatalogFreshness::Unknown,
                matched_context_windows: 0,
                total_chat_models: 0,
                matched_models: 0,
                autofilled_fields: 0,
                inferred_types: 0,
                unsupported_models: 0,
                checked_at: None,
                warning: Some("offline".into()),
            },
        },
    );

    assert_eq!(
        result.candidates[0].proposed_model.model_type,
        ModelType::Voice
    );
    assert_eq!(result.catalog.source, CatalogSource::Unavailable);
}
