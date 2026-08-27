use super::stop::StopSignal;
use super::types::{
    now_ms, MarkTargetErrorRequest, MultiModelRunEnvelope, MultiModelRunPhase,
    MultiModelRunSnapshot, MultiModelTargetSnapshot, MultiModelTargetState, MultiModelTurnAdapter,
    PersistUserTurnInput, StartMultiModelInput, StartTargetRequest, StreamHandle, StreamTerminal,
};
use aqbot_core::types::{
    resolve_target_thinking, validate_multi_model_targets, MultiModelExecutionMode, MultiModelTarget,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

const ACTIVE_RUN_EXISTS_ERROR: &str = "当前会话已有多模型回答正在进行，请等待完成或停止后再发送";

struct ConversationSlot {
    revision: u64,
    active: Option<ActiveRun>,
}

struct ActiveRun {
    snapshot: MultiModelRunSnapshot,
    stop: StopSignal,
    skip_current: Arc<AtomicBool>,
    #[allow(dead_code)]
    task: JoinHandle<()>,
}

#[derive(Clone, Default)]
pub struct MultiModelRunManager {
    inner: Arc<Mutex<HashMap<String, ConversationSlot>>>,
}

impl MultiModelRunManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn has_active(&self, conversation_id: &str) -> bool {
        let inner = self.inner.lock().await;
        inner
            .get(conversation_id)
            .is_some_and(|slot| slot.active.is_some())
    }

    pub async fn snapshot(&self, conversation_id: &str) -> MultiModelRunEnvelope {
        let inner = self.inner.lock().await;
        envelope_from_slot(conversation_id, inner.get(conversation_id))
    }

    pub async fn start<A: MultiModelTurnAdapter + 'static>(
        &self,
        adapter: A,
        input: StartMultiModelInput,
    ) -> Result<MultiModelRunEnvelope, String> {
        validate_start_input(&input)?;
        {
            let inner = self.inner.lock().await;
            if inner
                .get(&input.conversation_id)
                .is_some_and(|slot| slot.active.is_some())
            {
                return Err(ACTIVE_RUN_EXISTS_ERROR.to_string());
            }
        }

        let persisted = adapter
            .persist_user_turn(PersistUserTurnInput {
                conversation_id: input.conversation_id.clone(),
                content: input.content.clone(),
                attachments: input.attachments.clone(),
            })
            .await?;

        let run_id = aqbot_core::utils::gen_id();
        let targets = input
            .targets
            .iter()
            .enumerate()
            .map(|(index, target)| MultiModelTargetSnapshot {
                index: index as i32,
                target: target.clone(),
                state: MultiModelTargetState::Queued,
                stream_id: None,
                message_id: None,
                error: None,
            })
            .collect();
        let snapshot = MultiModelRunSnapshot {
            run_id: run_id.clone(),
            conversation_id: input.conversation_id.clone(),
            parent_message_id: Some(persisted.user_message_id.clone()),
            mode: input.execution_mode,
            interval_seconds: input.interval_seconds,
            phase: MultiModelRunPhase::Starting,
            next_start_at: None,
            targets,
        };
        let stop = StopSignal::new();
        let skip_current = Arc::new(AtomicBool::new(false));
        let adapter = Arc::new(adapter);
        let manager = self.clone();
        let conversation_id = input.conversation_id.clone();
        let run_input = input;
        let user_message_id = persisted.user_message_id;
        let task_stop = stop.clone();
        let task_skip = skip_current.clone();
        let task_adapter = adapter.clone();
        let task = tokio::spawn(async move {
            run_plan(
                manager,
                task_adapter,
                run_input,
                user_message_id,
                task_stop,
                task_skip,
            )
            .await;
        });

        let envelope = {
            let mut inner = self.inner.lock().await;
            let slot = inner.entry(conversation_id.clone()).or_insert(ConversationSlot {
                revision: 0,
                active: None,
            });
            slot.revision += 1;
            slot.active = Some(ActiveRun {
                snapshot,
                stop,
                skip_current,
                task,
            });
            envelope_from_slot(&conversation_id, Some(slot))
        };
        adapter.emit_envelope(envelope.clone()).await;
        Ok(envelope)
    }

    pub async fn skip_and_cancel<A: MultiModelTurnAdapter>(
        &self,
        adapter: &A,
        run_id: &str,
    ) -> Result<MultiModelRunEnvelope, String> {
        let (conversation_id, stream_id) = {
            let inner = self.inner.lock().await;
            let found = inner.iter().find_map(|(cid, slot)| {
                let active = slot.active.as_ref()?;
                if active.snapshot.run_id != run_id {
                    return None;
                }
                if active.snapshot.mode != MultiModelExecutionMode::Sequential {
                    return None;
                }
                let current = active.snapshot.targets.iter().find(|target| {
                    matches!(
                        target.state,
                        MultiModelTargetState::Starting | MultiModelTargetState::Streaming
                    )
                })?;
                Some((
                    cid.clone(),
                    current.stream_id.clone(),
                    active.skip_current.clone(),
                ))
            });
            match found {
                Some((cid, stream_id, skip)) => {
                    skip.store(true, Ordering::SeqCst);
                    (cid, stream_id)
                }
                None => return Err("没有可跳过的当前模型".to_string()),
            }
        };
        if let Some(stream_id) = stream_id {
            adapter
                .cancel_stream(&conversation_id, Some(&stream_id))
                .await?;
        }
        Ok(self.snapshot(&conversation_id).await)
    }

    pub async fn stop_run<A: MultiModelTurnAdapter>(
        &self,
        adapter: &A,
        run_id: &str,
    ) -> Result<MultiModelRunEnvelope, String> {
        let (conversation_id, stream_ids, stop) = {
            let mut inner = self.inner.lock().await;
            let found = inner.iter_mut().find_map(|(cid, slot)| {
                let active = slot.active.as_mut()?;
                if active.snapshot.run_id != run_id {
                    return None;
                }
                active.snapshot.phase = MultiModelRunPhase::Stopping;
                active.snapshot.next_start_at = None;
                slot.revision += 1;
                let stream_ids = active
                    .snapshot
                    .targets
                    .iter()
                    .filter_map(|target| target.stream_id.clone())
                    .collect::<Vec<_>>();
                Some((cid.clone(), stream_ids, active.stop.clone()))
            });
            match found {
                Some(value) => value,
                None => return Err("没有进行中的多模型回答".to_string()),
            }
        };
        stop.trigger();
        if stream_ids.is_empty() {
            adapter.cancel_stream(&conversation_id, None).await?;
        } else {
            for stream_id in stream_ids {
                adapter
                    .cancel_stream(&conversation_id, Some(&stream_id))
                    .await?;
            }
        }
        let envelope = self.snapshot(&conversation_id).await;
        adapter.emit_envelope(envelope.clone()).await;
        Ok(envelope)
    }

    async fn update_snapshot<F>(&self, conversation_id: &str, mutate: F) -> MultiModelRunEnvelope
    where
        F: FnOnce(&mut MultiModelRunSnapshot),
    {
        let mut inner = self.inner.lock().await;
        if let Some(slot) = inner.get_mut(conversation_id) {
            if let Some(active) = slot.active.as_mut() {
                mutate(&mut active.snapshot);
                slot.revision += 1;
            }
        }
        envelope_from_slot(conversation_id, inner.get(conversation_id))
    }

    async fn finalize(&self, conversation_id: &str) -> MultiModelRunEnvelope {
        let mut inner = self.inner.lock().await;
        if let Some(slot) = inner.get_mut(conversation_id) {
            slot.revision += 1;
            slot.active = None;
        }
        envelope_from_slot(conversation_id, inner.get(conversation_id))
    }
}

