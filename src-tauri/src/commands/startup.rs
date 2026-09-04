use crate::startup_diagnostics::{StartupPhase, StartupPresentation};

/// The calling window is injected by Tauri, never supplied by the frontend.
#[tauri::command]
pub async fn report_startup_presented(
    window: tauri::WebviewWindow,
    phase: tauri::State<'_, StartupPhase>,
    kind: StartupPresentation,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can confirm startup presentation".into());
    }

    phase.set("frontend.verify_visibility");
    // This getter can wait for the UI thread, so it must not run in the watchdog.
    let visibility = window.is_visible().map_err(|error| error.to_string());
    // A user may have hidden or released the window while this query was queued.
    if phase.presentation_cancelled() {
        return Ok(());
    }
    match require_visible_window(visibility) {
        Ok(()) => {
            phase.mark_presented(kind);
            Ok(())
        }
        Err(error) => {
            phase.fail(&std::io::Error::other(error.clone()));
            Err(error)
        }
    }
}

fn require_visible_window(visibility: Result<bool, String>) -> Result<(), String> {
    match visibility {
        Ok(true) => Ok(()),
        Ok(false) => Err("AQBot main window is not visible after frontend presentation".into()),
        Err(error) => Err(format!("Could not verify AQBot main window visibility: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::require_visible_window;

    #[test]
    fn hidden_or_unreadable_windows_cannot_confirm_startup() {
        assert!(require_visible_window(Ok(false)).is_err());
        assert!(require_visible_window(Err("window was destroyed".into()))
            .unwrap_err()
            .contains("window was destroyed"));
        assert!(require_visible_window(Ok(true)).is_ok());
    }
}
