use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

use aqbot_core::types::{
    AppSettings, SelectionToolbarBuiltinActionKey, SelectionToolbarBuiltinAiKey,
    SelectionToolbarDisplayMode, SelectionToolbarPlacement, SelectionToolbarSettings,
    SelectionToolbarTool, SelectionToolbarTriggerMode,
};
use tauri::{AppHandle, Emitter, Manager, Theme};
use tokio::sync::{mpsc, watch, Mutex};

use super::{
    compact_toolbar_width, normalize_permission_status,
    platform::{self, DismissReason, PlatformEvent, PlatformMonitorHandle},
    prefer_selection_observation,
    runtime::SessionView,
    window, OverflowDirection, PermissionSettingsOutcome, PermissionState, PreparedToolRun,
    RuntimeError, RuntimeSnapshot, RuntimeState, RuntimeStatus, RuntimeStore, ScreenPoint,
    SelectionChange, SelectionDebouncer, SelectionObservation, SelectionPlatform, SurfaceSize,
    ToolExecutionConfig, ToolbarToolView, OVERFLOW_SURFACE_MAX_HEIGHT, TOOLBAR_HEIGHT,
    TOOLBAR_WIDTH,
};

const SELECTION_OBSERVATION_RACE_MS: u64 = 200;

#[derive(Debug, Clone)]
struct PendingSelection {
    observation: SelectionObservation,
    observed_at_ms: u64,
}

pub struct SelectionToolbarRuntime {
    store: Mutex<RuntimeStore>,
    monitor: Mutex<Option<PlatformMonitorHandle>>,
    event_sender: Mutex<Option<mpsc::UnboundedSender<PlatformEvent>>>,
    generation: AtomicU64,
    debounce_clock: Instant,
    debouncer: Mutex<SelectionDebouncer>,
    /// Serializes native window moves that can change the active presentation.
    presentation_lock: Mutex<()>,
    surface: Mutex<SurfaceSize>,
    toolbar_width: Mutex<f64>,
    overflow_height: Mutex<f64>,
    last_window_position: Mutex<Option<ScreenPoint>>,
    last_toolbar_position: Mutex<Option<ScreenPoint>>,
    /// The configured direction is frozen for the lifetime of a selection session.
    preferred_placement: Mutex<SelectionToolbarPlacement>,
    /// Actual direction after edge flipping, exposed to the frontend for layout.
    resolved_placement: Mutex<SelectionToolbarPlacement>,
    dragged_for_session: AtomicBool,
    /// True while a tool is running or the pointer is interacting with the toolbar.
    interaction_lock: AtomicBool,
    /// Latest non-empty selection observed by the platform monitor. Shortcut
    /// mode keeps this without opening a toolbar until the accelerator fires.
    pending_selection: Mutex<Option<PendingSelection>>,
    /// Selection-toolbar webview has registered event listeners.
    frontend_ready: AtomicBool,
    /// Session emitted before the frontend was ready.
    pending_session: Mutex<Option<SessionView>>,
    /// Latest validated toolbar settings, consumed by the platform monitor
    /// before any clipboard fallback side effects.
    settings_tx: watch::Sender<SelectionToolbarSettings>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SelectionPublishDecision {
    PublishNew,
    ReanchorLive { selection_id: String },
    Ignore,
}

fn merge_shortcut_candidate(
    current: Option<PendingSelection>,
    incoming: SelectionObservation,
    now_ms: u64,
) -> PendingSelection {
    if let Some(current) = current {
        let within_race =
            now_ms.saturating_sub(current.observed_at_ms) <= SELECTION_OBSERVATION_RACE_MS;
        if within_race {
            let preferred =
                prefer_selection_observation(current.observation.clone(), incoming.clone());
            if preferred == current.observation {
                return current;
            }
            return PendingSelection {
                observation: preferred,
                observed_at_ms: now_ms,
            };
        }
    }
    PendingSelection {
        observation: incoming,
        observed_at_ms: now_ms,
    }
}

fn live_reanchor_allowed(surface: SurfaceSize, interaction_locked: bool, dragged: bool) -> bool {
    surface == SurfaceSize::Toolbar && !interaction_locked && !dragged
}

impl SelectionToolbarRuntime {
    pub fn new() -> Self {
        let (settings_tx, _) = watch::channel(SelectionToolbarSettings::default());
        Self {
            store: Mutex::new(RuntimeStore::new(SelectionPlatform::current())),
            monitor: Mutex::new(None),
            event_sender: Mutex::new(None),
            generation: AtomicU64::new(0),
            debounce_clock: Instant::now(),
            debouncer: Mutex::new(SelectionDebouncer::new(SELECTION_OBSERVATION_RACE_MS)),
            presentation_lock: Mutex::new(()),
            surface: Mutex::new(SurfaceSize::Toolbar),
            toolbar_width: Mutex::new(TOOLBAR_WIDTH),
            overflow_height: Mutex::new(OVERFLOW_SURFACE_MAX_HEIGHT),
            last_window_position: Mutex::new(None),
            last_toolbar_position: Mutex::new(None),
            preferred_placement: Mutex::new(SelectionToolbarPlacement::Below),
            resolved_placement: Mutex::new(SelectionToolbarPlacement::Below),
            dragged_for_session: AtomicBool::new(false),
            interaction_lock: AtomicBool::new(false),
            pending_selection: Mutex::new(None),
            frontend_ready: AtomicBool::new(false),
            pending_session: Mutex::new(None),
            settings_tx,
        }
    }

    pub async fn snapshot(&self) -> RuntimeSnapshot {
        let _ = self.refresh_permission_status().await;
        self.store.lock().await.snapshot()
    }

    pub async fn status(&self) -> RuntimeStatus {
        self.refresh_permission_status().await
    }

