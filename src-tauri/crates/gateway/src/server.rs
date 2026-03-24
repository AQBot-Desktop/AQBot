use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::State as AxumState,
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use axum_server::{tls_rustls::RustlsConfig, Handle};
use sea_orm::DatabaseConnection;
use tokio::task::JoinHandle;

use aqbot_core::error::{AQBotError, Result};

/// Shared state for Axum handlers (separate from Tauri AppState).
#[derive(Clone)]
pub struct GatewayAppState {
    pub db: DatabaseConnection,
    pub master_key: [u8; 32],
}

/// TLS certificate material.
#[derive(Debug, Clone)]
pub struct GatewayTlsConfig {
    pub cert_path: String,
    pub key_path: String,
}

/// SSL listener configuration: port number plus TLS certificate material.
#[derive(Debug, Clone)]
pub struct GatewaySslConfig {
    pub ssl_port: u16,
    pub tls: GatewayTlsConfig,
}

/// Full configuration passed to [`GatewayServer::start`].
#[derive(Debug, Clone)]
pub struct GatewayStartConfig {
    pub listen_address: String,
    pub http_port: u16,
    /// `None` means HTTP-only mode.
    pub ssl: Option<GatewaySslConfig>,
    /// When `true` and `ssl` is `Some`, the HTTP listener returns 302 redirects
    /// to the HTTPS URL instead of serving the gateway directly.
    pub force_ssl: bool,
}

// ─── SSL redirect handler ─────────────────────────────────────────────────

#[derive(Clone)]
struct RedirectState {
    https_port: u16,
}

async fn ssl_redirect_handler(
    AxumState(state): AxumState<RedirectState>,
    req: Request<Body>,
) -> Response {
    let host_header = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");

    // Strip any existing port from the Host header, handling bracketed IPv6.
    let bare_host = if host_header.starts_with('[') {
        // Bracketed IPv6: "[::1]:port" → "[::1]", or "[::1]" → "[::1]".
        match host_header.find("]:") {
            Some(pos) => &host_header[..pos + 1],
            None => host_header,
        }
    } else {
        match host_header.rfind(':') {
            Some(pos) => &host_header[..pos],
            None => host_header,
        }
    };

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    let location = format!(
        "https://{}:{}{}",
        bare_host, state.https_port, path_and_query
    );
    // 307 preserves the request method (POST stays POST), unlike 302.
    (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, location)]).into_response()
}

fn create_redirect_router(https_port: u16) -> Router {
    Router::new()
        .fallback(ssl_redirect_handler)
        .with_state(RedirectState { https_port })
}

// ─── GatewayServer ────────────────────────────────────────────────────────

pub struct GatewayServer {
    http_handle: Handle,
    http_task: Option<JoinHandle<()>>,
    http_addr: SocketAddr,
    https_handle: Option<Handle>,
    https_task: Option<JoinHandle<()>>,
    https_addr: Option<SocketAddr>,
    force_ssl: bool,
    running: Arc<AtomicBool>,
    started_at: i64,
}

