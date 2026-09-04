use std::env;
const LINUX_AUTO_WINDOW_ENV: &str = "AQBOT_LINUX_AUTO_WINDOW";

pub fn init_tracing() {
    crate::diagnostic_log::init();
}

pub fn log_process_startup() {
    tracing::info!(
        package_name = env!("CARGO_PKG_NAME"),
        crate_version = env!("CARGO_PKG_VERSION"),
        os = env::consts::OS,
        arch = env::consts::ARCH,
        pid = std::process::id(),
        rust_log = %env_value("RUST_LOG"),
        aqbot_log_file = %crate::diagnostic_log::path().display(),
        xdg_session_type = %env_value("XDG_SESSION_TYPE"),
        wayland_display = %env_value("WAYLAND_DISPLAY"),
        display = %env_value("DISPLAY"),
        gdk_backend = %env_value("GDK_BACKEND"),
        xdg_current_desktop = %env_value("XDG_CURRENT_DESKTOP"),
        desktop_session = %env_value("DESKTOP_SESSION"),
        webkit_disable_dmabuf_renderer = %env_value("WEBKIT_DISABLE_DMABUF_RENDERER"),
        webkit_disable_compositing_mode = %env_value("WEBKIT_DISABLE_COMPOSITING_MODE"),
        aqbot_linux_auto_window = %env_value(LINUX_AUTO_WINDOW_ENV),
        aqbot_linux_any_thread = %env_value(crate::startup_diagnostics::LINUX_ANY_THREAD_ENV),
        aqbot_linux_minimal_plugins = %env_value(crate::startup_diagnostics::LINUX_MINIMAL_PLUGINS_ENV),
        aqbot_enable_devtools = %env_value(crate::startup_diagnostics::ENABLE_DEVTOOLS_ENV),
        "AQBot process startup diagnostics"
    );
    #[cfg(target_os = "windows")]
    log_windows_startup_environment();
}

#[cfg(target_os = "windows")]
fn log_windows_startup_environment() {
    match crate::windows_utils::system_version() {
        Ok(version) => {
            tracing::info!(windows_version = %version, "AQBot Windows version diagnostics")
        }
        Err(error) => tracing::warn!(%error, "Could not read Windows version from registry"),
    }
    match tauri::webview_version() {
        Ok(version) => {
            tracing::info!(webview2_version = %version, "AQBot available WebView runtime diagnostics")
        }
        Err(error) => tracing::warn!(%error, "Could not query available WebView runtime version"),
    }
}

pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|panic_info| {
        let location = panic_info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "<unknown>".to_string());
        let payload = panic_payload(panic_info.payload());
        let backtrace = std::backtrace::Backtrace::force_capture();

        tracing::error!(
            location = %location,
            payload = %payload,
            backtrace = %backtrace,
            "AQBot process panicked"
        );
        eprintln!("AQBot process panicked at {location}: {payload}");
        if let Some(phase) = crate::startup_diagnostics::process_startup_phase() {
            phase.fail(&std::io::Error::other(format!("{payload} ({location})")));
        }
    }));
}

#[cfg(target_os = "linux")]
pub fn show_linux_startup_error_dialog(message: &str) {
    if spawn_linux_dialog(
        "zenity",
        &["--error", "--title", "AQBot", "--text", message],
    ) {
        return;
    }
    if spawn_linux_dialog("kdialog", &["--title", "AQBot", "--error", message]) {
        return;
    }

    tracing::warn!("No Linux native dialog command available for startup error");
}

fn env_value(key: &str) -> String {
    env::var(key).unwrap_or_else(|_| "<unset>".to_string())
}

fn panic_payload(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

#[cfg(target_os = "linux")]
fn spawn_linux_dialog(command: &str, args: &[&str]) -> bool {
    std::process::Command::new(command)
        .args(args)
        .spawn()
        .is_ok()
}
