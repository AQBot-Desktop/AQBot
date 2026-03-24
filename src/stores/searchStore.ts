import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type {
  SearchProvider,
  CreateSearchProviderInput,
  UpdateSearchProviderInput,
  SearchExecuteResponse,
} from '@/types';

interface SearchState {
  providers: SearchProvider[];
  loading: boolean;
  error: string | null;

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

export const useSearchStore = create<SearchState>((set) => ({
  providers: [],
  loading: false,
  error: null,

  loadProviders: async () => {
    set({ loading: true });
    try {
      const providers = await invoke<SearchProvider[]>('list_search_providers');
      set({ providers, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createProvider: async (input) => {
    try {
      const provider = await invoke<SearchProvider>('create_search_provider', { input });
      set((s) => ({ providers: [...s.providers, provider], error: null }));
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
      set((s) => ({ providers: s.providers.filter((p) => p.id !== id), error: null }));
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