    pub async fn reconcile(self: &Arc<Self>, app: &AppHandle, settings: &AppSettings) {
        if let Err(message) = settings.selection_toolbar.validate() {
            self.set_error("invalid_settings", message).await;
            return;
        }
        self.settings_tx
            .send_replace(settings.selection_toolbar.clone());
        if !settings.selection_toolbar.enabled {
            self.stop(app).await;
            return;
        }
        if self.monitor.lock().await.is_some() {
            if self.status().await.state == RuntimeState::PermissionRequired {
                return;
            }
            if settings.selection_toolbar.trigger_mode == SelectionToolbarTriggerMode::Shortcut {
                let _ = self.hide(app, "trigger_mode_changed").await;
                return;
            }
            self.refresh_session(app, settings).await;
            return;
        }

        self.set_runtime_state(RuntimeState::Starting, PermissionState::Unknown, None)
            .await;

        #[cfg(target_os = "macos")]
        if let Err(error) = window::precreate(app) {
            tracing::error!(%error, "Could not precreate selection toolbar panel");
            self.set_error("window_precreate_failed", error).await;
            return;
        }

        let sender = self.ensure_event_loop(app).await;
        match platform::start_monitor(sender, self.settings_tx.subscribe()) {
            Ok(handle) => {
                *self.monitor.lock().await = Some(handle);
                self.set_runtime_state(RuntimeState::Running, platform::permission_state(), None)
                    .await;
                let _ = self.refresh_permission_status().await;

                #[cfg(not(target_os = "macos"))]
                // Warm the toolbar webview/panel so the first selection is not a cold load.
                if let Err(error) = window::precreate(app) {
                    tracing::warn!(%error, "Could not precreate selection toolbar window");
                }
            }
            Err(start_error) => {
                let state = if start_error.permission == PermissionState::Denied {
                    RuntimeState::PermissionRequired
                } else {
                    RuntimeState::Unavailable
                };
                self.set_runtime_state(state, start_error.permission, Some(start_error.error))
                    .await;
            }
        }
    }

    pub async fn retry(self: &Arc<Self>, app: &AppHandle) -> Result<RuntimeStatus, String> {
        if let Some(handle) = self.monitor.lock().await.take() {
            handle.stop();
        }
        self.clear_selection_candidate().await;
        let settings =
            aqbot_core::repo::settings::get_settings(&app.state::<crate::AppState>().sea_db)
                .await
                .map_err(|error| error.to_string())?;
        self.reconcile(app, &settings).await;
        Ok(self.status().await)
    }

    pub async fn trigger_shortcut(&self, app: &AppHandle) -> Result<(), String> {
        let settings =
            aqbot_core::repo::settings::get_settings(&app.state::<crate::AppState>().sea_db)
                .await
                .map_err(|error| error.to_string())?;
        if !settings.selection_toolbar.enabled {
            return Err("Selection toolbar is disabled".into());
        }
        if settings.selection_toolbar.trigger_mode != SelectionToolbarTriggerMode::Shortcut {
            return Err("Selection toolbar shortcut trigger mode is not enabled".into());
        }
        let observation = self
            .pending_selection
            .lock()
            .await
            .as_ref()
            .map(|pending| pending.observation.clone())
            .ok_or_else(|| "No active text selection is available".to_string())?;
        if !settings
            .selection_toolbar
            .allows_source_app(&observation.source_app)
        {
            return Err("The active text selection is excluded by the app filter".into());
        }
        self.show_selection(app, observation, &settings).await
    }

    async fn remember_selection_candidate(&self, observation: &SelectionObservation) {
        let mut pending = self.pending_selection.lock().await;
        if super::is_actionable_selection_text(&observation.text) {
            *pending = Some(merge_shortcut_candidate(
                pending.take(),
                observation.clone(),
                self.elapsed_ms(),
            ));
        } else {
            *pending = None;
        }
    }

    async fn clear_selection_candidate(&self) {
        *self.pending_selection.lock().await = None;
    }

    pub fn open_permission_settings(&self) -> Result<PermissionSettingsOutcome, String> {
        platform::open_permission_settings()
    }

    pub fn request_permission(&self) -> Result<PermissionState, String> {
        platform::request_permission()
    }

    pub async fn shutdown(&self, app: &AppHandle) {
        if let Some(handle) = self.monitor.lock().await.take() {
            handle.stop();
        }
        let _ = self.hide(app, "application_exit").await;
    }

    pub async fn prepare_overflow(
        &self,
        app: &AppHandle,
        requested_height: f64,
    ) -> Result<OverflowDirection, String> {
        let toolbar_width = *self.toolbar_width.lock().await;
        let current_window = window::current_screen_position(app);
        let previous_window = *self.last_window_position.lock().await;
        let cached_toolbar = *self.last_toolbar_position.lock().await;
        let toolbar_position = match (cached_toolbar, current_window, previous_window) {
            (Some(toolbar), Some(current), Some(previous)) => ScreenPoint {
                x: toolbar.x + current.x - previous.x,
                y: toolbar.y + current.y - previous.y,
            },
            (Some(toolbar), _, _) => toolbar,
            (None, Some(current), _) => current,
            (None, None, _) => return Err("Selection toolbar position is unavailable".into()),
        };
        let height = sanitize_overflow_height(Some(requested_height));
        let (placement, _) =
            window::overflow_placement(app, toolbar_position, toolbar_width, height)?;
        Ok(placement.direction)
    }

