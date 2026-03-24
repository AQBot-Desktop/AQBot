pub mod adapter;
pub mod registry;
pub mod openai;
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
}

#[derive(Debug, Clone)]
pub struct ProviderRequestContext {
    pub api_key: String,
    pub key_id: String,
    pub provider_id: String,
    pub base_url: Option<String>,
    pub proxy_config: Option<ProviderProxyConfig>,
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
