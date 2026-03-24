use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Extension, Path, Request, State},
    http::{header, HeaderMap, HeaderName, Method, StatusCode},
    response::IntoResponse,
};
use aqbot_core::{
    crypto::decrypt_key,
    types::{GatewayKey, ProviderConfig, ProviderProxyConfig, ProviderType, TokenUsage},
};
use aqbot_providers::{build_http_client, ProviderRequestContext};
use futures::StreamExt;
use std::{convert::Infallible, time::Instant};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    auth::AuthenticatedKey,
    handlers::{
        build_provider_public_id_map, error_response, parse_model_field,
        resolve_provider_for_model,
    },
    server::GatewayAppState,
};

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeProtocol {
    OpenAiResponses,
    AnthropicMessages,
    AnthropicCountTokens,
    GeminiModels,
    GeminiGenerateContent,
    GeminiStreamGenerateContent,
    GeminiCountTokens,
}

impl NativeProtocol {
    fn provider_family(self) -> &'static str {
        match self {
            NativeProtocol::OpenAiResponses => "OpenAI-compatible",
            NativeProtocol::AnthropicMessages | NativeProtocol::AnthropicCountTokens => {
                "Anthropic"
            }
            NativeProtocol::GeminiModels
            | NativeProtocol::GeminiGenerateContent
            | NativeProtocol::GeminiStreamGenerateContent
            | NativeProtocol::GeminiCountTokens => "Gemini",
        }
    }

    fn matches_provider_type(self, provider_type: &ProviderType) -> bool {
        match self {
            NativeProtocol::OpenAiResponses => {
                matches!(provider_type, &ProviderType::OpenAI | &ProviderType::Custom)
            }
            NativeProtocol::AnthropicMessages | NativeProtocol::AnthropicCountTokens => {
                matches!(provider_type, &ProviderType::Anthropic)
            }
            NativeProtocol::GeminiModels
            | NativeProtocol::GeminiGenerateContent
            | NativeProtocol::GeminiStreamGenerateContent
            | NativeProtocol::GeminiCountTokens => matches!(provider_type, &ProviderType::Gemini),
        }
    }

    fn aggregates_usage(self) -> bool {
        matches!(
            self,
            NativeProtocol::OpenAiResponses
                | NativeProtocol::AnthropicMessages
                | NativeProtocol::GeminiGenerateContent
                | NativeProtocol::GeminiStreamGenerateContent
        )
    }

    fn usage_from_body(self, value: &serde_json::Value) -> Option<TokenUsage> {
        match self {
            NativeProtocol::OpenAiResponses => extract_openai_response_usage(value),
            NativeProtocol::AnthropicMessages => extract_anthropic_message_usage(value),
            NativeProtocol::AnthropicCountTokens => extract_anthropic_count_tokens_usage(value),
            NativeProtocol::GeminiGenerateContent | NativeProtocol::GeminiStreamGenerateContent => {
                extract_gemini_generate_content_usage(value)
            }
            NativeProtocol::GeminiCountTokens => extract_gemini_count_tokens_usage(value),
            NativeProtocol::GeminiModels => None,
        }
    }

    fn stream_observer(self) -> StreamUsageObserver {
        match self {
            NativeProtocol::OpenAiResponses => {
                StreamUsageObserver::OpenAiResponses(OpenAiResponsesStreamState::default())
            }
            NativeProtocol::AnthropicMessages => {
                StreamUsageObserver::AnthropicMessages(AnthropicMessagesStreamState::default())
            }
            NativeProtocol::GeminiStreamGenerateContent => {
                StreamUsageObserver::Gemini(GeminiStreamState::default())
            }
            _ => StreamUsageObserver::None,
        }
    }

    fn upstream_path(self, gemini_model: Option<&str>) -> Result<String, axum::response::Response> {
        match self {
            NativeProtocol::OpenAiResponses => Ok("/v1/responses".to_string()),
            NativeProtocol::AnthropicMessages => Ok("/v1/messages".to_string()),
            NativeProtocol::AnthropicCountTokens => Ok("/v1/messages/count_tokens".to_string()),
            NativeProtocol::GeminiModels => Ok("/v1beta/models".to_string()),
            NativeProtocol::GeminiGenerateContent => Ok(format!(
                "/v1beta/models/{}:generateContent",
                gemini_model.ok_or_else(|| {
                    error_response(StatusCode::BAD_REQUEST, "Missing Gemini model path")
                })?
            )),
            NativeProtocol::GeminiStreamGenerateContent => Ok(format!(
                "/v1beta/models/{}:streamGenerateContent",
                gemini_model.ok_or_else(|| {
                    error_response(StatusCode::BAD_REQUEST, "Missing Gemini model path")
                })?
            )),
            NativeProtocol::GeminiCountTokens => Ok(format!(
                "/v1beta/models/{}:countTokens",
                gemini_model.ok_or_else(|| {
                    error_response(StatusCode::BAD_REQUEST, "Missing Gemini model path")
                })?
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GeminiOperation {
    GenerateContent,
    StreamGenerateContent,
    CountTokens,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedGeminiModelAction {
    model: String,
    operation: GeminiOperation,
}

#[derive(Debug)]
struct ResolvedNativeContext {
    provider: ProviderConfig,
    request_ctx: ProviderRequestContext,
    model_id: Option<String>,
}

#[derive(Debug, Default)]
struct OpenAiResponsesStreamState {
    usage: Option<TokenUsage>,
}

impl OpenAiResponsesStreamState {
    fn observe_sse_line(&mut self, line: &str) {
        if let Some(value) = parse_sse_json_line(line) {
            if value.get("type").and_then(|v| v.as_str()) == Some("response.completed") {
                self.usage = extract_openai_response_usage(&value);
            }
        }
    }

    fn usage(&self) -> Option<TokenUsage> {
        self.usage.clone()
    }
}

#[derive(Debug, Default)]
struct AnthropicMessagesStreamState {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
}

impl AnthropicMessagesStreamState {
    fn observe_sse_line(&mut self, line: &str) {
        let Some(value) = parse_sse_json_line(line) else {
            return;
        };

        match value.get("type").and_then(|v| v.as_str()) {
            Some("message_start") => {
                self.prompt_tokens = value
                    .get("message")
                    .and_then(|message| message.get("usage"))
                    .and_then(|usage| usage.get("input_tokens"))
                    .and_then(|value| value.as_u64())
                    .map(|value| value as u32);
            }
            Some("message_delta") => {
                self.completion_tokens = value
                    .get("usage")
                    .and_then(|usage| usage.get("output_tokens"))
                    .and_then(|value| value.as_u64())
                    .map(|value| value as u32);
            }
            _ => {}
        }
    }

    fn usage(&self) -> Option<TokenUsage> {
        let prompt_tokens = self.prompt_tokens?;
        let completion_tokens = self.completion_tokens.unwrap_or(0);
        Some(TokenUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens + completion_tokens,
        })
    }
}

#[derive(Debug, Default)]
struct GeminiStreamState {
    usage: Option<TokenUsage>,
}

impl GeminiStreamState {
    fn observe_sse_line(&mut self, line: &str) {
        if let Some(value) = parse_sse_json_line(line) {
            self.usage = extract_gemini_generate_content_usage(&value).or(self.usage.clone());
        }
    }

    fn usage(&self) -> Option<TokenUsage> {
        self.usage.clone()
    }
}

enum StreamUsageObserver {
    None,
    OpenAiResponses(OpenAiResponsesStreamState),
    AnthropicMessages(AnthropicMessagesStreamState),
    Gemini(GeminiStreamState),
}

impl StreamUsageObserver {
    fn observe_line(&mut self, line: &str) {
        match self {
            StreamUsageObserver::None => {}
            StreamUsageObserver::OpenAiResponses(state) => state.observe_sse_line(line),
            StreamUsageObserver::AnthropicMessages(state) => state.observe_sse_line(line),
            StreamUsageObserver::Gemini(state) => state.observe_sse_line(line),
        }
    }

    fn usage(&self) -> Option<TokenUsage> {
        match self {
            StreamUsageObserver::None => None,
            StreamUsageObserver::OpenAiResponses(state) => state.usage(),
            StreamUsageObserver::AnthropicMessages(state) => state.usage(),
            StreamUsageObserver::Gemini(state) => state.usage(),
        }
    }
}

fn parse_gemini_model_action(model_action: &str) -> Option<ParsedGeminiModelAction> {
    let (model, action) = model_action.rsplit_once(':')?;
    let operation = match action {
        "generateContent" => GeminiOperation::GenerateContent,
        "streamGenerateContent" => GeminiOperation::StreamGenerateContent,
        "countTokens" => GeminiOperation::CountTokens,
        _ => return None,
    };

    Some(ParsedGeminiModelAction {
        model: model.to_string(),
        operation,
    })
}

fn parse_sse_json_line(line: &str) -> Option<serde_json::Value> {
    let data = if let Some(value) = line.strip_prefix("data: ") {
        value
    } else if let Some(value) = line.strip_prefix("data:") {
        value
    } else {
        return None;
    };

    if data == "[DONE]" {
        return None;
    }

    serde_json::from_str(data).ok()
}

fn extract_openai_response_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    let usage = value
        .get("usage")
        .or_else(|| value.get("response").and_then(|response| response.get("usage")))?;

    let prompt_tokens = usage.get("input_tokens")?.as_u64()? as u32;
    let completion_tokens = usage.get("output_tokens")?.as_u64()? as u32;
    let total_tokens = usage
        .get("total_tokens")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
        .unwrap_or(prompt_tokens + completion_tokens);

    Some(TokenUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
    })
}

fn extract_anthropic_message_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    let usage = value.get("usage")?;
    let prompt_tokens = usage.get("input_tokens")?.as_u64()? as u32;
    let completion_tokens = usage.get("output_tokens")?.as_u64()? as u32;

    Some(TokenUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
    })
}

