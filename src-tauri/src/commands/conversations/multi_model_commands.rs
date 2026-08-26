use crate::multi_model_run::{
    MarkTargetErrorRequest, MultiModelRunEnvelope, MultiModelTurnAdapter, PersistUserTurnInput,
    PersistedTurn, StartMultiModelInput, StartTargetRequest, StreamHandle,
};

struct ConversationTurnAdapter {
    app: tauri::AppHandle,
}

impl ConversationTurnAdapter {
    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }
}

#[async_trait::async_trait]
impl MultiModelTurnAdapter for ConversationTurnAdapter {
    async fn persist_user_turn(&self, input: PersistUserTurnInput) -> Result<PersistedTurn, String> {
        let state = self.state();
        let message = persist_user_message_turn(
            &*state,
            &input.conversation_id,
            &input.content,
            input.attachments,
        )
        .await?;
        Ok(PersistedTurn {
            user_message_id: message.id,
        })
    }

    async fn start_target(&self, request: StartTargetRequest) -> Result<StreamHandle, String> {
        let stream_id = aqbot_core::utils::gen_id();
        start_target_stream(
            self.app.clone(),
            request.conversation_id,
            stream_id,
            Some(request.history_mode),
            request.user_message_id,
            request.target.provider_id,
            request.target.model_id,
            request.enabled_mcp_server_ids,
            request.thinking_budget,
            request.thinking_level,
            request.enabled_knowledge_base_ids,
            request.enabled_memory_namespace_ids,
            request.create_inactive,
            None,
            Some(request.version_index),
            Some(request.allow_parallel),
        )
        .await
    }

    async fn cancel_stream(
        &self,
        conversation_id: &str,
        stream_id: Option<&str>,
    ) -> Result<(), String> {
        let state = self.state();
        let flags = state.stream_cancel_flags.lock().await;
        let to_cancel = apply_cancel_flags(&flags, conversation_id, stream_id);
        for flag in to_cancel {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    }

    async fn mark_target_error(&self, request: MarkTargetErrorRequest) -> Result<String, String> {
        let state = self.state();
        let assistant_message_id = aqbot_core::utils::gen_id();
        let versions = aqbot_core::repo::message::list_message_versions(
            &state.sea_db,
            &request.conversation_id,
            &request.user_message_id,
        )
        .await
        .map_err(|e| e.to_string())?;
        let original_created_at = versions.first().map(|v| v.created_at);
        use sea_orm::ActiveValue::Set;
        (aqbot_core::entity::messages::ActiveModel {
            id: Set(assistant_message_id.clone()),
            conversation_id: Set(request.conversation_id),
            role: Set("assistant".to_string()),
            content: Set(request.error.clone()),
            provider_id: Set(Some(request.target.provider_id)),
            model_id: Set(Some(request.target.model_id)),
            token_count: Set(None),
            prompt_tokens: Set(None),
            completion_tokens: Set(None),
            attachments: Set("[]".to_string()),
            thinking: Set(None),
            created_at: Set(original_created_at.unwrap_or_else(aqbot_core::utils::now_ts)),
            branch_id: Set(None),
            parent_message_id: Set(Some(request.user_message_id)),
            version_index: Set(request.version_index),
            is_active: Set(if request.create_inactive { 0 } else { 1 }),
            tool_calls_json: Set(None),
            tool_call_id: Set(None),
            status: Set("error".to_string()),
            tokens_per_second: Set(None),
            first_token_latency_ms: Set(None),
        })
        .insert(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
        Ok(assistant_message_id)
    }

    async fn emit_envelope(&self, envelope: MultiModelRunEnvelope) {
        let _ = self.app.emit("multi-model-run-updated", envelope);
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMultiModelRunCommand {
    pub conversation_id: String,
    pub content: String,
    pub attachments: Option<Vec<AttachmentInput>>,
    pub search_provider_id: Option<String>,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub thinking_budget: Option<u32>,
    pub thinking_level: Option<String>,
    pub enabled_knowledge_base_ids: Option<Vec<String>>,
    pub enabled_memory_namespace_ids: Option<Vec<String>>,
    pub targets: Option<Vec<MultiModelTarget>>,
    pub history_mode: Option<MultiModelContinuationMode>,
}

#[tauri::command]
pub async fn start_multi_model_run(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: StartMultiModelRunCommand,
) -> Result<MultiModelRunEnvelope, String> {
    let conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &input.conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let targets = input
        .targets
        .unwrap_or(conversation.multi_model_targets);
    if targets.is_empty() {
        return Err("multi_model_targets must not be empty".to_string());
    }
    aqbot_core::types::validate_multi_model_targets(&targets)?;
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    let start_input = StartMultiModelInput {
        conversation_id: input.conversation_id,
        content: input.content,
        attachments: input.attachments.unwrap_or_default(),
        search_provider_id: input.search_provider_id,
        enabled_mcp_server_ids: input.enabled_mcp_server_ids,
        thinking_budget: input.thinking_budget,
        thinking_level: input.thinking_level,
        enabled_knowledge_base_ids: input.enabled_knowledge_base_ids,
        enabled_memory_namespace_ids: input.enabled_memory_namespace_ids,
        history_mode: input
            .history_mode
            .unwrap_or(conversation.multi_model_continuation_mode),
        targets,
        execution_mode: settings.multi_model_execution_mode,
        interval_seconds: settings.multi_model_sequential_interval_seconds,
    };
    let adapter = ConversationTurnAdapter { app: app.clone() };
    state.multi_model_runs.start(adapter, start_input).await
}

#[tauri::command]
pub async fn get_multi_model_run_snapshot(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<MultiModelRunEnvelope, String> {
    Ok(state.multi_model_runs.snapshot(&conversation_id).await)
}

#[tauri::command]
pub async fn skip_multi_model_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    run_id: String,
) -> Result<MultiModelRunEnvelope, String> {
    let adapter = ConversationTurnAdapter { app };
    state.multi_model_runs.skip_and_cancel(&adapter, &run_id).await
}

#[tauri::command]
pub async fn stop_multi_model_run(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    run_id: String,
) -> Result<MultiModelRunEnvelope, String> {
    let adapter = ConversationTurnAdapter { app };
    state.multi_model_runs.stop_run(&adapter, &run_id).await
}
