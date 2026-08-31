//! macOS nonactivating NSPanel for the selection toolbar.
//!
//! A regular Tauri `WebviewWindow` activates the whole AQBot app when clicked,
//! which brings the main window forward and breaks hover / tool clicks.
//! `tauri-nspanel` converts the toolbar into a NonactivatingPanel with mouse
//! tracking so the WebView can receive hover and first-click without activating
//! the application (TextGO / tauri-nspanel hover_activate pattern).
//!
//! **All AppKit / NSPanel mutations must run on the main thread.** Calling
//! `to_panel` from a tokio worker traps with "Must only be used from the main thread".

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, OnceLock,
};

use tauri::{AppHandle, Manager};
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, TrackingAreaOptions,
    WebviewWindowExt,
};

use super::window::SELECTION_TOOLBAR_WINDOW_LABEL;

tauri_panel! {
    panel!(SelectionToolbarPanel {
        config: {
            can_become_main_window: false,
            can_become_key_window: true,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
        with: {
            tracking_area: {
                options: TrackingAreaOptions::new()
                    .active_always()
                    .mouse_entered_and_exited()
                    .mouse_moved()
                    .cursor_update(),
                auto_resize: true
            }
        }
    })

    panel_event!(SelectionToolbarPanelEventHandler {})
}

static PANEL_CONFIGURED: OnceLock<()> = OnceLock::new();
static RESULT_INTERACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_result_interactive(interactive: bool) {
    RESULT_INTERACTIVE.store(interactive, Ordering::Relaxed);
}

/// Convert the selection-toolbar webview into a nonactivating floating panel once.
/// Safe to call from any thread — work is marshalled to the main thread.
pub fn ensure_panel(app: &AppHandle) -> Result<(), String> {
    if app
        .get_webview_panel(SELECTION_TOOLBAR_WINDOW_LABEL)
        .is_ok()
    {
        return Ok(());
    }

    run_on_main_blocking(app, |handle| ensure_panel_on_main(handle))
}

fn ensure_panel_on_main(app: &AppHandle) -> Result<(), String> {
    if app
        .get_webview_panel(SELECTION_TOOLBAR_WINDOW_LABEL)
        .is_ok()
    {
        return Ok(());
    }

    let window = app
        .get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL)
        .ok_or_else(|| "Selection toolbar window is not available".to_string())?;

    let panel = window
        .to_panel::<SelectionToolbarPanel>()
        .map_err(|error| error.to_string())?;

    panel.set_level(PanelLevel::Floating.value());
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .into(),
    );
    panel.set_hides_on_deactivate(false);
    panel.set_works_when_modal(true);
    panel.set_floating_panel(true);
    panel.set_becomes_key_only_if_needed(true);
    panel.set_accepts_mouse_moved_events(true);
    panel.set_has_shadow(false);
    panel.set_transparent(true);

    if PANEL_CONFIGURED.set(()).is_ok() {
        let handler = SelectionToolbarPanelEventHandler::new();
        let enter_handle = app.clone();
        handler.on_mouse_entered(move |_event| {
            if let Err(error) = make_key_window(&enter_handle) {
                tracing::error!(%error, "Could not make selection toolbar panel key");
            } else {
                tracing::debug!("selection toolbar panel mouse entered → make_key");
            }
        });
        let exit_handle = app.clone();
        handler.on_mouse_exited(move |_event| {
            if RESULT_INTERACTIVE.load(Ordering::Relaxed) {
                tracing::debug!("selection toolbar result mouse exited → keep_key");
                return;
            }
            if let Err(error) = resign_key_window(&exit_handle) {
                tracing::error!(%error, "Could not resign selection toolbar panel key");
            } else {
                tracing::debug!("selection toolbar panel mouse exited → resign_key");
            }
        });
        panel.set_event_handler(Some(handler.as_ref()));
    }

    tracing::info!("selection toolbar converted to nonactivating NSPanel");
    Ok(())
}

/// Show the panel on the main thread without activating AQBot.
pub fn order_front(app: &AppHandle) -> Result<(), String> {
    run_on_main_blocking(app, |handle| {
        let panel = handle
            .get_webview_panel(SELECTION_TOOLBAR_WINDOW_LABEL)
            .map_err(|error| format!("Selection toolbar panel is unavailable: {error:?}"))?;
        panel.order_front_regardless();
        Ok(())
    })
}

/// Hide the panel on the main thread.
pub fn hide_panel(app: &AppHandle) -> Result<(), String> {
    run_on_main_blocking(app, |handle| {
        match handle.get_webview_panel(SELECTION_TOOLBAR_WINDOW_LABEL) {
            Ok(panel) => {
                panel.hide();
                Ok(())
            }
            Err(_)
                if handle
                    .get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL)
                    .is_none() =>
            {
                Ok(())
            }
            Err(error) => Err(format!("Selection toolbar panel is unavailable: {error:?}")),
        }
    })
}

/// Visibility check that does not call AppKit panel APIs from a worker thread.
/// Prefer Tauri webview visibility (runtime-marshalled) when panel APIs are unsafe here.
pub fn is_panel_visible(app: &AppHandle) -> bool {
    app.get_webview_window(SELECTION_TOOLBAR_WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Make the nonactivating panel the key window so its controls respond to the
/// first click/keystroke. Does not activate AQBot (Spotlight-style panel).
pub fn make_key_window(app: &AppHandle) -> Result<(), String> {
    run_on_main_blocking(app, |handle| {
        let panel = handle
            .get_webview_panel(SELECTION_TOOLBAR_WINDOW_LABEL)
            .map_err(|error| format!("Selection toolbar panel is unavailable: {error:?}"))?;
        panel.make_key_window();
        Ok(())
    })
}

pub fn resign_key_window(app: &AppHandle) -> Result<(), String> {
    run_on_main_blocking(app, |handle| {
        let panel = handle
            .get_webview_panel(SELECTION_TOOLBAR_WINDOW_LABEL)
            .map_err(|error| format!("Selection toolbar panel is unavailable: {error:?}"))?;
        panel.resign_key_window();
        Ok(())
    })
}

fn run_on_main_blocking<T, F>(app: &AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
{
    // If we are already on the main thread, run inline (avoids deadlock with
    // run_on_main_thread + blocking recv on the same thread).
    if is_main_thread() {
        return work(app);
    }

    let (sender, receiver) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = work(&handle);
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;

    receiver
        .recv()
        .map_err(|_| "Main-thread panel task did not complete".to_string())?
}

fn is_main_thread() -> bool {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;

    // SAFETY: NSThread is a system class; isMainThread is a class method returning BOOL.
    let Some(class) = AnyClass::get(c"NSThread") else {
        return false;
    };
    let is_main: bool = unsafe { msg_send![class, isMainThread] };
    is_main
}
