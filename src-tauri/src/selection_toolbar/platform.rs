#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use aqbot_core::types::SelectionToolbarSettings;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use tokio::sync::{mpsc::UnboundedSender, watch};

use super::{PermissionState, RuntimeError, ScreenPoint, SelectionObservation};

/// Process basenames for Windows apps that often lack a usable UIA TextPattern.
#[cfg(any(target_os = "windows", test))]
const WINDOWS_WEAK_UIA_PROCESS_MARKERS: &[&str] =
    &["wechat", "weixin", "wxwork", "wework", "wechatappex"];

#[cfg(any(target_os = "windows", test))]
fn should_try_windows_clipboard_fallback(attempt: usize, process_name: Option<&str>) -> bool {
    // This path synthesizes Ctrl+C, so it must never be a generic final probe.
    attempt == 0
        && process_name.is_some_and(|name| {
            let lowered = name.to_ascii_lowercase();
            WINDOWS_WEAK_UIA_PROCESS_MARKERS
                .iter()
                .any(|marker| lowered.contains(marker))
        })
}

#[cfg(any(target_os = "windows", test))]
fn is_windows_copy_target_active(
    target_process_id: u32,
    foreground_process_id: Option<u32>,
) -> bool {
    target_process_id != 0 && foreground_process_id == Some(target_process_id)
}

/// Why the platform requested closing the toolbar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DismissReason {
    /// The user pressed Escape: always close.
    Escape,
    /// The foreground application changed / was hidden / minimized. While the
    /// result panel is open this must NOT close the toolbar — only an outside
    /// click, Escape or the close button may.
    AppChanged,
}

#[derive(Debug)]
pub enum PlatformEvent {
    Selection(SelectionObservation),
    Clear,
    Dismiss(DismissReason),
    GlobalPointerDown(ScreenPoint),
    Error(RuntimeError),
}

pub struct PlatformMonitorHandle {
    stop: Option<Box<dyn FnOnce() + Send>>,
}

impl PlatformMonitorHandle {
    pub fn new(stop: impl FnOnce() + Send + 'static) -> Self {
        Self {
            stop: Some(Box::new(stop)),
        }
    }

    pub fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

impl Drop for PlatformMonitorHandle {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

#[derive(Debug)]
pub struct PlatformStartError {
    pub permission: PermissionState,
    pub error: RuntimeError,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{open_permission_settings, permission_state, request_permission, start_monitor};

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{open_permission_settings, permission_state, request_permission, start_monitor};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{open_permission_settings, permission_state, request_permission, start_monitor};

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn start_monitor(
    _sender: UnboundedSender<PlatformEvent>,
    _settings: watch::Receiver<SelectionToolbarSettings>,
) -> Result<PlatformMonitorHandle, PlatformStartError> {
    Err(PlatformStartError {
        permission: PermissionState::Unknown,
        error: RuntimeError {
            code: "unsupported_platform".into(),
            message: "Selection monitoring is not supported on this platform".into(),
        },
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn open_permission_settings() -> Result<super::PermissionSettingsOutcome, String> {
    Err("Selection monitoring is not supported on this platform".into())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn permission_state() -> PermissionState {
    PermissionState::Unknown
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn request_permission() -> Result<PermissionState, String> {
    Err("Selection monitoring is not supported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::{is_windows_copy_target_active, should_try_windows_clipboard_fallback};

    #[test]
    fn terminal_mouse_releases_never_request_clipboard_copy() {
        for process_name in [
            Some("WindowsTerminal.exe"),
            Some("mintty.exe"),
            Some("conhost.exe"),
            None,
        ] {
            for attempt in 0..3 {
                assert!(!should_try_windows_clipboard_fallback(
                    attempt,
                    process_name,
                ));
            }
        }
    }

    #[test]
    fn weak_uia_app_uses_clipboard_fallback_after_first_miss() {
        assert!(should_try_windows_clipboard_fallback(0, Some("WeChat.exe")));
        assert!(!should_try_windows_clipboard_fallback(
            1,
            Some("WeChat.exe")
        ));
        assert!(!should_try_windows_clipboard_fallback(
            2,
            Some("WeChat.exe")
        ));
    }

    #[test]
    fn clipboard_copy_stops_when_the_foreground_process_changes() {
        assert!(is_windows_copy_target_active(42, Some(42)));
        assert!(!is_windows_copy_target_active(42, Some(7)));
        assert!(!is_windows_copy_target_active(42, None));
    }
}
