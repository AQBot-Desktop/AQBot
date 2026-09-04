use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
#[cfg(any(target_os = "linux", target_os = "windows", test))]
use std::time::{Duration, Instant};

mod state;
pub(crate) use state::process_startup_phase;
pub use state::{install_process_startup_phase, StartupPhase, StartupPresentation};

pub const ENABLE_DEVTOOLS_ENV: &str = "AQBOT_ENABLE_DEVTOOLS";
pub const LINUX_ANY_THREAD_ENV: &str = "AQBOT_LINUX_ANY_THREAD";
pub const LINUX_MINIMAL_PLUGINS_ENV: &str = "AQBOT_LINUX_MINIMAL_PLUGINS";
const TEST_BUILD_ENV: &str = "AQBOT_TEST_BUILD";

pub struct StartupWatchdog {
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl StartupWatchdog {
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    fn noop() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(true)),
            handle: None,
        }
    }
}

impl Drop for StartupWatchdog {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            if handle.join().is_err() {
                tracing::error!("AQBot startup watchdog thread panicked");
            }
        }
    }
}

pub fn devtools_context_menu_enabled() -> bool {
    devtools_context_menu_enabled_from_values(
        env::var(ENABLE_DEVTOOLS_ENV).ok().as_deref(),
        option_env!("AQBOT_TEST_BUILD"),
        cfg!(debug_assertions),
    )
}

#[cfg(target_os = "linux")]
pub fn linux_any_thread_enabled() -> bool {
    env_truthy(LINUX_ANY_THREAD_ENV)
}

#[cfg(target_os = "linux")]
pub fn linux_minimal_plugins_enabled() -> bool {
    env_truthy(LINUX_MINIMAL_PLUGINS_ENV)
}

pub fn log_startup_env_switches() {
    tracing::info!(
        aqbot_enable_devtools = %env_value(ENABLE_DEVTOOLS_ENV),
        aqbot_linux_any_thread = %env_value(LINUX_ANY_THREAD_ENV),
        aqbot_linux_minimal_plugins = %env_value(LINUX_MINIMAL_PLUGINS_ENV),
        aqbot_test_build_runtime = %env_value(TEST_BUILD_ENV),
        aqbot_test_build = option_env!("AQBOT_TEST_BUILD").unwrap_or("<unset>"),
        "AQBot startup diagnostic switches"
    );
}

pub fn register_plugin<R, P>(
    builder: tauri::Builder<R>,
    plugin_name: &'static str,
    plugin: P,
) -> tauri::Builder<R>
where
    R: tauri::Runtime,
    P: tauri::plugin::Plugin<R> + 'static,
{
    tracing::info!(plugin = plugin_name, "Registering Tauri plugin");
    let builder = builder.plugin(plugin);
    tracing::info!(plugin = plugin_name, "Registered Tauri plugin");
    builder
}

