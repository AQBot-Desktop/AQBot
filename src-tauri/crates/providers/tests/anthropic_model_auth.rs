use aqbot_core::types::ProviderProxyConfig;
use aqbot_providers::{anthropic::AnthropicAdapter, ProviderAdapter, ProviderRequestContext};
use std::{collections::HashMap, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
    time::timeout,
};

fn header_values<'a>(request: &'a str, name: &str) -> Vec<&'a str> {
    request
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
        .collect()
}

async fn spawn_endpoint(expected_auth: Option<&str>) -> (ProviderProxyConfig, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let expected_auth = expected_auth.map(str::to_owned);
    let server = tokio::spawn(async move {
        timeout(Duration::from_secs(5), async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let mut buffer = [0; 1024];
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0, "request ended before headers");
                bytes.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(bytes).unwrap();
            let authorized = header_values(&request, "authorization")
                == expected_auth.as_deref().into_iter().collect::<Vec<_>>()
                && !header_values(&request, "x-api-key").is_empty();
            let (status, body) = if authorized {
                ("200 OK", r#"{"data":[{"id":"claude-test"}]}"#)
            } else {
                (
                    "401 Unauthorized",
                    r#"{"error":{"message":"未提供令牌或令牌无效","type":"new_api_error"}}"#,
                )
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            request
        })
        .await
        .expect("model request timed out")
    });
    let proxy = ProviderProxyConfig {
        proxy_type: Some("http".into()),
        proxy_address: Some("127.0.0.1".into()),
        proxy_port: Some(port),
    };
    (proxy, server)
}

fn context(proxy: ProviderProxyConfig) -> ProviderRequestContext {
    ProviderRequestContext {
        api_key: "sk-test".into(),
        key_id: "key-1".into(),
        provider_id: "provider-1".into(),
        base_url: Some("http://gateway.example.test/v1".into()),
        api_path: Some("/v1/messages".into()),
        aws_region: None,
        proxy_config: Some(proxy),
        custom_headers: None,
    }
}

#[tokio::test]
async fn model_sync_authenticates_with_the_current_key() {
    let adapter = AnthropicAdapter::new();
    for key in ["sk-first", "sk-second"] {
        let bearer = format!("Bearer {key}");
        let (proxy, server) = spawn_endpoint(Some(&bearer)).await;
        let ctx = ProviderRequestContext {
            api_key: key.into(),
            key_id: key.into(),
            ..context(proxy)
        };
        let result = adapter.list_models(&ctx).await;
        let request = server.await.unwrap();

        assert!(request.starts_with("GET http://gateway.example.test/v1/models HTTP/1.1\r\n"));
        assert_eq!(header_values(&request, "x-api-key"), [key]);
        assert_eq!(header_values(&request, "anthropic-version"), ["2023-06-01"]);
        let models = result.expect("Bearer gateway should accept the configured key");
        assert_eq!(header_values(&request, "authorization"), [bearer.as_str()]);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_id, "claude-test");
        assert_eq!(models[0].name, "claude-test");
        assert_eq!(models[0].provider_id, ctx.provider_id);
    }
}

#[tokio::test]
async fn official_anthropic_host_keeps_native_authentication() {
    for host in ["api.anthropic.com", "API.ANTHROPIC.COM"] {
        // A local HTTP proxy captures the official hostname without contacting Anthropic.
        let (proxy, server) = spawn_endpoint(None).await;
        let ctx = ProviderRequestContext {
            base_url: Some(format!("http://{host}/v1")),
            ..context(proxy)
        };
        let result = AnthropicAdapter::new().list_models(&ctx).await;
        let request = server.await.unwrap();

        result.expect("official endpoint should retain native authentication");
        assert!(request.starts_with("GET http://api.anthropic.com/v1/models HTTP/1.1\r\n"));
        assert_eq!(header_values(&request, "x-api-key"), ["sk-test"]);
        assert_eq!(header_values(&request, "anthropic-version"), ["2023-06-01"]);
        assert!(header_values(&request, "authorization").is_empty());
    }
}

#[tokio::test]
async fn custom_authorization_is_preserved_without_duplicates() {
    for name in ["Authorization", "authorization", "aUtHoRiZaTiOn"] {
        let (proxy, server) = spawn_endpoint(Some("Bearer custom-token")).await;
        let ctx = ProviderRequestContext {
            custom_headers: Some(HashMap::from([
                (name.into(), "Bearer custom-token".into()),
                ("X-Custom".into(), "kept".into()),
            ])),
            ..context(proxy)
        };
        let result = AnthropicAdapter::new().list_models(&ctx).await;
        let request = server.await.unwrap();

        result.expect("explicit authorization should take precedence");
        assert_eq!(
            header_values(&request, "authorization"),
            ["Bearer custom-token"]
        );
        assert_eq!(header_values(&request, "x-custom"), ["kept"]);
    }
}

#[tokio::test]
async fn official_hostname_prefix_does_not_disable_gateway_authentication() {
    let (proxy, server) = spawn_endpoint(Some("Bearer sk-test")).await;
    let ctx = ProviderRequestContext {
        base_url: Some("http://api.anthropic.com.proxy.example/v1".into()),
        ..context(proxy)
    };
    let result = AnthropicAdapter::new().list_models(&ctx).await;
    let request = server.await.unwrap();

    result.expect("hostnames must be compared exactly");
    assert_eq!(header_values(&request, "authorization"), ["Bearer sk-test"]);
}

#[tokio::test]
async fn model_sync_propagates_unauthorized_errors() {
    let (proxy, server) = spawn_endpoint(Some("Bearer different-key")).await;
    let result = AnthropicAdapter::new().list_models(&context(proxy)).await;
    let request = server.await.unwrap();

    assert_eq!(header_values(&request, "authorization"), ["Bearer sk-test"]);
    let error = result
        .expect_err("invalid credentials must fail")
        .to_string();
    assert!(error.contains("401 Unauthorized"), "{error}");
    assert!(error.contains("new_api_error"), "{error}");
    assert!(error.contains("未提供令牌或令牌无效"), "{error}");
}
