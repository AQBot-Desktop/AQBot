import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBar } from '../TitleBar';

vi.mock('../ConversationTabBar', () => ({
  ConversationTabBar: () => <div data-testid="conversation-tab-bar" />,
}));

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  loadBackupSettings: vi.fn(),
  backupSettings: null as { enabled: boolean; intervalHours: number } | null,
  settings: {
    theme_mode: 'system',
    always_on_top: false,
    webdav_sync_enabled: true,
    webdav_sync_interval_minutes: 1,
    titlebar_icon_visibility: {
      pin: false,
      theme: false,
      language: false,
      backup: true,
      github: false,
      update: false,
      reload: false,
    },
  },
}));

vi.mock('@/lib/invoke', () => ({
  invoke: mocks.invoke,
  isTauri: () => false,
}));

vi.mock('@/stores', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    activePage: 'chat',
    enterSettings: vi.fn(),
    exitSettings: vi.fn(),
  }),
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    settings: mocks.settings,
    saveSettings: vi.fn(),
  }),
}));

vi.mock('@/stores/backupStore', () => ({
  useBackupStore: () => ({
    backupSettings: mocks.backupSettings,
    loadBackupSettings: mocks.loadBackupSettings,
  }),
}));

vi.mock('@/hooks/useUpdateChecker', () => ({
  useUpdateChecker: () => ({ checkForUpdate: vi.fn() }),
}));

vi.mock('@/lib/shortcuts', () => ({
  getShortcutBinding: () => null,
  formatShortcutForDisplay: () => '',
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    startDragging: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US', changeLanguage: vi.fn() },
  }),
}));

vi.mock('antd', async () => {
  const { Fragment, createElement } = await import('react');
  const passthrough = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children);
  return {
    App: {
      useApp: () => ({
        modal: { confirm: vi.fn() },
        message: { success: vi.fn(), error: vi.fn() },
      }),
    },
    Divider: () => null,
    Dropdown: passthrough,
    Popover: passthrough,
    Space: passthrough,
    Spin: () => createElement('span'),
    Tooltip: passthrough,
    Typography: { Text: passthrough },
    theme: {
      useToken: () => ({
        token: {
          borderRadius: 4,
          colorBorder: '#ddd',
          colorBorderSecondary: '#eee',
          colorError: '#f00',
          colorErrorBg: '#fee',
          colorFillSecondary: '#eee',
          colorPrimary: '#00f',
          colorPrimaryBg: '#eef',
          colorText: '#111',
          colorTextBase: '#000',
          colorTextSecondary: '#666',
        },
      }),
    },
  };
});

describe('TitleBar auto-backup countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
    mocks.invoke.mockReset();
    mocks.loadBackupSettings.mockReset();
    mocks.backupSettings = null;
    mocks.settings.webdav_sync_enabled = true;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('advances the WebDAV schedule when the scheduled time arrives', async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_webdav_sync_status') {
        return Promise.resolve({
          lastSyncTime: '2026-08-10T23:59:01.000Z',
          lastSyncStatus: 'success',
        });
      }
      if (command === 'list_backups') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(<TitleBar />);
    await act(async () => Promise.resolve());

    expect(screen.getByText('(0:01)')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'get_webdav_sync_status')).toHaveLength(1);
    expect(screen.queryByText('(titlebar.now)')).not.toBeInTheDocument();
    expect(screen.getByText('(0:56)')).toBeInTheDocument();
  });

  it('advances the local backup schedule when the scheduled time arrives', async () => {
    mocks.backupSettings = { enabled: true, intervalHours: 1 };
    mocks.settings.webdav_sync_enabled = false;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_webdav_sync_status') {
        return Promise.resolve({ lastSyncTime: null, lastSyncStatus: null });
      }
      if (command === 'list_backups') {
        return Promise.resolve([{ createdAt: '2026-08-10T23:00:01.000Z' }]);
      }
      return Promise.resolve(null);
    });

    render(<TitleBar />);
    await act(async () => Promise.resolve());

    expect(screen.getByText('(0:01)')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'list_backups')).toHaveLength(1);
    expect(screen.queryByText('(titlebar.now)')).not.toBeInTheDocument();
    expect(screen.getByText('(1:00:00)')).toBeInTheDocument();
  });
});
