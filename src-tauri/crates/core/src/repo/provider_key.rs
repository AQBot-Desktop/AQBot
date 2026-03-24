use sea_orm::*;

use crate::entity::provider_keys;
use crate::error::{AQBotError, Result};
use crate::types::ProviderKey;
use crate::utils::{gen_id, now_ts};

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

/// Toggles enabled state (NOT enabled). Different from provider.rs which takes an explicit bool.
pub async fn toggle_provider_key(db: &DatabaseConnection, key_id: &str) -> Result<ProviderKey> {
    let row = provider_keys::Entity::find_by_id(key_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ProviderKey {}", key_id)))?;

    let new_enabled = if row.enabled != 0 { 0 } else { 1 };
    let mut am: provider_keys::ActiveModel = row.into();
    am.enabled = Set(new_enabled);
    am.update(db).await?;

    let row = provider_keys::Entity::find_by_id(key_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ProviderKey {}", key_id)))?;
    Ok(key_from_entity(row))
}

/// Takes an optional error message. Different from provider.rs which takes a bool.
pub async fn update_key_validation(
    db: &DatabaseConnection,
    key_id: &str,
    error: Option<&str>,
) -> Result<()> {
    if let Some(row) = provider_keys::Entity::find_by_id(key_id).one(db).await? {
        let mut am: provider_keys::ActiveModel = row.into();
        am.last_validated_at = Set(Some(now_ts()));
        am.last_error = Set(error.map(|s| s.to_string()));
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
