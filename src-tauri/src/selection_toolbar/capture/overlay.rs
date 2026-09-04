use std::sync::{Mutex, MutexGuard, OnceLock};

use image::RgbaImage;
use serde::Serialize;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::oneshot;

use super::{
    encode_png,
    geometry::{CaptureRegion, CaptureTarget},
    CaptureError, CapturedScreenshot, OVERLAY_LABEL,
};

type CaptureResult = Result<Option<CapturedScreenshot>, CaptureError>;

struct PendingCapture {
    id: String,
    target: CaptureTarget,
    frame: RgbaImage,
    png: Vec<u8>,
    language: String,
    completion: oneshot::Sender<CaptureResult>,
}

// ponytail: only one interactive capture exists; no image cache or persistent attachment store.
static PENDING: OnceLock<Mutex<Option<PendingCapture>>> = OnceLock::new();

fn pending() -> Result<MutexGuard<'static, Option<PendingCapture>>, CaptureError> {
    PENDING
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| CaptureError::failed("The screenshot session lock was poisoned"))
}

struct OverlayGuard {
    app: AppHandle,
    id: String,
}

impl Drop for OverlayGuard {
    fn drop(&mut self) {
        match pending() {
            Ok(mut state) if state.as_ref().is_some_and(|capture| capture.id == self.id) => {
                state.take();
            }
            Ok(_) => {}
            Err(error) => tracing::error!(%error, "Failed to release screenshot frame"),
        }
        if let Some(window) = self.app.get_webview_window(OVERLAY_LABEL) {
            if let Err(error) = window.destroy() {
                tracing::error!(%error, "Failed to destroy screenshot overlay");
            }
        }
    }
}

pub(super) async fn choose(
    app: &AppHandle,
    target: CaptureTarget,
    frame: RgbaImage,
    png: Vec<u8>,
) -> CaptureResult {
    target.ensure_current(app)?;
    let database = app.state::<crate::AppState>().sea_db.clone();
    let language = aqbot_core::repo::settings::get_settings(&database)
        .await
        .map_err(CaptureError::failed)?
        .language;
    let id = uuid::Uuid::new_v4().to_string();
    let (completion, receiver) = oneshot::channel();
    {
        let mut state = pending()?;
        if state.is_some() {
            return Err(CaptureError::new(
                "capture_busy",
                "A screenshot is already awaiting selection",
            ));
        }
        *state = Some(PendingCapture {
            id: id.clone(),
            target: target.clone(),
            frame,
            png,
            language,
            completion,
        });
    }
    let _guard = OverlayGuard {
        app: app.clone(),
        id: id.clone(),
    };
    open_window(app, &target, id)?;
    receiver.await.map_err(CaptureError::failed)?
}

fn open_window(app: &AppHandle, target: &CaptureTarget, id: String) -> Result<(), CaptureError> {
    let window =
        WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
            .title("AQBot")
            .visible(false)
            .focused(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .shadow(false)
            .background_color(tauri::window::Color(16, 16, 16, 255))
            .build()
            .map_err(CaptureError::failed)?;
    window
        .set_position(PhysicalPosition::new(target.x, target.y))
        .map_err(CaptureError::failed)?;
    window
        .set_size(PhysicalSize::new(target.width, target.height))
        .map_err(CaptureError::failed)?;
    window.set_fullscreen(true).map_err(CaptureError::failed)?;
    window.on_window_event(move |event| handle_window_event(&id, event));
    window.show().map_err(CaptureError::failed)?;
    window.set_focus().map_err(CaptureError::failed)?;
    Ok(())
}

fn event_result(event: &WindowEvent) -> Option<CaptureResult> {
    // Fullscreen positioning is asynchronous; queued initial geometry events are not
    // evidence of a topology change. Validate the actual window and monitor on confirm.
    matches!(
        event,
        WindowEvent::Destroyed | WindowEvent::CloseRequested { .. }
    )
    .then_some(Ok(None))
}

fn handle_window_event(id: &str, event: &WindowEvent) {
    let result = (|| {
        let mut state = pending()?;
        active(&state, id)?;
        let Some(result) = event_result(event) else {
            return Ok(());
        };
        if let Some(capture) = state.take() {
            let _ = capture.completion.send(result);
        }
        Ok::<_, CaptureError>(())
    })();
    if let Err(error) = result {
        if error.code != "capture_expired" {
            tracing::error!(%error, "Failed to handle screenshot overlay lifecycle");
        }
    }
}

fn authorize(label: &str) -> Result<(), CaptureError> {
    if label != OVERLAY_LABEL {
        return Err(CaptureError::new(
            "capture_unavailable",
            "Screenshot commands are restricted to the capture overlay",
        ));
    }
    Ok(())
}

fn active<'a>(
    state: &'a Option<PendingCapture>,
    id: &str,
) -> Result<&'a PendingCapture, CaptureError> {
    state
        .as_ref()
        .filter(|capture| capture.id == id)
        .ok_or_else(CaptureError::expired)
}

