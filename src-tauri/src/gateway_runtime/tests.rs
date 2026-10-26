use super::*;

async fn database(auto_start: bool) -> (tempfile::TempDir, DatabaseConnection) {
    let directory = tempfile::tempdir().unwrap();
    let db = aqbot_core::db::create_pool(directory.path().join("gateway.db").to_str().unwrap())
        .await
        .unwrap()
        .conn;
    let mut settings = aqbot_core::repo::settings::get_settings(&db).await.unwrap();
    settings.gateway_auto_start = auto_start;
    settings.gateway_listen_address = "127.0.0.1".into();
    settings.gateway_port = 0;
    aqbot_core::repo::settings::save_settings(&db, &settings)
        .await
        .unwrap();
    db.close().await.unwrap();
    let db = aqbot_core::db::create_pool(directory.path().join("gateway.db").to_str().unwrap())
        .await
        .unwrap()
        .conn;
    assert_eq!(
        aqbot_core::repo::settings::get_settings(&db)
            .await
            .unwrap()
            .gateway_auto_start,
        auto_start
    );
    (directory, db)
}

async fn health(port: u16) {
    let response = reqwest::get(format!("http://127.0.0.1:{port}/health"))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"status":"ok"})
    );
}

#[test]
fn gateway_auto_start_survives_setup_runtime() {
    let setup = tokio::runtime::Runtime::new().unwrap();
    let (directory, db) = setup.block_on(database(true));
    let runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let task = setup.block_on(async { schedule_auto_start(db.clone(), [0; 32], runtime.clone()) });
    drop(setup);
    tauri::async_runtime::block_on(async {
        task.await.unwrap();
        let status = runtime.lock().await.status(&db).await.unwrap();
        assert!(
            status.is_running,
            "persisted gateway_auto_start must start the actual listener"
        );
        health(status.port).await;
        runtime.lock().await.stop().await.unwrap();
        db.close().await.unwrap();
    });
    drop(directory);
}

#[tokio::test]
async fn gateway_disabled_and_cancelled_auto_start_do_not_listen() {
    for enabled in [false, true] {
        let (_directory, db) = database(enabled).await;
        let runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
        let mut guard = runtime.lock().await;
        let scheduled = schedule_auto_start(db.clone(), [0; 32], runtime.clone());
        if enabled {
            guard.stop().await.unwrap();
        }
        drop(guard);
        scheduled.await.unwrap();
        let status = runtime.lock().await.status(&db).await.unwrap();
        assert!(!status.is_running);
        assert!(status.last_start_error.is_none());
        assert_eq!(
            aqbot_core::repo::settings::get_settings(&db)
                .await
                .unwrap()
                .gateway_auto_start,
            enabled
        );
    }
}

#[tokio::test]
async fn gateway_bind_failure_is_retained_until_manual_recovery() {
    let (_directory, db) = database(true).await;
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut settings = aqbot_core::repo::settings::get_settings(&db).await.unwrap();
    settings.gateway_port = occupied.local_addr().unwrap().port();
    aqbot_core::repo::settings::save_settings(&db, &settings)
        .await
        .unwrap();
    let runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    schedule_auto_start(db.clone(), [0; 32], runtime.clone())
        .await
        .unwrap();
    let status = runtime.lock().await.status(&db).await.unwrap();
    assert!(!status.is_running);
    assert!(status
        .last_start_error
        .unwrap()
        .contains("Failed to bind HTTP port"));
    drop(occupied);
    runtime.lock().await.start(&db, [0; 32]).await.unwrap();
    let status = runtime.lock().await.status(&db).await.unwrap();
    assert!(status.last_start_error.is_none());
    health(status.port).await;
    runtime.lock().await.stop().await.unwrap();
    schedule_auto_start(db.clone(), [0; 32], runtime.clone())
        .await
        .unwrap();
    assert!(!runtime.lock().await.status(&db).await.unwrap().is_running);
}

#[tokio::test]
async fn gateway_concurrent_manual_start_has_one_listener_and_cancels_auto() {
    let (_directory, db) = database(true).await;
    let runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    let (first, second) = tokio::join!(
        async { runtime.lock().await.start(&db, [0; 32]).await },
        async { runtime.lock().await.start(&db, [0; 32]).await },
    );
    assert!(first.is_ok());
    assert_eq!(second.unwrap_err(), "Gateway is already running");
    let status = runtime.lock().await.status(&db).await.unwrap();
    assert!(status.is_running);
    assert!(status.last_start_error.is_none());
    let port = status.port;
    schedule_auto_start(db.clone(), [0; 32], runtime.clone())
        .await
        .unwrap();
    assert_eq!(runtime.lock().await.status(&db).await.unwrap().port, port);
    health(port).await;
    let (_, stopped) = tokio::join!(
        async { runtime.lock().await.start(&db, [0; 32]).await },
        async { runtime.lock().await.stop().await },
    );
    stopped.unwrap();
    assert!(!runtime.lock().await.status(&db).await.unwrap().is_running);
}

