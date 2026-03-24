use crate::AppState;
use aqbot_core::types::*;
use tauri::State;

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
        base_url: Some(provider.api_host.clone()),
        proxy_config: resolved_proxy,
    };
    let valid = adapter.list_models(&ctx).await.is_ok();
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
        base_url: Some(provider.api_host.clone()),
        proxy_config: resolved_proxy,
    };
    adapter.list_models(&ctx)
        .await
        .map_err(|e| e.to_string())
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
