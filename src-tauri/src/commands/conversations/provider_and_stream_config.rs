// Provider resolution, model parameters, and stream configuration.

const RAG_CONTEXT_TIMEOUT: Duration = Duration::from_secs(60);
const RAG_RETRIEVAL_FAILED_PREFIX: &str = "检索失败";
const SYSTEM_PROMPT_LOG_EXCERPT_BYTES: usize = 80;
const SEARCH_QUERY_HISTORY_LIMIT: usize = 6;
const SEARCH_QUERY_MESSAGE_CHAR_LIMIT: usize = 500;
const SEARCH_QUERY_CURRENT_CHAR_LIMIT: usize = 500;
const SEARCH_QUERY_MAX_TOKENS: u32 = 96;
const SEARCH_QUERY_RETRY_MAX_TOKENS: u32 = 1024;
const MCP_TOOL_RESULT_MAX_BYTES: usize = 50_000;
const MCP_TOOL_LOOP_MIN_ITERATIONS: u32 = 1;
const MCP_TOOL_LOOP_MAX_ITERATIONS: u32 = 100;

fn system_prompt_log_excerpt(prompt: &str) -> &str {
    let end = prompt.floor_char_boundary(prompt.len().min(SYSTEM_PROMPT_LOG_EXCERPT_BYTES));
    &prompt[..end]
}

fn format_rag_failure_message(reason: &str) -> String {
    let reason = reason.trim();
    if reason.is_empty() {
        return RAG_RETRIEVAL_FAILED_PREFIX.to_string();
    }
    if reason.starts_with(RAG_RETRIEVAL_FAILED_PREFIX) {
        return reason.to_string();
    }
    format!("{RAG_RETRIEVAL_FAILED_PREFIX}：{reason}")
}

fn rag_timeout_failure_reason() -> String {
    format!("检索超时，已超过 {} 秒", RAG_CONTEXT_TIMEOUT.as_secs())
}

fn provider_type_to_registry_key(pt: &ProviderType) -> &'static str {
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

async fn resolve_command_provider_id(
    db: &DatabaseConnection,
    provider_id: &str,
) -> Result<String, String> {
    aqbot_core::repo::provider::resolve_provider_id(db, provider_id)
        .await
        .map_err(|e| e.to_string())
}

async fn get_optional_model(
    db: &DatabaseConnection,
    provider_id: &str,
    model_id: &str,
) -> Result<Option<Model>, String> {
    match aqbot_core::repo::provider::get_model(db, provider_id, model_id).await {
        Ok(model) => Ok(Some(model)),
        Err(aqbot_core::error::AQBotError::NotFound(_)) => Ok(None),
        Err(error) => Err(format!(
            "Failed to load model metadata for {provider_id}/{model_id}: {error}"
        )),
    }
}

/// Whether the model can accept provider tool / function-calling payloads.
/// Unknown models default to `true` so legacy records keep previous behavior.
fn model_supports_function_calling(model: Option<&Model>) -> bool {
    model
        .map(|m| m.capabilities.contains(&ModelCapability::FunctionCalling))
        .unwrap_or(true)
}

#[cfg(test)]
mod function_calling_gate_tests {
    use super::*;

    fn sample_model(capabilities: Vec<ModelCapability>) -> Model {
        Model {
            provider_id: "p".into(),
            model_id: "m".into(),
            name: "m".into(),
            group_name: None,
            model_type: ModelType::Chat,
            capabilities,
            context_window: None,
            max_output_tokens: None,
            enabled: true,
            param_overrides: None,
            image_config: None,
            metadata_state: None,
            aliases: Vec::new(),
        }
    }

    #[test]
    fn unknown_model_defaults_to_allowing_tools() {
        assert!(model_supports_function_calling(None));
    }

    #[test]
    fn model_without_function_calling_disallows_tools() {
        let model = sample_model(vec![ModelCapability::TextChat]);
        assert!(!model_supports_function_calling(Some(&model)));
    }

    #[test]
    fn model_with_function_calling_allows_tools() {
        let model = sample_model(vec![
            ModelCapability::TextChat,
            ModelCapability::FunctionCalling,
        ]);
        assert!(model_supports_function_calling(Some(&model)));
    }
}

