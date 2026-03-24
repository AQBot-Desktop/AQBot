use sea_orm::*;

use crate::crypto;
use crate::entity::gateway_keys;
use crate::error::{AQBotError, Result};
use crate::types::{CreateGatewayKeyResult, GatewayKey};
use crate::utils::{gen_id, now_ts};

fn key_from_entity(m: gateway_keys::Model) -> GatewayKey {
    GatewayKey {
        id: m.id,
        name: m.name,
        key_hash: m.key_hash,
        key_prefix: m.key_prefix,
        enabled: m.enabled != 0,
        created_at: m.created_at,
        last_used_at: m.last_used_at,
        has_encrypted_key: m.encrypted_key.is_some(),
    }
}

pub async fn list_gateway_keys(db: &DatabaseConnection) -> Result<Vec<GatewayKey>> {
    let rows = gateway_keys::Entity::find()
        .order_by_desc(gateway_keys::Column::CreatedAt)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(key_from_entity).collect())
}

pub async fn create_gateway_key(
    db: &DatabaseConnection,
    name: &str,
    master_key: Option<&[u8; 32]>,
) -> Result<CreateGatewayKeyResult> {
    let id = gen_id();
    let now = now_ts();
    let plain_key = crypto::generate_gateway_key();
    let key_hash = crypto::sha256_hash(&plain_key);
    let key_prefix = crypto::key_prefix(&plain_key);

    let encrypted_key = master_key
        .map(|mk| crypto::encrypt_key(&plain_key, mk))
        .transpose()?;

    gateway_keys::ActiveModel {
        id: Set(id.clone()),
        name: Set(name.to_string()),
        key_hash: Set(key_hash),
        key_prefix: Set(key_prefix),
        enabled: Set(1),
        created_at: Set(now),
        last_used_at: Set(None),
        encrypted_key: Set(encrypted_key),
    }
    .insert(db)
    .await?;

    let row = gateway_keys::Entity::find_by_id(&id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("GatewayKey {}", id)))?;

    Ok(CreateGatewayKeyResult {
        gateway_key: key_from_entity(row),
        plain_key,
    })
}

pub async fn delete_gateway_key(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = gateway_keys::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("GatewayKey {}", id)));
    }
    Ok(())
}

pub async fn toggle_gateway_key(db: &DatabaseConnection, id: &str) -> Result<GatewayKey> {
    let row = gateway_keys::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("GatewayKey {}", id)))?;

    let new_enabled = if row.enabled != 0 { 0 } else { 1 };
    let mut am: gateway_keys::ActiveModel = row.into();
    am.enabled = Set(new_enabled);
    am.update(db).await?;

    let row = gateway_keys::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("GatewayKey {}", id)))?;
    Ok(key_from_entity(row))
}

/// Verify an incoming API key against stored hashes. Returns the matching key if found.
pub async fn verify_key(db: &DatabaseConnection, plain_key: &str) -> Result<GatewayKey> {
    let key_hash = crypto::sha256_hash(plain_key);

    let row = gateway_keys::Entity::find()
        .filter(gateway_keys::Column::KeyHash.eq(&key_hash))
        .filter(gateway_keys::Column::Enabled.eq(1))
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound("Invalid or disabled gateway key".to_string()))?;

    Ok(key_from_entity(row))
}

pub async fn update_last_used(db: &DatabaseConnection, id: &str) -> Result<()> {
    if let Some(row) = gateway_keys::Entity::find_by_id(id).one(db).await? {
        let mut am: gateway_keys::ActiveModel = row.into();
        am.last_used_at = Set(Some(now_ts()));
        am.update(db).await?;
    }
    Ok(())
}

/// Decrypt and return the plain key for a given key ID.
pub async fn get_plain_key(
    db: &DatabaseConnection,
    master_key: &[u8; 32],
    key_id: &str,
) -> Result<String> {
    let row = gateway_keys::Entity::find_by_id(key_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("GatewayKey {}", key_id)))?;

    let encrypted = row.encrypted_key.ok_or_else(|| {
        AQBotError::Crypto("Key was created before encrypted storage was available".to_string())
    })?;

    crypto::decrypt_key(&encrypted, master_key)
}
