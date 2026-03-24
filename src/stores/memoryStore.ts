import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type { MemoryNamespace, MemoryItem, UpdateMemoryNamespaceInput } from '@/types';

interface MemoryState {
  namespaces: MemoryNamespace[];
  items: MemoryItem[];
  loading: boolean;
  error: string | null;
  selectedNamespaceId: string | null;

  loadNamespaces: () => Promise<void>;
  createNamespace: (name: string, scope: string, embeddingProvider?: string) => Promise<MemoryNamespace | null>;
  deleteNamespace: (id: string) => Promise<void>;
  updateNamespace: (id: string, input: UpdateMemoryNamespaceInput) => Promise<void>;
  loadItems: (namespaceId: string) => Promise<void>;
  addItem: (namespaceId: string, title: string, content: string) => Promise<void>;
  deleteItem: (namespaceId: string, itemId: string) => Promise<void>;
  setSelectedNamespaceId: (id: string | null) => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  namespaces: [],
  items: [],
  loading: false,
  error: null,
  selectedNamespaceId: null,

  loadNamespaces: async () => {
    set({ loading: true });
    try {
      const namespaces = await invoke<MemoryNamespace[]>('list_memory_namespaces');
      set({ namespaces, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createNamespace: async (name, scope, embeddingProvider) => {
    try {
      const ns = await invoke<MemoryNamespace>('create_memory_namespace', {
        input: { name, scope, embeddingProvider },
      });
      set((s) => ({ namespaces: [...s.namespaces, ns], error: null }));
      return ns;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  deleteNamespace: async (id) => {
    try {
      await invoke('delete_memory_namespace', { id });
      set((s) => ({ namespaces: s.namespaces.filter((n) => n.id !== id), error: null }));
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
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  loadItems: async (namespaceId) => {
    set({ loading: true });
    try {
      const items = await invoke<MemoryItem[]>('list_memory_items', { namespaceId: namespaceId });
      set({ items, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

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

  setSelectedNamespaceId: (id) => {
    set({ selectedNamespaceId: id });
  },
}));
