use super::*;
use aqbot_core::types::{Model, ModelType, ProviderConfig, ProviderType};

#[test]
fn parser_keeps_only_valid_chat_input_limits() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).expect("catalog should parse");
    assert_eq!(entries.len(), 4);
    let openai = entries.get("gpt-4o").expect("OpenAI model");
    assert_eq!(openai.max_input_tokens, 128_000);
    assert_eq!(openai.provider, "openai");
    assert_eq!(openai.supports_vision, Some(true));
    assert!(!entries.contains_key("output-only"));
    assert!(!entries.contains_key("text-embedding-3-small"));
    assert!(!entries.contains_key("invalid-small"));
    assert!(!entries.contains_key("invalid-zero"));
    assert!(!entries.contains_key("invalid-large"));
    assert!(!entries.contains_key("invalid-type"));
    assert!(!entries.contains_key("sample_spec"));
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
    assert_eq!(
        canonical_provider(
            &ProviderType::Custom,
            None,
            "https://evil-openrouter.ai.example.com/v1"
        ),
        None
    );
    assert_eq!(
        canonical_provider(&ProviderType::Jina, Some("jina"), "https://api.jina.ai"),
        Some("jina")
    );
}

#[test]
fn provider_resolution_maps_named_builtins() {
    for (provider_type, builtin_id, expected) in [
        (ProviderType::OpenAIResponses, "openai_responses", "openai"),
        (ProviderType::Gemini, "gemini", "gemini"),
        (ProviderType::Anthropic, "anthropic", "anthropic"),
        (ProviderType::DeepSeek, "deepseek", "deepseek"),
        (ProviderType::XAI, "xai", "xai"),
        (ProviderType::OpenAI, "minimax", "minimax"),
        (ProviderType::Cohere, "cohere", "cohere"),
        (ProviderType::Voyage, "voyage", "voyage"),
    ] {
        assert_eq!(
            canonical_provider(&provider_type, Some(builtin_id), "https://api.example.com"),
            Some(expected)
        );
    }
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

fn model(model_id: &str, model_type: ModelType, context_window: Option<u32>) -> Model {
    Model {
        provider_id: "provider".into(),
        model_id: model_id.into(),
        name: model_id.into(),
        group_name: None,
        model_type,
        capabilities: vec![],
        context_window,
        enabled: true,
        param_overrides: None,
        image_config: None,
    }
}

#[test]
fn enrichment_updates_only_empty_chat_context_windows() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    let catalog = CatalogLoadResult {
        entries: Arc::new(entries),
        status: CatalogStatus {
            configured_source: ModelCatalogSourcePreference::Online,
            source: CatalogSource::Network,
            freshness: CatalogFreshness::Fresh,
            matched_context_windows: 0,
            total_chat_models: 0,
            checked_at: Some(1),
            warning: None,
        },
    };
    let provider = provider(
        ProviderType::OpenAI,
        Some("openai"),
        "https://api.openai.com",
    );

    let result = enrich_models(
        &provider,
        vec![
            model("gpt-4o", ModelType::Chat, None),
            model("gpt-4o", ModelType::Chat, Some(32_000)),
            model("gpt-4o", ModelType::Embedding, None),
        ],
        catalog,
    );

    assert_eq!(result.models[0].context_window, Some(128_000));
    assert_eq!(result.models[1].context_window, Some(32_000));
    assert_eq!(result.models[2].context_window, None);
    assert_eq!(result.catalog.matched_context_windows, 2);
    assert_eq!(result.catalog.total_chat_models, 2);
}

#[test]
fn enrichment_does_not_guess_unknown_provider_models() {
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    let status = CatalogStatus {
        configured_source: ModelCatalogSourcePreference::Online,
        source: CatalogSource::Cache,
        freshness: CatalogFreshness::Fresh,
        matched_context_windows: 0,
        total_chat_models: 0,
        checked_at: Some(1),
        warning: None,
    };

    let silicon = enrich_models(
        &provider(
            ProviderType::SiliconFlow,
            Some("siliconflow"),
            "https://api.siliconflow.cn",
        ),
        vec![model("gpt-4o", ModelType::Chat, None)],
        CatalogLoadResult {
            entries: Arc::new(entries.clone()),
            status: status.clone(),
        },
    );
    let qualified_custom = enrich_models(
        &provider(ProviderType::Custom, None, "https://example.invalid/v1"),
        vec![model("openrouter/openai/gpt-4o", ModelType::Chat, None)],
        CatalogLoadResult {
            entries: Arc::new(entries),
            status,
        },
    );

    assert_eq!(silicon.models[0].context_window, None);
    assert_eq!(qualified_custom.models[0].context_window, Some(64_000));
}

#[test]
fn unavailable_catalog_leaves_provider_models_usable() {
    let catalog = CatalogLoadResult {
        entries: Arc::new(Default::default()),
        status: CatalogStatus {
            configured_source: ModelCatalogSourcePreference::Online,
            source: CatalogSource::Unavailable,
            freshness: CatalogFreshness::Unknown,
            matched_context_windows: 0,
            total_chat_models: 0,
            checked_at: None,
            warning: Some("offline".into()),
        },
    };
    let input = vec![model("gpt-4o", ModelType::Chat, None)];

    let result = enrich_models(
        &provider(
            ProviderType::OpenAI,
            Some("openai"),
            "https://api.openai.com",
        ),
        input.clone(),
        catalog,
    );

    assert_eq!(result.models[0].model_id, input[0].model_id);
    assert_eq!(result.models[0].context_window, None);
    assert_eq!(result.catalog.source, CatalogSource::Unavailable);
    assert_eq!(result.catalog.total_chat_models, 1);
}
