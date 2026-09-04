use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy)]
pub enum AgentWaitStage {
    PreparingResources,
    PreparingSkills,
    PreparingContext,
    WaitingModel,
    Streaming,
}

impl AgentWaitStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PreparingResources => "preparing_resources",
            Self::PreparingSkills => "preparing_skills",
            Self::PreparingContext => "preparing_context",
            Self::WaitingModel => "waiting_model",
            Self::Streaming => "streaming",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusPayload {
    pub conversation_id: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    pub stage_started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_wait_ms: Option<u64>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn duration_from_timeout_secs(seconds: u64) -> Option<Duration> {
    (seconds > 0).then(|| Duration::from_secs(seconds))
}

pub fn emit_agent_stage(
    app: &AppHandle,
    conversation_id: &str,
    run_id: &str,
    stage: AgentWaitStage,
) {
    emit_agent_status(
        app,
        AgentStatusPayload {
            conversation_id: conversation_id.to_string(),
            run_id: run_id.to_string(),
            stage: Some(stage.as_str().to_string()),
            stage_started_at: now_ms(),
            message: None,
            retry_attempt: None,
            retry_wait_ms: None,
        },
    );
}

pub fn emit_agent_retry(
    app: &AppHandle,
    conversation_id: &str,
    run_id: &str,
    attempt: u32,
    wait_ms: u64,
) {
    emit_agent_status(
        app,
        AgentStatusPayload {
            conversation_id: conversation_id.to_string(),
            run_id: run_id.to_string(),
            stage: None,
            stage_started_at: now_ms(),
            message: None,
            retry_attempt: Some(attempt),
            retry_wait_ms: Some(wait_ms),
        },
    );
}

pub fn emit_agent_status_message(
    app: &AppHandle,
    conversation_id: &str,
    run_id: &str,
    message: &str,
) {
    emit_agent_status(
        app,
        AgentStatusPayload {
            conversation_id: conversation_id.to_string(),
            run_id: run_id.to_string(),
            stage: None,
            stage_started_at: now_ms(),
            message: Some(message.to_string()),
            retry_attempt: None,
            retry_wait_ms: None,
        },
    );
}

pub fn emit_agent_status(app: &AppHandle, payload: AgentStatusPayload) {
    if let Some(stage) = &payload.stage {
        tracing::info!(
            run_id = %payload.run_id,
            conversation_id = %payload.conversation_id,
            stage,
            "agent stage start"
        );
    } else if payload.retry_attempt.is_some() {
        tracing::info!(
            run_id = %payload.run_id,
            conversation_id = %payload.conversation_id,
            retry_attempt = payload.retry_attempt,
            retry_wait_ms = payload.retry_wait_ms,
            "agent retry wait"
        );
    }
    let _ = app.emit("agent-status", payload);
}

pub struct AgentStatusClearGuard {
    app: AppHandle,
    conversation_id: String,
    run_id: String,
    pub armed: bool,
}

impl AgentStatusClearGuard {
    pub fn new(app: AppHandle, conversation_id: String, run_id: String) -> Self {
        Self {
            app,
            conversation_id,
            run_id,
            armed: true,
        }
    }

    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for AgentStatusClearGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        emit_agent_status_message(&self.app, &self.conversation_id, &self.run_id, "");
    }
}
