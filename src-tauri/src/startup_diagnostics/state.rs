#[cfg(any(target_os = "windows", test))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(any(target_os = "windows", test))]
const SLOW_STARTUP_NOTICE_AFTER: Duration = Duration::from_secs(15);
static PROCESS_STARTUP: OnceLock<StartupPhase> = OnceLock::new();

#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StartupPresentation {
    App,
    Error,
}

impl StartupPresentation {
    fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Error => "error",
        }
    }
}

#[derive(Clone)]
pub struct StartupPhase {
    inner: Arc<Mutex<PhaseState>>,
    #[cfg(any(target_os = "windows", test))]
    slow_notice_shown: Arc<AtomicBool>,
}

struct PhaseState {
    phase: String,
    started: Instant,
    phase_started: Instant,
    finished: bool,
    presentation_cancelled: bool,
    last_presented_surface: Option<StartupPresentation>,
}

pub(super) struct PhaseSnapshot {
    pub phase: String,
    pub elapsed: Duration,
    pub phase_elapsed: Duration,
    #[cfg(any(target_os = "linux", target_os = "windows", test))]
    pub finished: bool,
}

impl StartupPhase {
    pub fn new(initial: impl Into<String>) -> Self {
        let phase = initial.into();
        tracing::info!(startup_phase = %phase, "AQBot startup phase started");
        let now = Instant::now();
        Self {
            inner: Arc::new(Mutex::new(PhaseState {
                phase,
                started: now,
                phase_started: now,
                finished: false,
                presentation_cancelled: false,
                last_presented_surface: None,
            })),
            #[cfg(any(target_os = "windows", test))]
            slow_notice_shown: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set(&self, value: impl Into<String>) {
        let value = value.into();
        let transition = match self.inner.lock() {
            Ok(mut state) if !state.finished && state.phase != value => {
                let previous = std::mem::replace(&mut state.phase, value.clone());
                let elapsed = state.started.elapsed();
                let phase_elapsed = state.phase_started.elapsed();
                state.phase_started = Instant::now();
                Some((previous, elapsed, phase_elapsed))
            }
            Ok(_) => None,
            Err(_) => {
                tracing::error!("AQBot startup phase lock poisoned");
                None
            }
        };
        if let Some((previous, elapsed, phase_elapsed)) = transition {
            tracing::info!(
                startup_phase = %value,
                previous_phase = %previous,
                elapsed_ms = elapsed.as_millis() as u64,
                previous_phase_elapsed_ms = phase_elapsed.as_millis() as u64,
                "AQBot startup phase changed"
            );
        }
    }

    pub fn get(&self) -> String {
        self.snapshot()
            .map(|snapshot| snapshot.phase)
            .unwrap_or_else(|| "<phase lock poisoned>".into())
    }

    /// Called only after the main window's native visibility has been verified.
    pub fn mark_presented(&self, surface: StartupPresentation) {
        if let Some(snapshot) = self.record_presentation(surface) {
            tracing::info!(
                window = "main",
                surface = surface.as_str(),
                visible = true,
                startup_phase = %snapshot.phase,
                elapsed_ms = snapshot.elapsed.as_millis() as u64,
                phase_elapsed_ms = snapshot.phase_elapsed.as_millis() as u64,
                "AQBot startup surface presented"
            );
        }
    }

    pub fn cancel_presentation(&self) {
        let cancelled = match self.inner.lock() {
            Ok(mut state) if !state.finished => {
                state.finished = true;
                state.presentation_cancelled = true;
                true
            }
            Ok(_) => false,
            Err(_) => {
                tracing::error!("AQBot startup phase lock poisoned");
                false
            }
        };
        if cancelled {
            tracing::info!(
                window = "main",
                reason = "user_hide_or_close",
                startup_phase = %self.get(),
                "AQBot startup presentation monitoring cancelled after user hid or closed the window"
            );
        }
    }

    pub fn presentation_cancelled(&self) -> bool {
        match self.inner.lock() {
            Ok(state) => state.presentation_cancelled,
            Err(_) => {
                tracing::error!("AQBot startup phase lock poisoned");
                false
            }
        }
    }

    pub fn fail(&self, error: &(dyn std::error::Error + 'static)) {
        let error_chain = super::format_error_chain(error);
        let snapshot = self.finish();
        let elapsed_ms = snapshot
            .as_ref()
            .map(|state| state.elapsed.as_millis() as u64);
        let phase_elapsed_ms = snapshot
            .as_ref()
            .map(|state| state.phase_elapsed.as_millis() as u64);
        tracing::error!(
            error_chain,
            elapsed_ms,
            phase_elapsed_ms,
            during_startup = snapshot.is_some(),
            startup_phase = %self.get(),
            "AQBot startup failure reported"
        );
        if snapshot.is_some() {
            #[cfg(target_os = "windows")]
            crate::startup_messages::show_failure(&error_chain);
        }
    }

    pub(super) fn snapshot(&self) -> Option<PhaseSnapshot> {
        match self.inner.lock() {
            Ok(state) => Some(PhaseSnapshot {
                phase: state.phase.clone(),
                elapsed: state.started.elapsed(),
                phase_elapsed: state.phase_started.elapsed(),
                #[cfg(any(target_os = "linux", target_os = "windows", test))]
                finished: state.finished,
            }),
            Err(_) => {
                tracing::error!("AQBot startup phase lock poisoned");
                None
            }
        }
    }

    #[cfg(any(target_os = "windows", test))]
    pub(super) fn claim_slow_notice(&self, elapsed: Duration) -> bool {
        elapsed >= SLOW_STARTUP_NOTICE_AFTER
            && self.snapshot().is_some_and(|state| !state.finished)
            && !self.slow_notice_shown.swap(true, Ordering::AcqRel)
    }

    fn record_presentation(&self, surface: StartupPresentation) -> Option<PhaseSnapshot> {
        match self.inner.lock() {
            Ok(mut state)
                if !state.presentation_cancelled
                    && (!state.finished
                        || (surface == StartupPresentation::Error
                            && state.last_presented_surface
                                != Some(StartupPresentation::Error))) =>
            {
                // A later error stays observable without reopening the startup lifecycle.
                state.finished = true;
                state.last_presented_surface = Some(surface);
                Some(PhaseSnapshot {
                    phase: state.phase.clone(),
                    elapsed: state.started.elapsed(),
                    phase_elapsed: state.phase_started.elapsed(),
                    #[cfg(any(target_os = "linux", target_os = "windows", test))]
                    finished: true,
                })
            }
            Ok(_) => None,
            Err(_) => {
                tracing::error!("AQBot startup phase lock poisoned");
                None
            }
        }
    }

    fn finish(&self) -> Option<PhaseSnapshot> {
        match self.inner.lock() {
            Ok(mut state) if !state.finished => {
                state.finished = true;
                Some(PhaseSnapshot {
                    phase: state.phase.clone(),
                    elapsed: state.started.elapsed(),
                    phase_elapsed: state.phase_started.elapsed(),
                    #[cfg(any(target_os = "linux", target_os = "windows", test))]
                    finished: true,
                })
            }
            Ok(_) => None,
            Err(_) => {
                tracing::error!("AQBot startup phase lock poisoned");
                None
            }
        }
    }
}

pub fn install_process_startup_phase(phase: StartupPhase) {
    if PROCESS_STARTUP.set(phase).is_err() {
        tracing::error!("AQBot process startup phase was already installed");
    }
}

pub(crate) fn process_startup_phase() -> Option<&'static StartupPhase> {
    PROCESS_STARTUP.get()
}

#[cfg(test)]
mod tests;
