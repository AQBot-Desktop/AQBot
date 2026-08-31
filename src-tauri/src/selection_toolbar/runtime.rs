use aqbot_core::types::{
    ChatContent, ChatMessage, ChatRequest, SelectionToolbarDisplayMode, SelectionToolbarPlacement,
};
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
    #[serde(default)]
    pub resolved_placement: SelectionToolbarPlacement,
    #[serde(default)]
    pub pinned: bool,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolRunMode {
    NewTool,
    FollowUp,
    Regenerate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolRunView {
    pub request_id: String,
    pub selection_id: String,
    pub tool_id: String,
    pub mode: ToolRunMode,
    pub user_input: Option<String>,
    pub status: ToolRunStatus,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolRunHistoryStatus {
    Completed,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolRunHistoryView {
    pub request_id: String,
    pub mode: ToolRunMode,
    pub user_input: Option<String>,
    pub status: ToolRunHistoryStatus,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSnapshot {
    pub runtime: RuntimeStatus,
    pub session: Option<SessionView>,
    pub run: Option<ToolRunView>,
    #[serde(default)]
    pub history: Vec<ToolRunHistoryView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolRunEvent {
    Started {
        request_id: String,
        selection_id: String,
        tool_id: String,
        mode: ToolRunMode,
        user_input: Option<String>,
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

#[derive(Debug, Clone)]
pub(crate) struct ToolExecutionConfig {
    pub provider_id: String,
    /// Request template with stable model and effective parameters. Runtime
    /// supplies the per-turn transcript messages before execution.
    pub request: ChatRequest,
}

pub(crate) struct PreparedToolRun {
    pub request_id: String,
    pub selection_id: String,
    pub tool_id: String,
    pub cancel: Arc<AtomicBool>,
    pub config: ToolExecutionConfig,
    pub mode: ToolRunMode,
    pub user_input: Option<String>,
}

struct ActiveSelection {
    view: SessionView,
    observation: SelectionObservation,
}

struct ActiveRun {
    view: ToolRunView,
    cancel: Arc<AtomicBool>,
    replace_history_index: Option<usize>,
}

struct TranscriptTurn {
    view: ToolRunHistoryView,
    context_output: Option<String>,
}

struct ActiveTranscript {
    selection_id: String,
    tool_id: String,
    config: ToolExecutionConfig,
    hidden_prompt: String,
    turns: Vec<TranscriptTurn>,
}

pub struct RuntimeStore {
    runtime: RuntimeStatus,
    selection: Option<ActiveSelection>,
    run: Option<ActiveRun>,
    transcript: Option<ActiveTranscript>,
}

impl RuntimeStore {
    pub fn new(platform: SelectionPlatform) -> Self {
        Self {
            runtime: RuntimeStatus::disabled(platform),
            selection: None,
            run: None,
            transcript: None,
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
        resolved_placement: SelectionToolbarPlacement,
        pinned: bool,
    ) -> String {
        self.cancel_active_run();
        self.run = None;
        self.transcript = None;
        let selection_id = Uuid::new_v4().to_string();
        self.selection = Some(ActiveSelection {
            view: SessionView {
                selection_id: selection_id.clone(),
                tools,
                theme: theme.into(),
                language: language.into(),
                display_mode,
                translate_target_language: translate_target_language.map(str::to_string),
                resolved_placement,
                pinned,
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

    pub fn set_resolved_placement(
        &mut self,
        selection_id: &str,
        placement: SelectionToolbarPlacement,
    ) -> Option<SessionView> {
        let selection = self
            .selection
            .as_mut()
            .filter(|selection| selection.view.selection_id == selection_id)?;
        selection.view.resolved_placement = placement;
        Some(selection.view.clone())
    }

    pub fn set_pinned(&mut self, selection_id: &str, pinned: bool) -> Result<SessionView, String> {
        let selection = self
            .selection
            .as_mut()
            .filter(|selection| selection.view.selection_id == selection_id)
            .ok_or_else(|| "The selection toolbar session is no longer active".to_string())?;
        selection.view.pinned = pinned;
        Ok(selection.view.clone())
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

    pub(crate) fn begin_new_tool_run(
        &mut self,
        selection_id: &str,
        tool_id: &str,
        config: ToolExecutionConfig,
        hidden_prompt: String,
    ) -> Result<PreparedToolRun, String> {
        self.require_selection(selection_id)?;
        self.cancel_active_run();
        self.transcript = Some(ActiveTranscript {
            selection_id: selection_id.into(),
            tool_id: tool_id.into(),
            config,
            hidden_prompt,
            turns: Vec::new(),
        });
        self.prepare_run(ToolRunMode::NewTool, None, None)
    }

    pub(crate) fn begin_follow_up_run(
        &mut self,
        selection_id: &str,
        text: String,
    ) -> Result<PreparedToolRun, String> {
        self.require_selection(selection_id)?;
        self.require_idle_run()?;
        let transcript = self.require_transcript(selection_id)?;
        let latest = transcript.turns.last().filter(|turn| {
            matches!(
                turn.view.status,
                ToolRunHistoryStatus::Completed | ToolRunHistoryStatus::Stopped
            ) && turn.context_output.is_some()
        });
        if latest.is_none() {
            return Err("There is no completed selection toolbar answer to follow up".into());
        }
        self.prepare_run(ToolRunMode::FollowUp, Some(text), None)
    }

    pub(crate) fn begin_regenerate_run(
        &mut self,
        selection_id: &str,
        request_id: &str,
    ) -> Result<PreparedToolRun, String> {
        self.require_selection(selection_id)?;
        self.require_idle_run()?;
        let transcript = self.require_transcript(selection_id)?;
        let last_index = transcript
            .turns
            .len()
            .checked_sub(1)
            .ok_or_else(|| "There is no selection toolbar answer to regenerate".to_string())?;
        let turn = &transcript.turns[last_index];
        if turn.view.request_id != request_id {
            return Err("Only the latest selection toolbar answer can be regenerated".into());
        }
        self.prepare_run(
            ToolRunMode::Regenerate,
            turn.view.user_input.clone(),
            Some(last_index),
        )
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
        if !matches!(
            run.view.status,
            ToolRunStatus::Started | ToolRunStatus::Streaming
        ) {
            return false;
        }
        run.cancel.store(true, Ordering::Relaxed);
        run.view.status = ToolRunStatus::Stopped;
        self.record_terminal_run(request_id);
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
        run.view.output = output.clone();
        if let Some(turn) = self.transcript.as_mut().and_then(|transcript| {
            transcript
                .turns
                .iter_mut()
                .find(|turn| turn.view.request_id == request_id)
        }) {
            turn.view.output = output.clone();
            if turn.view.status != ToolRunHistoryStatus::Error {
                turn.context_output = non_blank_context_output(&output);
            }
        }
        true
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        let current_request_id = self.run.as_ref().map(|run| run.view.request_id.as_str());
        let regenerating_index = self.run.as_ref().and_then(|run| {
            (run.view.mode == ToolRunMode::Regenerate
                && matches!(
                    run.view.status,
                    ToolRunStatus::Started | ToolRunStatus::Streaming
                ))
            .then_some(run.replace_history_index)
            .flatten()
        });
        RuntimeSnapshot {
            runtime: self.runtime.clone(),
            session: self
                .selection
                .as_ref()
                .map(|selection| selection.view.clone()),
            run: self.run.as_ref().map(|run| run.view.clone()),
            history: self
                .transcript
                .as_ref()
                .map(|transcript| {
                    transcript
                        .turns
                        .iter()
                        .enumerate()
                        .filter(|(index, turn)| {
                            Some(*index) != regenerating_index
                                && Some(turn.view.request_id.as_str()) != current_request_id
                        })
                        .map(|(_, turn)| turn.view.clone())
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    pub fn clear(&mut self) {
        self.cancel_active_run();
        self.selection = None;
        self.run = None;
        self.transcript = None;
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
        self.record_terminal_run(request_id);
        true
    }

    fn prepare_run(
        &mut self,
        mode: ToolRunMode,
        user_input: Option<String>,
        replace_history_index: Option<usize>,
    ) -> Result<PreparedToolRun, String> {
        let transcript = self
            .transcript
            .as_ref()
            .ok_or_else(|| "There is no active selection toolbar conversation".to_string())?;
        let mut config = transcript.config.clone();
        config.request.messages =
            transcript_messages(transcript, replace_history_index, &user_input);
        let request_id = Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        self.run = Some(ActiveRun {
            view: ToolRunView {
                request_id: request_id.clone(),
                selection_id: transcript.selection_id.clone(),
                tool_id: transcript.tool_id.clone(),
                mode,
                user_input: user_input.clone(),
                status: ToolRunStatus::Started,
                output: String::new(),
                error: None,
            },
            cancel: cancel.clone(),
            replace_history_index,
        });
        Ok(PreparedToolRun {
            request_id,
            selection_id: transcript.selection_id.clone(),
            tool_id: transcript.tool_id.clone(),
            cancel,
            config,
            mode,
            user_input,
        })
    }

    fn require_selection(&self, selection_id: &str) -> Result<(), String> {
        self.selection
            .as_ref()
            .filter(|selection| selection.view.selection_id == selection_id)
            .map(|_| ())
            .ok_or_else(|| "Selection is no longer active".to_string())
    }

    fn require_transcript(&self, selection_id: &str) -> Result<&ActiveTranscript, String> {
        self.transcript
            .as_ref()
            .filter(|transcript| transcript.selection_id == selection_id)
            .ok_or_else(|| "There is no active selection toolbar conversation".to_string())
    }

    fn require_idle_run(&self) -> Result<(), String> {
        if self.run.as_ref().is_some_and(|run| {
            matches!(
                run.view.status,
                ToolRunStatus::Started | ToolRunStatus::Streaming
            )
        }) {
            return Err("Selection toolbar generation is still running".into());
        }
        Ok(())
    }

    fn record_terminal_run(&mut self, request_id: &str) {
        let Some(run) = self
            .run
            .as_ref()
            .filter(|run| run.view.request_id == request_id)
        else {
            return;
        };
        let (status, context_output) = match run.view.status {
            ToolRunStatus::Completed => (
                ToolRunHistoryStatus::Completed,
                non_blank_context_output(&run.view.output),
            ),
            ToolRunStatus::Stopped => (
                ToolRunHistoryStatus::Stopped,
                non_blank_context_output(&run.view.output),
            ),
            ToolRunStatus::Error => (ToolRunHistoryStatus::Error, None),
            _ => return,
        };
        let turn = TranscriptTurn {
            view: ToolRunHistoryView {
                request_id: run.view.request_id.clone(),
                mode: run.view.mode,
                user_input: run.view.user_input.clone(),
                status,
                output: run.view.output.clone(),
                error: run.view.error.clone(),
            },
            context_output,
        };
        let Some(transcript) = self.transcript.as_mut() else {
            return;
        };
        if let Some(index) = run.replace_history_index {
            if let Some(existing) = transcript.turns.get_mut(index) {
                *existing = turn;
                return;
            }
        }
        if let Some(existing) = transcript
            .turns
            .iter_mut()
            .find(|existing| existing.view.request_id == request_id)
        {
            *existing = turn;
            return;
        }
        transcript.turns.push(turn);
    }
}

fn transcript_messages(
    transcript: &ActiveTranscript,
    before_history_index: Option<usize>,
    user_input: &Option<String>,
) -> Vec<ChatMessage> {
    let end = before_history_index.unwrap_or(transcript.turns.len());
    let mut messages = vec![text_message("user", transcript.hidden_prompt.clone())];
    for turn in transcript.turns.iter().take(end) {
        let Some(output) = &turn.context_output else {
            continue;
        };
        if let Some(input) = &turn.view.user_input {
            messages.push(text_message("user", input.clone()));
        }
        messages.push(text_message("assistant", output.clone()));
    }
    if let Some(input) = user_input {
        messages.push(text_message("user", input.clone()));
    }
    messages
}

fn text_message(role: &str, text: String) -> ChatMessage {
    ChatMessage {
        role: role.into(),
        content: ChatContent::Text(text),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    }
}

fn non_blank_context_output(output: &str) -> Option<String> {
    let stripped = crate::commands::conversations::strip_think_tags(output);
    let answer = if let Some(start) = valid_open_think_start(&stripped) {
        &stripped[..start]
    } else {
        &stripped
    }
    .trim();
    (!answer.is_empty()).then(|| answer.to_string())
}

fn valid_open_think_start(output: &str) -> Option<usize> {
    output.match_indices("<think").find_map(|(start, _)| {
        let after_tag = &output[start + 6..];
        (after_tag.starts_with('>') || after_tag.starts_with(' ')).then_some(start)
    })
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

    fn execution_config() -> ToolExecutionConfig {
        ToolExecutionConfig {
            provider_id: "provider-stable".into(),
            request: ChatRequest {
                model: "model-stable".into(),
                messages: Vec::new(),
                stream: true,
                temperature: Some(0.3),
                top_p: Some(0.8),
                max_tokens: Some(2048),
                tools: None,
                thinking_budget: None,
                thinking_level: Some("medium".into()),
                reasoning_profile: None,
                use_max_completion_tokens: Some(true),
                thinking_param_style: None,
                extra_body: None,
            },
        }
    }

    fn begin_new(store: &mut RuntimeStore, selection_id: &str) -> PreparedToolRun {
        store
            .begin_new_tool_run(
                selection_id,
                "summarize",
                execution_config(),
                "hidden prompt with selected text".into(),
            )
            .unwrap()
    }

    fn message_text(message: &ChatMessage) -> &str {
        match &message.content {
            ChatContent::Text(text) => text,
            ChatContent::Multipart(_) => panic!("expected text message"),
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
            SelectionToolbarPlacement::Below,
            false,
        );

        let prepared = store
            .begin_new_tool_run(
                &selection_id,
                "summarize",
                execution_config(),
                "private selected text inside rendered prompt".into(),
            )
            .unwrap();
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
        assert_eq!(snapshot.run.unwrap().user_input, None);
        assert_eq!(prepared.config.request.messages.len(), 1);
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
            SelectionToolbarPlacement::Below,
            false,
        );
        let prepared = begin_new(&mut store, &selection_id);
        let request_id = prepared.request_id;
        assert!(store.append_delta(&request_id, "**partial**"));
        assert!(store.stop_run(&request_id));
        assert!(!store.stop_run(&request_id));
        assert!(!store.append_delta(&request_id, "late"));
        assert!(!store.append_delta("stale-request", "ignored"));

        let run = store.snapshot().run.unwrap();
        assert_eq!(run.tool_id, "summarize");
        assert_eq!(run.status, ToolRunStatus::Stopped);
        assert_eq!(run.output, "**partial**");
        assert!(store.snapshot().history.is_empty());
        let _ = store
            .begin_follow_up_run(&selection_id, "continue".into())
            .unwrap();
        let history = store.snapshot().history;
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, ToolRunHistoryStatus::Stopped);
        assert_eq!(history[0].error, None);
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
            SelectionToolbarPlacement::Below,
            false,
        );
        let cancel = begin_new(&mut store, &first).cancel;
        let second = store.accept_selection(
            selected("second"),
            vec![],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
            SelectionToolbarPlacement::Below,
            false,
        );

        assert!(cancel.load(std::sync::atomic::Ordering::Relaxed));
        assert_ne!(first, second);
        assert!(store.snapshot().run.is_none());
        assert!(store.snapshot().history.is_empty());
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
            SelectionToolbarPlacement::Below,
            false,
        );
        let prepared = begin_new(&mut store, &selection_id);
        let request_id = prepared.request_id;
        let cancel = prepared.cancel;
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
    fn follow_up_reuses_stable_execution_config_and_clean_context() {
        let mut store = RuntimeStore::new(SelectionPlatform::Macos);
        let selection_id = store.accept_selection(
            selected("private selection"),
            vec![],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
            SelectionToolbarPlacement::Below,
            false,
        );
        let first = begin_new(&mut store, &selection_id);
        assert!(store.append_delta(
            &first.request_id,
            "<think totalMs=\"8\">private reasoning</think>\n\nfirst answer"
        ));
        assert!(store.complete_run(&first.request_id));

        let follow_up = store
            .begin_follow_up_run(&selection_id, "Why?".into())
            .unwrap();

        assert_eq!(follow_up.mode, ToolRunMode::FollowUp);
        assert_eq!(follow_up.user_input.as_deref(), Some("Why?"));
        assert_eq!(follow_up.config.provider_id, "provider-stable");
        assert_eq!(follow_up.config.request.model, "model-stable");
        assert_eq!(follow_up.config.request.temperature, Some(0.3));
        assert_eq!(follow_up.config.request.max_tokens, Some(2048));
        let messages = &follow_up.config.request.messages;
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].role, "user");
        assert_eq!(
            message_text(&messages[0]),
            "hidden prompt with selected text"
        );
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(message_text(&messages[1]), "first answer");
        assert_eq!(messages[2].role, "user");
        assert_eq!(message_text(&messages[2]), "Why?");
        assert!(messages
            .iter()
            .all(|message| !message_text(message).contains("private reasoning")));

        let json = serde_json::to_string(&store.snapshot()).unwrap();
        assert!(!json.contains("hidden prompt with selected text"));
        assert!(!json.contains("private selection"));
    }

    #[test]
    fn regenerate_replaces_the_latest_turn_and_reuses_its_user_input() {
        let mut store = RuntimeStore::new(SelectionPlatform::Macos);
        let selection_id = store.accept_selection(
            selected("text"),
            vec![],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
            SelectionToolbarPlacement::Below,
            false,
        );
        let first = begin_new(&mut store, &selection_id);
        assert!(store.append_delta(&first.request_id, "first answer"));
        assert!(store.complete_run(&first.request_id));
        let first_snapshot = store.snapshot();
        assert!(first_snapshot.history.is_empty());
        assert_eq!(
            first_snapshot
                .run
                .as_ref()
                .map(|run| run.request_id.as_str()),
            Some(first.request_id.as_str())
        );
        let follow_up = store
            .begin_follow_up_run(&selection_id, "More detail".into())
            .unwrap();
        assert!(store.append_delta(&follow_up.request_id, "old detail"));
        assert!(store.complete_run(&follow_up.request_id));

        let regenerated = store
            .begin_regenerate_run(&selection_id, &follow_up.request_id)
            .unwrap();
        assert_eq!(regenerated.mode, ToolRunMode::Regenerate);
        assert_eq!(regenerated.user_input.as_deref(), Some("More detail"));
        let messages = &regenerated.config.request.messages;
        assert_eq!(messages.len(), 3);
        assert_eq!(message_text(&messages[1]), "first answer");
        assert_eq!(message_text(&messages[2]), "More detail");
        assert!(messages
            .iter()
            .all(|message| message_text(message) != "old detail"));
        let regenerating_snapshot = store.snapshot();
        assert_eq!(regenerating_snapshot.history.len(), 1);
        assert_eq!(
            regenerating_snapshot.history[0].request_id,
            first.request_id
        );

        assert!(store.append_delta(&regenerated.request_id, "new detail"));
        assert!(store.complete_run(&regenerated.request_id));
        let completed_snapshot = store.snapshot();
        assert_eq!(completed_snapshot.history.len(), 1);
        assert_eq!(
            completed_snapshot
                .run
                .as_ref()
                .map(|run| run.request_id.as_str()),
            Some(regenerated.request_id.as_str())
        );
        let _ = store
            .begin_follow_up_run(&selection_id, "next question".into())
            .unwrap();
        let history = store.snapshot().history;
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].request_id, regenerated.request_id);
        assert_eq!(history[1].mode, ToolRunMode::Regenerate);
        assert_eq!(history[1].status, ToolRunHistoryStatus::Completed);
        assert_eq!(history[1].user_input.as_deref(), Some("More detail"));
        assert_eq!(history[1].output, "new detail");
    }

    #[test]
    fn failed_turn_is_recorded_but_not_added_to_provider_context() {
        let mut store = RuntimeStore::new(SelectionPlatform::Macos);
        let selection_id = store.accept_selection(
            selected("text"),
            vec![],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
            SelectionToolbarPlacement::Below,
            false,
        );
        let first = begin_new(&mut store, &selection_id);
        assert!(store.append_delta(&first.request_id, "first answer"));
        assert!(store.complete_run(&first.request_id));
        let failed = store
            .begin_follow_up_run(&selection_id, "failed question".into())
            .unwrap();
        assert!(store.fail_run(&failed.request_id, "network error".into()));

        let snapshot = store.snapshot();
        assert_eq!(snapshot.history.len(), 1);
        let transcript = store.transcript.as_ref().unwrap();
        assert_eq!(transcript.turns[1].view.status, ToolRunHistoryStatus::Error);
        assert_eq!(
            transcript.turns[1].view.error.as_deref(),
            Some("network error")
        );
        assert!(store
            .begin_follow_up_run(&selection_id, "must not skip the error".into())
            .is_err());
        let retry = store
            .begin_regenerate_run(&selection_id, &failed.request_id)
            .unwrap();
        assert_eq!(store.snapshot().history.len(), 1);
        assert_eq!(retry.config.request.messages.len(), 3);
        assert_eq!(
            message_text(&retry.config.request.messages[2]),
            "failed question"
        );
        assert!(retry
            .config
            .request
            .messages
            .iter()
            .all(|message| !message_text(message).contains("network error")));
    }

    #[test]
    fn follow_up_requires_the_latest_turn_to_have_a_non_empty_answer() {
        let mut store = RuntimeStore::new(SelectionPlatform::Macos);
        let selection_id = store.accept_selection(
            selected("text"),
            vec![],
            "light",
            "en-US",
            SelectionToolbarDisplayMode::Full,
            None,
            SelectionToolbarPlacement::Below,
            false,
        );
        let first = begin_new(&mut store, &selection_id);
        assert!(store.append_delta(&first.request_id, "first answer"));
        assert!(store.complete_run(&first.request_id));
        let empty = store
            .begin_follow_up_run(&selection_id, "unanswered".into())
            .unwrap();
        assert!(store.stop_run(&empty.request_id));

        assert!(store
            .begin_follow_up_run(&selection_id, "must not skip empty turn".into())
            .is_err());
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
