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
use std::collections::{BTreeMap, HashMap, HashSet};
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
/// With `gateway_model_provider_prefix` on, non-colliding names are also
/// emitted as `public_id/name`. Bare names remain accepted on requests.
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

    let settings = aqbot_core::repo::settings::get_settings(&state.db)
        .await
        .unwrap_or_default();

    let models = build_gateway_model_list(
        &providers,
        settings.gateway_auto_model_routing,
        settings.gateway_model_provider_prefix,
    );

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
    always_prefix: bool,
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
                if auto_routing && count > 1 && emitted_aggregated.insert(name.clone()) {
                    models.push(json!({
                        "id": name,
                        "object": "model",
                        "created": provider.created_at,
                        "owned_by": "aqbot",
                    }));
                }
                // Colliding names always keep a namespaced pin entry.
                let id = if always_prefix || count > 1 {
                    format!("{}/{}", public_id, name)
                } else {
                    name
                };
                models.push(json!({
                    "id": id,
                    "object": "model",
                    "created": provider.created_at,
                    "owned_by": provider.name,
                }));
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

const CHAT_COMPLETIONS_PATH: &str = "/v1/chat/completions";

/// Provider types `/v1/chat/completions` can route to.
///
/// Requests are translated through the provider adapter, so OpenAI Responses
/// providers are served by converting to and from the Responses API.
pub(crate) fn supports_chat_completions(provider_type: &ProviderType) -> bool {
    matches!(
        provider_type,
        ProviderType::OpenAI
            | ProviderType::OpenAIResponses
            | ProviderType::DeepSeek
            | ProviderType::XAI
            | ProviderType::GLM
            | ProviderType::SiliconFlow
            | ProviderType::Custom
    )
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
    // Public IDs are computed over all providers so they match `/v1/models`;
    // routing is then restricted to chat-completions-compatible provider types.
    let all_providers = match aqbot_core::repo::provider::list_providers(&state.db).await {
        Ok(p) => p,
        Err(e) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    };
    let public_id_map = build_provider_public_id_map(&all_providers);
    let known_public_ids: HashSet<String> = public_id_map.values().cloned().collect();
    let providers: Vec<ProviderConfig> = all_providers
        .iter()
        .filter(|p| supports_chat_completions(&p.provider_type))
        .cloned()
        .collect();

    // Parse model field: supports "provider_public_id/model_id" (preferred),
    // or bare "model_id" / alias.
    let parsed = parse_model_field(&request.model, &known_public_ids);

    let global_settings = aqbot_core::repo::settings::get_settings(&state.db)
        .await
        .unwrap_or_default();
    let auto_routing = global_settings.gateway_auto_model_routing;

    let targets = match resolve_route_targets(&providers, &public_id_map, &parsed, auto_routing)
        .map_err(|err| {
            explain_unsupported_provider(
                &all_providers,
                &public_id_map,
                &parsed,
                supports_chat_completions,
                CHAT_COMPLETIONS_PATH,
            )
            .unwrap_or(err)
        }) {
        Ok(t) => t,
        Err(err) => {
            record_route_failure(
                &state.db,
                &gateway_key,
                "POST",
                CHAT_COMPLETIONS_PATH,
                Some(&request.model),
                &err,
                start_time,
            )
            .await;
            return err.into_response();
        }
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
        let response_model = crate::response_model::response_model_name(
            global_settings.gateway_model_provider_prefix,
            &request.model,
            &model_id,
        );

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
                response_model.as_deref(),
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
            response_model.as_deref(),
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
                        CHAT_COMPLETIONS_PATH,
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
    response_model: Option<&str>,
    start_time: Instant,
) -> Result<axum::response::Response, String> {
    match adapter.chat(ctx, request).await {
        Ok(mut response) => {
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
                CHAT_COMPLETIONS_PATH,
                Some(model_id),
                Some(provider_id),
                200,
                elapsed,
                response.usage.prompt_tokens as i32,
                response.usage.completion_tokens as i32,
                None,
            )
            .await;

            if let Some(name) = response_model {
                response.model = name.to_string();
            }
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
    response_model: Option<&str>,
    start_time: Instant,
) -> axum::response::Response {
    let model_str = response_model.unwrap_or(model_id).to_string();
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
            CHAT_COMPLETIONS_PATH,
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

/// Base public-ID slug for a provider: the name slug, or the provider type when
/// the name has no ASCII alphanumerics (e.g. "深度求索" → `"deepseek"`).
fn provider_base_slug(provider: &ProviderConfig) -> String {
    let slug = provider_slug(&provider.name);
    if slug.is_empty() {
        provider_slug(provider_type_to_str(&provider.provider_type))
    } else {
        slug
    }
}

/// Build a `provider_internal_id → public_id` map for all enabled providers.
///
/// Always build it from the full provider list (not a protocol-filtered
/// subset) so the IDs shown by `/v1/models` resolve on every endpoint.
///
/// A provider's custom `gateway_prefix` wins when set and valid. Otherwise the
/// public ID is the base slug (see [`provider_base_slug`]).  When two or more
/// enabled providers share the same base slug (e.g. `"OpenAI"` and `"Open AI"`
/// both normalise to `"openai"`), a numeric suffix is appended (`-2`, `-3`, …)
/// in **internal-ID–sorted order**; IDs already taken by custom prefixes are
/// skipped, so the result is unique and deterministic.
pub fn build_provider_public_id_map(providers: &[ProviderConfig]) -> HashMap<String, String> {
    let mut enabled: Vec<&ProviderConfig> = providers.iter().filter(|p| p.enabled).collect();
    enabled.sort_by(|a, b| a.id.cmp(&b.id));

    let mut map = HashMap::new();
    let mut taken: HashSet<String> = HashSet::new();
    let mut slug_groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for p in enabled {
        let custom = p
            .gateway_prefix
            .as_deref()
            .filter(|prefix| aqbot_core::repo::provider::is_valid_gateway_prefix(prefix));
        match custom {
            Some(prefix) if taken.insert(prefix.to_string()) => {
                map.insert(p.id.clone(), prefix.to_string());
            }
            _ => slug_groups
                .entry(provider_base_slug(p))
                .or_default()
                .push(p.id.clone()),
        }
    }

    for (base_slug, ids) in slug_groups {
        let mut n = 1;
        for id in ids {
            let public_id = loop {
                let candidate = if n == 1 {
                    base_slug.clone()
                } else {
                    format!("{}-{}", base_slug, n)
                };
                n += 1;
                if taken.insert(candidate.clone()) {
                    break candidate;
                }
            };
            map.insert(id, public_id);
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
///    recognised when the left segment is a **known** public provider ID
///    (compared case-insensitively, e.g. `DeepSeek/deepseek-chat`).
///    This prevents misparsing native model IDs that contain `/` (e.g.
///    `"accounts/fireworks/models/qwen3"`).
/// 2. `model_id`                     — bare; resolved by unique match across providers
pub(crate) fn parse_model_field(model: &str, known_public_ids: &HashSet<String>) -> ParsedModel {
    if let Some((left, right)) = model.split_once('/') {
        // Public IDs are always lowercase ASCII slugs.
        let left = left.to_ascii_lowercase();
        if known_public_ids.contains(&left) {
            return ParsedModel {
                provider_hint: Some(left),
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
) -> Result<(ProviderConfig, String), RouteError> {
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
) -> Result<Vec<(ProviderConfig, String)>, RouteError> {
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
                RouteError::new(
                    StatusCode::NOT_FOUND,
                    format!("Provider '{}' not found", hint),
                )
            })?;

            let real_id = provider
                .models
                .iter()
                .filter(|m| m.enabled)
                .find_map(|m| resolve_real_model_id(m, &parsed.model_id))
                .ok_or_else(|| {
                    RouteError::new(
                        StatusCode::NOT_FOUND,
                        format!(
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
                return Err(RouteError::new(
                    StatusCode::NOT_FOUND,
                    format!("Model '{}' not found", parsed.model_id),
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
                return Err(RouteError::new(
                    StatusCode::NOT_FOUND,
                    format!("Model '{}' not found", parsed.model_id),
                ));
            }
            Ok(out)
        }
    }
}

/// A request that could not be routed to an upstream provider.
#[derive(Debug)]
pub(crate) struct RouteError {
    pub(crate) status: StatusCode,
    pub(crate) message: String,
}

impl RouteError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub(crate) fn into_response(self) -> axum::response::Response {
        error_response(self.status, &self.message)
    }
}

/// Explain a routing miss caused by an endpoint/provider-type mismatch.
///
/// Endpoints only route to the provider types they can serve, while public IDs
/// and `/v1/models` cover every provider.  When the requested provider (or the
/// bare model) belongs to an enabled provider this endpoint cannot serve, a
/// plain "not found" is misleading, so return a 400 that names the type.
pub(crate) fn explain_unsupported_provider(
    all_providers: &[ProviderConfig],
    public_id_map: &HashMap<String, String>,
    parsed: &ParsedModel,
    supports: impl Fn(&ProviderType) -> bool,
    endpoint: &str,
) -> Option<RouteError> {
    use crate::auto_route::resolve_real_model_id;

    let mut unsupported = all_providers
        .iter()
        .filter(|p| p.enabled && !supports(&p.provider_type));
    let provider = match &parsed.provider_hint {
        Some(hint) => unsupported.find(|p| public_id_map.get(&p.id) == Some(hint))?,
        None => unsupported.find(|p| {
            p.models
                .iter()
                .filter(|m| m.enabled)
                .any(|m| resolve_real_model_id(m, &parsed.model_id).is_some())
        })?,
    };

    let provider_type = provider_type_to_str(&provider.provider_type);
    let public_id = public_id_map
        .get(&provider.id)
        .map(String::as_str)
        .unwrap_or(provider.name.as_str());
    let mut message = format!(
        "Provider '{}' (type '{}') is not supported on {}",
        public_id, provider_type, endpoint
    );
    if let Some(native) = native_endpoint_for(&provider.provider_type) {
        message.push_str(&format!("; use {} instead", native));
    }
    Some(RouteError::new(StatusCode::BAD_REQUEST, message))
}

/// Gateway endpoint that serves a provider type natively, if any.
fn native_endpoint_for(provider_type: &ProviderType) -> Option<&'static str> {
    match provider_type {
        ProviderType::OpenAIResponses => Some("/v1/responses"),
        ProviderType::Anthropic => Some("/v1/messages"),
        ProviderType::Gemini => Some("/v1beta/models/{model}:generateContent"),
        ProviderType::OpenAI
        | ProviderType::DeepSeek
        | ProviderType::XAI
        | ProviderType::GLM
        | ProviderType::SiliconFlow
        | ProviderType::Custom => Some(CHAT_COMPLETIONS_PATH),
        ProviderType::Jina
        | ProviderType::Cohere
        | ProviderType::Voyage
        | ProviderType::Bedrock => None,
    }
}

/// Record a request that failed before reaching any upstream provider, so it
/// shows up in the gateway request log.
pub(crate) async fn record_route_failure(
    db: &sea_orm::DatabaseConnection,
    gateway_key: &GatewayKey,
    method: &str,
    path: &str,
    model: Option<&str>,
    err: &RouteError,
    start_time: Instant,
) {
    let _ = aqbot_core::repo::gateway_request_log::record_request_log(
        db,
        &gateway_key.id,
        &gateway_key.name,
        method,
        path,
        model,
        None,
        err.status.as_u16() as i32,
        start_time.elapsed().as_millis() as i32,
        0,
        0,
        Some(&err.message),
    )
    .await;
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
        path: String,
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
        let path = request.uri().path().to_string();
        let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
        state.captures.lock().unwrap().push(CapturedChatRequest {
            path,
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
        seed_chat_router(
            &[
                ("DeepSeek", ProviderType::DeepSeek),
                ("DeepSeek Backup", ProviderType::DeepSeek),
            ],
            api_host,
            "deepseek-v4-pro",
        )
        .await
    }

    /// Seed enabled providers that all serve `model_id` from `api_host`.
    async fn seed_chat_router(
        providers: &[(&str, ProviderType)],
        api_host: &str,
        model_id: &str,
    ) -> (Router, DbHandle, String, GatewayAppState) {
        let handle = create_test_pool().await.unwrap();
        let db = &handle.conn;
        let gateway_key = gateway::create_gateway_key(db, "Chat Test Key", None)
            .await
            .unwrap();
        let master_key = [7u8; 32];

        for (provider_name, provider_type) in providers {
            let provider = provider::create_provider(
                db,
                CreateProviderInput {
                    name: (*provider_name).into(),
                    provider_type: provider_type.clone(),
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
                    model_id: model_id.into(),
                    name: model_id.into(),
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
                    icon: None,
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

    #[test]
    fn test_parse_provider_prefix_case_insensitive() {
        let p = parse_model_field("DeepSeek/deepseek-chat", &known_ids(&["deepseek"]));
        assert_eq!(p.provider_hint.as_deref(), Some("deepseek"));
        assert_eq!(p.model_id, "deepseek-chat");
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

    #[test]
    fn test_public_id_map_non_ascii_name_falls_back_to_provider_type() {
        let mut providers = vec![
            make_provider("p1", "深度求索", &["deepseek-chat"]),
            make_provider("p2", "自定义一", &[]),
            make_provider("p3", "自定义二", &[]),
        ];
        providers[0].provider_type = ProviderType::DeepSeek;
        let map = build_provider_public_id_map(&providers);
        assert_eq!(map["p1"], "deepseek");
        assert_eq!(map["p2"], "custom");
        assert_eq!(map["p3"], "custom-2");
    }

    #[test]
    fn test_public_id_map_custom_prefix_wins() {
        let mut providers = vec![
            make_provider("p1", "DeepSeek", &["deepseek-chat"]),
            make_provider("p2", "OpenAI", &["gpt-4o"]),
        ];
        providers[0].gateway_prefix = Some("ds".into());
        let map = build_provider_public_id_map(&providers);
        assert_eq!(map["p1"], "ds");
        assert_eq!(map["p2"], "openai");

        let known: HashSet<String> = map.values().cloned().collect();
        let parsed = parse_model_field("ds/deepseek-chat", &known);
        let targets = resolve_route_targets(&providers, &map, &parsed, false).unwrap();
        assert_eq!(targets[0].0.id, "p1");
    }

    #[test]
    fn test_public_id_map_auto_slug_skips_custom_prefix() {
        let mut providers = vec![
            make_provider("p1", "OpenAI", &[]),
            make_provider("p2", "Other", &[]),
        ];
        providers[1].gateway_prefix = Some("openai".into());
        let map = build_provider_public_id_map(&providers);
        assert_eq!(map["p2"], "openai");
        assert_eq!(map["p1"], "openai-2");
    }

    #[test]
    fn test_public_id_map_invalid_or_duplicate_custom_prefix_falls_back() {
        let mut providers = vec![
            make_provider("p1", "Alpha", &[]),
            make_provider("p2", "Beta", &[]),
            make_provider("p3", "Gamma", &[]),
        ];
        providers[0].gateway_prefix = Some("shared".into());
        providers[1].gateway_prefix = Some("shared".into());
        providers[2].gateway_prefix = Some("Bad/Prefix".into());
        let map = build_provider_public_id_map(&providers);
        assert_eq!(map["p1"], "shared");
        assert_eq!(map["p2"], "beta");
        assert_eq!(map["p3"], "gamma");
    }

    #[test]
    fn test_public_id_map_suffix_never_collides_with_other_slug() {
        let providers = vec![
            make_provider("pa", "A Provider", &[]),
            make_provider("pb", "A Provider", &[]),
            make_provider("pc", "A Provider 2", &[]),
        ];
        let map = build_provider_public_id_map(&providers);
        let unique: HashSet<&String> = map.values().collect();
        assert_eq!(unique.len(), 3);
        assert_eq!(map["pa"], "a-provider");
        assert_eq!(map["pb"], "a-provider-2");
    }

    // ── build_gateway_model_list ──────────────────────────────────────────────

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
                    icon: None,
                })
                .collect(),
            keys: vec![],
            proxy_config: None,
            custom_headers: None,
            icon: None,
            builtin_id: None,
            gateway_prefix: None,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn list_ids(
        providers: &[ProviderConfig],
        auto_routing: bool,
        always_prefix: bool,
    ) -> Vec<String> {
        build_gateway_model_list(providers, auto_routing, always_prefix)
            .iter()
            .filter_map(|v| v["id"].as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn test_model_list_slug_collision_uses_deduplicated_public_id() {
        // "Open-AI" and "Open AI" → same base slug "open-ai".
        // p1 (id="p1") < p2 (id="p2") → p1 = "open-ai", p2 = "open-ai-2".
        let providers = vec![
            make_provider("p1", "Open-AI", &["gpt-4o", "shared-model"]),
            make_provider("p2", "Open AI", &["gpt-4", "shared-model"]),
        ];
        assert_eq!(
            list_ids(&providers, false, false),
            vec![
                "gpt-4",
                "gpt-4o",
                "open-ai-2/shared-model",
                "open-ai/shared-model",
            ]
        );
    }

    #[test]
    fn test_model_list_unique_models_bare() {
        let providers = vec![
            make_provider("p1", "OpenAI", &["gpt-4o", "gpt-3.5-turbo"]),
            make_provider("p2", "Anthropic", &["claude-3-opus"]),
        ];
        assert_eq!(
            list_ids(&providers, false, false),
            vec!["claude-3-opus", "gpt-3.5-turbo", "gpt-4o"]
        );
    }

    #[test]
    fn test_model_list_disabled_provider_excluded() {
        let mut providers = vec![
            make_provider("p1", "OpenAI", &["gpt-4o"]),
            make_provider("p2", "OtherAI", &["gpt-4o"]),
        ];
        // Disable p2 → no collision
        providers[1].enabled = false;
        assert_eq!(list_ids(&providers, false, false), vec!["gpt-4o"]);
    }

    #[test]
    fn test_model_list_always_prefix_namespaces_every_entry() {
        let mut providers = vec![
            make_provider("p1", "DeepSeek", &["deepseek-chat"]),
            make_provider("p2", "OpenAI", &["gpt-4o"]),
        ];
        providers[1].models[0].aliases = vec!["gpt".into()];
        assert_eq!(
            list_ids(&providers, false, true),
            vec!["deepseek/deepseek-chat", "openai/gpt", "openai/gpt-4o"]
        );
        let entries = build_gateway_model_list(&providers, false, true);
        assert_eq!(entries[0]["owned_by"], "DeepSeek");
    }

    #[test]
    fn test_model_list_always_prefix_keeps_aggregated_entry_when_auto_routing() {
        let providers = vec![
            make_provider("p1", "OpenAI", &["gpt-5.5", "gpt-4o"]),
            make_provider("p2", "OtherAI", &["gpt-5.5"]),
        ];
        assert_eq!(
            list_ids(&providers, true, true),
            vec![
                "gpt-5.5",
                "openai/gpt-4o",
                "openai/gpt-5.5",
                "otherai/gpt-5.5",
            ]
        );
    }

    #[test]
    fn test_model_list_always_prefix_ids_resolve() {
        let providers = vec![
            make_provider("p1", "OpenAI", &["gpt-4o"]),
            make_provider("p2", "深度求索", &["deepseek-chat"]),
        ];
        let map = build_provider_public_id_map(&providers);
        let known: HashSet<String> = map.values().cloned().collect();
        for id in list_ids(&providers, false, true) {
            let parsed = parse_model_field(&id, &known);
            assert!(parsed.provider_hint.is_some(), "{id} should be namespaced");
            let targets = resolve_route_targets(&providers, &map, &parsed, false)
                .unwrap_or_else(|_| panic!("{id} should resolve"));
            assert_eq!(targets.len(), 1);
        }
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
        let off = build_gateway_model_list(&providers, false, false);
        let off_ids: Vec<&str> = off.iter().filter_map(|v| v["id"].as_str()).collect();
        assert!(off_ids.iter().all(|id| id.contains('/')));

        let on = build_gateway_model_list(&providers, true, false);
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
    async fn chat_completions_echoes_requested_model_in_prefix_mode() {
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
        let (upstream_base, _captures, upstream_task) =
            spawn_mock_chat_upstream(headers, upstream_body).await;
        let (app, handle, gateway_key, _) =
            seed_chat_router_with_duplicate_model(&upstream_base).await;

        let send = |app: Router| {
            let gateway_key = gateway_key.clone();
            async move {
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
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                serde_json::from_slice::<serde_json::Value>(&body).unwrap()
            }
        };

        let off = send(app.clone()).await;
        assert_eq!(off["model"], "deepseek-v4-pro");

        crate::response_model::enable_provider_prefix_mode(&handle.conn).await;
        let on = send(app).await;
        assert_eq!(on["model"], "deepseek/deepseek-v4-pro");

        upstream_task.abort();
    }

    #[tokio::test]
    async fn chat_completions_stream_echoes_requested_model_in_prefix_mode() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
        let upstream_body = concat!(
            "data: {\"id\":\"chatcmpl-upstream\",\"object\":\"chat.completion.chunk\",\"model\":\"deepseek-v4-pro\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
            "data: [DONE]\n\n"
        )
        .to_string();
        let (upstream_base, _captures, upstream_task) =
            spawn_mock_chat_upstream(headers, upstream_body).await;
        let (app, handle, gateway_key, _) =
            seed_chat_router_with_duplicate_model(&upstream_base).await;
        crate::response_model::enable_provider_prefix_mode(&handle.conn).await;

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
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        let models: Vec<String> = text
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str::<serde_json::Value>(data).ok())
            .filter_map(|value| value["model"].as_str().map(str::to_string))
            .collect();
        assert!(!models.is_empty(), "no model fields in stream: {text}");
        assert!(models.iter().all(|m| m == "deepseek/deepseek-v4-pro"));

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

    #[tokio::test]
    async fn chat_completions_accepts_null_assistant_content_with_tool_calls() {
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
        // `stream` is omitted on purpose: OpenAI treats it as optional.
        let request_body = json!({
            "model": "deepseek/deepseek-v4-pro",
            "messages": [
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "get_time", "arguments": "{}" }
                    }]
                },
                { "role": "tool", "tool_call_id": "call_1", "content": "1700000000" }
            ]
        })
        .to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/chat/completions")
                    .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(request_body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let upstream_messages = &captured[0].body["messages"];
        assert_eq!(upstream_messages[0]["role"], "assistant");
        assert!(upstream_messages[0]["content"].is_null());
        assert_eq!(upstream_messages[0]["tool_calls"][0]["id"], "call_1");
        assert_eq!(upstream_messages[1]["tool_call_id"], "call_1");

        upstream_task.abort();
    }

    // ── Provider-type support (issue #233) ────────────────────────────────────

    fn post_json(uri: &str, gateway_key: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn response_json(response: axum::response::Response) -> serde_json::Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[test]
    fn supports_chat_completions_covers_openai_responses() {
        assert!(supports_chat_completions(&ProviderType::OpenAIResponses));
        assert!(supports_chat_completions(&ProviderType::OpenAI));
        assert!(!supports_chat_completions(&ProviderType::Anthropic));
        assert!(!supports_chat_completions(&ProviderType::Gemini));
    }

    #[tokio::test]
    async fn chat_completions_routes_openai_responses_provider_non_stream() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let upstream_body = json!({
            "id": "resp_upstream",
            "model": "mimo-v2.6-flash",
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": "ok" }]
            }],
            "usage": { "input_tokens": 3, "output_tokens": 2, "total_tokens": 5 }
        })
        .to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_chat_upstream(headers, upstream_body).await;
        let (app, _handle, gateway_key, _) = seed_chat_router(
            &[("小米Mimo", ProviderType::OpenAIResponses)],
            &upstream_base,
            "mimo-v2.6-flash",
        )
        .await;

        let response = app
            .oneshot(post_json(
                "/v1/chat/completions",
                &gateway_key,
                json!({
                    "model": "mimo/mimo-v2.6-flash",
                    "messages": [{ "role": "user", "content": "hi" }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = response_json(response).await;
        assert_eq!(payload["object"], "chat.completion");
        assert_eq!(payload["choices"][0]["message"]["content"], "ok");
        assert_eq!(payload["usage"]["total_tokens"], 5);

        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert!(
            captured[0].path.ends_with("/responses"),
            "{}",
            captured[0].path
        );
        assert_eq!(captured[0].body["model"], "mimo-v2.6-flash");
        assert!(captured[0].body.get("input").is_some());

        upstream_task.abort();
    }

    #[tokio::test]
    async fn chat_completions_routes_openai_responses_provider_stream() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
        let upstream_body = concat!(
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_upstream\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}],\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n"
        )
        .to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_chat_upstream(headers, upstream_body).await;
        let (app, _handle, gateway_key, _) = seed_chat_router(
            &[("小米Mimo", ProviderType::OpenAIResponses)],
            &upstream_base,
            "mimo-v2.6-flash",
        )
        .await;

        let response = app
            .oneshot(post_json(
                "/v1/chat/completions",
                &gateway_key,
                json!({
                    "model": "mimo/mimo-v2.6-flash",
                    "messages": [{ "role": "user", "content": "hi" }],
                    "stream": true
                }),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        let chunks: Vec<serde_json::Value> = text
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str(data).ok())
            .collect();
        let content: String = chunks
            .iter()
            .filter_map(|chunk| chunk["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert_eq!(content, "ok", "stream: {text}");
        assert!(chunks
            .iter()
            .any(|chunk| chunk["choices"][0]["finish_reason"] == "stop"));

        let captured = captures.lock().unwrap();
        assert!(
            captured[0].path.ends_with("/responses"),
            "{}",
            captured[0].path
        );
        assert_eq!(captured[0].body["stream"], true);

        upstream_task.abort();
    }

    #[tokio::test]
    async fn chat_completions_explains_unsupported_provider_type_and_logs_it() {
        let (app, handle, gateway_key, _) = seed_chat_router(
            &[("Claude", ProviderType::Anthropic)],
            "http://127.0.0.1:9",
            "claude-x",
        )
        .await;

        for model in ["claude/claude-x", "claude-x"] {
            let response = app
                .clone()
                .oneshot(post_json(
                    "/v1/chat/completions",
                    &gateway_key,
                    json!({ "model": model, "messages": [{ "role": "user", "content": "hi" }] }),
                ))
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "model {model}");
            let message = response_json(response).await["error"]["message"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(message.contains("'claude'"), "{message}");
            assert!(message.contains("type 'anthropic'"), "{message}");
            assert!(message.contains("use /v1/messages"), "{message}");
        }

        let logs = aqbot_core::repo::gateway_request_log::list_request_logs(&handle.conn, 10, 0)
            .await
            .unwrap();
        assert_eq!(logs.len(), 2);
        assert!(logs.iter().all(|log| log.status_code == 400
            && log.path == "/v1/chat/completions"
            && log.provider_id.is_none()
            && log
                .error_message
                .as_deref()
                .is_some_and(|m| m.contains("anthropic"))));
        let mut models: Vec<_> = logs.iter().filter_map(|log| log.model.clone()).collect();
        models.sort();
        assert_eq!(models, ["claude-x", "claude/claude-x"]);
    }

    #[tokio::test]
    async fn chat_completions_logs_unknown_model() {
        let (app, handle, gateway_key, _) =
            seed_chat_router_with_duplicate_model("http://127.0.0.1:9").await;

        let response = app
            .oneshot(post_json(
                "/v1/chat/completions",
                &gateway_key,
                json!({ "model": "missing-model", "messages": [{ "role": "user", "content": "hi" }] }),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let logs = aqbot_core::repo::gateway_request_log::list_request_logs(&handle.conn, 10, 0)
            .await
            .unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].status_code, 404);
        assert_eq!(logs[0].model.as_deref(), Some("missing-model"));
    }

    #[tokio::test]
    async fn native_messages_explains_unsupported_provider_type() {
        let (app, handle, gateway_key, _) = seed_chat_router(
            &[
                ("Claude", ProviderType::Anthropic),
                ("DeepSeek", ProviderType::DeepSeek),
            ],
            "http://127.0.0.1:9",
            "shared-model",
        )
        .await;

        let response = app
            .oneshot(post_json(
                "/v1/messages",
                &gateway_key,
                json!({
                    "model": "deepseek/shared-model",
                    "max_tokens": 16,
                    "messages": [{ "role": "user", "content": "hi" }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let message = response_json(response).await["error"]["message"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            message.contains("not supported on /v1/messages"),
            "{message}"
        );
        assert!(message.contains("use /v1/chat/completions"), "{message}");

        let logs = aqbot_core::repo::gateway_request_log::list_request_logs(&handle.conn, 10, 0)
            .await
            .unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].path, "/v1/messages");
        assert_eq!(logs[0].status_code, 400);
    }
}
