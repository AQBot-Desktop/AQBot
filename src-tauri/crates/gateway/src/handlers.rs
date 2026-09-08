use axum::{
    extract::{Extension, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json,
    },
};
use futures::StreamExt;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::time::Instant;
use tokio_stream::wrappers::ReceiverStream;

use aqbot_core::crypto::decrypt_key;
use aqbot_core::types::*;
use aqbot_providers::{resolve_base_url_for_type, ProviderAdapter, ProviderRequestContext};

use crate::auth::AuthenticatedKey;
use crate::server::GatewayAppState;

/// GET /health — unauthenticated health check
pub async fn health_check() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

/// GET /v1/models — list enabled models from all enabled providers.
///
/// Model IDs and aliases are listed. When the same request name collides across
/// providers:
/// - **auto routing off**: emit `public_id/name` (existing collision rule).
/// - **auto routing on**: emit a single bare name with `owned_by: "aqbot"`, and
///   still emit namespaced `public_id/name` entries so clients can pin a source.
///
/// Results are sorted deterministically by displayed model ID, then owner.
pub async fn list_models(State(state): State<GatewayAppState>) -> impl IntoResponse {
    let providers = match aqbot_core::repo::provider::list_providers(&state.db).await {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": { "message": e.to_string() } })),
            )
                .into_response();
        }
    };

    let auto_routing = aqbot_core::repo::settings::get_settings(&state.db)
        .await
        .map(|s| s.gateway_auto_model_routing)
        .unwrap_or(false);

    let models = build_gateway_model_list(&providers, auto_routing);

    Json(json!({
        "object": "list",
        "data": models,
    }))
    .into_response()
}

/// Build OpenAI-style model list entries for the gateway.
pub(crate) fn build_gateway_model_list(
    providers: &[ProviderConfig],
    auto_routing: bool,
) -> Vec<serde_json::Value> {
    use crate::auto_route::request_name_provider_counts;

    let public_id_map = build_provider_public_id_map(providers);
    let name_counts = request_name_provider_counts(providers);

    let mut models: Vec<serde_json::Value> = Vec::new();
    let mut emitted_aggregated: HashSet<String> = HashSet::new();

    for provider in providers.iter().filter(|p| p.enabled) {
        let public_id = public_id_map
            .get(&provider.id)
            .cloned()
            .unwrap_or_else(|| provider.name.clone());

        for model in provider.models.iter().filter(|m| m.enabled) {
            let mut names = vec![model.model_id.clone()];
            names.extend(model.aliases.iter().cloned());

            for name in names {
                let count = *name_counts.get(&name).unwrap_or(&0);
                if auto_routing && count > 1 {
                    if emitted_aggregated.insert(name.clone()) {
                        models.push(json!({
                            "id": name,
                            "object": "model",
                            "created": provider.created_at,
                            "owned_by": "aqbot",
                        }));
                    }
                    // Always keep namespaced pin entry when auto-routing aggregates.
                    models.push(json!({
                        "id": format!("{}/{}", public_id, name),
                        "object": "model",
                        "created": provider.created_at,
                        "owned_by": provider.name,
                    }));
                } else if count > 1 {
                    models.push(json!({
                        "id": format!("{}/{}", public_id, name),
                        "object": "model",
                        "created": provider.created_at,
                        "owned_by": provider.name,
                    }));
                } else {
                    models.push(json!({
                        "id": name,
                        "object": "model",
                        "created": provider.created_at,
                        "owned_by": provider.name,
                    }));
                }
            }
        }
    }

    models.sort_by(|a, b| {
        let id_a = a["id"].as_str().unwrap_or("");
        let id_b = b["id"].as_str().unwrap_or("");
        let ob_a = a["owned_by"].as_str().unwrap_or("");
        let ob_b = b["owned_by"].as_str().unwrap_or("");
        id_a.cmp(id_b).then(ob_a.cmp(ob_b))
    });
    models
}

