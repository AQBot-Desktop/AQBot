use std::collections::HashMap;
use std::time::{Duration, Instant};

use aqbot_core::think_tags::ThinkTagFilter;
use aqbot_core::types::*;
use aqbot_core::utils::now_ts;
use aqbot_providers::registry::ProviderRegistry;
use aqbot_providers::{
    adapter_supports_kind, all_adapter_test_kinds, registry_key_for_type, ProviderRequestContext,
};
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::watch;

use crate::chat_params::{model_extra_body_from_overrides, ChatParamInputs};
use crate::AppState;

#[derive(Default)]
pub struct ModelTestRegistry {
    by_id: HashMap<String, TestSlot>,
    by_target: HashMap<(String, String), String>,
}

struct TestSlot {
    cancel: watch::Sender<bool>,
    provider_id: Option<String>,
    model_id: Option<String>,
}

impl ModelTestRegistry {
    pub fn register(&mut self, test_id: String) -> Result<watch::Receiver<bool>, String> {
        if test_id.trim().is_empty() || test_id.len() > 128 {
            return Err("Invalid model test ID".into());
        }
        if self.by_id.contains_key(&test_id) {
            return Err("Model test ID is already registered".into());
        }
        let (tx, rx) = watch::channel(false);
        self.by_id.insert(
            test_id,
            TestSlot {
                cancel: tx,
                provider_id: None,
                model_id: None,
            },
        );
        Ok(rx)
    }

    pub fn bind_target(
        &mut self,
        test_id: &str,
        provider_id: String,
        model_id: String,
    ) -> Result<(), String> {
        let key = (provider_id.clone(), model_id.clone());
        if self.by_target.get(&key).is_some_and(|id| id != test_id) {
            return Err("A test for this model is already running".into());
        }
        let slot = self
            .by_id
            .get_mut(test_id)
            .ok_or("Model test is not registered")?;
        slot.provider_id = Some(provider_id);
        slot.model_id = Some(model_id);
        self.by_target.insert(key, test_id.to_string());
        Ok(())
    }

    pub fn cancel(&mut self, test_id: &str) {
        if let Some(slot) = self.by_id.get(test_id) {
            let _ = slot.cancel.send(true);
        }
    }

    pub fn is_cancelled(&self, test_id: &str) -> bool {
        self.by_id
            .get(test_id)
            .map(|slot| *slot.cancel.borrow())
            .unwrap_or(false)
    }

    pub fn remove_if_current(&mut self, test_id: &str) {
        if let Some(slot) = self.by_id.remove(test_id) {
            if let (Some(provider_id), Some(model_id)) = (slot.provider_id, slot.model_id) {
                let key = (provider_id, model_id);
                if self.by_target.get(&key).map(String::as_str) == Some(test_id) {
                    self.by_target.remove(&key);
                }
            }
        }
    }
}

#[tauri::command]
pub async fn get_model_test_config() -> Result<ModelTestConfig, String> {
    Ok(ModelTestConfig {
        default_prompt: MODEL_TEST_DEFAULT_PROMPT.to_string(),
        max_prompt_chars: MODEL_TEST_MAX_PROMPT_CHARS as u32,
        timeout_secs: MODEL_TEST_TIMEOUT_SECS,
        adapter_kinds: all_adapter_test_kinds(),
    })
}

#[tauri::command]
pub async fn cancel_model_test(state: State<'_, AppState>, test_id: String) -> Result<(), String> {
    state.model_test_registry.lock().await.cancel(&test_id);
    Ok(())
}

