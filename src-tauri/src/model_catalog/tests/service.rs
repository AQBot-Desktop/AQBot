use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[test]
fn builtin_load_uses_embedded_catalog_without_touching_cache() {
    let temp = tempfile::tempdir().unwrap();
    let service = ModelCatalogService::new(temp.path(), ModelCatalogConfig::default());

    let result = service.load_builtin();

    assert_eq!(
        result.status.configured_source,
        ModelCatalogSourcePreference::Builtin
    );
    assert_eq!(result.status.source, CatalogSource::Builtin);
    assert_eq!(result.status.warning, None);
    assert!(result.entries.len() > 2_000);
    assert!(!temp.path().join("litellm.json").exists());
}

#[tokio::test]
async fn successful_download_is_normalized_and_cached() {
    let temp = tempfile::tempdir().unwrap();
    let (source_url, request_rx) =
        spawn_http_server("200 OK", SAMPLE_CATALOG, Some("\"catalog-v1\"")).await;
    let service = ModelCatalogService::new(temp.path(), test_config(source_url));
    let result = service.load_online(&reqwest::Client::new(), 100_000).await;

    assert_eq!(result.status.source, CatalogSource::Network);
    assert_eq!(result.status.freshness, CatalogFreshness::Fresh);
    assert_eq!(
        find_context_window(&result.entries, Some("openai"), "gpt-4o"),
        Some(128_000)
    );
    let cached = std::fs::read_to_string(temp.path().join("litellm.json")).unwrap();
    assert_eq!(
        read_cache(&temp.path().join("litellm.json")).unwrap().etag,
        Some("\"catalog-v1\"".to_string())
    );
    assert!(!cached.contains("max_output_tokens"));
    assert!(!cached.contains("\"max_tokens\""));
    let request = request_rx.await.unwrap().to_ascii_lowercase();
    assert!(request.contains("user-agent: aqbot-"));
}

#[tokio::test]
async fn fresh_cache_skips_network() {
    let temp = tempfile::tempdir().unwrap();
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    write_cache_atomic(
        &temp.path().join("litellm.json"),
        &CatalogCache::new(entries, Some("\"cached\"".into()), 10_000),
    )
    .unwrap();
    let service = ModelCatalogService::new(
        temp.path(),
        test_config("http://127.0.0.1:9/unreachable".into()),
    );

    let result = service.load_online(&reqwest::Client::new(), 10_001).await;
    assert_eq!(result.status.source, CatalogSource::Cache);
    assert_eq!(result.status.freshness, CatalogFreshness::Fresh);
    assert_eq!(result.status.warning, None);
}

#[tokio::test]
async fn stale_cache_uses_etag_and_304_refreshes_checked_at() {
    let temp = tempfile::tempdir().unwrap();
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    write_cache_atomic(
        &temp.path().join("litellm.json"),
        &CatalogCache::new(entries, Some("\"catalog-v1\"".into()), 1_000),
    )
    .unwrap();
    let (source_url, request_rx) = spawn_http_server("304 Not Modified", "", None).await;
    let service = ModelCatalogService::new(temp.path(), test_config(source_url));

    let result = service.load_online(&reqwest::Client::new(), 100_000).await;
    assert_eq!(result.status.source, CatalogSource::Cache);
    assert_eq!(result.status.freshness, CatalogFreshness::Fresh);
    assert_eq!(result.status.checked_at, Some(100_000));
    let request = request_rx.await.unwrap();
    assert!(
        request
            .to_ascii_lowercase()
            .contains("if-none-match: \"catalog-v1\""),
        "request did not contain ETag validator: {request}"
    );
    assert_eq!(
        read_cache(&temp.path().join("litellm.json"))
            .unwrap()
            .checked_at,
        100_000
    );
}

#[tokio::test]
async fn failed_refresh_falls_back_to_stale_cache() {
    let temp = tempfile::tempdir().unwrap();
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    write_cache_atomic(
        &temp.path().join("litellm.json"),
        &CatalogCache::new(entries, None, 1_000),
    )
    .unwrap();
    let service = ModelCatalogService::new(
        temp.path(),
        test_config("http://127.0.0.1:9/unreachable".into()),
    );

    let result = service.load_online(&reqwest::Client::new(), 100_000).await;
    assert_eq!(result.status.source, CatalogSource::Cache);
    assert_eq!(result.status.freshness, CatalogFreshness::Stale);
    assert!(result.status.warning.is_some());
    assert_eq!(
        find_context_window(&result.entries, Some("openai"), "gpt-4o"),
        Some(128_000)
    );
}

#[tokio::test]
async fn failed_first_download_falls_back_to_builtin_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let service = ModelCatalogService::new(
        temp.path(),
        test_config("http://127.0.0.1:9/unreachable".into()),
    );

    let result = service.load_online(&reqwest::Client::new(), 100_000).await;
    assert_eq!(
        result.status.configured_source,
        ModelCatalogSourcePreference::Online
    );
    assert_eq!(result.status.source, CatalogSource::Builtin);
    assert_eq!(result.status.freshness, CatalogFreshness::Unknown);
    assert!(!result.entries.is_empty());
    assert!(result.status.warning.is_some());
}

#[tokio::test]
async fn unavailable_is_reported_only_when_online_and_builtin_sources_fail() {
    let temp = tempfile::tempdir().unwrap();
    let service = ModelCatalogService::new_with_builtin(
        temp.path(),
        test_config("http://127.0.0.1:9/unreachable".into()),
        Err("invalid embedded snapshot".into()),
    );

    let result = service.load_online(&reqwest::Client::new(), 100_000).await;

    assert_eq!(result.status.source, CatalogSource::Unavailable);
    assert!(result.entries.is_empty());
    let warning = result.status.warning.unwrap();
    assert!(warning.contains("Failed to refresh LiteLLM catalog"));
    assert!(warning.contains("invalid embedded snapshot"));
}

