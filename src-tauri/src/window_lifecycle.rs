use crate::{window_state, AppState};
use std::sync::atomic::Ordering;
use tauri::{LogicalPosition, LogicalSize, Manager, Position, Size, WebviewWindow};

const MAIN_WINDOW_LABEL: &str = "main";

pub fn configure_main_window(app: &tauri::AppHandle, main_window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    if let Err(error) = crate::linux_webkit::enable_input_method_preedit(main_window) {
        tracing::warn!(
            error = %error,
            "Failed to enable WebKitGTK input method preedit"
        );
    }

    // On Windows, hide native decorations so the custom TitleBar is
    // the only title bar. macOS keeps its Overlay style (traffic lights).
    // After removing decorations, re-enable minimize/maximize capabilities
    // since set_decorations(false) strips the WS_MINIMIZEBOX/WS_MAXIMIZEBOX styles.
    #[cfg(target_os = "windows")]
    {
        let _ = main_window.set_decorations(false);
        let _ = main_window.set_minimizable(true);
        let _ = main_window.set_maximizable(true);
    }

    let state = app.state::<AppState>();
    if let Some(saved_state) = window_state::load_window_state(&state.app_data_dir) {
        let restored_state = if let Ok(Some(monitor)) = main_window.current_monitor() {
            let monitor_size = monitor
                .size()
                .to_logical::<f64>(main_window.scale_factor().unwrap_or(1.0));
            window_state::clamp_window_state_to_monitor(
                saved_state,
                monitor_size.width,
                monitor_size.height,
            )
        } else {
            saved_state
        };

        let _ = main_window.set_size(Size::Logical(LogicalSize::new(
            restored_state.width,
            restored_state.height,
        )));

        if let (Some(x), Some(y)) = (restored_state.x, restored_state.y) {
            let _ = main_window.set_position(Position::Logical(LogicalPosition::new(x, y)));
        } else {
            let _ = main_window.center();
        }

        if restored_state.fullscreen {
            let _ = main_window.set_fullscreen(true);
        } else if restored_state.maximized {
            let _ = main_window.maximize();
        }
    }
}

pub fn ensure_main_window_for_setup(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        tracing::info!("AQBot main window found during setup");
        configure_main_window(app, &main_window);
        tracing::info!("AQBot main window configured");
        return Ok(());
    }

    tracing::warn!("AQBot main window was not found during setup");

    #[cfg(target_os = "linux")]
    if crate::linux_webkit::should_create_main_window_in_setup() {
        tracing::info!("Creating AQBot main window manually during Linux setup");
        let main_window = create_main_window_from_config(app)?;
        tracing::info!("AQBot main window manually created during Linux setup");
        configure_main_window(app, &main_window);
        tracing::info!("AQBot main window configured");
    }

    Ok(())
}

pub fn release_main_window_to_tray(window: &tauri::Window) -> Result<(), String> {
    let app = window.app_handle();
    if should_release_webview(&app) {
        mark_main_window_released(&app, true);
        if let Err(err) = window.destroy() {
            mark_main_window_released(&app, false);
            return Err(err.to_string());
        }
        set_app_dock_visibility(&app, false);
    } else {
        // Hide from taskbar before hide so Windows doesn't keep a ghost button.
        set_skip_taskbar(window, true);
        window.hide().map_err(|err| err.to_string())?;
        set_app_dock_visibility(&app, false);
    }
    app.state::<crate::startup_diagnostics::StartupPhase>()
        .cancel_presentation();
    Ok(())
}

pub fn release_webview_window_to_tray(window: &WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    if should_release_webview(&app) {
        mark_main_window_released(&app, true);
        if let Err(err) = window.destroy() {
            mark_main_window_released(&app, false);
            return Err(err.to_string());
        }
        set_app_dock_visibility(&app, false);
    } else {
        set_skip_taskbar(window, true);
        window.hide().map_err(|err| err.to_string())?;
        set_app_dock_visibility(&app, false);
    }
    app.state::<crate::startup_diagnostics::StartupPhase>()
        .cancel_presentation();
    Ok(())
}

pub fn minimize_main_window(window: tauri::Window) -> Result<(), String> {
    let app = window.app_handle();
    if window.label() == MAIN_WINDOW_LABEL && should_release_webview(&app) {
        release_main_window_to_tray(&window)
    } else {
        window.minimize().map_err(|err| err.to_string())
    }
}