    pub async fn set_surface(
        &self,
        app: &AppHandle,
        surface: SurfaceSize,
        requested_overflow_height: Option<f64>,
    ) -> Result<Option<OverflowDirection>, String> {
        let _presentation_guard = self.presentation_lock.lock().await;
        let toolbar_width = *self.toolbar_width.lock().await;
        let anchor = {
            let store = self.store.lock().await;
            let snapshot = store.snapshot();
            snapshot
                .session
                .and_then(|session| store.selection_observation(&session.selection_id).cloned())
                .map(|observation| (observation.anchor, observation.anchor_kind))
        };
        let previous_surface = *self.surface.lock().await;
        let current_position = window::current_screen_position(app);
        let previous_position = *self.last_window_position.lock().await;
        let mut toolbar_position = *self.last_toolbar_position.lock().await;
        if let (Some(current), Some(previous), Some(toolbar)) =
            (current_position, previous_position, toolbar_position)
        {
            if position_changed(current, previous) {
                toolbar_position = Some(ScreenPoint {
                    x: toolbar.x + current.x - previous.x,
                    y: toolbar.y + current.y - previous.y,
                });
                self.dragged_for_session.store(true, Ordering::Relaxed);
            }
        }
        if toolbar_position.is_none() && previous_surface == SurfaceSize::Toolbar {
            toolbar_position = current_position;
        }
        if surface == SurfaceSize::Result && previous_surface == SurfaceSize::Result {
            if let Some(position) = current_position {
                *self.last_window_position.lock().await = Some(position);
            }
            *self.last_toolbar_position.lock().await = toolbar_position;
            if let Err(error) = window::focus_surface(app) {
                tracing::warn!(%error, "Could not refocus the selection toolbar result surface");
            }
            return Ok(None);
        }

        let overflow_height = if surface == SurfaceSize::Overflow {
            let height = sanitize_overflow_height(requested_overflow_height);
            *self.overflow_height.lock().await = height;
            height
        } else {
            *self.overflow_height.lock().await
        };
        let preferred_placement = *self.preferred_placement.lock().await;
        let anchored_result = if surface == SurfaceSize::Result
            && !self.dragged_for_session.load(Ordering::Relaxed)
        {
            anchor
                .map(|(anchor, kind)| {
                    window::show_surface(
                        app,
                        anchor,
                        kind,
                        SurfaceSize::Result,
                        toolbar_width,
                        preferred_placement,
                    )
                })
                .transpose()?
        } else {
            None
        };

        let (position, next_toolbar_position, direction, resolved_placement) =
            match (surface, toolbar_position, anchored_result) {
                (SurfaceSize::Result, _, Some(placement)) => (
                    Some(placement.window_position),
                    Some(placement.toolbar_position),
                    None,
                    Some(placement.direction),
                ),
                (SurfaceSize::Overflow, Some(toolbar_position), _) => {
                    let placement = window::show_overflow_at_toolbar(
                        app,
                        toolbar_position,
                        toolbar_width,
                        overflow_height,
                    )?;
                    (
                        Some(placement.window_position),
                        Some(placement.toolbar_position),
                        Some(placement.direction),
                        None,
                    )
                }
                (SurfaceSize::Toolbar, Some(toolbar_position), _) => {
                    let position = window::show_surface_at_position(
                        app,
                        toolbar_position,
                        SurfaceSize::Toolbar,
                        toolbar_width,
                    )?;
                    (Some(position), Some(position), None, None)
                }
                (SurfaceSize::Result, Some(toolbar_position), _) => {
                    let placement = window::show_result_at_toolbar(
                        app,
                        toolbar_position,
                        toolbar_width,
                        preferred_placement,
                    )?;
                    (
                        Some(placement.window_position),
                        Some(placement.toolbar_position),
                        None,
                        Some(placement.direction),
                    )
                }
                _ => {
                    let placement = anchor
                        .map(|(anchor, kind)| {
                            window::show_surface(
                                app,
                                anchor,
                                kind,
                                surface,
                                toolbar_width,
                                preferred_placement,
                            )
                        })
                        .transpose()?;
                    (
                        placement.map(|value| value.window_position),
                        placement.map(|value| value.toolbar_position),
                        None,
                        placement.map(|value| value.direction),
                    )
                }
            };
        if let Some(position) = position {
            *self.last_window_position.lock().await = Some(position);
        }
        *self.last_toolbar_position.lock().await = next_toolbar_position;
        *self.surface.lock().await = surface;
        if let Some(placement) = resolved_placement {
            *self.resolved_placement.lock().await = placement;
            let session = {
                let mut store = self.store.lock().await;
                let selection_id = store.snapshot().session.map(|session| session.selection_id);
                selection_id
                    .and_then(|selection_id| store.set_resolved_placement(&selection_id, placement))
            };
            if let Some(session) = session {
                let _ = app.emit_to(
                    window::SELECTION_TOOLBAR_WINDOW_LABEL,
                    "selection-toolbar://session",
                    session,
                );
            }
        }
        if matches!(surface, SurfaceSize::Result) {
            // The result panel appears under a stationary cursor, so the
            // hover→make-key path may never fire; focus it explicitly so its
            // buttons respond to the first click.
            if let Err(error) = window::focus_surface(app) {
                tracing::warn!(%error, "Could not focus the selection toolbar result surface");
            }
        }
        Ok(direction)
    }

    pub async fn hide(&self, app: &AppHandle, reason: &str) -> Result<(), String> {
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.debouncer.lock().await.clear();
        self.store.lock().await.clear();
        self.dragged_for_session.store(false, Ordering::Relaxed);
        self.interaction_lock.store(false, Ordering::Relaxed);
        *self.last_window_position.lock().await = None;
        *self.last_toolbar_position.lock().await = None;
        *self.preferred_placement.lock().await = SelectionToolbarPlacement::Below;
        *self.resolved_placement.lock().await = SelectionToolbarPlacement::Below;
        *self.pending_session.lock().await = None;
        window::hide(app)?;
        tracing::debug!(reason, "selection toolbar hide");
        let _ = app.emit_to(
            window::SELECTION_TOOLBAR_WINDOW_LABEL,
            "selection-toolbar://hidden",
            reason,
        );
        Ok(())
    }

    pub async fn set_pinned(&self, selection_id: &str, pinned: bool) -> Result<bool, String> {
        let session = self.store.lock().await.set_pinned(selection_id, pinned)?;
        tracing::debug!(
            selection_id = %session.selection_id,
            pinned = session.pinned,
            "selection toolbar result pin changed"
        );
        Ok(session.pinned)
    }

    pub async fn drag_ended(&self, app: &AppHandle, selection_id: &str) -> Result<(), String> {
        let result = self.sync_drag_position(app, selection_id).await;
        self.unlock_interaction();
        result
    }

    async fn sync_drag_position(&self, app: &AppHandle, selection_id: &str) -> Result<(), String> {
        let _presentation_guard = self.presentation_lock.lock().await;
        let active_selection_id = self
            .store
            .lock()
            .await
            .snapshot()
            .session
            .map(|session| session.selection_id)
            .ok_or_else(|| "The selection toolbar session is no longer active".to_string())?;
        if active_selection_id != selection_id {
            return Err("The selection toolbar session is no longer active".into());
        }
        let current = window::current_screen_position(app)
            .ok_or_else(|| "Selection toolbar position is unavailable".to_string())?;
        let previous = *self.last_window_position.lock().await;
        let toolbar = *self.last_toolbar_position.lock().await;
        let next_toolbar = match (previous, toolbar) {
            (Some(previous), Some(toolbar)) => ScreenPoint {
                x: toolbar.x + current.x - previous.x,
                y: toolbar.y + current.y - previous.y,
            },
            (_, Some(toolbar)) => toolbar,
            (_, None) => current,
        };
        *self.last_window_position.lock().await = Some(current);
        *self.last_toolbar_position.lock().await = Some(next_toolbar);
        self.dragged_for_session.store(true, Ordering::Relaxed);
        tracing::debug!(
            selection_id,
            position_x = current.x,
            position_y = current.y,
            "selection toolbar drag ended"
        );
        Ok(())
    }

    pub fn lock_interaction(&self) {
        self.interaction_lock.store(true, Ordering::Relaxed);
    }

    pub fn unlock_interaction(&self) {
        self.interaction_lock.store(false, Ordering::Relaxed);
    }

    /// Called when the selection-toolbar webview has finished wiring event listeners.
    pub async fn mark_frontend_ready(&self, app: &AppHandle) {
        self.frontend_ready.store(true, Ordering::Relaxed);
        if let Some(session) = self.pending_session.lock().await.take() {
            tracing::debug!(
                selection_id = %session.selection_id,
                "Flushing pending selection toolbar session after frontend ready"
            );
            let _ = app.emit_to(
                window::SELECTION_TOOLBAR_WINDOW_LABEL,
                "selection-toolbar://session",
                session,
            );
        }
    }

