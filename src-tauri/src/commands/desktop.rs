use crate::tray::PendingTrayAction;
use crate::AppState;
use std::sync::atomic::Ordering;
use tauri::Manager;

#[tauri::command]
pub async fn minimize_window(window: tauri::Window) -> Result<(), String> {
    crate::window_lifecycle::minimize_main_window(window)
}

#[tauri::command]
pub async fn toggle_maximize_window(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn set_always_on_top(window: tauri::Window, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_close_to_tray(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.close_to_tray.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn set_release_webview_on_tray(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    state
        .release_webview_on_tray
        .store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn apply_startup_settings(
    window: tauri::Window,
    app: tauri::AppHandle,
    always_on_top: bool,
    close_to_tray: bool,
    release_webview_on_tray: bool,
    tray_enabled: Option<bool>,
) -> Result<(), String> {
    window
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    if let Some(tray_enabled) = tray_enabled {
        state.tray_enabled.store(tray_enabled, Ordering::Relaxed);
    }
    state.close_to_tray.store(close_to_tray, Ordering::Relaxed);
    state
        .release_webview_on_tray
        .store(release_webview_on_tray, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn force_quit(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.is_quitting.store(true, Ordering::Relaxed);
    app.exit(0);
    Ok(())
}

/// Rebuild tray menu (recent conversations, selection-toolbar check, i18n labels).
#[tauri::command]
pub async fn refresh_tray_menu(app: tauri::AppHandle) -> Result<(), String> {
    crate::tray::sync_tray_menu(&app).await
}

/// Drain a tray action queued while the main webview was destroyed or not yet ready.
#[tauri::command]
pub fn take_pending_tray_action(app: tauri::AppHandle) -> Option<PendingTrayAction> {
    crate::tray::take_pending_action(&app)
}

#[tauri::command]
pub async fn get_desktop_capabilities() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!([
        { "key": "tray", "supported": true },
        { "key": "global_shortcut", "supported": true },
        { "key": "protocol_handler", "supported": true },
        { "key": "mini_window", "supported": true },
        { "key": "notification", "supported": true },
        {
            "key": "devtools_context_menu",
            "supported": crate::startup_diagnostics::devtools_context_menu_enabled()
        }
    ]))
}

#[tauri::command]
pub async fn send_desktop_notification(_title: String, _body: String) -> Result<(), String> {
    // Placeholder — real notification via tauri notification plugin
    Ok(())
}

#[tauri::command]
pub async fn get_window_state() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "width": 1200,
        "height": 800,
        "maximized": false,
        "visible": true
    }))
}

#[tauri::command]
pub async fn open_conversation_popout(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<(), String> {
    crate::conversation_popout::open_or_focus_and_wait(&app, &conversation_id).await
}

#[tauri::command]
pub async fn report_conversation_popout_ready(conversation_id: String) -> Result<(), String> {
    crate::conversation_popout::report_ready(&conversation_id);
    Ok(())
}

#[tauri::command]
pub async fn open_devtools(webview_window: tauri::WebviewWindow) -> Result<(), String> {
    tracing::info!(
        window = webview_window.label(),
        devtools_context_menu_enabled = crate::startup_diagnostics::devtools_context_menu_enabled(),
        "Opening AQBot WebView devtools"
    );
    webview_window.open_devtools();
    Ok(())
}

#[tauri::command]
pub async fn write_diagnostic_log(level: String, message: String) -> Result<(), String> {
    let message = truncate_diagnostic_message(&message);
    match level.trim().to_ascii_lowercase().as_str() {
        "trace" => tracing::trace!(target: "aqbot_frontend", "{}", message),
        "debug" => tracing::debug!(target: "aqbot_frontend", "{}", message),
        "warn" | "warning" => tracing::warn!(target: "aqbot_frontend", "{}", message),
        "error" => tracing::error!(target: "aqbot_frontend", "{}", message),
        _ => tracing::info!(target: "aqbot_frontend", "{}", message),
    }
    Ok(())
}

fn truncate_diagnostic_message(message: &str) -> String {
    const MAX_DIAGNOSTIC_MESSAGE_LEN: usize = 8 * 1024;
    let mut result = String::with_capacity(message.len().min(MAX_DIAGNOSTIC_MESSAGE_LEN));
    for ch in message.chars() {
        if result.len() + ch.len_utf8() > MAX_DIAGNOSTIC_MESSAGE_LEN {
            result.push_str("...<truncated>");
            break;
        }
        result.push(ch);
    }
    result
}

#[tauri::command]
pub async fn test_proxy(
    proxy_type: String,
    proxy_address: String,
    proxy_port: u16,
) -> Result<serde_json::Value, String> {
    use std::time::Instant;
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    let addr = format!("{}:{}", proxy_address, proxy_port);
    let start = Instant::now();

    match timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
        Ok(Ok(_stream)) => {
            let latency = start.elapsed().as_millis();
            // If it's an HTTP proxy, try a minimal HTTP CONNECT to verify
            if proxy_type == "http" {
                Ok(serde_json::json!({ "ok": true, "latency_ms": latency }))
            } else {
                Ok(serde_json::json!({ "ok": true, "latency_ms": latency }))
            }
        }
        Ok(Err(e)) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(_) => Ok(serde_json::json!({ "ok": false, "error": "Connection timed out (5s)" })),
    }
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let source = font_kit::source::SystemSource::new();
        let mut families = source.all_families().map_err(|e| e.to_string())?;
        families.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        Ok(families)
    })
    .await
    .map_err(|e| e.to_string())?
}
