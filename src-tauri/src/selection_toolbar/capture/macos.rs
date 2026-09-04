use std::io::Cursor;

use core_graphics::access::ScreenCaptureAccess;
use core_graphics::event::CGEvent;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use image::{ImageFormat, ImageReader};
use tauri::AppHandle;

use super::{
    validate_dimensions, validate_encoded_size, CaptureError, CapturedScreenshot, ScreenPoint,
};

pub(super) async fn capture(app: &AppHandle) -> Result<Option<CapturedScreenshot>, CaptureError> {
    request_permission(app).await?;
    let directory = tempfile::Builder::new()
        .prefix("aqbot-capture-")
        .tempdir()
        .map_err(CaptureError::failed)?;
    let path = directory.path().join("capture.png");
    let output = tokio::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-s", "-x", "-t", "png"])
        .arg(&path)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(CaptureError::failed)?;
    let exists = path.try_exists().map_err(CaptureError::failed)?;
    if !has_capture(
        output.status.code(),
        exists,
        &String::from_utf8_lossy(&output.stderr),
    )? {
        return Ok(None);
    }
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(CaptureError::failed)?
        .len();
    validate_encoded_size(usize::try_from(size).map_err(CaptureError::failed)?)?;
    let png = tokio::fs::read(&path).await.map_err(CaptureError::failed)?;
    let (width, height) = ImageReader::with_format(Cursor::new(&png), ImageFormat::Png)
        .into_dimensions()
        .map_err(CaptureError::failed)?;
    validate_dimensions(width, height)?;
    Ok(Some(CapturedScreenshot {
        png,
        width,
        height,
        anchor: pointer_anchor()?,
    }))
}

pub(super) fn pointer_anchor() -> Result<ScreenPoint, CaptureError> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| CaptureError::failed("Could not read the cursor position"))?;
    let point = CGEvent::new(source)
        .map_err(|_| CaptureError::failed("Could not read the cursor position"))?
        .location();
    // Quartz event locations use the same logical coordinates as the macOS toolbar.
    Ok(ScreenPoint {
        x: point.x,
        y: point.y,
    })
}

async fn request_permission(app: &AppHandle) -> Result<(), CaptureError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let permission = ScreenCaptureAccess;
        let allowed = permission.preflight() || permission.request();
        let _ = sender.send(allowed);
    })
    .map_err(CaptureError::failed)?;
    if !receiver.await.map_err(CaptureError::failed)? {
        return Err(CaptureError::new(
            "capture_permission_required",
            "Allow AQBot in macOS Screen Recording settings, then try again",
        ));
    }
    Ok(())
}

fn has_capture(status: Option<i32>, exists: bool, stderr: &str) -> Result<bool, CaptureError> {
    // Escape terminates the native picker without creating its output file.
    if status == Some(1) && !exists && stderr.trim().is_empty() {
        return Ok(false);
    }
    if status != Some(0) {
        return Err(CaptureError::failed(format!(
            "The system screenshot command failed ({status:?}): {}",
            stderr.trim()
        )));
    }
    if !exists {
        return Err(CaptureError::failed(
            "The screenshot was not saved; clipboard-only captures are not supported",
        ));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_cancel_is_not_confused_with_permission_or_clipboard_only_output() {
        assert!(!has_capture(Some(1), false, "").unwrap());
        assert!(has_capture(Some(0), true, "").unwrap());
        assert!(has_capture(Some(1), false, "screen capture denied").is_err());
        assert!(has_capture(Some(0), false, "").is_err());
        assert!(has_capture(None, false, "").is_err());
    }
}
