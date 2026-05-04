// === Provider System ===
export type ProviderType =
  | 'openai'
  | 'openai_responses'
  | 'deepseek'
  | 'xai'
  | 'glm'
  | 'siliconflow'
  | 'anthropic'
  | 'gemini'
  | 'jina'
  | 'cohere'
  | 'voyage'
  | 'custom';

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
  custom_headers: string | null;
  icon: string | null;
  builtin_id: string | null;
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
  provider_type?: ProviderType;
  api_host?: string;
  api_path?: string | null;
  enabled?: boolean;
  proxy_config?: ProviderProxyConfig;
  custom_headers?: string | null;
  icon?: string | null;
  sort_order?: number;
}

export interface DeepLinkProviderImportInput {
  name: string;
  baseurl: string;
  apikey: string;
  type: ProviderType;
}

export interface DeepLinkProviderImportResult {
  provider_id: string;
  provider_name: string;
  created_provider: boolean;
  added_key: boolean;
  reused_key: boolean;
}

// === Model System ===
export type ModelCapability = 'TextChat' | 'Vision' | 'FunctionCalling' | 'Reasoning' | 'RealtimeVoice';
export type ModelType = 'Chat' | 'Voice' | 'Embedding' | 'Image' | 'Rerank';

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
  use_max_completion_tokens?: boolean;
  no_system_role?: boolean;
  force_max_tokens?: boolean;
  thinking_param_style?: string;
  reasoning_profile?: string;
  reasoning_options?: string[];
  reasoning_default?: string;
}

// === Conversation & Message ===
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ConversationCategory {
  id: string;
  name: string;
  icon_type: string | null;
  icon_value: string | null;
  system_prompt: string | null;
  default_provider_id: string | null;
  default_model_id: string | null;
  default_temperature: number | null;
  default_max_tokens: number | null;
  default_top_p: number | null;
  default_frequency_penalty: number | null;
  sort_order: number;
  is_collapsed: boolean;
  created_at: number;
  updated_at: number;
}

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
  thinking_level?: string | null;
  enabled_mcp_server_ids: string[];
  enabled_knowledge_base_ids: string[];
  enabled_memory_namespace_ids: string[];
  is_pinned: boolean;
  is_archived: boolean;
  context_compression: boolean;
  category_id: string | null;
  parent_conversation_id: string | null;
  mode?: 'chat' | 'agent';
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
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  attachments: Attachment[];
  thinking: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  created_at: number;
  parent_message_id: string | null;
  version_index: number;
  is_active: boolean;
  status: 'complete' | 'partial' | 'error';
  tokens_per_second?: number | null;
  first_token_latency_ms?: number | null;
}

export interface MessagePage {
  messages: Message[];
  has_older: boolean;
  oldest_message_id: string | null;
  total_active_count: number;
}

