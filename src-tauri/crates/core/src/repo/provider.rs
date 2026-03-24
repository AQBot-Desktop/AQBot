use sea_orm::*;
use sea_orm::sea_query::Expr;

use crate::entity::{models, provider_keys, providers};
use crate::error::{AQBotError, Result};
use crate::types::*;
use crate::utils::{gen_id, now_ts};

fn parse_provider_type(s: &str) -> ProviderType {
    match s {
        "openai" => ProviderType::OpenAI,
        "anthropic" => ProviderType::Anthropic,
        "gemini" => ProviderType::Gemini,
        _ => ProviderType::Custom,
    }
}

fn provider_type_str(pt: &ProviderType) -> &'static str {
    match pt {
        ProviderType::OpenAI => "openai",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Custom => "custom",
    }
}

fn key_from_entity(m: provider_keys::Model) -> ProviderKey {
    ProviderKey {
        id: m.id,
        provider_id: m.provider_id,
        key_encrypted: m.key_encrypted,
        key_prefix: m.key_prefix,
        enabled: m.enabled != 0,
        last_validated_at: m.last_validated_at,
        last_error: m.last_error,
        rotation_index: m.rotation_index as u32,
        created_at: m.created_at,
    }
}

fn model_from_entity(m: models::Model) -> Model {
    Model {
        provider_id: m.provider_id,
        model_id: m.model_id,
        name: m.name,
        group_name: m.group_name,
        model_type: m.model_type.parse().unwrap_or_default(),
        capabilities: serde_json::from_str(&m.capabilities).unwrap_or_default(),
        max_tokens: m.max_tokens.map(|v| v as u32),
        enabled: m.enabled != 0,
        param_overrides: m
            .param_overrides
            .and_then(|s| serde_json::from_str(&s).ok()),
    }
}

fn provider_from_entity(
    row: providers::Model,
    keys: Vec<ProviderKey>,
    models: Vec<Model>,
) -> ProviderConfig {
    ProviderConfig {
        id: row.id,
        name: row.name,
        provider_type: parse_provider_type(&row.provider_type),
        api_host: row.api_host,
        api_path: row.api_path,
        enabled: row.enabled != 0,
        models,
        keys,
        proxy_config: row
            .proxy_config
            .and_then(|s| serde_json::from_str(&s).ok()),
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

// --- Provider CRUD ---

pub async fn list_providers(db: &DatabaseConnection) -> Result<Vec<ProviderConfig>> {
    let rows = providers::Entity::find()
        .order_by_asc(providers::Column::SortOrder)
        .order_by_desc(providers::Column::CreatedAt)
        .all(db)
        .await?;

    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row.id.clone();
        let keys = list_keys_for_provider(db, &id).await?;
        let models = list_models_for_provider(db, &id).await?;
        result.push(provider_from_entity(row, keys, models));
    }
    Ok(result)
}

pub async fn get_provider(db: &DatabaseConnection, id: &str) -> Result<ProviderConfig> {
    let row = providers::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Provider {}", id)))?;

    let keys = list_keys_for_provider(db, &row.id).await?;
    let models = list_models_for_provider(db, &row.id).await?;
    Ok(provider_from_entity(row, keys, models))
}

pub async fn create_provider(
    db: &DatabaseConnection,
    input: CreateProviderInput,
) -> Result<ProviderConfig> {
    let id = gen_id();
    let now = now_ts();

    providers::ActiveModel {
        id: Set(id.clone()),
        name: Set(input.name),
        provider_type: Set(provider_type_str(&input.provider_type).to_string()),
        api_host: Set(input.api_host),
        api_path: Set(input.api_path),
        enabled: Set(if input.enabled { 1 } else { 0 }),
        proxy_config: Set(None),
        sort_order: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(db)
    .await?;

    get_provider(db, &id).await
}

pub async fn update_provider(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateProviderInput,
) -> Result<ProviderConfig> {
    let existing = get_provider(db, id).await?;
    let now = now_ts();

    let name = input.name.unwrap_or(existing.name);
    let api_host = input.api_host.unwrap_or(existing.api_host);
    let enabled = input.enabled.unwrap_or(existing.enabled);
    let proxy_json = match input.proxy_config {
        Some(ref pc) => Some(serde_json::to_string(pc).unwrap()),
        None => existing
            .proxy_config
            .map(|pc| serde_json::to_string(&pc).unwrap()),
    };

    let row = providers::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Provider {}", id)))?;

    let mut am: providers::ActiveModel = row.into();
    am.name = Set(name);
    am.api_host = Set(api_host);
    am.enabled = Set(if enabled { 1 } else { 0 });
    am.proxy_config = Set(proxy_json);
    if let Some(api_path) = input.api_path {
        am.api_path = Set(api_path);
    }
    if let Some(sort_order) = input.sort_order {
        am.sort_order = Set(sort_order);
    }
    am.updated_at = Set(now);
    am.update(db).await?;

    get_provider(db, id).await
}

pub async fn delete_provider(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = providers::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("Provider {}", id)));
    }
    Ok(())
}