    fn should_suppress_clear(&self, app: &AppHandle) -> bool {
        if self.interaction_lock.load(Ordering::Relaxed) {
            return true;
        }
        // While the session is live and the toolbar window is up, treat empty AX
        // clears as noise unless an outside click / Dismiss decides otherwise.
        let session_live = self
            .store
            .try_lock()
            .map(|store| store.snapshot().session.is_some())
            .unwrap_or(true);
        session_live && window::is_toolbar_visible_for_suppress(app)
    }

    pub async fn selection_text(&self, selection_id: &str) -> Option<String> {
        self.store
            .lock()
            .await
            .selection_text(selection_id)
            .map(str::to_string)
    }

    pub(crate) async fn begin_new_tool_run(
        &self,
        selection_id: &str,
        tool_id: &str,
        config: ToolExecutionConfig,
        hidden_prompt: String,
    ) -> Result<PreparedToolRun, String> {
        self.store
            .lock()
            .await
            .begin_new_tool_run(selection_id, tool_id, config, hidden_prompt)
    }

    pub(crate) async fn begin_follow_up_run(
        &self,
        selection_id: &str,
        text: String,
    ) -> Result<PreparedToolRun, String> {
        self.store
            .lock()
            .await
            .begin_follow_up_run(selection_id, text)
    }

    pub(crate) async fn begin_regenerate_run(
        &self,
        selection_id: &str,
        request_id: &str,
    ) -> Result<PreparedToolRun, String> {
        self.store
            .lock()
            .await
            .begin_regenerate_run(selection_id, request_id)
    }

    pub async fn append_delta(&self, request_id: &str, delta: &str) -> bool {
        self.store.lock().await.append_delta(request_id, delta)
    }

    pub async fn complete_run(&self, request_id: &str) -> bool {
        self.store.lock().await.complete_run(request_id)
    }

    pub async fn stop_run(&self, request_id: &str) -> bool {
        self.store.lock().await.stop_run(request_id)
    }

    pub async fn fail_run(&self, request_id: &str, error: String) -> bool {
        self.store.lock().await.fail_run(request_id, error)
    }

    pub async fn run_output(&self, request_id: &str) -> Option<String> {
        self.store
            .lock()
            .await
            .run_output(request_id)
            .map(str::to_string)
    }

    pub async fn replace_output(&self, request_id: &str, output: String) -> bool {
        self.store.lock().await.replace_output(request_id, output)
    }

