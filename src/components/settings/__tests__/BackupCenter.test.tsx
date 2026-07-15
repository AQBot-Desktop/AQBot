import { App } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BackupCenter from '../BackupCenter';
import { invalidateS3SyncResources } from '../S3Sync';

const { invokeMock, saveSettingsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveSettingsMock: vi.fn(),
}));

const backupStoreState = {
  backups: [],
  loading: false,
  error: null,
  selectedIds: [],
  backupSettings: {
    enabled: false,
    intervalHours: 24,
    maxCount: 10,
    backupDir: '/Users/test/.aqbot/backups',
  },
  ensureBackupsLoaded: vi.fn(),
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  deleteBackup: vi.fn(),
  batchDeleteBackups: vi.fn(),
  setSelectedIds: vi.fn(),
  ensureBackupSettingsLoaded: vi.fn(),
  updateBackupSettings: vi.fn(),
};

const settingsStoreState = {
  settings: {
    s3_sync_enabled: false,
    s3_sync_interval_minutes: 60,
    s3_max_remote_backups: 10,
    s3_include_documents: false,
  },
  saveSettings: saveSettingsMock,
};

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

vi.mock('@/stores', () => ({
  useBackupStore: () => backupStoreState,
  useSettingsStore: () => settingsStoreState,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('BackupCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateS3SyncResources();
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'get_s3_config':
          return {
            bucket: '',
            region: 'us-east-1',
            prefix: 'aqbot/',
            endpointUrl: null,
            forcePathStyle: false,
            useDefaultCredentials: false,
            accessKeyId: '',
            secretAccessKey: '',
            sessionToken: null,
          };
        case 'get_s3_sync_status':
          return {
            lastSyncTime: null,
            lastSyncStatus: null,
          };
        case 's3_list_backups':
          return [];
        case 'save_s3_config':
        case 'restart_s3_sync':
          return undefined;
        default:
          return undefined;
      }
    });
  });

  it('shows the effective backup directory in auto-backup settings', async () => {
    const user = userEvent.setup();

    render(
      <App>
        <BackupCenter />
      </App>,
    );

    await user.click(screen.getByRole('button', { name: 'backup.autoBackup' }));

    expect(await screen.findByTestId('backup-effective-dir')).toHaveTextContent(
      '/Users/test/.aqbot/backups',
    );
  });

  it('shows S3 tab and persists S3 config with sync settings', async () => {
    render(
      <App>
        <BackupCenter />
      </App>,
    );

    fireEvent.click(screen.getByText('S3'));
    fireEvent.click(await screen.findByText('backup.s3.config'));

    fireEvent.change(screen.getByLabelText('backup.s3.bucket'), {
      target: { value: 'aqbot-backups' },
    });
    fireEvent.change(screen.getByLabelText('backup.s3.region'), {
      target: { value: 'us-west-2' },
    });
    fireEvent.change(screen.getByLabelText('backup.s3.prefix'), {
      target: { value: 'desktop/' },
    });
    fireEvent.change(screen.getByLabelText('backup.s3.accessKeyId'), {
      target: { value: 'access' },
    });
    fireEvent.change(screen.getByLabelText('backup.s3.secretAccessKey'), {
      target: { value: 'secret' },
    });

    fireEvent.click(screen.getByText('OK'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('save_s3_config', {
        config: expect.objectContaining({
          bucket: 'aqbot-backups',
          region: 'us-west-2',
          prefix: 'desktop/',
          accessKeyId: 'access',
          secretAccessKey: 'secret',
        }),
      });
      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          s3_bucket: 'aqbot-backups',
          s3_region: 'us-west-2',
          s3_prefix: 'desktop/',
          s3_sync_enabled: false,
          s3_sync_interval_minutes: 60,
          s3_max_remote_backups: 10,
          s3_include_documents: false,
        }),
      );
    });
  });

  it('does not stringify S3 form validation errors as connection failures', async () => {
    render(
      <App>
        <BackupCenter />
      </App>,
    );

    fireEvent.click(screen.getByText('S3'));
    fireEvent.click(await screen.findByText('backup.s3.config'));
    fireEvent.click(screen.getByText('backup.s3.testConnection'));

    await waitFor(() => {
      expect(screen.getByText('backup.s3.bucketRequired')).toBeInTheDocument();
    });

    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    expect(screen.queryByText('backup.s3.testFailed')).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith(
      's3_check_connection',
      expect.anything(),
    );
  });
});