impl GatewayServer {
    pub async fn start(
        pool: DatabaseConnection,
        master_key: [u8; 32],
        config: GatewayStartConfig,
    ) -> Result<Self> {
        let app_state = GatewayAppState {
            db: pool,
            master_key,
        };

        // ── Bind HTTP listener ──────────────────────────────────────────
        let http_bind: SocketAddr = format!("{}:{}", config.listen_address, config.http_port)
            .parse()
            .map_err(|e| AQBotError::Gateway(format!("Invalid HTTP bind address: {}", e)))?;
        let http_listener = std::net::TcpListener::bind(http_bind)
            .map_err(|e| AQBotError::Gateway(format!("Failed to bind HTTP port: {}", e)))?;
        http_listener
            .set_nonblocking(true)
            .map_err(|e| AQBotError::Gateway(format!("Failed to set nonblocking: {}", e)))?;
        let http_actual_addr = http_listener
            .local_addr()
            .map_err(|e| AQBotError::Gateway(format!("Failed to get HTTP local addr: {}", e)))?;

        // ── Optionally bind HTTPS listener and load TLS config ──────────
        struct HttpsBinding {
            listener: std::net::TcpListener,
            rustls: RustlsConfig,
            addr: SocketAddr,
        }
        let https_binding: Option<HttpsBinding> = match &config.ssl {
            Some(ssl_cfg) => {
                let https_bind: SocketAddr =
                    format!("{}:{}", config.listen_address, ssl_cfg.ssl_port)
                        .parse()
                        .map_err(|e| {
                            AQBotError::Gateway(format!("Invalid HTTPS bind address: {}", e))
                        })?;
                let listener = std::net::TcpListener::bind(https_bind).map_err(|e| {
                    AQBotError::Gateway(format!("Failed to bind HTTPS port: {}", e))
                })?;
                listener.set_nonblocking(true).map_err(|e| {
                    AQBotError::Gateway(format!("Failed to set HTTPS nonblocking: {}", e))
                })?;
                let addr = listener.local_addr().map_err(|e| {
                    AQBotError::Gateway(format!("Failed to get HTTPS local addr: {}", e))
                })?;
                let rustls =
                    RustlsConfig::from_pem_file(&ssl_cfg.tls.cert_path, &ssl_cfg.tls.key_path)
                        .await
                        .map_err(|e| {
                            AQBotError::Gateway(format!("Failed to load TLS certificate: {}", e))
                        })?;
                Some(HttpsBinding { listener, rustls, addr })
            }
            None => None,
        };

        let https_actual_addr = https_binding.as_ref().map(|b| b.addr);

        // ── Build router(s) ─────────────────────────────────────────────
        // HTTP router: redirect (force_ssl) or full gateway.
        // HTTPS router: always the full gateway when SSL is configured.
        let http_router: Router = if config.force_ssl && https_actual_addr.is_some() {
            create_redirect_router(https_actual_addr.unwrap().port())
        } else {
            crate::routes::create_router(app_state.clone())
        };
        let https_router: Option<Router> = if https_binding.is_some() {
            Some(crate::routes::create_router(app_state))
        } else {
            None
        };

        // ── Spawn HTTP task ─────────────────────────────────────────────
        // Pre-create the HTTPS Handle (when HTTPS will be active) before
        // spawning the HTTP task so that each task holds a clone of its
        // sibling's handle for mutual-shutdown: if one listener exits
        // unexpectedly, it triggers a graceful shutdown of the other so
        // the gateway never ends up half-dead.
        let running = Arc::new(AtomicBool::new(true));
        let http_handle = Handle::new();
        let https_handle: Option<Handle> =
            if https_binding.is_some() && https_router.is_some() {
                Some(Handle::new())
            } else {
                None
            };
        let http_task = {
            let server_handle = http_handle.clone();
            let running_flag = running.clone();
            let router = http_router;
            let addr = http_actual_addr;
            let peer_handle = https_handle.clone();
            tokio::spawn(async move {
                tracing::info!("Gateway HTTP listener on http://{}", addr);
                let result = axum_server::from_tcp(http_listener)
                    .handle(server_handle)
                    .serve(router.into_make_service())
                    .await;
                if let Err(e) = result {
                    tracing::error!("Gateway HTTP server error: {}", e);
                }
                // Shut down the sibling HTTPS listener if still running.
                if let Some(h) = peer_handle {
                    h.graceful_shutdown(Some(Duration::from_secs(5)));
                }
                running_flag.store(false, Ordering::SeqCst);
                tracing::info!("Gateway HTTP server stopped");
            })
        };

        // ── Spawn HTTPS task (when SSL is configured) ───────────────────
        let https_task = match (https_binding, https_router) {
            (Some(binding), Some(router)) => {
                // Reuse the pre-created handle so the HTTP task already
                // holds a clone for mutual-shutdown.
                let server_handle = https_handle
                    .as_ref()
                    .expect("handle pre-created above")
                    .clone();
                let addr = binding.addr;
                let running_flag = running.clone();
                let peer_handle = http_handle.clone();
                let task = tokio::spawn(async move {
                    tracing::info!("Gateway HTTPS listener on https://{}", addr);
                    let result =
                        axum_server::from_tcp_rustls(binding.listener, binding.rustls)
                            .handle(server_handle)
                            .serve(router.into_make_service())
                            .await;
                    if let Err(e) = result {
                        tracing::error!("Gateway HTTPS server error: {}", e);
                    }
                    // Shut down the sibling HTTP listener if still running.
                    peer_handle.graceful_shutdown(Some(Duration::from_secs(5)));
                    running_flag.store(false, Ordering::SeqCst);
                    tracing::info!("Gateway HTTPS server stopped");
                });
                Some(task)
            }
            _ => None,
        };

        Ok(Self {
            http_handle,
            http_task: Some(http_task),
            http_addr: http_actual_addr,
            https_handle,
            https_task,
            https_addr: https_actual_addr,
            force_ssl: config.force_ssl,
            running,
            started_at: aqbot_core::utils::now_ts(),
        })
    }

    pub async fn stop(&mut self) -> Result<()> {
        // Signal graceful shutdown on both listeners.
        self.http_handle
            .graceful_shutdown(Some(Duration::from_secs(5)));
        if let Some(ref h) = self.https_handle {
            h.graceful_shutdown(Some(Duration::from_secs(5)));
        }
        // Await both tasks.
        if let Some(task) = self.http_task.take() {
            let _ = task.await;
        }
        if let Some(task) = self.https_task.take() {
            let _ = task.await;
        }
        self.running.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Bound address of the HTTP listener.
    pub fn http_addr(&self) -> SocketAddr {
        self.http_addr
    }

    /// Bound address of the HTTPS listener, or `None` if SSL is not active.
    pub fn https_addr(&self) -> Option<SocketAddr> {
        self.https_addr
    }

    pub fn force_ssl(&self) -> bool {
        self.force_ssl
    }

    pub fn started_at(&self) -> i64 {
        self.started_at
    }
}