#[tauri::command]
pub async fn test_model(
    state: State<'_, AppState>,
    test_id: String,
    provider_id: String,
    model_id: String,
    prompt: Option<String>,
    thinking_level: Option<String>,
    on_event: Channel<ModelTestProgressEvent>,
) -> Result<ModelTestResult, String> {
    let cancel_rx = {
        let mut registry = state.model_test_registry.lock().await;
        registry.register(test_id.clone())?
    };
    if let Err(error) = on_event.send(ModelTestProgressEvent::Registered {
        test_id: test_id.clone(),
    }) {
        state
            .model_test_registry
            .lock()
            .await
            .remove_if_current(&test_id);
        return Err(format!("Failed to register model test progress: {error}"));
    }

    let result = run_model_test(
        &state,
        test_id.clone(),
        provider_id,
        model_id,
        prompt,
        thinking_level,
        on_event,
        cancel_rx,
    )
    .await;

    state
        .model_test_registry
        .lock()
        .await
        .remove_if_current(&test_id);
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
async fn run_model_test(
    state: &AppState,
    test_id: String,
    provider_id: String,
    model_id: String,
    prompt: Option<String>,
    thinking_level: Option<String>,
    on_event: Channel<ModelTestProgressEvent>,
    mut cancel_rx: watch::Receiver<bool>,
) -> ModelTestResult {
    let checked_at = now_ts();
    let fail = |status: ModelTestStatus,
                provider_id: String,
                error_code: Option<&str>,
                error_detail: Option<String>,
                first_text_ms: Option<u64>,
                total_ms: Option<u64>,
                preview: Option<String>| {
        ModelTestResult {
            test_id: test_id.clone(),
            provider_id,
            model_id: model_id.clone(),
            status,
            first_text_ms,
            total_ms,
            checked_at,
            response_preview: preview,
            error_code: error_code.map(str::to_string),
            error_detail,
        }
    };

    if *cancel_rx.borrow() {
        return fail(
            ModelTestStatus::Cancelled,
            provider_id,
            Some("cancelled"),
            None,
            None,
            None,
            None,
        );
    }

    let prompt = match effective_model_test_prompt(prompt.as_deref()) {
        Ok(prompt) => prompt,
        Err(error) => {
            return fail(
                ModelTestStatus::Failed,
                provider_id,
                Some("invalid_prompt"),
                Some(error),
                None,
                None,
                None,
            );
        }
    };
    let thinking_level = match validate_reasoning_level(thinking_level.as_deref()) {
        Ok(level) => level,
        Err(error) => {
            return fail(
                ModelTestStatus::Failed,
                provider_id,
                Some("invalid_reasoning"),
                Some(error),
                None,
                None,
                None,
            );
        }
    };

    let real_id =
        match aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, &provider_id).await {
            Ok(id) => id,
            Err(error) => {
                return fail(
                    ModelTestStatus::Failed,
                    provider_id,
                    Some("provider"),
                    Some(error.to_string()),
                    None,
                    None,
                    None,
                );
            }
        };

    {
        let mut registry = state.model_test_registry.lock().await;
        if let Err(error) = registry.bind_target(&test_id, real_id.clone(), model_id.clone()) {
            return fail(
                ModelTestStatus::Failed,
                real_id,
                Some("already_running"),
                Some(error),
                None,
                None,
                None,
            );
        }
        if registry.is_cancelled(&test_id) {
            return fail(
                ModelTestStatus::Cancelled,
                real_id,
                Some("cancelled"),
                None,
                None,
                None,
                None,
            );
        }
    }

    let provider = match aqbot_core::repo::provider::get_provider(&state.sea_db, &real_id).await {
        Ok(provider) => provider,
        Err(error) => {
            return fail(
                ModelTestStatus::Failed,
                real_id,
                Some("provider"),
                Some(error.to_string()),
                None,
                None,
                None,
            );
        }
    };
    let model = match provider
        .models
        .iter()
        .find(|model| model.model_id == model_id)
        .cloned()
    {
        Some(model) => model,
        None => {
            return fail(
                ModelTestStatus::Failed,
                real_id,
                Some("model_not_found"),
                Some("Model not found on this provider".into()),
                None,
                None,
                None,
            );
        }
    };
    let registry_key = registry_key_for_type(&provider.provider_type);
    let kind = match test_kind_for_model_type(&model.model_type) {
        Some(kind) if adapter_supports_kind(registry_key, kind) => kind,
        _ => {
            return fail(
                ModelTestStatus::Unsupported,
                real_id,
                Some("unsupported"),
                None,
                None,
                None,
                None,
            );
        }
    };

    let key_row = match aqbot_core::repo::provider::get_active_key(&state.sea_db, &real_id).await {
        Ok(key) => key,
        Err(error) => {
            return fail(
                ModelTestStatus::Failed,
                real_id,
                Some("no_active_key"),
                Some(error.to_string()),
                None,
                None,
                None,
            );
        }
    };
    let decrypted = match aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &state.master_key)
    {
        Ok(key) => key,
        Err(error) => {
            return fail(
                ModelTestStatus::Failed,
                real_id,
                Some("provider"),
                Some(error.to_string()),
                None,
                None,
                None,
            );
        }
    };
    let global_settings = match aqbot_core::repo::settings::get_settings(&state.sea_db).await {
        Ok(settings) => settings,
        Err(error) => {
            return fail(
                ModelTestStatus::Failed,
                real_id,
                Some("settings"),
                Some(error.to_string()),
                None,
                None,
                None,
            )
        }
    };
    let custom_headers = match provider
        .custom_headers
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
    {
        Ok(headers) => headers,
        Err(error) => {
            return fail(
                ModelTestStatus::Failed,
                real_id,
                Some("custom_headers"),
                Some(format!("Invalid custom headers: {error}")),
                None,
                None,
                None,
            )
        }
    };
    let resolved_proxy =
        aqbot_core::types::ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = ProviderRequestContext {
        api_key: decrypted.clone(),
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(aqbot_providers::resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        aws_region: provider.aws_region.clone(),
        proxy_config: resolved_proxy,
        custom_headers,
    };

    if *cancel_rx.borrow() {
        return fail(
            ModelTestStatus::Cancelled,
            real_id,
            Some("cancelled"),
            None,
            None,
            None,
            None,
        );
    }

    let mut adapters = ProviderRegistry::create_default();
    // Bedrock's SDK retries by default; probes measure exactly one attempt.
    adapters.register(
        "bedrock",
        Box::new(aqbot_providers::bedrock::BedrockAdapter::without_retries()),
    );
    let Some(adapter) = adapters.get(registry_key) else {
        return fail(
            ModelTestStatus::Unsupported,
            real_id,
            Some("unsupported"),
            None,
            None,
            None,
            None,
        );
    };

    if on_event
        .send(ModelTestProgressEvent::RequestStarted {
            test_id: test_id.clone(),
        })
        .is_err()
    {
        return fail(
            ModelTestStatus::Cancelled,
            real_id,
            Some("progress_closed"),
            None,
            None,
            None,
            None,
        );
    }

    let timeout = Duration::from_secs(MODEL_TEST_TIMEOUT_SECS);
    let first_text_ms = std::sync::Arc::new(std::sync::Mutex::new(None));
    let preview = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let probe = probe_kind(
        adapter,
        &ctx,
        &model,
        kind,
        &prompt,
        thinking_level.as_deref(),
        &global_settings,
        &on_event,
        &test_id,
        &mut cancel_rx,
        first_text_ms.clone(),
        preview.clone(),
    );
    let outcome = match tokio::time::timeout(timeout, probe).await {
        Ok(outcome) => outcome,
        Err(_) => ProbeOutcome {
            status: ModelTestStatus::Timeout,
            first_text_ms: first_text_ms.lock().ok().and_then(|value| *value),
            total_ms: Some(timeout.as_millis() as u64),
            preview: preview
                .lock()
                .ok()
                .and_then(|value| nonempty_preview(&value)),
            error_code: Some("timeout".into()),
            error_detail: None,
        },
    };

    fail(
        outcome.status,
        real_id,
        outcome.error_code.as_deref(),
        outcome
            .error_detail
            .map(|detail| redact_error(&detail, &decrypted)),
        outcome.first_text_ms,
        outcome.total_ms,
        outcome.preview,
    )
}

