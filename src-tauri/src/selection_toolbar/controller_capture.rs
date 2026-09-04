use super::*;
use crate::selection_toolbar::{capture, CaptureErrorView, SELECTION_TOOLBAR_WINDOW_LABEL};

struct CapturePresentation {
    generation: u64,
    was_visible: bool,
    position: Option<ScreenPoint>,
}

/// Native ownership and frontend auto-dismiss suspension have the same lifetime.
struct CaptureLease<'a> {
    flag: &'a AtomicBool,
    app: &'a AppHandle,
}

impl Drop for CaptureLease<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
        if let Err(error) = self.app.emit_to(
            SELECTION_TOOLBAR_WINDOW_LABEL,
            "selection-toolbar://capture-end",
            (),
        ) {
            tracing::warn!(%error, "Could not announce screenshot completion");
        }
    }
}

impl SelectionToolbarRuntime {
    pub async fn capture_screenshot(&self, app: &AppHandle) -> Result<(), String> {
        let settings =
            aqbot_core::repo::settings::get_settings(&app.state::<crate::AppState>().sea_db)
                .await
                .map_err(|error| error.to_string())?;
        if !settings.selection_toolbar.enabled || !settings.global_shortcuts_enabled {
            return Err("Screenshot capture is disabled".into());
        }
        let presentation_guard = self.presentation_lock.lock().await;
        if self
            .capturing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            tracing::debug!("Ignoring repeated screenshot shortcut during capture");
            return Ok(());
        }
        let _lease = CaptureLease {
            flag: &self.capturing,
            app,
        };
        if toolbar_tool_views(&settings, ToolbarInputKind::Screenshot).is_empty() {
            drop(presentation_guard);
            return self
                .show_capture_error(
                    app,
                    &settings,
                    capture::CaptureError {
                        code: "capture_unavailable".into(),
                        detail: "No enabled AI tools can accept a screenshot".into(),
                    },
                    None,
                )
                .await;
        }
        let previous = CapturePresentation {
            generation: self.generation.fetch_add(1, Ordering::Relaxed) + 1,
            was_visible: window::is_toolbar_visible_for_suppress(app),
            position: window::current_screen_position(app),
        };
        self.debouncer.lock().await.clear();
        self.store.lock().await.set_capture_error(None);
        app.emit_to(
            SELECTION_TOOLBAR_WINDOW_LABEL,
            "selection-toolbar://capture-start",
            (),
        )
        .map_err(|error| error.to_string())?;
        window::hide(app)?;
        drop(presentation_guard);
        self.capture_and_restore(app, &settings, &previous).await
    }

    async fn capture_and_restore(
        &self,
        app: &AppHandle,
        settings: &AppSettings,
        previous: &CapturePresentation,
    ) -> Result<(), String> {
        let outcome = capture::capture(app).await;
        if self.generation.load(Ordering::Relaxed) != previous.generation {
            return Ok(());
        }
        let error = match outcome {
            Ok(Some(screenshot)) => {
                match self
                    .publish_capture(app, screenshot, previous.generation)
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(detail) => Some(capture::CaptureError {
                        code: "capture_failed".into(),
                        detail,
                    }),
                }
            }
            Ok(None) => None,
            Err(error) => Some(error),
        };
        self.restore_after_capture(app, previous).await?;
        if let Some(error) = error {
            self.show_capture_error(app, settings, error, Some(previous.generation))
                .await?;
        }
        Ok(())
    }

    async fn publish_capture(
        &self,
        app: &AppHandle,
        screenshot: capture::CapturedScreenshot,
        generation: u64,
    ) -> Result<(), String> {
        let settings =
            aqbot_core::repo::settings::get_settings(&app.state::<crate::AppState>().sea_db)
                .await
                .map_err(|error| error.to_string())?;
        if !settings.selection_toolbar.enabled {
            return Ok(());
        }
        let input = ToolbarInput::Screenshot {
            png: screenshot.png.into(),
            width: screenshot.width,
            height: screenshot.height,
            anchor: screenshot.anchor,
        };
        self.show_input(app, input, &settings, Some(generation))
            .await
    }

    async fn restore_after_capture(
        &self,
        app: &AppHandle,
        previous: &CapturePresentation,
    ) -> Result<(), String> {
        let _presentation_guard = self.presentation_lock.lock().await;
        if !previous.was_visible || self.generation.load(Ordering::Relaxed) != previous.generation {
            return Ok(());
        }
        let position = previous
            .position
            .ok_or_else(|| "The previous toolbar position is unavailable".to_string())?;
        let surface = *self.surface.lock().await;
        let position = window::show_surface_at_position(
            app,
            position,
            surface,
            *self.toolbar_width.lock().await,
        )?;
        *self.last_window_position.lock().await = Some(position);
        if surface == SurfaceSize::Result {
            window::focus_surface(app)?;
        }
        Ok(())
    }

    async fn show_capture_error(
        &self,
        app: &AppHandle,
        settings: &AppSettings,
        error: capture::CaptureError,
        generation: Option<u64>,
    ) -> Result<(), String> {
        let _presentation_guard = self.presentation_lock.lock().await;
        if generation.is_some_and(|expected| self.generation.load(Ordering::Relaxed) != expected) {
            return Ok(());
        }
        tracing::warn!(code = %error.code, detail = %error.detail, "Screenshot capture failed");
        let error = CaptureErrorView {
            code: error.code,
            detail: error.detail,
            language: settings.language.clone(),
            theme: toolbar_theme(app, settings).into(),
        };
        self.store
            .lock()
            .await
            .set_capture_error(Some(error.clone()));
        let position = match *self.last_window_position.lock().await {
            Some(position) => position,
            None => capture::pointer_anchor(app).map_err(|error| error.detail)?,
        };
        let position = window::show_surface_at_position(
            app,
            position,
            SurfaceSize::Result,
            *self.toolbar_width.lock().await,
        )?;
        *self.surface.lock().await = SurfaceSize::Result;
        *self.last_window_position.lock().await = Some(position);
        window::focus_surface(app)?;
        app.emit_to(
            SELECTION_TOOLBAR_WINDOW_LABEL,
            "selection-toolbar://capture-error",
            error,
        )
        .map_err(|error| error.to_string())
    }
}
