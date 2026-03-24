use sea_orm::*;

use crate::crypto;
use crate::entity::{gateway_keys, gateway_usage};
use crate::error::{AQBotError, Result};
use crate::types::*;
use crate::utils::now_ts;

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

// --- Gateway Key CRUD ---

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
    crate::repo::gateway_key::create_gateway_key(db, name, master_key).await
}

pub async fn delete_gateway_key(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = gateway_keys::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("GatewayKey {}", id)));
    }
    Ok(())
}

pub async fn toggle_gateway_key(db: &DatabaseConnection, id: &str, enabled: bool) -> Result<()> {
    let row = gateway_keys::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("GatewayKey {}", id)))?;

    let mut am: gateway_keys::ActiveModel = row.into();
    am.enabled = Set(if enabled { 1 } else { 0 });
    am.update(db).await?;

    Ok(())
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

// --- Gateway Usage ---

pub async fn record_usage(
    db: &DatabaseConnection,
    key_id: &str,
    provider_id: &str,
    model_id: Option<&str>,
    request_tokens: u64,
    response_tokens: u64,
) -> Result<()> {
    gateway_usage::ActiveModel {
        key_id: Set(key_id.to_string()),
        provider_id: Set(provider_id.to_string()),
        model_id: Set(model_id.map(|s| s.to_string())),
        request_tokens: Set(request_tokens as i32),
        response_tokens: Set(response_tokens as i32),
        created_at: Set(now_ts()),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(())
}

pub async fn get_gateway_metrics(db: &DatabaseConnection) -> Result<GatewayMetrics> {
    let today_start = chrono::Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp();

    #[derive(Debug, FromQueryResult)]
    struct MetricsRow {
        total_requests: i64,
        total_tokens: i64,
        request_tokens: i64,
        response_tokens: i64,
    }

    let all = MetricsRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Sqlite,
        "SELECT COUNT(*) as total_requests, \
         COALESCE(SUM(request_tokens + response_tokens), 0) as total_tokens, \
         COALESCE(SUM(request_tokens), 0) as request_tokens, \
         COALESCE(SUM(response_tokens), 0) as response_tokens \
         FROM gateway_usage",
    ))
    .one(db)
    .await?
    .unwrap_or(MetricsRow {
        total_requests: 0,
        total_tokens: 0,
        request_tokens: 0,
        response_tokens: 0,
    });

    let today = MetricsRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "SELECT COUNT(*) as total_requests, \
         COALESCE(SUM(request_tokens + response_tokens), 0) as total_tokens, \
         COALESCE(SUM(request_tokens), 0) as request_tokens, \
         COALESCE(SUM(response_tokens), 0) as response_tokens \
         FROM gateway_usage WHERE created_at >= ?",
        [today_start.into()],
    ))
    .one(db)
    .await?
    .unwrap_or(MetricsRow {
        total_requests: 0,
        total_tokens: 0,
        request_tokens: 0,
        response_tokens: 0,
    });

    Ok(GatewayMetrics {
        total_requests: all.total_requests as u64,
        total_tokens: all.total_tokens as u64,
        total_request_tokens: all.request_tokens as u64,
        total_response_tokens: all.response_tokens as u64,
        active_connections: 0,
        today_requests: today.total_requests as u64,
        today_tokens: today.total_tokens as u64,
        today_request_tokens: today.request_tokens as u64,
        today_response_tokens: today.response_tokens as u64,
    })
}

pub async fn get_usage_by_key(db: &DatabaseConnection) -> Result<Vec<UsageByKey>> {
    #[derive(Debug, FromQueryResult)]
    struct Row {
        key_id: String,
        key_name: String,
        request_count: i64,
        token_count: i64,
        request_tokens: i64,
        response_tokens: i64,
    }

    let rows = Row::find_by_statement(Statement::from_string(
        DatabaseBackend::Sqlite,
        "SELECT gu.key_id, gk.name as key_name, \
         COUNT(*) as request_count, \
         COALESCE(SUM(gu.request_tokens + gu.response_tokens), 0) as token_count, \
         COALESCE(SUM(gu.request_tokens), 0) as request_tokens, \
         COALESCE(SUM(gu.response_tokens), 0) as response_tokens \
         FROM gateway_usage gu \
         JOIN gateway_keys gk ON gk.id = gu.key_id \
         GROUP BY gu.key_id \
         ORDER BY token_count DESC",
    ))
    .all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| UsageByKey {
            key_id: r.key_id,
            key_name: r.key_name,
            request_count: r.request_count as u64,
            token_count: r.token_count as u64,
            request_tokens: r.request_tokens as u64,
            response_tokens: r.response_tokens as u64,
        })
        .collect())
}

