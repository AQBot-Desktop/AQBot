pub mod adapter;
pub mod registry;
pub mod openai;
pub mod openai_responses;
pub mod anthropic;
pub mod gemini;

use async_trait::async_trait;
use aqbot_core::types::*;
use aqbot_core::error::{AQBotError, Result};
use futures::Stream;
use std::pin::Pin;

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    async fn chat(&self, ctx: &ProviderRequestContext, request: ChatRequest) -> Result<ChatResponse>;

    fn chat_stream(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>>;

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>>;

    async fn embed(&self, ctx: &ProviderRequestContext, request: EmbedRequest) -> Result<EmbedResponse>;

    /// Validate the API key. Default: try list_models.
    /// Providers may override for endpoints that don't support model listing.
    async fn validate_key(&self, ctx: &ProviderRequestContext) -> Result<bool> {
        self.list_models(ctx).await.map(|_| true)
    }
}

#[derive(Debug, Clone)]
pub struct ProviderRequestContext {
    pub api_key: String,
    pub key_id: String,
    pub provider_id: String,
    pub base_url: Option<String>,
    pub api_path: Option<String>,
    pub proxy_config: Option<ProviderProxyConfig>,
}

/// Resolve `api_host` into a usable base URL.
///
/// - Trailing `!` → force mode: strip `!`, return as-is (no auto `/v1`).
/// - Already ends with `/v1` → return as-is.
/// - Otherwise → append `/v1`.
pub fn resolve_base_url(api_host: &str) -> String {
    let trimmed = api_host.trim_end_matches('/');
    if let Some(forced) = trimmed.strip_suffix('!') {
        forced.trim_end_matches('/').to_string()
    } else if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{}/v1", trimmed)
    }
}

/// Build the full chat/completion URL from resolved `base_url` and optional `api_path`.
///
/// When `api_path` is provided:
/// - Trailing `!` on api_path → force: concat resolved base + raw path (strip `!`).
/// - No `!` → auto-dedup: if both resolved base ends with `/v1` and
///   api_path starts with `/v1`, strip the duplicate prefix from api_path.
///
/// When `api_path` is absent, returns `resolved_base_url + default_suffix`
/// (e.g. `/chat/completions`).
pub fn resolve_chat_url(resolved_base: &str, api_path: Option<&str>, default_suffix: &str) -> String {
    let base = resolved_base.trim_end_matches('/');
    match api_path {
        Some(path) if !path.is_empty() => {
            if let Some(forced) = path.strip_suffix('!') {
                // Force mode: concat as-is
                let p = if forced.starts_with('/') { forced.to_string() } else { format!("/{}", forced) };
                format!("{}{}", base, p)
            } else {
                let p = if path.starts_with('/') { path.to_string() } else { format!("/{}", path) };
                // Auto dedup: if both have /v1, strip from api_path
                if base.ends_with("/v1") && p.starts_with("/v1") {
                    format!("{}{}", base, &p[3..])
                } else {
                    format!("{}{}", base, p)
                }
            }
        }
        _ => format!("{}{}", base, default_suffix),
    }
}

pub(crate) fn parse_base64_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (mime_type, data) = rest.split_once(";base64,")?;
    if mime_type.is_empty() || data.is_empty() {
        return None;
    }
    Some((mime_type.to_string(), data.to_string()))
}

/// Build an HTTP client with optional proxy configuration.
pub fn build_http_client(proxy_config: Option<&ProviderProxyConfig>) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder();

    if let Some(config) = proxy_config {
        if let (Some(proxy_type), Some(addr), Some(port)) =
            (&config.proxy_type, &config.proxy_address, &config.proxy_port)
        {
            if proxy_type != "none" && !addr.is_empty() {
                let scheme = if proxy_type == "socks5" { "socks5" } else { "http" };
                let proxy_url = format!("{}://{}:{}", scheme, addr, port);
                let proxy = reqwest::Proxy::all(&proxy_url)
                    .map_err(|e| AQBotError::Provider(format!("Invalid proxy URL: {}", e)))?;
                builder = builder.proxy(proxy);
            }
        }
    }

    builder
        .build()
        .map_err(|e| AQBotError::Provider(format!("Failed to build HTTP client: {}", e)))
}
