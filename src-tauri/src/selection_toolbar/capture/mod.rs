mod geometry;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
pub mod overlay;
#[cfg(target_os = "windows")]
mod windows;

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};

use image::{ImageFormat, RgbaImage};
use serde::Serialize;
use tauri::AppHandle;

use super::ScreenPoint;

pub const OVERLAY_LABEL: &str = "capture-overlay";
pub const MAX_CAPTURE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CAPTURE_PIXELS: u64 = 32 * 1024 * 1024;
static CAPTURE_BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub struct CapturedScreenshot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub anchor: ScreenPoint,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureError {
    pub code: String,
    pub detail: String,
}

impl CaptureError {
    pub fn new(code: &str, detail: impl ToString) -> Self {
        Self {
            code: code.into(),
            detail: detail.to_string(),
        }
    }

    fn failed(detail: impl ToString) -> Self {
        Self::new("capture_failed", detail)
    }

    fn expired() -> Self {
        Self::new(
            "capture_expired",
            "The screenshot session is no longer active",
        )
    }
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for CaptureError {}

struct BusyGuard;

impl BusyGuard {
    fn acquire() -> Result<Self, CaptureError> {
        CAPTURE_BUSY
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                CaptureError::new("capture_busy", "A screenshot is already in progress")
            })?;
        Ok(Self)
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        CAPTURE_BUSY.store(false, Ordering::Release);
    }
}

/// Captures one user-selected rectangle without writing a persistent attachment.
pub async fn capture(app: &AppHandle) -> Result<Option<CapturedScreenshot>, CaptureError> {
    let _busy = BusyGuard::acquire()?;
    #[cfg(target_os = "macos")]
    return macos::capture(app).await;
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        #[cfg(target_os = "linux")]
        linux::ensure_x11()?;
        let target = geometry::CaptureTarget::under_cursor(app)?;
        let capture_target = target.clone();
        let (frame, png) = tauri::async_runtime::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            let frame = windows::capture_monitor(&capture_target)?;
            #[cfg(target_os = "linux")]
            let frame = linux::capture_monitor(&capture_target)?;
            let png = encode_overlay_preview(&frame)?;
            Ok::<_, CaptureError>((frame, png))
        })
        .await
        .map_err(CaptureError::failed)??;
        overlay::choose(app, target, frame, png).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err(CaptureError::new(
        "capture_unavailable",
        "Screen capture is not supported on this platform",
    ))
}

pub fn pointer_anchor(app: &AppHandle) -> Result<ScreenPoint, CaptureError> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        macos::pointer_anchor()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let point = app.cursor_position().map_err(CaptureError::failed)?;
        Ok(ScreenPoint {
            x: point.x,
            y: point.y,
        })
    }
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), CaptureError> {
    if width == 0 || height == 0 {
        return Err(CaptureError::failed("The screenshot has no pixels"));
    }
    if u64::from(width) * u64::from(height) > MAX_CAPTURE_PIXELS {
        return Err(CaptureError::new(
            "capture_too_large",
            "The screenshot exceeds 32 megapixels",
        ));
    }
    Ok(())
}

fn encode_png(frame: &RgbaImage) -> Result<Vec<u8>, CaptureError> {
    validate_dimensions(frame.width(), frame.height())?;
    let mut encoded = Cursor::new(Vec::new());
    frame
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(CaptureError::failed)?;
    let png = encoded.into_inner();
    validate_encoded_size(png.len())?;
    Ok(png)
}

fn encode_overlay_preview(frame: &RgbaImage) -> Result<Vec<u8>, CaptureError> {
    // Only the selector preview is bounded; the selected image keeps its original pixels.
    // A full 8K PNG can exceed the attachment limit before the user can select a small area.
    if frame.width() > 2560 || frame.height() > 2560 {
        return encode_png(&image::imageops::thumbnail(frame, 2560, 2560));
    }
    encode_png(frame)
}

fn validate_encoded_size(bytes: usize) -> Result<(), CaptureError> {
    if bytes > MAX_CAPTURE_BYTES {
        return Err(CaptureError::new(
            "capture_too_large",
            "The screenshot exceeds 32 MiB",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_capture_can_run_and_its_lock_is_released() {
        let first = BusyGuard::acquire().unwrap();
        assert_eq!(BusyGuard::acquire().err().unwrap().code, "capture_busy");
        drop(first);
        assert!(BusyGuard::acquire().is_ok());
    }

    #[test]
    fn screenshot_limits_and_png_encoding_are_enforced() {
        assert!(validate_dimensions(0, 20).is_err());
        assert_eq!(
            validate_dimensions(u32::MAX, u32::MAX).unwrap_err().code,
            "capture_too_large"
        );
        assert!(validate_dimensions(7680, 4320).is_ok());
        assert_eq!(
            validate_encoded_size(MAX_CAPTURE_BYTES + 1)
                .unwrap_err()
                .code,
            "capture_too_large"
        );
        let frame = RgbaImage::from_pixel(3, 2, image::Rgba([11, 22, 33, 255]));
        let decoded = image::load_from_memory(&encode_png(&frame).unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(decoded, frame);
        let wide = RgbaImage::new(3000, 1);
        let preview = image::load_from_memory(&encode_overlay_preview(&wide).unwrap()).unwrap();
        assert_eq!(preview.width(), 2560);
        assert_eq!(wide.width(), 3000);
    }
}
