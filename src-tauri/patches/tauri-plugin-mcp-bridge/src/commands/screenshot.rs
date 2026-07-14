//! Native screenshot capture.

use tauri::{command, Runtime, WebviewWindow};

/// Native screenshot command using platform-specific APIs.
///
/// This command takes a screenshot of the **current viewport** (visible area) of the webview
/// using native platform APIs:
/// - macOS/iOS: Uses WKWebView's takeSnapshot (viewport only)
/// - Windows: Uses WebView2's CapturePreview (viewport by default)
/// - Linux: Uses webkit_web_view_get_snapshot with WEBKIT_SNAPSHOT_REGION_VISIBLE
/// - Android: Uses WebView.draw() to capture the visible viewport
///
/// **Note**: This captures only what's currently visible in the viewport.
/// The agent should scroll content into view before taking screenshots if needed.
///
/// # Arguments
///
/// * `window` - The window to capture
/// * `format` - Image format ("png" or "jpeg")
/// * `quality` - JPEG quality (0-100), only used for JPEG format
///
/// # Returns
///
/// * `Ok(String)` - Base64-encoded image data URL
/// * `Err(String)` - Error message if capture fails
#[command]
pub async fn capture_native_screenshot<R: Runtime>(
    window: WebviewWindow<R>,
    format: Option<String>,
    quality: Option<u8>,
) -> Result<String, String> {
    let format = format.unwrap_or_else(|| "png".to_string());
    let quality = quality.unwrap_or(90);

    // Use the screenshot module for viewport capture
    use crate::screenshot;

    match screenshot::capture_viewport_screenshot(&window, &format, quality).await {
        Ok(data_url) => Ok(data_url),
        Err(e) => Err(e.to_string()),
    }
}