/// POST /v1/chat/completions — main proxy handler
pub async fn chat_completions(
    State(state): State<GatewayAppState>,
    Extension(auth): Extension<AuthenticatedKey>,
    Json(request): Json<ChatRequest>,
) -> impl IntoResponse {
    let AuthenticatedKey(gateway_key) = auth;
    let start_time = Instant::now();

    // Fetch providers once — used for both model-field parsing and resolution.
    // Filter to only chat-completions-compatible provider types.
    let providers: Vec<ProviderConfig> =
        match aqbot_core::repo::provider::list_providers(&state.db).await {
            Ok(p) => p
                .into_iter()
                .filter(|p| {
                    matches!(
                        p.provider_type,
                        ProviderType::OpenAI
                            | ProviderType::DeepSeek
                            | ProviderType::XAI
                            | ProviderType::GLM
                            | ProviderType::SiliconFlow
                            | ProviderType::Custom
                    )
                })
                .collect(),
            Err(e) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
            }
        };
    let public_id_map = build_provider_public_id_map(&providers);
    let known_public_ids: HashSet<String> = public_id_map.values().cloned().collect();

    // Parse model field: supports "provider_public_id/model_id" (preferred),
    // or bare "model_id" / alias.
    let parsed = parse_model_field(&request.model, &known_public_ids);

    let global_settings = aqbot_core::repo::settings::get_settings(&state.db)
        .await
        .unwrap_or_default();
    let auto_routing = global_settings.gateway_auto_model_routing;

    let targets = match resolve_route_targets(&providers, &public_id_map, &parsed, auto_routing) {
        Ok(t) => t,
        Err(resp) => return resp,
    };

    let registry = aqbot_providers::registry::ProviderRegistry::create_default();
    let pinned = parsed.provider_hint.is_some() || targets.len() == 1 || !auto_routing;

    let mut last_error: Option<String> = None;
    for (idx, (provider, model_id)) in targets.into_iter().enumerate() {
        // Get active key and decrypt
        let provider_key =
            match aqbot_core::repo::provider::get_active_key(&state.db, &provider.id).await {
                Ok(k) => k,
                Err(_) => {
                    let msg = format!("No active API key for provider '{}'", provider.name);
                    crate::auto_route::mark_failure(&provider.id, &model_id);
                    last_error = Some(msg.clone());
                    if pinned {
                        return error_response(StatusCode::BAD_GATEWAY, &msg);
                    }
                    continue;
                }
            };

        let api_key = match decrypt_key(&provider_key.key_encrypted, &state.master_key) {
            Ok(k) => k,
            Err(e) => {
                tracing::error!("Failed to decrypt provider key: {}", e);
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal key error");
            }
        };

        let provider_type_str = provider_type_to_str(&provider.provider_type);
        let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

        let ctx = ProviderRequestContext {
            api_key,
            key_id: provider_key.id.clone(),
            provider_id: provider.id.clone(),
            base_url: Some(resolve_base_url_for_type(
                &provider.api_host,
                &provider.provider_type,
            )),
            api_path: provider.api_path.clone(),
            aws_region: provider.aws_region.clone(),
            proxy_config: resolved_proxy,
            custom_headers: provider
                .custom_headers
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok()),
        };

        let adapter = match registry.get(provider_type_str) {
            Some(a) => a,
            None => match registry.get("openai") {
                Some(a) => a,
                None => {
                    let msg = format!("No adapter for provider type '{}'", provider_type_str);
                    last_error = Some(msg.clone());
                    if pinned {
                        return error_response(StatusCode::BAD_GATEWAY, &msg);
                    }
                    continue;
                }
            },
        };

        let mut attempt_request = request.clone();
        // Always send the real upstream model id.
        attempt_request.model = model_id.clone();

        if attempt_request.stream {
            // Streaming: try until we get a stream handle; mid-stream failures
            // cannot failover (handle_stream owns the response after first byte).
            let response = handle_stream(
                adapter,
                &ctx,
                attempt_request,
                &state,
                &gateway_key,
                &provider.id,
                &model_id,
                start_time,
            )
            .await;
            // Success path returns 200 SSE; failure returns 502 JSON before stream starts.
            if response.status().is_success() {
                crate::auto_route::mark_success(&provider.id, &model_id);
                return response;
            }
            let msg = format!(
                "Upstream '{}' failed for model '{}'",
                provider.name, model_id
            );
            crate::auto_route::mark_failure(&provider.id, &model_id);
            last_error = Some(msg);
            if pinned {
                return response;
            }
            tracing::warn!(
                attempt = idx + 1,
                provider = %provider.name,
                model = %model_id,
                "gateway auto-route stream attempt failed; trying next"
            );
            continue;
        }

        match try_non_stream(
            adapter,
            &ctx,
            attempt_request,
            &state,
            &gateway_key,
            &provider.id,
            &model_id,
            start_time,
        )
        .await
        {
            Ok(response) => {
                crate::auto_route::mark_success(&provider.id, &model_id);
                return response;
            }
            Err(err_msg) => {
                let retriable = crate::auto_route::is_retriable_error_message(&err_msg);
                crate::auto_route::mark_failure(&provider.id, &model_id);
                last_error = Some(err_msg.clone());
                if pinned || !retriable {
                    let elapsed = start_time.elapsed().as_millis() as i32;
                    let _ = aqbot_core::repo::gateway_request_log::record_request_log(
                        &state.db,
                        &gateway_key.id,
                        &gateway_key.name,
                        "POST",
                        "/v1/chat/completions",
                        Some(&model_id),
                        Some(&provider.id),
                        502,
                        elapsed,
                        0,
                        0,
                        Some(&err_msg),
                    )
                    .await;
                    return error_response(StatusCode::BAD_GATEWAY, &err_msg);
                }
                tracing::warn!(
                    attempt = idx + 1,
                    provider = %provider.name,
                    model = %model_id,
                    error = %err_msg,
                    "gateway auto-route attempt failed; trying next"
                );
            }
        }
    }

    error_response(
        StatusCode::BAD_GATEWAY,
        last_error
            .as_deref()
            .unwrap_or("All upstream providers failed for this model"),
    )
}

/// Attempt a non-streaming chat call. On success returns the HTTP response.
/// On failure returns the error message (caller decides failover / logging).
async fn try_non_stream(
    adapter: &dyn ProviderAdapter,
    ctx: &ProviderRequestContext,
    request: ChatRequest,
    state: &GatewayAppState,
    gateway_key: &GatewayKey,
    provider_id: &str,
    model_id: &str,
    start_time: Instant,
) -> Result<axum::response::Response, String> {
    match adapter.chat(ctx, request).await {
        Ok(response) => {
            let _ = aqbot_core::repo::gateway::record_usage(
                &state.db,
                &gateway_key.id,
                provider_id,
                Some(model_id),
                response.usage.prompt_tokens as u64,
                response.usage.completion_tokens as u64,
            )
            .await;

            let elapsed = start_time.elapsed().as_millis() as i32;
            let _ = aqbot_core::repo::gateway_request_log::record_request_log(
                &state.db,
                &gateway_key.id,
                &gateway_key.name,
                "POST",
                "/v1/chat/completions",
                Some(model_id),
                Some(provider_id),
                200,
                elapsed,
                response.usage.prompt_tokens as i32,
                response.usage.completion_tokens as i32,
                None,
            )
            .await;

            Ok(Json(build_non_stream_response_body(&response)).into_response())
        }
        Err(e) => Err(e.to_string()),
    }
}

