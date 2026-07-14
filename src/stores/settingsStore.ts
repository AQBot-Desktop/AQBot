import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import {
  DEFAULT_AGENT_WORKSPACE_DATETIME_FORMAT,
  DEFAULT_AGENT_WORKSPACE_NAME_STRATEGY,
  DEFAULT_MCP_TOOL_LOOP_MAX_ITERATIONS,
  type AppSettings,
} from '@/types';
import { DEFAULT_SHORTCUT_BINDINGS } from '@/lib/shortcuts';

const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh-CN',
  theme_mode: 'system',
  primary_color: '#17A93D',
  border_radius: 8,
  auto_start: false,
  show_on_start: true,
  minimize_to_tray: true,
  font_size: 14,
  font_weight: 400,
  font_family: '',
  code_font_family: '',
  chat_font_size: 15,
  chat_line_height: 1.7,
  chat_font_family: '',
  chat_font_weight: 400,
  bubble_style: 'minimal',
  chat_user_message_area_style: 'none',
  chat_user_message_area_light_color: 'rgba(0, 0, 0, 0)',
  chat_user_message_area_dark_color: 'rgba(0, 0, 0, 0)',
  chat_user_message_area_border_width: 1,
  chat_ai_message_area_style: 'none',
  chat_ai_message_area_light_color: '#f5f5f5',
  chat_ai_message_area_dark_color: 'rgba(255, 255, 255, 0.06)',
  chat_ai_message_area_border_width: 1,
  code_theme: 'poimandres',
  code_theme_light: 'github-light',
  default_provider_id: null,
  default_model_id: null,
  default_temperature: null,
  default_max_tokens: null,
  default_top_p: null,
  default_frequency_penalty: null,
  default_context_count: null,
  title_summary_provider_id: null,
  title_summary_model_id: null,
  title_summary_temperature: null,
  title_summary_max_tokens: null,
  title_summary_top_p: null,
  title_summary_frequency_penalty: null,
  title_summary_context_count: null,
  title_summary_prompt: null,
  compression_provider_id: null,
  compression_model_id: null,
  compression_temperature: null,
  compression_max_tokens: null,
  compression_top_p: null,
  compression_frequency_penalty: null,
  compression_prompt: null,
  proxy_type: null,
  proxy_address: null,
  proxy_port: null,
  global_shortcut: DEFAULT_SHORTCUT_BINDINGS.toggleCurrentWindow,
  shortcut_toggle_current_window: DEFAULT_SHORTCUT_BINDINGS.toggleCurrentWindow,
  shortcut_toggle_all_windows: DEFAULT_SHORTCUT_BINDINGS.toggleAllWindows,
  shortcut_close_window: DEFAULT_SHORTCUT_BINDINGS.closeWindow,
  shortcut_new_conversation: DEFAULT_SHORTCUT_BINDINGS.newConversation,
  shortcut_send_message: DEFAULT_SHORTCUT_BINDINGS.sendMessage,
  shortcut_open_settings: DEFAULT_SHORTCUT_BINDINGS.openSettings,
  shortcut_toggle_model_selector: DEFAULT_SHORTCUT_BINDINGS.toggleModelSelector,
  shortcut_toggle_chat_sidebar: DEFAULT_SHORTCUT_BINDINGS.toggleChatSidebar,
  shortcut_fill_last_message: DEFAULT_SHORTCUT_BINDINGS.fillLastMessage,
  shortcut_clear_context: DEFAULT_SHORTCUT_BINDINGS.clearContext,
  shortcut_clear_conversation_messages: DEFAULT_SHORTCUT_BINDINGS.clearConversationMessages,
  shortcut_toggle_gateway: DEFAULT_SHORTCUT_BINDINGS.toggleGateway,
  shortcut_toggle_mode: DEFAULT_SHORTCUT_BINDINGS.toggleMode,
  gateway_auto_start: false,
  gateway_listen_address: '127.0.0.1',
  gateway_port: 8080,
  gateway_ssl_enabled: false,
  gateway_ssl_mode: 'upload',
  gateway_ssl_cert_path: null,
  gateway_ssl_key_path: null,
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
  release_webview_on_tray: false,
  notify_backup: true,
  notify_import: true,
  notify_errors: true,
  last_selected_conversation_id: null,
  documents_root_override: null,
  update_check_interval: 60,
  default_system_prompt: null,
  chat_minimap_enabled: false,
  chat_minimap_style: 'faq',
  chat_sidebar_collapsed: false,
  inherit_conversation_preferences_on_create: true,
  chat_stream_first_packet_timeout_secs: 180,
  chat_stream_idle_timeout_secs: 90,
  mcp_tool_loop_max_iterations: DEFAULT_MCP_TOOL_LOOP_MAX_ITERATIONS,
  document_attachment_reading_enabled: false,
  show_image_models_in_model_selector: false,
  multi_model_display_mode: 'tabs',
  render_user_markdown: false,
  agent_workspace_root: null,
  agent_workspace_name_strategy: DEFAULT_AGENT_WORKSPACE_NAME_STRATEGY,
  agent_workspace_datetime_format: DEFAULT_AGENT_WORKSPACE_DATETIME_FORMAT,
  agent_bash_path: null,
  // WebDAV sync settings — must be present so stale saves never omit them
  webdav_host: null,
  webdav_username: null,
  webdav_path: null,
  webdav_accept_invalid_certs: false,
  webdav_sync_enabled: false,
  webdav_sync_interval_minutes: 60,
  webdav_max_remote_backups: 10,
  webdav_include_documents: false,
  // S3 sync settings — must be present so stale saves never omit them
  s3_bucket: null,
  s3_region: 'us-east-1',
  s3_endpoint: null,
  s3_prefix: 'aqbot/',
  s3_force_path_style: false,
  s3_use_default_credentials: false,
  s3_sync_enabled: false,
  s3_sync_interval_minutes: 60,
  s3_max_remote_backups: 10,
  s3_include_documents: false,
};

