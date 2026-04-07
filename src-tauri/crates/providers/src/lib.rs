pub mod adapter;
pub mod anthropic;
pub mod gemini;
pub mod openai;
pub mod openai_responses;
pub mod registry;

use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse>;

    fn chat_stream(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>>;

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>>;

    async fn embed(
        &self,
        ctx: &ProviderRequestContext,
        request: EmbedRequest,
    ) -> Result<EmbedResponse>;

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
    pub custom_headers: Option<std::collections::HashMap<String, String>>,
}

/// Default version path for a given provider type.
pub fn default_version_for_type(provider_type: &ProviderType) -> &'static str {
    match provider_type {
        ProviderType::Gemini => "/v1beta",
        _ => "/v1",
    }
}

/// Resolve `api_host` into a usable base URL, using the provider type to
/// determine the default version path (e.g. `/v1` for OpenAI, `/v1beta` for Gemini).
///
/// - Trailing `!` → force mode: strip `!`, return as-is.
/// - Already ends with a versioned path (e.g. `/v1`, `/v1beta`) → return as-is.
/// - Otherwise → append the default version path for this provider type.
pub fn resolve_base_url_for_type(api_host: &str, provider_type: &ProviderType) -> String {
    let default_version = default_version_for_type(provider_type);
    resolve_base_url_inner(api_host, default_version)
}

/// Resolve `api_host` into a usable base URL (defaults to `/v1`).
pub fn resolve_base_url(api_host: &str) -> String {
    resolve_base_url_inner(api_host, "/v1")
}

fn resolve_base_url_inner(api_host: &str, default_version: &str) -> String {
    let trimmed = api_host.trim_end_matches('/');
    if let Some(forced) = trimmed.strip_suffix('!') {
        forced.trim_end_matches('/').to_string()
    } else if has_version_suffix(trimmed) {
        trimmed.to_string()
    } else {
        format!("{}{}", trimmed, default_version)
    }
}

/// Check whether the URL already ends with a versioned path segment
/// like `/v1`, `/v1beta`, `/v2`, `/v1beta1`, etc.
fn has_version_suffix(url: &str) -> bool {
    let last_seg = url.rsplit('/').next().unwrap_or("");
    // Match patterns like v1, v2, v1beta, v1beta1, v1alpha, etc.
    let bytes = last_seg.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'v' {
        return false;
    }
    // After 'v', must start with digit(s), optionally followed by alpha tag
    let rest = &last_seg[1..];
    rest.starts_with(|c: char| c.is_ascii_digit())
}

/// Build the full chat/completion URL from resolved `base_url` and optional `api_path`.
///
/// When `api_path` is provided:
/// - Trailing `!` on api_path → force: concat resolved base + raw path (strip `!`).
/// - No `!` → auto-dedup: if both resolved base and api_path share a common
///   versioned prefix (e.g. `/v1`, `/v1beta`), strip the duplicate from api_path.
///
/// When `api_path` is absent, returns `resolved_base_url + default_suffix`
/// (e.g. `/chat/completions`).
pub fn resolve_chat_url(
    resolved_base: &str,
    api_path: Option<&str>,
    default_suffix: &str,
) -> String {
    let base = resolved_base.trim_end_matches('/');
    match api_path {
        Some(path) if !path.is_empty() => {
            if let Some(forced) = path.strip_suffix('!') {
                // Force mode: concat as-is
                let p = if forced.starts_with('/') {
                    forced.to_string()
                } else {
                    format!("/{}", forced)
                };
                format!("{}{}", base, p)
            } else {
                let p = if path.starts_with('/') {
                    path.to_string()
                } else {
                    format!("/{}", path)
                };
                // Auto dedup: if base ends with a version prefix that matches
                // the start of api_path, strip it from api_path
                if let Some(ver) = extract_version_prefix(base) {
                    if p.starts_with(&ver) {
                        return format!("{}{}", base, &p[ver.len()..]);
                    }
                }
                format!("{}{}", base, p)
            }
        }
        _ => format!("{}{}", base, default_suffix),
    }
}

/// Extract the trailing version prefix from a URL (e.g. "/v1", "/v1beta").
fn extract_version_prefix(url: &str) -> Option<String> {
    let last_seg = url.rsplit('/').next()?;
    let bytes = last_seg.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'v' {
        return None;
    }
    let rest = &last_seg[1..];
    if rest.starts_with(|c: char| c.is_ascii_digit()) {
        Some(format!("/{}", last_seg))
    } else {
        None
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
/// When no proxy is configured, system proxy auto-detection is explicitly disabled.
pub fn build_http_client(proxy_config: Option<&ProviderProxyConfig>) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder();

    if let Some(config) = proxy_config {
        if let (Some(proxy_type), Some(addr), Some(port)) = (
            &config.proxy_type,
            &config.proxy_address,
            &config.proxy_port,
        ) {
            if proxy_type != "none" && !addr.is_empty() {
                let scheme = if proxy_type == "socks5" {
                    "socks5"
                } else {
                    "http"
                };
                let proxy_url = format!("{}://{}:{}", scheme, addr, port);
                let proxy = reqwest::Proxy::all(&proxy_url)
                    .map_err(|e| AQBotError::Provider(format!("Invalid proxy URL: {}", e)))?;
                builder = builder.proxy(proxy);
            } else {
                builder = builder.no_proxy();
            }
        } else {
            builder = builder.no_proxy();
        }
    } else {
        builder = builder.no_proxy();
    }

    builder
        .build()
        .map_err(|e| AQBotError::Provider(format!("Failed to build HTTP client: {}", e)))
}

/// Default User-Agent: `AQBot-{os}_{arch}/{version}`
pub fn default_user_agent() -> String {
    format!(
        "AQBot-{}_{}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        env!("CARGO_PKG_VERSION")
    )
}

/// Apply custom headers + default User-Agent to a request builder.
pub fn apply_request_headers(
    builder: reqwest::RequestBuilder,
    ctx: &ProviderRequestContext,
) -> reqwest::RequestBuilder {
    apply_headers_to_request(builder, &ctx.custom_headers)
}

/// Apply custom headers + default User-Agent from a raw headers map.
pub fn apply_headers_to_request(
    mut builder: reqwest::RequestBuilder,
    custom_headers: &Option<std::collections::HashMap<String, String>>,
) -> reqwest::RequestBuilder {
    let mut has_ua = false;
    if let Some(ref headers) = custom_headers {
        for (key, value) in headers {
            if key.eq_ignore_ascii_case("user-agent") {
                has_ua = true;
            }
            builder = builder.header(key, value);
        }
    }
    if !has_ua {
        builder = builder.header("User-Agent", default_user_agent());
    }
    builder
}
