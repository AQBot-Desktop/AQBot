// === Provider System ===
export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  provider_type: ProviderType;
  api_host: string;
  api_path: string | null;
  enabled: boolean;
  models: Model[];
  keys: ProviderKey[];
  proxy_config: ProviderProxyConfig | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface ProviderKey {
  id: string;
  provider_id: string;
  key_encrypted: string;
  key_prefix: string;
  enabled: boolean;
  last_validated_at: number | null;
  last_error: string | null;
  rotation_index: number;
  created_at: number;
}

export interface ProviderProxyConfig {
  proxy_type: string | null;
  proxy_address: string | null;
  proxy_port: number | null;
}

export interface CreateProviderInput {
  name: string;
  provider_type: ProviderType;
  api_host: string;
  api_path?: string | null;
  enabled: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  api_host?: string;
  api_path?: string | null;
  enabled?: boolean;
  proxy_config?: ProviderProxyConfig;
  sort_order?: number;
}

// === Model System ===
export type ModelCapability = 'TextChat' | 'Vision' | 'FunctionCalling' | 'Reasoning' | 'RealtimeVoice';
export type ModelType = 'Chat' | 'Voice' | 'Embedding';

export interface Model {
  provider_id: string;
  model_id: string;
  name: string;
  group_name?: string | null;
  model_type: ModelType;
  capabilities: ModelCapability[];
  max_tokens: number | null;
  enabled: boolean;
  param_overrides: ModelParamOverrides | null;
}

export interface ModelParamOverrides {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
}

// === Conversation & Message ===
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Conversation {
  id: string;
  title: string;
  model_id: string;
  provider_id: string;
  system_prompt: string | null;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  frequency_penalty: number | null;
  search_enabled: boolean;
  search_provider_id: string | null;
  thinking_budget: number | null;
  enabled_mcp_server_ids: string[];
  enabled_knowledge_base_ids: string[];
  enabled_memory_namespace_ids: string[];
  is_pinned: boolean;
  is_archived: boolean;
  message_count: number;
  created_at: number;
  updated_at: number;
}

export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  provider_id: string | null;
  model_id: string | null;
  token_count: number | null;
  attachments: Attachment[];
  thinking: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  created_at: number;
  parent_message_id: string | null;
  version_index: number;
  is_active: boolean;
}

export interface MessagePage {
  messages: Message[];
  has_older: boolean;
  oldest_message_id: string | null;
}

export interface Attachment {
  id: string;
  file_type: string;
  file_name: string;
  file_path: string;
  file_size: number;
  data?: string;
}

export interface AttachmentInput {
  file_name: string;
  file_type: string;
  file_size: number;
  data: string;
}

export interface ConversationSearchResult {
  conversation: Conversation;
  matched_message_preview: string | null;
}

export interface UpdateConversationInput {
  title?: string;
  provider_id?: string;
  model_id?: string;
  is_pinned?: boolean;
  is_archived?: boolean;
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  search_enabled?: boolean;
  search_provider_id?: string | null;
  thinking_budget?: number | null;
  enabled_mcp_server_ids?: string[];
  enabled_knowledge_base_ids?: string[];
  enabled_memory_namespace_ids?: string[];
}

// === Gateway System ===
export interface GatewayStatus {
  is_running: boolean;
  listen_address: string;
  port: number;
  ssl_enabled: boolean;
  started_at: number | null;
  /** HTTPS listener port; `null` when SSL is disabled or not yet started. */
  https_port: number | null;
  /** When `true` the gateway redirects all HTTP traffic to HTTPS. */
  force_ssl: boolean;
}

export interface GatewayKey {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  enabled: boolean;
  created_at: number;
  last_used_at: number | null;
  has_encrypted_key: boolean;
}

export interface CreateGatewayKeyResult {
  gateway_key: GatewayKey;
  plain_key: string;
}

export interface GatewayMetrics {
  total_requests: number;
  total_tokens: number;
  total_request_tokens: number;
  total_response_tokens: number;
  active_connections: number;
  today_requests: number;
  today_tokens: number;
  today_request_tokens: number;
  today_response_tokens: number;
}

export interface UsageByKey {
  key_id: string;
  key_name: string;
  request_count: number;
  token_count: number;
  request_tokens: number;
  response_tokens: number;
}

export interface UsageByProvider {
  provider_id: string;
  provider_name: string;
  request_count: number;
  token_count: number;
  request_tokens: number;
  response_tokens: number;
}

export interface UsageByDay {
  date: string;
  request_count: number;
  token_count: number;
  request_tokens: number;
  response_tokens: number;
}

export interface ConnectedProgram {
  key_id: string;
  key_name: string;
  key_prefix: string;
  today_requests: number;
  today_tokens: number;
  today_request_tokens: number;
  today_response_tokens: number;
  last_active_at: number | null;
  is_active: boolean;
}

