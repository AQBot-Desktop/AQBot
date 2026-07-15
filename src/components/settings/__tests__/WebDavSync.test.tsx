import { App } from 'antd';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WebDavSync, { invalidateWebDavSyncResources } from '../WebDavSync';

const { invokeMock, saveSettingsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveSettingsMock: vi.fn(),
}));

const settingsStoreState = {
  settings: {
    webdav_sync_enabled: false,
    webdav_sync_interval_minutes: 60,
    webdav_max_remote_backups: 10,
    webdav_include_documents: false,
  },
  saveSettings: saveSettingsMock,
};

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

vi.mock('@/stores', () => ({
  useSettingsStore: () => settingsStoreState,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('WebDavSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateWebDavSyncResources();
    settingsStoreState.settings = {
      webdav_sync_enabled: false,
      webdav_sync_interval_minutes: 60,
      webdav_max_remote_backups: 10,
      webdav_include_documents: false,
    };

    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'get_webdav_config':
          return {
            host: '',
            username: '',
            password: '',
            path: '/aqbot/',
            acceptInvalidCerts: false,
          };
        case 'get_webdav_sync_status':
          return {
            lastSyncTime: null,
            lastSyncStatus: null,
          };
        case 'save_webdav_config':
        case 'restart_webdav_sync':
          return undefined;
        case 'webdav_list_backups':
          return [];
        default:
          return undefined;
      }
    });
  });

  it('persists connection fields alongside sync settings after saving config', async () => {
    const user = userEvent.setup();

    render(
      <App>
        <WebDavSync />
      </App>,
    );

    await user.click(
      await screen.findByRole('button', { name: 'backup.webdav.config' }),
    );

    await user.type(
      screen.getByRole('textbox', { name: 'backup.webdav.host' }),
      'https://dav.example.com',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'backup.webdav.username' }),
      'alice',
    );
    await user.type(
      screen.getByLabelText('backup.webdav.password'),
      'secret',
    );

    await user.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => {
      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          webdav_host: 'https://dav.example.com',
          webdav_username: 'alice',
          webdav_path: '/aqbot/',
          webdav_accept_invalid_certs: false,
          webdav_sync_enabled: false,
          webdav_sync_interval_minutes: 60,
          webdav_max_remote_backups: 10,
          webdav_include_documents: false,
        }),
      );
    });
  });
});