fn extract_anthropic_count_tokens_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    let prompt_tokens = value.get("input_tokens")?.as_u64()? as u32;
    Some(TokenUsage {
        prompt_tokens,
        completion_tokens: 0,
        total_tokens: prompt_tokens,
    })
}

fn extract_gemini_generate_content_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    let usage = value.get("usageMetadata")?;
    let prompt_tokens = usage.get("promptTokenCount")?.as_u64()? as u32;
    let completion_tokens = usage.get("candidatesTokenCount")?.as_u64()? as u32;
    let total_tokens = usage
        .get("totalTokenCount")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
        .unwrap_or(prompt_tokens + completion_tokens);

    Some(TokenUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
    })
}

fn extract_gemini_count_tokens_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    let prompt_tokens = value.get("totalTokens")?.as_u64()? as u32;
    Some(TokenUsage {
        prompt_tokens,
        completion_tokens: 0,
        total_tokens: prompt_tokens,
    })
}

fn split_url_origin_and_path(url: &str) -> (&str, &str) {
    if let Some(scheme_idx) = url.find("://") {
        let authority_start = scheme_idx + 3;
        if let Some(path_idx) = url[authority_start..].find('/') {
            let split_idx = authority_start + path_idx;
            (&url[..split_idx], &url[split_idx..])
        } else {
            (url, "")
        }
    } else if let Some(path_idx) = url.find('/') {
        (&url[..path_idx], &url[path_idx..])
    } else {
        (url, "")
    }
}