export interface GatewayStats {
  total_requests: number;
  active_connections: number;
  uptime_seconds: number;
  requests_per_minute: number;
}

export interface GatewaySettings {
  listen_address: string;
  port: number;
  load_balance_strategy: 'round_robin';
}

// === Settings ===
export interface AppSettings {
  language: string;
  theme_mode: string;
  primary_color: string;
  border_radius: number;
  auto_start: boolean;
  show_on_start: boolean;
  minimize_to_tray: boolean;
  font_size: number;
  bubble_style: string;
  code_theme: string;
  default_provider_id: string | null;
  default_model_id: string | null;
  default_temperature: number | null;
  default_max_tokens: number | null;
  default_top_p: number | null;
  default_frequency_penalty: number | null;
  default_context_count: number | null;
  title_summary_provider_id: string | null;
  title_summary_model_id: string | null;
  title_summary_temperature: number | null;
  title_summary_max_tokens: number | null;
  title_summary_top_p: number | null;
  title_summary_frequency_penalty: number | null;
  title_summary_context_count: number | null;
  title_summary_prompt: string | null;
  proxy_type: string | null;
  proxy_address: string | null;
  proxy_port: number | null;
  global_shortcut: string;
  shortcut_toggle_current_window: string;
  shortcut_toggle_all_windows: string;
  shortcut_close_window: string;
  shortcut_new_conversation: string;
  shortcut_open_settings: string;
  shortcut_toggle_model_selector: string;
  shortcut_fill_last_message: string;
  shortcut_clear_context: string;
  shortcut_clear_conversation_messages: string;
  shortcut_toggle_gateway: string;
  gateway_auto_start: boolean;
  gateway_listen_address: string;
  gateway_port: number;
  gateway_ssl_enabled: boolean;
  gateway_ssl_mode: string;
  gateway_ssl_cert_path: string | null;
  gateway_ssl_key_path: string | null;
  gateway_ssl_port: number;
  gateway_force_ssl: boolean;
  // Desktop integration
  always_on_top?: boolean;
  tray_enabled?: boolean;
  global_shortcuts_enabled?: boolean;
  shortcut_registration_logs_enabled?: boolean;
  shortcut_trigger_toast_enabled?: boolean;
  notifications_enabled?: boolean;
  mini_window_enabled?: boolean;
  start_minimized?: boolean;
  close_to_tray?: boolean;
  notify_backup?: boolean;
  notify_import?: boolean;
  notify_errors?: boolean;
}

// === Streaming ===
export interface ChatStreamChunk {
  content: string | null;
  thinking: string | null;
  tool_calls: ToolCall[] | null;
  done: boolean;
  is_final?: boolean | null;
  usage: TokenUsage | null;
}

export interface ChatStreamEvent {
  conversation_id: string;
  message_id: string;
  chunk: ChatStreamChunk;
}

export interface ChatStreamErrorEvent {
  conversation_id: string;
  message_id: string;
  error: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// === Voice ===
export type VoiceSessionState = 'Idle' | 'Connecting' | 'Connected' | 'Speaking' | 'Listening' | 'Disconnecting';

export type AudioEncoding = 'Pcm16' | 'Opus';

export interface AudioFormat {
  sample_rate: number;
  channels: number;
  encoding: AudioEncoding;
}

export interface RealtimeConfig {
  model_id: string;
  voice: string | null;
  audio_format: AudioFormat;
}

// === UI State ===
export type PageKey = 'chat' | 'gateway' | 'files' | 'settings';
export type SettingsSection = 'providers' | 'defaultModel' | 'general' | 'display' | 'proxy' | 'shortcuts' | 'data' | 'storage' | 'about' | 'searchProviders' | 'mcpServers' | 'knowledge' | 'memory' | 'backup';

// === Files Module ===
export type FileCategory = 'images' | 'files' | 'backups';

export type FileSortKey = 'createdAt' | 'size' | 'name';

export interface FileRow {
  id: string;
  name: string;
  path: string;
  storagePath?: string;
  size?: number;
  createdAt?: string;
  category?: FileCategory;
  hasThumbnail?: boolean;
  previewUrl?: string;
  missing?: boolean;
}

export interface FilesPageEntry {
  id: string;
  sourceKind: string;
  category: FileCategory;
  displayName: string;
  path: string;
  storagePath?: string | null;
  sizeBytes: number;
  createdAt: string;
  missing: boolean;
  previewUrl?: string | null;
}

// Phase-2 type modules
export * from './search';
export * from './mcp';
export * from './knowledge';
export * from './memory';
export * from './artifact';
export * from './backup';
export * from './workspace';