fn envelope_from_slot(
    conversation_id: &str,
    slot: Option<&ConversationSlot>,
) -> MultiModelRunEnvelope {
    match slot {
        Some(slot) => MultiModelRunEnvelope {
            conversation_id: conversation_id.to_string(),
            revision: slot.revision,
            active_run: slot.active.as_ref().map(|active| active.snapshot.clone()),
        },
        None => MultiModelRunEnvelope {
            conversation_id: conversation_id.to_string(),
            revision: 0,
            active_run: None,
        },
    }
}

fn validate_start_input(input: &StartMultiModelInput) -> Result<(), String> {
    if input.targets.is_empty() {
        return Err("multi_model_targets must not be empty".to_string());
    }
    validate_multi_model_targets(&input.targets)?;
    if input.interval_seconds > aqbot_core::types::MAX_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS {
        return Err(format!(
            "multi_model_sequential_interval_seconds must be 0..={}",
            aqbot_core::types::MAX_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS
        ));
    }
    Ok(())
}

async fn run_plan<A: MultiModelTurnAdapter>(
    manager: MultiModelRunManager,
    adapter: Arc<A>,
    input: StartMultiModelInput,
    user_message_id: String,
    stop: StopSignal,
    skip_current: Arc<AtomicBool>,
) {
    let conversation_id = input.conversation_id.clone();
    match input.execution_mode {
        MultiModelExecutionMode::Parallel => {
            run_parallel(
                &manager,
                adapter.as_ref(),
                &input,
                &user_message_id,
                &stop,
            )
            .await;
        }
        MultiModelExecutionMode::Sequential => {
            run_sequential(
                &manager,
                adapter.as_ref(),
                &input,
                &user_message_id,
                &stop,
                &skip_current,
            )
            .await;
        }
    }
    let envelope = manager.finalize(&conversation_id).await;
    adapter.emit_envelope(envelope).await;
}

