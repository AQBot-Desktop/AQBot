import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type {
  EnsureLoadedOptions,
  ResourceInvalidationReason,
  ResourceMeta,
} from '@/lib/resourceState';
import type {
  SearchProvider,
  CreateSearchProviderInput,
  UpdateSearchProviderInput,
  SearchExecuteResponse,
} from '@/types';

const SEARCH_PROVIDERS_RESOURCE_KEY = 'search-providers';
let providersRequest: { revision: number; promise: Promise<void> } | null = null;

function mutateProvidersMeta(meta: ResourceMeta): ResourceMeta {
  return {
    status: meta.status === 'ready' ? 'ready' : 'idle',
    key: meta.status === 'ready' ? SEARCH_PROVIDERS_RESOURCE_KEY : null,
    loadedAt: meta.status === 'ready' ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

interface SearchState {
  providers: SearchProvider[];
  loading: boolean;
  error: string | null;
  providersMeta: ResourceMeta;

  ensureProvidersLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateProviders: (reason: ResourceInvalidationReason) => void;
  loadProviders: () => Promise<void>;
  createProvider: (input: CreateSearchProviderInput) => Promise<SearchProvider | null>;
  updateProvider: (id: string, input: UpdateSearchProviderInput) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  testProvider: (id: string) => Promise<{ ok: boolean; latency_ms?: number; error?: string }>;
  executeSearch: (
    providerId: string,
    query: string,
    maxResults?: number,
  ) => Promise<SearchExecuteResponse | null>;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  providersMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureProvidersLoaded: async (options = {}) => {
    const state = get();
    if (!options.force && isResourceFresh(state.providersMeta, {
      ...options,
      key: SEARCH_PROVIDERS_RESOURCE_KEY,
    })) return;
    if (providersRequest?.revision === state.providersMeta.revision) {
      return providersRequest.promise;
    }

    const revision = state.providersMeta.revision;
    set((current) => ({
      loading: true,
      providersMeta: {
        ...current.providersMeta,
        status: 'loading',
        key: SEARCH_PROVIDERS_RESOURCE_KEY,
      },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const providers = await invoke<SearchProvider[]>('list_search_providers');
        if (get().providersMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            providers,
            loading: false,
            error: null,
            providersMeta: {
              status: 'ready',
              key: SEARCH_PROVIDERS_RESOURCE_KEY,
              loadedAt: Date.now(),
              revision,
            },
          });
        }
      } catch (e) {
        if (get().providersMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            error: String(e),
            loading: false,
            providersMeta: { ...current.providersMeta, status: 'error' },
          }));
        }
      } finally {
        if (providersRequest?.promise === promise) providersRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureProvidersLoaded();
    })();
    providersRequest = { revision, promise };
    return promise;
  },

  invalidateProviders: (_reason) => set((state) => ({
    loading: false,
    providersMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.providersMeta.revision + 1,
    },
  })),

  loadProviders: () => get().ensureProvidersLoaded({ force: true }),

  createProvider: async (input) => {
    try {
      const provider = await invoke<SearchProvider>('create_search_provider', { input });
      set((s) => ({
        providers: [...s.providers, provider],
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
      return provider;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  updateProvider: async (id, input) => {
    try {
      const updated = await invoke<SearchProvider>('update_search_provider', { id, input });
      set((s) => ({
        providers: s.providers.map((p) => (p.id === id ? updated : p)),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteProvider: async (id) => {
    try {
      await invoke('delete_search_provider', { id });
      set((s) => ({
        providers: s.providers.filter((p) => p.id !== id),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  testProvider: async (id) => {
    try {
      const result = await invoke<{ ok: boolean; latency_ms?: number; error?: string }>(
        'test_search_provider',
        { id },
      );
      return result;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  executeSearch: async (providerId, query, maxResults) => {
    try {
      const result = await invoke<SearchExecuteResponse>('execute_search', {
        providerId,
        query,
        maxResults: maxResults ?? null,
      });
      return result;
    } catch (e) {
      console.error('[executeSearch] error:', e);
      return null;
    }
  },
}));