pub fn restore_main_window(app: &tauri::AppHandle) {
    // Restore Dock presence before showing so the window is findable again.
    set_app_dock_visibility(app, true);

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let state = app.state::<AppState>();
        state
            .main_window_released_to_tray
            .store(false, Ordering::Relaxed);
        set_skip_taskbar(&window, false);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let state = app.state::<AppState>();
    if state.main_window_restoring.swap(true, Ordering::Relaxed) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let result = restore_main_window_inner(&app);
        let state = app.state::<AppState>();
        if result.is_ok() {
            state
                .main_window_released_to_tray
                .store(false, Ordering::Relaxed);
        } else if let Err(err) = result {
            tracing::warn!("Failed to restore main window: {}", err);
        }
        state.main_window_restoring.store(false, Ordering::Relaxed);
    });
}

/// Hide or show the app in the macOS Dock when tray-hiding.
///
/// On macOS, a hidden window still keeps a Dock icon under the default
/// `Regular` activation policy. Switching to `Accessory` removes the Dock
/// icon while the process keeps running via the system tray.
pub(crate) fn set_app_dock_visibility(app: &tauri::AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        if let Err(err) = app.set_activation_policy(policy) {
            tracing::warn!(
                visible,
                error = %err,
                "Failed to update macOS activation policy for tray lifecycle"
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
    }
}

fn set_skip_taskbar(window: &impl SetSkipTaskbar, skip: bool) {
    window.apply_skip_taskbar(skip);
}

/// Thin wrapper so both `Window` and `WebviewWindow` can update taskbar visibility.
trait SetSkipTaskbar {
    fn apply_skip_taskbar(&self, skip: bool);
}

impl SetSkipTaskbar for tauri::Window {
    fn apply_skip_taskbar(&self, skip: bool) {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if let Err(err) = self.set_skip_taskbar(skip) {
            tracing::warn!(
                skip,
                error = %err,
                "Failed to update taskbar visibility for tray lifecycle"
            );
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        let _ = skip;
    }
}

impl SetSkipTaskbar for WebviewWindow {
    fn apply_skip_taskbar(&self, skip: bool) {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if let Err(err) = self.set_skip_taskbar(skip) {
            tracing::warn!(
                skip,
                error = %err,
                "Failed to update taskbar visibility for tray lifecycle"
            );
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        let _ = skip;
    }
}

fn restore_main_window_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let window = create_main_window_from_config(app)?;
    configure_main_window(app, &window);
    Ok(())
}

fn create_main_window_from_config(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window config not found".to_string())?;

    tracing::info!(
        label = %config.label,
        create = config.create,
        visible = config.visible,
        "Preparing AQBot main window builder from config"
    );
    let builder =
        tauri::WebviewWindowBuilder::from_config(app, config).map_err(|err| err.to_string())?;
    tracing::info!("AQBot main window builder created from config");
    let window = builder.build().map_err(|err| err.to_string())?;
    tracing::info!("AQBot main window WebView build completed");
    Ok(window)
}

pub(crate) fn effective_close_to_tray(
    tray_enabled: bool,
    tray_available: bool,
    minimize_to_tray: bool,
) -> bool {
    tray_enabled && tray_available && minimize_to_tray
}

pub(crate) fn effective_release_webview(
    tray_enabled: bool,
    tray_available: bool,
    minimize_to_tray: bool,
    release_webview_on_tray: bool,
) -> bool {
    effective_close_to_tray(tray_enabled, tray_available, minimize_to_tray) && release_webview_on_tray
}

fn should_release_webview(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    effective_release_webview(
        state.tray_enabled.load(Ordering::Relaxed),
        state.tray_available.load(Ordering::Relaxed),
        state.close_to_tray.load(Ordering::Relaxed),
        state.release_webview_on_tray.load(Ordering::Relaxed),
    )
}

#[cfg(test)]
pub(crate) fn should_release_webview_for_settings(
    close_to_tray: bool,
    release_webview_on_tray: bool,
) -> bool {
    close_to_tray && release_webview_on_tray
}

fn mark_main_window_released(app: &tauri::AppHandle, released: bool) {
    let state = app.state::<AppState>();
    state
        .main_window_released_to_tray
        .store(released, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::should_release_webview_for_settings;

    #[test]
    fn releases_webview_only_when_close_to_tray_and_release_setting_are_enabled() {
        assert!(should_release_webview_for_settings(true, true));
        assert!(!should_release_webview_for_settings(true, false));
        assert!(!should_release_webview_for_settings(false, true));
        assert!(!should_release_webview_for_settings(false, false));
    }

    #[test]
    fn close_to_tray_requires_enabled_and_available_tray() {
        assert!(super::effective_close_to_tray(true, true, true));
        assert!(!super::effective_close_to_tray(false, true, true));
        assert!(!super::effective_close_to_tray(true, false, true));
        assert!(!super::effective_close_to_tray(true, true, false));
        assert!(!super::effective_release_webview(true, true, true, false));
        assert!(super::effective_release_webview(true, true, true, true));
        assert!(!super::effective_release_webview(false, true, true, true));
    }
}
