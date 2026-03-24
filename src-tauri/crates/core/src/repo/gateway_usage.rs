use sea_orm::*;

use crate::entity::gateway_usage;
use crate::error::Result;
use crate::types::*;
use crate::utils::now_ts;

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

pub async fn get_metrics(db: &DatabaseConnection) -> Result<GatewayMetrics> {
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
    }

    let all = MetricsRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Sqlite,
        "SELECT COUNT(*) as total_requests, \
         COALESCE(SUM(request_tokens + response_tokens), 0) as total_tokens \
         FROM gateway_usage",
    ))
    .one(db)
    .await?
    .unwrap_or(MetricsRow { total_requests: 0, total_tokens: 0 });

    let today = MetricsRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "SELECT COUNT(*) as total_requests, \
         COALESCE(SUM(request_tokens + response_tokens), 0) as total_tokens \
         FROM gateway_usage WHERE created_at >= ?",
        [today_start.into()],
    ))
    .one(db)
    .await?
    .unwrap_or(MetricsRow { total_requests: 0, total_tokens: 0 });

    Ok(GatewayMetrics {
        total_requests: all.total_requests as u64,
        total_tokens: all.total_tokens as u64,
        active_connections: 0, // runtime state, not tracked in DB
        today_requests: today.total_requests as u64,
        today_tokens: today.total_tokens as u64,
    })
}

pub async fn get_usage_by_key(db: &DatabaseConnection) -> Result<Vec<UsageByKey>> {
    #[derive(Debug, FromQueryResult)]
    struct Row {
        key_id: String,
        key_name: String,
        request_count: i64,
        token_count: i64,
    }

    let rows = Row::find_by_statement(Statement::from_string(
        DatabaseBackend::Sqlite,
        "SELECT gu.key_id, gk.name as key_name, \
         COUNT(*) as request_count, \
         COALESCE(SUM(gu.request_tokens + gu.response_tokens), 0) as token_count \
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
    }

    let rows = Row::find_by_statement(Statement::from_string(
        DatabaseBackend::Sqlite,
        "SELECT gu.provider_id, COALESCE(p.name, gu.provider_id) as provider_name, \
         COUNT(*) as request_count, \
         COALESCE(SUM(gu.request_tokens + gu.response_tokens), 0) as token_count \
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
        })
        .collect())
}

pub async fn get_usage_by_day(db: &DatabaseConnection, days: u32) -> Result<Vec<UsageByDay>> {
    #[derive(Debug, FromQueryResult)]
    struct Row {
        date: String,
        request_count: i64,
        token_count: i64,
    }

    let since = now_ts() - (days as i64 * 86400);

    let rows = Row::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "SELECT date(created_at, 'unixepoch') as date, \
         COUNT(*) as request_count, \
         COALESCE(SUM(request_tokens + response_tokens), 0) as token_count \
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
    let active_threshold = now_ts() - 300; // active within last 5 minutes

    #[derive(Debug, FromQueryResult)]
    struct Row {
        key_id: String,
        key_name: String,
        key_prefix: String,
        today_requests: i64,
        today_tokens: i64,
        last_active_at: Option<i64>,
    }

    let rows = Row::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Sqlite,
        "SELECT gk.id as key_id, gk.name as key_name, gk.key_prefix, \
         COALESCE(t.cnt, 0) as today_requests, \
         COALESCE(t.tokens, 0) as today_tokens, \
         gk.last_used_at as last_active_at \
         FROM gateway_keys gk \
         LEFT JOIN ( \
             SELECT key_id, COUNT(*) as cnt, \
             SUM(request_tokens + response_tokens) as tokens \
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
            last_active_at: r.last_active_at,
            is_active: r
                .last_active_at
                .map(|t| t >= active_threshold)
                .unwrap_or(false),
        })
        .collect())
}
