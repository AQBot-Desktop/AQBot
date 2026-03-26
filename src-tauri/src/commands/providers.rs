use crate::AppState;
use aqbot_core::types::*;
use tauri::State;
use std::time::Instant;

#[tauri::command]
pub async fn list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderConfig>, String> {
    aqbot_core::repo::provider::list_providers(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_provider(
    state: State<'_, AppState>,
    input: CreateProviderInput,
) -> Result<ProviderConfig, String> {
    aqbot_core::repo::provider::create_provider(&state.sea_db, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_provider(
    state: State<'_, AppState>,
    id: String,
    input: UpdateProviderInput,
) -> Result<ProviderConfig, String> {
    aqbot_core::repo::provider::update_provider(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_provider(state: State<'_, AppState>, id: String) -> Result<(), String> {
    aqbot_core::repo::provider::delete_provider(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_provider(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    aqbot_core::repo::provider::toggle_provider(&state.sea_db, &id, enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_provider_key(
    state: State<'_, AppState>,
    provider_id: String,
    raw_key: String,
) -> Result<ProviderKey, String> {
    let encrypted =
        aqbot_core::crypto::encrypt_key(&raw_key, &state.master_key).map_err(|e| e.to_string())?;
    let prefix = if raw_key.len() >= 8 {
        format!("{}...", &raw_key[..8])
    } else {
        raw_key.clone()
    };
    aqbot_core::repo::provider::add_provider_key(&state.sea_db, &provider_id, &encrypted, &prefix)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_provider_key(
    state: State<'_, AppState>,
    key_id: String,
) -> Result<(), String> {
    aqbot_core::repo::provider::delete_provider_key(&state.sea_db, &key_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_provider_key(
    state: State<'_, AppState>,
    key_id: String,
    enabled: bool,
) -> Result<(), String> {
    aqbot_core::repo::provider::toggle_provider_key(&state.sea_db, &key_id, enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn validate_provider_key(
    state: State<'_, AppState>,
    key_id: String,
) -> Result<bool, String> {
    let key_row = aqbot_core::repo::provider::get_provider_key(&state.sea_db, &key_id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &key_row.provider_id)
        .await
        .map_err(|e| e.to_string())?;
    // Use the registry to validate by listing models
    let registry = aqbot_providers::registry::ProviderRegistry::create_default();
    let provider_type_str = match provider.provider_type {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Custom => "openai",
    };
    let adapter = registry.get(provider_type_str)
        .ok_or_else(|| format!("No adapter for provider type: {}", provider_type_str))?;
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = aqbot_core::types::ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = aqbot_providers::ProviderRequestContext {
        api_key: decrypted,
        key_id: key_id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(aqbot_providers::resolve_base_url(&provider.api_host)),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
    };
    let valid = adapter.validate_key(&ctx).await.unwrap_or(false);
    // Update validation timestamp
    aqbot_core::repo::provider::update_key_validation(&state.sea_db, &key_id, valid)
        .await
        .map_err(|e| e.to_string())?;
    Ok(valid)
}

#[tauri::command]
pub async fn save_models(
    state: State<'_, AppState>,
    provider_id: String,
    models: Vec<Model>,
) -> Result<(), String> {
    aqbot_core::repo::provider::save_models(&state.sea_db, &provider_id, &models)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_model(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
    enabled: bool,
) -> Result<Model, String> {
    aqbot_core::repo::provider::toggle_model(&state.sea_db, &provider_id, &model_id, enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_model_params(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
    overrides: ModelParamOverrides,
) -> Result<Model, String> {
    aqbot_core::repo::provider::update_model_params(
        &state.sea_db,
        &provider_id,
        &model_id,
        overrides,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_remote_models(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<Model>, String> {
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    // Get an enabled key for the provider
    let key_row = aqbot_core::repo::provider::get_active_key(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;
    let registry = aqbot_providers::registry::ProviderRegistry::create_default();
    let provider_type_str = match provider.provider_type {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Custom => "openai",
    };
    let adapter = registry.get(provider_type_str)
        .ok_or_else(|| format!("No adapter for provider type: {}", provider_type_str))?;
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = aqbot_core::types::ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = aqbot_providers::ProviderRequestContext {
        api_key: decrypted,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(aqbot_providers::resolve_base_url(&provider.api_host)),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
    };
    adapter.list_models(&ctx)
        .await
        .map_err(|e| e.to_string())
}

/// Test a single model's availability by sending a minimal chat request.
/// Returns latency in milliseconds on success.
#[tauri::command]
pub async fn test_model(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
) -> Result<u64, String> {
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row = aqbot_core::repo::provider::get_active_key(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;
    let registry = aqbot_providers::registry::ProviderRegistry::create_default();
    let provider_type_str = match provider.provider_type {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Custom => "openai",
    };
    let adapter = registry.get(provider_type_str)
        .ok_or_else(|| format!("No adapter for provider type: {}", provider_type_str))?;
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy = aqbot_core::types::ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = aqbot_providers::ProviderRequestContext {
        api_key: decrypted,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(aqbot_providers::resolve_base_url(&provider.api_host)),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
    };
    let request = ChatRequest {
        model: model_id,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: ChatContent::Text("hi".into()),
            tool_calls: None,
            tool_call_id: None,
        }],
        stream: false,
        temperature: None,
        top_p: None,
        max_tokens: Some(1),
        tools: None,
        thinking_budget: None,
    };
    let start = Instant::now();
    adapter.chat(&ctx, request)
        .await
        .map_err(|e| e.to_string())?;
    Ok(start.elapsed().as_millis() as u64)
}

#[tauri::command]
pub async fn reorder_providers(
    state: State<'_, AppState>,
    provider_ids: Vec<String>,
) -> Result<(), String> {
    aqbot_core::repo::provider::reorder_providers(&state.sea_db, &provider_ids)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InitializeResult {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub skipped: Vec<String>,
}

#[tauri::command]
pub async fn initialize_providers(
    state: State<'_, AppState>,
    overwrite: bool,
) -> Result<InitializeResult, String> {
    let existing = aqbot_core::repo::provider::list_providers(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    let builtins = aqbot_core::db::get_builtin_providers();
    let max_sort = existing.iter().map(|p| p.sort_order).max().unwrap_or(-1);

    let mut added = Vec::new();
    let mut updated = Vec::new();
    let mut skipped = Vec::new();

    for (i, bp) in builtins.into_iter().enumerate() {
        let matched = existing.iter().find(|p| p.name == bp.name);

        if let Some(ex) = matched {
            if overwrite {
                aqbot_core::repo::provider::update_provider(
                    &state.sea_db,
                    &ex.id,
                    aqbot_core::types::UpdateProviderInput {
                        name: Some(bp.name.to_string()),
                        provider_type: Some(bp.provider_type.clone()),
                        api_host: Some(bp.api_host.to_string()),
                        api_path: Some(None),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| e.to_string())?;

                let models: Vec<aqbot_core::types::Model> = bp
                    .models
                    .into_iter()
                    .map(|(model_id, name, caps, max_tokens)| aqbot_core::types::Model {
                        provider_id: ex.id.clone(),
                        model_id: model_id.to_string(),
                        name: name.to_string(),
                        group_name: None,
                        model_type: aqbot_core::types::ModelType::detect(model_id),
                        capabilities: caps,
                        max_tokens,
                        enabled: true,
                        param_overrides: None,
                    })
                    .collect();

                aqbot_core::repo::provider::save_models(&state.sea_db, &ex.id, &models)
                    .await
                    .map_err(|e| e.to_string())?;

                updated.push(bp.name.to_string());
            } else {
                skipped.push(bp.name.to_string());
            }
        } else {
            let prov = aqbot_core::repo::provider::create_provider(
                &state.sea_db,
                aqbot_core::types::CreateProviderInput {
                    name: bp.name.to_string(),
                    provider_type: bp.provider_type,
                    api_host: bp.api_host.to_string(),
                    api_path: None,
                    enabled: true,
                },
            )
            .await
            .map_err(|e| e.to_string())?;

            let models: Vec<aqbot_core::types::Model> = bp
                .models
                .into_iter()
                .map(|(model_id, name, caps, max_tokens)| aqbot_core::types::Model {
                    provider_id: prov.id.clone(),
                    model_id: model_id.to_string(),
                    name: name.to_string(),
                    group_name: None,
                    model_type: aqbot_core::types::ModelType::detect(model_id),
                    capabilities: caps,
                    max_tokens,
                    enabled: true,
                    param_overrides: None,
                })
                .collect();

            aqbot_core::repo::provider::save_models(&state.sea_db, &prov.id, &models)
                .await
                .map_err(|e| e.to_string())?;

            aqbot_core::repo::provider::update_provider(
                &state.sea_db,
                &prov.id,
                aqbot_core::types::UpdateProviderInput {
                    sort_order: Some(max_sort + 1 + i as i32),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;

            added.push(bp.name.to_string());
        }
    }

    Ok(InitializeResult { added, updated, skipped })
}