/// Load MCP tools only when the model supports FunctionCalling.
/// Persisted MCP selections are kept; runtime injection is forced off otherwise.
async fn load_mcp_tools_for_model(
    db: &DatabaseConnection,
    enabled_mcp_server_ids: Option<Vec<String>>,
    model: Option<&Model>,
) -> (Vec<String>, Option<Vec<ChatTool>>) {
    let mcp_ids = enabled_mcp_server_ids.unwrap_or_default();
    if mcp_ids.is_empty() {
        return (mcp_ids, None);
    }
    if !model_supports_function_calling(model) {
        tracing::info!(
            "[mcp] Skipping tool injection: model does not support FunctionCalling (mcp_ids={:?})",
            mcp_ids
        );
        return (Vec::new(), None);
    }

    let mut all_tools = Vec::new();
    for server_id in &mcp_ids {
        if let Ok(descriptors) =
            aqbot_core::repo::mcp_server::list_tools_for_server(db, server_id).await
        {
            for td in descriptors {
                let parameters: Option<serde_json::Value> = td
                    .input_schema_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok());
                all_tools.push(ChatTool {
                    r#type: "function".to_string(),
                    function: ChatToolFunction {
                        name: td.name,
                        description: td.description,
                        parameters,
                    },
                });
            }
        }
    }
    if all_tools.is_empty() {
        (mcp_ids, None)
    } else {
        (mcp_ids, Some(all_tools))
    }
}

fn merge_memory_tool(
    mcp_tools: Option<Vec<ChatTool>>,
    prepared: &aqbot_core::context_engine::PreparedTurn,
) -> Option<Vec<ChatTool>> {
    match &prepared.memory_tool {
        None => mcp_tools,
        Some(binding) => {
            let mut tools = mcp_tools.unwrap_or_default();
            tools.push(binding.tool.clone());
            Some(tools)
        }
    }
}