export interface ConversationStats {
  total_messages: number;
  total_user_messages: number;
  total_assistant_messages: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  avg_tokens_per_second: number | null;
  avg_first_token_latency_ms: number | null;
  avg_response_time_ms: number | null;
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

export interface ConversationSummary {
  id: string;
  conversation_id: string;
  summary_text: string;
  compressed_until_message_id: string | null;
  token_count: number | null;
  model_used: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpdateConversationInput {
  title?: string;
  provider_id?: string;
  model_id?: string;
  is_pinned?: boolean;
  is_archived?: boolean;
  system_prompt?: string;
  temperature?: number | null;
  max_tokens?: number | null;
  top_p?: number | null;
  frequency_penalty?: number | null;
  search_enabled?: boolean;
  search_provider_id?: string | null;
  thinking_budget?: number | null;
  thinking_level?: string | null;
  enabled_mcp_server_ids?: string[];
  enabled_knowledge_base_ids?: string[];
  enabled_memory_namespace_ids?: string[];
  context_compression?: boolean;
  category_id?: string | null;
  mode?: 'chat' | 'agent';
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
  font_weight: number;
  font_family: string;
  code_font_family: string;
  bubble_style: string;
  code_theme: string;
  code_theme_light: string;
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
  compression_provider_id: string | null;
  compression_model_id: string | null;
  compression_temperature: number | null;
  compression_max_tokens: number | null;
  compression_top_p: number | null;
  compression_frequency_penalty: number | null;
  compression_prompt: string | null;
  proxy_type: string | null;
  proxy_address: string | null;
  proxy_port: number | null;
  global_shortcut: string;
  shortcut_toggle_current_window: string;
  shortcut_toggle_all_windows: string;
  shortcut_close_window: string;
  shortcut_new_conversation: string;
  shortcut_send_message: string;
  shortcut_open_settings: string;
  shortcut_toggle_model_selector: string;
  shortcut_fill_last_message: string;
  shortcut_clear_context: string;
  shortcut_clear_conversation_messages: string;
  shortcut_toggle_gateway: string;
  shortcut_toggle_mode: string;
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
  // WebDAV sync settings
  webdav_host?: string | null;
  webdav_username?: string | null;
  webdav_path?: string | null;
  webdav_accept_invalid_certs?: boolean;
  webdav_sync_enabled?: boolean;
  webdav_sync_interval_minutes?: number;
  webdav_max_remote_backups?: number;
  webdav_include_documents?: boolean;
  last_selected_conversation_id?: string | null;
  /** Custom documents root override (overrides ~/Documents/aqbot/) */
  documents_root_override?: string | null;
  /** Auto update check interval in minutes (default 60, min 1) */
  update_check_interval?: number;
  /** Global system prompt fallback — used when a conversation has no custom system prompt */
  default_system_prompt?: string | null;
  /** Chat minimap / navigation overlay */
  chat_minimap_enabled?: boolean;
  chat_minimap_style?: 'faq' | 'sticky';
  /** Include Image models in the conversation model selector. Default: false */
  show_image_models_in_model_selector?: boolean;
  /** Multi-model response display mode */
  multi_model_display_mode?: 'tabs' | 'side-by-side' | 'stacked';
  /** Render user messages as Markdown (like AI messages). Default: false */
  render_user_markdown?: boolean;
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
  model_id?: string;
  provider_id?: string;
  chunk: ChatStreamChunk;
}

export interface ChatStreamErrorEvent {
  conversation_id: string;
  message_id: string;
  model_id?: string;
  provider_id?: string;
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
export type PageKey = 'chat' | 'drawing' | 'knowledge' | 'memory' | 'gateway' | 'files' | 'settings' | 'skills';

// === Drawing ===
export type DrawingModelId = 'gpt-image-2' | 'gpt-image-1.5' | 'gpt-image-1' | 'gpt-image-1-mini';
export type DrawingAction = 'generate' | 'reference_generate' | 'edit' | 'mask_edit';
export type DrawingStatus = 'running' | 'succeeded' | 'failed';
export type DrawingQuality = 'low' | 'medium' | 'high' | 'auto';
export type DrawingOutputFormat = 'png' | 'jpeg' | 'webp';
export type DrawingBackground = 'auto' | 'opaque' | 'transparent';

export interface DrawingSettings {
  providerId: string;
  modelId: DrawingModelId;
  size: string;
  quality: DrawingQuality;
  outputFormat: DrawingOutputFormat;
  background: DrawingBackground;
  outputCompression?: number;
  n: number;
}

export interface DrawingStoredFile {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
}

export interface DrawingImage {
  id: string;
  generation_id: string;
  stored_file_id: string;
  storage_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  revised_prompt: string | null;
  created_at: number;
}

export interface DrawingGeneration {
  id: string;
  parent_generation_id: string | null;
  provider_id: string;
  key_id: string;
  model_id: DrawingModelId | string;
  api_kind: 'image_api';
  action: DrawingAction;
  prompt: string;
  parameters_json: string;
  reference_file_ids_json: string;
  source_image_ids_json: string;
  mask_file_id: string | null;
  status: DrawingStatus;
  error_message: string | null;
  response_id: string | null;
  usage_json: string | null;
  created_at: number;
  completed_at: number | null;
  images: DrawingImage[];
  reference_files?: DrawingStoredFile[];
  source_images?: DrawingImage[];
  mask_file?: DrawingStoredFile | null;
}

export interface DrawingGenerateInput {
  provider_id: string;
  model_id: DrawingModelId;
  prompt: string;
  size: string;
  quality: DrawingQuality;
  output_format: DrawingOutputFormat;
  background: DrawingBackground;
  output_compression?: number;
  n: number;
  reference_file_ids: string[];
}

export interface DrawingEditInput extends DrawingGenerateInput {
  source_image_id: string;
}

export interface DrawingMaskEditInput extends DrawingEditInput {
  mask_file_id: string;
}
export type SettingsSection = 'providers' | 'defaultModel' | 'conversationSettings' | 'general' | 'display' | 'proxy' | 'shortcuts' | 'data' | 'storage' | 'about' | 'searchProviders' | 'mcpServers' | 'backup';

// === Files Module ===
export type FileCategory = 'images' | 'files';

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

// ── Skills ─────────────────────────────────────────────────────────────
export interface Skill {
  name: string;
  description: string;
  author?: string;
  version?: string;
  source: 'builtin' | 'aqbot' | 'claude' | 'agents' | 'project';
  sourcePath: string;
  enabled: boolean;
  hasUpdate: boolean;
  userInvocable: boolean;
  argumentHint?: string;
  whenToUse?: string;
  group?: string;
}

export interface SkillDetail {
  info: Skill;
  content: string;
  files: string[];
  manifest?: SkillManifest;
}

export interface SkillManifest {
  sourceKind: string;
  sourceRef?: string;
  branch?: string;
  commit?: string;
  installedAt: string;
  installedVia?: string;
}

export interface MarketplaceSkill {
  name: string;
  description: string;
  repo: string;
  stars: number;
  installs: number;
  installed: boolean;
}

export interface SkillUpdateInfo {
  name: string;
  currentCommit: string;
  latestCommit: string;
  sourceRef: string;
}

// Phase-2 type modules
export * from './search';
export * from './mcp';
export * from './knowledge';
export * from './memory';
export * from './artifact';
export * from './backup';
export * from './workspace';
export * from './agent';