async fn run_parallel<A: MultiModelTurnAdapter>(
    manager: &MultiModelRunManager,
    adapter: &A,
    input: &StartMultiModelInput,
    user_message_id: &str,
    stop: &StopSignal,
) {
    let mut handles: Vec<(usize, Result<StreamHandle, String>)> = Vec::new();
    for (index, target) in input.targets.iter().enumerate() {
        if stop.is_stopped() {
            break;
        }
        let envelope = manager
            .update_snapshot(&input.conversation_id, |snapshot| {
                snapshot.phase = MultiModelRunPhase::Running;
                snapshot.targets[index].state = MultiModelTargetState::Starting;
            })
            .await;
        adapter.emit_envelope(envelope).await;
        let started = start_one(adapter, input, user_message_id, index, target, true).await;
        match &started {
            Ok(handle) => {
                let stream_id = handle.stream_id.clone();
                let message_id = handle.message_id.clone();
                let envelope = manager
                    .update_snapshot(&input.conversation_id, |snapshot| {
                        snapshot.targets[index].state = MultiModelTargetState::Streaming;
                        snapshot.targets[index].stream_id = Some(stream_id);
                        snapshot.targets[index].message_id = Some(message_id);
                    })
                    .await;
                adapter.emit_envelope(envelope).await;
            }
            Err(error) => {
                let marked = mark_start_error(adapter, input, user_message_id, index, target, error)
                    .await;
                let envelope = manager
                    .update_snapshot(&input.conversation_id, |snapshot| {
                        snapshot.targets[index].state = MultiModelTargetState::Error;
                        snapshot.targets[index].error = Some(error.clone());
                        snapshot.targets[index].message_id = marked.ok();
                    })
                    .await;
                adapter.emit_envelope(envelope).await;
            }
        }
        handles.push((index, started));
    }

    for (index, started) in handles {
        let Ok(handle) = started else { continue };
        if stop.is_stopped() {
            let _ = adapter
                .cancel_stream(&input.conversation_id, Some(&handle.stream_id))
                .await;
        }
        let terminal = handle.terminal.await.unwrap_or(StreamTerminal::Cancelled);
        let envelope = manager
            .update_snapshot(&input.conversation_id, |snapshot| {
                apply_terminal(&mut snapshot.targets[index], terminal, false);
            })
            .await;
        adapter.emit_envelope(envelope).await;
    }
}

