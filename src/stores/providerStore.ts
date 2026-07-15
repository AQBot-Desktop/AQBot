import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type {
  EnsureLoadedOptions,
  ResourceInvalidationReason,
  ResourceMeta,
} from '@/lib/resourceState';
import type {
  ProviderConfig,
  CreateProviderInput,
  UpdateProviderInput,
  ProviderKey,
  Model,
  ModelParamOverrides,
  DeepLinkProviderImportInput,
  DeepLinkProviderImportResult,
  ProviderImportBatchResult,
  ProviderImportCandidate,
} from '@/types';

const PROVIDERS_RESOURCE_KEY = 'providers';
let providersRequest: { revision: number; promise: Promise<void> } | null = null;

function mutateProvidersMeta(meta: ResourceMeta): ResourceMeta {
  const remainsComplete = meta.status === 'ready' && meta.key === PROVIDERS_RESOURCE_KEY;
  return {
    status: remainsComplete ? 'ready' : 'idle',
    key: remainsComplete ? PROVIDERS_RESOURCE_KEY : null,
    loadedAt: remainsComplete ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

function replaceProvidersMeta(meta: ResourceMeta): ResourceMeta {
  return {
    status: 'ready',
    key: PROVIDERS_RESOURCE_KEY,
    loadedAt: Date.now(),
    revision: meta.revision + 1,
  };
}

interface ProviderState {
  providers: ProviderConfig[];
  loading: boolean;
  error: string | null;
  providersMeta: ResourceMeta;
  ensureProvidersLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateProviders: (reason: ResourceInvalidationReason) => void;
  fetchProviders: () => Promise<void>;
  createProvider: (input: CreateProviderInput) => Promise<ProviderConfig>;
  importProviderFromDeepLink: (input: DeepLinkProviderImportInput) => Promise<DeepLinkProviderImportResult>;
  scanCcSwitchProviderImports: () => Promise<ProviderImportCandidate[]>;
  importCcSwitchProviderConfigs: (candidateIds: string[]) => Promise<ProviderImportBatchResult>;
  updateProvider: (id: string, input: UpdateProviderInput) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  toggleProvider: (id: string, enabled: boolean) => Promise<void>;
  reorderProviders: (providerIds: string[]) => Promise<void>;
  addProviderKey: (providerId: string, rawKey: string) => Promise<void>;
  updateProviderKey: (keyId: string, rawKey: string) => Promise<void>;
  deleteProviderKey: (keyId: string) => Promise<void>;
  toggleProviderKey: (keyId: string, enabled: boolean) => Promise<void>;
  validateProviderKey: (keyId: string) => Promise<boolean>;
  saveModels: (providerId: string, models: Model[]) => Promise<void>;
  toggleModel: (providerId: string, modelId: string, enabled: boolean) => Promise<Model>;
  updateModelParams: (providerId: string, modelId: string, overrides: ModelParamOverrides) => Promise<Model>;
  fetchRemoteModels: (providerId: string) => Promise<Model[]>;
  testModel: (providerId: string, modelId: string) => Promise<number>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  providersMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureProvidersLoaded: async (options = {}) => {
    const state = get();
    if (!options.force && isResourceFresh(state.providersMeta, {
      ...options,
      key: PROVIDERS_RESOURCE_KEY,
    })) return;

    if (providersRequest?.revision === state.providersMeta.revision && !options.force) {
      return providersRequest.promise;
    }
    if (providersRequest) {
      await providersRequest.promise;
      return get().ensureProvidersLoaded(options);
    }

    const revision = state.providersMeta.revision;
    set((current) => ({
      loading: true,
      providersMeta: {
        ...current.providersMeta,
        status: 'loading',
        key: PROVIDERS_RESOURCE_KEY,
      },
    }));

    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const providers = await invoke<ProviderConfig[]>('list_providers');
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
              key: PROVIDERS_RESOURCE_KEY,
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
        providersRequest = null;
      }
      if (reloadAfterCompletion) {
        await get().ensureProvidersLoaded();
      }
    })();
    providersRequest = { revision, promise };
    return promise;
  },

  invalidateProviders: (_reason) => set((state) => ({
    providersMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.providersMeta.revision + 1,
    },
  })),

  fetchProviders: () => get().ensureProvidersLoaded({ force: true }),

  createProvider: async (input) => {
    try {
      const provider = await invoke<ProviderConfig>('create_provider', { input });
      set((s) => ({
        providers: [...s.providers, provider],
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
      return provider;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  importProviderFromDeepLink: async (input) => {
    try {
      const result = await invoke<DeepLinkProviderImportResult>('import_provider_from_deep_link', { input });
      set((state) => ({
        error: null,
        providersMeta: {
          status: 'idle',
          key: null,
          loadedAt: null,
          revision: state.providersMeta.revision + 1,
        },
      }));
      return result;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  scanCcSwitchProviderImports: async () => {
    try {
      const candidates = await invoke<ProviderImportCandidate[]>('scan_cc_switch_provider_imports');
      set({ error: null });
      return candidates;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  importCcSwitchProviderConfigs: async (candidateIds) => {
    try {
      const result = await invoke<ProviderImportBatchResult>('import_cc_switch_provider_configs', {
        candidateIds,
      });
      const providers = await invoke<ProviderConfig[]>('list_providers');
      set((state) => ({
        providers,
        providersMeta: replaceProvidersMeta(state.providersMeta),
        error: null,
      }));
      return result;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateProvider: async (id, input) => {
    try {
      const updated = await invoke<ProviderConfig>('update_provider', { id, input });
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
      await invoke('delete_provider', { id });
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

  toggleProvider: async (id, enabled) => {
    try {
      await invoke('toggle_provider', { id, enabled });
      if (id.startsWith('builtin_')) {
        // Virtual provider was materialized — refetch to get real ID
        const providers = await invoke<ProviderConfig[]>('list_providers');
        set((state) => ({
          providers,
          providersMeta: replaceProvidersMeta(state.providersMeta),
          error: null,
        }));
      } else {
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === id ? { ...p, enabled } : p,
          ),
          providersMeta: mutateProvidersMeta(s.providersMeta),
          error: null,
        }));
      }
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  reorderProviders: async (providerIds) => {
    const hasVirtual = providerIds.some((id) => id.startsWith('builtin_'));
    await invoke('reorder_providers', { providerIds });
    if (hasVirtual) {
      // Virtual IDs were materialized — refetch to get real IDs
      const providers = await invoke<ProviderConfig[]>('list_providers');
      set((state) => ({
        providers,
        providersMeta: replaceProvidersMeta(state.providersMeta),
      }));
    } else {
      set((s) => {
        const ordered = providerIds
          .map((id, i) => {
            const p = s.providers.find((p) => p.id === id);
            return p ? { ...p, sort_order: i } : null;
          })
          .filter(Boolean) as ProviderConfig[];
        return {
          providers: ordered,
          providersMeta: mutateProvidersMeta(s.providersMeta),
        };
      });
    }
  },

  addProviderKey: async (providerId, rawKey) => {
    try {
      const key = await invoke<ProviderKey>('add_provider_key', {
        providerId,
        rawKey,
      });
      if (providerId.startsWith('builtin_')) {
        // Virtual provider was materialized — refetch to get real ID
        const providers = await invoke<ProviderConfig[]>('list_providers');
        set((state) => ({
          providers,
          providersMeta: replaceProvidersMeta(state.providersMeta),
          error: null,
        }));
        return;
      }
      set((s) => ({
        providers: s.providers.map((p) =>
          p.id === providerId ? { ...p, keys: [...p.keys, key] } : p,
        ),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateProviderKey: async (keyId, rawKey) => {
    try {
      const key = await invoke<ProviderKey>('update_provider_key', {
        keyId,
        rawKey,
      });
      set((s) => ({
        providers: s.providers.map((p) => ({
          ...p,
          keys: p.keys.map((k) => (k.id === keyId ? key : k)),
        })),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteProviderKey: async (keyId) => {
    try {
      await invoke('delete_provider_key', { keyId });
      set((s) => ({
        providers: s.providers.map((p) => ({
          ...p,
          keys: p.keys.filter((k) => k.id !== keyId),
        })),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  toggleProviderKey: async (keyId, enabled) => {
    try {
      await invoke('toggle_provider_key', { keyId, enabled });
      set((s) => ({
        providers: s.providers.map((p) => ({
          ...p,
          keys: p.keys.map((k) => (k.id === keyId ? { ...k, enabled } : k)),
        })),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  validateProviderKey: async (keyId) => {
    try {
      return await invoke<boolean>('validate_provider_key', { keyId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  saveModels: async (providerId, models) => {
    try {
      await invoke('save_models', { providerId, models });
      if (providerId.startsWith('builtin_')) {
        // Virtual provider was materialized — refetch to get real ID
        const providers = await invoke<ProviderConfig[]>('list_providers');
        set((state) => ({
          providers,
          providersMeta: replaceProvidersMeta(state.providersMeta),
          error: null,
        }));
        return;
      }
      set((s) => ({
        providers: s.providers.map((p) =>
          p.id === providerId ? { ...p, models } : p,
        ),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  toggleModel: async (providerId, modelId, enabled) => {
    try {
      const model = await invoke<Model>('toggle_model', {
        providerId,
        modelId,
        enabled,
      });
      set((s) => ({
        providers: s.providers.map((p) =>
          p.id === providerId
            ? {
                ...p,
                models: p.models.map((m) =>
                  m.model_id === modelId ? model : m,
                ),
              }
            : p,
        ),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
      return model;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateModelParams: async (providerId, modelId, overrides) => {
    try {
      const model = await invoke<Model>('update_model_params', {
        providerId,
        modelId,
        overrides,
      });
      set((s) => ({
        providers: s.providers.map((p) =>
          p.id === providerId
            ? {
                ...p,
                models: p.models.map((m) =>
                  m.model_id === modelId ? model : m,
                ),
              }
            : p,
        ),
        providersMeta: mutateProvidersMeta(s.providersMeta),
        error: null,
      }));
      return model;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  fetchRemoteModels: async (providerId) => {
    try {
      return await invoke<Model[]>('fetch_remote_models', { providerId });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  testModel: async (providerId, modelId) => {
    return await invoke<number>('test_model', { providerId, modelId });
  },
}));
