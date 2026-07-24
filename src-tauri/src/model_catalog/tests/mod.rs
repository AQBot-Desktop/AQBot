use super::cache::{read_cache, write_cache_atomic, CatalogCache};
use super::metadata::{canonical_provider, find_context_window, parse_catalog};
use super::*;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SAMPLE_CATALOG: &str = r#"{
  "sample_spec": {
    "litellm_provider": "one of the supported providers",
    "max_input_tokens": "maximum input tokens",
    "mode": "chat"
  },
  "gpt-4o": {
    "litellm_provider": "openai",
    "mode": "chat",
    "max_input_tokens": 128000,
    "max_output_tokens": 16384,
    "max_tokens": 16384,
    "supports_vision": true
  },
  "output-only": {
    "litellm_provider": "openai",
    "mode": "chat",
    "max_output_tokens": 8192,
    "max_tokens": 8192
  },
  "text-embedding-3-small": {
    "litellm_provider": "openai",
    "mode": "embedding",
    "max_input_tokens": 8192
  },
  "invalid-small": {
    "litellm_provider": "openai",
    "mode": "chat",
    "max_input_tokens": 1000
  },
  "invalid-zero": {
    "litellm_provider": "openai",
    "mode": "chat",
    "max_input_tokens": 0
  },
  "invalid-large": {
    "litellm_provider": "openai",
    "mode": "chat",
    "max_input_tokens": 10000001
  },
  "invalid-type": {
    "litellm_provider": "openai",
    "mode": "chat",
    "max_input_tokens": "128000"
  },
  "openrouter/openai/gpt-4o": {
    "litellm_provider": "openrouter",
    "mode": "chat",
    "max_input_tokens": 64000
  },
  "github_copilot/gpt-4o": {
    "litellm_provider": "github_copilot",
    "mode": "chat",
    "max_input_tokens": 64000
  },
  "zai/glm-4.6": {
    "litellm_provider": "zai",
    "mode": "chat",
    "max_input_tokens": 128000
  }
}"#;

async fn spawn_http_server(
    status: &str,
    body: &'static str,
    etag: Option<&'static str>,
) -> (String, tokio::sync::oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (request_tx, request_rx) = tokio::sync::oneshot::channel();
    let status = status.to_string();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0; 8 * 1024];
        let size = stream.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..size]).to_string();
        let _ = request_tx.send(request);
        let etag_header = etag
            .map(|value| format!("ETag: {value}\r\n"))
            .unwrap_or_default();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{etag_header}Connection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (format!("http://{address}/catalog.json"), request_rx)
}

fn test_config(source_url: String) -> ModelCatalogConfig {
    ModelCatalogConfig {
        source_url,
        ttl: Duration::from_secs(24 * 60 * 60),
        request_timeout: Duration::from_secs(1),
        max_response_bytes: 5 * 1024 * 1024,
    }
}

mod metadata;
mod service;
mod snapshot;