fn join_upstream_base_and_path(base_url: &str, path: &str) -> String {
    let trimmed_base = base_url.trim_end_matches('/');
    let (origin, base_path) = split_url_origin_and_path(trimmed_base);

    if !base_path.is_empty() {
        let base_prefix = format!("{base_path}/");
        if path == base_path || path.starts_with(&base_prefix) {
            return format!("{origin}{path}");
        }
    }

    format!("{trimmed_base}{path}")
}

fn should_forward_request_header(name: &HeaderName) -> bool {
    !matches!(name.as_str(), "authorization" | "host" | "content-length")
}

fn should_copy_response_header(name: &HeaderName) -> bool {
    !matches!(name.as_str(), "content-length" | "connection" | "transfer-encoding")
}

fn extract_model_from_body(
    body_json: Option<&serde_json::Value>,
    protocol: NativeProtocol,
) -> Result<String, axum::response::Response> {
    body_json
        .and_then(|value| value.get("model"))
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            error_response(
                StatusCode::BAD_REQUEST,
                &format!(
                    "{} request must include a string model field",
                    protocol.provider_family()
                ),
            )
        })
}

fn build_upstream_url(
    base_url: &str,
    path: &str,
    query: Option<&str>,
    protocol: NativeProtocol,
    api_key: &str,
) -> String {
    let mut url = join_upstream_base_and_path(base_url, path);
    if let Some(query) = query.filter(|value| !value.is_empty()) {
        url.push('?');
        url.push_str(query);
    }
    if matches!(
        protocol,
        NativeProtocol::GeminiModels
            | NativeProtocol::GeminiGenerateContent
            | NativeProtocol::GeminiStreamGenerateContent
            | NativeProtocol::GeminiCountTokens
    ) {
        if url.contains('?') {
            url.push('&');
        } else {
            url.push('?');
        }
        url.push_str("key=");
        url.push_str(api_key);
    }
    url
}

fn build_passthrough_response(
    status: StatusCode,
    headers: &HeaderMap,
    body: Body,
) -> axum::response::Response {
    let mut response = axum::response::Response::builder().status(status);
    for (name, value) in headers.iter() {
        if should_copy_response_header(name) {
            response = response.header(name, value);
        }
    }
    response.body(body).unwrap_or_else(|_| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to build proxied response",
        )
    })
}

fn observe_sse_chunk(buffer: &mut String, bytes: &Bytes, observer: &mut StreamUsageObserver) {
    buffer.push_str(&String::from_utf8_lossy(bytes));
    while let Some(pos) = buffer.find('\n') {
        let line = buffer[..pos].trim_end().to_string();
        *buffer = buffer[pos + 1..].to_string();
        observer.observe_line(&line);
    }
}

async fn resolve_native_context(
    state: &GatewayAppState,
    protocol: NativeProtocol,
    model: Option<&str>,
) -> Result<ResolvedNativeContext, axum::response::Response> {
    let providers = aqbot_core::repo::provider::list_providers(&state.db)
        .await
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let candidates: Vec<ProviderConfig> = providers
        .into_iter()
        .filter(|provider| provider.enabled && protocol.matches_provider_type(&provider.provider_type))
        .collect();

    if candidates.is_empty() {
        return Err(error_response(
            StatusCode::BAD_GATEWAY,
            &format!("No enabled {} provider is configured", protocol.provider_family()),
        ));
    }

    let (provider, model_id) = if let Some(model) = model {
        let public_id_map = build_provider_public_id_map(&candidates);
        let known_public_ids = public_id_map.values().cloned().collect();
        let parsed = parse_model_field(model, &known_public_ids);
        if parsed.provider_hint.is_some() {
            let (provider, resolved_model_id) =
                resolve_provider_for_model(&candidates, &public_id_map, &parsed)?;
            (provider, Some(resolved_model_id))
        } else {
            let matching: Vec<&ProviderConfig> = candidates
                .iter()
                .filter(|provider| {
                    provider
                        .models
                        .iter()
                        .any(|model| model.enabled && model.model_id == parsed.model_id)
                })
                .collect();
            let fallback = matching.first().ok_or_else(|| {
                error_response(
                    StatusCode::NOT_FOUND,
                    &format!("Model '{}' not found", parsed.model_id),
                )
            })?;
            let mut preferred_provider = None;
            for provider in &matching {
                if aqbot_core::repo::provider::get_active_key(&state.db, &provider.id)
                    .await
                    .is_ok()
                {
                    preferred_provider = Some((*provider).clone());
                    break;
                }
            }
            (
                preferred_provider.unwrap_or_else(|| (*fallback).clone()),
                Some(parsed.model_id),
            )
        }
    } else {
        (candidates[0].clone(), None)
    };

    let provider_key = aqbot_core::repo::provider::get_active_key(&state.db, &provider.id)
        .await
        .map_err(|_| {
            error_response(
                StatusCode::BAD_GATEWAY,
                &format!("No active API key for provider '{}'", provider.name),
            )
        })?;
    let api_key = decrypt_key(&provider_key.key_encrypted, &state.master_key).map_err(|e| {
        tracing::error!("Failed to decrypt provider key: {}", e);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal key error")
    })?;

    let global_settings = aqbot_core::repo::settings::get_settings(&state.db)
        .await
        .unwrap_or_default();
    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);

    Ok(ResolvedNativeContext {
        provider: provider.clone(),
        request_ctx: ProviderRequestContext {
            api_key,
            key_id: provider_key.id.clone(),
            provider_id: provider.id.clone(),
            base_url: Some(provider.api_host.clone()),
            proxy_config: resolved_proxy,
        },
        model_id,
    })
}