async fn handle_stream(
    adapter: &dyn ProviderAdapter,
    ctx: &ProviderRequestContext,
    request: ChatRequest,
    state: &GatewayAppState,
    gateway_key: &GatewayKey,
    provider_id: &str,
    model_id: &str,
    start_time: Instant,
) -> axum::response::Response {
    let model_str = model_id.to_string();
    let mut stream = adapter.chat_stream(ctx, request);

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(32);
    let db = state.db.clone();
    let key_id = gateway_key.id.clone();
    let key_name = gateway_key.name.clone();
    let prov_id = provider_id.to_string();
    let mod_id = model_id.to_string();

    tokio::spawn(async move {
        let mut total_prompt = 0u32;
        let mut total_completion = 0u32;
        let mut total_tokens = 0u32;
        let mut stream_error: Option<String> = None;

        loop {
            let chunk_result = tokio::select! {
                _ = tx.closed() => break,
                result = stream.next() => result,
            };
            let Some(chunk_result) = chunk_result else {
                stream_error = Some("Stream ended without a protocol terminal event".into());
                let data = json!({"error": {"message": stream_error.as_deref()}});
                let _ = tx.send(Ok(Event::default().data(data.to_string()))).await;
                break;
            };
            match chunk_result {
                Ok(chunk) => {
                    if let Some(usage) = &chunk.usage {
                        total_prompt = usage.prompt_tokens;
                        total_completion = usage.completion_tokens;
                        total_tokens = usage.total_tokens;
                    }

                    if let Some(data) = build_stream_chunk_response_body(&model_str, &chunk) {
                        if tx
                            .send(Ok(Event::default().data(data.to_string())))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }

                    if chunk.done {
                        // Send final chunk
                        let data = match build_stream_final_response_body(
                            &model_str,
                            &TokenUsage {
                                prompt_tokens: total_prompt,
                                completion_tokens: total_completion,
                                total_tokens,
                            },
                            chunk.finish_reason,
                        ) {
                            Ok(data) => data,
                            Err(error) => {
                                stream_error = Some(error.into());
                                let data = json!({"error": {"message": error}});
                                let _ = tx.send(Ok(Event::default().data(data.to_string()))).await;
                                break;
                            }
                        };
                        let _ = tx.send(Ok(Event::default().data(data.to_string()))).await;
                        let _ = tx.send(Ok(Event::default().data("[DONE]"))).await;
                        break;
                    }
                }
                Err(e) => {
                    stream_error = Some(e.to_string());
                    let data = json!({
                        "error": { "message": e.to_string() }
                    });
                    let _ = tx.send(Ok(Event::default().data(data.to_string()))).await;
                    break;
                }
            }
        }
        drop(stream);

        // Record usage
        let _ = aqbot_core::repo::gateway::record_usage(
            &db,
            &key_id,
            &prov_id,
            Some(&mod_id),
            total_prompt as u64,
            total_completion as u64,
        )
        .await;

        let elapsed = start_time.elapsed().as_millis() as i32;
        let status_code = if stream_error.is_some() { 502 } else { 200 };
        let _ = aqbot_core::repo::gateway_request_log::record_request_log(
            &db,
            &key_id,
            &key_name,
            "POST",
            "/v1/chat/completions",
            Some(&mod_id),
            Some(&prov_id),
            status_code,
            elapsed,
            total_prompt as i32,
            total_completion as i32,
            stream_error.as_deref(),
        )
        .await;
    });

    let sse_stream = ReceiverStream::new(rx);
    Sse::new(sse_stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn build_non_stream_response_body(response: &ChatResponse) -> serde_json::Value {
    let mut message = serde_json::Map::from_iter([
        ("role".to_string(), json!("assistant")),
        ("content".to_string(), json!(response.content)),
    ]);
    if let Some(reasoning) = response
        .thinking
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        message.insert("reasoning_content".to_string(), json!(reasoning));
    }

    json!({
        "id": response.id,
        "object": "chat.completion",
        "model": response.model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": response.usage.prompt_tokens,
            "completion_tokens": response.usage.completion_tokens,
            "total_tokens": response.usage.total_tokens,
        }
    })
}

fn build_stream_chunk_response_body(
    model: &str,
    chunk: &ChatStreamChunk,
) -> Option<serde_json::Value> {
    let mut delta = serde_json::Map::new();

    if let Some(content) = chunk.content.as_deref().filter(|value| !value.is_empty()) {
        delta.insert("content".to_string(), json!(content));
    }
    if let Some(reasoning) = chunk.thinking.as_deref().filter(|value| !value.is_empty()) {
        delta.insert("reasoning_content".to_string(), json!(reasoning));
    }
    if let Some(calls) = chunk.tool_calls.as_ref().filter(|calls| !calls.is_empty()) {
        delta.insert("tool_calls".into(), json!(calls.iter().enumerate().map(|(index, call)| {
            json!({"index": index, "id": call.id, "type": call.call_type, "function": call.function})
        }).collect::<Vec<_>>()));
    }

    if delta.is_empty() {
        None
    } else {
        Some(json!({
            "id": "chatcmpl-gateway",
            "object": "chat.completion.chunk",
            "model": model,
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": null,
            }]
        }))
    }
}

