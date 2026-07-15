import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataManager } from '../DataManager';

const { saveSettingsMock } = vi.hoisted(() => ({
  saveSettingsMock: vi.fn(),
}));

vi.mock('@/lib/invoke', () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useConversationStore: {
    getState: () => ({
      conversations: [],
      deleteConversation: vi.fn(),
    }),
  },
  useSettingsStore: {
    getState: () => ({
      settings: {},
      saveSettings: saveSettingsMock,
    }),
  },
  useProviderStore: {
    getState: () => ({
      fetchProviders: vi.fn(),
    }),
  },
}));

vi.mock('@/stores/fileStore', () => ({
  useFileStore: {
    getState: () => ({
      refreshCurrentCategory: vi.fn(),
    }),
  },
}));

vi.mock('@/stores/invalidateResources', () => ({
  invalidateApplicationResources: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

describe('DataManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes Cherry Studio import from third-party data import settings', async () => {
    const user = userEvent.setup();

    render(
      <App>
        <DataManager />
      </App>,
    );

    expect(screen.getByText('settings.groupThirdPartyImport')).toBeInTheDocument();
    expect(screen.getByText('settings.cherryImport.source')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'settings.cherryImport.action' }));

    expect(screen.getByText('settings.cherryImport.title')).toBeInTheDocument();
  });

  it('exposes Kelivo import from third-party data import settings', async () => {
    const user = userEvent.setup();

    render(
      <App>
        <DataManager />
      </App>,
    );

    expect(screen.getByText('settings.groupThirdPartyImport')).toBeInTheDocument();
    expect(screen.getByText('settings.kelivoImport.source')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'settings.kelivoImport.action' }));

    expect(screen.getByText('settings.kelivoImport.title')).toBeInTheDocument();
  });

  it('exposes ChatGPT export import from third-party data import settings', async () => {
    const user = userEvent.setup();

    render(
      <App>
        <DataManager />
      </App>,
    );

    expect(screen.getByText('settings.chatgptImport.source')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'settings.chatgptImport.action' }));

    expect(screen.getByText('settings.chatgptImport.title')).toBeInTheDocument();
  });

  it('places ChatGPT official export before other third-party imports', () => {
    render(
      <App>
        <DataManager />
      </App>,
    );

    const chatgpt = screen.getByText('settings.chatgptImport.source');
    const cherry = screen.getByText('settings.cherryImport.source');
    const kelivo = screen.getByText('settings.kelivoImport.source');

    expect(chatgpt.compareDocumentPosition(cherry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chatgpt.compareDocumentPosition(kelivo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