fn push_l1_system_message(
    chat_messages: &mut Vec<ChatMessage>,
    prepared: &aqbot_core::context_engine::PreparedTurn,
) {
    if let Some(text) = &prepared.l1_system_message {
        chat_messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(text.clone()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
    }
}

async fn prepare_chat_turn(
    db: &DatabaseConnection,
    kb_ids: Option<Vec<String>>,
    mem_ids: Option<Vec<String>>,
    model: Option<&Model>,
) -> Result<aqbot_core::context_engine::PreparedTurn, String> {
    let kb = kb_ids.unwrap_or_default();
    let mem = mem_ids.unwrap_or_default();
    aqbot_core::context_engine::prepare_turn(
        db,
        aqbot_core::context_engine::PrepareTurnRequest {
            enabled_knowledge_base_ids: &kb,
            enabled_memory_namespace_ids: &mem,
            inject_l1: true,
            model_supports_tools: model_supports_function_calling(model),
        },
    )
    .await
    .map_err(|e| e.to_string())
}

/// Resolve effective system prompt with priority: Conversation → Category → Global Default
async fn resolve_system_prompt(
    db: &DatabaseConnection,
    conversation: &Conversation,
) -> Result<Option<String>, String> {
    // 1. Conversation-level system prompt (highest priority)
    if let Some(s) = &conversation.system_prompt {
        if !s.is_empty() {
            return Ok(Some(s.clone()));
        }
    }

    // 2. Category-level system prompt (middle priority)
    if let Some(ref cat_id) = conversation.category_id {
        let categories = aqbot_core::repo::conversation_category::list_conversation_categories(db)
            .await
            .map_err(|error| format!("Failed to load conversation categories: {error}"))?;
        if let Some(cat) = categories.iter().find(|c| &c.id == cat_id) {
            if let Some(ref s) = cat.system_prompt {
                if !s.is_empty() {
                    return Ok(Some(s.clone()));
                }
            }
        }
    }

    // 3. Global default system prompt (lowest priority)
    let settings = aqbot_core::repo::settings::get_settings(db)
        .await
        .map_err(|error| format!("Failed to load app settings: {error}"))?;
    Ok(settings.default_system_prompt.filter(|s| !s.is_empty()))
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct EffectiveChatModelParams {
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Copy)]
struct StreamContextPolicy {
    strategy: ContextStrategy,
    input_budget: Option<usize>,
    protected_prefix_len: usize,
}

impl StreamContextPolicy {
    fn new(
        strategy: ContextStrategy,
        input_budget: Option<usize>,
        messages: &[ChatMessage],
    ) -> Self {
        Self {
            strategy,
            input_budget,
            protected_prefix_len: messages
                .iter()
                .take_while(|message| message.role == "system")
                .count(),
        }
    }
}

fn apply_stream_context_policy(
    messages: &[ChatMessage],
    policy: StreamContextPolicy,
) -> Result<crate::context_manager::ContextBuildResult, String> {
    let prefix_len = policy.protected_prefix_len.min(messages.len());
    let (protected, history) = messages.split_at(prefix_len);
    crate::context_manager::build_context_for_strategy(
        protected,
        history,
        None,
        policy.strategy,
        policy.input_budget,
    )
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct StreamTimeoutConfig {
    first_packet: Option<Duration>,
    idle: Option<Duration>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ContextBoundary {
    start_index: usize,
    use_summary: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CompressionEvent {
    conversation_id: String,
    marker_message: Message,
    summary: ConversationSummary,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextUsage {
    used_tokens: u32,
    context_window: Option<u32>,
    threshold_tokens: Option<u32>,
    has_summary: bool,
    compressed_until_message_id: Option<String>,
    messages_after_boundary: u32,
    effective_strategy: ContextStrategy,
    raw_tokens: u32,
    sent_tokens: u32,
    excluded_message_count: u32,
    exclusion_reason: Option<String>,
    overflow: bool,
}

fn stream_timeout_config_from_settings(settings: &AppSettings) -> StreamTimeoutConfig {
    StreamTimeoutConfig {
        first_packet: duration_from_timeout_secs(settings.chat_stream_first_packet_timeout_secs),
        idle: duration_from_timeout_secs(settings.chat_stream_idle_timeout_secs),
    }
}

fn mcp_tool_loop_max_iterations_from_settings(settings: &AppSettings) -> usize {
    settings
        .mcp_tool_loop_max_iterations
        .clamp(MCP_TOOL_LOOP_MIN_ITERATIONS, MCP_TOOL_LOOP_MAX_ITERATIONS) as usize
}

fn duration_from_timeout_secs(seconds: u64) -> Option<Duration> {
    (seconds > 0).then(|| Duration::from_secs(seconds))
}

const ACTIVE_STREAM_EXISTS_ERROR: &str = "当前会话已有回复正在生成，请等待完成或停止后再发送";

async fn has_active_stream_for_conversation(
    cancel_flags: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, crate::StreamCancelEntry>>,
    >,
    conversation_id: &str,
) -> bool {
    let flags = cancel_flags.lock().await;
    flags.values().any(|entry| {
        entry.conversation_id == conversation_id
            && !entry.flag.load(std::sync::atomic::Ordering::Relaxed)
    })
}

async fn register_stream_cancel_flag(
    cancel_flags: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, crate::StreamCancelEntry>>,
    >,
    conversation_id: &str,
    stream_id: &str,
    cancel_flag: Arc<AtomicBool>,
    allow_parallel: bool,
) -> Result<(), String> {
    let mut flags = cancel_flags.lock().await;
    let has_active_stream = flags.values().any(|entry| {
        entry.conversation_id == conversation_id
            && !entry.flag.load(std::sync::atomic::Ordering::Relaxed)
    });
    if has_active_stream && !allow_parallel {
        return Err(ACTIVE_STREAM_EXISTS_ERROR.to_string());
    }

    flags.insert(
        stream_id.to_string(),
        crate::StreamCancelEntry {
            conversation_id: conversation_id.to_string(),
            flag: cancel_flag,
        },
    );
    Ok(())
}

struct RegisteredStreamGuard {
    cancel_flags:
        Arc<tokio::sync::Mutex<std::collections::HashMap<String, crate::StreamCancelEntry>>>,
    stream_id: String,
    cancel_flag: Arc<AtomicBool>,
    released: bool,
}

impl RegisteredStreamGuard {
    async fn register(
        cancel_flags: Arc<
            tokio::sync::Mutex<std::collections::HashMap<String, crate::StreamCancelEntry>>,
        >,
        conversation_id: &str,
        stream_id: &str,
        cancel_flag: Arc<AtomicBool>,
        allow_parallel: bool,
    ) -> Result<Self, String> {
        register_stream_cancel_flag(
            cancel_flags.clone(),
            conversation_id,
            stream_id,
            cancel_flag.clone(),
            allow_parallel,
        )
        .await?;

        Ok(Self {
            cancel_flags,
            stream_id: stream_id.to_string(),
            cancel_flag,
            released: false,
        })
    }

    async fn release(mut self) {
        self.released = true;
        self.cancel_flags.lock().await.remove(&self.stream_id);
    }
}

impl Drop for RegisteredStreamGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }

        self.cancel_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let cancel_flags = self.cancel_flags.clone();
        let stream_id = self.stream_id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                cancel_flags.lock().await.remove(&stream_id);
            });
        }
    }
}

