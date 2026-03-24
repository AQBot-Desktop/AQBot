use sea_orm::*;

use crate::entity::search_providers;
use crate::error::{AQBotError, Result};
use crate::types::{CreateSearchProviderInput, SearchProvider};
use crate::utils::gen_id;

fn model_to_search_provider(m: search_providers::Model) -> SearchProvider {
    SearchProvider {
        id: m.id,
        name: m.name,
        provider_type: m.provider_type,
        endpoint: m.endpoint,
        has_api_key: m.api_key_ref.as_ref().map_or(false, |k| !k.is_empty()),
        enabled: m.enabled != 0,
        region: m.region,
        language: m.language,
        safe_search: m.safe_search.map(|v| v != 0),
        result_limit: m.result_limit,
        timeout_ms: m.timeout_ms,
    }
}

pub async fn list_search_providers(db: &DatabaseConnection) -> Result<Vec<SearchProvider>> {
    let rows = search_providers::Entity::find()
        .order_by_asc(search_providers::Column::Name)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(model_to_search_provider).collect())
}

pub async fn get_search_provider(
    db: &DatabaseConnection,
    id: &str,
) -> Result<SearchProvider> {
    let model = search_providers::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("SearchProvider {}", id)))?;

    Ok(model_to_search_provider(model))
}

pub async fn create_search_provider(
    db: &DatabaseConnection,
    input: CreateSearchProviderInput,
) -> Result<SearchProvider> {
    let id = gen_id();

    search_providers::ActiveModel {
        id: Set(id.clone()),
        name: Set(input.name),
        provider_type: Set(input.provider_type),
        endpoint: Set(input.endpoint),
        api_key_ref: Set(input.api_key),
        enabled: Set(if input.enabled.unwrap_or(true) { 1 } else { 0 }),
        region: Set(input.region),
        language: Set(input.language),
        safe_search: Set(input.safe_search.map(|b| if b { 1i64 } else { 0 })),
        result_limit: Set(input.result_limit.unwrap_or(10)),
        timeout_ms: Set(input.timeout_ms.unwrap_or(5000)),
    }
    .insert(db)
    .await?;

    get_search_provider(db, &id).await
}

pub async fn update_search_provider(
    db: &DatabaseConnection,
    id: &str,
    input: CreateSearchProviderInput,
) -> Result<SearchProvider> {
    let model = search_providers::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("SearchProvider {}", id)))?;

    let name = if input.name.is_empty() { model.name.clone() } else { input.name };
    let provider_type = if input.provider_type.is_empty() {
        model.provider_type.clone()
    } else {
        input.provider_type
    };
    let endpoint = input.endpoint.or(model.endpoint.clone());
    let api_key_ref = input.api_key.or(model.api_key_ref.clone());
    let enabled = input.enabled.unwrap_or(model.enabled != 0);
    let region = input.region.or(model.region.clone());
    let language = input.language.or(model.language.clone());
    let safe_search = input.safe_search.or(model.safe_search.map(|v| v != 0));
    let result_limit = input.result_limit.unwrap_or(model.result_limit);
    let timeout_ms = input.timeout_ms.unwrap_or(model.timeout_ms);

    let mut am: search_providers::ActiveModel = model.into();
    am.name = Set(name);
    am.provider_type = Set(provider_type);
    am.endpoint = Set(endpoint);
    am.api_key_ref = Set(api_key_ref);
    am.enabled = Set(if enabled { 1 } else { 0 });
    am.region = Set(region);
    am.language = Set(language);
    am.safe_search = Set(safe_search.map(|b| if b { 1i64 } else { 0 }));
    am.result_limit = Set(result_limit);
    am.timeout_ms = Set(timeout_ms);
    am.update(db).await?;

    get_search_provider(db, id).await
}

pub async fn delete_search_provider(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = search_providers::Entity::delete_by_id(id)
        .exec(db)
        .await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("SearchProvider {}", id)));
    }
    Ok(())
}