pub async fn toggle_provider(db: &DatabaseConnection, id: &str, enabled: bool) -> Result<()> {
    let row = providers::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Provider {}", id)))?;

    let mut am: providers::ActiveModel = row.into();
    am.enabled = Set(if enabled { 1 } else { 0 });
    am.updated_at = Set(now_ts());
    am.update(db).await?;

    Ok(())
}

// --- Provider Key CRUD ---

pub async fn reorder_providers(
    db: &DatabaseConnection,
    provider_ids: &[String],
) -> Result<()> {
    for (i, id) in provider_ids.iter().enumerate() {
        providers::Entity::update_many()
            .col_expr(providers::Column::SortOrder, Expr::value(i as i32))
            .col_expr(providers::Column::UpdatedAt, Expr::value(crate::utils::now_ts()))
            .filter(providers::Column::Id.eq(id))
            .exec(db)
            .await?;
    }
    Ok(())
}

// --- Provider Key CRUD (continued) ---

pub async fn list_keys_for_provider(db: &DatabaseConnection, provider_id: &str) -> Result<Vec<ProviderKey>> {
    let rows = provider_keys::Entity::find()
        .filter(provider_keys::Column::ProviderId.eq(provider_id))
        .order_by_asc(provider_keys::Column::RotationIndex)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(key_from_entity).collect())
}

pub async fn add_provider_key(
    db: &DatabaseConnection,
    provider_id: &str,
    key_encrypted: &str,
    key_prefix: &str,
) -> Result<ProviderKey> {
    let id = gen_id();
    let now = now_ts();

    let max_idx = provider_keys::Entity::find()
        .filter(provider_keys::Column::ProviderId.eq(provider_id))
        .select_only()
        .column_as(provider_keys::Column::RotationIndex.max(), "m")
        .into_tuple::<Option<i32>>()
        .one(db)
        .await?
        .flatten();
    let rotation_index = max_idx.unwrap_or(-1) + 1;

    provider_keys::ActiveModel {
        id: Set(id.clone()),
        provider_id: Set(provider_id.to_string()),
        key_encrypted: Set(key_encrypted.to_string()),
        key_prefix: Set(key_prefix.to_string()),
        enabled: Set(1),
        last_validated_at: Set(None),
        last_error: Set(None),
        rotation_index: Set(rotation_index),
        created_at: Set(now),
    }
    .insert(db)
    .await?;

    let row = provider_keys::Entity::find_by_id(&id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ProviderKey {}", id)))?;
    Ok(key_from_entity(row))
}

pub async fn delete_provider_key(db: &DatabaseConnection, key_id: &str) -> Result<()> {
    let result = provider_keys::Entity::delete_by_id(key_id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("ProviderKey {}", key_id)));
    }
    Ok(())
}

pub async fn toggle_provider_key(db: &DatabaseConnection, key_id: &str, enabled: bool) -> Result<()> {
    let row = provider_keys::Entity::find_by_id(key_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ProviderKey {}", key_id)))?;

    let mut am: provider_keys::ActiveModel = row.into();
    am.enabled = Set(if enabled { 1 } else { 0 });
    am.update(db).await?;

    Ok(())
}

pub async fn get_provider_key(db: &DatabaseConnection, key_id: &str) -> Result<ProviderKey> {
    let row = provider_keys::Entity::find_by_id(key_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ProviderKey {}", key_id)))?;
    Ok(key_from_entity(row))
}

pub async fn get_active_key(db: &DatabaseConnection, provider_id: &str) -> Result<ProviderKey> {
    let row = provider_keys::Entity::find()
        .filter(provider_keys::Column::ProviderId.eq(provider_id))
        .filter(provider_keys::Column::Enabled.eq(1))
        .order_by_asc(provider_keys::Column::RotationIndex)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("No active key for provider {}", provider_id)))?;
    Ok(key_from_entity(row))
}