fn build_stream_final_response_body(
    model: &str,
    usage: &TokenUsage,
    finish_reason: Option<ChatFinishReason>,
) -> Result<serde_json::Value, &'static str> {
    let finish_reason = finish_reason
        .unwrap_or(ChatFinishReason::Stop)
        .as_openai_str()
        .ok_or("Provider returned an unknown finish reason")?;
    Ok(json!({
        "id": "chatcmpl-gateway",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": finish_reason,
        }],
        "usage": {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
        }
    }))
}

// ── Model-name helpers ────────────────────────────────────────────────────────

/// Derive a stable, URL-safe slug from a provider's human-readable name.
///
/// Rules: lowercase, runs of non-alphanumeric characters become a single `-`,
/// leading/trailing `-` are stripped.  E.g. "OpenAI (EU)" → `"openai-eu"`.
fn provider_slug(name: &str) -> String {
    let raw: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    raw.split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Build a `provider_internal_id → public_id` map for all enabled providers.
///
/// The public ID is the name slug (see [`provider_slug`]).  When two or more
/// enabled providers share the same base slug (e.g. `"OpenAI"` and `"Open AI"`
/// both normalise to `"openai"`), a numeric suffix is appended (`-2`, `-3`, …)
/// in **internal-ID–sorted order** so the result is unique and deterministic.
pub(crate) fn build_provider_public_id_map(
    providers: &[ProviderConfig],
) -> HashMap<String, String> {
    // Group enabled providers by their base slug.
    let mut slug_groups: HashMap<String, Vec<String>> = HashMap::new();
    for p in providers.iter().filter(|p| p.enabled) {
        slug_groups
            .entry(provider_slug(&p.name))
            .or_default()
            .push(p.id.clone());
    }

    let mut map = HashMap::new();
    for (base_slug, mut ids) in slug_groups {
        if ids.len() == 1 {
            map.insert(ids.remove(0), base_slug);
        } else {
            // Stable tie-breaking by internal ID (lexicographic).
            ids.sort();
            for (i, id) in ids.into_iter().enumerate() {
                let public_id = if i == 0 {
                    base_slug.clone()
                } else {
                    format!("{}-{}", base_slug, i + 1)
                };
                map.insert(id, public_id);
            }
        }
    }
    map
}

/// Build a `(provider_internal_id, model_id) → display_id` map for all
/// enabled models across all enabled providers.
///
/// Display rules:
/// - If a `model_id` is **globally unique** across enabled providers → emit bare `model_id`.
/// - If the same `model_id` appears on **multiple** enabled providers → emit
///   `public_provider_id/model_id` using the ID from [`build_provider_public_id_map`].
fn build_model_display_map(providers: &[ProviderConfig]) -> HashMap<(String, String), String> {
    let public_id_map = build_provider_public_id_map(providers);

    // Count how many enabled providers expose each model_id.
    let mut model_id_counts: HashMap<String, usize> = HashMap::new();
    for provider in providers.iter().filter(|p| p.enabled) {
        for model in provider.models.iter().filter(|m| m.enabled) {
            *model_id_counts.entry(model.model_id.clone()).or_default() += 1;
        }
    }

    let mut map = HashMap::new();
    for provider in providers.iter().filter(|p| p.enabled) {
        let public_id = public_id_map.get(&provider.id).cloned().unwrap_or_default();
        for model in provider.models.iter().filter(|m| m.enabled) {
            let count = *model_id_counts.get(&model.model_id).unwrap_or(&0);
            let display_id = if count > 1 {
                format!("{}/{}", public_id, model.model_id)
            } else {
                model.model_id.clone()
            };
            map.insert((provider.id.clone(), model.model_id.clone()), display_id);
        }
    }
    map
}

// ── Model-field parsing ───────────────────────────────────────────────────────

/// Result of parsing the `model` field from a chat completion request.
pub(crate) struct ParsedModel {
    /// Provider hint, if present (public ID from `/` separator).
    pub(crate) provider_hint: Option<String>,
    /// The bare model identifier (right-hand side, or whole string if no separator).
    pub(crate) model_id: String,
}

/// Parse the `model` field of a chat completion request.
///
/// Accepted formats:
/// 1. `provider_public_id/model_id`  — preferred namespaced form; only
///    recognised when the left segment is a **known** public provider ID.
///    This prevents misparsing native model IDs that contain `/` (e.g.
///    `"accounts/fireworks/models/qwen3"`).
/// 2. `model_id`                     — bare; resolved by unique match across providers
pub(crate) fn parse_model_field(model: &str, known_public_ids: &HashSet<String>) -> ParsedModel {
    if let Some((left, right)) = model.split_once('/') {
        if known_public_ids.contains(left) {
            return ParsedModel {
                provider_hint: Some(left.to_string()),
                model_id: right.to_string(),
            };
        }
    }
    ParsedModel {
        provider_hint: None,
        model_id: model.to_string(),
    }
}

/// Resolve a single target (legacy helper / native pin). Prefer [`resolve_route_targets`].
#[allow(dead_code)]
pub(crate) fn resolve_provider_for_model(
    providers: &[ProviderConfig],
    public_id_map: &HashMap<String, String>,
    parsed: &ParsedModel,
) -> Result<(ProviderConfig, String), axum::response::Response> {
    let mut targets = resolve_route_targets(providers, public_id_map, parsed, false)?;
    // When auto_routing is false only one target is returned; take the first.
    let first = targets.remove(0);
    Ok(first)
}

/// Resolve one or more `(provider, real_model_id)` targets for a request.
///
/// - With provider hint: always a single pinned target (model id or alias).
/// - Bare name: all matching providers (id or alias). When `auto_routing` is
///   false only the first (by sort_order) is returned; when true, the full
///   ordered pool is returned for failover.
pub(crate) fn resolve_route_targets(
    providers: &[ProviderConfig],
    public_id_map: &HashMap<String, String>,
    parsed: &ParsedModel,
    auto_routing: bool,
) -> Result<Vec<(ProviderConfig, String)>, axum::response::Response> {
    use crate::auto_route::{
        candidates_for_attempt, collect_candidates, resolve_real_model_id, RouteCandidate,
    };

    let enabled: Vec<&ProviderConfig> = providers.iter().filter(|p| p.enabled).collect();
    let provider_by_id: HashMap<&str, &ProviderConfig> =
        enabled.iter().map(|p| (p.id.as_str(), *p)).collect();

    match &parsed.provider_hint {
        Some(hint) => {
            let provider_opt = enabled
                .iter()
                .find(|p| public_id_map.get(&p.id).map_or(false, |id| id == hint));

            let provider = provider_opt.ok_or_else(|| {
                error_response(
                    StatusCode::NOT_FOUND,
                    &format!("Provider '{}' not found", hint),
                )
            })?;

            let real_id = provider
                .models
                .iter()
                .filter(|m| m.enabled)
                .find_map(|m| resolve_real_model_id(m, &parsed.model_id))
                .ok_or_else(|| {
                    error_response(
                        StatusCode::NOT_FOUND,
                        &format!(
                            "Model '{}' not found on provider '{}'",
                            parsed.model_id, hint
                        ),
                    )
                })?;

            Ok(vec![((*provider).clone(), real_id)])
        }
        None => {
            let cands = collect_candidates(providers, &parsed.model_id);
            if cands.is_empty() {
                return Err(error_response(
                    StatusCode::NOT_FOUND,
                    &format!("Model '{}' not found", parsed.model_id),
                ));
            }

            let ordered: Vec<RouteCandidate> = if auto_routing && cands.len() > 1 {
                candidates_for_attempt(&cands)
            } else {
                // First-match by sort_order (compat when auto routing is off).
                cands.into_iter().take(1).collect()
            };

            let mut out = Vec::with_capacity(ordered.len());
            for cand in ordered {
                if let Some(provider) = provider_by_id.get(cand.provider_id.as_str()) {
                    out.push(((*provider).clone(), cand.real_model_id));
                }
            }
            if out.is_empty() {
                return Err(error_response(
                    StatusCode::NOT_FOUND,
                    &format!("Model '{}' not found", parsed.model_id),
                ));
            }
            Ok(out)
        }
    }
}

pub(crate) fn provider_type_to_str(pt: &ProviderType) -> &'static str {
    match pt {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::DeepSeek => "deepseek",
        ProviderType::XAI => "xai",
        ProviderType::GLM => "glm",
        ProviderType::SiliconFlow => "siliconflow",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Bedrock => "bedrock",
        ProviderType::Custom => "custom",
    }
}