async fn record_native_outcome(
    db: &sea_orm::DatabaseConnection,
    gateway_key: &GatewayKey,
    provider_id: &str,
    model_id: Option<&str>,
    method: &Method,
    path: &str,
    status_code: i32,
    start_time: Instant,
    usage: Option<&TokenUsage>,
    error_message: Option<&str>,
    aggregate_usage: bool,
) {
    if aggregate_usage && status_code < 400 {
        if let Some(usage) = usage {
            let _ = aqbot_core::repo::gateway::record_usage(
                db,
                &gateway_key.id,
                provider_id,
                model_id,
                usage.prompt_tokens as u64,
                usage.completion_tokens as u64,
            )
            .await;
        }
    }

    let elapsed = start_time.elapsed().as_millis() as i32;
    let request_tokens = usage.map(|usage| usage.prompt_tokens as i32).unwrap_or(0);
    let response_tokens = usage
        .map(|usage| usage.completion_tokens as i32)
        .unwrap_or(0);
    let _ = aqbot_core::repo::gateway_request_log::record_request_log(
        db,
        &gateway_key.id,
        &gateway_key.name,
        method.as_str(),
        path,
        model_id,
        Some(provider_id),
        status_code,
        elapsed,
        request_tokens,
        response_tokens,
        error_message,
    )
    .await;
}

async fn proxy_buffered_response(
    protocol: NativeProtocol,
    gateway_key: &GatewayKey,
    state: &GatewayAppState,
    method: &Method,
    path: &str,
    provider_id: &str,
    model_id: Option<&str>,
    start_time: Instant,
    response: reqwest::Response,
) -> axum::response::Response {
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers().clone();
    let body = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(e) => {
            record_native_outcome(
                &state.db,
                gateway_key,
                provider_id,
                model_id,
                method,
                path,
                502,
                start_time,
                None,
                Some(&format!("Failed to read upstream response: {e}")),
                protocol.aggregates_usage(),
            )
            .await;
            return error_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to read upstream response: {e}"),
            );
        }
    };

    let usage = if status.is_success() {
        serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| protocol.usage_from_body(&value))
    } else {
        None
    };
    let error_message = if status.is_success() {
        None
    } else {
        Some(String::from_utf8_lossy(&body).to_string())
    };

    record_native_outcome(
        &state.db,
        gateway_key,
        provider_id,
        model_id,
        method,
        path,
        status.as_u16() as i32,
        start_time,
        usage.as_ref(),
        error_message.as_deref(),
        protocol.aggregates_usage(),
    )
    .await;

    build_passthrough_response(status, &headers, Body::from(body))
}

fn is_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.starts_with("text/event-stream"))
        .unwrap_or(false)
}

fn build_upstream_request(
    client: reqwest::Client,
    protocol: NativeProtocol,
    method: &Method,
    upstream_url: &str,
    headers: &HeaderMap,
    body: Bytes,
    api_key: &str,
) -> Result<reqwest::RequestBuilder, axum::response::Response> {
    let mut request = match *method {
        Method::GET => client.get(upstream_url),
        Method::POST => client.post(upstream_url),
        _ => {
            return Err(error_response(
                StatusCode::METHOD_NOT_ALLOWED,
                "Unsupported native gateway method",
            ));
        }
    };

    for (name, value) in headers.iter() {
        if should_forward_request_header(name) {
            request = request.header(name, value);
        }
    }

    match protocol {
        NativeProtocol::OpenAiResponses => {
            request = request.header(header::AUTHORIZATION, format!("Bearer {api_key}"));
        }
        NativeProtocol::AnthropicMessages | NativeProtocol::AnthropicCountTokens => {
            request = request.header("x-api-key", api_key);
            if !headers.contains_key("anthropic-version") {
                request = request.header("anthropic-version", ANTHROPIC_VERSION);
            }
        }
        NativeProtocol::GeminiModels
        | NativeProtocol::GeminiGenerateContent
        | NativeProtocol::GeminiStreamGenerateContent
        | NativeProtocol::GeminiCountTokens => {}
    }

    if *method != Method::GET {
        request = request.body(body);
    }

    Ok(request)
}