    async fn ensure_event_loop(
        self: &Arc<Self>,
        app: &AppHandle,
    ) -> mpsc::UnboundedSender<PlatformEvent> {
        if let Some(sender) = self.event_sender.lock().await.clone() {
            return sender;
        }
        let (sender, mut receiver) = mpsc::unbounded_channel();
        *self.event_sender.lock().await = Some(sender.clone());
        let runtime = Arc::clone(self);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = receiver.recv().await {
                runtime.handle_platform_event(&app, event).await;
            }
        });
        sender
    }

    async fn handle_platform_event(self: &Arc<Self>, app: &AppHandle, event: PlatformEvent) {
        match event {
            PlatformEvent::Selection(observation) => {
                tracing::debug!(
                    source_app = %observation.source_app,
                    text_len = observation.text.chars().count(),
                    "selection event received"
                );
                self.remember_selection_candidate(&observation).await;
                let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
                self.debouncer
                    .lock()
                    .await
                    .push(observation, self.elapsed_ms());
                let runtime = Arc::clone(self);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        SELECTION_OBSERVATION_RACE_MS,
                    ))
                    .await;
                    let current_generation = runtime.generation.load(Ordering::Relaxed);
                    if current_generation == generation {
                        let change = {
                            let mut debouncer = runtime.debouncer.lock().await;
                            debouncer.take_ready(runtime.elapsed_ms())
                        };
                        match change {
                            Some(SelectionChange::Selected(observation)) => {
                                runtime.publish_selection(&app, observation).await;
                            }
                            Some(SelectionChange::Cleared) => {
                                if runtime.should_suppress_clear(&app) {
                                    tracing::debug!(
                                        "Suppressing selection_cleared while toolbar interaction is active"
                                    );
                                } else {
                                    let _ = runtime.hide(&app, "selection_cleared").await;
                                }
                            }
                            None => {}
                        }
                    }
                });
            }
            PlatformEvent::Clear => {
                tracing::debug!("clear event received");
                if self.should_suppress_clear(app) {
                    tracing::debug!(
                        "Suppressing platform Clear while toolbar interaction is active"
                    );
                } else {
                    self.clear_selection_candidate().await;
                    let _ = self.hide(app, "platform").await;
                }
            }
            PlatformEvent::Dismiss(reason) => {
                tracing::debug!(?reason, "dismiss event received");
                // Esc always closes. App switch / hide / minimize must not close
                // the toolbar while the user is interacting with it or a result
                // panel is open — only an outside click, Esc or the close button.
                if reason == DismissReason::AppChanged {
                    self.clear_selection_candidate().await;
                }
                if keep_after_dismiss(reason, self.sticky_interaction_active().await) {
                    tracing::debug!(
                        "Keeping selection toolbar open across an app change while interacting"
                    );
                } else {
                    let _ = self.hide(app, "platform").await;
                }
            }
            PlatformEvent::GlobalPointerDown(point) => {
                if window::is_pointer_over_toolbar(app, point) {
                    tracing::debug!("Ignoring global pointer down over selection toolbar");
                    self.interaction_lock.store(true, Ordering::Relaxed);
                } else if self.pinned_result_active().await {
                    self.clear_selection_candidate().await;
                    self.interaction_lock.store(false, Ordering::Relaxed);
                    if let Err(error) = window::release_surface_focus(app) {
                        tracing::warn!(%error, "Could not release pinned selection result focus");
                    }
                    tracing::debug!("Keeping pinned selection result open after outside click");
                } else {
                    self.clear_selection_candidate().await;
                    let _ = self.hide(app, "outside_click").await;
                }
            }
            PlatformEvent::Error(error) => {
                self.set_runtime_state(
                    RuntimeState::Error,
                    self.status().await.permission,
                    Some(error),
                )
                .await;
                self.clear_selection_candidate().await;
                let _ = self.hide(app, "monitor_error").await;
            }
        }
    }

    /// True while a tool is running, the pointer is interacting with the
    /// toolbar, or the result panel is open — states in which the toolbar must
    /// survive app switches and duplicate selection announcements.
    async fn sticky_interaction_active(&self) -> bool {
        if self.interaction_lock.load(Ordering::Relaxed) {
            return true;
        }
        matches!(*self.surface.lock().await, SurfaceSize::Result)
    }

    async fn pinned_result_active(&self) -> bool {
        if *self.surface.lock().await != SurfaceSize::Result {
            return false;
        }
        self.store
            .lock()
            .await
            .snapshot()
            .session
            .is_some_and(|session| session.pinned)
    }

    /// A selection can be announced by more than one platform path (mouse-up
    /// probe, AX notification) with different anchors. Re-publishing mints a new
    /// session id, cancels any active run and resets the surface — so keep the
    /// live session for duplicates, and never replace a session the user is
    /// actively interacting with.
    async fn selection_publish_decision(
        &self,
        observation: &SelectionObservation,
    ) -> SelectionPublishDecision {
        let live_selection = {
            let store = self.store.lock().await;
            store.snapshot().session.and_then(|session| {
                store
                    .selection_observation(&session.selection_id)
                    .cloned()
                    .map(|current| (session.selection_id, current))
            })
        };
        let Some((selection_id, current)) = live_selection else {
            tracing::debug!(
                source_app = %observation.source_app,
                text_len = observation.text.chars().count(),
                incoming_anchor_kind = ?observation.anchor_kind,
                arbitration = ?SelectionPublishDecision::PublishNew,
                "selection observation arbitration"
            );
            return SelectionPublishDecision::PublishNew;
        };
        // range_signature is unstable across range, text-marker and hit-test
        // paths, so app + text remains the logical duplicate key.
        let duplicate =
            current.source_app == observation.source_app && current.text == observation.text;
        let surface = *self.surface.lock().await;
        let interaction_locked = self.interaction_lock.load(Ordering::Relaxed);
        let dragged = self.dragged_for_session.load(Ordering::Relaxed);
        let decision = if duplicate {
            if live_reanchor_allowed(surface, interaction_locked, dragged)
                && current.anchor_kind == super::SelectionAnchorKind::SelectionRect
                && observation.anchor_kind == super::SelectionAnchorKind::Pointer
            {
                SelectionPublishDecision::ReanchorLive { selection_id }
            } else {
                SelectionPublishDecision::Ignore
            }
        } else if interaction_locked || surface == SurfaceSize::Result {
            SelectionPublishDecision::Ignore
        } else {
            SelectionPublishDecision::PublishNew
        };
        tracing::debug!(
            source_app = %observation.source_app,
            text_len = observation.text.chars().count(),
            current_anchor_kind = ?current.anchor_kind,
            current_anchor_x = current.anchor.x,
            current_anchor_y = current.anchor.y,
            current_anchor_width = current.anchor.width,
            current_anchor_height = current.anchor.height,
            incoming_anchor_kind = ?observation.anchor_kind,
            incoming_anchor_x = observation.anchor.x,
            incoming_anchor_y = observation.anchor.y,
            incoming_anchor_width = observation.anchor.width,
            incoming_anchor_height = observation.anchor.height,
            ?surface,
            interaction_locked,
            dragged,
            arbitration = ?decision,
            "selection observation arbitration"
        );
        decision
    }

    async fn refresh_dragged_state(&self, app: &AppHandle) {
        let current = window::current_screen_position(app);
        let previous = *self.last_window_position.lock().await;
        if matches!((current, previous), (Some(current), Some(previous)) if position_changed(current, previous))
        {
            self.dragged_for_session.store(true, Ordering::Relaxed);
            tracing::debug!(
                current_x = current.map(|point| point.x),
                current_y = current.map(|point| point.y),
                previous_x = previous.map(|point| point.x),
                previous_y = previous.map(|point| point.y),
                "selection toolbar manual movement detected"
            );
        }
    }

    async fn reanchor_live_selection(
        &self,
        app: &AppHandle,
        selection_id: &str,
        observation: SelectionObservation,
    ) -> Result<(), String> {
        let _presentation_guard = self.presentation_lock.lock().await;
        self.refresh_dragged_state(app).await;
        let surface = *self.surface.lock().await;
        let interaction_locked = self.interaction_lock.load(Ordering::Relaxed);
        let dragged = self.dragged_for_session.load(Ordering::Relaxed);
        if !live_reanchor_allowed(surface, interaction_locked, dragged) {
            tracing::debug!(
                selection_id,
                ?surface,
                interaction_locked,
                dragged,
                arbitration = ?SelectionPublishDecision::Ignore,
                "Live selection reanchor was blocked after presentation state changed"
            );
            return Ok(());
        }
        let toolbar_width = *self.toolbar_width.lock().await;
        let preferred_placement = *self.preferred_placement.lock().await;
        let mut store = self.store.lock().await;
        let still_live = store
            .snapshot()
            .session
            .is_some_and(|session| session.selection_id == selection_id);
        if !still_live {
            tracing::debug!(selection_id, "Skipping stale live selection reanchor");
            return Ok(());
        }
        let placement = match window::show_surface(
            app,
            observation.anchor,
            observation.anchor_kind,
            SurfaceSize::Toolbar,
            toolbar_width,
            preferred_placement,
        ) {
            Ok(placement) => placement,
            Err(error) => {
                drop(store);
                self.set_error("window_reanchor_failed", error.clone())
                    .await;
                return Err(error);
            }
        };
        if !store.reanchor_selection(selection_id, observation.clone()) {
            tracing::error!(
                selection_id,
                "Live selection disappeared during atomic reanchor"
            );
            return Err("Live selection disappeared during reanchor".into());
        }
        let session = store.set_resolved_placement(selection_id, placement.direction);
        drop(store);
        *self.resolved_placement.lock().await = placement.direction;
        *self.last_window_position.lock().await = Some(placement.window_position);
        *self.last_toolbar_position.lock().await = Some(placement.toolbar_position);
        if let Some(session) = session {
            let _ = app.emit_to(
                window::SELECTION_TOOLBAR_WINDOW_LABEL,
                "selection-toolbar://session",
                session,
            );
        }
        tracing::debug!(
            selection_id,
            source_app = %observation.source_app,
            text_len = observation.text.chars().count(),
            anchor_kind = ?observation.anchor_kind,
            anchor_x = observation.anchor.x,
            anchor_y = observation.anchor.y,
            position_x = placement.window_position.x,
            position_y = placement.window_position.y,
            resolved_placement = ?placement.direction,
            "live selection toolbar reanchored"
        );
        Ok(())
    }

    async fn publish_selection(&self, app: &AppHandle, observation: SelectionObservation) {
        tracing::debug!(
            source_app = %observation.source_app,
            text_len = observation.text.chars().count(),
            "publishing selection"
        );
        let settings =
            match aqbot_core::repo::settings::get_settings(&app.state::<crate::AppState>().sea_db)
                .await
            {
                Ok(settings) if settings.selection_toolbar.enabled => settings,
                _ => return,
            };
        if settings.selection_toolbar.trigger_mode != SelectionToolbarTriggerMode::Selection {
            tracing::debug!("selection cached until the configured shortcut is pressed");
            return;
        }
        if !settings
            .selection_toolbar
            .allows_source_app(&observation.source_app)
        {
            tracing::debug!(
                source_app = %observation.source_app,
                mode = ?settings.selection_toolbar.app_filter_mode,
                "selection ignored by app filter"
            );
            return;
        }
        let _ = self.show_selection(app, observation, &settings).await;
    }

    async fn show_selection(
        &self,
        app: &AppHandle,
        observation: SelectionObservation,
        settings: &AppSettings,
    ) -> Result<(), String> {
        self.refresh_dragged_state(app).await;
        match self.selection_publish_decision(&observation).await {
            SelectionPublishDecision::PublishNew => {}
            SelectionPublishDecision::ReanchorLive { selection_id } => {
                return self
                    .reanchor_live_selection(app, &selection_id, observation)
                    .await;
            }
            SelectionPublishDecision::Ignore => return Ok(()),
        }
        let status = self.status().await;
        if status.state != RuntimeState::Running {
            self.set_runtime_state(RuntimeState::Running, status.permission, None)
                .await;
        }
        let tools = toolbar_tool_views(&settings);
        if tools.is_empty() {
            let _ = self.hide(app, "no_enabled_tools").await;
            return Err("Selection toolbar has no enabled tools".into());
        }
        let toolbar_width = toolbar_width_for(settings.selection_toolbar.display_mode, tools.len());
        let theme = toolbar_theme(app, &settings);
        let anchor = observation.anchor;
        let anchor_kind = observation.anchor_kind;
        let source_app = observation.source_app.clone();
        let text_len = observation.text.chars().count();
        *self.surface.lock().await = SurfaceSize::Toolbar;
        *self.toolbar_width.lock().await = toolbar_width;
        *self.preferred_placement.lock().await = settings.selection_toolbar.placement;
        self.dragged_for_session.store(false, Ordering::Relaxed);
        let placement = match window::show_surface(
            app,
            anchor,
            anchor_kind,
            SurfaceSize::Toolbar,
            toolbar_width,
            settings.selection_toolbar.placement,
        ) {
            Ok(placement) => placement,
            Err(error) => {
                self.set_error("window_show_failed", error.clone()).await;
                return Err(error);
            }
        };
        *self.resolved_placement.lock().await = placement.direction;
        let session = {
            let mut store = self.store.lock().await;
            let id = store.accept_selection(
                observation,
                tools,
                theme,
                &settings.language,
                settings.selection_toolbar.display_mode,
                settings
                    .selection_toolbar
                    .translate_target_language
                    .as_deref(),
                placement.direction,
                settings.selection_toolbar.result_pinned_by_default,
            );
            store
                .snapshot()
                .session
                .filter(|session| session.selection_id == id)
        };
        tracing::debug!(
            source_app = %source_app,
            text_len,
            anchor_kind = ?anchor_kind,
            anchor_x = anchor.x,
            anchor_y = anchor.y,
            anchor_width = anchor.width,
            anchor_height = anchor.height,
            position_x = placement.window_position.x,
            position_y = placement.window_position.y,
            resolved_placement = ?placement.direction,
            arbitration = "publish_new",
            "selection toolbar placement resolved"
        );
        tracing::info!(
            position_x = placement.window_position.x,
            position_y = placement.window_position.y,
            "selection toolbar window shown"
        );
        *self.last_window_position.lock().await = Some(placement.window_position);
        *self.last_toolbar_position.lock().await = Some(placement.toolbar_position);
        if let Some(session) = session {
            tracing::debug!(
                selection_id = %session.selection_id,
                frontend_ready = self.frontend_ready.load(Ordering::Relaxed),
                "selection toolbar show"
            );
            if self.frontend_ready.load(Ordering::Relaxed) {
                let _ = app.emit_to(
                    window::SELECTION_TOOLBAR_WINDOW_LABEL,
                    "selection-toolbar://session",
                    session,
                );
            } else {
                *self.pending_session.lock().await = Some(session);
            }
        }
        Ok(())
    }

    async fn refresh_session(&self, app: &AppHandle, settings: &AppSettings) {
        let tools = toolbar_tool_views(settings);
        if tools.is_empty() {
            let _ = self.hide(app, "no_enabled_tools").await;
            return;
        }
        let toolbar_width = toolbar_width_for(settings.selection_toolbar.display_mode, tools.len());
        let theme = toolbar_theme(app, settings).to_string();
        let session = {
            let mut store = self.store.lock().await;
            store.refresh_session(
                tools,
                &theme,
                &settings.language,
                settings.selection_toolbar.display_mode,
                settings
                    .selection_toolbar
                    .translate_target_language
                    .as_deref(),
            );
            store.snapshot().session
        };
        let previous_toolbar_width = {
            let mut current = self.toolbar_width.lock().await;
            let previous = *current;
            *current = toolbar_width;
            previous
        };
        if session.is_some()
            && *self.surface.lock().await == SurfaceSize::Toolbar
            && (previous_toolbar_width - toolbar_width).abs() > f64::EPSILON
        {
            if let Some(position) = window::current_screen_position(app) {
                let centered_position = ScreenPoint {
                    x: position.x - (toolbar_width - previous_toolbar_width) / 2.0,
                    y: position.y,
                };
                match window::show_surface_at_position(
                    app,
                    centered_position,
                    SurfaceSize::Toolbar,
                    toolbar_width,
                ) {
                    Ok(position) => {
                        *self.last_window_position.lock().await = Some(position);
                        *self.last_toolbar_position.lock().await = Some(position);
                    }
                    Err(error) => {
                        self.set_error("window_resize_failed", error).await;
                        return;
                    }
                }
            }
        }
        if let Some(session) = session {
            let _ = app.emit_to(
                window::SELECTION_TOOLBAR_WINDOW_LABEL,
                "selection-toolbar://session",
                session,
            );
        }
    }

    async fn stop(&self, app: &AppHandle) {
        if let Some(handle) = self.monitor.lock().await.take() {
            handle.stop();
        }
        self.clear_selection_candidate().await;
        let _ = self.hide(app, "disabled").await;
        self.set_runtime_state(RuntimeState::Disabled, platform::permission_state(), None)
            .await;
    }

    async fn set_error(&self, code: &str, message: String) {
        self.set_runtime_state(
            RuntimeState::Error,
            self.status().await.permission,
            Some(RuntimeError {
                code: code.into(),
                message,
            }),
        )
        .await;
    }

    fn elapsed_ms(&self) -> u64 {
        self.debounce_clock.elapsed().as_millis() as u64
    }

    async fn set_runtime_state(
        &self,
        state: RuntimeState,
        permission: PermissionState,
        last_error: Option<RuntimeError>,
    ) {
        self.store.lock().await.set_status(RuntimeStatus {
            state,
            platform: SelectionPlatform::current(),
            permission,
            last_error,
            global_dismissal_supported: matches!(
                SelectionPlatform::current(),
                SelectionPlatform::Macos | SelectionPlatform::Windows
            ),
        });
    }

    async fn refresh_permission_status(&self) -> RuntimeStatus {
        let permission = platform::permission_state();
        let (status, permission_revoked) = {
            let mut store = self.store.lock().await;
            let previous = store.status();
            let permission_revoked = permission == PermissionState::Denied
                && matches!(
                    previous.state,
                    RuntimeState::Starting | RuntimeState::Running
                );
            let status = normalize_permission_status(previous, permission);
            store.set_status(status.clone());
            (status, permission_revoked)
        };
        if permission_revoked {
            if let Some(handle) = self.monitor.lock().await.take() {
                handle.stop();
            }
        }
        status
    }
}