async fn run_sequential<A: MultiModelTurnAdapter>(
    manager: &MultiModelRunManager,
    adapter: &A,
    input: &StartMultiModelInput,
    user_message_id: &str,
    stop: &StopSignal,
    skip_current: &AtomicBool,
) {
    let last_index = input.targets.len().saturating_sub(1);
    for (index, target) in input.targets.iter().enumerate() {
        if stop.is_stopped() {
            break;
        }
        skip_current.store(false, Ordering::SeqCst);
        let envelope = manager
            .update_snapshot(&input.conversation_id, |snapshot| {
                snapshot.phase = MultiModelRunPhase::Running;
                snapshot.next_start_at = None;
                snapshot.targets[index].state = MultiModelTargetState::Starting;
            })
            .await;
        adapter.emit_envelope(envelope).await;

        match start_one(adapter, input, user_message_id, index, target, false).await {
            Ok(handle) => {
                let stream_id = handle.stream_id.clone();
                let message_id = handle.message_id.clone();
                let envelope = manager
                    .update_snapshot(&input.conversation_id, |snapshot| {
                        snapshot.targets[index].state = MultiModelTargetState::Streaming;
                        snapshot.targets[index].stream_id = Some(stream_id);
                        snapshot.targets[index].message_id = Some(message_id);
                    })
                    .await;
                adapter.emit_envelope(envelope).await;
                let mut terminal_rx = handle.terminal;
                let terminal = tokio::select! {
                    terminal = &mut terminal_rx => terminal.unwrap_or(StreamTerminal::Cancelled),
                    _ = stop.cancelled() => {
                        let _ = adapter
                            .cancel_stream(&input.conversation_id, Some(&handle.stream_id))
                            .await;
                        terminal_rx.await.unwrap_or(StreamTerminal::Cancelled)
                    }
                };
                let skipped = skip_current.swap(false, Ordering::SeqCst);
                let envelope = manager
                    .update_snapshot(&input.conversation_id, |snapshot| {
                        apply_terminal(&mut snapshot.targets[index], terminal, skipped);
                        snapshot.targets[index].stream_id = None;
                    })
                    .await;
                adapter.emit_envelope(envelope).await;
            }
            Err(error) => {
                let marked =
                    mark_start_error(adapter, input, user_message_id, index, target, &error).await;
                let envelope = manager
                    .update_snapshot(&input.conversation_id, |snapshot| {
                        snapshot.targets[index].state = MultiModelTargetState::Error;
                        snapshot.targets[index].error = Some(error);
                        snapshot.targets[index].message_id = marked.ok();
                    })
                    .await;
                adapter.emit_envelope(envelope).await;
            }
        }

        if index == last_index || stop.is_stopped() {
            break;
        }
        let interval = Duration::from_secs(u64::from(input.interval_seconds));
        let envelope = manager
            .update_snapshot(&input.conversation_id, |snapshot| {
                snapshot.phase = MultiModelRunPhase::Waiting;
                snapshot.next_start_at = Some(now_ms() + interval.as_millis() as i64);
            })
            .await;
        adapter.emit_envelope(envelope).await;
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = stop.cancelled() => break,
        }
    }
}

async fn start_one<A: MultiModelTurnAdapter>(
    adapter: &A,
    input: &StartMultiModelInput,
    user_message_id: &str,
    index: usize,
    target: &MultiModelTarget,
    parallel: bool,
) -> Result<StreamHandle, String> {
    let (thinking_budget, thinking_level) = resolve_target_thinking(
        target,
        input.thinking_budget,
        input.thinking_level.as_deref(),
    );
    adapter
        .start_target(StartTargetRequest {
            conversation_id: input.conversation_id.clone(),
            user_message_id: user_message_id.to_string(),
            target: target.clone(),
            version_index: index as i32,
            create_inactive: index > 0,
            allow_parallel: parallel,
            history_mode: input.history_mode,
            enabled_mcp_server_ids: input.enabled_mcp_server_ids.clone(),
            thinking_budget,
            thinking_level,
            enabled_knowledge_base_ids: input.enabled_knowledge_base_ids.clone(),
            enabled_memory_namespace_ids: input.enabled_memory_namespace_ids.clone(),
        })
        .await
}

async fn mark_start_error<A: MultiModelTurnAdapter>(
    adapter: &A,
    input: &StartMultiModelInput,
    user_message_id: &str,
    index: usize,
    target: &MultiModelTarget,
    error: &str,
) -> Result<String, String> {
    adapter
        .mark_target_error(MarkTargetErrorRequest {
            conversation_id: input.conversation_id.clone(),
            user_message_id: user_message_id.to_string(),
            target: target.clone(),
            version_index: index as i32,
            create_inactive: index > 0,
            error: error.to_string(),
        })
        .await
}

fn apply_terminal(target: &mut MultiModelTargetSnapshot, terminal: StreamTerminal, skipped: bool) {
    match terminal {
        StreamTerminal::Complete => {
            target.state = MultiModelTargetState::Complete;
            target.error = None;
        }
        StreamTerminal::Error { message } => {
            target.state = MultiModelTargetState::Error;
            target.error = Some(message);
        }
        StreamTerminal::Cancelled => {
            target.state = if skipped {
                MultiModelTargetState::Skipped
            } else {
                MultiModelTargetState::Skipped
            };
        }
    }
}
