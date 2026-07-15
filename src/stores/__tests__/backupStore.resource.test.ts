import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock('@/lib/invoke', () => ({ invoke: invokeMock }));
vi.mock('../invalidateResources', () => ({
  invalidateApplicationResources: invalidateMock,
}));

describe('backup restore resource invalidation', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invalidateMock.mockReset();
    vi.resetModules();
  });

  it('invalidates cached application data after a successful restore', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { useBackupStore } = await import('../backupStore');

    await useBackupStore.getState().restoreBackup('backup-1');

    expect(invalidateMock).toHaveBeenCalledWith('restore');
  });

  it('keeps caches intact when restore fails', async () => {
    invokeMock.mockRejectedValue(new Error('restore failed'));
    const { useBackupStore } = await import('../backupStore');

    await expect(useBackupStore.getState().restoreBackup('backup-1')).rejects.toThrow('restore failed');

    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('coalesces empty backup resources and reuses them across remounts', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_backups') return Promise.resolve([]);
      if (command === 'get_backup_settings') {
        return Promise.resolve({ enabled: false, intervalHours: 24, maxCount: 10, backupDir: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useBackupStore } = await import('../backupStore');

    await Promise.all([
      useBackupStore.getState().ensureBackupsLoaded(),
      useBackupStore.getState().ensureBackupsLoaded(),
      useBackupStore.getState().ensureBackupSettingsLoaded(),
      useBackupStore.getState().ensureBackupSettingsLoaded(),
    ]);
    await useBackupStore.getState().ensureBackupsLoaded();
    await useBackupStore.getState().ensureBackupSettingsLoaded();

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'list_backups',
      'get_backup_settings',
    ]);
    expect(useBackupStore.getState().backupsMeta.status).toBe('ready');
    expect(useBackupStore.getState().backupSettingsMeta.status).toBe('ready');
  });

  it('reloads backup resources invalidated while older requests are in flight', async () => {
    let resolveBackups!: (value: unknown[]) => void;
    let resolveSettings!: (value: unknown) => void;
    invokeMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveBackups = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSettings = resolve; }))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ enabled: false, intervalHours: 24, maxCount: 10, backupDir: null });
    const { useBackupStore } = await import('../backupStore');

    const firstBackups = useBackupStore.getState().ensureBackupsLoaded();
    const firstSettings = useBackupStore.getState().ensureBackupSettingsLoaded();
    useBackupStore.getState().invalidateBackups('restore');
    useBackupStore.getState().invalidateBackupSettings('restore');
    resolveBackups([]);
    resolveSettings({ enabled: false, intervalHours: 24, maxCount: 10, backupDir: null });
    await Promise.all([firstBackups, firstSettings]);

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'list_backups',
      'get_backup_settings',
      'list_backups',
      'get_backup_settings',
    ]);
  });
});
