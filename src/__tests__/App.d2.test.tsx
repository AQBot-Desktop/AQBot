import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enableD2 = vi.fn();
const preloadChatRenderers = vi.fn();
const setDefaultI18nMap = vi.fn();
const setupAgentEventListeners = vi.fn(() => vi.fn());

const settingsState = {
  settings: {
    theme_mode: 'dark',
    primary_color: '#17A93D',
    font_size: 14,
    font_weight: 400,
    font_family: '',
    font_style: 'normal',
    code_font_family: '',
    chat_font_size: 16,
    chat_line_height: 1.8,
    chat_font_family: 'Inter',
    chat_font_weight: 500,
    chat_font_style: 'normal',
    border_radius: 8,
    language: 'zh-CN',
    always_on_top: false,
    close_to_tray: true,
    auto_start: false,
    global_shortcuts_enabled: false,
    shortcut_registration_logs_enabled: false,
    shortcut_trigger_toast_enabled: false,
    global_shortcut: '',
  },
  fetchSettings: vi.fn().mockResolvedValue(undefined),
  setGlobalShortcutStatus: vi.fn(),
};

const uiState = {
  activePage: 'chat',
  settingsSection: 'general' as const,
  enterSettings: vi.fn(),
  setSettingsSection: vi.fn(),
  setSelectedProviderId: vi.fn(),
};

const providerState = {
  importProviderFromDeepLink: vi.fn(),
  fetchProviders: vi.fn(),
};

const conversationState = {
  startStreamListening: vi.fn(),
  stopStreamListening: vi.fn(),
};

vi.mock('antd', () => ({
  ConfigProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  App: Object.assign(
    ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    {
      useApp: () => ({
        modal: {},
        message: {},
      }),
    },
  ),
  Layout: Object.assign(
    ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    {
      Sider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    },
  ),
  theme: {
    useToken: () => ({
      token: {
        colorBorderSecondary: '#444',
        colorBgContainer: '#111',
        colorBgElevated: '#1a1a1a',
        colorText: '#f5f5f5',
        colorTextSecondary: '#999',
        colorPrimary: '#1677ff',
      },
    }),
  },
}));

vi.mock('antd/locale/zh_CN', () => ({
  default: {},
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
  useTranslation: () => ({
    i18n: {
      language: 'zh-CN',
      dir: () => 'ltr',
      getFixedT: () => (_key: string) => _key,
      changeLanguage: vi.fn(),
    },
  }),
}));

vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => <div>sidebar</div>,
}));

vi.mock('@/components/layout/CrashRecoveryModal', () => ({
  CrashRecoveryModal: () => null,
}));

vi.mock('@/components/layout/TitleBar', () => ({
  TitleBar: () => <div>titlebar</div>,
}));

vi.mock('@/components/layout/ContentArea', () => ({
  ContentArea: () => <div>content</div>,
}));

vi.mock('@/components/layout/CommandPalette', () => ({
  default: () => null,
}));

vi.mock('@/hooks/useCommandPalette', () => ({
  useCommandPalette: () => ({
    open: false,
    setOpen: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProviderDeepLink', () => ({
  ProviderDeepLinkDialog: () => null,
}));

vi.mock('@/stores', () => ({
  useUIStore: (selector: (state: typeof uiState) => unknown) => selector(uiState),
  useProviderStore: (selector: (state: typeof providerState) => unknown) => selector(providerState),
  useConversationStore: (selector: (state: typeof conversationState) => unknown) => selector(conversationState),
  useSettingsStore: Object.assign(
    (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
    {
      getState: () => settingsState,
    },
  ),
  useMultiModelColumnLayoutStore: Object.assign(
    (selector: (state: { layout: { popoutWidthMode: string }; ensureLoaded: () => Promise<void> }) => unknown) => selector({
      layout: { popoutWidthMode: 'scroll' },
      ensureLoaded: vi.fn().mockResolvedValue(undefined),
    }),
    {
      getState: () => ({
        ensureLoaded: vi.fn().mockResolvedValue(undefined),
      }),
    },
  ),
}));

vi.mock('@/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}));

vi.mock('@/hooks/useResolvedDarkMode', () => ({
  useResolvedDarkMode: () => true,
}));

vi.mock('@/theme/shadcnTheme', () => ({
  useShadcnTheme: () => ({}),
}));

vi.mock('@/lib/invoke', () => ({
  isTauri: () => false,
}));

vi.mock('@/hooks/useSystemFontFaces', () => ({
  useSystemFontFaces: () => [],
}));

vi.mock('@/lib/preloadChatRenderers', () => ({
  preloadChatRenderers,
}));

vi.mock('@/stores/agentStore', () => ({
  setupAgentEventListeners,
}));

vi.mock('markstream-react', () => ({
  enableD2,
  setDefaultI18nMap,
}));

describe('AppRoot D2 setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.style.cssText = '';
  });

  it('enables the markstream D2 loader during startup', async () => {
    const { default: AppRoot } = await import('../App');

    render(<AppRoot />);

    expect(enableD2).toHaveBeenCalledTimes(1);
    expect(preloadChatRenderers).toHaveBeenCalledTimes(1);
    expect(setupAgentEventListeners).toHaveBeenCalledTimes(1);
  });

  it('syncs chat typography settings to CSS variables', async () => {
    const { default: AppRoot } = await import('../App');

    render(<AppRoot />);

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--chat-font-size')).toBe('16px');
      expect(document.documentElement.style.getPropertyValue('--chat-line-height')).toBe('1.8');
      expect(document.documentElement.style.getPropertyValue('--chat-font-family')).toBe(
        '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      );
      expect(document.documentElement.style.getPropertyValue('--chat-font-weight')).toBe('500');
    });
  });

  it('routes quit requests directly by default and to confirmation when enabled', async () => {
    const { runQuitFlow } = await import('../App');
    const confirm = vi.fn();
    const quit = vi.fn();

    runQuitFlow(false, confirm, quit);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();

    runQuitFlow(true, confirm, quit);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
