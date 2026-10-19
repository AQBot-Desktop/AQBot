use super::{set_app_dock_visibility, set_skip_taskbar};
use crate::window_state::PersistedWindowState;
use std::sync::{Mutex, MutexGuard};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StartupWindowMode {
    Visible,
    Hidden,
    Minimized,
}

struct PresentationState {
    mode: StartupWindowMode,
    applied: bool,
    restore: Option<PersistedWindowState>,
}

/// Process state survives React remounts and tray WebView recreation.
pub struct MainWindowStartup(Mutex<PresentationState>);

impl MainWindowStartup {
    pub fn new(show_on_start: bool, start_minimized: bool) -> Self {
        let mode = if !show_on_start {
            StartupWindowMode::Hidden
        } else if start_minimized {
            StartupWindowMode::Minimized
        } else {
            StartupWindowMode::Visible
        };
        Self(Mutex::new(PresentationState {
            mode,
            applied: false,
            restore: None,
        }))
    }

    fn lock(&self) -> Result<MutexGuard<'_, PresentationState>, String> {
        self.0
            .lock()
            .map_err(|error| format!("Main window startup state poisoned: {error}"))
    }

    pub fn mode(&self) -> Result<StartupWindowMode, String> {
        Ok(self.lock()?.mode)
    }

    pub fn request_show(&self) -> Result<(), String> {
        let mut state = self.lock()?;
        state.mode = StartupWindowMode::Visible;
        state.applied = false;
        Ok(())
    }

    pub fn defer_restore(&self, saved: PersistedWindowState) -> Result<(), String> {
        self.lock()?.restore = Some(saved);
        Ok(())
    }

    pub fn has_deferred_restore(&self) -> Result<bool, String> {
        Ok(self.lock()?.restore.is_some())
    }

    fn begin_presentation(&self, force_visible: bool) -> Result<(StartupWindowMode, bool), String> {
        if force_visible {
            self.request_show()?;
        }
        let mut state = self.lock()?;
        let apply = !state.applied;
        state.applied = true;
        Ok((state.mode, apply))
    }
}

/// Called on the UI thread so startup and explicit restore cannot reorder native actions.
pub fn present_main_window(
    window: &WebviewWindow,
    force_visible: bool,
) -> Result<StartupWindowMode, String> {
    let app = window.app_handle();
    let startup = app.state::<MainWindowStartup>();
    let (mode, apply) = startup.begin_presentation(force_visible)?;
    if !apply {
        return Ok(mode);
    }
    match mode {
        StartupWindowMode::Hidden => {
            set_skip_taskbar(window, true);
            window.hide().map_err(|error| error.to_string())?;
            set_app_dock_visibility(app, false);
        }
        StartupWindowMode::Minimized => {
            // Keep saved maximized/fullscreen flags deferred: Tao reapplies them on show.
            set_skip_taskbar(window, false);
            show_minimized(window)?;
        }
        StartupWindowMode::Visible => {
            set_app_dock_visibility(app, true);
            set_skip_taskbar(window, false);
            window.unminimize().map_err(|error| error.to_string())?;
            restore_window_presentation(window)?;
            window.show().map_err(|error| error.to_string())?;
            if let Err(error) = window.set_focus() {
                tracing::warn!(%error, "Could not focus AQBot main window");
            }
        }
    }
    tracing::info!(?mode, "Applied AQBot main window startup presentation");
    Ok(mode)
}

#[cfg(not(target_os = "macos"))]
fn show_minimized(window: &WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn show_minimized(window: &WebviewWindow) -> Result<(), String> {
    let native = window.ns_window().map_err(|error| error.to_string())?;
    // AppKit ignores miniaturize on an unordered window; Tauri show would make it key.
    // SAFETY: Tauri owns this NSWindow and presentation runs on the main thread.
    let native = unsafe { &*native.cast::<objc2_app_kit::NSWindow>() };
    native.orderFront(None);
    native.miniaturize(None);
    Ok(())
}

pub(super) fn finish_configuration(window: &WebviewWindow) -> Result<(), String> {
    let startup = window.app_handle().state::<MainWindowStartup>();
    let already_visible = {
        let state = startup.lock()?;
        state.applied && state.mode == StartupWindowMode::Visible && state.restore.is_some()
    };
    if already_visible {
        restore_window_presentation(window)?;
    }
    Ok(())
}

fn restore_window_presentation(window: &WebviewWindow) -> Result<(), String> {
    let startup = window.app_handle().state::<MainWindowStartup>();
    // Drop the lock before native operations, which can synchronously emit window events.
    let saved = startup.lock()?.restore.take();
    if let Some(saved) = saved {
        if saved.fullscreen {
            window
                .set_fullscreen(true)
                .map_err(|error| error.to_string())?;
        } else if saved.maximized {
            window.maximize().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn should_save_window_state(window: &tauri::Window) -> Result<bool, String> {
    let startup = window.app_handle().state::<MainWindowStartup>();
    Ok(!startup.has_deferred_restore()?
        && window.is_visible().map_err(|error| error.to_string())?
        && !window.is_minimized().map_err(|error| error.to_string())?)
}

/// Taskbar/Dock restore is an explicit user action too, and may precede frontend readiness.
pub fn on_main_window_focus(window: &tauri::Window) -> Result<(), String> {
    let app = window.app_handle();
    if app.state::<MainWindowStartup>().mode()? != StartupWindowMode::Visible
        && window.is_visible().map_err(|error| error.to_string())?
        && !window.is_minimized().map_err(|error| error.to_string())?
    {
        super::restore_main_window(app);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