pub async fn update_key_validation(db: &DatabaseConnection, key_id: &str, valid: bool) -> Result<()> {
    if let Some(row) = provider_keys::Entity::find_by_id(key_id).one(db).await? {
        let error = if valid { None } else { Some("Validation failed".to_string()) };
        let mut am: provider_keys::ActiveModel = row.into();
        am.last_validated_at = Set(Some(now_ts()));
        am.last_error = Set(error);
        am.update(db).await?;
    }
    Ok(())
}

pub async fn get_enabled_keys(db: &DatabaseConnection, provider_id: &str) -> Result<Vec<ProviderKey>> {
    let rows = provider_keys::Entity::find()
        .filter(provider_keys::Column::ProviderId.eq(provider_id))
        .filter(provider_keys::Column::Enabled.eq(1))
        .order_by_asc(provider_keys::Column::RotationIndex)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(key_from_entity).collect())
}

pub async fn update_rotation_index(db: &DatabaseConnection, key_id: &str, index: u32) -> Result<()> {
    if let Some(row) = provider_keys::Entity::find_by_id(key_id).one(db).await? {
        let mut am: provider_keys::ActiveModel = row.into();
        am.rotation_index = Set(index as i32);
        am.update(db).await?;
    }
    Ok(())
}

// --- Model CRUD ---

pub async fn list_models_for_provider(
    db: &DatabaseConnection,
    provider_id: &str,
) -> Result<Vec<Model>> {
    let rows = models::Entity::find()
        .filter(models::Column::ProviderId.eq(provider_id))
        .order_by_asc(models::Column::Name)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(model_from_entity).collect())
}

pub async fn get_model(
    db: &DatabaseConnection,
    provider_id: &str,
    model_id: &str,
) -> Result<Model> {
    let row = models::Entity::find_by_id((provider_id.to_string(), model_id.to_string()))
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Model {}/{}", provider_id, model_id)))?;

    Ok(model_from_entity(row))
}

pub async fn save_models(
    db: &DatabaseConnection,
    provider_id: &str,
    input_models: &[Model],
) -> Result<()> {
    let provider_id = provider_id.to_string();
    let input_models = input_models.to_vec();

    db.transaction::<_, _, sea_orm::DbErr>(|txn| {
        Box::pin(async move {
            models::Entity::delete_many()
                .filter(models::Column::ProviderId.eq(&provider_id))
                .exec(txn)
                .await?;

            for model in &input_models {
                let capabilities = serde_json::to_string(&model.capabilities)
                    .unwrap_or_else(|_| "[]".to_string());
                let param_overrides = model
                    .param_overrides
                    .as_ref()
                    .map(|po| serde_json::to_string(po).unwrap_or_else(|_| "null".to_string()));

                models::ActiveModel {
                    provider_id: Set(provider_id.clone()),
                    model_id: Set(model.model_id.clone()),
                    name: Set(model.name.clone()),
                    group_name: Set(model.group_name.clone()),
                    model_type: Set(model.model_type.to_string()),
                    capabilities: Set(capabilities),
                    max_tokens: Set(model.max_tokens.map(|v| v as i64)),
                    enabled: Set(if model.enabled { 1 } else { 0 }),
                    param_overrides: Set(param_overrides),
                }
                .insert(txn)
                .await?;
            }

            Ok(())
        })
    })
    .await?;

    Ok(())
}

pub async fn toggle_model(
    db: &DatabaseConnection,
    provider_id: &str,
    model_id: &str,
    enabled: bool,
) -> Result<Model> {
    let row = models::Entity::find_by_id((provider_id.to_string(), model_id.to_string()))
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Model {}/{}", provider_id, model_id)))?;

    let mut am: models::ActiveModel = row.into();
    am.enabled = Set(if enabled { 1 } else { 0 });
    am.update(db).await?;

    get_model(db, provider_id, model_id).await
}

pub async fn update_model_params(
    db: &DatabaseConnection,
    provider_id: &str,
    model_id: &str,
    overrides: ModelParamOverrides,
) -> Result<Model> {
    let param_json = serde_json::to_string(&overrides).unwrap();

    let row = models::Entity::find_by_id((provider_id.to_string(), model_id.to_string()))
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Model {}/{}", provider_id, model_id)))?;

    let mut am: models::ActiveModel = row.into();
    am.param_overrides = Set(Some(param_json));
    am.update(db).await?;

    get_model(db, provider_id, model_id).await
}