pub async fn get_usage_by_provider(db: &DatabaseConnection) -> Result<Vec<UsageByProvider>> {
    #[derive(Debug, FromQueryResult)]
    struct Row {
        provider_id: String,
        provider_name: String,
        request_count: i64,
        token_count: i64,
        request_tokens: i64,
        response_tokens: i64,
    }

    let rows = Row::find_by_statement(Statement::from_string(
        DatabaseBackend::Sqlite,
        "SELECT gu.provider_id, COALESCE(p.name, gu.provider_id) as provider_name, \
         COUNT(*) as request_count, \
         COALESCE(SUM(gu.request_tokens + gu.response_tokens), 0) as token_count, \
         COALESCE(SUM(gu.request_tokens), 0) as request_tokens, \
         COALESCE(SUM(gu.response_tokens), 0) as response_tokens \
         FROM gateway_usage gu \
         LEFT JOIN providers p ON p.id = gu.provider_id \
         GROUP BY gu.provider_id \
         ORDER BY token_count DESC",
    ))
    .all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| UsageByProvider {
            provider_id: r.provider_id,
            provider_name: r.provider_name,
            request_count: r.request_count as u64,
            token_count: r.token_count as u64,
            request_tokens: r.request_tokens as u64,
            response_tokens: r.response_tokens as u64,
        })
        .collect())
}

pub async fn get_usage_by_day(db: &DatabaseConnection, days: u32) -> Result<Vec<UsageByDay>> {
    #[derive(Debug, FromQueryResult)]
    struct Row {
        date: String,
        request_count: i64,
        token_count: i64,
        request_tokens: i64,
        response_tokens: i64,
    }

    let since = now_ts() - (days as i64 * 86400);

    let rows = Row::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "SELECT date(created_at, 'unixepoch') as date, \
         COUNT(*) as request_count, \
         COALESCE(SUM(request_tokens + response_tokens), 0) as token_count, \
         COALESCE(SUM(request_tokens), 0) as request_tokens, \
         COALESCE(SUM(response_tokens), 0) as response_tokens \
         FROM gateway_usage \
         WHERE created_at >= ? \
         GROUP BY date \
         ORDER BY date ASC",
        [since.into()],
    ))
    .all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| UsageByDay {
            date: r.date,
            request_count: r.request_count as u64,
            token_count: r.token_count as u64,
            request_tokens: r.request_tokens as u64,
            response_tokens: r.response_tokens as u64,
        })
        .collect())
}

pub async fn get_connected_programs(db: &DatabaseConnection) -> Result<Vec<ConnectedProgram>> {
    let today_start = chrono::Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp();
    let active_threshold = now_ts() - 300;

    #[derive(Debug, FromQueryResult)]
    struct Row {
        key_id: String,
        key_name: String,
        key_prefix: String,
        today_requests: i64,
        today_tokens: i64,
        today_request_tokens: i64,
        today_response_tokens: i64,
        last_active_at: Option<i64>,
    }

    let rows = Row::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "SELECT gk.id as key_id, gk.name as key_name, gk.key_prefix, \
         COALESCE(t.cnt, 0) as today_requests, \
         COALESCE(t.tokens, 0) as today_tokens, \
         COALESCE(t.request_tokens, 0) as today_request_tokens, \
         COALESCE(t.response_tokens, 0) as today_response_tokens, \
         gk.last_used_at as last_active_at \
         FROM gateway_keys gk \
         LEFT JOIN ( \
              SELECT key_id, COUNT(*) as cnt, \
              SUM(request_tokens + response_tokens) as tokens, \
              SUM(request_tokens) as request_tokens, \
              SUM(response_tokens) as response_tokens \
              FROM gateway_usage WHERE created_at >= ? \
              GROUP BY key_id \
          ) t ON t.key_id = gk.id \
         WHERE gk.enabled = 1 \
         ORDER BY gk.created_at DESC",
        [today_start.into()],
    ))
    .all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ConnectedProgram {
            key_id: r.key_id,
            key_name: r.key_name,
            key_prefix: r.key_prefix,
            today_requests: r.today_requests as u64,
            today_tokens: r.today_tokens as u64,
            today_request_tokens: r.today_request_tokens as u64,
            today_response_tokens: r.today_response_tokens as u64,
            last_active_at: r.last_active_at,
            is_active: r
                .last_active_at
                .map(|t| t >= active_threshold)
                .unwrap_or(false),
        })
        .collect())
}
