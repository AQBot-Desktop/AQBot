import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enableD2 = vi.fn();
const preloadChatRenderers = vi.fn();
const setDefaultI18nMap = vi.fn();

const settingsState = {
  settings: {
    theme_mode: 'dark',
    primary_color: '#17A93D',
    font_size: 14,
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
};

const uiState = {
  activePage: 'chat',
};

vi.mock('antd', () => ({
  ConfigProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  App: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
      getFixedT: () => (_key: string) => _key,
      changeLanguage: vi.fn(),
    },
  }),
}));

vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => <div>sidebar</div>,
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

vi.mock('@/stores', () => ({
  useUIStore: (selector: (state: typeof uiState) => unknown) => selector(uiState),
  useSettingsStore: Object.assign(
    (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
    {
      getState: () => settingsState,
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

vi.mock('@/lib/preloadChatRenderers', () => ({
  preloadChatRenderers,
}));

vi.mock('markstream-react', () => ({
  enableD2,
  setDefaultI18nMap,
}));

describe('AppRoot D2 setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables the markstream D2 loader during startup', async () => {
    const { default: AppRoot } = await import('../App');

    render(<AppRoot />);

    expect(enableD2).toHaveBeenCalledTimes(1);
    expect(preloadChatRenderers).toHaveBeenCalledTimes(1);
  });
});