fn position_changed(current: ScreenPoint, previous: ScreenPoint) -> bool {
    (current.x - previous.x).abs() > 2.0 || (current.y - previous.y).abs() > 2.0
}

fn keep_after_dismiss(reason: DismissReason, sticky_interaction: bool) -> bool {
    reason == DismissReason::AppChanged && sticky_interaction
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::selection_toolbar::{ScreenRect, SelectionAnchorKind};

    fn observation(text: &str, source_app: &str) -> SelectionObservation {
        SelectionObservation {
            text: text.into(),
            source_app: source_app.into(),
            source_window: "window".into(),
            range_signature: "range:0:4".into(),
            anchor: ScreenRect {
                x: 10.0,
                y: 20.0,
                width: 30.0,
                height: 12.0,
            },
            anchor_kind: SelectionAnchorKind::SelectionRect,
        }
    }

    async fn runtime_with_live_selection(text: &str) -> Arc<SelectionToolbarRuntime> {
        let runtime = Arc::new(SelectionToolbarRuntime::new());
        runtime.store.lock().await.accept_selection(
            observation(text, "com.example.editor"),
            vec![],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
            SelectionToolbarPlacement::Below,
            false,
        );
        runtime
    }

    #[tokio::test]
    async fn pointer_reannouncement_requests_a_live_reanchor() {
        let runtime = runtime_with_live_selection("hello").await;

        // Same app + text with a different anchor/signature (probe vs AX path).
        let mut duplicate = observation("hello", "com.example.editor");
        duplicate.range_signature = "marker:deadbeef".into();
        duplicate.anchor.x = 500.0;
        duplicate.anchor_kind = SelectionAnchorKind::Pointer;

        assert!(matches!(
            runtime.selection_publish_decision(&duplicate).await,
            SelectionPublishDecision::ReanchorLive { .. }
        ));
        assert_eq!(
            runtime
                .selection_publish_decision(&observation("different", "com.example.editor"))
                .await,
            SelectionPublishDecision::PublishNew
        );
    }

    #[tokio::test]
    async fn live_pointer_anchor_is_never_downgraded_to_a_selection_rect() {
        let runtime = runtime_with_live_selection("hello").await;
        let mut pointer = observation("hello", "com.example.editor");
        pointer.anchor_kind = SelectionAnchorKind::Pointer;
        let selection_id = runtime
            .store
            .lock()
            .await
            .snapshot()
            .session
            .expect("live session")
            .selection_id;
        assert!(runtime
            .store
            .lock()
            .await
            .reanchor_selection(&selection_id, pointer));

        assert_eq!(
            runtime
                .selection_publish_decision(&observation("hello", "com.example.editor"))
                .await,
            SelectionPublishDecision::Ignore
        );
    }

    #[tokio::test]
    async fn live_pointer_reanchor_respects_drag_interaction_and_surface_guards() {
        let runtime = runtime_with_live_selection("hello").await;
        let mut pointer = observation("hello", "com.example.editor");
        pointer.anchor_kind = SelectionAnchorKind::Pointer;

        runtime.dragged_for_session.store(true, Ordering::Relaxed);
        assert_eq!(
            runtime.selection_publish_decision(&pointer).await,
            SelectionPublishDecision::Ignore
        );
        assert_eq!(
            runtime
                .selection_publish_decision(&observation("different", "com.example.editor"))
                .await,
            SelectionPublishDecision::PublishNew
        );

        runtime.dragged_for_session.store(false, Ordering::Relaxed);
        runtime.lock_interaction();
        assert_eq!(
            runtime.selection_publish_decision(&pointer).await,
            SelectionPublishDecision::Ignore
        );
        runtime.unlock_interaction();

        for surface in [SurfaceSize::Overflow, SurfaceSize::Result] {
            *runtime.surface.lock().await = surface;
            assert_eq!(
                runtime.selection_publish_decision(&pointer).await,
                SelectionPublishDecision::Ignore
            );
        }
    }

    #[test]
    fn live_reanchor_guard_requires_an_idle_undragged_toolbar() {
        assert!(live_reanchor_allowed(SurfaceSize::Toolbar, false, false));
        assert!(!live_reanchor_allowed(SurfaceSize::Toolbar, true, false));
        assert!(!live_reanchor_allowed(SurfaceSize::Toolbar, false, true));
        assert!(!live_reanchor_allowed(SurfaceSize::Overflow, false, false));
        assert!(!live_reanchor_allowed(SurfaceSize::Result, false, false));
    }

    #[tokio::test]
    async fn no_selection_is_published_while_the_user_interacts_with_the_toolbar() {
        let runtime = runtime_with_live_selection("hello").await;
        runtime.lock_interaction();

        assert_eq!(
            runtime
                .selection_publish_decision(&observation("different", "com.example.editor"))
                .await,
            SelectionPublishDecision::Ignore
        );

        runtime.unlock_interaction();
        assert_eq!(
            runtime
                .selection_publish_decision(&observation("different", "com.example.editor"))
                .await,
            SelectionPublishDecision::PublishNew
        );
    }

    #[tokio::test]
    async fn result_surface_blocks_replacement_and_app_change_dismissal() {
        let runtime = runtime_with_live_selection("hello").await;
        assert!(!runtime.sticky_interaction_active().await);

        *runtime.surface.lock().await = SurfaceSize::Result;

        assert!(runtime.sticky_interaction_active().await);
        assert_eq!(
            runtime
                .selection_publish_decision(&observation("different", "com.example.editor"))
                .await,
            SelectionPublishDecision::Ignore
        );
        assert!(keep_after_dismiss(DismissReason::AppChanged, true));
        assert!(!keep_after_dismiss(DismissReason::Escape, true));
    }

    #[tokio::test]
    async fn only_a_pinned_result_survives_an_outside_click() {
        let runtime = runtime_with_live_selection("hello").await;
        *runtime.surface.lock().await = SurfaceSize::Result;
        assert!(!runtime.pinned_result_active().await);

        let selection_id = runtime
            .store
            .lock()
            .await
            .snapshot()
            .session
            .expect("live session")
            .selection_id;
        assert!(runtime.set_pinned(&selection_id, true).await.unwrap());
        assert!(runtime.pinned_result_active().await);
        assert!(!runtime.set_pinned(&selection_id, false).await.unwrap());
        assert!(!runtime.pinned_result_active().await);
    }

    #[tokio::test]
    async fn without_a_live_session_every_selection_publishes() {
        let runtime = Arc::new(SelectionToolbarRuntime::new());
        runtime.lock_interaction();

        assert_eq!(
            runtime
                .selection_publish_decision(&observation("hello", "com.example.editor"))
                .await,
            SelectionPublishDecision::PublishNew
        );
    }

    #[tokio::test]
    async fn shortcut_candidate_tracks_the_latest_non_empty_selection() {
        let runtime = SelectionToolbarRuntime::new();
        runtime
            .remember_selection_candidate(&observation("first", "app.one"))
            .await;
        runtime
            .remember_selection_candidate(&observation("second", "app.two"))
            .await;

        let candidate = runtime.pending_selection.lock().await.clone();
        assert_eq!(
            candidate
                .as_ref()
                .map(|value| value.observation.text.as_str()),
            Some("second")
        );
        assert_eq!(
            candidate
                .as_ref()
                .map(|value| value.observation.source_app.as_str()),
            Some("app.two")
        );

        runtime
            .remember_selection_candidate(&observation("   ", "app.two"))
            .await;
        assert!(runtime.pending_selection.lock().await.is_none());
    }

    #[test]
    fn shortcut_pointer_arbitration_is_limited_to_the_observation_race_window() {
        let mut pointer = observation("same", "com.example.editor");
        pointer.anchor_kind = SelectionAnchorKind::Pointer;
        let rect = observation("same", "com.example.editor");

        let pending = merge_shortcut_candidate(None, pointer, 0);
        let within_race = merge_shortcut_candidate(Some(pending.clone()), rect.clone(), 50);
        let after_race = merge_shortcut_candidate(Some(pending), rect, 201);

        assert_eq!(
            within_race.observation.anchor_kind,
            SelectionAnchorKind::Pointer
        );
        assert_eq!(
            after_race.observation.anchor_kind,
            SelectionAnchorKind::SelectionRect
        );
    }

    #[test]
    fn default_toolbar_views_include_explain_with_lightbulb_icon() {
        let views = toolbar_tool_views(&AppSettings::default());
        let explain = views
            .iter()
            .find(|view| view.id == "explain")
            .expect("default toolbar should include explain");
        assert_eq!(explain.icon, "lightbulb");
        let search = views
            .iter()
            .find(|view| view.id == "search")
            .expect("default toolbar should include search");
        assert_eq!(search.icon, "search");
        assert_eq!(search.kind, "action");
    }

    #[test]
    fn toolbar_width_uses_the_display_mode_and_enabled_tool_count() {
        assert_eq!(
            toolbar_width_for(SelectionToolbarDisplayMode::Full, 7),
            TOOLBAR_WIDTH
        );
        assert_eq!(
            toolbar_width_for(SelectionToolbarDisplayMode::Compact, 1),
            82.0
        );
        assert_eq!(
            toolbar_width_for(SelectionToolbarDisplayMode::Compact, 7),
            230.0
        );
    }
}

