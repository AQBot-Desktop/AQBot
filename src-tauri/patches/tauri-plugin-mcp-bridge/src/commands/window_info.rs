//! Window information retrieval.

use serde_json::Value;
use tauri::{command, Runtime, WebviewWindow};

/// Retrieves detailed information about the current window.
///
/// Returns comprehensive window state including dimensions, position, title,
/// focus state, and visibility.
///
/// # Arguments
///
/// * `window` - The Tauri window handle
///
/// # Returns
///
/// * `Ok(Value)` - JSON object containing:
///   - `width`: Window width in pixels
///   - `height`: Window height in pixels
///   - `x`: Window x-coordinate
///   - `y`: Window y-coordinate
///   - `title`: Window title string
///   - `focused`: Whether the window has focus
///   - `visible`: Whether the window is visible
/// * `Err(String)` - Error message if retrieval fails
///
/// # Examples
///
/// ```typescript
/// import { invoke } from '@tauri-apps/api/core';
///
/// const info = await invoke('plugin:mcp-bridge|get_window_info');
/// console.log(`Window size: ${info.width}x${info.height}`);
/// ```
#[command]
pub async fn get_window_info<R: Runtime>(window: WebviewWindow<R>) -> Result<Value, String> {
    let size = window
        .outer_size()
        .map_err(|e| format!("Failed to get size: {e}"))?;
    let position = window
        .outer_position()
        .map_err(|e| format!("Failed to get position: {e}"))?;
    let title = window
        .title()
        .map_err(|e| format!("Failed to get title: {e}"))?;
    let is_focused = window
        .is_focused()
        .map_err(|e| format!("Failed to get focus: {e}"))?;
    let is_visible = window
        .is_visible()
        .map_err(|e| format!("Failed to get visibility: {e}"))?;

    Ok(serde_json::json!({
        "width": size.width,
        "height": size.height,
        "x": position.x,
        "y": position.y,
        "title": title,
        "focused": is_focused,
        "visible": is_visible,
    }))
}
