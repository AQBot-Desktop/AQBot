import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type { BackupManifest, AutoBackupSettings } from '@/types';

interface BackupState {
  backups: BackupManifest[];
  loading: boolean;
  error: string | null;
  selectedIds: string[];
  backupSettings: AutoBackupSettings | null;

  loadBackups: () => Promise<void>;
  createBackup: (format?: string) => Promise<BackupManifest | null>;
  restoreBackup: (backupId: string) => Promise<void>;
  deleteBackup: (id: string) => Promise<void>;
  batchDeleteBackups: (ids: string[]) => Promise<void>;
  setSelectedIds: (ids: string[]) => void;
  loadBackupSettings: () => Promise<void>;
  updateBackupSettings: (settings: AutoBackupSettings) => Promise<void>;
}

export const useBackupStore = create<BackupState>((set, get) => ({
  backups: [],
  loading: false,
  error: null,
  selectedIds: [],
  backupSettings: null,

  loadBackups: async () => {
    set({ loading: true });
    try {
      const backups = await invoke<BackupManifest[]>('list_backups');
      set({ backups, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createBackup: async (format = 'json') => {
    set({ loading: true, error: null });
    try {
      const backup = await invoke<BackupManifest>('create_backup', { format });
      await get().loadBackups();
      return backup;
    } catch (e) {
      set({ error: String(e), loading: false });
      return null;
    }
  },

  restoreBackup: async (backupId: string) => {
    set({ loading: true, error: null });
    try {
      await invoke('restore_backup', { backupId });
      set({ loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
      throw e;
    }
  },

  deleteBackup: async (id: string) => {
    try {
      await invoke('delete_backup', { backupId: id });
      set({
        backups: get().backups.filter((b) => b.id !== id),
        selectedIds: get().selectedIds.filter((i) => i !== id),
      });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  batchDeleteBackups: async (ids: string[]) => {
    set({ loading: true, error: null });
    try {
      await invoke('batch_delete_backups', { backupIds: ids });
      set({
        backups: get().backups.filter((b) => !ids.includes(b.id)),
        selectedIds: [],
        loading: false,
      });
    } catch (e) {
      set({ error: String(e), loading: false });
      throw e;
    }
  },

  setSelectedIds: (ids: string[]) => {
    set({ selectedIds: ids });
  },

  loadBackupSettings: async () => {
    try {
      const settings = await invoke<AutoBackupSettings>('get_backup_settings');
      set({ backupSettings: settings });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  updateBackupSettings: async (settings: AutoBackupSettings) => {
    try {
      await invoke('update_backup_settings', { backupSettings: settings });
      set({ backupSettings: settings });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
}));
