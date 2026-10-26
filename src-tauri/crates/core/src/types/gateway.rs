use serde::{Deserialize, Serialize};

// === Gateway System ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayCertResult {
    pub cert_path: String,
    pub key_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatus {
    pub last_start_error: Option<String>,
    pub is_running: bool,
    pub listen_address: String,
    pub port: u16,
    pub ssl_enabled: bool,
    pub started_at: Option<i64>,
    /// HTTPS listener port; `None` when SSL is disabled or not yet started.
    pub https_port: Option<u16>,
    /// When `true` the gateway redirects all HTTP traffic to HTTPS.
    pub force_ssl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayKey {
    pub id: String,
    pub name: String,
    pub key_hash: String,
    pub key_prefix: String,
    pub enabled: bool,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub has_encrypted_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGatewayKeyResult {
    pub gateway_key: GatewayKey,
    pub plain_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayMetrics {
    pub total_requests: u64,
    pub total_tokens: u64,
    pub total_request_tokens: u64,
    pub total_response_tokens: u64,
    pub active_connections: u32,
    pub today_requests: u64,
    pub today_tokens: u64,
    pub today_request_tokens: u64,
    pub today_response_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageByKey {
    pub key_id: String,
    pub key_name: String,
    pub request_count: u64,
    pub token_count: u64,
    pub request_tokens: u64,
    pub response_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageByProvider {
    pub provider_id: String,
    pub provider_name: String,
    pub request_count: u64,
    pub token_count: u64,
    pub request_tokens: u64,
    pub response_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageByDay {
    pub date: String,
    pub request_count: u64,
    pub token_count: u64,
    pub request_tokens: u64,
    pub response_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedProgram {
    pub key_id: String,
    pub key_name: String,
    pub key_prefix: String,
    pub today_requests: u64,
    pub today_tokens: u64,
    pub today_request_tokens: u64,
    pub today_response_tokens: u64,
    pub last_active_at: Option<i64>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStats {
    pub total_requests: u64,
    pub active_connections: u32,
    pub uptime_seconds: u64,
    pub requests_per_minute: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewaySettings {
    pub listen_address: String,
    pub port: u16,
    pub load_balance_strategy: LoadBalanceStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadBalanceStrategy {
    RoundRobin,
}