fn toolbar_tool_views(settings: &AppSettings) -> Vec<ToolbarToolView> {
    settings
        .selection_toolbar
        .tools
        .iter()
        .filter(|tool| tool.enabled())
        .map(|tool| match tool {
            SelectionToolbarTool::BuiltinAi { builtin_key, .. } => ToolbarToolView::ai(
                builtin_key.as_str(),
                Some(builtin_key.as_str()),
                None,
                match builtin_key {
                    SelectionToolbarBuiltinAiKey::Translate => "languages",
                    SelectionToolbarBuiltinAiKey::Explain => "lightbulb",
                    SelectionToolbarBuiltinAiKey::Polish => "spell-check",
                    SelectionToolbarBuiltinAiKey::Summarize => "list-collapse",
                },
            ),
            SelectionToolbarTool::BuiltinAction { builtin_key, .. } => ToolbarToolView::action(
                builtin_key.as_str(),
                builtin_key.as_str(),
                match builtin_key {
                    SelectionToolbarBuiltinActionKey::Copy => "copy",
                    SelectionToolbarBuiltinActionKey::Search => "search",
                },
            ),
            SelectionToolbarTool::CustomAi { id, name, icon, .. } => {
                ToolbarToolView::ai(id, None, Some(name), icon)
            }
        })
        .collect()
}

fn toolbar_width_for(display_mode: SelectionToolbarDisplayMode, tool_count: usize) -> f64 {
    match display_mode {
        SelectionToolbarDisplayMode::Full => TOOLBAR_WIDTH,
        SelectionToolbarDisplayMode::Compact => compact_toolbar_width(tool_count),
    }
}

fn sanitize_overflow_height(requested_height: Option<f64>) -> f64 {
    requested_height
        .filter(|height| height.is_finite())
        .unwrap_or(OVERFLOW_SURFACE_MAX_HEIGHT)
        .clamp(TOOLBAR_HEIGHT, OVERFLOW_SURFACE_MAX_HEIGHT)
}

fn toolbar_theme(app: &AppHandle, settings: &AppSettings) -> &'static str {
    if settings.selection_toolbar.theme_follow || settings.theme_mode == "system" {
        return match app
            .get_webview_window("main")
            .and_then(|window| window.theme().ok())
        {
            Some(Theme::Dark) => "dark",
            _ => "light",
        };
    }
    if settings.theme_mode == "dark" {
        "dark"
    } else {
        "light"
    }
}
