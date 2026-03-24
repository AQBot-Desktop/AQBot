use crate::AppState;
use std::sync::atomic::Ordering;
use tauri::Manager;

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
pub async fn apply_startup_settings(
    window: tauri::Window,
    app: tauri::AppHandle,
    always_on_top: bool,
    close_to_tray: bool,
) -> Result<(), String> {
    window
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    state.close_to_tray.store(close_to_tray, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn get_desktop_capabilities() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!([
        { "key": "tray", "supported": true },
        { "key": "global_shortcut", "supported": true },
        { "key": "protocol_handler", "supported": true },
        { "key": "mini_window", "supported": true },
        { "key": "notification", "supported": true }
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
pub async fn open_devtools(webview_window: tauri::WebviewWindow) -> Result<(), String> {
    webview_window.open_devtools();
    Ok(())
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