#[tokio::test]
async fn corrupted_cache_is_replaced_after_successful_download() {
    let temp = tempfile::tempdir().unwrap();
    let cache_path = temp.path().join("litellm.json");
    std::fs::write(&cache_path, b"{not-json").unwrap();
    let (source_url, _) = spawn_http_server("200 OK", SAMPLE_CATALOG, Some("\"recovered\"")).await;
    let service = ModelCatalogService::new(temp.path(), test_config(source_url));

    let result = service.load_online(&reqwest::Client::new(), 100_000).await;

    assert_eq!(result.status.source, CatalogSource::Network);
    let recovered = read_cache(&cache_path).unwrap();
    assert_eq!(recovered.etag.as_deref(), Some("\"recovered\""));
    assert_eq!(
        std::fs::read_dir(temp.path()).unwrap().count(),
        1,
        "atomic replacement must not leave staging files"
    );
}

#[tokio::test]
async fn cached_only_load_reports_client_configuration_error() {
    let temp = tempfile::tempdir().unwrap();
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    write_cache_atomic(
        &temp.path().join("litellm.json"),
        &CatalogCache::new(entries, None, 1_000),
    )
    .unwrap();
    let service = ModelCatalogService::new(
        temp.path(),
        test_config("http://unused.invalid/catalog.json".into()),
    );

    let result = service
        .load_cached_only(100_000, "invalid proxy configuration".into())
        .await;

    assert_eq!(result.status.source, CatalogSource::Cache);
    assert_eq!(result.status.freshness, CatalogFreshness::Stale);
    assert_eq!(
        result.status.warning.as_deref(),
        Some("invalid proxy configuration")
    );
}

#[tokio::test]
async fn cached_only_without_cache_falls_back_to_builtin() {
    let temp = tempfile::tempdir().unwrap();
    let service = ModelCatalogService::new(temp.path(), ModelCatalogConfig::default());

    let result = service
        .load_cached_only(100_000, "invalid proxy configuration".into())
        .await;

    assert_eq!(result.status.source, CatalogSource::Builtin);
    assert!(!result.entries.is_empty());
    assert_eq!(
        result.status.warning.as_deref(),
        Some("invalid proxy configuration")
    );
}

#[tokio::test]
async fn oversized_download_does_not_replace_stale_cache() {
    let temp = tempfile::tempdir().unwrap();
    let entries = parse_catalog(SAMPLE_CATALOG.as_bytes()).unwrap();
    write_cache_atomic(
        &temp.path().join("litellm.json"),
        &CatalogCache::new(entries, None, 1_000),
    )
    .unwrap();
    let (source_url, _) = spawn_http_server("200 OK", SAMPLE_CATALOG, None).await;
    let mut config = test_config(source_url);
    config.max_response_bytes = SAMPLE_CATALOG.len() - 1;
    let service = ModelCatalogService::new(temp.path(), config);

    let result = service.load_online(&reqwest::Client::new(), 100_000).await;
    assert_eq!(result.status.source, CatalogSource::Cache);
    assert_eq!(result.status.freshness, CatalogFreshness::Stale);
    assert!(result.status.warning.unwrap().contains("exceeds"));
    assert_eq!(
        read_cache(&temp.path().join("litellm.json"))
            .unwrap()
            .checked_at,
        1_000
    );
}

#[tokio::test]
async fn concurrent_first_loads_share_one_network_request() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let request_count = Arc::new(AtomicUsize::new(0));
    let server_count = request_count.clone();
    let server = tokio::spawn(async move {
        while let Ok(Ok((mut stream, _))) =
            tokio::time::timeout(Duration::from_millis(300), listener.accept()).await
        {
            server_count.fetch_add(1, Ordering::SeqCst);
            let mut buffer = vec![0; 8 * 1024];
            let _ = stream.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                SAMPLE_CATALOG.len(),
                SAMPLE_CATALOG
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let service = Arc::new(ModelCatalogService::new(
        temp.path(),
        test_config(format!("http://{address}/catalog.json")),
    ));
    let client = reqwest::Client::new();

    let (first, second) = tokio::join!(
        service.load_online(&client, 100_000),
        service.load_online(&client, 100_000)
    );
    server.await.unwrap();
    assert!(!first.entries.is_empty());
    assert!(!second.entries.is_empty());
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn concurrent_failed_loads_share_one_network_request() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let request_count = Arc::new(AtomicUsize::new(0));
    let server_count = request_count.clone();
    let server = tokio::spawn(async move {
        while let Ok(Ok((mut stream, _))) =
            tokio::time::timeout(Duration::from_millis(300), listener.accept()).await
        {
            server_count.fetch_add(1, Ordering::SeqCst);
            let mut buffer = vec![0; 8 * 1024];
            let _ = stream.read(&mut buffer).await;
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        }
    });
    let service = Arc::new(ModelCatalogService::new(
        temp.path(),
        test_config(format!("http://{address}/catalog.json")),
    ));
    let client = reqwest::Client::new();

    let (first, second) = tokio::join!(
        service.load_online(&client, 100_000),
        service.load_online(&client, 100_000)
    );
    server.await.unwrap();

    assert_eq!(first.status.source, CatalogSource::Builtin);
    assert_eq!(second.status.source, CatalogSource::Builtin);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
}