pub fn diagnostic_marker_plugin<R: tauri::Runtime>(
    marker_name: &'static str,
) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new(marker_name)
        .setup(move |_app, _api| {
            if let Some(phase) = process_startup_phase() {
                phase.set(format!("plugin setup: {marker_name}"));
            }
            tracing::info!(
                plugin_marker = marker_name,
                "AQBot diagnostic plugin setup reached"
            );
            Ok(())
        })
        .build()
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn start_startup_watchdog(phase: StartupPhase) -> StartupWatchdog {
    start_watchdog(phase, Duration::from_secs(2), Duration::from_millis(250))
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn start_watchdog(phase: StartupPhase, heartbeat: Duration, tick: Duration) -> StartupWatchdog {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let handle = thread::spawn(move || {
        let started = Instant::now();
        let mut next_heartbeat = heartbeat;
        tracing::info!("AQBot startup watchdog started");
        while !thread_stop.load(Ordering::Relaxed) {
            thread::sleep(tick);
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            let Some(snapshot) = phase.snapshot() else {
                break;
            };
            if snapshot.finished {
                break;
            }
            #[cfg(target_os = "windows")]
            if phase.claim_slow_notice(snapshot.elapsed) {
                let notice_phase = phase.clone();
                // MessageBox is modal, so keep it off the heartbeat thread.
                thread::spawn(move || {
                    if let Some(snapshot) = notice_phase.snapshot().filter(|state| !state.finished)
                    {
                        crate::startup_messages::show_slow_startup(&snapshot.phase);
                    }
                });
            }
            if started.elapsed() < next_heartbeat {
                continue;
            }
            tracing::warn!(
                elapsed_ms = snapshot.elapsed.as_millis() as u64,
                phase_elapsed_ms = snapshot.phase_elapsed.as_millis() as u64,
                startup_phase = %snapshot.phase,
                "AQBot startup watchdog heartbeat"
            );
            #[cfg(target_os = "linux")]
            tracing::warn!(
                xdg_session_type = %env_value("XDG_SESSION_TYPE"),
                wayland_display = %env_value("WAYLAND_DISPLAY"),
                display = %env_value("DISPLAY"),
                gdk_backend = %env_value("GDK_BACKEND"),
                webkit_disable_dmabuf_renderer = %env_value("WEBKIT_DISABLE_DMABUF_RENDERER"),
                webkit_disable_compositing_mode = %env_value("WEBKIT_DISABLE_COMPOSITING_MODE"),
                aqbot_linux_auto_window = %env_value("AQBOT_LINUX_AUTO_WINDOW"),
                aqbot_linux_any_thread = %env_value(LINUX_ANY_THREAD_ENV),
                aqbot_linux_minimal_plugins = %env_value(LINUX_MINIMAL_PLUGINS_ENV),
                "AQBot Linux startup environment"
            );
            next_heartbeat += heartbeat;
        }
        tracing::info!(
            elapsed_secs = started.elapsed().as_secs(),
            "AQBot startup watchdog stopped"
        );
    });

    StartupWatchdog {
        stop,
        handle: Some(handle),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub fn start_startup_watchdog(_phase: StartupPhase) -> StartupWatchdog {
    StartupWatchdog::noop()
}

pub fn format_error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut chain = vec![error.to_string()];
    let mut source = error.source();
    while let Some(err) = source {
        chain.push(err.to_string());
        source = err.source();
    }
    chain.join(" | caused by: ")
}

fn devtools_context_menu_enabled_from_values(
    runtime_env: Option<&str>,
    test_build_env: Option<&str>,
    debug_assertions: bool,
) -> bool {
    debug_assertions
        || runtime_env.map(is_truthy).unwrap_or(false)
        || test_build_env.map(is_truthy).unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn env_truthy(key: &str) -> bool {
    env::var(key)
        .ok()
        .as_deref()
        .map(is_truthy)
        .unwrap_or(false)
}

fn env_value(key: &str) -> String {
    env::var(key).unwrap_or_else(|_| "<unset>".to_string())
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        devtools_context_menu_enabled_from_values, format_error_chain, is_truthy, StartupPhase,
    };

    #[test]
    fn parses_truthy_env_values() {
        assert!(is_truthy("1"));
        assert!(is_truthy("true"));
        assert!(is_truthy(" YES "));
        assert!(is_truthy("on"));
        assert!(!is_truthy("0"));
        assert!(!is_truthy(""));
        assert!(!is_truthy("false"));
    }

    #[test]
    fn devtools_context_menu_is_enabled_by_debug_runtime_or_test_build() {
        assert!(devtools_context_menu_enabled_from_values(None, None, true));
        assert!(devtools_context_menu_enabled_from_values(
            Some("1"),
            None,
            false
        ));
        assert!(devtools_context_menu_enabled_from_values(
            None,
            Some("true"),
            false
        ));
        assert!(!devtools_context_menu_enabled_from_values(
            None, None, false
        ));
        assert!(!devtools_context_menu_enabled_from_values(
            Some("0"),
            Some("false"),
            false
        ));
    }

    #[test]
    fn startup_phase_can_be_updated() {
        let phase = StartupPhase::new("initial");
        assert_eq!(phase.get(), "initial");

        phase.set("builder.build");
        assert_eq!(phase.get(), "builder.build");
    }

    #[test]
    fn formats_error_chains() {
        let error = std::io::Error::new(std::io::ErrorKind::Other, "outer");

        assert_eq!(format_error_chain(&error), "outer");
    }

    #[test]
    fn watchdog_finishes_when_main_surface_is_presented() {
        let phase = StartupPhase::new("frontend commit");
        let watchdog = super::start_watchdog(
            phase.clone(),
            super::Duration::from_millis(5),
            super::Duration::from_millis(1),
        );
        phase.mark_presented(super::StartupPresentation::App);
        let deadline = super::Instant::now() + super::Duration::from_secs(2);
        while !watchdog.handle.as_ref().unwrap().is_finished() && super::Instant::now() < deadline {
            std::thread::sleep(super::Duration::from_millis(1));
        }
        assert!(watchdog.handle.as_ref().unwrap().is_finished());
        drop(watchdog);
    }
}
