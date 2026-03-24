import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type { AppSettings } from '@/types';
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
  bubble_style: 'minimal',
  code_theme: 'github-dark',
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
  proxy_type: null,
  proxy_address: null,
  proxy_port: null,
  global_shortcut: DEFAULT_SHORTCUT_BINDINGS.toggleCurrentWindow,
  shortcut_toggle_current_window: DEFAULT_SHORTCUT_BINDINGS.toggleCurrentWindow,
  shortcut_toggle_all_windows: DEFAULT_SHORTCUT_BINDINGS.toggleAllWindows,
  shortcut_close_window: DEFAULT_SHORTCUT_BINDINGS.closeWindow,
  shortcut_new_conversation: DEFAULT_SHORTCUT_BINDINGS.newConversation,
  shortcut_open_settings: DEFAULT_SHORTCUT_BINDINGS.openSettings,
  shortcut_toggle_model_selector: DEFAULT_SHORTCUT_BINDINGS.toggleModelSelector,
  shortcut_fill_last_message: DEFAULT_SHORTCUT_BINDINGS.fillLastMessage,
  shortcut_clear_context: DEFAULT_SHORTCUT_BINDINGS.clearContext,
  shortcut_clear_conversation_messages: DEFAULT_SHORTCUT_BINDINGS.clearConversationMessages,
  shortcut_toggle_gateway: DEFAULT_SHORTCUT_BINDINGS.toggleGateway,
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
  notify_backup: true,
  notify_import: true,
  notify_errors: true,
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
  error: string | null;
  globalShortcutStatus: GlobalShortcutStatus;
  fetchSettings: () => Promise<void>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<void>;
  setGlobalShortcutStatus: (status: GlobalShortcutStatus) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loading: false,
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
      set({ settings: { ...DEFAULT_SETTINGS, ...fetched }, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  saveSettings: async (partial) => {
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