fn build_stream_error_event(
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    error: String,
    kind: &str,
    timeout_secs: Option<u64>,
) -> ChatStreamErrorEvent {
    let safe = aqbot_core::inline_media::filter_complete_inline_data;
    ChatStreamErrorEvent {
        conversation_id: safe(conversation_id),
        message_id: safe(message_id),
        stream_id: Some(safe(stream_id)),
        model_id: Some(safe(model_id)),
        provider_id: Some(safe(provider_id)),
        error: safe(&error),
        kind: Some(safe(kind)),
        timeout_secs,
    }
}

fn build_tool_loop_exceeded_error_event(
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    max_iterations: usize,
) -> ChatStreamErrorEvent {
    build_stream_error_event(
        conversation_id,
        message_id,
        stream_id,
        model_id,
        provider_id,
        format!("MCP tool loop exceeded {} iterations", max_iterations),
        "tool_loop_exceeded",
        None,
    )
}

fn build_stream_timeout_error_event(
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    received_stream_packet: bool,
    timeout: Duration,
) -> ChatStreamErrorEvent {
    let timeout_secs = timeout.as_secs();
    let (kind, error) = if received_stream_packet {
        (
            "idle_timeout",
            format!("模型响应空闲超时，已超过 {} 秒未收到新内容", timeout_secs),
        )
    } else {
        (
            "first_packet_timeout",
            format!("模型首包超时，已超过 {} 秒未收到响应", timeout_secs),
        )
    };

    build_stream_error_event(
        conversation_id,
        message_id,
        stream_id,
        model_id,
        provider_id,
        error,
        kind,
        Some(timeout_secs),
    )
}

fn build_stream_done_event(
    conversation_id: &str,
    message_id: &str,
    stream_id: &str,
    model_id: &str,
    provider_id: &str,
    usage: Option<TokenUsage>,
) -> ChatStreamEvent {
    let safe = aqbot_core::inline_media::filter_complete_inline_data;
    ChatStreamEvent {
        conversation_id: safe(conversation_id),
        message_id: safe(message_id),
        stream_id: Some(safe(stream_id)),
        model_id: Some(safe(model_id)),
        provider_id: Some(safe(provider_id)),
        chunk: ChatStreamChunk {
            content: None,
            thinking: None,
            done: true,
            is_final: Some(true),
            usage,
            tool_calls: None,
        },
    }
}

fn pre_persist_stream_chunk(chunk: &ChatStreamChunk) -> Option<ChatStreamChunk> {
    if !chunk.done {
        return Some(chunk.clone());
    }

    let has_tool_calls = chunk
        .tool_calls
        .as_ref()
        .is_some_and(|tool_calls| !tool_calls.is_empty());
    if has_tool_calls {
        let mut non_final = chunk.clone();
        non_final.is_final = Some(false);
        return Some(non_final);
    }

    if chunk.content.is_none() && chunk.thinking.is_none() && chunk.usage.is_none() {
        return None;
    }

    let mut delta = chunk.clone();
    delta.done = false;
    delta.is_final = None;
    Some(delta)
}

fn filter_inline_data_stream_event_content(
    filter: &mut aqbot_core::inline_media::InlineDataStreamFilter,
    content: &str,
    is_done: bool,
) -> String {
    let mut filtered = filter.push(content);
    if is_done {
        filtered.push_str(&filter.finish());
    }
    filtered
}

fn filter_complete_inline_data_event_text(content: &str) -> String {
    let mut filter = aqbot_core::inline_media::InlineDataStreamFilter::default();
    filter_inline_data_stream_event_content(&mut filter, content, true)
}

