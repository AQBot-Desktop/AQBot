use crate::AppState;
use aqbot_core::repo::provider_import::{ProviderImportBatchResult, ProviderImportCandidate};
use aqbot_core::types::*;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;
use tauri::State;

fn provider_registry_key(provider_type: &ProviderType) -> &'static str {
    match provider_type {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::DeepSeek => "deepseek",
        ProviderType::XAI => "xai",
        ProviderType::GLM => "glm",
        ProviderType::SiliconFlow => "siliconflow",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Custom => "custom",
    }
}

async fn load_model_catalog(
    state: &AppState,
    settings: &AppSettings,
    now: i64,
) -> crate::model_catalog::CatalogLoadResult {
    if settings.model_catalog_source == ModelCatalogSourcePreference::Builtin {
        return state.model_catalog.load_builtin();
    }
    let proxy = ProviderProxyConfig::resolve(&None, settings);
    match aqbot_providers::build_http_client(proxy.as_ref()) {
        Ok(client) => state.model_catalog.load_online(&client, now).await,
        Err(error) => {
            state
                .model_catalog
                .load_cached_only(now, format!("Failed to build LiteLLM HTTP client: {error}"))
                .await
        }
    }
}

#[tauri::command]
pub async fn list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderConfig>, String> {
    aqbot_core::repo::provider::list_providers_merged(&state.sea_db)
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
pub async fn import_provider_from_deep_link(
    state: State<'_, AppState>,
    input: DeepLinkProviderImportInput,
) -> Result<DeepLinkProviderImportResult, String> {
    aqbot_core::repo::provider::import_provider_from_deep_link(
        &state.sea_db,
        &state.master_key,
        input,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan_cc_switch_provider_imports(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderImportCandidate>, String> {
    aqbot_core::repo::provider_import::scan_cc_switch_provider_imports(
        &state.sea_db,
        &state.master_key,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_cc_switch_provider_configs(
    state: State<'_, AppState>,
    candidate_ids: Vec<String>,
) -> Result<ProviderImportBatchResult, String> {
    let before = provider_model_inventory(state.inner()).await?;
    let result = aqbot_core::repo::provider_import::import_cc_switch_provider_configs(
        &state.sea_db,
        &state.master_key,
        candidate_ids,
    )
    .await
    .map_err(|e| e.to_string())?;
    adapt_imported_models(state.inner(), &before).await?;
    Ok(result)
}

pub(crate) async fn provider_model_inventory(
    state: &AppState,
) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    let providers = aqbot_core::repo::provider::list_providers_merged(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    Ok(providers
        .into_iter()
        .map(|provider| {
            (
                provider.id,
                provider
                    .models
                    .into_iter()
                    .map(|model| model.model_id)
                    .collect(),
            )
        })
        .collect())
}

pub(crate) async fn adapt_imported_models(
    state: &AppState,
    before: &BTreeMap<String, BTreeSet<String>>,
) -> Result<(), String> {
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let catalog = state
        .model_catalog
        .load_local(
            settings.model_catalog_source,
            chrono::Utc::now().timestamp(),
        )
        .await;
    let providers = aqbot_core::repo::provider::list_providers_merged(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    for mut provider in providers {
        if provider.id.starts_with("builtin_") {
            continue;
        }
        let previous = before.get(&provider.id);
        let mut changed = false;
        let context = provider.clone();
        for model in &mut provider.models {
            if previous.is_some_and(|models| models.contains(&model.model_id)) {
                continue;
            }
            let candidate = crate::model_catalog::infer_single_model(
                &context,
                model.clone(),
                catalog.clone(),
                true,
            );
            if candidate.unsupported_reason.is_some() {
                model.enabled = false;
                model.metadata_state = candidate.proposed_model.metadata_state;
            } else {
                *model = candidate.proposed_model;
            }
            changed = true;
        }
        if changed {
            aqbot_core::repo::provider::save_models_from_user_selection(
                &state.sea_db,
                &provider.id,
                &provider.models,
            )
            .await
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn update_provider(
    state: State<'_, AppState>,
    id: String,
    input: UpdateProviderInput,
) -> Result<ProviderConfig, String> {
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())?;
    aqbot_core::repo::provider::update_provider(&state.sea_db, &real_id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_provider(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Virtual built-in providers have no DB row — deletion is a no-op (they'll reappear)
    if id.starts_with("builtin_") {
        return Ok(());
    }
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
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())?;
    aqbot_core::repo::provider::toggle_provider(&state.sea_db, &real_id, enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_provider_key(
    state: State<'_, AppState>,
    provider_id: String,
    raw_key: String,
) -> Result<ProviderKey, String> {
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let encrypted =
        aqbot_core::crypto::encrypt_key(&raw_key, &state.master_key).map_err(|e| e.to_string())?;
    let prefix = if raw_key.len() >= 8 {
        format!("{}...", &raw_key[..8])
    } else {
        raw_key.clone()
    };
    aqbot_core::repo::provider::add_provider_key(&state.sea_db, &real_id, &encrypted, &prefix)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_provider_key(
    state: State<'_, AppState>,
    key_id: String,
    raw_key: String,
) -> Result<ProviderKey, String> {
    let encrypted =
        aqbot_core::crypto::encrypt_key(&raw_key, &state.master_key).map_err(|e| e.to_string())?;
    let prefix = if raw_key.len() >= 8 {
        format!("{}...", &raw_key[..8])
    } else {
        raw_key.clone()
    };
    aqbot_core::repo::provider::update_provider_key(&state.sea_db, &key_id, &encrypted, &prefix)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_provider_key(state: State<'_, AppState>, key_id: String) -> Result<(), String> {
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
pub async fn get_decrypted_provider_key(
    state: State<'_, AppState>,
    key_id: String,
) -> Result<String, String> {
    let key_row = aqbot_core::repo::provider::get_provider_key(&state.sea_db, &key_id)
        .await
        .map_err(|e| e.to_string())?;
    aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
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
    let provider_type_str = provider_registry_key(&provider.provider_type);
    let adapter = registry
        .get(provider_type_str)
        .ok_or_else(|| format!("No adapter for provider type: {}", provider_type_str))?;
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy =
        aqbot_core::types::ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = aqbot_providers::ProviderRequestContext {
        api_key: decrypted,
        key_id: key_id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(aqbot_providers::resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };
    let valid = match adapter.validate_key(&ctx).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("Key validation failed for key {}: {}", key_id, e);
            // Update as invalid, then return the error
            let _ =
                aqbot_core::repo::provider::update_key_validation(&state.sea_db, &key_id, false)
                    .await;
            return Err(e.to_string());
        }
    };
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
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    aqbot_core::repo::provider::save_models_from_user_selection(&state.sea_db, &real_id, &models)
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
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    aqbot_core::repo::provider::toggle_model(&state.sea_db, &real_id, &model_id, enabled)
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
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    aqbot_core::repo::provider::update_model_params(&state.sea_db, &real_id, &model_id, overrides)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_remote_models(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<crate::model_catalog::RemoteModelSyncResult, String> {
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &real_id)
        .await
        .map_err(|e| e.to_string())?;
    // Get an enabled key for the provider
    let key_row = aqbot_core::repo::provider::get_active_key(&state.sea_db, &real_id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;
    let registry = aqbot_providers::registry::ProviderRegistry::create_default();
    let provider_type_str = provider_registry_key(&provider.provider_type);
    let adapter = registry
        .get(provider_type_str)
        .ok_or_else(|| format!("No adapter for provider type: {}", provider_type_str))?;
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy =
        aqbot_core::types::ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = aqbot_providers::ProviderRequestContext {
        api_key: decrypted,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(aqbot_providers::resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };
    let now = chrono::Utc::now().timestamp();
    let catalog_future = load_model_catalog(state.inner(), &global_settings, now);
    let (models, catalog) = tokio::join!(adapter.list_models(&ctx), catalog_future);
    let models = models.map_err(|error| error.to_string())?;
    Ok(crate::model_catalog::infer_remote_models(
        &provider, models, catalog,
    ))
}

#[tauri::command]
pub async fn infer_model_metadata(
    state: State<'_, AppState>,
    provider_id: String,
    model: Model,
    automatic_only: Option<bool>,
) -> Result<crate::model_catalog::ModelSyncCandidate, String> {
    let provider = match aqbot_core::repo::provider::get_provider(&state.sea_db, &provider_id).await
    {
        Ok(provider) => provider,
        Err(error) if provider_id.starts_with("builtin_") => {
            aqbot_core::repo::provider::list_providers_merged(&state.sea_db)
                .await
                .map_err(|error| error.to_string())?
                .into_iter()
                .find(|provider| provider.id == provider_id)
                .ok_or_else(|| error.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let catalog = state
        .model_catalog
        .load_local(
            settings.model_catalog_source,
            chrono::Utc::now().timestamp(),
        )
        .await;
    Ok(crate::model_catalog::infer_single_model(
        &provider,
        model,
        catalog,
        automatic_only.unwrap_or(false),
    ))
}

#[tauri::command]
pub async fn apply_model_sync(
    state: State<'_, AppState>,
    provider_id: String,
    models: Vec<Model>,
) -> Result<(), String> {
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|error| error.to_string())?;
    aqbot_core::repo::provider::save_models_from_user_selection(&state.sea_db, &real_id, &models)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn update_model_metadata(
    state: State<'_, AppState>,
    provider_id: String,
    mut model: Model,
    user_fields: Vec<String>,
    automatic_fields: Option<Vec<String>>,
) -> Result<Model, String> {
    let automatic_fields = automatic_fields.unwrap_or_default();
    validate_metadata_field_updates(&model, &user_fields, &automatic_fields)?;
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|error| error.to_string())?;
    model.provider_id = real_id.clone();
    mark_model_metadata_as_user(&mut model, &user_fields);
    let mut provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &real_id)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(existing) = provider
        .models
        .iter_mut()
        .find(|existing| existing.model_id == model.model_id)
    {
        *existing = model.clone();
    } else {
        provider.models.push(model.clone());
    }
    aqbot_core::repo::provider::save_models_from_user_selection(
        &state.sea_db,
        &real_id,
        &provider.models,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(model)
}

fn metadata_field_source(
    metadata: &ModelMetadataState,
    field: &str,
) -> Option<ModelMetadataSource> {
    match field {
        "model_type" => Some(metadata.model_type),
        "capabilities" => Some(metadata.capabilities),
        "context_window" => Some(metadata.context_window),
        "max_output_tokens" => Some(metadata.max_output_tokens),
        "no_system_role" => Some(metadata.no_system_role),
        "omit_sampling_params" => Some(metadata.omit_sampling_params),
        "reasoning_options" => Some(metadata.reasoning_options),
        _ => None,
    }
}

fn validate_metadata_field_updates(
    model: &Model,
    user_fields: &[String],
    automatic_fields: &[String],
) -> Result<(), String> {
    let user_fields: BTreeSet<_> = user_fields.iter().map(String::as_str).collect();
    let automatic_fields: BTreeSet<_> = automatic_fields.iter().map(String::as_str).collect();
    if let Some(field) = user_fields.intersection(&automatic_fields).next() {
        return Err(format!(
            "Model metadata field cannot be both manual and automatic: {field}"
        ));
    }
    for field in &user_fields {
        if !is_metadata_field(field) {
            return Err(format!("Unknown model metadata field: {field}"));
        }
    }
    let metadata = model.metadata_state.as_ref();
    for field in automatic_fields {
        let source = metadata.and_then(|value| metadata_field_source(value, field));
        if source.is_none() {
            return Err(format!("Unknown model metadata field: {field}"));
        }
        if source == Some(ModelMetadataSource::User) {
            return Err(format!(
                "Automatic model metadata field still has user ownership: {field}"
            ));
        }
    }
    Ok(())
}

fn is_metadata_field(field: &str) -> bool {
    matches!(
        field,
        "model_type"
            | "capabilities"
            | "context_window"
            | "max_output_tokens"
            | "no_system_role"
            | "omit_sampling_params"
            | "reasoning_options"
    )
}

#[tauri::command]
pub async fn reset_model_metadata(
    state: State<'_, AppState>,
    provider_id: String,
    model_ids: Vec<String>,
    fields: Option<Vec<String>>,
) -> Result<Vec<Model>, String> {
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|error| error.to_string())?;
    let mut provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &real_id)
        .await
        .map_err(|error| error.to_string())?;
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let catalog =
        load_model_catalog(state.inner(), &settings, chrono::Utc::now().timestamp()).await;
    let reset_all = model_ids.is_empty();
    let provider_context = provider.clone();
    for model in &mut provider.models {
        if !reset_all && !model_ids.iter().any(|model_id| model_id == &model.model_id) {
            continue;
        }
        let candidate = crate::model_catalog::infer_single_model(
            &provider_context,
            model.clone(),
            catalog.clone(),
            true,
        );
        if candidate.unsupported_reason.is_none() {
            match fields.as_deref() {
                Some(fields) if !fields.is_empty() => {
                    apply_automatic_fields(model, &candidate.proposed_model, fields)
                }
                _ => *model = candidate.proposed_model,
            }
        }
    }
    aqbot_core::repo::provider::save_models_from_user_selection(
        &state.sea_db,
        &real_id,
        &provider.models,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(provider.models)
}

fn apply_automatic_fields(target: &mut Model, automatic: &Model, fields: &[String]) {
    let automatic_state = automatic.metadata_state.clone().unwrap_or_default();
    let target_state = target.metadata_state.get_or_insert_with(Default::default);
    target_state.schema_version = automatic_state.schema_version;
    target_state.catalog_key = automatic_state.catalog_key.clone();
    target_state.catalog_mode = automatic_state.catalog_mode.clone();
    for field in fields {
        match field.as_str() {
            "model_type" => {
                target.model_type = automatic.model_type.clone();
                target_state.model_type = automatic_state.model_type;
            }
            "capabilities" => {
                target.capabilities = automatic.capabilities.clone();
                target_state.capabilities = automatic_state.capabilities;
            }
            "context_window" => {
                target.context_window = automatic.context_window;
                target_state.context_window = automatic_state.context_window;
            }
            "max_output_tokens" => {
                target.max_output_tokens = automatic.max_output_tokens;
                target_state.max_output_tokens = automatic_state.max_output_tokens;
            }
            "no_system_role" => {
                target
                    .param_overrides
                    .get_or_insert_with(Default::default)
                    .no_system_role = automatic
                    .param_overrides
                    .as_ref()
                    .and_then(|params| params.no_system_role);
                target_state.no_system_role = automatic_state.no_system_role;
            }
            "omit_sampling_params" => {
                target
                    .param_overrides
                    .get_or_insert_with(Default::default)
                    .omit_sampling_params = automatic
                    .param_overrides
                    .as_ref()
                    .and_then(|params| params.omit_sampling_params);
                target_state.omit_sampling_params = automatic_state.omit_sampling_params;
            }
            "reasoning_options" => {
                target
                    .param_overrides
                    .get_or_insert_with(Default::default)
                    .reasoning_options = automatic
                    .param_overrides
                    .as_ref()
                    .and_then(|params| params.reasoning_options.clone());
                target_state.reasoning_options = automatic_state.reasoning_options;
            }
            _ => {}
        }
    }
}

fn mark_metadata_field_as_user(metadata: &mut ModelMetadataState, field: &str) {
    let source = ModelMetadataSource::User;
    match field {
        "model_type" => metadata.model_type = source,
        "capabilities" => metadata.capabilities = source,
        "context_window" => metadata.context_window = source,
        "max_output_tokens" => metadata.max_output_tokens = source,
        "no_system_role" => metadata.no_system_role = source,
        "omit_sampling_params" => metadata.omit_sampling_params = source,
        "reasoning_options" => metadata.reasoning_options = source,
        _ => {}
    }
}

fn mark_model_metadata_as_user(model: &mut Model, fields: &[String]) {
    if fields.is_empty() {
        return;
    }
    let metadata = model.metadata_state.get_or_insert_with(Default::default);
    for field in fields {
        mark_metadata_field_as_user(metadata, field);
    }
}

#[cfg(test)]
mod model_metadata_tests {
    use super::*;

    fn model() -> Model {
        Model {
            provider_id: "provider".into(),
            model_id: "model".into(),
            name: "Model".into(),
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

    #[test]
    fn request_only_edits_keep_legacy_metadata_protection() {
        let mut model = model();
        mark_model_metadata_as_user(&mut model, &[]);
        assert_eq!(model.metadata_state, None);
    }

    #[test]
    fn explicit_token_clears_are_persisted_as_user_metadata() {
        let mut model = model();
        mark_model_metadata_as_user(
            &mut model,
            &["context_window".into(), "max_output_tokens".into()],
        );
        let state = model.metadata_state.expect("metadata state");
        assert_eq!(state.context_window, ModelMetadataSource::User);
        assert_eq!(state.max_output_tokens, ModelMetadataSource::User);
    }

    #[test]
    fn single_field_reset_does_not_replace_other_user_metadata() {
        let mut target = model();
        target.capabilities.push(ModelCapability::Vision);
        target.metadata_state = Some(ModelMetadataState {
            capabilities: ModelMetadataSource::User,
            max_output_tokens: ModelMetadataSource::User,
            ..ModelMetadataState::default()
        });
        let mut automatic = model();
        automatic.max_output_tokens = Some(8_192);
        automatic.metadata_state = Some(ModelMetadataState {
            capabilities: ModelMetadataSource::Catalog,
            max_output_tokens: ModelMetadataSource::Catalog,
            ..ModelMetadataState::default()
        });

        apply_automatic_fields(&mut target, &automatic, &["max_output_tokens".into()]);

        assert_eq!(target.max_output_tokens, Some(8_192));
        assert!(target.capabilities.contains(&ModelCapability::Vision));
        let state = target.metadata_state.expect("metadata state");
        assert_eq!(state.max_output_tokens, ModelMetadataSource::Catalog);
        assert_eq!(state.capabilities, ModelMetadataSource::User);
    }

    #[test]
    fn metadata_fields_cannot_be_manual_and_automatic_together() {
        let model = model();
        let error = validate_metadata_field_updates(
            &model,
            &["context_window".into()],
            &["context_window".into()],
        )
        .expect_err("overlapping ownership must fail");
        assert!(error.contains("both manual and automatic"));
    }

    #[test]
    fn automatic_fields_require_a_non_user_source() {
        let mut model = model();
        model.metadata_state = Some(ModelMetadataState {
            context_window: ModelMetadataSource::User,
            ..ModelMetadataState::default()
        });
        assert!(validate_metadata_field_updates(&model, &[], &["context_window".into()],).is_err());

        model
            .metadata_state
            .as_mut()
            .expect("metadata")
            .context_window = ModelMetadataSource::Catalog;
        assert!(validate_metadata_field_updates(&model, &[], &["context_window".into()],).is_ok());
    }
}

/// Test a single model's availability by sending the minimal native request.
/// Returns latency in milliseconds on success.
#[tauri::command]
pub async fn test_model(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
) -> Result<u64, String> {
    let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &real_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row = aqbot_core::repo::provider::get_active_key(&state.sea_db, &real_id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;
    let registry = aqbot_providers::registry::ProviderRegistry::create_default();
    let provider_type_str = provider_registry_key(&provider.provider_type);
    let adapter = registry
        .get(provider_type_str)
        .ok_or_else(|| format!("No adapter for provider type: {}", provider_type_str))?;
    let global_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let resolved_proxy =
        aqbot_core::types::ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = aqbot_providers::ProviderRequestContext {
        api_key: decrypted,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(aqbot_providers::resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };
    let model_type = provider
        .models
        .iter()
        .find(|model| model.model_id == model_id)
        .map(|model| &model.model_type);
    let start = Instant::now();
    if model_type.is_some_and(|model_type| *model_type == ModelType::Rerank) {
        adapter
            .rerank(
                &ctx,
                RerankRequest {
                    model: model_id,
                    query: "test".into(),
                    documents: vec!["test".into()],
                    top_n: 1,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
    } else {
        let request = ChatRequest {
            model: model_id,
            messages: vec![ChatMessage {
                role: "user".into(),
                content: ChatContent::Text("hi".into()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: None,
            top_p: None,
            max_tokens: Some(1),
            tools: None,
            thinking_budget: None,
            thinking_level: None,
            reasoning_profile: None,
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        };
        adapter
            .chat(&ctx, request)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(start.elapsed().as_millis() as u64)
}

#[tauri::command]
pub async fn reorder_providers(
    state: State<'_, AppState>,
    provider_ids: Vec<String>,
) -> Result<(), String> {
    // Materialize any virtual built-in providers so sort_order can be persisted
    let mut real_ids = Vec::with_capacity(provider_ids.len());
    for id in &provider_ids {
        let real_id = aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, id)
            .await
            .map_err(|e| e.to_string())?;
        real_ids.push(real_id);
    }
    aqbot_core::repo::provider::reorder_providers(&state.sea_db, &real_ids)
        .await
        .map_err(|e| e.to_string())
}
