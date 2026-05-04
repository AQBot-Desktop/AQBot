use sea_orm::sea_query::Expr;
use sea_orm::*;
use std::collections::HashSet;

use crate::crypto::{decrypt_key, encrypt_key};
use crate::entity::{models, provider_keys, providers};
use crate::error::{AQBotError, Result};
use crate::types::*;
use crate::utils::{gen_id, now_ts};

fn parse_provider_type(s: &str) -> ProviderType {
    match s {
        "openai" => ProviderType::OpenAI,
        "openai_responses" => ProviderType::OpenAIResponses,
        "deepseek" => ProviderType::DeepSeek,
        "xai" => ProviderType::XAI,
        "glm" => ProviderType::GLM,
        "siliconflow" => ProviderType::SiliconFlow,
        "anthropic" => ProviderType::Anthropic,
        "gemini" => ProviderType::Gemini,
        "jina" => ProviderType::Jina,
        "cohere" => ProviderType::Cohere,
        "voyage" => ProviderType::Voyage,
        _ => ProviderType::Custom,
    }
}

fn provider_type_str(pt: &ProviderType) -> &'static str {
    match pt {
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
        proxy_config: row.proxy_config.and_then(|s| serde_json::from_str(&s).ok()),
        custom_headers: row.custom_headers,
        icon: row.icon,
        builtin_id: row.builtin_id,
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
        custom_headers: Set(None),
        icon: Set(None),
        builtin_id: Set(input.builtin_id),
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
    let provider_type = input.provider_type.unwrap_or(existing.provider_type);
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
    am.provider_type = Set(provider_type_str(&provider_type).to_string());
    am.enabled = Set(if enabled { 1 } else { 0 });
    am.proxy_config = Set(proxy_json);
    if let Some(api_path) = input.api_path {
        am.api_path = Set(api_path);
    }
    if let Some(sort_order) = input.sort_order {
        am.sort_order = Set(sort_order);
    }
    if let Some(custom_headers) = input.custom_headers {
        am.custom_headers = Set(custom_headers);
    }
    if let Some(icon) = input.icon {
        am.icon = Set(icon);
    }
    am.updated_at = Set(now);
    am.update(db).await?;

    get_provider(db, id).await
}

fn parse_deep_link_provider_type(value: &str) -> Result<ProviderType> {
    match value.trim() {
        "openai" => Ok(ProviderType::OpenAI),
        "openai_responses" => Ok(ProviderType::OpenAIResponses),
        "deepseek" => Ok(ProviderType::DeepSeek),
        "xai" => Ok(ProviderType::XAI),
        "glm" => Ok(ProviderType::GLM),
        "siliconflow" => Ok(ProviderType::SiliconFlow),
        "anthropic" => Ok(ProviderType::Anthropic),
        "gemini" => Ok(ProviderType::Gemini),
        "jina" => Ok(ProviderType::Jina),
        "cohere" => Ok(ProviderType::Cohere),
        "voyage" => Ok(ProviderType::Voyage),
        "custom" => Ok(ProviderType::Custom),
        other => Err(AQBotError::Validation(format!(
            "Unsupported provider type: {other}"
        ))),
    }
}

fn normalize_deep_link_baseurl(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AQBotError::Validation("Base URL is required".into()));
    }

    let forced = trimmed.ends_with('!');
    let without_force = if forced {
        trimmed.trim_end_matches('!').trim_end_matches('/')
    } else {
        trimmed.trim_end_matches('/')
    };

    let parsed = reqwest::Url::parse(without_force)
        .map_err(|_| AQBotError::Validation("Base URL must be a valid URL".into()))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => {
            return Err(AQBotError::Validation(
                "Base URL must use http or https".into(),
            ));
        }
    }
    if parsed.host_str().is_none() {
        return Err(AQBotError::Validation("Base URL host is required".into()));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AQBotError::Validation(
            "Base URL must not contain query or fragment".into(),
        ));
    }

    if forced {
        Ok(format!("{without_force}!"))
    } else {
        Ok(without_force.to_string())
    }
}

fn find_matching_provider(
    providers: &[ProviderConfig],
    baseurl: &str,
    provider_type: &ProviderType,
) -> Option<ProviderConfig> {
    providers
        .iter()
        .find(|provider| {
            provider.provider_type == *provider_type
                && normalize_deep_link_baseurl(&provider.api_host)
                    .ok()
                    .as_deref()
                    == Some(baseurl)
        })
        .cloned()
}

