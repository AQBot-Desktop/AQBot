import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import { invalidateApplicationResources } from './invalidateResources';
import type {
  EnsureLoadedOptions,
  ResourceInvalidationReason,
  ResourceMeta,
} from '@/lib/resourceState';
import type { BackupManifest, AutoBackupSettings } from '@/types';

const BACKUPS_RESOURCE_KEY = 'backups';
const BACKUP_SETTINGS_RESOURCE_KEY = 'backup-settings';
let backupsRequest: { revision: number; promise: Promise<void> } | null = null;
let backupSettingsRequest: { revision: number; promise: Promise<void> } | null = null;

function invalidateMeta(meta: ResourceMeta): ResourceMeta {
  return {
    status: 'idle',
    key: null,
    loadedAt: null,
    revision: meta.revision + 1,
  };
}

function updateReadyMeta(meta: ResourceMeta, key: string): ResourceMeta {
  return {
    status: 'ready',
    key,
    loadedAt: Date.now(),
    revision: meta.revision + 1,
  };
}

interface BackupState {
  backups: BackupManifest[];
  loading: boolean;
  error: string | null;
  selectedIds: string[];
  backupSettings: AutoBackupSettings | null;
  backupsMeta: ResourceMeta;
  backupSettingsMeta: ResourceMeta;

  ensureBackupsLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateBackups: (reason: ResourceInvalidationReason) => void;
  loadBackups: () => Promise<void>;
  createBackup: (format?: string) => Promise<BackupManifest | null>;
  restoreBackup: (backupId: string) => Promise<void>;
  deleteBackup: (id: string) => Promise<void>;
  batchDeleteBackups: (ids: string[]) => Promise<void>;
  setSelectedIds: (ids: string[]) => void;
  ensureBackupSettingsLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateBackupSettings: (reason: ResourceInvalidationReason) => void;
  loadBackupSettings: () => Promise<void>;
  updateBackupSettings: (settings: AutoBackupSettings) => Promise<void>;
}

export const useBackupStore = create<BackupState>((set, get) => ({
  backups: [],
  loading: false,
  error: null,
  selectedIds: [],
  backupSettings: null,
  backupsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  backupSettingsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureBackupsLoaded: async (options = {}) => {
    const state = get();
    if (!options.force && isResourceFresh(state.backupsMeta, {
      ...options,
      key: BACKUPS_RESOURCE_KEY,
    })) return;
    if (backupsRequest?.revision === state.backupsMeta.revision && !options.force) {
      return backupsRequest.promise;
    }
    if (backupsRequest) {
      await backupsRequest.promise;
      return get().ensureBackupsLoaded(options);
    }

    const revision = state.backupsMeta.revision;
    set((current) => ({
      loading: true,
      backupsMeta: { ...current.backupsMeta, status: 'loading', key: BACKUPS_RESOURCE_KEY },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const backups = await invoke<BackupManifest[]>('list_backups');
        if (get().backupsMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            backups,
            loading: false,
            error: null,
            backupsMeta: {
              status: 'ready',
              key: BACKUPS_RESOURCE_KEY,
              loadedAt: Date.now(),
              revision,
            },
          });
        }
      } catch (e) {
        if (get().backupsMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            error: String(e),
            loading: false,
            backupsMeta: { ...current.backupsMeta, status: 'error' },
          }));
        }
      } finally {
        backupsRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureBackupsLoaded();
    })();
    backupsRequest = { revision, promise };
    return promise;
  },

  invalidateBackups: (_reason) => set((state) => ({
    backupsMeta: invalidateMeta(state.backupsMeta),
  })),

  loadBackups: () => get().ensureBackupsLoaded({ force: true }),

  createBackup: async (format = 'json') => {
    set({ loading: true, error: null });
    try {
      const backup = await invoke<BackupManifest>('create_backup', { format });
      await get().ensureBackupsLoaded({ force: true });
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
      invalidateApplicationResources('restore');
      set((state) => ({
        loading: false,
        backupsMeta: invalidateMeta(state.backupsMeta),
        backupSettingsMeta: invalidateMeta(state.backupSettingsMeta),
      }));
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
        backupsMeta: updateReadyMeta(get().backupsMeta, BACKUPS_RESOURCE_KEY),
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
        backupsMeta: updateReadyMeta(get().backupsMeta, BACKUPS_RESOURCE_KEY),
      });
    } catch (e) {
      set({ error: String(e), loading: false });
      throw e;
    }
  },

  setSelectedIds: (ids: string[]) => {
    set({ selectedIds: ids });
  },

  ensureBackupSettingsLoaded: async (options = {}) => {
    const state = get();
    if (!options.force && isResourceFresh(state.backupSettingsMeta, {
      ...options,
      key: BACKUP_SETTINGS_RESOURCE_KEY,
    })) return;
    if (backupSettingsRequest?.revision === state.backupSettingsMeta.revision && !options.force) {
      return backupSettingsRequest.promise;
    }
    if (backupSettingsRequest) {
      await backupSettingsRequest.promise;
      return get().ensureBackupSettingsLoaded(options);
    }

    const revision = state.backupSettingsMeta.revision;
    set((current) => ({
      backupSettingsMeta: {
        ...current.backupSettingsMeta,
        status: 'loading',
        key: BACKUP_SETTINGS_RESOURCE_KEY,
      },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const settings = await invoke<AutoBackupSettings>('get_backup_settings');
        if (get().backupSettingsMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set({
            backupSettings: settings,
            error: null,
            backupSettingsMeta: {
              status: 'ready',
              key: BACKUP_SETTINGS_RESOURCE_KEY,
              loadedAt: Date.now(),
              revision,
            },
          });
        }
      } catch (e) {
        if (get().backupSettingsMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set((current) => ({
            error: String(e),
            backupSettingsMeta: { ...current.backupSettingsMeta, status: 'error' },
          }));
        }
      } finally {
        backupSettingsRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureBackupSettingsLoaded();
    })();
    backupSettingsRequest = { revision, promise };
    return promise;
  },

  invalidateBackupSettings: (_reason) => set((state) => ({
    backupSettingsMeta: invalidateMeta(state.backupSettingsMeta),
  })),

  loadBackupSettings: () => get().ensureBackupSettingsLoaded({ force: true }),

  updateBackupSettings: async (settings: AutoBackupSettings) => {
    try {
      await invoke('update_backup_settings', { backupSettings: settings });
      set((state) => ({
        backupSettings: settings,
        backupSettingsMeta: updateReadyMeta(state.backupSettingsMeta, BACKUP_SETTINGS_RESOURCE_KEY),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
}));