async fn proxy_stream_response(
    protocol: NativeProtocol,
    gateway_key: GatewayKey,
    db: sea_orm::DatabaseConnection,
    method: Method,
    path: String,
    provider_id: String,
    model_id: Option<String>,
    start_time: Instant,
    response: reqwest::Response,
) -> axum::response::Response {
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers().clone();
    let mut upstream_stream = response.bytes_stream();
    let mut observer = protocol.stream_observer();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, Infallible>>(32);

    tokio::spawn(async move {
        let mut buffer = String::new();
        let mut stream_error: Option<String> = None;

        while let Some(chunk) = upstream_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    observe_sse_chunk(&mut buffer, &bytes, &mut observer);
                    if tx.send(Ok(bytes)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    stream_error = Some(format!("Stream error: {e}"));
                    break;
                }
            }
        }

        let usage = observer.usage();
        let logged_status = if stream_error.is_some() {
            502
        } else {
            status.as_u16() as i32
        };
        record_native_outcome(
            &db,
            &gateway_key,
            &provider_id,
            model_id.as_deref(),
            &method,
            &path,
            logged_status,
            start_time,
            usage.as_ref(),
            stream_error.as_deref(),
            protocol.aggregates_usage(),
        )
        .await;
    });

    build_passthrough_response(status, &headers, Body::from_stream(ReceiverStream::new(rx)))
}

async fn handle_native_request(
    protocol: NativeProtocol,
    state: GatewayAppState,
    gateway_key: GatewayKey,
    request: Request,
    gemini_model: Option<String>,
) -> axum::response::Response {
    let start_time = Instant::now();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let query = request.uri().query().map(ToOwned::to_owned);
    let headers = request.headers().clone();
    let body = match to_bytes(request.into_body(), usize::MAX).await {
        Ok(bytes) => bytes,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("Failed to read request body: {e}"),
            )
        }
    };

    let body_json = if body.is_empty() {
        None
    } else {
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(value) => Some(value),
            Err(e) => {
                return error_response(StatusCode::BAD_REQUEST, &format!("Invalid JSON body: {e}"))
            }
        }
    };

    let model_hint = match protocol {
        NativeProtocol::OpenAiResponses
        | NativeProtocol::AnthropicMessages
        | NativeProtocol::AnthropicCountTokens => match extract_model_from_body(body_json.as_ref(), protocol) {
            Ok(model) => Some(model),
            Err(response) => return response,
        },
        NativeProtocol::GeminiGenerateContent
        | NativeProtocol::GeminiStreamGenerateContent
        | NativeProtocol::GeminiCountTokens => gemini_model.clone(),
        NativeProtocol::GeminiModels => None,
    };

    let resolved = match resolve_native_context(&state, protocol, model_hint.as_deref()).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };

    let upstream_path = match protocol.upstream_path(gemini_model.as_deref()) {
        Ok(path) => path,
        Err(response) => return response,
    };
    let upstream_url = build_upstream_url(
        &resolved.provider.api_host,
        &upstream_path,
        query.as_deref(),
        protocol,
        &resolved.request_ctx.api_key,
    );
    let client = match build_http_client(resolved.request_ctx.proxy_config.as_ref()) {
        Ok(client) => client,
        Err(e) => {
            record_native_outcome(
                &state.db,
                &gateway_key,
                &resolved.provider.id,
                resolved.model_id.as_deref(),
                &method,
                &path,
                502,
                start_time,
                None,
                Some(&e.to_string()),
                protocol.aggregates_usage(),
            )
            .await;
            return error_response(StatusCode::BAD_GATEWAY, &e.to_string());
        }
    };
    let request_builder = match build_upstream_request(
        client,
        protocol,
        &method,
        &upstream_url,
        &headers,
        body,
        &resolved.request_ctx.api_key,
    ) {
        Ok(builder) => builder,
        Err(response) => return response,
    };
    let response = match request_builder.send().await {
        Ok(response) => response,
        Err(e) => {
            record_native_outcome(
                &state.db,
                &gateway_key,
                &resolved.provider.id,
                resolved.model_id.as_deref(),
                &method,
                &path,
                502,
                start_time,
                None,
                Some(&e.to_string()),
                protocol.aggregates_usage(),
            )
            .await;
            return error_response(StatusCode::BAD_GATEWAY, &e.to_string());
        }
    };

    if is_event_stream(response.headers()) {
        proxy_stream_response(
            protocol,
            gateway_key,
            state.db.clone(),
            method,
            path,
            resolved.provider.id.clone(),
            resolved.model_id,
            start_time,
            response,
        )
        .await
    } else {
        proxy_buffered_response(
            protocol,
            &gateway_key,
            &state,
            &method,
            &path,
            &resolved.provider.id,
            resolved.model_id.as_deref(),
            start_time,
            response,
        )
        .await
    }
}

pub async fn openai_responses(
    State(state): State<GatewayAppState>,
    Extension(auth): Extension<AuthenticatedKey>,
    request: Request,
) -> impl IntoResponse {
    let AuthenticatedKey(gateway_key) = auth;
    handle_native_request(
        NativeProtocol::OpenAiResponses,
        state,
        gateway_key,
        request,
        None,
    )
    .await
}

pub async fn anthropic_messages(
    State(state): State<GatewayAppState>,
    Extension(auth): Extension<AuthenticatedKey>,
    request: Request,
) -> impl IntoResponse {
    let AuthenticatedKey(gateway_key) = auth;
    handle_native_request(
        NativeProtocol::AnthropicMessages,
        state,
        gateway_key,
        request,
        None,
    )
    .await
}

