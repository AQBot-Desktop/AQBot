use aqbot_core::types::GatewayStatus;
use aqbot_gateway::server::GatewayServer;
use sea_orm::DatabaseConnection;
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) struct GatewayRuntimeSettings {
    pub(crate) listen_address: String,
    pub(crate) port: u16,
    pub(crate) ssl_port: u16,
    pub(crate) ssl_enabled: bool,
    pub(crate) ssl_cert_path: Option<String>,
    pub(crate) ssl_key_path: Option<String>,
    pub(crate) force_ssl: bool,
}

pub(crate) async fn load_gateway_runtime_settings(
    db: &DatabaseConnection,
) -> Result<GatewayRuntimeSettings, String> {
    let settings = aqbot_core::repo::settings::get_settings(db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(GatewayRuntimeSettings {
        listen_address: settings.gateway_listen_address,
        port: settings.gateway_port,
        ssl_port: settings.gateway_ssl_port,
        ssl_enabled: settings.gateway_ssl_enabled,
        ssl_cert_path: aqbot_core::path_vars::decode_path_opt(&settings.gateway_ssl_cert_path),
        ssl_key_path: aqbot_core::path_vars::decode_path_opt(&settings.gateway_ssl_key_path),
        force_ssl: settings.gateway_force_ssl,
    })
}

/// Validates SSL settings before starting; returns an error message if invalid.
fn validate_ssl_settings(s: &GatewayRuntimeSettings) -> Result<(), String> {
    if !s.ssl_enabled {
        return Ok(());
    }
    if s.ssl_cert_path.as_deref().unwrap_or("").trim().is_empty() {
        return Err("SSL is enabled but no certificate file is configured".to_string());
    }
    if s.ssl_key_path.as_deref().unwrap_or("").trim().is_empty() {
        return Err("SSL is enabled but no private key file is configured".to_string());
    }
    if s.port == s.ssl_port {
        return Err(format!(
            "HTTP port ({}) and HTTPS port ({}) must be different",
            s.port, s.ssl_port
        ));
    }
    Ok(())
}

pub(crate) struct GatewayRuntime {
    pub(crate) server: Option<GatewayServer>,
    last_start_error: Option<String>,
    auto_start_pending: bool,
}

impl Default for GatewayRuntime {
    fn default() -> Self {
        Self {
            server: None,
            last_start_error: None,
            auto_start_pending: true,
        }
    }
}

impl GatewayRuntime {
    pub(crate) async fn start(
        &mut self,
        db: &DatabaseConnection,
        master_key: [u8; 32],
    ) -> Result<(), String> {
        self.auto_start_pending = false;
        if self.server.as_ref().map_or(false, |s| s.is_running()) {
            return Err("Gateway is already running".to_string());
        }
        let result = self.start_server(db, master_key).await;
        match &result {
            Ok(()) => self.last_start_error = None,
            Err(error) => self.last_start_error = Some(error.clone()),
        }
        result
    }

    async fn start_server(
        &mut self,
        db: &DatabaseConnection,
        master_key: [u8; 32],
    ) -> Result<(), String> {
        let settings = load_gateway_runtime_settings(db).await?;
        validate_ssl_settings(&settings)?;

        // Drop any stale stopped server before storing the new one.
        if self.server.is_some() {
            self.server = None;
        }

        let ssl_config = if settings.ssl_enabled {
            // cert/key paths are validated non-empty by validate_ssl_settings above.
            Some(aqbot_gateway::server::GatewaySslConfig {
                ssl_port: settings.ssl_port,
                tls: aqbot_gateway::server::GatewayTlsConfig {
                    cert_path: settings.ssl_cert_path.unwrap_or_default(),
                    key_path: settings.ssl_key_path.unwrap_or_default(),
                },
            })
        } else {
            None
        };

        let start_config = aqbot_gateway::server::GatewayStartConfig {
            listen_address: settings.listen_address,
            http_port: settings.port,
            ssl: ssl_config,
            force_ssl: settings.force_ssl,
        };

        let server =
            aqbot_gateway::server::GatewayServer::start(db.clone(), master_key, start_config)
                .await
                .map_err(|e| e.to_string())?;

        self.server = Some(server);
        Ok(())
    }

    pub(crate) async fn stop(&mut self) -> Result<(), String> {
        self.auto_start_pending = false;
        if let Some(mut server) = self.server.take() {
            server.stop().await.map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub(crate) async fn status(&self, db: &DatabaseConnection) -> Result<GatewayStatus, String> {
        if let Some(server) = self.server.as_ref().filter(|server| server.is_running()) {
            return Ok(GatewayStatus {
                is_running: true,
                listen_address: server.http_addr().ip().to_string(),
                port: server.http_addr().port(),
                ssl_enabled: server.https_addr().is_some(),
                started_at: Some(server.started_at()),
                https_port: server.https_addr().map(|addr| addr.port()),
                force_ssl: server.force_ssl(),
                last_start_error: self.last_start_error.clone(),
            });
        }
        let settings = load_gateway_runtime_settings(db).await?;
        Ok(GatewayStatus {
            is_running: false,
            listen_address: settings.listen_address,
            port: settings.port,
            ssl_enabled: settings.ssl_enabled,
            started_at: None,
            https_port: settings.ssl_enabled.then_some(settings.ssl_port),
            force_ssl: settings.force_ssl,
            last_start_error: self.last_start_error.clone(),
        })
    }
}

pub(crate) fn schedule_auto_start(
    db: DatabaseConnection,
    master_key: [u8; 32],
    runtime: Arc<Mutex<GatewayRuntime>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut gateway = runtime.lock().await;
        if !gateway.auto_start_pending {
            return;
        }
        gateway.auto_start_pending = false;
        let result = async {
            let settings = aqbot_core::repo::settings::get_settings(&db)
                .await
                .map_err(|error| error.to_string())?;
            if settings.gateway_auto_start {
                gateway.start(&db, master_key).await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            gateway.last_start_error = Some(error.clone());
            tracing::error!(error = %error, "Failed to auto-start gateway");
        }
    })
}

#[cfg(test)]
mod tests;
