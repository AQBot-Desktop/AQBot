import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type { EnsureLoadedOptions, ResourceInvalidationReason, ResourceMeta } from '@/lib/resourceState';
import type { FileCategory, FileRow, FileSortKey, FilesPageEntry } from '@/types';

const FILE_QUERY_MAX_AGE_MS = 5_000;
const MAX_FILE_QUERY_CACHE_ENTRIES = 32;

interface FileCacheEntry {
  rows: FileRow[];
  meta: ResourceMeta;
}

const fileCache = new Map<string, FileCacheEntry>();
const fileRequests = new Map<string, Promise<void>>();
let fileCacheEpoch = 0;

function fileQueryKey(category: FileCategory, search: string, sortKey: FileSortKey): string {
  return JSON.stringify([category, search, sortKey]);
}

function cacheFileQuery(key: string, entry: FileCacheEntry): void {
  fileCache.delete(key);
  fileCache.set(key, entry);
  while (fileCache.size > MAX_FILE_QUERY_CACHE_ENTRIES) {
    const oldestKey = fileCache.keys().next().value;
    if (oldestKey === undefined) break;
    fileCache.delete(oldestKey);
  }
}

function normalizeFileRow(row: FileRow | FilesPageEntry): FileRow {
  if ('displayName' in row) {
    const previewUrl = row.previewUrl ?? undefined;
    return {
      id: row.id,
      storedFileId: row.storedFileId ?? undefined,
      name: row.displayName,
      path: row.path,
      storagePath: row.storagePath ?? undefined,
      size: row.sizeBytes,
      createdAt: row.createdAt,
      category: row.category,
      hasThumbnail: Boolean(row.storedFileId),
      previewUrl,
      missing: row.missing,
    };
  }

  return {
    ...row,
    hasThumbnail: row.hasThumbnail ?? Boolean(row.storedFileId || row.previewUrl),
  };
}

interface FileStoreState {
  rows: FileRow[];
  loading: boolean;
  error: string | null;
  search: string;
  sortKey: FileSortKey;
  currentCategory: FileCategory | null;
  filesMeta: ResourceMeta;

  ensureCategoryLoaded: (category: FileCategory, options?: EnsureLoadedOptions) => Promise<void>;
  invalidateFiles: (reason: ResourceInvalidationReason) => void;
  loadCategory: (category: FileCategory) => Promise<void>;
  refreshCurrentCategory: () => Promise<void>;
  setSearch: (search: string) => void;
  setSortKey: (key: FileSortKey) => void;
  clearError: () => void;
  openEntry: (path: string) => Promise<void>;
  revealEntry: (path: string) => Promise<void>;
  cleanupMissingEntry: (entryId: string) => Promise<void>;
}

export const useFileStore = create<FileStoreState>((set, get) => ({
  rows: [],
  loading: false,
  error: null,
  search: '',
  sortKey: 'createdAt',
  currentCategory: null,
  filesMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureCategoryLoaded: async (category, options = {}) => {
    const { search, sortKey } = get();
    const key = fileQueryKey(category, search, sortKey);
    const cached = fileCache.get(key);
    const maxAgeMs = options.maxAgeMs ?? FILE_QUERY_MAX_AGE_MS;

    if (!options.force && cached && isResourceFresh(cached.meta, { key, maxAgeMs })) {
      set({
        rows: cached.rows,
        currentCategory: category,
        filesMeta: cached.meta,
        loading: false,
        error: null,
      });
      return;
    }

    if (cached) {
      set({
        rows: cached.rows,
        currentCategory: category,
        filesMeta: { ...cached.meta, status: 'loading' },
        loading: false,
        error: null,
      });
    } else {
      set((state) => ({
        rows: [],
        currentCategory: category,
        filesMeta: {
          status: 'loading',
          key,
          loadedAt: null,
          revision: state.filesMeta.key === key ? state.filesMeta.revision : 0,
        },
        loading: true,
        error: null,
      }));
    }

    const pending = fileRequests.get(key);
    if (pending && !options.force) return pending;
    if (pending) {
      await pending;
      return get().ensureCategoryLoaded(category, options);
    }

    const revision = cached?.meta.revision ?? (get().filesMeta.key === key ? get().filesMeta.revision : 0);
    const requestEpoch = fileCacheEpoch;
    const args: Record<string, unknown> = { category, sort_key: sortKey };
    if (search) args.search = search;
    const request = invoke<Array<FileRow | FilesPageEntry>>('list_files_page_entries', args)
      .then((rawRows) => {
        const rows = (rawRows ?? []).map(normalizeFileRow);
        const meta: ResourceMeta = { status: 'ready', key, loadedAt: Date.now(), revision };
        const currentCachedRevision = fileCache.get(key)?.meta.revision;
        if (
          requestEpoch !== fileCacheEpoch
          || (currentCachedRevision !== undefined && currentCachedRevision !== revision)
        ) return;
        cacheFileQuery(key, { rows, meta });
        set((state) => state.filesMeta.key === key && state.filesMeta.revision === revision ? {
          rows,
          loading: false,
          error: null,
          currentCategory: category,
          filesMeta: meta,
        } : {});
      })
      .catch((e) => set((state) => state.filesMeta.key === key ? {
        error: String(e),
        loading: false,
        filesMeta: { ...state.filesMeta, status: 'error' },
      } : {}))
      .finally(() => {
        fileRequests.delete(key);
      });
    fileRequests.set(key, request);
    return request;
  },

  invalidateFiles: (_reason) => {
    fileCacheEpoch += 1;
    fileCache.clear();
    set((state) => ({
      filesMeta: {
        status: 'idle',
        key: null,
        loadedAt: null,
        revision: state.filesMeta.revision + 1,
      },
    }));
  },

  loadCategory: (category) => get().ensureCategoryLoaded(category, { force: true }),

  refreshCurrentCategory: async () => {
    const category = get().currentCategory;
    if (!category) return;
    await get().loadCategory(category);
  },

  setSearch: (search: string) => set({ search }),

  setSortKey: (key: FileSortKey) => set({ sortKey: key }),

  clearError: () => set({ error: null }),

  openEntry: async (path: string) => {
    const row = get().rows.find((r) => r.path === path);
    if (!row || row.missing) return;
    try {
      await invoke('open_files_page_entry', { path });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  revealEntry: async (path: string) => {
    const row = get().rows.find((r) => r.path === path);
    if (!row || row.missing) return;
    try {
      await invoke('reveal_files_page_entry', { path });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  cleanupMissingEntry: async (entryId: string) => {
    const row = get().rows.find((r) => r.id === entryId);
    if (!row || !row.missing) return;
    try {
      await invoke('cleanup_missing_files_page_entry', { entryId });
      set((state) => {
        const rows = state.rows.filter((r) => r.id !== entryId);
        const filesMeta = {
          ...state.filesMeta,
          status: 'ready' as const,
          loadedAt: Date.now(),
          revision: state.filesMeta.revision + 1,
        };
        if (filesMeta.key) cacheFileQuery(filesMeta.key, { rows, meta: filesMeta });
        return { rows, filesMeta };
      });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
}));
