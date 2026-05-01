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
/// Model IDs are emitted as plain `model_id` when globally unique across all
/// enabled providers, or as `provider_slug/model_id` when the same `model_id`
/// exists on more than one enabled provider (collision).  The legacy
/// `provider_uuid:model_id` format is **no longer emitted**.
///
/// Results are sorted deterministically: primary key is the displayed model ID
/// (lexicographic), secondary key is the provider name (tiebreaker for the rare
/// case of identical display IDs across multiple providers).
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

    let display_map = build_model_display_map(&providers);

    let mut models: Vec<serde_json::Value> = Vec::new();
    for provider in providers.iter().filter(|p| p.enabled) {
        for model in provider.models.iter().filter(|m| m.enabled) {
            let key = (provider.id.clone(), model.model_id.clone());
            let display_id = display_map
                .get(&key)
                .cloned()
                .unwrap_or_else(|| model.model_id.clone());
            models.push(json!({
                "id": display_id,
                "object": "model",
                "created": provider.created_at,
                "owned_by": provider.name,
            }));
        }
    }

    // Deterministic ordering: display ID first, provider name as tiebreaker.
    models.sort_by(|a, b| {
        let id_a = a["id"].as_str().unwrap_or("");
        let id_b = b["id"].as_str().unwrap_or("");
        let ob_a = a["owned_by"].as_str().unwrap_or("");
        let ob_b = b["owned_by"].as_str().unwrap_or("");
        id_a.cmp(id_b).then(ob_a.cmp(ob_b))
    });

    Json(json!({
        "object": "list",
        "data": models,
    }))
    .into_response()
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
                .filter(|p| matches!(p.provider_type, ProviderType::OpenAI | ProviderType::Custom))
                .collect(),
            Err(e) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
            }
        };
    let public_id_map = build_provider_public_id_map(&providers);
    let known_public_ids: HashSet<String> = public_id_map.values().cloned().collect();

    // Parse model field: supports "provider_public_id/model_id" (preferred),
    // legacy "provider_id:model_id" (compat), or bare "model_id".
    let parsed = parse_model_field(&request.model, &known_public_ids);

    // Resolve the provider and canonical model_id.
    let (provider, model_id) = match resolve_provider_for_model(&providers, &public_id_map, &parsed)
    {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };

    // Get active key and decrypt
    let provider_key =
        match aqbot_core::repo::provider::get_active_key(&state.db, &provider.id).await {
            Ok(k) => k,
            Err(_) => {
                return error_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("No active API key for provider '{}'", provider.name),
                );
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

    let global_settings = aqbot_core::repo::settings::get_settings(&state.db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    let ctx = ProviderRequestContext {
        api_key,
        key_id: provider_key.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(&provider.api_host, &provider.provider_type)),
        api_path: provider.api_path.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    let registry = aqbot_providers::registry::ProviderRegistry::create_default();
    let adapter = match registry.get(provider_type_str) {
        Some(a) => a,
        None => {
            // Fallback to openai-compatible for custom providers
            match registry.get("openai") {
                Some(a) => a,
                None => {
                    return error_response(
                        StatusCode::BAD_GATEWAY,
                        &format!("No adapter for provider type '{}'", provider_type_str),
                    );
                }
            }
        }
    };

    if request.stream {
        handle_stream(
            adapter,
            &ctx,
            request,
            &state,
            &gateway_key,
            &provider.id,
            &model_id,
            start_time,
        )
        .await
    } else {
        handle_non_stream(
            adapter,
            &ctx,
            request,
            &state,
            &gateway_key,
            &provider.id,
            &model_id,
            start_time,
        )
        .await
    }
}

async fn handle_non_stream(
    adapter: &dyn ProviderAdapter,
    ctx: &ProviderRequestContext,
    request: ChatRequest,
    state: &GatewayAppState,
    gateway_key: &GatewayKey,
    provider_id: &str,
    model_id: &str,
    start_time: Instant,
) -> axum::response::Response {
    match adapter.chat(ctx, request).await {
        Ok(response) => {
            // Record usage
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

            Json(build_non_stream_response_body(&response)).into_response()
        }
        Err(e) => {
            let elapsed = start_time.elapsed().as_millis() as i32;
            let _ = aqbot_core::repo::gateway_request_log::record_request_log(
                &state.db,
                &gateway_key.id,
                &gateway_key.name,
                "POST",
                "/v1/chat/completions",
                Some(model_id),
                Some(provider_id),
                502,
                elapsed,
                0,
                0,
                Some(&e.to_string()),
            )
            .await;

            error_response(StatusCode::BAD_GATEWAY, &e.to_string())
        }
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
        let mut stream_error: Option<String> = None;

        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    if let Some(usage) = &chunk.usage {
                        total_prompt = usage.prompt_tokens;
                        total_completion = usage.completion_tokens;
                    }

                    if chunk.done {
                        // Send final chunk
                        let data = build_stream_final_response_body(
                            &model_str,
                            total_prompt,
                            total_completion,
                        );
                        let _ = tx.send(Ok(Event::default().data(data.to_string()))).await;
                        let _ = tx.send(Ok(Event::default().data("[DONE]"))).await;
                        break;
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
    prompt_tokens: u32,
    completion_tokens: u32,
) -> serde_json::Value {
    json!({
        "id": "chatcmpl-gateway",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }
    })
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

/// Resolve the `ProviderConfig` and canonical `model_id` string from a parsed
/// model field.
///
/// - Slug hint (`/`): match enabled provider by its public ID (from the map),
///   verify model exists.
/// - No hint: scan all enabled providers for an enabled model with that ID;
///   succeed only when exactly one provider has it — otherwise error with a
///   helpful message asking the caller to use the `provider/model` form.
pub(crate) fn resolve_provider_for_model(
    providers: &[ProviderConfig],
    public_id_map: &HashMap<String, String>,
    parsed: &ParsedModel,
) -> Result<(ProviderConfig, String), axum::response::Response> {
    let enabled: Vec<&ProviderConfig> = providers.iter().filter(|p| p.enabled).collect();

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

            if !provider
                .models
                .iter()
                .any(|m| m.enabled && m.model_id == parsed.model_id)
            {
                return Err(error_response(
                    StatusCode::NOT_FOUND,
                    &format!(
                        "Model '{}' not found on provider '{}'",
                        parsed.model_id, hint
                    ),
                ));
            }

            Ok(((*provider).clone(), parsed.model_id.clone()))
        }
        None => {
            // Bare model_id: find matching enabled providers.
            let matching: Vec<&&ProviderConfig> = enabled
                .iter()
                .filter(|p| {
                    p.models
                        .iter()
                        .any(|m| m.enabled && m.model_id == parsed.model_id)
                })
                .collect();

            match matching.len() {
                0 => Err(error_response(
                    StatusCode::NOT_FOUND,
                    &format!("Model '{}' not found", parsed.model_id),
                )),
                _ => Ok(((*matching[0]).clone(), parsed.model_id.clone())),
            }
        }
    }
}

pub(crate) fn provider_type_to_str(pt: &ProviderType) -> &'static str {
    match pt {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Custom => "openai", // custom providers use OpenAI-compatible API
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
                    max_tokens: None,
                    enabled: true,
                    param_overrides: None,
                })
                .collect(),
            keys: vec![],
            proxy_config: None,
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
            },
        )
        .expect("chunk payload");

        assert_eq!(
            payload["choices"][0]["delta"]["reasoning_content"],
            json!("step-by-step")
        );
    }
}
