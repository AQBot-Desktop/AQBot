use aqbot_core::types::SelectionToolbarDisplayMode;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use uuid::Uuid;

use super::SelectionObservation;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SelectionPlatform {
    Macos,
    Windows,
    Linux,
    Unsupported,
}

impl SelectionPlatform {
    pub fn current() -> Self {
        #[cfg(target_os = "macos")]
        return Self::Macos;
        #[cfg(target_os = "windows")]
        return Self::Windows;
        #[cfg(target_os = "linux")]
        return Self::Linux;
        #[allow(unreachable_code)]
        Self::Unsupported
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Disabled,
    Starting,
    Running,
    PermissionRequired,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    NotRequired,
    Granted,
    Denied,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub platform: SelectionPlatform,
    pub permission: PermissionState,
    pub last_error: Option<RuntimeError>,
    pub global_dismissal_supported: bool,
}

impl RuntimeStatus {
    pub fn disabled(platform: SelectionPlatform) -> Self {
        Self {
            state: RuntimeState::Disabled,
            platform,
            permission: if platform == SelectionPlatform::Windows {
                PermissionState::NotRequired
            } else {
                PermissionState::Unknown
            },
            last_error: None,
            global_dismissal_supported: matches!(
                platform,
                SelectionPlatform::Macos | SelectionPlatform::Windows
            ),
        }
    }
}

pub(crate) fn normalize_permission_status(
    mut status: RuntimeStatus,
    permission: PermissionState,
) -> RuntimeStatus {
    status.permission = permission;
    if permission != PermissionState::Denied {
        return status;
    }
    if matches!(status.state, RuntimeState::Starting | RuntimeState::Running) {
        status.state = RuntimeState::PermissionRequired;
    }
    if status.state == RuntimeState::PermissionRequired && status.last_error.is_none() {
        status.last_error = Some(RuntimeError {
            code: match status.platform {
                SelectionPlatform::Macos => "macos_accessibility_permission_required",
                _ => "accessibility_permission_required",
            }
            .into(),
            message: "Accessibility permission is required".into(),
        });
    }
    status
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolbarToolView {
    pub id: String,
    pub kind: String,
    pub builtin_key: Option<String>,
    pub name: Option<String>,
    pub icon: String,
}

impl ToolbarToolView {
    pub fn action(id: &str, builtin_key: &str, icon: &str) -> Self {
        Self {
            id: id.into(),
            kind: "action".into(),
            builtin_key: Some(builtin_key.into()),
            name: None,
            icon: icon.into(),
        }
    }

    pub fn ai(id: &str, builtin_key: Option<&str>, name: Option<&str>, icon: &str) -> Self {
        Self {
            id: id.into(),
            kind: "ai".into(),
            builtin_key: builtin_key.map(str::to_string),
            name: name.map(str::to_string),
            icon: icon.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionView {
    pub selection_id: String,
    pub tools: Vec<ToolbarToolView>,
    pub theme: String,
    pub language: String,
    #[serde(default)]
    pub display_mode: SelectionToolbarDisplayMode,
    /// Configured translate target language; `None` follows `language`.
    #[serde(default)]
    pub translate_target_language: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolRunStatus {
    Started,
    Streaming,
    Completed,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolRunView {
    pub request_id: String,
    pub selection_id: String,
    pub tool_id: String,
    pub status: ToolRunStatus,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSnapshot {
    pub runtime: RuntimeStatus,
    pub session: Option<SessionView>,
    pub run: Option<ToolRunView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolRunEvent {
    Started {
        request_id: String,
        selection_id: String,
        tool_id: String,
    },
    Delta {
        request_id: String,
        selection_id: String,
        delta: String,
    },
    Completed {
        request_id: String,
        selection_id: String,
        /// Post-processed final output (think tags closed and stamped with
        /// durations); the frontend replaces its accumulated text with this.
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    Stopped {
        request_id: String,
        selection_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    Error {
        request_id: String,
        selection_id: String,
        error: String,
    },
}

struct ActiveSelection {
    view: SessionView,
    observation: SelectionObservation,
}

struct ActiveRun {
    view: ToolRunView,
    cancel: Arc<AtomicBool>,
}

pub struct RuntimeStore {
    runtime: RuntimeStatus,
    selection: Option<ActiveSelection>,
    run: Option<ActiveRun>,
}

impl RuntimeStore {
    pub fn new(platform: SelectionPlatform) -> Self {
        Self {
            runtime: RuntimeStatus::disabled(platform),
            selection: None,
            run: None,
        }
    }

    pub fn status(&self) -> RuntimeStatus {
        self.runtime.clone()
    }

    pub fn set_status(&mut self, status: RuntimeStatus) {
        self.runtime = status;
    }

    pub fn accept_selection(
        &mut self,
        observation: SelectionObservation,
        tools: Vec<ToolbarToolView>,
        theme: &str,
        language: &str,
        display_mode: SelectionToolbarDisplayMode,
        translate_target_language: Option<&str>,
    ) -> String {
        self.cancel_active_run();
        self.run = None;
        let selection_id = Uuid::new_v4().to_string();
        self.selection = Some(ActiveSelection {
            view: SessionView {
                selection_id: selection_id.clone(),
                tools,
                theme: theme.into(),
                language: language.into(),
                display_mode,
                translate_target_language: translate_target_language.map(str::to_string),
            },
            observation,
        });
        selection_id
    }

    pub fn selection_text(&self, selection_id: &str) -> Option<&str> {
        self.selection
            .as_ref()
            .filter(|selection| selection.view.selection_id == selection_id)
            .map(|selection| selection.observation.text.as_str())
    }

    pub fn selection_observation(&self, selection_id: &str) -> Option<&SelectionObservation> {
        self.selection
            .as_ref()
            .filter(|selection| selection.view.selection_id == selection_id)
            .map(|selection| &selection.observation)
    }

    pub fn reanchor_selection(
        &mut self,
        selection_id: &str,
        observation: SelectionObservation,
    ) -> bool {
        let Some(selection) = self
            .selection
            .as_mut()
            .filter(|selection| selection.view.selection_id == selection_id)
        else {
            return false;
        };
        selection.observation = observation;
        true
    }

    pub fn refresh_session(
        &mut self,
        tools: Vec<ToolbarToolView>,
        theme: &str,
        language: &str,
        display_mode: SelectionToolbarDisplayMode,
        translate_target_language: Option<&str>,
    ) {
        if let Some(selection) = self.selection.as_mut() {
            selection.view.tools = tools;
            selection.view.theme = theme.into();
            selection.view.language = language.into();
            selection.view.display_mode = display_mode;
            selection.view.translate_target_language =
                translate_target_language.map(str::to_string);
        }
    }

    pub fn begin_run(
        &mut self,
        selection_id: &str,
        tool_id: &str,
    ) -> Result<(String, Arc<AtomicBool>), String> {
        let active_selection_id = self
            .selection
            .as_ref()
            .filter(|selection| selection.view.selection_id == selection_id)
            .map(|selection| selection.view.selection_id.clone())
            .ok_or_else(|| "Selection is no longer active".to_string())?;
        self.cancel_active_run();
        let request_id = Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        self.run = Some(ActiveRun {
            view: ToolRunView {
                request_id: request_id.clone(),
                selection_id: active_selection_id,
                tool_id: tool_id.into(),
                status: ToolRunStatus::Started,
                output: String::new(),
                error: None,
            },
            cancel: cancel.clone(),
        });
        Ok((request_id, cancel))
    }

    pub fn append_delta(&mut self, request_id: &str, delta: &str) -> bool {
        let Some(run) = self
            .run
            .as_mut()
            .filter(|run| run.view.request_id == request_id)
        else {
            return false;
        };
        if run.cancel.load(Ordering::Relaxed)
            || !matches!(
                run.view.status,
                ToolRunStatus::Started | ToolRunStatus::Streaming
            )
        {
            return false;
        }
        run.view.output.push_str(delta);
        run.view.status = ToolRunStatus::Streaming;
        true
    }

    pub fn complete_run(&mut self, request_id: &str) -> bool {
        self.set_run_terminal(request_id, ToolRunStatus::Completed, None)
    }

    pub fn stop_run(&mut self, request_id: &str) -> bool {
        let Some(run) = self
            .run
            .as_mut()
            .filter(|run| run.view.request_id == request_id)
        else {
            return false;
        };
        run.cancel.store(true, Ordering::Relaxed);
        run.view.status = ToolRunStatus::Stopped;
        true
    }

    pub fn fail_run(&mut self, request_id: &str, error: String) -> bool {
        self.set_run_terminal(request_id, ToolRunStatus::Error, Some(error))
    }

    pub fn run_output(&self, request_id: &str) -> Option<&str> {
        self.run
            .as_ref()
            .filter(|run| run.view.request_id == request_id)
            .map(|run| run.view.output.as_str())
    }

    /// Replace the stored output with a post-processed version (think tags
    /// closed / stamped). Unlike `append_delta` this also applies to runs that
    /// already reached a terminal state.
    pub fn replace_output(&mut self, request_id: &str, output: String) -> bool {
        let Some(run) = self
            .run
            .as_mut()
            .filter(|run| run.view.request_id == request_id)
        else {
            return false;
        };
        run.view.output = output;
        true
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        RuntimeSnapshot {
            runtime: self.runtime.clone(),
            session: self
                .selection
                .as_ref()
                .map(|selection| selection.view.clone()),
            run: self.run.as_ref().map(|run| run.view.clone()),
        }
    }

    pub fn clear(&mut self) {
        self.cancel_active_run();
        self.selection = None;
        self.run = None;
    }

    fn cancel_active_run(&mut self) {
        if let Some(run) = &self.run {
            run.cancel.store(true, Ordering::Relaxed);
        }
    }

    fn set_run_terminal(
        &mut self,
        request_id: &str,
        status: ToolRunStatus,
        error: Option<String>,
    ) -> bool {
        let Some(run) = self
            .run
            .as_mut()
            .filter(|run| run.view.request_id == request_id)
        else {
            return false;
        };
        if run.cancel.load(Ordering::Relaxed) {
            return false;
        }
        run.view.status = status;
        run.view.error = error;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::selection_toolbar::{ScreenRect, SelectionAnchorKind, SelectionObservation};

    fn selected(text: &str) -> SelectionObservation {
        SelectionObservation {
            text: text.into(),
            source_app: "editor".into(),
            source_window: "document".into(),
            range_signature: "0:4".into(),
            anchor: ScreenRect {
                x: 100.0,
                y: 200.0,
                width: 80.0,
                height: 20.0,
            },
            anchor_kind: SelectionAnchorKind::SelectionRect,
        }
    }

    #[test]
    fn public_snapshot_never_contains_selected_text() {
        let mut store = RuntimeStore::new(SelectionPlatform::Macos);
        let selection_id = store.accept_selection(
            selected("private selected text"),
            vec![ToolbarToolView::action("copy", "copy", "copy")],
            "dark",
            "zh-CN",
            SelectionToolbarDisplayMode::Compact,
            None,
        );

        let snapshot = store.snapshot();
        assert_eq!(
            snapshot
                .session
                .as_ref()
                .map(|session| session.display_mode),
            Some(SelectionToolbarDisplayMode::Compact)
        );
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains(&selection_id));
        assert!(!json.contains("private selected text"));
        assert_eq!(
            store.selection_text(&selection_id),
            Some("private selected text")
        );
    }

    #[test]
    fn stale_chunks_are_rejected_and_stop_preserves_partial_output() {
        let mut store = RuntimeStore::new(SelectionPlatform::Macos);
        let selection_id = store.accept_selection(
            selected("text"),
            vec![ToolbarToolView::ai(
                "summarize",
                Some("summarize"),
                None,
                "list-collapse",
            )],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
        );
        let (request_id, _) = store.begin_run(&selection_id, "summarize").unwrap();
        assert!(store.append_delta(&request_id, "**partial**"));
        assert!(store.stop_run(&request_id));
        assert!(!store.append_delta(&request_id, "late"));
        assert!(!store.append_delta("stale-request", "ignored"));

        let run = store.snapshot().run.unwrap();
        assert_eq!(run.tool_id, "summarize");
        assert_eq!(run.status, ToolRunStatus::Stopped);
        assert_eq!(run.output, "**partial**");
    }

    #[test]
    fn a_new_selection_cancels_the_previous_run_and_resets_result_state() {
        let mut store = RuntimeStore::new(SelectionPlatform::Macos);
        let first = store.accept_selection(
            selected("first"),
            vec![],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
        );
        let (_, cancel) = store.begin_run(&first, "summarize").unwrap();
        let second = store.accept_selection(
            selected("second"),
            vec![],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
        );

        assert!(cancel.load(std::sync::atomic::Ordering::Relaxed));
        assert_ne!(first, second);
        assert!(store.snapshot().run.is_none());
    }

    #[test]
    fn reanchoring_a_live_selection_preserves_the_session_and_streaming_run() {
        let mut store = RuntimeStore::new(SelectionPlatform::Macos);
        let selection_id = store.accept_selection(
            selected("text"),
            vec![ToolbarToolView::ai(
                "summarize",
                Some("summarize"),
                None,
                "list-collapse",
            )],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
        );
        let (request_id, cancel) = store.begin_run(&selection_id, "summarize").unwrap();
        assert!(store.append_delta(&request_id, "partial"));
        let before = store.snapshot();

        let mut reanchored = selected("text");
        reanchored.range_signature = "pointer".into();
        reanchored.anchor = ScreenRect {
            x: 640.0,
            y: 480.0,
            width: 1.0,
            height: 1.0,
        };
        reanchored.anchor_kind = SelectionAnchorKind::Pointer;

        assert!(store.reanchor_selection(&selection_id, reanchored.clone()));

        let after = store.snapshot();
        assert_eq!(after.session, before.session);
        assert_eq!(after.run, before.run);
        assert_eq!(
            store.selection_observation(&selection_id),
            Some(&reanchored)
        );
        assert!(!cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn revoked_permission_invalidates_a_cached_running_status() {
        let status = RuntimeStatus {
            state: RuntimeState::Running,
            platform: SelectionPlatform::Macos,
            permission: PermissionState::Granted,
            last_error: None,
            global_dismissal_supported: true,
        };

        let refreshed = normalize_permission_status(status, PermissionState::Denied);

        assert_eq!(refreshed.state, RuntimeState::PermissionRequired);
        assert_eq!(refreshed.permission, PermissionState::Denied);
        assert_eq!(
            refreshed.last_error.unwrap().code,
            "macos_accessibility_permission_required"
        );
    }

    #[test]
    fn disabled_runtime_still_reports_the_current_permission() {
        let status = RuntimeStatus::disabled(SelectionPlatform::Macos);

        let refreshed = normalize_permission_status(status, PermissionState::Granted);

        assert_eq!(refreshed.state, RuntimeState::Disabled);
        assert_eq!(refreshed.permission, PermissionState::Granted);
    }
}
