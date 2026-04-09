use serde::{Deserialize, Deserializer, Serialize};

/// Deserialize `Option<Option<T>>` so that a JSON `null` becomes `Some(None)`
/// while a missing field (via `#[serde(default)]`) stays `None`.
fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

// === Provider System ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: ProviderType,
    pub api_host: String,
    pub api_path: Option<String>,
    pub enabled: bool,
    pub models: Vec<Model>,
    pub keys: Vec<ProviderKey>,
    pub proxy_config: Option<ProviderProxyConfig>,
    pub custom_headers: Option<String>,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    OpenAI,
    #[serde(rename = "openai_responses")]
    OpenAIResponses,
    Anthropic,
    Gemini,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderKey {
    pub id: String,
    pub provider_id: String,
    pub key_encrypted: String,
    pub key_prefix: String,
    pub enabled: bool,
    pub last_validated_at: Option<i64>,
    pub last_error: Option<String>,
    pub rotation_index: u32,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProxyConfig {
    pub proxy_type: Option<String>,
    pub proxy_address: Option<String>,
    pub proxy_port: Option<u16>,
}

impl ProviderProxyConfig {
    /// Resolve effective proxy: provider-level overrides global.
    /// If provider has explicit proxy_type, use it (even "none" to disable).
    /// Otherwise fall back to global settings.
    pub fn resolve(provider: &Option<Self>, global_settings: &AppSettings) -> Option<Self> {
        if let Some(config) = provider {
            if config.proxy_type.is_some() {
                if config.proxy_type.as_deref() == Some("none") {
                    return None;
                }
                return Some(config.clone());
            }
        }
        // Fall back to global proxy
        match global_settings.proxy_type.as_deref() {
            Some("none") | None => None,
            Some("system") => Some(Self {
                proxy_type: Some("system".to_string()),
                proxy_address: None,
                proxy_port: None,
            }),
            _ => Some(Self {
                proxy_type: global_settings.proxy_type.clone(),
                proxy_address: global_settings.proxy_address.clone(),
                proxy_port: global_settings.proxy_port,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProviderInput {
    pub name: String,
    pub provider_type: ProviderType,
    pub api_host: String,
    pub api_path: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateProviderInput {
    pub name: Option<String>,
    pub provider_type: Option<ProviderType>,
    pub api_host: Option<String>,
    pub api_path: Option<Option<String>>,
    pub enabled: Option<bool>,
    pub proxy_config: Option<ProviderProxyConfig>,
    pub custom_headers: Option<Option<String>>,
    pub icon: Option<Option<String>>,
    pub sort_order: Option<i32>,
}

// === Model System ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub group_name: Option<String>,
    pub model_type: ModelType,
    pub capabilities: Vec<ModelCapability>,
    pub max_tokens: Option<u32>,
    pub enabled: bool,
    pub param_overrides: Option<ModelParamOverrides>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ModelType {
    Chat,
    Voice,
    Embedding,
}

impl Default for ModelType {
    fn default() -> Self {
        ModelType::Chat
    }
}

impl ModelType {
    /// Auto-detect model type from model_id string
    pub fn detect(model_id: &str) -> Self {
        let id = model_id.to_lowercase();
        if id.contains("embed") {
            ModelType::Embedding
        } else if id.contains("realtime")
            || id.contains("tts")
            || id.contains("whisper")
            || id.contains("audio")
        {
            ModelType::Voice
        } else {
            ModelType::Chat
        }
    }
}

impl std::fmt::Display for ModelType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelType::Chat => write!(f, "chat"),
            ModelType::Voice => write!(f, "voice"),
            ModelType::Embedding => write!(f, "embedding"),
        }
    }
}

impl std::str::FromStr for ModelType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "chat" => Ok(ModelType::Chat),
            "voice" => Ok(ModelType::Voice),
            "embedding" => Ok(ModelType::Embedding),
            _ => Ok(ModelType::Chat),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ModelCapability {
    TextChat,
    Vision,
    FunctionCalling,
    Reasoning,
    RealtimeVoice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelParamOverrides {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    pub frequency_penalty: Option<f32>,
    /// When true, the provider adapter should send `max_completion_tokens`
    /// instead of `max_tokens` (required by OpenAI o-series models).
    pub use_max_completion_tokens: Option<bool>,
    /// When true, system messages are converted to user messages
    /// (for models that don't support the system role).
    pub no_system_role: Option<bool>,
    /// When true, always include max_tokens in the request
    /// (falls back to 4096 if conversation.max_tokens is not set).
    pub force_max_tokens: Option<bool>,
}

// === Conversation & Message ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub model_id: String,
    pub provider_id: String,
    pub system_prompt: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    pub frequency_penalty: Option<f32>,
    pub search_enabled: bool,
    pub search_provider_id: Option<String>,
    pub thinking_budget: Option<i64>,
    pub enabled_mcp_server_ids: Vec<String>,
    pub enabled_knowledge_base_ids: Vec<String>,
    pub enabled_memory_namespace_ids: Vec<String>,
    pub message_count: u32,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub context_compression: bool,
    pub category_id: Option<String>,
    pub parent_conversation_id: Option<String>,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: MessageRole,
    pub content: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub token_count: Option<u32>,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub attachments: Vec<Attachment>,
    pub thinking: Option<String>,
    pub created_at: i64,
    pub parent_message_id: Option<String>,
    pub version_index: i32,
    pub is_active: bool,
    pub tool_calls_json: Option<String>,
    pub tool_call_id: Option<String>,
    pub status: String,
    pub tokens_per_second: Option<f64>,
    pub first_token_latency_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationStats {
    pub total_messages: u64,
    pub total_user_messages: u64,
    pub total_assistant_messages: u64,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_tokens: u64,
    pub avg_tokens_per_second: Option<f64>,
    pub avg_first_token_latency_ms: Option<f64>,
    pub avg_response_time_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagePage {
    pub messages: Vec<Message>,
    pub has_older: bool,
    pub oldest_message_id: Option<String>,
    pub total_active_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    #[serde(default)]
    pub id: String,
    pub file_type: String,
    pub file_name: String,
    #[serde(default)]
    pub file_path: String,
    pub file_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentInput {
    pub file_name: String,
    pub file_type: String,
    pub file_size: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSearchResult {
    pub conversation: Conversation,
    pub matched_message_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub conversation_id: String,
    pub summary_text: String,
    pub compressed_until_message_id: Option<String>,
    pub token_count: Option<u32>,
    pub model_used: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateConversationInput {
    pub title: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub is_pinned: Option<bool>,
    pub is_archived: Option<bool>,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub top_p: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub search_enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub search_provider_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub thinking_budget: Option<Option<i64>>,
    pub enabled_mcp_server_ids: Option<Vec<String>>,
    pub enabled_knowledge_base_ids: Option<Vec<String>>,
    pub enabled_memory_namespace_ids: Option<Vec<String>>,
    pub context_compression: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub category_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub parent_conversation_id: Option<Option<String>>,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationCategory {
    pub id: String,
    pub name: String,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub system_prompt: Option<String>,
    pub sort_order: i32,
    pub is_collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversationCategoryInput {
    pub name: String,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateConversationCategoryInput {
    pub name: Option<String>,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub system_prompt: Option<String>,
}

// === Gateway System ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayCertResult {
    pub cert_path: String,
    pub key_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatus {
    pub is_running: bool,
    pub listen_address: String,
    pub port: u16,
    pub ssl_enabled: bool,
    pub started_at: Option<i64>,
    /// HTTPS listener port; `None` when SSL is disabled or not yet started.
    pub https_port: Option<u16>,
    /// When `true` the gateway redirects all HTTP traffic to HTTPS.
    pub force_ssl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayKey {
    pub id: String,
    pub name: String,
    pub key_hash: String,
    pub key_prefix: String,
    pub enabled: bool,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub has_encrypted_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGatewayKeyResult {
    pub gateway_key: GatewayKey,
    pub plain_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayMetrics {
    pub total_requests: u64,
    pub total_tokens: u64,
    pub total_request_tokens: u64,
    pub total_response_tokens: u64,
    pub active_connections: u32,
    pub today_requests: u64,
    pub today_tokens: u64,
    pub today_request_tokens: u64,
    pub today_response_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageByKey {
    pub key_id: String,
    pub key_name: String,
    pub request_count: u64,
    pub token_count: u64,
    pub request_tokens: u64,
    pub response_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageByProvider {
    pub provider_id: String,
    pub provider_name: String,
    pub request_count: u64,
    pub token_count: u64,
    pub request_tokens: u64,
    pub response_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageByDay {
    pub date: String,
    pub request_count: u64,
    pub token_count: u64,
    pub request_tokens: u64,
    pub response_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedProgram {
    pub key_id: String,
    pub key_name: String,
    pub key_prefix: String,
    pub today_requests: u64,
    pub today_tokens: u64,
    pub today_request_tokens: u64,
    pub today_response_tokens: u64,
    pub last_active_at: Option<i64>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStats {
    pub total_requests: u64,
    pub active_connections: u32,
    pub uptime_seconds: u64,
    pub requests_per_minute: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewaySettings {
    pub listen_address: String,
    pub port: u16,
    pub load_balance_strategy: LoadBalanceStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadBalanceStrategy {
    RoundRobin,
}

// === Settings ===

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub language: String,
    pub theme_mode: String,
    pub primary_color: String,
    pub border_radius: u8,
    pub auto_start: bool,
    pub show_on_start: bool,
    pub minimize_to_tray: bool,
    pub font_size: u8,
    pub font_weight: u16,
    pub font_family: String,
    pub code_font_family: String,
    pub bubble_style: String,
    pub code_theme: String,
    pub default_provider_id: Option<String>,
    pub default_model_id: Option<String>,
    pub default_temperature: Option<f32>,
    pub default_max_tokens: Option<u32>,
    pub default_top_p: Option<f32>,
    pub default_frequency_penalty: Option<f32>,
    pub default_context_count: Option<u32>,
    pub title_summary_provider_id: Option<String>,
    pub title_summary_model_id: Option<String>,
    pub title_summary_temperature: Option<f32>,
    pub title_summary_max_tokens: Option<u32>,
    pub title_summary_top_p: Option<f32>,
    pub title_summary_frequency_penalty: Option<f32>,
    pub title_summary_context_count: Option<u32>,
    pub title_summary_prompt: Option<String>,
    pub compression_provider_id: Option<String>,
    pub compression_model_id: Option<String>,
    pub compression_temperature: Option<f32>,
    pub compression_max_tokens: Option<u32>,
    pub compression_top_p: Option<f32>,
    pub compression_frequency_penalty: Option<f32>,
    pub compression_prompt: Option<String>,
    pub proxy_type: Option<String>,
    pub proxy_address: Option<String>,
    pub proxy_port: Option<u16>,
    pub global_shortcut: String,
    pub shortcut_toggle_current_window: String,
    pub shortcut_toggle_all_windows: String,
    pub shortcut_close_window: String,
    pub shortcut_new_conversation: String,
    pub shortcut_open_settings: String,
    pub shortcut_toggle_model_selector: String,
    pub shortcut_fill_last_message: String,
    pub shortcut_clear_context: String,
    pub shortcut_clear_conversation_messages: String,
    pub shortcut_toggle_gateway: String,
    pub shortcut_toggle_mode: String,
    pub gateway_auto_start: bool,
    pub gateway_listen_address: String,
    pub gateway_port: u16,
    pub gateway_ssl_enabled: bool,
    pub gateway_ssl_mode: String,
    pub gateway_ssl_cert_path: Option<String>,
    pub gateway_ssl_key_path: Option<String>,
    pub gateway_ssl_port: u16,
    pub gateway_force_ssl: bool,
    pub always_on_top: bool,
    pub tray_enabled: bool,
    pub global_shortcuts_enabled: bool,
    pub shortcut_registration_logs_enabled: bool,
    pub shortcut_trigger_toast_enabled: bool,
    pub notifications_enabled: bool,
    pub mini_window_enabled: bool,
    pub start_minimized: bool,
    pub close_to_tray: bool,
    pub notify_backup: bool,
    pub notify_import: bool,
    pub notify_errors: bool,
    // Auto-backup settings
    pub backup_dir: Option<String>,
    pub auto_backup_enabled: bool,
    pub auto_backup_interval_hours: u32,
    pub auto_backup_max_count: u32,
    // WebDAV sync settings
    pub webdav_host: Option<String>,
    pub webdav_username: Option<String>,
    pub webdav_path: Option<String>,
    pub webdav_accept_invalid_certs: bool,
    pub webdav_sync_enabled: bool,
    pub webdav_sync_interval_minutes: u32,
    pub webdav_max_remote_backups: u32,
    pub webdav_include_documents: bool,
    pub last_selected_conversation_id: Option<String>,
    /// Auto update check interval in minutes (default 60, min 1).
    pub update_check_interval: u32,
    /// Global system prompt fallback — used when a conversation has no custom system prompt.
    pub default_system_prompt: Option<String>,
    /// Chat minimap / navigation overlay.
    pub chat_minimap_enabled: bool,
    pub chat_minimap_style: String,
    /// Multi-model response display mode: "tabs" | "side-by-side" | "stacked".
    pub multi_model_display_mode: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "zh-CN".to_string(),
            theme_mode: "system".to_string(),
            primary_color: "#17A93D".to_string(),
            border_radius: 8,
            auto_start: false,
            show_on_start: true,
            minimize_to_tray: true,
            font_size: 14,
            font_weight: 400,
            font_family: String::new(),
            code_font_family: String::new(),
            bubble_style: "minimal".to_string(),
            code_theme: "github-dark".to_string(),
            default_provider_id: None,
            default_model_id: None,
            default_temperature: None,
            default_max_tokens: None,
            default_top_p: None,
            default_frequency_penalty: None,
            default_context_count: None,
            title_summary_provider_id: None,
            title_summary_model_id: None,
            title_summary_temperature: None,
            title_summary_max_tokens: None,
            title_summary_top_p: None,
            title_summary_frequency_penalty: None,
            title_summary_context_count: None,
            title_summary_prompt: None,
            compression_provider_id: None,
            compression_model_id: None,
            compression_temperature: None,
            compression_max_tokens: None,
            compression_top_p: None,
            compression_frequency_penalty: None,
            compression_prompt: None,
            proxy_type: None,
            proxy_address: None,
            proxy_port: None,
            global_shortcut: "CommandOrControl+Shift+A".to_string(),
            shortcut_toggle_current_window: "CommandOrControl+Shift+A".to_string(),
            shortcut_toggle_all_windows: "CommandOrControl+Shift+Alt+A".to_string(),
            shortcut_close_window: "CommandOrControl+Shift+W".to_string(),
            shortcut_new_conversation: "CommandOrControl+N".to_string(),
            shortcut_open_settings: "CommandOrControl+Comma".to_string(),
            shortcut_toggle_model_selector: "CommandOrControl+Shift+M".to_string(),
            shortcut_fill_last_message: "CommandOrControl+Shift+ArrowUp".to_string(),
            shortcut_clear_context: "CommandOrControl+Shift+K".to_string(),
            shortcut_clear_conversation_messages: "CommandOrControl+Shift+Backspace".to_string(),
            shortcut_toggle_gateway: "CommandOrControl+Shift+G".to_string(),
            shortcut_toggle_mode: "Shift+Tab".to_string(),
            gateway_auto_start: false,
            gateway_listen_address: "127.0.0.1".to_string(),
            gateway_port: 8080,
            gateway_ssl_enabled: false,
            gateway_ssl_mode: "upload".to_string(),
            gateway_ssl_cert_path: None,
            gateway_ssl_key_path: None,
            gateway_ssl_port: 8443,
            gateway_force_ssl: false,
            always_on_top: false,
            tray_enabled: true,
            global_shortcuts_enabled: true,
            shortcut_registration_logs_enabled: false,
            shortcut_trigger_toast_enabled: false,
            notifications_enabled: true,
            mini_window_enabled: false,
            start_minimized: false,
            close_to_tray: true,
            notify_backup: true,
            notify_import: true,
            notify_errors: true,
            backup_dir: None,
            auto_backup_enabled: false,
            auto_backup_interval_hours: 24,
            auto_backup_max_count: 10,
            webdav_host: None,
            webdav_username: None,
            webdav_path: None,
            webdav_accept_invalid_certs: false,
            webdav_sync_enabled: false,
            webdav_sync_interval_minutes: 60,
            webdav_max_remote_backups: 10,
            webdav_include_documents: false,
            last_selected_conversation_id: None,
            update_check_interval: 60,
            default_system_prompt: None,
            chat_minimap_enabled: false,
            chat_minimap_style: "faq".to_string(),
            multi_model_display_mode: "tabs".to_string(),
        }
    }
}

// === Chat Streaming Types ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ChatTool>>,
    /// Optional thinking/reasoning token budget. Mapped to provider-specific fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budget: Option<u32>,
    /// When true, send `max_completion_tokens` instead of `max_tokens` (OpenAI o-series).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_max_completion_tokens: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTool {
    pub r#type: String,
    pub function: ChatToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolFunction {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
}

/// A single tool call requested by the AI model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    /// Provider-assigned ID (e.g., "call_abc123")
    pub id: String,
    /// Always "function" for now
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    /// JSON-encoded arguments string
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: ChatContent,
    /// For assistant messages: tool calls the model wants to make
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// For tool-result messages: the ID of the tool call this responds to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatContent {
    Text(String),
    Multipart(Vec<ContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentPart {
    pub r#type: String,
    pub text: Option<String>,
    pub image_url: Option<ImageUrl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub id: String,
    pub model: String,
    pub content: String,
    pub thinking: Option<String>,
    pub usage: TokenUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStreamChunk {
    pub content: Option<String>,
    pub thinking: Option<String>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_final: Option<bool>,
    pub usage: Option<TokenUsage>,
    /// Tool calls requested by the model (populated on the final content chunk or a dedicated chunk)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStreamEvent {
    pub conversation_id: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub chunk: ChatStreamChunk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStreamErrorEvent {
    pub conversation_id: String,
    pub message_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationTitleUpdatedEvent {
    pub conversation_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationTitleGeneratingEvent {
    pub conversation_id: String,
    pub generating: bool,
    /// Error message if generation failed
    pub error: Option<String>,
}

// === RAG Context Events ===

/// A single retrieved chunk from RAG search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagRetrievedItem {
    pub content: String,
    pub score: f32,
    pub document_id: String,
    /// Chunk ID within the vector store.
    #[serde(default)]
    pub id: String,
    /// Human-readable document name (populated for knowledge items).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_name: Option<String>,
}

/// Results from a single RAG source (knowledge base or memory namespace).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagSourceResult {
    /// "knowledge" or "memory"
    pub source_type: String,
    pub container_id: String,
    pub items: Vec<RagRetrievedItem>,
}

/// Combined results of RAG context collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagContextResult {
    /// Formatted context parts for injection into system prompt.
    pub context_parts: Vec<String>,
    /// Structured results for frontend display.
    pub source_results: Vec<RagSourceResult>,
}

/// Tauri event emitted after RAG context retrieval completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagContextRetrievedEvent {
    pub conversation_id: String,
    pub sources: Vec<RagSourceResult>,
}

// === Embedding Types ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedRequest {
    pub model: String,
    pub input: Vec<String>,
    pub dimensions: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedResponse {
    pub embeddings: Vec<Vec<f32>>,
    pub dimensions: usize,
}

// === Realtime Voice ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RealtimeConfig {
    pub model_id: String,
    pub voice: Option<String>,
    pub audio_format: AudioFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u8,
    pub encoding: AudioEncoding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AudioEncoding {
    Pcm16,
    Opus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum VoiceSessionState {
    Idle,
    Connecting,
    Connected,
    Speaking,
    Listening,
    Disconnecting,
}

// ─── Phase-2 Types ───────────────────────────────────────────────

// Search
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProvider {
    pub id: String,
    pub name: String,
    pub provider_type: String, // tavily | zhipu | bocha
    pub endpoint: Option<String>,
    pub has_api_key: bool,
    pub enabled: bool,
    pub region: Option<String>,
    pub language: Option<String>,
    pub safe_search: Option<bool>,
    pub result_limit: i32,
    pub timeout_ms: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCitation {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
    pub provider_id: String,
    pub rank: i32,
}

// MCP & Tools
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: String, // stdio | http | sse
    pub command: Option<String>,
    pub args_json: Option<String>,
    pub endpoint: Option<String>,
    pub env_json: Option<String>,
    pub enabled: bool,
    pub permission_policy: String, // ask | allow_safe | allow_all
    pub source: String,            // builtin | custom
    pub discover_timeout_secs: Option<i32>,
    pub execute_timeout_secs: Option<i32>,
    pub headers_json: Option<String>,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub description: Option<String>,
    pub input_schema_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecution {
    pub id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub server_id: String,
    pub tool_name: String,
    pub status: String, // pending | running | success | failed | cancelled
    pub input_preview: Option<String>,
    pub output_preview: Option<String>,
    pub error_message: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
    pub approval_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub conversation_id: String,
    pub cwd: Option<String>,
    pub permission_mode: String,
    pub runtime_status: String,
    pub sdk_context_json: Option<String>,
    pub sdk_context_backup_json: Option<String>,
    pub total_tokens: i32,
    pub total_cost_usd: f64,
    pub created_at: String,
    pub updated_at: String,
}

// Knowledge
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub embedding_provider: Option<String>,
    pub enabled: bool,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub sort_order: i32,
    pub embedding_dimensions: Option<i32>,
    pub retrieval_threshold: Option<f32>,
    pub retrieval_top_k: Option<i32>,
    pub chunk_size: Option<i32>,
    pub chunk_overlap: Option<i32>,
    pub separator: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    pub id: String,
    pub knowledge_base_id: String,
    pub title: String,
    pub source_path: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub indexing_status: String, // pending | indexing | ready | failed
    pub doc_type: String,        // file | url | text | ...
    pub index_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalHit {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub knowledge_base_id: String,
    pub document_id: String,
    pub chunk_ref: String,
    pub score: f64,
    pub preview: String,
}

// Memory
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryNamespace {
    pub id: String,
    pub name: String,
    pub scope: String, // global | project
    pub embedding_provider: Option<String>,
    pub embedding_dimensions: Option<i32>,
    pub retrieval_threshold: Option<f32>,
    pub retrieval_top_k: Option<i32>,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub namespace_id: String,
    pub title: String,
    pub content: String,
    pub source: String,      // manual | auto_extract
    pub index_status: String, // pending | indexing | ready | failed | skipped
    pub index_error: Option<String>,
    pub updated_at: String,
}

// Artifacts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub conversation_id: String,
    pub kind: String, // draft | note | report | snippet | checklist
    pub title: String,
    pub content: String,
    pub format: String, // markdown | text | json
    pub pinned: bool,
    pub updated_at: String,
}

// Context Sources
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSource {
    pub id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    #[serde(rename = "type")]
    pub source_type: String, // app | attachment | search | knowledge | memory | tool
    pub ref_id: String,
    pub title: String,
    pub enabled: bool,
    pub summary: Option<String>,
}

// Conversation Branches
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationBranch {
    pub id: String,
    pub conversation_id: String,
    pub parent_message_id: String,
    pub branch_label: String,
    pub branch_index: i32,
    pub compared_message_ids_json: Option<String>,
    pub created_at: String,
}

// Backup & Migration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub id: String,
    pub version: String,
    pub created_at: String,
    pub encrypted: bool,
    pub checksum: String,
    pub object_counts_json: String,
    pub source_app_version: String,
    pub file_path: Option<String>,
    pub file_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTarget {
    pub id: String,
    pub kind: String, // local | webdav | s3
    pub config_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupSettings {
    pub enabled: bool,
    pub interval_hours: u32,
    pub max_count: u32,
    pub backup_dir: Option<String>,
}

// Gateway Phase-2
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramPolicy {
    pub id: String,
    pub program_name: String,
    pub allowed_provider_ids_json: String,
    pub allowed_model_ids_json: String,
    pub default_provider_id: Option<String>,
    pub default_model_id: Option<String>,
    pub rate_limit_per_minute: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayDiagnostic {
    pub id: String,
    pub category: String, // provider_latency | provider_error | proxy | auth | port
    pub status: String,   // ok | warning | error
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRequestLog {
    pub id: String,
    pub key_id: String,
    pub key_name: String,
    pub method: String,
    pub path: String,
    pub model: Option<String>,
    pub provider_id: Option<String>,
    pub status_code: i32,
    pub duration_ms: i32,
    pub request_tokens: i32,
    pub response_tokens: i32,
    pub error_message: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayTemplate {
    pub id: String,
    pub name: String,
    pub target: String, // cursor | vscode | claude_code | openai_compatible
    pub format: String, // json | yaml | markdown
    pub content: String,
    pub copy_hint: Option<String>,
}

// CLI Tool Integration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliToolInfo {
    pub id: String,
    pub name: String,
    pub status: String, // not_installed | not_connected | connected
    pub version: Option<String>,
    pub config_path: Option<String>,
    pub has_backup: bool,
    pub connected_protocol: Option<String>,
}

// Desktop
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub window_key: String, // main | mini | voice | artifact
    pub width: i32,
    pub height: i32,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub maximized: bool,
    pub visible: bool,
}

// ─── Phase-2 Input Types (non-FromRow) ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateSearchProviderInput {
    pub name: String,
    pub provider_type: String,
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
    pub enabled: Option<bool>,
    pub region: Option<String>,
    pub language: Option<String>,
    pub safe_search: Option<bool>,
    pub result_limit: Option<i32>,
    pub timeout_ms: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateMcpServerInput {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub endpoint: Option<String>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub enabled: Option<bool>,
    pub permission_policy: Option<String>,
    pub source: Option<String>,
    pub discover_timeout_secs: Option<i32>,
    pub execute_timeout_secs: Option<i32>,
    pub headers_json: Option<String>,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArtifactInput {
    pub conversation_id: String,
    pub source_message_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateArtifactInput {
    pub title: Option<String>,
    pub content: Option<String>,
    pub format: Option<String>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateContextSourceInput {
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub source_type: String,
    pub ref_id: String,
    pub title: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBackupJobInput {
    pub target_kind: String,
    pub target_config_json: String,
    pub include_attachments: bool,
    pub include_knowledge_files: bool,
    pub include_gateway_config: bool,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourceInput {
    pub source_type: String,
    pub path: String,
    pub credentials_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPolicyInput {
    pub duplicate_strategy: String, // skip | rename | overwrite
    pub merge_settings: bool,
    pub merge_apps: bool,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProgramPolicyInput {
    pub program_name: String,
    pub allowed_provider_ids: Vec<String>,
    pub allowed_model_ids: Vec<String>,
    pub default_provider_id: Option<String>,
    pub default_model_id: Option<String>,
    pub rate_limit_per_minute: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateKnowledgeBaseInput {
    pub name: String,
    pub description: Option<String>,
    pub embedding_provider: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateKnowledgeBaseInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub embedding_provider: Option<String>,
    pub enabled: Option<bool>,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    #[serde(default)]
    pub update_icon: bool,
    pub embedding_dimensions: Option<i32>,
    #[serde(default)]
    pub update_embedding_dimensions: bool,
    pub retrieval_threshold: Option<f32>,
    #[serde(default)]
    pub update_retrieval_threshold: bool,
    pub retrieval_top_k: Option<i32>,
    #[serde(default)]
    pub update_retrieval_top_k: bool,
    pub chunk_size: Option<i32>,
    #[serde(default)]
    pub update_chunk_size: bool,
    pub chunk_overlap: Option<i32>,
    #[serde(default)]
    pub update_chunk_overlap: bool,
    pub separator: Option<String>,
    #[serde(default)]
    pub update_separator: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMemoryNamespaceInput {
    pub name: String,
    pub scope: String,
    pub embedding_provider: Option<String>,
    pub embedding_dimensions: Option<i32>,
    pub retrieval_threshold: Option<f32>,
    pub retrieval_top_k: Option<i32>,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemoryNamespaceInput {
    pub name: Option<String>,
    pub embedding_provider: Option<String>,
    #[serde(default)]
    pub update_embedding_provider: bool,
    pub embedding_dimensions: Option<i32>,
    #[serde(default)]
    pub update_embedding_dimensions: bool,
    pub retrieval_threshold: Option<f32>,
    #[serde(default)]
    pub update_retrieval_threshold: bool,
    pub retrieval_top_k: Option<i32>,
    #[serde(default)]
    pub update_retrieval_top_k: bool,
    pub icon_type: Option<String>,
    pub icon_value: Option<String>,
    #[serde(default)]
    pub update_icon: bool,
    pub sort_order: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMemoryItemInput {
    pub namespace_id: String,
    pub title: String,
    pub content: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemoryItemInput {
    pub title: Option<String>,
    pub content: Option<String>,
}

// ── Skills ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub author: Option<String>,
    pub version: Option<String>,
    pub source: String,
    pub source_path: String,
    pub enabled: bool,
    pub has_update: bool,
    pub user_invocable: bool,
    pub argument_hint: Option<String>,
    pub when_to_use: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub info: SkillInfo,
    pub content: String,
    pub files: Vec<String>,
    pub manifest: Option<SkillManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub installed_at: String,
    pub installed_via: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateInfo {
    pub name: String,
    pub current_commit: String,
    pub latest_commit: String,
    pub source_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSkill {
    pub name: String,
    pub description: String,
    pub repo: String,
    pub stars: i64,
    pub installs: i64,
    pub installed: bool,
}