struct ProbeOutcome {
    status: ModelTestStatus,
    first_text_ms: Option<u64>,
    total_ms: Option<u64>,
    preview: Option<String>,
    error_code: Option<String>,
    error_detail: Option<String>,
}

fn redact_error(detail: &str, secret: &str) -> String {
    let redacted = if secret.is_empty() {
        detail.to_string()
    } else {
        detail.replace(secret, "[REDACTED]")
    };
    truncate_chars(&redacted, MODEL_TEST_ERROR_DETAIL_CHARS)
}

#[allow(clippy::too_many_arguments)]
async fn probe_kind(
    adapter: &dyn aqbot_providers::ProviderAdapter,
    ctx: &ProviderRequestContext,
    model: &Model,
    kind: ModelTestKind,
    prompt: &str,
    thinking_level: Option<&str>,
    settings: &AppSettings,
    on_event: &Channel<ModelTestProgressEvent>,
    test_id: &str,
    cancel_rx: &mut watch::Receiver<bool>,
    first_text_ms: std::sync::Arc<std::sync::Mutex<Option<u64>>>,
    preview: std::sync::Arc<std::sync::Mutex<String>>,
) -> ProbeOutcome {
    match kind {
        ModelTestKind::Chat => {
            probe_chat(
                adapter,
                ctx,
                model,
                prompt,
                thinking_level,
                settings,
                on_event,
                test_id,
                cancel_rx,
                first_text_ms,
                preview,
            )
            .await
        }
        ModelTestKind::Embedding => probe_embedding(adapter, ctx, model, cancel_rx).await,
        ModelTestKind::Rerank => probe_rerank(adapter, ctx, model, cancel_rx).await,
    }
}