fn key_prefix(raw_key: &str) -> String {
    if raw_key.len() >= 8 {
        format!("{}...", &raw_key[..8])
    } else {
        raw_key.to_string()
    }
}

pub async fn import_provider_from_deep_link(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    input: DeepLinkProviderImportInput,
) -> Result<DeepLinkProviderImportResult> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AQBotError::Validation("Provider name is required".into()));
    }

    let raw_key = input.apikey.trim();
    if raw_key.is_empty() {
        return Err(AQBotError::Validation("API key is required".into()));
    }

    let provider_type = parse_deep_link_provider_type(&input.provider_type)?;
    let baseurl = normalize_deep_link_baseurl(&input.baseurl)?;
    let providers = list_providers(db).await?;
    let (provider, created_provider) =
        if let Some(provider) = find_matching_provider(&providers, &baseurl, &provider_type) {
            (provider, false)
        } else {
            (
                create_provider(
                    db,
                    CreateProviderInput {
                        name: name.to_string(),
                        provider_type,
                        api_host: baseurl,
                        api_path: None,
                        enabled: true,
                        builtin_id: None,
                    },
                )
                .await?,
                true,
            )
        };

    let key_exists = provider.keys.iter().any(|key| {
        decrypt_key(&key.key_encrypted, master_key)
            .map(|decrypted| decrypted == raw_key)
            .unwrap_or(false)
    });

    if key_exists {
        return Ok(DeepLinkProviderImportResult {
            provider_id: provider.id,
            provider_name: provider.name,
            created_provider,
            added_key: false,
            reused_key: true,
        });
    }

    let encrypted = encrypt_key(raw_key, master_key)?;
    add_provider_key(db, &provider.id, &encrypted, &key_prefix(raw_key)).await?;

    Ok(DeepLinkProviderImportResult {
        provider_id: provider.id,
        provider_name: provider.name,
        created_provider,
        added_key: true,
        reused_key: false,
    })
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

pub async fn reorder_providers(db: &DatabaseConnection, provider_ids: &[String]) -> Result<()> {
    for (i, id) in provider_ids.iter().enumerate() {
        providers::Entity::update_many()
            .col_expr(providers::Column::SortOrder, Expr::value(i as i32))
            .col_expr(
                providers::Column::UpdatedAt,
                Expr::value(crate::utils::now_ts()),
            )
            .filter(providers::Column::Id.eq(id))
            .exec(db)
            .await?;
    }
    Ok(())
}

// --- Provider Key CRUD (continued) ---

pub async fn list_keys_for_provider(
    db: &DatabaseConnection,
    provider_id: &str,
) -> Result<Vec<ProviderKey>> {
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

pub async fn update_provider_key(
    db: &DatabaseConnection,
    key_id: &str,
    key_encrypted: &str,
    key_prefix: &str,
) -> Result<ProviderKey> {
    let row = provider_keys::Entity::find_by_id(key_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ProviderKey {}", key_id)))?;

    let mut am: provider_keys::ActiveModel = row.into();
    am.key_encrypted = Set(key_encrypted.to_string());
    am.key_prefix = Set(key_prefix.to_string());
    am.last_validated_at = Set(None);
    am.last_error = Set(None);
    am.update(db).await?;

    get_provider_key(db, key_id).await
}

pub async fn delete_provider_key(db: &DatabaseConnection, key_id: &str) -> Result<()> {
    let result = provider_keys::Entity::delete_by_id(key_id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("ProviderKey {}", key_id)));
    }
    Ok(())
}

pub async fn toggle_provider_key(
    db: &DatabaseConnection,
    key_id: &str,
    enabled: bool,
) -> Result<()> {
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
        .ok_or_else(|| {
            AQBotError::NotFound(format!("No active key for provider {}", provider_id))
        })?;
    Ok(key_from_entity(row))
}

pub async fn update_key_validation(
    db: &DatabaseConnection,
    key_id: &str,
    valid: bool,
) -> Result<()> {
    if let Some(row) = provider_keys::Entity::find_by_id(key_id).one(db).await? {
        let error = if valid {
            None
        } else {
            Some("Validation failed".to_string())
        };
        let mut am: provider_keys::ActiveModel = row.into();
        am.last_validated_at = Set(Some(now_ts()));
        am.last_error = Set(error);
        am.update(db).await?;
    }
    Ok(())
}

pub async fn get_enabled_keys(
    db: &DatabaseConnection,
    provider_id: &str,
) -> Result<Vec<ProviderKey>> {
    let rows = provider_keys::Entity::find()
        .filter(provider_keys::Column::ProviderId.eq(provider_id))
        .filter(provider_keys::Column::Enabled.eq(1))
        .order_by_asc(provider_keys::Column::RotationIndex)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(key_from_entity).collect())
}

