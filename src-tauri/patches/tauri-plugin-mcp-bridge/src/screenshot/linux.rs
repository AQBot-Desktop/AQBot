use super::{Screenshot, ScreenshotError};
use tauri::{Runtime, WebviewWindow};

/// Linux-specific screenshot implementation
///
/// Currently returns an error to trigger the JavaScript fallback (html2canvas).
/// Native WebKitGTK screenshot support requires matching glib versions between
/// webkit2gtk and the rest of the GTK ecosystem, which creates version conflicts.
///
/// TODO: Implement native screenshot when webkit2gtk updates to glib 0.20+
pub fn capture_viewport<R: Runtime>(
    _window: &WebviewWindow<R>,
) -> Result<Screenshot, ScreenshotError> {
    // Return error to trigger JavaScript fallback
    // The webkit2gtk crate uses glib 0.18.x while newer GTK crates use 0.20.x
    // This version mismatch prevents native screenshot implementation
    Err(ScreenshotError::CaptureFailed(
        "Native Linux screenshot not yet implemented - using JavaScript fallback".to_string(),
    ))
}
