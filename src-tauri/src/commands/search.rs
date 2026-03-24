use crate::AppState;
use aqbot_core::entity::search_providers;
use aqbot_core::search::{self, SearchResponse, TestResult};
use aqbot_core::types::*;
use sea_orm::EntityTrait;
use tauri::State;

#[tauri::command]
pub async fn list_search_providers(state: State<'_, AppState>) -> Result<Vec<SearchProvider>, String> {
    aqbot_core::repo::search_provider::list_search_providers(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_search_provider(
    state: State<'_, AppState>,
    mut input: CreateSearchProviderInput,
) -> Result<SearchProvider, String> {
    if let Some(ref raw_key) = input.api_key {
        if !raw_key.is_empty() {
            let encrypted =
                aqbot_core::crypto::encrypt_key(raw_key, &state.master_key).map_err(|e| e.to_string())?;
            input.api_key = Some(encrypted);
        }
    }
    aqbot_core::repo::search_provider::create_search_provider(&state.sea_db, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_search_provider(
    state: State<'_, AppState>,
    id: String,
    mut input: CreateSearchProviderInput,
) -> Result<SearchProvider, String> {
    if let Some(ref raw_key) = input.api_key {
        if !raw_key.is_empty() {
            let encrypted =
                aqbot_core::crypto::encrypt_key(raw_key, &state.master_key).map_err(|e| e.to_string())?;
            input.api_key = Some(encrypted);
        }
    }
    aqbot_core::repo::search_provider::update_search_provider(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_search_provider(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    aqbot_core::repo::search_provider::delete_search_provider(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch the raw DB model and decrypt its API key
async fn get_provider_with_key(
    state: &AppState,
    id: &str,
) -> Result<(search_providers::Model, String), String> {
    let model = search_providers::Entity::find_by_id(id)
        .one(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("SearchProvider {} not found", id))?;

    let api_key = match &model.api_key_ref {
        Some(encrypted) if !encrypted.is_empty() => {
            aqbot_core::crypto::decrypt_key(encrypted, &state.master_key)
                .map_err(|e| e.to_string())?
        }
        _ => String::new(),
    };

    Ok((model, api_key))
}

#[tauri::command]
pub async fn test_search_provider(
    state: State<'_, AppState>,
    id: String,
) -> Result<TestResult, String> {
    let (model, api_key) = get_provider_with_key(&state, &id).await?;

    Ok(search::test_provider(
        &model.provider_type,
        model.endpoint.as_deref(),
        &api_key,
        model.timeout_ms,
    )
    .await)
}

#[tauri::command]
pub async fn execute_search(
    state: State<'_, AppState>,
    provider_id: String,
    query: String,
    max_results: Option<i32>,
) -> Result<SearchResponse, String> {
    let (model, api_key) = get_provider_with_key(&state, &provider_id).await?;

    search::execute_search(
        &model.provider_type,
        model.endpoint.as_deref(),
        &api_key,
        &query,
        max_results.unwrap_or(model.result_limit),
        model.timeout_ms,
    )
    .await
    .map_err(|e| e.to_string())
}
