use tauri::{Runtime, WebviewWindow};

// Platform-specific modules
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "ios")]
mod ios;

#[cfg(target_os = "android")]
mod android;

/// Screenshot result containing the image data
#[derive(Debug)]
pub struct Screenshot {
    /// The raw PNG bytes
    pub data: Vec<u8>,
}

/// Screenshot error types
#[derive(Debug, thiserror::Error)]
pub enum ScreenshotError {
    #[error("Platform not supported")]
    PlatformUnsupported,

    #[error("Webview capture failed: {0}")]
    CaptureFailed(String),

    #[error("Encoding failed: {0}")]
    EncodeFailed(String),

    #[error("Timeout exceeded")]
    Timeout,
}

/// Platform-specific screenshot implementation trait
pub trait PlatformScreenshot {
    /// Capture a screenshot of the current viewport
    fn capture_viewport(
        window: &WebviewWindow<impl Runtime>,
    ) -> Result<Screenshot, ScreenshotError>;
}

/// Capture a screenshot of the current viewport using platform-specific APIs
pub async fn capture_viewport_screenshot<R: Runtime>(
    window: &WebviewWindow<R>,
    format: &str,
    _quality: u8,
) -> Result<String, ScreenshotError> {
    // Dispatch to platform-specific implementation
    #[cfg(target_os = "macos")]
    let screenshot = macos::capture_viewport(window)?;

    #[cfg(target_os = "windows")]
    let screenshot = windows::capture_viewport(window)?;

    #[cfg(target_os = "linux")]
    let screenshot = linux::capture_viewport(window)?;

    #[cfg(target_os = "ios")]
    let screenshot = ios::capture_viewport(window)?;

    #[cfg(target_os = "android")]
    let screenshot = android::capture_viewport(window)?;

    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux",
        target_os = "ios",
        target_os = "android"
    )))]
    return Err(ScreenshotError::PlatformUnsupported);

    // Convert to base64 data URL
    let mime_type = if format == "jpeg" {
        "image/jpeg"
    } else {
        "image/png"
    };

    // If we need to convert PNG to JPEG or apply quality settings,
    // we'll need to use the image crate here
    // For now, we'll just return the PNG data

    use base64::Engine as _;
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&screenshot.data);
    let data_url = format!("data:{mime_type};base64,{base64_data}");

    Ok(data_url)
}