pub async fn anthropic_count_tokens(
    State(state): State<GatewayAppState>,
    Extension(auth): Extension<AuthenticatedKey>,
    request: Request,
) -> impl IntoResponse {
    let AuthenticatedKey(gateway_key) = auth;
    handle_native_request(
        NativeProtocol::AnthropicCountTokens,
        state,
        gateway_key,
        request,
        None,
    )
    .await
}

pub async fn gemini_list_models(
    State(state): State<GatewayAppState>,
    Extension(auth): Extension<AuthenticatedKey>,
    request: Request,
) -> impl IntoResponse {
    let AuthenticatedKey(gateway_key) = auth;
    handle_native_request(NativeProtocol::GeminiModels, state, gateway_key, request, None).await
}

pub async fn gemini_model_operation(
    State(state): State<GatewayAppState>,
    Extension(auth): Extension<AuthenticatedKey>,
    Path(model_action): Path<String>,
    request: Request,
) -> impl IntoResponse {
    let AuthenticatedKey(gateway_key) = auth;
    let Some(parsed) = parse_gemini_model_action(&model_action) else {
        return error_response(StatusCode::NOT_FOUND, "Unsupported Gemini native operation");
    };
    let protocol = match parsed.operation {
        GeminiOperation::GenerateContent => NativeProtocol::GeminiGenerateContent,
        GeminiOperation::StreamGenerateContent => NativeProtocol::GeminiStreamGenerateContent,
        GeminiOperation::CountTokens => NativeProtocol::GeminiCountTokens,
    };

    handle_native_request(protocol, state, gateway_key, request, Some(parsed.model)).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::{
        crypto::{encrypt_key, key_prefix},
        db::{create_test_pool, DbHandle},
        repo::{gateway, gateway_request_log, provider},
        types::{
            CreateProviderInput, Model, ModelCapability, ModelType, ProviderType, TokenUsage,
        },
    };
    use axum::{
        body::{to_bytes, Body},
        extract::State,
        http::{header, HeaderMap, Method, Request, Response, StatusCode},
        routing::any,
        Router,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    use crate::{routes::create_router, server::GatewayAppState};

    #[derive(Clone, Debug)]
    struct CapturedUpstreamRequest {
        method: String,
        path_and_query: String,
        authorization: Option<String>,
        x_api_key: Option<String>,
        anthropic_version: Option<String>,
        body: serde_json::Value,
    }

    #[derive(Clone)]
    struct MockUpstreamState {
        captures: Arc<Mutex<Vec<CapturedUpstreamRequest>>>,
        status: StatusCode,
        headers: HeaderMap,
        body: String,
    }

    async fn mock_upstream_handler(
        State(state): State<MockUpstreamState>,
        request: Request<Body>,
    ) -> Response<Body> {
        let (parts, body) = request.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.unwrap();
        let json_body = if bytes.is_empty() {
            json!(null)
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };

        state.captures.lock().unwrap().push(CapturedUpstreamRequest {
            method: parts.method.to_string(),
            path_and_query: parts
                .uri
                .path_and_query()
                .map(|value| value.as_str().to_string())
                .unwrap_or_else(|| parts.uri.path().to_string()),
            authorization: parts
                .headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            x_api_key: parts
                .headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            anthropic_version: parts
                .headers
                .get("anthropic-version")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            body: json_body,
        });

        let mut response = Response::builder().status(state.status);
        for (name, value) in state.headers.iter() {
            response = response.header(name, value);
        }
        response.body(Body::from(state.body.clone())).unwrap()
    }

    async fn spawn_mock_upstream(
        status: StatusCode,
        headers: HeaderMap,
        body: String,
    ) -> (
        String,
        Arc<Mutex<Vec<CapturedUpstreamRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let captures = Arc::new(Mutex::new(Vec::new()));
        let state = MockUpstreamState {
            captures: captures.clone(),
            status,
            headers,
            body,
        };
        let app = Router::new()
            .fallback(any(mock_upstream_handler))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        (format!("http://{}", addr), captures, task)
    }

    async fn seed_native_router(
        provider_type: ProviderType,
        api_host: &str,
        model_id: &str,
    ) -> (Router, DbHandle, String, GatewayAppState) {
        let handle = create_test_pool().await.unwrap();
        let db = &handle.conn;
        let gateway_key = gateway::create_gateway_key(db, "Native Test Key", None)
            .await
            .unwrap();
        let provider = provider::create_provider(
            db,
            CreateProviderInput {
                name: "Native Provider".into(),
                provider_type,
                api_host: api_host.into(),
                api_path: None,
                enabled: true,
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
                max_tokens: Some(4096),
                enabled: true,
                param_overrides: None,
            }],
        )
        .await
        .unwrap();

        let master_key = [9u8; 32];
        provider::add_provider_key(
            db,
            &provider.id,
            &encrypt_key("upstream-secret", &master_key).unwrap(),
            &key_prefix("upstream-secret"),
        )
        .await
        .unwrap();

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

    async fn insert_provider_with_optional_key(
        db: &sea_orm::DatabaseConnection,
        master_key: &[u8; 32],
        name: &str,
        provider_type: ProviderType,
        api_host: &str,
        model_id: &str,
        with_key: bool,
    ) -> aqbot_core::types::ProviderConfig {
        let provider = provider::create_provider(
            db,
            CreateProviderInput {
                name: name.into(),
                provider_type,
                api_host: api_host.into(),
                api_path: None,
                enabled: true,
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
                max_tokens: Some(4096),
                enabled: true,
                param_overrides: None,
            }],
        )
        .await
        .unwrap();

        if with_key {
            provider::add_provider_key(
                db,
                &provider.id,
                &encrypt_key("upstream-secret", master_key).unwrap(),
                &key_prefix("upstream-secret"),
            )
            .await
            .unwrap();
        }

        provider::get_provider(db, &provider.id).await.unwrap()
    }

    fn assert_usage(actual: Option<TokenUsage>, prompt: u32, completion: u32, total: u32) {
        let usage = actual.expect("expected usage to be present");
        assert_eq!(usage.prompt_tokens, prompt);
        assert_eq!(usage.completion_tokens, completion);
        assert_eq!(usage.total_tokens, total);
    }

    #[test]
    fn parses_gemini_model_action_suffixes() {
        let parsed = parse_gemini_model_action("gemini-2.5-pro:streamGenerateContent").unwrap();
        assert_eq!(parsed.model, "gemini-2.5-pro");
        assert_eq!(parsed.operation, GeminiOperation::StreamGenerateContent);

        let parsed = parse_gemini_model_action("models/gemini-2.5-pro:countTokens").unwrap();
        assert_eq!(parsed.model, "models/gemini-2.5-pro");
        assert_eq!(parsed.operation, GeminiOperation::CountTokens);

        assert!(parse_gemini_model_action("gemini-2.5-pro").is_none());
        assert!(parse_gemini_model_action("gemini-2.5-pro:unknown").is_none());
    }

    #[test]
    fn extracts_non_stream_usage_from_native_protocol_bodies() {
        assert_usage(
            extract_openai_response_usage(&json!({
                "usage": {
                    "input_tokens": 120,
                    "output_tokens": 45,
                    "total_tokens": 165
                }
            })),
            120,
            45,
            165,
        );

        assert_usage(
            extract_anthropic_message_usage(&json!({
                "usage": {
                    "input_tokens": 88,
                    "output_tokens": 12
                }
            })),
            88,
            12,
            100,
        );

        assert_usage(
            extract_gemini_generate_content_usage(&json!({
                "usageMetadata": {
                    "promptTokenCount": 33,
                    "candidatesTokenCount": 9,
                    "totalTokenCount": 42
                }
            })),
            33,
            9,
            42,
        );
    }

    #[test]
    fn extracts_stream_usage_from_native_protocol_events() {
        let mut openai = OpenAiResponsesStreamState::default();
        openai.observe_sse_line(
            r#"data: {"type":"response.completed","response":{"usage":{"input_tokens":55,"output_tokens":21,"total_tokens":76}}}"#,
        );
        assert_usage(openai.usage(), 55, 21, 76);

        let mut anthropic = AnthropicMessagesStreamState::default();
        anthropic.observe_sse_line(
            r#"data: {"type":"message_delta","usage":{"output_tokens":17}}"#,
        );
        anthropic.observe_sse_line(
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":61}}}"#,
        );
        assert_usage(anthropic.usage(), 61, 17, 78);

        let mut gemini = GeminiStreamState::default();
        gemini.observe_sse_line(
            r#"data: {"usageMetadata":{"promptTokenCount":44,"candidatesTokenCount":13,"totalTokenCount":57}}"#,
        );
        assert_usage(gemini.usage(), 44, 13, 57);
    }

    #[test]
    fn extracts_count_token_usage_for_auxiliary_endpoints() {
        assert_usage(
            extract_anthropic_count_tokens_usage(&json!({ "input_tokens": 123 })),
            123,
            0,
            123,
        );

        assert_usage(
            extract_gemini_count_tokens_usage(&json!({ "totalTokens": 27 })),
            27,
            0,
            27,
        );
    }

    #[tokio::test]
    async fn openai_responses_proxy_records_usage() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let upstream_body = json!({
            "id": "resp_123",
            "object": "response",
            "usage": {
                "input_tokens": 11,
                "output_tokens": 7,
                "total_tokens": 18
            }
        })
        .to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_upstream(StatusCode::OK, headers, upstream_body.clone()).await;
        let (app, handle, gateway_key, _) =
            seed_native_router(ProviderType::OpenAI, &upstream_base, "gpt-5").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/responses")
                    .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "model": "gpt-5",
                            "input": "hello"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::from_str::<serde_json::Value>(&upstream_body).unwrap()
        );

        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].method, "POST");
        assert_eq!(captured[0].path_and_query, "/v1/responses");
        assert_eq!(captured[0].authorization.as_deref(), Some("Bearer upstream-secret"));
        assert_eq!(captured[0].body["model"], "gpt-5");
        drop(captured);

        let metrics = gateway::get_gateway_metrics(&handle.conn).await.unwrap();
        assert_eq!(metrics.total_requests, 1);
        assert_eq!(metrics.total_request_tokens, 11);
        assert_eq!(metrics.total_response_tokens, 7);

        let logs = gateway_request_log::list_request_logs(&handle.conn, 10, 0)
            .await
            .unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].path, "/v1/responses");
        assert_eq!(logs[0].request_tokens, 11);
        assert_eq!(logs[0].response_tokens, 7);

        upstream_task.abort();
    }

    #[tokio::test]
    async fn anthropic_stream_proxy_records_usage() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
        let upstream_body = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":61}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":17}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        )
        .to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_upstream(StatusCode::OK, headers, upstream_body.clone()).await;
        let (app, handle, gateway_key, _) = seed_native_router(
            ProviderType::Anthropic,
            &upstream_base,
            "claude-sonnet-4-20250514",
        )
        .await;

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/messages")
                    .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "model": "claude-sonnet-4-20250514",
                            "max_tokens": 32,
                            "stream": true,
                            "messages": [{ "role": "user", "content": "hi" }]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let status = response.status();
        let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body_text = String::from_utf8(body.to_vec()).unwrap();
        assert_eq!(status, StatusCode::OK, "unexpected anthropic body: {body_text}");
        assert_eq!(content_type.unwrap(), "text/event-stream");
        assert_eq!(body_text, upstream_body);

        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].path_and_query, "/v1/messages");
        assert_eq!(captured[0].x_api_key.as_deref(), Some("upstream-secret"));
        assert_eq!(captured[0].anthropic_version.as_deref(), Some("2023-06-01"));
        drop(captured);

        let metrics = gateway::get_gateway_metrics(&handle.conn).await.unwrap();
        assert_eq!(metrics.total_requests, 1);
        assert_eq!(metrics.total_request_tokens, 61);
        assert_eq!(metrics.total_response_tokens, 17);

        let logs = gateway_request_log::list_request_logs(&handle.conn, 10, 0)
            .await
            .unwrap();
        assert_eq!(logs[0].path, "/v1/messages");
        assert_eq!(logs[0].request_tokens, 61);
        assert_eq!(logs[0].response_tokens, 17);

        upstream_task.abort();
    }

    #[tokio::test]
    async fn gemini_count_tokens_logs_without_aggregate_usage() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let upstream_body = json!({ "totalTokens": 27 }).to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_upstream(StatusCode::OK, headers, upstream_body.clone()).await;
        let (app, handle, gateway_key, _) =
            seed_native_router(ProviderType::Gemini, &upstream_base, "gemini-2.5-pro").await;

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1beta/models/gemini-2.5-pro:countTokens")
                    .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "contents": [{
                                "role": "user",
                                "parts": [{ "text": "hello" }]
                            }]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body_text = String::from_utf8(body.to_vec()).unwrap();
        assert_eq!(status, StatusCode::OK, "unexpected gemini body: {body_text}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body_text).unwrap(),
            serde_json::from_str::<serde_json::Value>(&upstream_body).unwrap()
        );

        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(
            captured[0].path_and_query,
            "/v1beta/models/gemini-2.5-pro:countTokens?key=upstream-secret"
        );
        drop(captured);

        let metrics = gateway::get_gateway_metrics(&handle.conn).await.unwrap();
        assert_eq!(metrics.total_requests, 0);
        assert_eq!(metrics.total_tokens, 0);

        let logs = gateway_request_log::list_request_logs(&handle.conn, 10, 0)
            .await
            .unwrap();
        assert_eq!(logs[0].path, "/v1beta/models/gemini-2.5-pro:countTokens");
        assert_eq!(logs[0].request_tokens, 27);
        assert_eq!(logs[0].response_tokens, 0);

        upstream_task.abort();
    }

    #[tokio::test]
    async fn openai_responses_prefers_matching_provider_with_active_key() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let upstream_body = json!({
            "id": "resp_456",
            "object": "response",
            "usage": {
                "input_tokens": 9,
                "output_tokens": 3,
                "total_tokens": 12
            }
        })
        .to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_upstream(StatusCode::OK, headers, upstream_body).await;

        let handle = create_test_pool().await.unwrap();
        let db = &handle.conn;
        let gateway_key = gateway::create_gateway_key(db, "Native Test Key", None)
            .await
            .unwrap();
        let master_key = [9u8; 32];

        insert_provider_with_optional_key(
            db,
            &master_key,
            "OpenAI",
            ProviderType::OpenAI,
            &upstream_base,
            "gpt-4o",
            true,
        )
        .await;
        insert_provider_with_optional_key(
            db,
            &master_key,
            "OpenAI Responses",
            ProviderType::OpenAI,
            &upstream_base,
            "gpt-4o",
            false,
        )
        .await;

        let app = create_router(GatewayAppState {
            db: handle.conn.clone(),
            master_key,
        });
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/responses")
                    .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key.plain_key))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "model": "gpt-4o",
                            "input": "hello"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].path_and_query, "/v1/responses");

        upstream_task.abort();
    }

    #[tokio::test]
    async fn openai_responses_reuses_existing_v1_base_path() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let upstream_body = json!({
            "id": "resp_789",
            "object": "response",
            "usage": {
                "input_tokens": 4,
                "output_tokens": 2,
                "total_tokens": 6
            }
        })
        .to_string();
        let (upstream_base, captures, upstream_task) =
            spawn_mock_upstream(StatusCode::OK, headers, upstream_body).await;
        let (app, _handle, gateway_key, _) = seed_native_router(
            ProviderType::OpenAI,
            &format!("{}/v1", upstream_base),
            "gpt-4o",
        )
        .await;

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/responses")
                    .header(header::AUTHORIZATION, format!("Bearer {}", gateway_key))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "model": "gpt-4o",
                            "input": "hello"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let captured = captures.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].path_and_query, "/v1/responses");

        upstream_task.abort();
    }
}
