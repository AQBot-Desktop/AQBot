//! Window listing and discovery.

use serde::Serialize;
use serde_json::Value;
use tauri::{command, AppHandle, Manager, Runtime};

/// Information about a webview window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// The unique label/identifier for this window
    pub label: String,
    /// The window title (if available)
    pub title: Option<String>,
    /// The current URL loaded in the webview (if available)
    pub url: Option<String>,
    /// Whether this window currently has focus
    pub focused: bool,
    /// Whether this window is visible
    pub visible: bool,
    /// Whether this is the main window (label == "main")
    pub is_main: bool,
}

/// Lists all open webview windows in the application.
///
/// Returns detailed information about each window including its label, title,
/// URL, focus state, and visibility.
///
/// # Arguments
///
/// * `app` - The Tauri application handle
///
/// # Returns
///
/// * `Ok(Value)` - JSON array of WindowInfo objects
/// * `Err(String)` - Error message if retrieval fails
///
/// # Examples
///
/// ```typescript
/// import { invoke } from '@tauri-apps/api/core';
///
/// const windows = await invoke('plugin:mcp-bridge|list_windows');
/// console.log(`Found ${windows.length} windows`);
/// ```
#[command]
pub async fn list_windows<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    let windows = app.webview_windows();
    let mut window_list: Vec<WindowInfo> = Vec::new();

    for (label, window) in windows.iter() {
        let title = window.title().ok();
        let url = window.url().ok().map(|u| u.to_string());
        let focused = window.is_focused().unwrap_or(false);
        let visible = window.is_visible().unwrap_or(false);
        let is_main = label == "main";

        window_list.push(WindowInfo {
            label: label.clone(),
            title,
            url,
            focused,
            visible,
            is_main,
        });
    }

    // Sort by label for consistent ordering, with "main" first
    window_list.sort_by(|a, b| {
        if a.is_main {
            std::cmp::Ordering::Less
        } else if b.is_main {
            std::cmp::Ordering::Greater
        } else {
            a.label.cmp(&b.label)
        }
    });

    serde_json::to_value(&window_list).map_err(|e| format!("Failed to serialize windows: {e}"))
}

/// Context about which window was used for an operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowContext {
    /// The label of the window that was used
    pub window_label: String,
    /// Total number of windows available
    pub total_windows: usize,
    /// Warning message if multiple windows exist but none was specified
    pub warning: Option<String>,
}

/// Result of resolving a window, including context information.
pub struct ResolvedWindow<R: Runtime> {
    pub window: tauri::WebviewWindow<R>,
    pub context: WindowContext,
}

/// Resolves a window by label, defaulting to "main" if not specified.
/// Returns both the window and context about the resolution.
///
/// # Arguments
///
/// * `app` - The Tauri application handle
/// * `label` - Optional window label (defaults to "main")
///
/// # Returns
///
/// * `Ok(ResolvedWindow)` - The resolved window with context
/// * `Err(String)` - Error if window not found
pub fn resolve_window_with_context<R: Runtime>(
    app: &AppHandle<R>,
    label: Option<String>,
) -> Result<ResolvedWindow<R>, String> {
    let windows = app.webview_windows();
    let total_windows = windows.len();
    let explicit_label = label.is_some();
    let target_label = label.unwrap_or_else(|| "main".to_string());

    let window = app
        .get_webview_window(&target_label)
        .ok_or_else(|| format!("Window '{target_label}' not found"))?;

    let warning = if !explicit_label && total_windows > 1 {
        Some(format!(
            "Multiple windows detected ({total_windows} total). Defaulting to 'main' window. \
             Use windowId parameter to target a specific window. \
             Available windows: {}",
            windows.keys().cloned().collect::<Vec<_>>().join(", ")
        ))
    } else {
        None
    };

    Ok(ResolvedWindow {
        window,
        context: WindowContext {
            window_label: target_label,
            total_windows,
            warning,
        },
    })
}

/// Resolves a window by label, defaulting to "main" if not specified.
/// Simple version without context (for backward compatibility).
///
/// # Arguments
///
/// * `app` - The Tauri application handle
/// * `label` - Optional window label (defaults to "main")
///
/// # Returns
///
/// * `Ok(WebviewWindow)` - The resolved window
/// * `Err(String)` - Error if window not found
pub fn resolve_window<R: Runtime>(
    app: &AppHandle<R>,
    label: Option<String>,
) -> Result<tauri::WebviewWindow<R>, String> {
    let label = label.unwrap_or_else(|| "main".to_string());
    app.get_webview_window(&label)
        .ok_or_else(|| format!("Window '{label}' not found"))
}