fn filter_tool_calls_for_event(tool_calls: Option<&[ToolCall]>) -> Option<Vec<ToolCall>> {
    tool_calls.map(|tool_calls| {
        tool_calls
            .iter()
            .cloned()
            .map(|mut tool_call| {
                tool_call.id = filter_complete_inline_data_event_text(&tool_call.id);
                tool_call.call_type = filter_complete_inline_data_event_text(&tool_call.call_type);
                tool_call.function.name =
                    filter_complete_inline_data_event_text(&tool_call.function.name);
                tool_call.function.arguments =
                    filter_complete_inline_data_event_text(&tool_call.function.arguments);
                tool_call
            })
            .collect()
    })
}

const STREAM_ERROR_CONTENT_MARKER: &str = "<!-- aqbot-stream-error -->";

fn append_stream_error_to_content(content: &str, error: &str) -> String {
    let trimmed_content = content.trim_end();
    let trimmed_error = error.trim();
    if trimmed_content.trim().is_empty() {
        return trimmed_error.to_string();
    }

    if let Some((prefix, _)) = trimmed_content.split_once(STREAM_ERROR_CONTENT_MARKER) {
        return format!(
            "{}\n\n{}\n{}",
            prefix.trim_end(),
            STREAM_ERROR_CONTENT_MARKER,
            trimmed_error
        );
    }

    format!(
        "{}\n\n{}\n{}",
        trimmed_content, STREAM_ERROR_CONTENT_MARKER, trimmed_error
    )
}

fn resolve_chat_model_params(
    conversation: &Conversation,
    model_param_overrides: Option<&ModelParamOverrides>,
    settings: &AppSettings,
    _use_max_completion_tokens: Option<bool>,
    force_max_tokens: Option<bool>,
    max_output_tokens: Option<u32>,
) -> EffectiveChatModelParams {
    let omit_sampling_params = model_param_overrides
        .and_then(|params| params.omit_sampling_params)
        .unwrap_or(false);
    let temperature = (!omit_sampling_params)
        .then(|| {
            conversation
                .temperature
                .or_else(|| model_param_overrides.and_then(|params| params.temperature))
                .or(settings.default_temperature)
                .map(|value| value as f64)
        })
        .flatten();
    let top_p = (!omit_sampling_params)
        .then(|| {
            conversation
                .top_p
                .or_else(|| model_param_overrides.and_then(|params| params.top_p))
                .or(settings.default_top_p)
                .map(|value| value as f64)
        })
        .flatten();
    let configured_max_tokens = match conversation.max_tokens {
        Some(max_tokens) => Some(max_tokens),
        None if force_max_tokens == Some(true) => model_param_overrides
            .and_then(|p| p.max_tokens)
            .or(settings.default_max_tokens)
            .or(Some(4096)),
        None => settings.default_max_tokens,
    };
    let max_tokens = match (configured_max_tokens, max_output_tokens) {
        (Some(configured), Some(limit)) if configured > limit => {
            tracing::warn!(
                configured_max_tokens = configured,
                model_max_output_tokens = limit,
                "Clamped chat output tokens to the model metadata limit"
            );
            Some(limit)
        }
        (configured, _) => configured,
    };

    EffectiveChatModelParams {
        temperature,
        top_p,
        max_tokens,
    }
}

fn resolved_context_output_reserve(
    conversation: &Conversation,
    model_param_overrides: Option<&ModelParamOverrides>,
    settings: &AppSettings,
    use_max_completion_tokens: Option<bool>,
    force_max_tokens: Option<bool>,
    model_max_output_tokens: Option<u32>,
) -> Option<usize> {
    // A strict input budget needs an actual upper bound. A configured request
    // limit wins; otherwise model metadata is the only safe provider-default
    // bound. Guessing 4096 while omitting max_tokens would not be strict.
    resolve_chat_model_params(
        conversation,
        model_param_overrides,
        settings,
        use_max_completion_tokens,
        force_max_tokens,
        model_max_output_tokens,
    )
    .max_tokens
    .or(model_max_output_tokens)
    .map(|resolved| resolved as usize)
}

fn estimate_tool_schema_tokens(tools: Option<&[ChatTool]>) -> Result<usize, String> {
    let Some(tools) = tools else {
        return Ok(0);
    };
    let serialized = serde_json::to_string(tools).map_err(|error| {
        format!("Failed to serialize tool schemas for context budgeting: {error}")
    })?;
    Ok(aqbot_core::token_counter::estimate_tokens(&serialized))
}

fn model_extra_body_from_overrides(
    model_param_overrides: Option<&ModelParamOverrides>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    model_param_overrides.and_then(|params| params.extra_body.clone())
}