#[tokio::test]
async fn gateway_invalid_tls_auto_start_is_visible_and_manual_validation_matches() {
    let (_directory, db) = database(true).await;
    let mut settings = aqbot_core::repo::settings::get_settings(&db).await.unwrap();
    settings.gateway_ssl_enabled = true;
    settings.gateway_ssl_port = 1;
    settings.gateway_ssl_cert_path = None;
    aqbot_core::repo::settings::save_settings(&db, &settings)
        .await
        .unwrap();
    let runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    schedule_auto_start(db.clone(), [0; 32], runtime.clone())
        .await
        .unwrap();
    let error = runtime
        .lock()
        .await
        .status(&db)
        .await
        .unwrap()
        .last_start_error
        .unwrap();
    assert_eq!(
        error,
        "SSL is enabled but no certificate file is configured"
    );
    assert_eq!(
        runtime.lock().await.start(&db, [0; 32]).await.unwrap_err(),
        error
    );
    settings.gateway_ssl_enabled = false;
    aqbot_core::repo::settings::save_settings(&db, &settings)
        .await
        .unwrap();
    runtime.lock().await.start(&db, [0; 32]).await.unwrap();
    health(runtime.lock().await.status(&db).await.unwrap().port).await;
    runtime.lock().await.stop().await.unwrap();
}

// Keep failure, recovery, and runtime reconstruction together to verify the same persisted configuration.
#[tokio::test]
async fn gateway_https_decodes_paths_and_preserves_force_ssl() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (directory, db) = database(true).await;
    let certificates = tempfile::tempdir_in(dirs::home_dir().unwrap()).unwrap();
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let cert_path = certificates.path().join("cert.pem");
    let key_path = certificates.path().join("key.pem");
    std::fs::write(&cert_path, "invalid certificate").unwrap();
    std::fs::write(&key_path, key.serialize_pem()).unwrap();
    let mut settings = aqbot_core::repo::settings::get_settings(&db).await.unwrap();
    let available = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    settings.gateway_port = available.local_addr().unwrap().port();
    drop(available);
    settings.gateway_ssl_port = 0;
    settings.gateway_ssl_enabled = true;
    settings.gateway_force_ssl = true;
    settings.gateway_ssl_cert_path = Some(aqbot_core::path_vars::encode_path(
        cert_path.to_str().unwrap(),
    ));
    settings.gateway_ssl_key_path = Some(aqbot_core::path_vars::encode_path(
        key_path.to_str().unwrap(),
    ));
    assert!(settings
        .gateway_ssl_cert_path
        .as_ref()
        .unwrap()
        .starts_with("{{HOME}}"));
    aqbot_core::repo::settings::save_settings(&db, &settings)
        .await
        .unwrap();
    let runtime = Arc::new(Mutex::new(GatewayRuntime::default()));
    schedule_auto_start(db.clone(), [0; 32], runtime.clone())
        .await
        .unwrap();
    let failure = runtime.lock().await.status(&db).await.unwrap();
    assert!(!failure.is_running);
    assert!(failure
        .last_start_error
        .unwrap()
        .contains("Failed to load TLS certificate"));
    std::fs::write(&cert_path, cert.pem()).unwrap();
    runtime.lock().await.start(&db, [0; 32]).await.unwrap();
    let status = runtime.lock().await.status(&db).await.unwrap();
    assert!(status.force_ssl && status.ssl_enabled);
    assert!(status.last_start_error.is_none());
    let https_port = status.https_port.unwrap();
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client
        .get(format!("https://127.0.0.1:{https_port}/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"status":"ok"})
    );
    let response = client
        .get(format!("http://127.0.0.1:{}/health", status.port))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
    assert!(response.headers()["location"]
        .to_str()
        .unwrap()
        .contains(&format!(":{https_port}/health")));
    runtime.lock().await.stop().await.unwrap();
    // A fresh gateway runtime starts HTTPS from the same persisted settings without manual intervention.
    let restarted = Arc::new(Mutex::new(GatewayRuntime::default()));
    schedule_auto_start(db.clone(), [0; 32], restarted.clone())
        .await
        .unwrap();
    let status = restarted.lock().await.status(&db).await.unwrap();
    assert!(status.is_running && status.ssl_enabled && status.force_ssl);
    let response = client
        .get(format!(
            "https://127.0.0.1:{}/health",
            status.https_port.unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"status":"ok"})
    );
    restarted.lock().await.stop().await.unwrap();
    db.close().await.unwrap();
    drop(directory);
}
