import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import BackupCenter from '../BackupCenter';

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
  loadBackups: vi.fn(),
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  deleteBackup: vi.fn(),
  batchDeleteBackups: vi.fn(),
  setSelectedIds: vi.fn(),
  loadBackupSettings: vi.fn(),
  updateBackupSettings: vi.fn(),
};

vi.mock('@/stores', () => ({
  useBackupStore: () => backupStoreState,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('BackupCenter', () => {
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
});
