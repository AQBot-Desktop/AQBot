//! Backend state retrieval.

use crate::monitor::current_timestamp;
use serde_json::Value;
use tauri::{command, AppHandle, Manager, Runtime};

/// Retrieves comprehensive backend application state.
///
/// Returns detailed metadata about the running Tauri application including
/// app identity, configuration, environment, and window information.
///
/// # Returns
///
/// * `Ok(Value)` - JSON object containing:
///   - `app`: Application metadata (name, identifier, version)
///   - `tauri`: Tauri framework version
///   - `environment`: Runtime environment info (debug mode, OS, arch)
///   - `windows`: List of window labels and their states
///   - `timestamp`: Current timestamp in milliseconds
#[command]
pub async fn get_backend_state<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    let config = app.config();

    // Get window information
    let windows: Vec<Value> = app
        .webview_windows()
        .iter()
        .map(|(label, window)| {
            let is_focused = window.is_focused().unwrap_or(false);
            let is_visible = window.is_visible().unwrap_or(false);
            let title = window.title().unwrap_or_default();

            serde_json::json!({
                "label": label,
                "title": title,
                "focused": is_focused,
                "visible": is_visible,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "app": {
            "name": config.product_name.clone().unwrap_or_else(|| "Unknown".to_string()),
            "identifier": config.identifier.clone(),
            "version": config.version.clone().unwrap_or_else(|| "0.0.0".to_string()),
        },
        "tauri": {
            "version": tauri::VERSION,
        },
        "environment": {
            "debug": cfg!(debug_assertions),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
        },
        "windows": windows,
        "window_count": windows.len(),
        "timestamp": current_timestamp(),
    }))
}