#[allow(clippy::too_many_arguments)]
async fn probe_chat(
    adapter: &dyn aqbot_providers::ProviderAdapter,
    ctx: &ProviderRequestContext,
    model: &Model,
    prompt: &str,
    thinking_level: Option<&str>,
    settings: &AppSettings,
    on_event: &Channel<ModelTestProgressEvent>,
    test_id: &str,
    cancel_rx: &mut watch::Receiver<bool>,
    shared_first_text_ms: std::sync::Arc<std::sync::Mutex<Option<u64>>>,
    shared_preview: std::sync::Arc<std::sync::Mutex<String>>,
) -> ProbeOutcome {
    if *cancel_rx.borrow() {
        return ProbeOutcome {
            status: ModelTestStatus::Cancelled,
            first_text_ms: None,
            total_ms: None,
            preview: None,
            error_code: Some("cancelled".into()),
            error_detail: None,
        };
    }
    let overrides = model.param_overrides.as_ref();
    let params = crate::chat_params::resolve_chat_model_params(ChatParamInputs {
        conversation_temperature: None,
        conversation_top_p: None,
        conversation_max_tokens: None,
        model_param_overrides: overrides,
        settings,
        force_max_tokens: overrides.and_then(|value| value.force_max_tokens),
        max_output_tokens: model.max_output_tokens,
    });
    let request = ChatRequest {
        model: model.model_id.clone(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: ChatContent::Text(prompt.to_string()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        }],
        stream: true,
        temperature: params.temperature,
        top_p: params.top_p,
        max_tokens: params.max_tokens,
        tools: None,
        thinking_budget: None,
        thinking_level: thinking_level.map(str::to_string),
        reasoning_profile: overrides.and_then(|value| value.reasoning_profile.clone()),
        use_max_completion_tokens: overrides.and_then(|value| value.use_max_completion_tokens),
        thinking_param_style: overrides.and_then(|value| value.thinking_param_style.clone()),
        extra_body: model_extra_body_from_overrides(overrides),
    };

    let started = Instant::now();
    let mut stream = adapter.chat_stream(ctx, request);
    let mut filter = ThinkTagFilter::default();
    let mut first_text_ms = None;
    let mut preview = String::new();
    let mut saw_done = false;
    let mut finish_reason = None;
    let mut has_tool_calls = false;
    let mut has_thinking = false;
    let mut last_error = None;

    loop {
        if *cancel_rx.borrow() {
            return ProbeOutcome {
                status: ModelTestStatus::Cancelled,
                first_text_ms,
                total_ms: Some(started.elapsed().as_millis() as u64),
                preview: nonempty_preview(&preview),
                error_code: Some("cancelled".into()),
                error_detail: None,
            };
        }
        tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    return ProbeOutcome {
                        status: ModelTestStatus::Cancelled,
                        first_text_ms,
                        total_ms: Some(started.elapsed().as_millis() as u64),
                        preview: nonempty_preview(&preview),
                        error_code: Some("cancelled".into()),
                        error_detail: None,
                    };
                }
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(chunk)) => {
                        if let Some(reason) = chunk.finish_reason {
                            finish_reason = Some(reason);
                        }
                        if chunk.tool_calls.as_ref().is_some_and(|calls| !calls.is_empty()) {
                            has_tool_calls = true;
                        }
                        if let Some(thinking) = chunk.thinking.as_deref() {
                            has_thinking |= !thinking.trim().is_empty();
                        }
                        if let Some(content) = chunk.content.as_deref() {
                            let visible = filter.push_visible(content);
                            if first_text_ms.is_none()
                                && visible.chars().any(|ch| !ch.is_whitespace())
                            {
                                let elapsed = started.elapsed().as_millis() as u64;
                                first_text_ms = Some(elapsed);
                                if let Ok(mut slot) = shared_first_text_ms.lock() {
                                    *slot = Some(elapsed);
                                }
                                if on_event.send(ModelTestProgressEvent::FirstText {
                                    test_id: test_id.to_string(),
                                    first_text_ms: elapsed,
                                }).is_err() {
                                    return ProbeOutcome { status: ModelTestStatus::Cancelled, first_text_ms, total_ms: Some(started.elapsed().as_millis() as u64), preview: nonempty_preview(&visible), error_code: Some("progress_closed".into()), error_detail: None };
                                }
                            }
                            append_preview(&mut preview, &visible);
                            if let Ok(mut slot) = shared_preview.lock() {
                                append_preview(&mut slot, &visible);
                            }
                        }
                        if chunk.done {
                            saw_done = true;
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        last_error = Some(error.to_string());
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    drop(stream);
    has_thinking |= filter.has_thinking();
    if saw_done {
        let trailing = filter.finish_visible();
        if first_text_ms.is_none() && !trailing.trim().is_empty() {
            let elapsed = started.elapsed().as_millis() as u64;
            first_text_ms = Some(elapsed);
            if on_event
                .send(ModelTestProgressEvent::FirstText {
                    test_id: test_id.to_string(),
                    first_text_ms: elapsed,
                })
                .is_err()
            {
                return ProbeOutcome {
                    status: ModelTestStatus::Cancelled,
                    first_text_ms,
                    total_ms: Some(elapsed),
                    preview: nonempty_preview(&preview),
                    error_code: Some("progress_closed".into()),
                    error_detail: None,
                };
            }
        }
        append_preview(&mut preview, &trailing);
    }
    let total_ms = Some(started.elapsed().as_millis() as u64);
    let preview = nonempty_preview(&preview);
    let has_text = first_text_ms.is_some();

    if let Some(error) = last_error {
        return ProbeOutcome {
            status: ModelTestStatus::Failed,
            first_text_ms,
            total_ms,
            preview,
            error_code: Some("provider".into()),
            error_detail: Some(error),
        };
    }
    if *cancel_rx.borrow() {
        return ProbeOutcome {
            status: ModelTestStatus::Cancelled,
            first_text_ms,
            total_ms,
            preview,
            error_code: Some("cancelled".into()),
            error_detail: None,
        };
    }

    let incomplete_reason = match finish_reason {
        Some(ChatFinishReason::OutputLimit) => Some("output_limit"),
        Some(ChatFinishReason::ToolCalls) => Some("tool_calls"),
        Some(ChatFinishReason::ContentFilter) => Some("content_filter"),
        Some(ChatFinishReason::Other) => Some("unknown_finish_reason"),
        _ => None,
    };

    if matches!(finish_reason, Some(ChatFinishReason::ContentFilter)) {
        return ProbeOutcome {
            status: ModelTestStatus::Failed,
            first_text_ms,
            total_ms,
            preview,
            error_code: Some("content_filter".into()),
            error_detail: Some("The model filtered the response".into()),
        };
    }

    if !saw_done {
        return ProbeOutcome {
            status: if has_text {
                ModelTestStatus::Incomplete
            } else {
                ModelTestStatus::Failed
            },
            first_text_ms,
            total_ms,
            preview,
            error_code: Some("incomplete_stream".into()),
            error_detail: Some("Stream ended without a protocol terminal event".into()),
        };
    }

    if !has_text {
        return ProbeOutcome {
            status: if has_tool_calls || has_thinking || incomplete_reason.is_some() {
                ModelTestStatus::Incomplete
            } else {
                ModelTestStatus::Failed
            },
            first_text_ms,
            total_ms,
            preview,
            error_code: Some(
                if has_tool_calls {
                    "tool_calls"
                } else if let Some(reason) = incomplete_reason {
                    reason
                } else if has_thinking {
                    "thinking_only"
                } else {
                    "empty_result"
                }
                .into(),
            ),
            error_detail: Some("The model did not return visible text".into()),
        };
    }

    if let Some(code) = incomplete_reason {
        return ProbeOutcome {
            status: ModelTestStatus::Incomplete,
            first_text_ms,
            total_ms,
            preview,
            error_code: Some(code.into()),
            error_detail: None,
        };
    }

    ProbeOutcome {
        status: ModelTestStatus::Passed,
        first_text_ms,
        total_ms,
        preview,
        error_code: None,
        error_detail: None,
    }
}

async fn probe_embedding(
    adapter: &dyn aqbot_providers::ProviderAdapter,
    ctx: &ProviderRequestContext,
    model: &Model,
    cancel_rx: &mut watch::Receiver<bool>,
) -> ProbeOutcome {
    if *cancel_rx.borrow() {
        return ProbeOutcome {
            status: ModelTestStatus::Cancelled,
            first_text_ms: None,
            total_ms: None,
            preview: None,
            error_code: Some("cancelled".into()),
            error_detail: None,
        };
    }
    let started = Instant::now();
    let request = EmbedRequest {
        model: model.model_id.clone(),
        input: vec![MODEL_TEST_EMBED_INPUT.to_string()],
        dimensions: None,
    };
    let result = tokio::select! {
        _ = cancel_rx.changed() => {
            return ProbeOutcome {
                status: ModelTestStatus::Cancelled,
                first_text_ms: None,
                total_ms: Some(started.elapsed().as_millis() as u64),
                preview: None,
                error_code: Some("cancelled".into()),
                error_detail: None,
            };
        }
        result = adapter.embed(ctx, request) => result,
    };
    let total_ms = Some(started.elapsed().as_millis() as u64);
    match result {
        Ok(response) => {
            if validate_embedding(&response) {
                ProbeOutcome {
                    status: ModelTestStatus::Passed,
                    first_text_ms: None,
                    total_ms,
                    preview: Some(format!("dim {}", response.dimensions)),
                    error_code: None,
                    error_detail: None,
                }
            } else {
                ProbeOutcome {
                    status: ModelTestStatus::Failed,
                    first_text_ms: None,
                    total_ms,
                    preview: None,
                    error_code: Some("empty_result".into()),
                    error_detail: Some("Embedding response was empty or invalid".into()),
                }
            }
        }
        Err(error) => ProbeOutcome {
            status: ModelTestStatus::Failed,
            first_text_ms: None,
            total_ms,
            preview: None,
            error_code: Some("provider".into()),
            error_detail: Some(error.to_string()),
        },
    }
}

async fn probe_rerank(
    adapter: &dyn aqbot_providers::ProviderAdapter,
    ctx: &ProviderRequestContext,
    model: &Model,
    cancel_rx: &mut watch::Receiver<bool>,
) -> ProbeOutcome {
    if *cancel_rx.borrow() {
        return ProbeOutcome {
            status: ModelTestStatus::Cancelled,
            first_text_ms: None,
            total_ms: None,
            preview: None,
            error_code: Some("cancelled".into()),
            error_detail: None,
        };
    }
    let started = Instant::now();
    let request = RerankRequest {
        model: model.model_id.clone(),
        query: MODEL_TEST_RERANK_QUERY.to_string(),
        documents: vec![MODEL_TEST_RERANK_DOCUMENT.to_string()],
        top_n: 1,
    };
    let result = tokio::select! {
        _ = cancel_rx.changed() => {
            return ProbeOutcome {
                status: ModelTestStatus::Cancelled,
                first_text_ms: None,
                total_ms: Some(started.elapsed().as_millis() as u64),
                preview: None,
                error_code: Some("cancelled".into()),
                error_detail: None,
            };
        }
        result = adapter.rerank(ctx, request) => result,
    };
    let total_ms = Some(started.elapsed().as_millis() as u64);
    match result {
        Ok(response) => {
            if validate_rerank(&response) {
                let score = response.results[0].relevance_score;
                ProbeOutcome {
                    status: ModelTestStatus::Passed,
                    first_text_ms: None,
                    total_ms,
                    preview: Some(format!("score {score:.4}")),
                    error_code: None,
                    error_detail: None,
                }
            } else {
                ProbeOutcome {
                    status: ModelTestStatus::Failed,
                    first_text_ms: None,
                    total_ms,
                    preview: None,
                    error_code: Some("empty_result".into()),
                    error_detail: Some("Rerank response was empty or invalid".into()),
                }
            }
        }
        Err(error) => ProbeOutcome {
            status: ModelTestStatus::Failed,
            first_text_ms: None,
            total_ms,
            preview: None,
            error_code: Some("provider".into()),
            error_detail: Some(error.to_string()),
        },
    }
}

fn validate_embedding(response: &EmbedResponse) -> bool {
    if response.embeddings.len() != 1 {
        return false;
    }
    let vector = &response.embeddings[0];
    !vector.is_empty()
        && vector.len() == response.dimensions
        && vector.iter().all(|value| value.is_finite())
}

fn validate_rerank(response: &RerankResponse) -> bool {
    response.results.len() == 1
        && response
            .results
            .first()
            .is_some_and(|result| result.index == 0 && result.relevance_score.is_finite())
}

fn append_preview(preview: &mut String, text: &str) {
    let remaining = MODEL_TEST_PREVIEW_CHARS.saturating_sub(preview.chars().count());
    preview.extend(text.chars().take(remaining));
}

fn nonempty_preview(preview: &str) -> Option<String> {
    let trimmed = preview.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(truncate_chars(trimmed, MODEL_TEST_PREVIEW_CHARS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll};

    #[test]
    fn registry_rejects_duplicates_without_replacing_or_cancelling_the_active_test() {
        let mut registry = ModelTestRegistry::default();
        let active = registry.register("a".into()).unwrap();
        registry.bind_target("a", "p".into(), "m".into()).unwrap();
        assert!(registry.register("a".into()).is_err());
        let _second = registry.register("b".into()).unwrap();
        assert!(registry.bind_target("b", "p".into(), "m".into()).is_err());
        registry.remove_if_current("b");
        assert!(!*active.borrow());
        registry.cancel("a");
        assert!(*active.borrow());
        registry.remove_if_current("a");
        let _replacement = registry.register("c".into()).unwrap();
        registry.bind_target("c", "p".into(), "m".into()).unwrap();
    }

    struct ProbeAdapter {
        chunks: Vec<ChatStreamChunk>,
        pending: bool,
        dropped: Arc<AtomicBool>,
    }

    struct ProbeStream {
        chunks: VecDeque<ChatStreamChunk>,
        pending: bool,
        dropped: Arc<AtomicBool>,
    }

    impl futures::Stream for ProbeStream {
        type Item = aqbot_core::error::Result<ChatStreamChunk>;

        fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            match self.chunks.pop_front() {
                Some(chunk) => Poll::Ready(Some(Ok(chunk))),
                None if self.pending => Poll::Pending,
                None => Poll::Ready(None),
            }
        }
    }

    impl Drop for ProbeStream {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    #[async_trait::async_trait]
    impl aqbot_providers::ProviderAdapter for ProbeAdapter {
        async fn chat(
            &self,
            _ctx: &ProviderRequestContext,
            _request: ChatRequest,
        ) -> aqbot_core::error::Result<ChatResponse> {
            panic!("a model probe must use streaming chat")
        }

        fn chat_stream(
            &self,
            _ctx: &ProviderRequestContext,
            request: ChatRequest,
        ) -> Pin<Box<dyn futures::Stream<Item = aqbot_core::error::Result<ChatStreamChunk>> + Send>>
        {
            assert!(request.stream);
            assert!(request.tools.is_none());
            assert_eq!(request.max_tokens, Some(64));
            Box::pin(ProbeStream {
                chunks: self.chunks.clone().into(),
                pending: self.pending,
                dropped: self.dropped.clone(),
            })
        }

        async fn list_models(
            &self,
            _ctx: &ProviderRequestContext,
        ) -> aqbot_core::error::Result<Vec<Model>> {
            panic!("unused")
        }
        async fn embed(
            &self,
            _ctx: &ProviderRequestContext,
            _request: EmbedRequest,
        ) -> aqbot_core::error::Result<EmbedResponse> {
            panic!("unused")
        }
    }

    async fn run_probe(
        adapter: &ProbeAdapter,
        events: &Channel<ModelTestProgressEvent>,
        cancel: &mut watch::Receiver<bool>,
    ) -> ProbeOutcome {
        let model: Model = serde_json::from_value(serde_json::json!({
            "provider_id":"p", "model_id":"m", "name":"M", "model_type":"Chat",
            "capabilities":[], "enabled":false, "param_overrides":{"max_tokens":64,"force_max_tokens":true}
        })).unwrap();
        let ctx = ProviderRequestContext {
            api_key: String::new(),
            key_id: String::new(),
            provider_id: "p".into(),
            base_url: None,
            api_path: None,
            aws_region: None,
            proxy_config: None,
            custom_headers: None,
        };
        probe_chat(
            adapter,
            &ctx,
            &model,
            "Question",
            None,
            &AppSettings::default(),
            events,
            "test",
            cancel,
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(String::new())),
        )
        .await
    }

    fn adapter(chunks: Vec<ChatStreamChunk>) -> ProbeAdapter {
        ProbeAdapter {
            chunks,
            pending: false,
            dropped: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn chat_probe_requires_visible_text_and_accepted_terminal() {
        for (content, thinking, reason, done, expected, code) in [
            (
                Some("OK"),
                None,
                Some(ChatFinishReason::Stop),
                true,
                ModelTestStatus::Passed,
                None,
            ),
            (
                Some("OK"),
                None,
                Some(ChatFinishReason::OutputLimit),
                true,
                ModelTestStatus::Incomplete,
                Some("output_limit"),
            ),
            (
                Some("OK"),
                None,
                Some(ChatFinishReason::Other),
                true,
                ModelTestStatus::Incomplete,
                Some("unknown_finish_reason"),
            ),
            (
                Some("OK"),
                None,
                Some(ChatFinishReason::ContentFilter),
                true,
                ModelTestStatus::Failed,
                Some("content_filter"),
            ),
            (
                None,
                Some("reasoning"),
                Some(ChatFinishReason::Stop),
                true,
                ModelTestStatus::Incomplete,
                Some("thinking_only"),
            ),
            (
                Some("<think>reasoning</think>"),
                None,
                Some(ChatFinishReason::Stop),
                true,
                ModelTestStatus::Incomplete,
                Some("thinking_only"),
            ),
            (
                Some("  \n"),
                None,
                Some(ChatFinishReason::Stop),
                true,
                ModelTestStatus::Failed,
                Some("empty_result"),
            ),
            (
                Some("OK"),
                None,
                None,
                false,
                ModelTestStatus::Incomplete,
                Some("incomplete_stream"),
            ),
        ] {
            let adapter = adapter(vec![ChatStreamChunk {
                content: content.map(str::to_string),
                thinking: thinking.map(str::to_string),
                done,
                finish_reason: reason,
                ..Default::default()
            }]);
            let (_tx, mut cancel) = watch::channel(false);
            let outcome = run_probe(&adapter, &Channel::new(|_| Ok(())), &mut cancel).await;
            assert_eq!(outcome.status, expected, "{reason:?} {content:?}");
            assert_eq!(outcome.error_code.as_deref(), code);
            assert_eq!(outcome.first_text_ms.is_some(), content == Some("OK"));
            assert!(adapter.dropped.load(Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn chat_probe_filters_split_thinking_and_emits_only_one_first_text_event() {
        let mut chunks: Vec<_> = ["<think", ">内部", "思考</th", "ink>", " ", "O", "K"]
            .iter()
            .map(|text| ChatStreamChunk {
                content: Some((*text).into()),
                ..Default::default()
            })
            .collect();
        chunks.push(ChatStreamChunk {
            content: Some("答".repeat(1000)),
            done: true,
            finish_reason: Some(ChatFinishReason::Stop),
            ..Default::default()
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let channel = Channel::new(move |event| {
            captured.lock().unwrap().push(event);
            Ok(())
        });
        let (_tx, mut cancel) = watch::channel(false);
        let outcome = run_probe(&adapter(chunks), &channel, &mut cancel).await;
        assert_eq!(outcome.status, ModelTestStatus::Passed);
        let preview = outcome.preview.unwrap();
        assert!(preview.starts_with("OK答"));
        assert!(preview.chars().count() <= MODEL_TEST_PREVIEW_CHARS);
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_and_deadline_drop_an_upstream_waiting_for_body() {
        let mut adapter = adapter(vec![ChatStreamChunk {
            content: Some("OK".into()),
            ..Default::default()
        }]);
        adapter.pending = true;
        let (tx, mut cancel) = watch::channel(false);
        let channel = Channel::new(move |_| {
            tx.send(true).unwrap();
            Ok(())
        });
        let outcome = run_probe(&adapter, &channel, &mut cancel).await;
        assert_eq!(outcome.status, ModelTestStatus::Cancelled);
        assert!(adapter.dropped.load(Ordering::SeqCst));

        adapter.dropped.store(false, Ordering::SeqCst);
        let (_tx, mut cancel) = watch::channel(false);
        let channel = Channel::new(|_| Ok(()));
        assert!(tokio::time::timeout(
            Duration::from_secs(MODEL_TEST_TIMEOUT_SECS),
            run_probe(&adapter, &channel, &mut cancel)
        )
        .await
        .is_err());
        assert!(adapter.dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_closed_progress_channel_cancels_and_drops_the_stream() {
        let adapter = adapter(vec![ChatStreamChunk {
            content: Some("OK".into()),
            ..Default::default()
        }]);
        let (_tx, mut cancel) = watch::channel(false);
        let channel = Channel::new(|_| {
            Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "closed",
            )))
        });
        let outcome = run_probe(&adapter, &channel, &mut cancel).await;
        assert_eq!(outcome.status, ModelTestStatus::Cancelled);
        assert_eq!(outcome.error_code.as_deref(), Some("progress_closed"));
        assert!(adapter.dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancelling_before_the_probe_never_constructs_the_upstream_stream() {
        let adapter = adapter(vec![]);
        let (_tx, mut cancel) = watch::channel(true);
        let outcome = run_probe(&adapter, &Channel::new(|_| Ok(())), &mut cancel).await;
        assert_eq!(outcome.status, ModelTestStatus::Cancelled);
        assert_eq!(outcome.total_ms, None);
        assert!(!adapter.dropped.load(Ordering::SeqCst));
    }

    #[test]
    fn embedding_and_rerank_validate_shape_and_finite_values() {
        assert!(validate_embedding(&EmbedResponse {
            embeddings: vec![vec![0.5, -0.5]],
            dimensions: 2
        }));
        assert!(!validate_embedding(&EmbedResponse {
            embeddings: vec![vec![f32::NAN]],
            dimensions: 1
        }));
        assert!(!validate_embedding(&EmbedResponse {
            embeddings: vec![vec![0.5]],
            dimensions: 2
        }));
        assert!(validate_rerank(&RerankResponse {
            results: vec![RerankResult {
                index: 0,
                relevance_score: 0.5
            }]
        }));
        for (index, score) in [(1, 0.5), (0, f32::INFINITY)] {
            assert!(!validate_rerank(&RerankResponse {
                results: vec![RerankResult {
                    index,
                    relevance_score: score
                }]
            }));
        }
        assert!(!validate_rerank(&RerankResponse { results: vec![] }));
    }
}