export interface GlobalShortcutDiagnostic {
  timestamp: string;
  phase: 'env' | 'register' | 'cleanup';
  level: 'info' | 'warn' | 'error';
  message: string;
  action?: string;
  shortcut?: string;
  reason?: string;
}

export interface GlobalShortcutStatus {
  enabled: boolean;
  registered: string[];
  failed: Array<{ shortcut: string; reason: string }>;
  diagnostics: GlobalShortcutDiagnostic[];
}

interface SettingsState {
  settings: AppSettings;
  loading: boolean;
  /** Set once after the first successful fetchSettings; guards saveSettings from writing stale data. */
  _loaded: boolean;
  error: string | null;
  globalShortcutStatus: GlobalShortcutStatus;
  fetchSettings: () => Promise<void>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<void>;
  setGlobalShortcutStatus: (status: GlobalShortcutStatus) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loading: true,
  _loaded: false,
  error: null,
  globalShortcutStatus: {
    enabled: false,
    registered: [],
    failed: [],
    diagnostics: [],
  },

  fetchSettings: async () => {
    set({ loading: true });
    try {
      const fetched = await invoke<Partial<AppSettings>>('get_settings');
      set({ settings: { ...DEFAULT_SETTINGS, ...fetched }, loading: false, _loaded: true, error: null });
    } catch (e) {
      set({ error: String(e), loading: false, _loaded: true });
    }
  },

  saveSettings: async (partial) => {
    if (!get()._loaded) {
      console.warn('[settingsStore] saveSettings skipped: settings not loaded yet');
      return;
    }
    const merged = { ...get().settings, ...partial };
    set({ settings: merged, error: null });
    try {
      await invoke('save_settings', { settings: merged });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setGlobalShortcutStatus: (status) => {
    set({ globalShortcutStatus: status });
  },
}));