pub async fn update_rotation_index(
    db: &DatabaseConnection,
    key_id: &str,
    index: u32,
) -> Result<()> {
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
                let capabilities =
                    serde_json::to_string(&model.capabilities).unwrap_or_else(|_| "[]".to_string());
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

// --- Built-in Provider Merge ---

async fn sync_missing_builtin_models(
    db: &DatabaseConnection,
    builtins: &[crate::db::BuiltinProvider],
    providers: &[ProviderConfig],
) -> Result<bool> {
    let mut changed = false;

    for bp in builtins {
        let Some(provider) = providers
            .iter()
            .find(|provider| provider.builtin_id.as_deref() == Some(bp.builtin_id))
        else {
            continue;
        };

        let existing_ids: HashSet<&str> = provider
            .models
            .iter()
            .map(|model| model.model_id.as_str())
            .collect();
        let missing_models: Vec<Model> = bp
            .models
            .iter()
            .filter(|model| !existing_ids.contains(model.model_id))
            .map(|model| model.to_model(&provider.id))
            .collect();

        if !missing_models.is_empty() {
            let mut models = provider.models.clone();
            models.extend(missing_models);
            save_models(db, &provider.id, &models).await?;
            changed = true;
        }

        if bp.builtin_id == "minimax" && provider.api_host == "https://api.minimaxi.com" {
            update_provider(
                db,
                &provider.id,
                UpdateProviderInput {
                    api_host: Some(bp.api_host.to_string()),
                    ..Default::default()
                },
            )
            .await?;
            changed = true;
        }
    }

    Ok(changed)
}

/// Merge built-in provider definitions with database records.
/// Built-in providers without a DB row appear as virtual providers (enabled=false, no keys/models).
/// Built-in providers with a DB row use the DB values (user overrides).
/// Custom providers (builtin_id=NULL) are appended after built-ins.
pub async fn list_providers_merged(db: &DatabaseConnection) -> Result<Vec<ProviderConfig>> {
    let mut db_providers = list_providers(db).await?;
    let builtins = crate::db::get_builtin_providers();
    if sync_missing_builtin_models(db, &builtins, &db_providers).await? {
        db_providers = list_providers(db).await?;
    }

    let mut result = Vec::new();

    for bp in &builtins {
        if let Some(db_prov) = db_providers
            .iter()
            .find(|p| p.builtin_id.as_deref() == Some(bp.builtin_id))
        {
            result.push(db_prov.clone());
        } else {
            let now = now_ts();
            let default_models: Vec<Model> = bp
                .models
                .iter()
                .map(|model| model.to_model(&format!("builtin_{}", bp.builtin_id)))
                .collect();

            result.push(ProviderConfig {
                id: format!("builtin_{}", bp.builtin_id),
                name: String::from(bp.name),
                provider_type: bp.provider_type.clone(),
                api_host: String::from(bp.api_host),
                api_path: None,
                enabled: false,
                models: default_models,
                keys: vec![],
                proxy_config: None,
                custom_headers: None,
                icon: None,
                builtin_id: Some(String::from(bp.builtin_id)),
                sort_order: 0,
                created_at: now,
                updated_at: now,
            });
        }
    }

    // Append custom providers (no builtin_id)
    for p in &db_providers {
        if p.builtin_id.is_none() {
            result.push(p.clone());
        }
    }

    // Sort: enabled first (by sort_order), then disabled (by sort_order)
    result.sort_by(|a, b| {
        b.enabled
            .cmp(&a.enabled)
            .then(a.sort_order.cmp(&b.sort_order))
    });

    Ok(result)
}

/// Materialize a virtual built-in provider into the database.
/// Called when a user first modifies a built-in provider that has no DB record.
/// Returns the new real provider ID.
pub async fn ensure_builtin_provider(db: &DatabaseConnection, builtin_id: &str) -> Result<String> {
    let existing = providers::Entity::find()
        .filter(providers::Column::BuiltinId.eq(builtin_id))
        .one(db)
        .await?;

    if let Some(row) = existing {
        return Ok(row.id);
    }

    let builtins = crate::db::get_builtin_providers();
    let bp = builtins
        .iter()
        .find(|b| b.builtin_id == builtin_id)
        .ok_or_else(|| AQBotError::NotFound(format!("Built-in provider {}", builtin_id)))?;

    let prov = create_provider(
        db,
        CreateProviderInput {
            name: String::from(bp.name),
            provider_type: bp.provider_type.clone(),
            api_host: String::from(bp.api_host),
            api_path: None,
            enabled: false,
            builtin_id: Some(String::from(builtin_id)),
        },
    )
    .await?;

    let models: Vec<Model> = bp
        .models
        .iter()
        .map(|model| model.to_model(&prov.id))
        .collect();

    save_models(db, &prov.id, &models).await?;

    Ok(prov.id)
}

/// Resolve a provider ID that might be a virtual builtin ID (e.g., "builtin_openai").
/// If virtual, materializes the provider into DB and returns the real ID.
/// If already a real ID, returns it unchanged.
pub async fn resolve_provider_id(db: &DatabaseConnection, id: &str) -> Result<String> {
    if let Some(builtin_id) = id.strip_prefix("builtin_") {
        ensure_builtin_provider(db, builtin_id).await
    } else {
        Ok(id.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::decrypt_key;
    use crate::db::create_test_pool;

    #[tokio::test]
    async fn provider_key_update_rewrites_encrypted_value_and_prefix() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;

        let provider = create_provider(
            db,
            CreateProviderInput {
                name: "Test".into(),
                provider_type: ProviderType::Custom,
                api_host: "https://example.com".into(),
                api_path: None,
                enabled: true,
                builtin_id: None,
            },
        )
        .await
        .unwrap();

        let key = add_provider_key(db, &provider.id, "enc_old_key", "sk-old")
            .await
            .unwrap();

        let updated = update_provider_key(db, &key.id, "enc_new_key", "sk-new")
            .await
            .unwrap();
        assert_eq!(updated.id, key.id);
        assert_eq!(updated.provider_id, provider.id);
        assert_eq!(updated.key_encrypted, "enc_new_key");
        assert_eq!(updated.key_prefix, "sk-new");
        assert_eq!(updated.rotation_index, key.rotation_index);
        assert_eq!(updated.created_at, key.created_at);
        assert_eq!(updated.last_validated_at, None);
        assert_eq!(updated.last_error, None);

        let fetched = get_provider_key(db, &key.id).await.unwrap();
        assert_eq!(fetched.key_encrypted, "enc_new_key");
        assert_eq!(fetched.key_prefix, "sk-new");
    }

    #[tokio::test]
    async fn merged_builtins_restore_missing_current_models() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;

        let provider = create_provider(
            db,
            CreateProviderInput {
                name: "MiniMax".into(),
                provider_type: ProviderType::OpenAI,
                api_host: "https://api.minimaxi.com".into(),
                api_path: None,
                enabled: true,
                builtin_id: Some("minimax".into()),
            },
        )
        .await
        .unwrap();
        save_models(
            db,
            &provider.id,
            &[Model {
                provider_id: provider.id.clone(),
                model_id: "MiniMax-M1".into(),
                name: "MiniMax-M1".into(),
                group_name: None,
                model_type: ModelType::Chat,
                capabilities: vec![ModelCapability::TextChat],
                max_tokens: Some(1_000_000),
                enabled: true,
                param_overrides: None,
            }],
        )
        .await
        .unwrap();

        let providers = list_providers_merged(db).await.unwrap();
        let minimax = providers
            .iter()
            .find(|provider| provider.builtin_id.as_deref() == Some("minimax"))
            .expect("minimax provider");

        assert_eq!(minimax.api_host, "https://api.minimax.io");
        assert!(minimax
            .models
            .iter()
            .any(|model| model.model_id == "MiniMax-M2.7"));

        let m2 = get_model(db, &provider.id, "MiniMax-M2.7")
            .await
            .expect("persisted MiniMax-M2.7");
        assert_eq!(
            m2.param_overrides
                .as_ref()
                .and_then(|params| params.use_max_completion_tokens),
            Some(true)
        );
    }

    #[tokio::test]
    async fn provider_deep_link_import_creates_provider_and_key() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let master_key = [7u8; 32];

        let result = import_provider_from_deep_link(
            db,
            &master_key,
            DeepLinkProviderImportInput {
                name: "Example AI".into(),
                baseurl: "https://api.example.com/".into(),
                apikey: "sk-example".into(),
                provider_type: "openai".into(),
            },
        )
        .await
        .unwrap();

        assert!(result.created_provider);
        assert!(result.added_key);
        assert!(!result.reused_key);

        let provider = get_provider(db, &result.provider_id).await.unwrap();
        assert_eq!(provider.name, "Example AI");
        assert_eq!(provider.provider_type, ProviderType::OpenAI);
        assert_eq!(provider.api_host, "https://api.example.com");
        assert_eq!(provider.api_path, None);
        assert!(provider.enabled);
        assert_eq!(provider.keys.len(), 1);
        assert_eq!(
            decrypt_key(&provider.keys[0].key_encrypted, &master_key).unwrap(),
            "sk-example"
        );
    }

    #[tokio::test]
    async fn provider_deep_link_import_accepts_builtin_openai_compatible_types() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let master_key = [11u8; 32];

        for (provider_type, expected) in [
            ("deepseek", ProviderType::DeepSeek),
            ("xai", ProviderType::XAI),
            ("glm", ProviderType::GLM),
            ("siliconflow", ProviderType::SiliconFlow),
        ] {
            let result = import_provider_from_deep_link(
                db,
                &master_key,
                DeepLinkProviderImportInput {
                    name: format!("{provider_type} provider"),
                    baseurl: format!("https://{provider_type}.example.com"),
                    apikey: format!("sk-{provider_type}"),
                    provider_type: provider_type.into(),
                },
            )
            .await
            .unwrap();

            let provider = get_provider(db, &result.provider_id).await.unwrap();
            assert_eq!(provider.provider_type, expected);
        }
    }

    #[tokio::test]
    async fn provider_deep_link_import_reuses_existing_provider_and_key() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let master_key = [8u8; 32];

        let first = import_provider_from_deep_link(
            db,
            &master_key,
            DeepLinkProviderImportInput {
                name: "First Name".into(),
                baseurl: "https://api.example.com!".into(),
                apikey: "sk-existing".into(),
                provider_type: "custom".into(),
            },
        )
        .await
        .unwrap();

        let second = import_provider_from_deep_link(
            db,
            &master_key,
            DeepLinkProviderImportInput {
                name: "Changed Name".into(),
                baseurl: "https://api.example.com/!".into(),
                apikey: "sk-existing".into(),
                provider_type: "custom".into(),
            },
        )
        .await
        .unwrap();

        assert_eq!(second.provider_id, first.provider_id);
        assert!(!second.created_provider);
        assert!(!second.added_key);
        assert!(second.reused_key);

        let provider = get_provider(db, &second.provider_id).await.unwrap();
        assert_eq!(provider.name, "First Name");
        assert_eq!(provider.keys.len(), 1);
    }

    #[tokio::test]
    async fn provider_deep_link_import_reuses_provider_and_adds_new_key() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let master_key = [10u8; 32];

        let first = import_provider_from_deep_link(
            db,
            &master_key,
            DeepLinkProviderImportInput {
                name: "First Name".into(),
                baseurl: "https://api.example.com".into(),
                apikey: "sk-first".into(),
                provider_type: "openai".into(),
            },
        )
        .await
        .unwrap();

        let second = import_provider_from_deep_link(
            db,
            &master_key,
            DeepLinkProviderImportInput {
                name: "Changed Name".into(),
                baseurl: "https://api.example.com/".into(),
                apikey: "sk-second".into(),
                provider_type: "openai".into(),
            },
        )
        .await
        .unwrap();

        assert_eq!(second.provider_id, first.provider_id);
        assert!(!second.created_provider);
        assert!(second.added_key);
        assert!(!second.reused_key);

        let provider = get_provider(db, &second.provider_id).await.unwrap();
        assert_eq!(provider.name, "First Name");
        assert_eq!(provider.keys.len(), 2);
    }

    #[tokio::test]
    async fn provider_deep_link_import_rejects_invalid_input() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let master_key = [9u8; 32];

        let cases = [
            ("", "https://api.example.com", "sk-example", "openai"),
            ("Example", "ftp://api.example.com", "sk-example", "openai"),
            (
                "Example",
                "https://api.example.com?x=1",
                "sk-example",
                "openai",
            ),
            ("Example", "https://api.example.com", "", "openai"),
            (
                "Example",
                "https://api.example.com",
                "sk-example",
                "unknown",
            ),
        ];

        for (name, baseurl, apikey, provider_type) in cases {
            let error = import_provider_from_deep_link(
                db,
                &master_key,
                DeepLinkProviderImportInput {
                    name: name.into(),
                    baseurl: baseurl.into(),
                    apikey: apikey.into(),
                    provider_type: provider_type.into(),
                },
            )
            .await
            .expect_err("invalid input should fail");

            assert!(matches!(error, AQBotError::Validation(_)));
        }
    }
}
