use aqbot_core::bedrock_credentials;
use aqbot_core::error::{AQBotError, Result};
use aws_credential_types::Credentials;
use aws_sdk_bedrockruntime::config::{Region, SharedHttpClient};
use aws_smithy_http_client::proxy::ProxyConfig;
use aws_smithy_http_client::{tls, Builder, Connector};

use crate::ProviderRequestContext;

pub(super) struct BedrockClients {
    pub control: aws_sdk_bedrock::Client,
    pub runtime: aws_sdk_bedrockruntime::Client,
}

impl BedrockClients {
    pub async fn from_context(ctx: &ProviderRequestContext, disable_retries: bool) -> Result<Self> {
        let region = required_region(ctx)?;
        let credential = bedrock_credentials::parse(&ctx.api_key)?;
        let credentials = Credentials::new(
            credential.access_key_id,
            credential.secret_access_key,
            credential.session_token,
            None,
            "aqbot-bedrock",
        );
        let http_client = build_http_client(ctx)?;
        let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(Region::new(region))
            .credentials_provider(credentials)
            .http_client(http_client);
        if disable_retries {
            loader = loader.retry_config(aws_config::retry::RetryConfig::disabled());
        }
        let shared_config = loader.load().await;

        Ok(Self {
            control: aws_sdk_bedrock::Client::new(&shared_config),
            runtime: aws_sdk_bedrockruntime::Client::new(&shared_config),
        })
    }
}

fn required_region(ctx: &ProviderRequestContext) -> Result<String> {
    ctx.aws_region
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AQBotError::Validation("AWS Region is required for Bedrock".into()))
}

fn build_http_client(ctx: &ProviderRequestContext) -> Result<SharedHttpClient> {
    let proxy = proxy_config(ctx)?;
    Ok(Builder::new().build_with_connector_fn(move |settings, _| {
        let mut builder = Connector::builder().proxy_config(proxy.clone());
        if let Some(settings) = settings {
            builder = builder.connector_settings(settings.clone());
        }
        builder
            .tls_provider(tls::Provider::Rustls(
                tls::rustls_provider::CryptoMode::AwsLc,
            ))
            .build()
    }))
}

fn proxy_config(ctx: &ProviderRequestContext) -> Result<ProxyConfig> {
    let Some(config) = &ctx.proxy_config else {
        return Ok(ProxyConfig::disabled());
    };

    match config.proxy_type.as_deref() {
        None | Some("none") => Ok(ProxyConfig::disabled()),
        Some("system") => Ok(ProxyConfig::from_env()),
        Some("socks5") => Err(AQBotError::Provider(
            "AWS Bedrock does not support SOCKS5 proxy configuration".into(),
        )),
        Some("http") => {
            let address = config
                .proxy_address
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AQBotError::Validation("HTTP proxy address is required".into()))?;
            let port = config
                .proxy_port
                .ok_or_else(|| AQBotError::Validation("HTTP proxy port is required".into()))?;
            ProxyConfig::all(format!("http://{address}:{port}"))
                .map_err(|error| AQBotError::Provider(format!("Invalid HTTP proxy: {error}")))
        }
        Some(other) => Err(AQBotError::Provider(format!(
            "Unsupported Bedrock proxy type: {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::types::ProviderProxyConfig;

    fn context(proxy_type: &str) -> ProviderRequestContext {
        ProviderRequestContext {
            api_key: String::new(),
            key_id: String::new(),
            provider_id: String::new(),
            base_url: None,
            api_path: None,
            aws_region: Some("us-east-1".into()),
            proxy_config: Some(ProviderProxyConfig {
                proxy_type: Some(proxy_type.into()),
                proxy_address: Some("127.0.0.1".into()),
                proxy_port: Some(8080),
            }),
            custom_headers: None,
        }
    }

    #[test]
    fn rejects_socks5_proxy() {
        let error = proxy_config(&context("socks5")).unwrap_err();
        assert!(error.to_string().contains("SOCKS5"));
    }

    #[test]
    fn accepts_http_proxy() {
        proxy_config(&context("http")).unwrap();
    }

    #[tokio::test]
    async fn probe_clients_disable_sdk_retries_without_sending_a_request() {
        let mut ctx = context("none");
        ctx.api_key = bedrock_credentials::serialize(&aqbot_core::types::BedrockCredentialInput {
            access_key_id: "test-access-key".into(),
            secret_access_key: "test-secret-key".into(),
            session_token: None,
        })
        .unwrap();
        let clients = BedrockClients::from_context(&ctx, true).await.unwrap();
        assert_eq!(
            clients
                .runtime
                .config()
                .retry_config()
                .unwrap()
                .max_attempts(),
            1
        );
        assert_eq!(
            clients
                .control
                .config()
                .retry_config()
                .unwrap()
                .max_attempts(),
            1
        );
    }
}
