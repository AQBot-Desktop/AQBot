import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type {
  ProviderConfig,
  CreateProviderInput,
  UpdateProviderInput,
  ProviderKey,
  Model,
  ModelParamOverrides,
  DeepLinkProviderImportInput,
  DeepLinkProviderImportResult,
} from '@/types';

interface ProviderState {
  providers: ProviderConfig[];
  loading: boolean;
  error: string | null;
  fetchProviders: () => Promise<void>;
  createProvider: (input: CreateProviderInput) => Promise<ProviderConfig>;
  importProviderFromDeepLink: (input: DeepLinkProviderImportInput) => Promise<DeepLinkProviderImportResult>;
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

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [],
  loading: false,
  error: null,

  fetchProviders: async () => {
    set({ loading: true });
    try {
      const providers = await invoke<ProviderConfig[]>('list_providers');
      set({ providers, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createProvider: async (input) => {
    try {
      const provider = await invoke<ProviderConfig>('create_provider', { input });
      set((s) => ({ providers: [...s.providers, provider], error: null }));
      return provider;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  importProviderFromDeepLink: async (input) => {
    try {
      const result = await invoke<DeepLinkProviderImportResult>('import_provider_from_deep_link', { input });
      set({ error: null });
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
        set({ providers, error: null });
      } else {
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === id ? { ...p, enabled } : p,
          ),
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
      set({ providers });
    } else {
      set((s) => {
        const ordered = providerIds
          .map((id, i) => {
            const p = s.providers.find((p) => p.id === id);
            return p ? { ...p, sort_order: i } : null;
          })
          .filter(Boolean) as ProviderConfig[];
        return { providers: ordered };
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
        set({ providers, error: null });
        return;
      }
      set((s) => ({
        providers: s.providers.map((p) =>
          p.id === providerId ? { ...p, keys: [...p.keys, key] } : p,
        ),
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
      set((s) => ({
        providers: s.providers.map((p) =>
          p.id === providerId ? { ...p, models } : p,
        ),
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