pub(crate) fn error_response(status: StatusCode, message: &str) -> axum::response::Response {
    (
        status,
        Json(json!({
            "error": {
                "message": message,
                "type": "api_error",
            }
        })),
    )
        .into_response()
}

// ── Unit tests ────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::{
        crypto::{encrypt_key, key_prefix},
        db::{create_test_pool, DbHandle},
        repo::{gateway, provider},
        types::{CreateProviderInput, ModelCapability, ModelType},
    };
    use axum::{
        body::{to_bytes, Body},
        extract::State,
        http::{header, HeaderMap, Method, Request, Response, StatusCode},
        routing::any,
        Router,
    };
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    use crate::{routes::create_router, server::GatewayAppState};

    #[derive(Clone, Debug)]
    struct CapturedChatRequest {
        body: serde_json::Value,
    }

    #[derive(Clone)]
    struct MockChatUpstreamState {
        captures: Arc<Mutex<Vec<CapturedChatRequest>>>,
        headers: HeaderMap,
        body: String,
    }

    async fn mock_chat_upstream_handler(
        State(state): State<MockChatUpstreamState>,
        request: Request<Body>,
    ) -> Response<Body> {
        let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
        state.captures.lock().unwrap().push(CapturedChatRequest {
            body: serde_json::from_slice(&bytes).unwrap(),
        });

        let mut response = Response::builder().status(StatusCode::OK);
        for (name, value) in state.headers.iter() {
            response = response.header(name, value);
        }
        response.body(Body::from(state.body.clone())).unwrap()
    }

    async fn spawn_mock_chat_upstream(
        headers: HeaderMap,
        body: String,
    ) -> (
        String,
        Arc<Mutex<Vec<CapturedChatRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let captures = Arc::new(Mutex::new(Vec::new()));
        let state = MockChatUpstreamState {
            captures: captures.clone(),
            headers,
            body,
        };
        let app = Router::new()
            .fallback(any(mock_chat_upstream_handler))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        (format!("http://{}", addr), captures, task)
    }

    async fn seed_chat_router_with_duplicate_model(
        api_host: &str,
    ) -> (Router, DbHandle, String, GatewayAppState) {
        let handle = create_test_pool().await.unwrap();
        let db = &handle.conn;
        let gateway_key = gateway::create_gateway_key(db, "Chat Test Key", None)
            .await
            .unwrap();
        let master_key = [7u8; 32];

        for provider_name in ["DeepSeek", "DeepSeek Backup"] {
            let provider = provider::create_provider(
                db,
                CreateProviderInput {
                    name: provider_name.into(),
                    provider_type: ProviderType::DeepSeek,
                    api_host: api_host.into(),
                    api_path: None,
                    aws_region: None,
                    enabled: true,
                    builtin_id: None,
                },
            )
            .await
            .unwrap();
            provider::save_models(
                db,
                &provider.id,
                &[Model {
                    provider_id: provider.id.clone(),
                    model_id: "deepseek-v4-pro".into(),
                    name: "deepseek-v4-pro".into(),
                    group_name: None,
                    model_type: ModelType::Chat,
                    capabilities: vec![ModelCapability::TextChat],
                    context_window: Some(4096),
                    max_output_tokens: None,
                    enabled: true,
                    param_overrides: None,
                    image_config: None,
                    metadata_state: None,
                    aliases: Vec::new(),
                }],
            )
            .await
            .unwrap();
            provider::add_provider_key(
                db,
                &provider.id,
                &encrypt_key("upstream-secret", &master_key).unwrap(),
                &key_prefix("upstream-secret"),
            )
            .await
            .unwrap();
        }

        let state = GatewayAppState {
            db: handle.conn.clone(),
            master_key,
        };
        (
            create_router(state.clone()),
            handle,
            gateway_key.plain_key,
            state,
        )
    }

    fn chat_request_body(stream: bool) -> String {
        json!({
            "model": "deepseek/deepseek-v4-pro",
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": stream
        })
        .to_string()
    }

    // ── provider_slug ─────────────────────────────────────────────────────────

    #[test]
    fn test_provider_slug_simple() {
        assert_eq!(provider_slug("OpenAI"), "openai");
    }

    #[test]
    fn test_provider_slug_spaces_and_parens() {
        assert_eq!(provider_slug("OpenAI (EU)"), "openai-eu");
    }

    #[test]
    fn test_provider_slug_leading_trailing_special() {
        assert_eq!(provider_slug("--Anthropic--"), "anthropic");
    }

    #[test]
    fn test_provider_slug_numbers() {
        assert_eq!(provider_slug("Provider 42 Beta"), "provider-42-beta");
    }

    // ── parse_model_field ─────────────────────────────────────────────────────

    fn known_ids(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_parse_slash_format() {
        let p = parse_model_field("openai/gpt-4o", &known_ids(&["openai"]));
        assert_eq!(p.provider_hint.as_deref(), Some("openai"));
        assert_eq!(p.model_id, "gpt-4o");
    }

    #[test]
    fn test_parse_bare_model() {
        let p = parse_model_field("gpt-4o", &known_ids(&[]));
        assert!(p.provider_hint.is_none());
        assert_eq!(p.model_id, "gpt-4o");
    }

    // Slash is treated as namespaced only when the left segment is a known public ID.
    #[test]
    fn test_parse_slash_with_colon_in_model() {
        let p = parse_model_field("openai/gpt-4:legacy", &known_ids(&["openai"]));
        assert_eq!(p.provider_hint.as_deref(), Some("openai"));
        assert_eq!(p.model_id, "gpt-4:legacy");
    }

    // A model ID whose first segment is NOT a known public provider ID must be
    // kept as a bare model ID, not misinterpreted as `provider/model`.
    #[test]
    fn test_parse_slash_in_model_id_treated_as_bare() {
        let p = parse_model_field("accounts/fireworks/models/qwen3", &known_ids(&[]));
        assert!(p.provider_hint.is_none());
        assert_eq!(p.model_id, "accounts/fireworks/models/qwen3");
    }

    // Unknown left segment with colon is treated as bare model.
    #[test]
    fn test_parse_unknown_prefix_with_colon_treated_as_bare() {
        let p = parse_model_field("unknown/model:variant", &known_ids(&[]));
        assert!(p.provider_hint.is_none());
        assert_eq!(p.model_id, "unknown/model:variant");
    }

    // ── build_provider_public_id_map ──────────────────────────────────────────

    #[test]
    fn test_public_id_map_no_collision() {
        let providers = vec![
            make_provider("p1", "OpenAI", &["gpt-4o"]),
            make_provider("p2", "Anthropic", &["claude-3-opus"]),
        ];
        let map = build_provider_public_id_map(&providers);
        assert_eq!(map["p1"], "openai");
        assert_eq!(map["p2"], "anthropic");
    }

    #[test]
    fn test_public_id_map_slug_collision_deduplication() {
        // "Open-AI" and "Open AI" both normalise to "open-ai".
        // p1 < p2 lexicographically → p1 keeps "open-ai", p2 gets "open-ai-2".
        let providers = vec![
            make_provider("p1", "Open-AI", &["gpt-4o"]),
            make_provider("p2", "Open AI", &["gpt-4"]),
        ];
        let map = build_provider_public_id_map(&providers);
        assert_eq!(map["p1"], "open-ai");
        assert_eq!(map["p2"], "open-ai-2");
    }

    #[test]
    fn test_public_id_map_triple_collision() {
        let providers = vec![
            make_provider("pa", "A Provider", &[]),
            make_provider("pb", "A Provider", &[]),
            make_provider("pc", "A Provider", &[]),
        ];
        let map = build_provider_public_id_map(&providers);
        // Sorted by ID: pa → a-provider, pb → a-provider-2, pc → a-provider-3
        assert_eq!(map["pa"], "a-provider");
        assert_eq!(map["pb"], "a-provider-2");
        assert_eq!(map["pc"], "a-provider-3");
    }

    // ── build_model_display_map ───────────────────────────────────────────────

    fn make_provider(id: &str, name: &str, model_ids: &[&str]) -> ProviderConfig {
        ProviderConfig {
            id: id.to_string(),
            name: name.to_string(),
            provider_type: ProviderType::Custom,
            api_host: String::new(),
            api_path: None,
            aws_region: None,
            enabled: true,
            models: model_ids
                .iter()
                .map(|mid| Model {
                    provider_id: id.to_string(),
                    model_id: mid.to_string(),
                    name: mid.to_string(),
                    group_name: None,
                    model_type: ModelType::Chat,
                    capabilities: vec![],
                    context_window: None,
                    max_output_tokens: None,
                    enabled: true,
                    param_overrides: None,
                    image_config: None,
                    metadata_state: None,
                    aliases: Vec::new(),
                })
                .collect(),
            keys: vec![],
            proxy_config: None,
            custom_headers: None,
            icon: None,
            builtin_id: None,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn test_display_map_slug_collision_uses_deduplicated_public_id() {
        // "Open-AI" and "Open AI" → same base slug "open-ai".
        // p1 (id="p1") < p2 (id="p2") → p1 = "open-ai", p2 = "open-ai-2".
        let providers = vec![
            make_provider("p1", "Open-AI", &["gpt-4o", "shared-model"]),
            make_provider("p2", "Open AI", &["gpt-4", "shared-model"]),
        ];
        let map = build_model_display_map(&providers);
        // shared-model is on both → namespaced with deduplicated public IDs
        assert_eq!(
            map[&("p1".to_string(), "shared-model".to_string())],
            "open-ai/shared-model"
        );
        assert_eq!(
            map[&("p2".to_string(), "shared-model".to_string())],
            "open-ai-2/shared-model"
        );
        // unique models stay bare
        assert_eq!(map[&("p1".to_string(), "gpt-4o".to_string())], "gpt-4o");
        assert_eq!(map[&("p2".to_string(), "gpt-4".to_string())], "gpt-4");
    }

    #[test]
    fn test_display_map_unique_models_bare() {
        let providers = vec![
            make_provider("p1", "OpenAI", &["gpt-4o", "gpt-3.5-turbo"]),
            make_provider("p2", "Anthropic", &["claude-3-opus"]),
        ];
        let map = build_model_display_map(&providers);
        assert_eq!(map[&("p1".to_string(), "gpt-4o".to_string())], "gpt-4o");
        assert_eq!(
            map[&("p1".to_string(), "gpt-3.5-turbo".to_string())],
            "gpt-3.5-turbo"
        );
        assert_eq!(
            map[&("p2".to_string(), "claude-3-opus".to_string())],
            "claude-3-opus"
        );
    }

    #[test]
    fn test_display_map_collision_uses_slug_prefix() {
        let providers = vec![
            make_provider("p1", "OpenAI", &["gpt-4o", "custom-model"]),
            make_provider("p2", "My Provider", &["custom-model"]),
        ];
        let map = build_model_display_map(&providers);
        // gpt-4o is unique → bare
        assert_eq!(map[&("p1".to_string(), "gpt-4o".to_string())], "gpt-4o");
        // custom-model appears on both → namespaced
        assert_eq!(
            map[&("p1".to_string(), "custom-model".to_string())],
            "openai/custom-model"
        );
        assert_eq!(
            map[&("p2".to_string(), "custom-model".to_string())],
            "my-provider/custom-model"
        );
    }

    #[test]
    fn test_display_map_disabled_provider_excluded() {
        let mut providers = vec![
            make_provider("p1", "OpenAI", &["gpt-4o"]),
            make_provider("p2", "OtherAI", &["gpt-4o"]),
        ];
        // Disable p2 → no collision
        providers[1].enabled = false;
        let map = build_model_display_map(&providers);
        // Only p1 is enabled, gpt-4o is unique
        assert_eq!(map[&("p1".to_string(), "gpt-4o".to_string())], "gpt-4o");
        // p2 is disabled → not in map at all
        assert!(!map.contains_key(&("p2".to_string(), "gpt-4o".to_string())));
    }

    #[test]
    fn resolve_route_targets_alias_rewrites_to_real_model_id() {
        let mut providers = vec![make_provider("p1", "OpenAI", &["claude-sonnet-real"])];
        providers[0].models[0].aliases = vec!["sonnet".into()];
        let map = build_provider_public_id_map(&providers);
        let parsed = parse_model_field("sonnet", &HashSet::new());
        let targets = resolve_route_targets(&providers, &map, &parsed, false).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].1, "claude-sonnet-real");
    }

    #[test]
    fn resolve_route_targets_auto_routing_returns_pool() {
        let mut providers = vec![
            make_provider("p1", "OpenAI", &["gpt-5.5"]),
            make_provider("p2", "OtherAI", &["gpt-5.5"]),
        ];
        providers[0].sort_order = 10;
        providers[1].sort_order = 0;
        let map = build_provider_public_id_map(&providers);
        let parsed = parse_model_field("gpt-5.5", &HashSet::new());
        let single = resolve_route_targets(&providers, &map, &parsed, false).unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].0.id, "p2");

        let multi = resolve_route_targets(&providers, &map, &parsed, true).unwrap();
        assert_eq!(multi.len(), 2);
        assert_eq!(multi[0].0.id, "p2");
        assert_eq!(multi[1].0.id, "p1");
    }

    #[test]
    fn gateway_model_list_aggregates_when_auto_routing() {
        let providers = vec![
            make_provider("p1", "OpenAI", &["gpt-5.5"]),
            make_provider("p2", "OtherAI", &["gpt-5.5"]),
        ];
        let off = build_gateway_model_list(&providers, false);
        let off_ids: Vec<&str> = off.iter().filter_map(|v| v["id"].as_str()).collect();
        assert!(off_ids.iter().all(|id| id.contains('/')));

        let on = build_gateway_model_list(&providers, true);
        let on_ids: Vec<&str> = on.iter().filter_map(|v| v["id"].as_str()).collect();
        assert!(on_ids.contains(&"gpt-5.5"));
        assert!(on_ids
            .iter()
            .any(|id| id.contains("gpt-5.5") && id.contains('/')));
        let bare = on
            .iter()
            .find(|v| v["id"] == "gpt-5.5")
            .expect("aggregated bare id");
        assert_eq!(bare["owned_by"], "aqbot");
    }

    #[test]
    fn test_non_stream_payload_includes_reasoning_content() {
        let payload = build_non_stream_response_body(&ChatResponse {
            id: "resp_1".into(),
            model: "deepseek-chat".into(),
            content: "final answer".into(),
            thinking: Some("first think, then answer".into()),
            usage: TokenUsage {
                prompt_tokens: 12,
                completion_tokens: 8,
                total_tokens: 20,
            },
            tool_calls: None,
        });

        assert_eq!(
            payload["choices"][0]["message"]["reasoning_content"],
            json!("first think, then answer")
        );
    }

    #[test]
    fn test_stream_chunk_payload_includes_reasoning_content_delta() {
        let payload = build_stream_chunk_response_body(
            "deepseek-chat",
            &ChatStreamChunk {
                content: None,
                thinking: Some("step-by-step".into()),
                done: false,
                is_final: None,
                usage: None,
                tool_calls: None,
                finish_reason: None,
            },
        )
        .expect("chunk payload");

        assert_eq!(
            payload["choices"][0]["delta"]["reasoning_content"],
            json!("step-by-step")
        );
    }

    #[test]
    fn stream_final_payload_preserves_finish_reason_usage_and_tool_calls() {
        let usage = TokenUsage {
            prompt_tokens: 3,
            completion_tokens: 4,
            total_tokens: 7,
        };
        for (reason, expected) in [
            (ChatFinishReason::Stop, "stop"),
            (ChatFinishReason::OutputLimit, "length"),
            (ChatFinishReason::ToolCalls, "tool_calls"),
            (ChatFinishReason::ContentFilter, "content_filter"),
        ] {
            let payload = build_stream_final_response_body("model", &usage, Some(reason)).unwrap();
            assert_eq!(payload["choices"][0]["finish_reason"], expected);
            assert_eq!(payload["usage"]["total_tokens"], 7);
        }
        assert!(
            build_stream_final_response_body("model", &usage, Some(ChatFinishReason::Other))
                .is_err()
        );
        let payload = build_stream_chunk_response_body(
            "model",
            &ChatStreamChunk {
                done: true,
                tool_calls: Some(vec![aqbot_core::types::ToolCall {
                    id: "call_1".into(),
                    call_type: "function".into(),
                    function: aqbot_core::types::ToolCallFunction {
                        name: "weather".into(),
                        arguments: "{}".into(),
                    },
                }]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            payload["choices"][0]["delta"]["tool_calls"][0]["function"]["name"],
            "weather"
        );
    }

    #[tokio::test]
    async fn chat_completions_sends_canonical_model_to_upstream_for_namespaced_non_stream() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let upstream_body = json!({
            "id": "chatcmpl-upstream",
            "object": "chat.completion",
            "model": "deepseek-v4-pro",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": "ok" },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5 }
        })
        .to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_chat_upstream(headers, upstream_body).await;
        let (app, _handle, gateway_key, _) =
            seed_chat_router_with_duplicate_model(&upstream_base).await;

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/chat/completions")
                    .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(chat_request_body(false)))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].body["model"], "deepseek-v4-pro");

        upstream_task.abort();
    }

    #[tokio::test]
    async fn chat_completions_sends_canonical_model_to_upstream_for_namespaced_stream() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
        let upstream_body = concat!(
            "data: {\"id\":\"chatcmpl-upstream\",\"object\":\"chat.completion.chunk\",\"model\":\"deepseek-v4-pro\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
            "data: [DONE]\n\n"
        )
        .to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_chat_upstream(headers, upstream_body).await;
        let (app, _handle, gateway_key, _) =
            seed_chat_router_with_duplicate_model(&upstream_base).await;

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/chat/completions")
                    .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(chat_request_body(true)))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let _ = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].body["model"], "deepseek-v4-pro");

        upstream_task.abort();
    }
}
