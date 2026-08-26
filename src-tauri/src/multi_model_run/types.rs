use aqbot_core::types::{
    AttachmentInput, MultiModelContinuationMode, MultiModelExecutionMode, MultiModelTarget,
};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MultiModelTargetState {
    Queued,
    Starting,
    Streaming,
    Complete,
    Error,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MultiModelRunPhase {
    Starting,
    Running,
    Waiting,
    Stopping,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelTargetSnapshot {
    pub index: i32,
    pub target: MultiModelTarget,
    pub state: MultiModelTargetState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelRunSnapshot {
    pub run_id: String,
    pub conversation_id: String,
    pub parent_message_id: Option<String>,
    pub mode: MultiModelExecutionMode,
    pub interval_seconds: u32,
    pub phase: MultiModelRunPhase,
    pub next_start_at: Option<i64>,
    pub targets: Vec<MultiModelTargetSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelRunEnvelope {
    pub conversation_id: String,
    pub revision: u64,
    pub active_run: Option<MultiModelRunSnapshot>,
}

#[derive(Debug, Clone)]
pub struct StartMultiModelInput {
    pub conversation_id: String,
    pub content: String,
    pub attachments: Vec<AttachmentInput>,
    pub search_provider_id: Option<String>,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub thinking_budget: Option<u32>,
    pub thinking_level: Option<String>,
    pub enabled_knowledge_base_ids: Option<Vec<String>>,
    pub enabled_memory_namespace_ids: Option<Vec<String>>,
    pub history_mode: MultiModelContinuationMode,
    pub targets: Vec<MultiModelTarget>,
    pub execution_mode: MultiModelExecutionMode,
    pub interval_seconds: u32,
}

#[derive(Debug)]
pub enum StreamTerminal {
    Complete,
    Error { message: String },
    Cancelled,
}

pub struct StreamHandle {
    pub stream_id: String,
    pub message_id: String,
    pub terminal: oneshot::Receiver<StreamTerminal>,
}

impl StreamHandle {
    pub fn immediate(stream_id: String, message_id: String, terminal: StreamTerminal) -> Self {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(terminal);
        Self {
            stream_id,
            message_id,
            terminal: rx,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PersistUserTurnInput {
    pub conversation_id: String,
    pub content: String,
    pub attachments: Vec<AttachmentInput>,
}

#[derive(Debug, Clone)]
pub struct PersistedTurn {
    pub user_message_id: String,
}

#[derive(Debug, Clone)]
pub struct StartTargetRequest {
    pub conversation_id: String,
    pub user_message_id: String,
    pub target: MultiModelTarget,
    pub version_index: i32,
    pub create_inactive: bool,
    pub allow_parallel: bool,
    pub history_mode: MultiModelContinuationMode,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub thinking_budget: Option<u32>,
    pub thinking_level: Option<String>,
    pub enabled_knowledge_base_ids: Option<Vec<String>>,
    pub enabled_memory_namespace_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct MarkTargetErrorRequest {
    pub conversation_id: String,
    pub user_message_id: String,
    pub target: MultiModelTarget,
    pub version_index: i32,
    pub create_inactive: bool,
    pub error: String,
}

#[async_trait::async_trait]
pub trait MultiModelTurnAdapter: Send + Sync {
    async fn persist_user_turn(&self, input: PersistUserTurnInput) -> Result<PersistedTurn, String>;
    async fn start_target(&self, request: StartTargetRequest) -> Result<StreamHandle, String>;
    async fn cancel_stream(
        &self,
        conversation_id: &str,
        stream_id: Option<&str>,
    ) -> Result<(), String>;
    async fn mark_target_error(&self, request: MarkTargetErrorRequest) -> Result<String, String>;
    async fn emit_envelope(&self, envelope: MultiModelRunEnvelope);
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
