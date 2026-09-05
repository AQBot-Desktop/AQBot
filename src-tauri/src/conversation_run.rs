use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const ACTIVE_CONVERSATION_RUN_EXISTS_ERROR: &str =
    "当前会话已有回复正在生成，请等待完成或停止后再发送";
pub const CONVERSATION_RUN_UPDATED_EVENT: &str = "conversation-run-updated";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConversationRunMode {
    Chat,
    Agent,
    MultiModel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConversationRunPhase {
    Preparing,
    Streaming,
    Stopping,
    Complete,
    Error,
    Cancelled,
}

impl ConversationRunPhase {
    pub fn is_live(self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Streaming | Self::Stopping
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunSnapshot {
    pub conversation_id: String,
    pub run_id: String,
    pub stream_id: Option<String>,
    pub message_id: Option<String>,
    pub mode: ConversationRunMode,
    pub phase: ConversationRunPhase,
    pub revision: u64,
    pub content: String,
    pub thinking: Option<String>,
    pub pending_permission: Option<serde_json::Value>,
    pub pending_ask: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunUpdatedEvent {
    pub conversation_id: String,
    pub revision: u64,
    pub snapshot: Option<ConversationRunSnapshot>,
}

#[derive(Debug, Clone)]
struct ConversationRunRecord {
    snapshot: ConversationRunSnapshot,
}

#[derive(Clone, Default)]
pub struct ConversationRunRegistry {
    inner: Arc<Mutex<HashMap<String, ConversationRunRecord>>>,
}

pub struct ConversationRunGuard {
    registry: ConversationRunRegistry,
    conversation_id: String,
    run_id: String,
    released: bool,
}

impl ConversationRunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn admit(
        &self,
        conversation_id: &str,
        run_id: &str,
        stream_id: Option<&str>,
        mode: ConversationRunMode,
    ) -> Result<ConversationRunGuard, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "conversation run registry lock poisoned".to_string())?;
        if let Some(existing) = inner.get(conversation_id) {
            if existing.snapshot.phase.is_live() {
                return Err(ACTIVE_CONVERSATION_RUN_EXISTS_ERROR.to_string());
            }
        }
        let snapshot = ConversationRunSnapshot {
            conversation_id: conversation_id.to_string(),
            run_id: run_id.to_string(),
            stream_id: stream_id.map(ToString::to_string),
            message_id: None,
            mode,
            phase: ConversationRunPhase::Preparing,
            revision: inner
                .get(conversation_id)
                .map(|record| record.snapshot.revision + 1)
                .unwrap_or(1),
            content: String::new(),
            thinking: None,
            pending_permission: None,
            pending_ask: None,
        };
        inner.insert(
            conversation_id.to_string(),
            ConversationRunRecord {
                snapshot: snapshot.clone(),
            },
        );
        Ok(ConversationRunGuard {
            registry: self.clone(),
            conversation_id: conversation_id.to_string(),
            run_id: run_id.to_string(),
            released: false,
        })
    }

    pub fn snapshot(&self, conversation_id: &str) -> Option<ConversationRunSnapshot> {
        let inner = self.inner.lock().ok()?;
        inner.get(conversation_id).map(|record| record.snapshot.clone())
    }

    pub fn list_active(&self) -> Vec<ConversationRunSnapshot> {
        let Ok(inner) = self.inner.lock() else {
            return Vec::new();
        };
        inner
            .values()
            .filter(|record| record.snapshot.phase.is_live())
            .map(|record| record.snapshot.clone())
            .collect()
    }

    pub fn update(
        &self,
        conversation_id: &str,
        run_id: &str,
        mutate: impl FnOnce(&mut ConversationRunSnapshot),
    ) -> Option<ConversationRunSnapshot> {
        let mut inner = self.inner.lock().ok()?;
        let record = inner.get_mut(conversation_id)?;
        if record.snapshot.run_id != run_id {
            return None;
        }
        mutate(&mut record.snapshot);
        record.snapshot.revision += 1;
        Some(record.snapshot.clone())
    }

    pub fn release(&self, conversation_id: &str, run_id: &str) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        match inner.get(conversation_id) {
            Some(record) if record.snapshot.run_id == run_id => {
                inner.remove(conversation_id);
                true
            }
            _ => false,
        }
    }
}

impl ConversationRunGuard {
    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn release(&mut self) -> bool {
        if self.released {
            return false;
        }
        self.released = true;
        self.registry.release(&self.conversation_id, &self.run_id)
    }

    pub fn defuse(&mut self) {
        self.released = true;
    }
}

impl Drop for ConversationRunGuard {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admit_rejects_a_second_live_run_for_the_same_conversation() {
        let registry = ConversationRunRegistry::new();
        let first = registry
            .admit("conv-a", "run-1", Some("stream-1"), ConversationRunMode::Chat)
            .unwrap();
        let error = match registry.admit(
            "conv-a",
            "run-2",
            Some("stream-2"),
            ConversationRunMode::Agent,
        ) {
            Ok(_) => panic!("second admit should be rejected"),
            Err(error) => error,
        };
        assert_eq!(error, ACTIVE_CONVERSATION_RUN_EXISTS_ERROR);
        assert!(registry.snapshot("conv-a").unwrap().phase.is_live());
        drop(first);
        assert!(registry.snapshot("conv-a").is_none());
        let second = registry
            .admit("conv-a", "run-2", Some("stream-2"), ConversationRunMode::Chat)
            .unwrap();
        assert_eq!(second.run_id(), "run-2");
    }

    #[test]
    fn different_conversations_can_run_in_parallel() {
        let registry = ConversationRunRegistry::new();
        let a = registry
            .admit("conv-a", "run-a", Some("stream-a"), ConversationRunMode::Chat)
            .unwrap();
        let b = registry
            .admit("conv-b", "run-b", Some("stream-b"), ConversationRunMode::Agent)
            .unwrap();
        let listed = registry.list_active();
        assert_eq!(listed.len(), 2);
        drop(a);
        drop(b);
        assert!(registry.list_active().is_empty());
    }

    #[test]
    fn updates_and_releases_require_matching_run_id() {
        let registry = ConversationRunRegistry::new();
        let guard = registry
            .admit("conv-a", "run-1", Some("stream-1"), ConversationRunMode::Chat)
            .unwrap();
        assert!(registry
            .update("conv-a", "run-other", |snapshot| {
                snapshot.content.push_str("stale");
            })
            .is_none());
        let updated = registry
            .update("conv-a", "run-1", |snapshot| {
                snapshot.phase = ConversationRunPhase::Streaming;
                snapshot.message_id = Some("msg-1".into());
                snapshot.content.push_str("hello");
            })
            .unwrap();
        assert_eq!(updated.phase, ConversationRunPhase::Streaming);
        assert_eq!(updated.content, "hello");
        assert!(!registry.release("conv-a", "run-other"));
        assert!(registry.release("conv-a", "run-1"));
        drop(guard);
        assert!(registry.snapshot("conv-a").is_none());
    }

    #[test]
    fn releasing_a_run_allows_a_new_admit_before_later_work_finishes() {
        let registry = ConversationRunRegistry::new();
        let mut first = registry
            .admit("conv-a", "run-1", Some("stream-1"), ConversationRunMode::Chat)
            .unwrap();
        assert!(first.release());
        let second = registry
            .admit("conv-a", "run-2", Some("stream-2"), ConversationRunMode::Chat)
            .unwrap();
        assert_eq!(second.run_id(), "run-2");
        drop(first);
        assert_eq!(
            registry.snapshot("conv-a").unwrap().run_id,
            "run-2"
        );
    }
}