#[derive(Serialize)]
pub struct CaptureSnapshot {
    capture_id: String,
    // Original pixels, not the potentially downsampled selector preview dimensions.
    width: u32,
    height: u32,
    language: String,
}

#[tauri::command]
pub fn capture_overlay_snapshot(window: WebviewWindow) -> Result<CaptureSnapshot, CaptureError> {
    authorize(window.label())?;
    let state = pending()?;
    let capture = state.as_ref().ok_or_else(CaptureError::expired)?;
    Ok(CaptureSnapshot {
        capture_id: capture.id.clone(),
        width: capture.frame.width(),
        height: capture.frame.height(),
        language: capture.language.clone(),
    })
}

#[tauri::command]
pub async fn capture_overlay_image(
    window: WebviewWindow,
    capture_id: String,
) -> Result<tauri::ipc::Response, CaptureError> {
    authorize(window.label())?;
    let state = pending()?;
    let capture = active(&state, &capture_id)?;
    Ok(tauri::ipc::Response::new(capture.png.clone()))
}

#[tauri::command]
pub async fn capture_overlay_confirm(
    window: WebviewWindow,
    capture_id: String,
    region: CaptureRegion,
) -> Result<(), CaptureError> {
    authorize(window.label())?;
    let target = active(&*pending()?, &capture_id)?.target.clone();
    let topology = target.ensure_overlay(&window);
    if let Err(error) = topology {
        let mut state = pending()?;
        active(&state, &capture_id)?;
        if let Some(capture) = state.take() {
            let _ = capture.completion.send(Err(error.clone()));
        }
        return Err(error);
    }
    let capture = {
        let mut state = pending()?;
        let capture = active(&state, &capture_id)?;
        region.validate(capture.frame.width(), capture.frame.height())?;
        state.take().ok_or_else(CaptureError::expired)?
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let cropped = image::imageops::crop_imm(
            &capture.frame,
            region.x,
            region.y,
            region.width,
            region.height,
        )
        .to_image();
        let screenshot = encode_png(&cropped).map(|png| {
            Some(CapturedScreenshot {
                png,
                width: region.width,
                height: region.height,
                anchor: capture.target.anchor(region),
            })
        });
        (capture.completion, screenshot)
    })
    .await
    .map_err(CaptureError::failed)?;
    let (completion, screenshot) = result;
    let error = screenshot.as_ref().err().cloned();
    completion
        .send(screenshot)
        .map_err(|_| CaptureError::expired())?;
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn capture_overlay_cancel(
    window: WebviewWindow,
    capture_id: String,
) -> Result<(), CaptureError> {
    authorize(window.label())?;
    let mut state = pending()?;
    active(&state, &capture_id)?;
    let capture = state.take().ok_or_else(CaptureError::expired)?;
    capture
        .completion
        .send(Ok(None))
        .map_err(|_| CaptureError::expired())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_capture() -> PendingCapture {
        let (completion, _) = oneshot::channel();
        PendingCapture {
            id: "current".into(),
            target: CaptureTarget {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
                scale_factor: 1.5,
                name: None,
            },
            frame: RgbaImage::new(1, 1),
            png: vec![],
            language: "en-US".into(),
            completion,
        }
    }

    #[test]
    fn stale_ids_are_rejected_and_initial_geometry_events_do_not_cancel() {
        assert!(authorize(OVERLAY_LABEL).is_ok());
        assert_eq!(authorize("main").unwrap_err().code, "capture_unavailable");
        assert!(authorize("selection-toolbar").is_err());
        let state = Some(pending_capture());
        assert_eq!(
            active(&state, "stale").err().unwrap().code,
            "capture_expired"
        );
        assert!(active(&state, "current").is_ok());
        assert!(event_result(&WindowEvent::Moved(PhysicalPosition::new(-1920, 0))).is_none());
        assert!(event_result(&WindowEvent::Resized(PhysicalSize::new(1920, 1080))).is_none());
        assert!(event_result(&WindowEvent::Resized(PhysicalSize::new(1280, 720))).is_none());
        assert!(event_result(&WindowEvent::Destroyed)
            .unwrap()
            .unwrap()
            .is_none());
    }
}
