import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type { EnsureLoadedOptions, ResourceInvalidationReason, ResourceMeta } from '@/lib/resourceState';
import type { MemoryNamespace, MemoryItem, UpdateMemoryNamespaceInput, UpdateMemoryItemInput } from '@/types';

const NAMESPACES_RESOURCE_KEY = 'memory-namespaces';
let namespacesRequest: { revision: number; promise: Promise<void> } | null = null;
const itemRequests = new Map<string, { revision: number; promise: Promise<void> }>();

function mutateNamespacesMeta(meta: ResourceMeta): ResourceMeta {
  const remainsComplete = meta.status === 'ready' && meta.key === NAMESPACES_RESOURCE_KEY;
  return {
    status: remainsComplete ? 'ready' : 'idle',
    key: remainsComplete ? NAMESPACES_RESOURCE_KEY : null,
    loadedAt: remainsComplete ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

interface MemoryState {
  namespaces: MemoryNamespace[];
  items: MemoryItem[];
  loading: boolean;
  error: string | null;
  selectedNamespaceId: string | null;
  namespacesMeta: ResourceMeta;
  itemsMeta: ResourceMeta;

  ensureNamespacesLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateNamespaces: (reason: ResourceInvalidationReason) => void;
  loadNamespaces: () => Promise<void>;
  createNamespace: (name: string, scope: string, embeddingProvider?: string) => Promise<MemoryNamespace | null>;
  deleteNamespace: (id: string) => Promise<void>;
  updateNamespace: (id: string, input: UpdateMemoryNamespaceInput) => Promise<void>;
  ensureItemsLoaded: (namespaceId: string, options?: EnsureLoadedOptions) => Promise<void>;
  invalidateItems: (reason: ResourceInvalidationReason) => void;
  loadItems: (namespaceId: string) => Promise<void>;
  addItem: (namespaceId: string, title: string, content: string) => Promise<void>;
  deleteItem: (namespaceId: string, itemId: string) => Promise<void>;
  updateItem: (namespaceId: string, itemId: string, input: UpdateMemoryItemInput) => Promise<void>;
  setSelectedNamespaceId: (id: string | null) => void;
  reorderNamespaces: (namespaceIds: string[]) => Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  namespaces: [],
  items: [],
  loading: false,
  error: null,
  selectedNamespaceId: null,
  namespacesMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  itemsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureNamespacesLoaded: async (options = {}) => {
    const key = NAMESPACES_RESOURCE_KEY;
    const state = get();
    if (!options.force && isResourceFresh(state.namespacesMeta, { ...options, key })) return;
    if (namespacesRequest?.revision === state.namespacesMeta.revision && !options.force) {
      return namespacesRequest.promise;
    }
    if (namespacesRequest) {
      await namespacesRequest.promise;
      return get().ensureNamespacesLoaded(options);
    }

    const revision = state.namespacesMeta.revision;
    set((state) => ({
      loading: true,
      namespacesMeta: { ...state.namespacesMeta, status: 'loading', key },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const namespaces = await invoke<MemoryNamespace[]>('list_memory_namespaces');
        if (get().namespacesMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            namespaces,
            loading: false,
            error: null,
            namespacesMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().namespacesMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            error: String(e),
            loading: false,
            namespacesMeta: { ...current.namespacesMeta, status: 'error' },
          }));
        }
      } finally {
        namespacesRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureNamespacesLoaded();
    })();
    namespacesRequest = { revision, promise };
    return promise;
  },

  invalidateNamespaces: (_reason) => set((state) => ({
    namespacesMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.namespacesMeta.revision + 1,
    },
  })),

  loadNamespaces: () => get().ensureNamespacesLoaded({ force: true }),

  createNamespace: async (name, scope, embeddingProvider) => {
    try {
      const ns = await invoke<MemoryNamespace>('create_memory_namespace', {
        input: { name, scope, embeddingProvider },
      });
      set((s) => ({
        namespaces: [...s.namespaces, ns],
        error: null,
        namespacesMeta: mutateNamespacesMeta(s.namespacesMeta),
      }));
      return ns;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  deleteNamespace: async (id) => {
    try {
      await invoke('delete_memory_namespace', { id });
      set((s) => ({
        namespaces: s.namespaces.filter((n) => n.id !== id),
        items: s.itemsMeta.key === id ? [] : s.items,
        error: null,
        namespacesMeta: mutateNamespacesMeta(s.namespacesMeta),
        itemsMeta: s.itemsMeta.key === id ? {
          status: 'idle',
          key: null,
          loadedAt: null,
          revision: s.itemsMeta.revision + 1,
        } : s.itemsMeta,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateNamespace: async (id, input) => {
    try {
      const updated = await invoke<MemoryNamespace>('update_memory_namespace', { id, input });
      set((s) => ({
        namespaces: s.namespaces.map((n) => (n.id === id ? updated : n)),
        error: null,
        namespacesMeta: mutateNamespacesMeta(s.namespacesMeta),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  ensureItemsLoaded: async (namespaceId, options = {}) => {
    const state = get();
    if (!options.force && isResourceFresh(state.itemsMeta, { ...options, key: namespaceId })) return;
    const pending = itemRequests.get(namespaceId);
    if (
      pending?.revision === state.itemsMeta.revision
      && state.itemsMeta.key === namespaceId
      && !options.force
    ) return pending.promise;
    if (pending) {
      await pending.promise;
      return get().ensureItemsLoaded(namespaceId, options);
    }

    const revision = state.itemsMeta.revision;
    set((state) => ({
      loading: true,
      itemsMeta: { ...state.itemsMeta, status: 'loading', key: namespaceId },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const items = await invoke<MemoryItem[]>('list_memory_items', { namespaceId });
        const current = get().itemsMeta;
        if (current.revision !== revision) {
          reloadAfterCompletion = current.key === null || current.key === namespaceId;
          set({ loading: false });
        } else if (current.key === namespaceId) {
          set({
            items,
            loading: false,
            error: null,
            itemsMeta: { status: 'ready', key: namespaceId, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        const current = get().itemsMeta;
        if (current.revision !== revision) {
          reloadAfterCompletion = current.key === null || current.key === namespaceId;
          set({ loading: false });
        } else if (current.key === namespaceId) {
          set({
            error: String(e),
            loading: false,
            itemsMeta: { ...current, status: 'error' },
          });
        }
      } finally {
        if (itemRequests.get(namespaceId)?.promise === promise) itemRequests.delete(namespaceId);
      }
      if (reloadAfterCompletion) await get().ensureItemsLoaded(namespaceId);
    })();
    itemRequests.set(namespaceId, { revision, promise });
    return promise;
  },

  invalidateItems: (_reason) => set((state) => ({
    itemsMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.itemsMeta.revision + 1,
    },
  })),

  loadItems: (namespaceId) => get().ensureItemsLoaded(namespaceId, { force: true }),

  addItem: async (namespaceId, title, content) => {
    try {
      await invoke('add_memory_item', { input: { namespaceId, title, content } });
      await get().loadItems(namespaceId);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteItem: async (namespaceId, itemId) => {
    try {
      await invoke('delete_memory_item', { namespaceId, id: itemId });
      await get().loadItems(namespaceId);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateItem: async (namespaceId, itemId, input) => {
    try {
      await invoke<MemoryItem>('update_memory_item', { namespaceId, id: itemId, input });
      await get().loadItems(namespaceId);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  setSelectedNamespaceId: (id) => {
    set({ selectedNamespaceId: id });
  },

  reorderNamespaces: async (namespaceIds) => {
    await invoke('reorder_memory_namespaces', { namespaceIds });
    set((s) => {
      const ordered = namespaceIds
        .map((id, i) => {
          const n = s.namespaces.find((n) => n.id === id);
          return n ? { ...n, sortOrder: i } : null;
        })
        .filter(Boolean) as MemoryNamespace[];
      return {
        namespaces: ordered,
        namespacesMeta: mutateNamespacesMeta(s.namespacesMeta),
      };
    });
  },
}));
