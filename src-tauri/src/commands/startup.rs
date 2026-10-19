use crate::startup_diagnostics::{StartupPhase, StartupPresentation};
use crate::window_lifecycle::{MainWindowStartup, StartupWindowMode};
use tauri::Manager;

#[tauri::command]
pub async fn present_startup_window(
    window: tauri::WebviewWindow,
    force_visible: bool,
) -> Result<StartupWindowMode, String> {
    if window.label() != "main" {
        return Err("Only the main window can apply startup presentation".into());
    }
    let app = window.app_handle().clone();
    let result = on_main_thread(&app, move || {
        crate::window_lifecycle::present_main_window(&window, force_visible)
    })
    .await;
    if let Err(error) = &result {
        app.state::<StartupPhase>()
            .fail(&std::io::Error::other(error.clone()));
    }
    result
}

/// The calling window is injected by Tauri, never supplied by the frontend.
#[tauri::command]
pub async fn report_startup_presented(
    window: tauri::WebviewWindow,
    kind: StartupPresentation,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can confirm startup presentation".into());
    }

    let app = window.app_handle().clone();
    on_main_thread(&app, move || verify_main_window(&window, kind)).await
}

async fn on_main_thread<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        if sender.send(work()).is_err() {
            tracing::debug!("Startup presentation caller disconnected");
        }
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

fn verify_main_window(
    window: &tauri::WebviewWindow,
    kind: StartupPresentation,
) -> Result<(), String> {
    let phase = window.app_handle().state::<StartupPhase>();
    phase.set("frontend.verify_visibility");
    // Query intent and native state together, serialized with explicit restore actions.
    let visibility = window.is_visible().map_err(|error| error.to_string());
    let mode = window.app_handle().state::<MainWindowStartup>().mode()?;
    let minimized = if mode == StartupWindowMode::Minimized {
        window.is_minimized().map_err(|error| error.to_string())
    } else {
        Ok(false)
    };
    // A user may have hidden or released the window while this query was queued.
    if phase.presentation_cancelled() {
        return Ok(());
    }
    match require_window_presentation(mode, visibility, minimized) {
        Ok(visible) => {
            phase.mark_presented(kind, visible);
            Ok(())
        }
        Err(error) => {
            phase.fail(&std::io::Error::other(error.clone()));
            Err(error)
        }
    }
}

fn require_window_presentation(
    mode: StartupWindowMode,
    visibility: Result<bool, String>,
    minimized: Result<bool, String>,
) -> Result<bool, String> {
    let visible = visibility
        .map_err(|error| format!("Could not verify AQBot main window visibility: {error}"))?;
    let minimized = minimized
        .map_err(|error| format!("Could not verify AQBot main window minimization: {error}"))?;
    let matches = match mode {
        StartupWindowMode::Hidden => !visible,
        StartupWindowMode::Visible => visible,
        // AppKit miniaturization animates asynchronously, then is_visible becomes false.
        StartupWindowMode::Minimized if cfg!(target_os = "macos") => visible || minimized,
        StartupWindowMode::Minimized => visible && minimized,
    };
    if matches {
        Ok(visible)
    } else {
        Err(format!("AQBot main window does not match {mode:?} startup presentation: visible={visible}, minimized={minimized}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_requested_native_presentation_can_confirm_startup() {
        use StartupWindowMode::*;
        assert!(require_window_presentation(Visible, Ok(false), Ok(false)).is_err());
        assert!(require_window_presentation(
            Visible,
            Err("window was destroyed".into()),
            Ok(false)
        )
        .unwrap_err()
        .contains("window was destroyed"));
        assert_eq!(
            require_window_presentation(Visible, Ok(true), Ok(false)),
            Ok(true)
        );
        assert_eq!(
            require_window_presentation(Hidden, Ok(false), Ok(false)),
            Ok(false)
        );
        assert!(require_window_presentation(Hidden, Ok(true), Ok(false)).is_err());
        assert_eq!(
            require_window_presentation(Minimized, Ok(true), Ok(true)),
            Ok(true)
        );
        for (visible, minimized) in [(true, false), (false, true)] {
            assert_eq!(
                require_window_presentation(Minimized, Ok(visible), Ok(minimized)).is_ok(),
                cfg!(target_os = "macos"),
            );
        }
        assert!(require_window_presentation(Minimized, Ok(false), Ok(false)).is_err());
        assert!(
            require_window_presentation(Minimized, Ok(true), Err("query failed".into())).is_err()
        );
    }
}
