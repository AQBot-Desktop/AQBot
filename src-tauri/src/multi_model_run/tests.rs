use super::*;
use aqbot_core::types::{MultiModelContinuationMode, MultiModelExecutionMode, MultiModelTarget};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

#[derive(Clone)]
struct FakeAdapter {
    persist_count: Arc<AtomicUsize>,
    started: Arc<Mutex<Vec<String>>>,
    cancelled: Arc<Mutex<Vec<Option<String>>>>,
    envelopes: Arc<Mutex<Vec<MultiModelRunEnvelope>>>,
    terminals: Arc<Mutex<HashMap<String, oneshot::Sender<StreamTerminal>>>>,
    fail_start: Arc<Mutex<Vec<String>>>,
}

impl FakeAdapter {
    fn new() -> Self {
        Self {
            persist_count: Arc::new(AtomicUsize::new(0)),
            started: Arc::new(Mutex::new(Vec::new())),
            cancelled: Arc::new(Mutex::new(Vec::new())),
            envelopes: Arc::new(Mutex::new(Vec::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            fail_start: Arc::new(Mutex::new(Vec::new())),
        }
    }

    async fn complete(&self, model_id: &str, terminal: StreamTerminal) {
        if let Some(sender) = self.terminals.lock().await.remove(model_id) {
            let _ = sender.send(terminal);
        }
    }
}

#[async_trait::async_trait]
impl MultiModelTurnAdapter for FakeAdapter {
    async fn persist_user_turn(
        &self,
        _input: PersistUserTurnInput,
    ) -> Result<PersistedTurn, String> {
        self.persist_count.fetch_add(1, Ordering::SeqCst);
        Ok(PersistedTurn {
            user_message_id: "user-1".to_string(),
        })
    }

    async fn start_target(&self, request: StartTargetRequest) -> Result<StreamHandle, String> {
        if self
            .fail_start
            .lock()
            .await
            .iter()
            .any(|model_id| model_id == &request.target.model_id)
        {
            return Err(format!("start failed for {}", request.target.model_id));
        }
        self.started
            .lock()
            .await
            .push(request.target.model_id.clone());
        let (tx, rx) = oneshot::channel();
        self.terminals
            .lock()
            .await
            .insert(request.target.model_id.clone(), tx);
        Ok(StreamHandle {
            stream_id: format!("stream-{}", request.target.model_id),
            message_id: format!("msg-{}", request.version_index),
            terminal: rx,
        })
    }

    async fn cancel_stream(
        &self,
        _conversation_id: &str,
        stream_id: Option<&str>,
    ) -> Result<(), String> {
        self.cancelled
            .lock()
            .await
            .push(stream_id.map(ToString::to_string));
        Ok(())
    }

    async fn mark_target_error(&self, request: MarkTargetErrorRequest) -> Result<String, String> {
        Ok(format!("err-{}", request.version_index))
    }

    async fn emit_envelope(&self, envelope: MultiModelRunEnvelope) {
        self.envelopes.lock().await.push(envelope);
    }
}

fn sample_input(mode: MultiModelExecutionMode, interval_seconds: u32) -> StartMultiModelInput {
    StartMultiModelInput {
        conversation_id: "conv-1".to_string(),
        content: "hello".to_string(),
        attachments: Vec::new(),
        search_provider_id: None,
        enabled_mcp_server_ids: None,
        thinking_budget: None,
        thinking_level: None,
        enabled_knowledge_base_ids: None,
        enabled_memory_namespace_ids: None,
        history_mode: MultiModelContinuationMode::Selected,
        targets: vec![
            MultiModelTarget {
                provider_id: "p1".to_string(),
                model_id: "m1".to_string(),
            },
            MultiModelTarget {
                provider_id: "p2".to_string(),
                model_id: "m2".to_string(),
            },
        ],
        execution_mode: mode,
        interval_seconds,
    }
}

async fn wait_until<F, Fut>(mut predicate: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..2000 {
        if predicate().await {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("condition not met");
}

#[tokio::test]
async fn parallel_starts_all_targets_immediately() {
    let manager = MultiModelRunManager::new();
    let adapter = FakeAdapter::new();
    let started = adapter.started.clone();
    let envelope = manager
        .start(adapter, sample_input(MultiModelExecutionMode::Parallel, 3))
        .await
        .unwrap();
    assert!(envelope.active_run.is_some());
    wait_until(|| async { started.lock().await.len() == 2 }).await;
    assert_eq!(
        *started.lock().await,
        vec!["m1".to_string(), "m2".to_string()]
    );
}

#[tokio::test]
async fn sequential_starts_second_target_after_first_completes() {
    let manager = MultiModelRunManager::new();
    let adapter = FakeAdapter::new();
    let started = adapter.started.clone();
    let envelopes = adapter.envelopes.clone();
    let control = adapter.clone();
    manager
        .start(adapter, sample_input(MultiModelExecutionMode::Sequential, 0))
        .await
        .unwrap();
    wait_until(|| async { started.lock().await.len() == 1 }).await;
    assert_eq!(started.lock().await.len(), 1);
    control.complete("m1", StreamTerminal::Complete).await;
    wait_until(|| async { started.lock().await.len() == 2 }).await;
    control.complete("m2", StreamTerminal::Complete).await;
    wait_until(|| async {
        envelopes
            .lock()
            .await
            .iter()
            .any(|envelope| envelope.active_run.is_none() && envelope.revision > 0)
    })
    .await;
}

#[tokio::test]
async fn sequential_zero_interval_still_waits_for_terminal() {
    let manager = MultiModelRunManager::new();
    let adapter = FakeAdapter::new();
    let started = adapter.started.clone();
    let control = adapter.clone();
    manager
        .start(adapter, sample_input(MultiModelExecutionMode::Sequential, 0))
        .await
        .unwrap();
    wait_until(|| async { started.lock().await.len() == 1 }).await;
    tokio::task::yield_now().await;
    assert_eq!(started.lock().await.len(), 1);
    control.complete("m1", StreamTerminal::Complete).await;
    wait_until(|| async { started.lock().await.len() == 2 }).await;
}

#[tokio::test]
async fn sequential_skip_cancels_only_current_stream() {
    let manager = MultiModelRunManager::new();
    let adapter = FakeAdapter::new();
    let started = adapter.started.clone();
    let cancelled = adapter.cancelled.clone();
    let envelopes = adapter.envelopes.clone();
    let control = adapter.clone();
    let envelope = manager
        .start(adapter, sample_input(MultiModelExecutionMode::Sequential, 0))
        .await
        .unwrap();
    wait_until(|| async { started.lock().await.len() == 1 }).await;
    let run_id = envelope.active_run.unwrap().run_id;
    manager.skip_and_cancel(&control, &run_id).await.unwrap();
    assert_eq!(*cancelled.lock().await, vec![Some("stream-m1".to_string())]);
    control.complete("m1", StreamTerminal::Cancelled).await;
    wait_until(|| async {
        envelopes.lock().await.iter().any(|envelope| {
            envelope.active_run.as_ref().is_some_and(|run| {
                run.targets
                    .first()
                    .is_some_and(|target| target.state == MultiModelTargetState::Skipped)
            })
        })
    })
    .await;
}

#[tokio::test]
async fn stop_during_wait_prevents_next_target() {
    let manager = MultiModelRunManager::new();
    let adapter = FakeAdapter::new();
    let started = adapter.started.clone();
    let envelopes = adapter.envelopes.clone();
    let control = adapter.clone();
    let envelope = manager
        .start(adapter, sample_input(MultiModelExecutionMode::Sequential, 60))
        .await
        .unwrap();
    wait_until(|| async { started.lock().await.len() == 1 }).await;
    control.complete("m1", StreamTerminal::Complete).await;
    wait_until(|| async {
        envelopes.lock().await.iter().any(|envelope| {
            envelope
                .active_run
                .as_ref()
                .is_some_and(|run| run.phase == MultiModelRunPhase::Waiting)
        })
    })
    .await;
    let run_id = envelope.active_run.unwrap().run_id;
    manager.stop_run(&control, &run_id).await.unwrap();
    wait_until(|| async {
        envelopes
            .lock()
            .await
            .iter()
            .any(|envelope| envelope.active_run.is_none() && envelope.revision > 0)
    })
    .await;
    assert_eq!(started.lock().await.len(), 1);
}

#[tokio::test]
async fn start_failure_records_error_and_continues() {
    let manager = MultiModelRunManager::new();
    let adapter = FakeAdapter::new();
    adapter.fail_start.lock().await.push("m1".to_string());
    let started = adapter.started.clone();
    let envelopes = adapter.envelopes.clone();
    let control = adapter.clone();
    manager
        .start(adapter, sample_input(MultiModelExecutionMode::Sequential, 0))
        .await
        .unwrap();
    wait_until(|| async { started.lock().await.len() == 1 }).await;
    wait_until(|| async {
        envelopes.lock().await.iter().any(|envelope| {
            envelope.active_run.as_ref().is_some_and(|run| {
                run.targets.first().is_some_and(|target| {
                    target.state == MultiModelTargetState::Error
                        && target.message_id.as_deref() == Some("err-0")
                })
            })
        })
    })
    .await;
    control.complete("m2", StreamTerminal::Complete).await;
}

#[tokio::test]
async fn second_run_for_same_conversation_is_rejected() {
    let manager = MultiModelRunManager::new();
    let adapter = FakeAdapter::new();
    let started = adapter.started.clone();
    manager
        .start(adapter, sample_input(MultiModelExecutionMode::Sequential, 3))
        .await
        .unwrap();
    wait_until(|| async { started.lock().await.len() == 1 }).await;
    let err = manager
        .start(
            FakeAdapter::new(),
            sample_input(MultiModelExecutionMode::Sequential, 3),
        )
        .await
        .unwrap_err();
    assert!(err.contains("已有多模型"));
}

#[tokio::test]
async fn different_conversations_do_not_block_each_other() {
    let manager = MultiModelRunManager::new();
    let first = FakeAdapter::new();
    let second = FakeAdapter::new();
    let first_started = first.started.clone();
    let second_started = second.started.clone();
    manager
        .start(first, sample_input(MultiModelExecutionMode::Sequential, 3))
        .await
        .unwrap();
    let mut other = sample_input(MultiModelExecutionMode::Parallel, 0);
    other.conversation_id = "conv-2".to_string();
    manager.start(second, other).await.unwrap();
    wait_until(|| async { first_started.lock().await.len() == 1 }).await;
    wait_until(|| async { second_started.lock().await.len() == 2 }).await;
}
