use crate::AppState;
use aqbot_core::repo::cli_config::CliTool;
use aqbot_core::types::*;
use tauri::State;

struct GatewayRuntimeSettings {
    listen_address: String,
    port: u16,
    ssl_port: u16,
    ssl_enabled: bool,
    ssl_cert_path: Option<String>,
    ssl_key_path: Option<String>,
    force_ssl: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuickConnectProtocol {
    Http,
    Https,
}

impl QuickConnectProtocol {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "http" => Ok(Self::Http),
            "https" => Ok(Self::Https),
            _ => Err("Invalid quick connect protocol. Expected 'http' or 'https'.".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GatewayUrlOptions {
    http: Option<String>,
    https: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliToolConnectionState {
    status: &'static str,
    connected_protocol: Option<QuickConnectProtocol>,
}

async fn load_gateway_runtime_settings(
    state: &AppState,
) -> Result<GatewayRuntimeSettings, String> {
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(GatewayRuntimeSettings {
        listen_address: settings.gateway_listen_address,
        port: settings.gateway_port,
        ssl_port: settings.gateway_ssl_port,
        ssl_enabled: settings.gateway_ssl_enabled,
        ssl_cert_path: settings.gateway_ssl_cert_path,
        ssl_key_path: settings.gateway_ssl_key_path,
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

fn gateway_client_host(listen_address: &str) -> String {
    match listen_address.trim() {
        "0.0.0.0" => "127.0.0.1".to_string(),
        "::" | "[::]" => "localhost".to_string(),
        other => other.to_string(),
    }
}

fn gateway_api_base_path(tool: CliTool) -> &'static str {
    match tool {
        CliTool::Gemini => "/v1beta",
        _ => "/v1",
    }
}

fn build_gateway_url_for_selected_protocol(
    listen_address: &str,
    http_port: u16,
    https_port: Option<u16>,
    force_ssl: bool,
    tool: CliTool,
    protocol: QuickConnectProtocol,
) -> Result<String, String> {
    if matches!(protocol, QuickConnectProtocol::Http) && force_ssl {
        return Err("HTTP is unavailable for quick connect while Force SSL is enabled".to_string());
    }

    build_gateway_url_for_protocol(listen_address, http_port, https_port, tool, protocol)
}

fn build_gateway_url_for_protocol(
    listen_address: &str,
    http_port: u16,
    https_port: Option<u16>,
    tool: CliTool,
    protocol: QuickConnectProtocol,
) -> Result<String, String> {
    let host = gateway_client_host(listen_address);
    let base_path = gateway_api_base_path(tool);

    match protocol {
        QuickConnectProtocol::Http => Ok(format!("http://{}:{}{}", host, http_port, base_path)),
        QuickConnectProtocol::Https => {
            let https_port =
                https_port.ok_or_else(|| "HTTPS is unavailable for quick connect".to_string())?;
            Ok(format!("https://{}:{}{}", host, https_port, base_path))
        }
    }
}

fn build_gateway_url_options(
    listen_address: &str,
    http_port: u16,
    https_port: Option<u16>,
    _force_ssl: bool,
    tool: CliTool,
) -> GatewayUrlOptions {
    GatewayUrlOptions {
        http: build_gateway_url_for_protocol(
            listen_address,
            http_port,
            https_port,
            tool,
            QuickConnectProtocol::Http,
        )
        .ok(),
        https: build_gateway_url_for_protocol(
            listen_address,
            http_port,
            https_port,
            tool,
            QuickConnectProtocol::Https,
        )
        .ok(),
    }
}

fn gateway_url_for_protocol(
    gateway_urls: &GatewayUrlOptions,
    protocol: QuickConnectProtocol,
) -> Result<String, String> {
    match protocol {
        QuickConnectProtocol::Http => gateway_urls
            .http
            .clone()
            .ok_or_else(|| "HTTP is unavailable for quick connect".to_string()),
        QuickConnectProtocol::Https => gateway_urls
            .https
            .clone()
            .ok_or_else(|| "HTTPS is unavailable for quick connect".to_string()),
    }
}

fn resolve_cli_tool_connection_state(
    is_installed: bool,
    http_connected: bool,
    https_connected: bool,
) -> CliToolConnectionState {
    if !is_installed {
        return CliToolConnectionState {
            status: "not_installed",
            connected_protocol: None,
        };
    }

    let connected_protocol = if https_connected {
        Some(QuickConnectProtocol::Https)
    } else if http_connected {
        Some(QuickConnectProtocol::Http)
    } else {
        None
    };

    CliToolConnectionState {
        status: if connected_protocol.is_some() {
            "connected"
        } else {
            "not_connected"
        },
        connected_protocol,
    }
}

fn detect_cli_tool_connection_state(
    tool: CliTool,
    gateway_urls: &GatewayUrlOptions,
) -> CliToolConnectionState {
    let is_installed = aqbot_core::repo::cli_config::check_installed(tool);
    let http_connected = gateway_urls
        .http
        .as_deref()
        .map(|gateway_url| {
            aqbot_core::repo::cli_config::validate_connection(tool, gateway_url).unwrap_or(false)
        })
        .unwrap_or(false);
    let https_connected = gateway_urls
        .https
        .as_deref()
        .map(|gateway_url| {
            aqbot_core::repo::cli_config::validate_connection(tool, gateway_url).unwrap_or(false)
        })
        .unwrap_or(false);

    resolve_cli_tool_connection_state(is_installed, http_connected, https_connected)
}

fn disconnect_gateway_url_for_cli_tool(
    gateway_urls: &GatewayUrlOptions,
    connection_state: &CliToolConnectionState,
) -> Result<String, String> {
    if let Some(protocol) = connection_state.connected_protocol {
        return gateway_url_for_protocol(gateway_urls, protocol);
    }

    gateway_urls
        .https
        .clone()
        .or_else(|| gateway_urls.http.clone())
        .ok_or_else(|| "No gateway URL is available for quick connect".to_string())
}

async fn resolve_gateway_urls(
    state: &AppState,
    tool: CliTool,
) -> Result<GatewayUrlOptions, String> {
    resolve_gateway_runtime_value(state, |listen_address, http_port, https_port, force_ssl| {
        Ok(build_gateway_url_options(
            listen_address,
            http_port,
            https_port,
            force_ssl,
            tool,
        ))
    })
    .await
}

async fn resolve_gateway_url_for_selected_protocol(
    state: &AppState,
    tool: CliTool,
    protocol: QuickConnectProtocol,
) -> Result<String, String> {
    resolve_gateway_runtime_value(state, |listen_address, http_port, https_port, force_ssl| {
        build_gateway_url_for_selected_protocol(
            listen_address,
            http_port,
            https_port,
            force_ssl,
            tool,
            protocol,
        )
    })
    .await
}

async fn resolve_gateway_runtime_value<T, F>(
    state: &AppState,
    build: F,
) -> Result<T, String>
where
    F: FnOnce(&str, u16, Option<u16>, bool) -> Result<T, String>,
{
    struct LivePorts {
        http_port: u16,
        https_port: Option<u16>,
        force_ssl: bool,
    }

    let live_ports: Option<LivePorts> = {
        let gw = state.gateway.lock().await;
        gw.as_ref().filter(|s| s.is_running()).map(|s| LivePorts {
            http_port: s.http_addr().port(),
            https_port: s.https_addr().map(|a| a.port()),
            force_ssl: s.force_ssl(),
        })
        // MutexGuard dropped here
    };

    let settings = load_gateway_runtime_settings(state).await?;

    match live_ports {
        Some(info) => build(
            &settings.listen_address,
            info.http_port,
            info.https_port,
            info.force_ssl,
        ),
        None => build(
            &settings.listen_address,
            settings.port,
            if settings.ssl_enabled {
                Some(settings.ssl_port)
            } else {
                None
            },
            settings.force_ssl,
        ),
    }
}

// ─── CLI Tool Integration ───────────────────────────────

#[tauri::command]
pub async fn get_all_cli_tool_statuses(
    state: State<'_, AppState>,
) -> Result<Vec<CliToolInfo>, String> {
    let mut results = Vec::new();
    for tool in aqbot_core::repo::cli_config::CliTool::all() {
        let gateway_urls = resolve_gateway_urls(&state, *tool).await?;
        let version = aqbot_core::repo::cli_config::check_installed_version(*tool);
        let config_exists = aqbot_core::repo::cli_config::check_config_exists(*tool);
        let is_installed = version.is_some() || config_exists;
        let connection_state = if is_installed {
            let http_connected = gateway_urls
                .http
                .as_deref()
                .map(|gateway_url| {
                    aqbot_core::repo::cli_config::validate_connection(*tool, gateway_url)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            let https_connected = gateway_urls
                .https
                .as_deref()
                .map(|gateway_url| {
                    aqbot_core::repo::cli_config::validate_connection(*tool, gateway_url)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            resolve_cli_tool_connection_state(true, http_connected, https_connected)
        } else {
            resolve_cli_tool_connection_state(false, false, false)
        };
        let config_path = aqbot_core::repo::cli_config::get_config_path(*tool).ok();
        let has_backup = aqbot_core::repo::cli_config::has_backup(*tool);
        results.push(CliToolInfo {
            id: tool.id().to_string(),
            name: tool.display_name().to_string(),
            status: connection_state.status.to_string(),
            version,
            config_path,
            has_backup,
            connected_protocol: connection_state
                .connected_protocol
                .map(|protocol| protocol.as_str().to_string()),
        });
    }
    Ok(results)
}

#[tauri::command]
pub async fn connect_cli_tool(
    state: State<'_, AppState>,
    tool: String,
    key_id: String,
    protocol: String,
) -> Result<(), String> {
    let cli_tool = CliTool::from_str(&tool).map_err(|e| e.to_string())?;
    let protocol = QuickConnectProtocol::parse(&protocol)?;

    // Get plain key via decryption
    let plain_key =
        aqbot_core::repo::gateway_key::get_plain_key(&state.sea_db, &state.master_key, &key_id)
            .await
            .map_err(|e| e.to_string())?;

    let gateway_url = resolve_gateway_url_for_selected_protocol(&state, cli_tool, protocol).await?;

    aqbot_core::repo::cli_config::connect(cli_tool, &gateway_url, &plain_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_cli_tool(
    state: State<'_, AppState>,
    tool: String,
    restore_backup: bool,
) -> Result<(), String> {
    let cli_tool = CliTool::from_str(&tool).map_err(|e| e.to_string())?;
    let gateway_urls = resolve_gateway_urls(&state, cli_tool).await?;
    let connection_state = detect_cli_tool_connection_state(cli_tool, &gateway_urls);
    let gateway_url = disconnect_gateway_url_for_cli_tool(&gateway_urls, &connection_state)?;
    aqbot_core::repo::cli_config::disconnect(cli_tool, restore_backup, &gateway_url)
        .map_err(|e| e.to_string())
}

// ─── Existing Commands ──────────────────────────────────

#[tauri::command]
pub async fn list_gateway_keys(state: State<'_, AppState>) -> Result<Vec<GatewayKey>, String> {
    aqbot_core::repo::gateway::list_gateway_keys(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_gateway_key(
    state: State<'_, AppState>,
    name: String,
) -> Result<CreateGatewayKeyResult, String> {
    aqbot_core::repo::gateway_key::create_gateway_key(&state.sea_db, &name, Some(&state.master_key))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_gateway_key(state: State<'_, AppState>, id: String) -> Result<(), String> {
    aqbot_core::repo::gateway::delete_gateway_key(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_gateway_key(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    aqbot_core::repo::gateway::toggle_gateway_key(&state.sea_db, &id, enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_gateway_metrics(
    state: State<'_, AppState>,
) -> Result<GatewayMetrics, String> {
    aqbot_core::repo::gateway::get_gateway_metrics(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_gateway(
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let gw = state.gateway.lock().await;
        if gw.as_ref().map_or(false, |s| s.is_running()) {
            return Err("Gateway is already running".to_string());
        }
    }

    let settings = load_gateway_runtime_settings(&state).await?;
    validate_ssl_settings(&settings)?;

    let mut gw = state.gateway.lock().await;
    if gw.as_ref().map_or(false, |s| s.is_running()) {
        return Err("Gateway is already running".to_string());
    }
    // Drop any stale stopped server before storing the new one.
    if gw.is_some() {
        *gw = None;
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

    let server = aqbot_gateway::server::GatewayServer::start(
        state.sea_db.clone(),
        state.master_key,
        start_config,
    )
    .await
    .map_err(|e| e.to_string())?;

    *gw = Some(server);
    Ok(())
}

#[tauri::command]
pub async fn stop_gateway(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut gw = state.gateway.lock().await;
    if let Some(mut server) = gw.take() {
        server.stop().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_gateway_status(
    state: State<'_, AppState>,
) -> Result<GatewayStatus, String> {
    // Extract live addresses while holding the lock, then drop it before the
    // async settings fetch.
    struct LiveInfo {
        http_port: u16,
        https_port: Option<u16>,
        listen_ip: String,
        force_ssl: bool,
        started_at: i64,
    }
    let live: Option<LiveInfo> = {
        let gw = state.gateway.lock().await;
        gw.as_ref().filter(|s| s.is_running()).map(|s| LiveInfo {
            http_port: s.http_addr().port(),
            https_port: s.https_addr().map(|a| a.port()),
            listen_ip: s.http_addr().ip().to_string(),
            force_ssl: s.force_ssl(),
            started_at: s.started_at(),
        })
        // MutexGuard dropped here
    };

    if let Some(info) = live {
        Ok(GatewayStatus {
            is_running: true,
            listen_address: info.listen_ip,
            port: info.http_port,
            ssl_enabled: info.https_port.is_some(),
            started_at: Some(info.started_at),
            https_port: info.https_port,
            force_ssl: info.force_ssl,
        })
    } else {
        // Fall back to DB settings when the server is stopped.
        let settings = load_gateway_runtime_settings(&state).await?;
        Ok(GatewayStatus {
            is_running: false,
            listen_address: settings.listen_address,
            port: settings.port,
            ssl_enabled: settings.ssl_enabled,
            started_at: None,
            https_port: if settings.ssl_enabled { Some(settings.ssl_port) } else { None },
            force_ssl: settings.force_ssl,
        })
    }
}

#[tauri::command]
pub async fn get_gateway_usage_by_key(
    state: State<'_, AppState>,
) -> Result<Vec<UsageByKey>, String> {
    aqbot_core::repo::gateway::get_usage_by_key(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_gateway_usage_by_provider(
    state: State<'_, AppState>,
) -> Result<Vec<UsageByProvider>, String> {
    aqbot_core::repo::gateway::get_usage_by_provider(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_gateway_usage_by_day(
    state: State<'_, AppState>,
    days: Option<u32>,
) -> Result<Vec<UsageByDay>, String> {
    aqbot_core::repo::gateway::get_usage_by_day(&state.sea_db, days.unwrap_or(30))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_connected_programs(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectedProgram>, String> {
    aqbot_core::repo::gateway::get_connected_programs(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_gateway_diagnostics(
    state: State<'_, AppState>,
) -> Result<Vec<GatewayDiagnostic>, String> {
    aqbot_core::repo::gateway_diagnostic::get_diagnostics(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_program_policies(
    state: State<'_, AppState>,
) -> Result<Vec<ProgramPolicy>, String> {
    aqbot_core::repo::program_policy::list_program_policies(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_program_policy(
    state: State<'_, AppState>,
    input: SaveProgramPolicyInput,
) -> Result<ProgramPolicy, String> {
    aqbot_core::repo::program_policy::save_program_policy(&state.sea_db, &input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_program_policy(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    aqbot_core::repo::program_policy::delete_program_policy(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_gateway_templates() -> Result<Vec<GatewayTemplate>, String> {
    Ok(vec![
        GatewayTemplate {
            id: "cursor".to_string(),
            name: "Cursor".to_string(),
            target: "cursor".to_string(),
            format: "json".to_string(),
            content: r#"{
  "openai.apiKey": "YOUR_KEY",
  "openai.apiBaseUrl": "http://localhost:8080/v1"
}"#
            .to_string(),
            copy_hint: Some(
                "Add to Cursor User settings.json".to_string(),
            ),
        },
        GatewayTemplate {
            id: "vscode".to_string(),
            name: "VS Code Continue".to_string(),
            target: "vscode".to_string(),
            format: "json".to_string(),
            content: r#"{
  "models": [{
    "title": "AQBot Gateway",
    "provider": "openai",
    "apiBase": "http://localhost:8080/v1",
    "apiKey": "YOUR_KEY"
  }]
}"#
            .to_string(),
            copy_hint: Some("Add to ~/.continue/config.json".to_string()),
        },
        GatewayTemplate {
            id: "claude_code".to_string(),
            name: "Claude Code".to_string(),
            target: "claude_code".to_string(),
            format: "markdown".to_string(),
            content: r#"export ANTHROPIC_AUTH_TOKEN="YOUR_KEY"
export ANTHROPIC_BASE_URL="http://localhost:8080/v1""#
                .to_string(),
            copy_hint: Some(
                "Add to your shell profile (~/.bashrc or ~/.zshrc)".to_string(),
            ),
        },
        GatewayTemplate {
            id: "openai_compatible".to_string(),
            name: "OpenAI Compatible".to_string(),
            target: "openai_compatible".to_string(),
            format: "json".to_string(),
            content: r#"{
  "api_key": "YOUR_KEY",
  "base_url": "http://localhost:8080/v1",
  "model": "gpt-4"
}"#
            .to_string(),
            copy_hint: Some(
                "Use these settings in any OpenAI-compatible client".to_string(),
            ),
        },
    ])
}

#[tauri::command]
pub async fn copy_gateway_template(template_id: String) -> Result<String, String> {
    let templates = list_gateway_templates().await?;
    templates
        .into_iter()
        .find(|t| t.id == template_id)
        .map(|t| t.content)
        .ok_or_else(|| format!("Template '{}' not found", template_id))
}

#[tauri::command]
pub async fn list_gateway_request_logs(
    state: State<'_, AppState>,
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<Vec<GatewayRequestLog>, String> {
    aqbot_core::repo::gateway_request_log::list_request_logs(
        &state.sea_db,
        limit.unwrap_or(100),
        offset.unwrap_or(0),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_gateway_request_logs(
    state: State<'_, AppState>,
) -> Result<u64, String> {
    aqbot_core::repo::gateway_request_log::clear_request_logs(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_self_signed_cert(
    state: State<'_, AppState>,
) -> Result<GatewayCertResult, String> {
    use rcgen::{CertificateParams, KeyPair};

    let cert_dir = state.app_data_dir.join("ssl");
    std::fs::create_dir_all(&cert_dir).map_err(|e| e.to_string())?;

    let settings = load_gateway_runtime_settings(&state).await?;
    let key_pair = KeyPair::generate().map_err(|e| e.to_string())?;
    let mut subject_alt_names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    let listen_address = settings.listen_address.trim();
    if !listen_address.is_empty()
        && !matches!(listen_address, "localhost" | "127.0.0.1" | "0.0.0.0" | "::" | "[::]")
        && !subject_alt_names.iter().any(|name| name == listen_address)
    {
        subject_alt_names.push(listen_address.to_string());
    }

    let mut params = CertificateParams::new(subject_alt_names).map_err(|e| e.to_string())?;
    params.distinguished_name.push(
        rcgen::DnType::CommonName,
        rcgen::DnValue::Utf8String("AQBot Gateway".to_string()),
    );
    params.distinguished_name.push(
        rcgen::DnType::OrganizationName,
        rcgen::DnValue::Utf8String("AQBot".to_string()),
    );

    let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;

    let cert_path = cert_dir.join("cert.pem");
    let key_path = cert_dir.join("key.pem");

    std::fs::write(&cert_path, cert.pem()).map_err(|e| e.to_string())?;

    // Write the private key atomically with restricted permissions.
    // Using a temp-file + rename guarantees 0o600 even when key.pem already
    // exists with permissive mode: `OpenOptions::mode` only takes effect on
    // file *creation*, so overwriting in-place would preserve the old mode.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        // Temp file lives in the same directory so the rename is atomic.
        let tmp_path = cert_dir.join("key.pem.tmp");
        // Remove any stale temp file left by an interrupted earlier run so
        // that the create_new(true) open below does not fail with EEXIST.
        let _ = std::fs::remove_file(&tmp_path);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true) // always a fresh file → mode(0o600) is always applied
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|e| format!("failed to create temp key file: {}", e))?;
        file.write_all(key_pair.serialize_pem().as_bytes())
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp_path);
                format!("failed to write temp key file: {}", e)
            })?;
        // Flush and close before rename so content is durable.
        drop(file);
        std::fs::rename(&tmp_path, &key_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("failed to install key file: {}", e)
        })?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&key_path, key_pair.serialize_pem()).map_err(|e| e.to_string())?;
    }

    Ok(GatewayCertResult {
        cert_path: cert_path.to_string_lossy().to_string(),
        key_path: key_path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_gateway_url_for_selected_protocol, build_gateway_url_options,
        disconnect_gateway_url_for_cli_tool, gateway_api_base_path, list_gateway_templates,
        resolve_cli_tool_connection_state, GatewayUrlOptions, QuickConnectProtocol,
    };
    use aqbot_core::repo::cli_config::CliTool;

    #[test]
    fn gateway_api_base_path_matches_native_protocols() {
        assert_eq!(gateway_api_base_path(CliTool::Gemini), "/v1beta");
        assert_eq!(gateway_api_base_path(CliTool::ClaudeCode), "/v1");
        assert_eq!(gateway_api_base_path(CliTool::Codex), "/v1");
        assert_eq!(gateway_api_base_path(CliTool::OpenCode), "/v1");
        assert_eq!(gateway_api_base_path(CliTool::Cursor), "/v1");
    }

    #[test]
    fn list_gateway_templates_match_actual_claude_and_cursor_contracts() {
        let templates =
            tauri::async_runtime::block_on(list_gateway_templates()).expect("list templates");

        let cursor = templates
            .iter()
            .find(|template| template.id == "cursor")
            .expect("cursor template should exist");
        assert!(
            cursor.content.contains("\"openai.apiKey\""),
            "cursor template should use the dotted openai.apiKey setting key"
        );
        assert!(
            cursor.content.contains("\"openai.apiBaseUrl\""),
            "cursor template should use the dotted openai.apiBaseUrl setting key"
        );
        assert!(
            !cursor.content.contains("\"openaiApiKey\""),
            "cursor template should not use the legacy camelCase key"
        );
        assert!(
            !cursor.content.contains("\"openaiBaseUrl\""),
            "cursor template should not use the legacy camelCase base URL key"
        );

        let claude = templates
            .iter()
            .find(|template| template.id == "claude_code")
            .expect("Claude template should exist");
        assert!(
            claude.content.contains("ANTHROPIC_BASE_URL"),
            "Claude template should export ANTHROPIC_BASE_URL"
        );
        assert!(
            claude.content.contains("ANTHROPIC_AUTH_TOKEN"),
            "Claude template should export ANTHROPIC_AUTH_TOKEN"
        );
        assert!(
            !claude.content.contains("OPENAI_API_KEY"),
            "Claude template should not advertise OpenAI env var names"
        );
        assert!(
            !claude.content.contains("OPENAI_BASE_URL"),
            "Claude template should not advertise OpenAI base URL env var names"
        );
    }

    #[test]
    fn build_gateway_url_for_selected_protocol_uses_http_and_https_urls() {
        assert_eq!(
            build_gateway_url_for_selected_protocol(
                "0.0.0.0",
                8080,
                Some(8443),
                false,
                CliTool::Cursor,
                QuickConnectProtocol::Http,
            )
            .expect("http url"),
            "http://127.0.0.1:8080/v1"
        );
        assert_eq!(
            build_gateway_url_for_selected_protocol(
                "0.0.0.0",
                8080,
                Some(8443),
                false,
                CliTool::Cursor,
                QuickConnectProtocol::Https,
            )
            .expect("https url"),
            "https://127.0.0.1:8443/v1"
        );
    }

    #[test]
    fn build_gateway_url_for_selected_protocol_rejects_https_when_unavailable() {
        let error = build_gateway_url_for_selected_protocol(
            "127.0.0.1",
            8080,
            None,
            false,
            CliTool::ClaudeCode,
            QuickConnectProtocol::Https,
        )
        .expect_err("https should be unavailable");

        assert!(
            error.contains("HTTPS"),
            "expected unavailable https error, got: {error}"
        );
    }

    #[test]
    fn build_gateway_url_for_selected_protocol_rejects_http_when_force_ssl_is_enabled() {
        let error = build_gateway_url_for_selected_protocol(
            "127.0.0.1",
            8080,
            Some(8443),
            true,
            CliTool::Cursor,
            QuickConnectProtocol::Http,
        )
        .expect_err("http should be unavailable");

        assert!(
            error.contains("HTTP"),
            "expected unavailable http error, got: {error}"
        );
    }

    #[test]
    fn build_gateway_url_options_keeps_http_for_detection_when_force_ssl_is_enabled() {
        let gateway_urls =
            build_gateway_url_options("127.0.0.1", 8080, Some(8443), true, CliTool::Cursor);

        assert_eq!(
            gateway_urls.http.as_deref(),
            Some("http://127.0.0.1:8080/v1")
        );
        assert_eq!(
            gateway_urls.https.as_deref(),
            Some("https://127.0.0.1:8443/v1")
        );
    }

    #[test]
    fn resolve_cli_tool_connection_state_prefers_https_then_http_then_none() {
        let both_connected = resolve_cli_tool_connection_state(true, true, true);
        assert_eq!(
            both_connected.connected_protocol,
            Some(QuickConnectProtocol::Https)
        );
        assert_eq!(both_connected.status, "connected");

        let http_only = resolve_cli_tool_connection_state(true, true, false);
        assert_eq!(
            http_only.connected_protocol,
            Some(QuickConnectProtocol::Http)
        );
        assert_eq!(http_only.status, "connected");

        let neither = resolve_cli_tool_connection_state(true, false, false);
        assert_eq!(neither.connected_protocol, None);
        assert_eq!(neither.status, "not_connected");
    }

    #[test]
    fn disconnect_gateway_url_for_cli_tool_uses_actual_connected_url() {
        let gateway_urls = GatewayUrlOptions {
            http: Some("http://127.0.0.1:8080/v1".to_string()),
            https: Some("https://127.0.0.1:8443/v1".to_string()),
        };
        let connection_state = resolve_cli_tool_connection_state(true, true, false);

        assert_eq!(
            disconnect_gateway_url_for_cli_tool(&gateway_urls, &connection_state)
                .expect("disconnect url"),
            "http://127.0.0.1:8080/v1"
        );
    }

    #[test]
    fn disconnect_gateway_url_for_cli_tool_keeps_http_target_when_force_ssl_is_enabled() {
        let gateway_urls =
            build_gateway_url_options("127.0.0.1", 8080, Some(8443), true, CliTool::Cursor);
        let connection_state = resolve_cli_tool_connection_state(true, true, false);

        assert_eq!(
            disconnect_gateway_url_for_cli_tool(&gateway_urls, &connection_state)
                .expect("disconnect url"),
            "http://127.0.0.1:8080/v1"
        );
    }

    #[test]
    fn quick_connect_protocol_parsing_accepts_only_http_and_https() {
        assert_eq!(
            QuickConnectProtocol::parse("http").expect("http protocol"),
            QuickConnectProtocol::Http
        );
        assert_eq!(
            QuickConnectProtocol::parse("https").expect("https protocol"),
            QuickConnectProtocol::Https
        );
        assert!(QuickConnectProtocol::parse("ws").is_err());
        assert!(QuickConnectProtocol::parse("HTTP").is_err());
    }
}
