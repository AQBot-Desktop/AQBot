import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type { EnsureLoadedOptions, ResourceInvalidationReason, ResourceMeta } from '@/lib/resourceState';
import type {
  KnowledgeBase,
  KnowledgeDocument,
  CreateKnowledgeBaseInput,
  UpdateKnowledgeBaseInput,
} from '@/types';

const BASES_RESOURCE_KEY = 'knowledge-bases';
let basesRequest: { revision: number; promise: Promise<void> } | null = null;
const documentRequests = new Map<string, { revision: number; promise: Promise<void> }>();

function mutateBasesMeta(meta: ResourceMeta): ResourceMeta {
  const remainsComplete = meta.status === 'ready' && meta.key === BASES_RESOURCE_KEY;
  return {
    status: remainsComplete ? 'ready' : 'idle',
    key: remainsComplete ? BASES_RESOURCE_KEY : null,
    loadedAt: remainsComplete ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

interface KnowledgeState {
  bases: KnowledgeBase[];
  documents: KnowledgeDocument[];
  loading: boolean;
  error: string | null;
  selectedBaseId: string | null;
  basesMeta: ResourceMeta;
  documentsMeta: ResourceMeta;

  ensureBasesLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateBases: (reason: ResourceInvalidationReason) => void;
  loadBases: () => Promise<void>;
  createBase: (input: CreateKnowledgeBaseInput) => Promise<KnowledgeBase | null>;
  updateBase: (id: string, input: UpdateKnowledgeBaseInput) => Promise<void>;
  deleteBase: (id: string) => Promise<void>;
  reorderBases: (baseIds: string[]) => Promise<void>;
  ensureDocumentsLoaded: (baseId: string, options?: EnsureLoadedOptions) => Promise<void>;
  invalidateDocuments: (reason: ResourceInvalidationReason) => void;
  loadDocuments: (baseId: string) => Promise<void>;
  addDocument: (baseId: string, title: string, sourcePath: string, mimeType: string) => Promise<void>;
  deleteDocument: (knowledgeBaseId: string, documentId: string) => Promise<void>;
  setSelectedBaseId: (id: string | null) => void;
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  bases: [],
  documents: [],
  loading: false,
  error: null,
  selectedBaseId: null,
  basesMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  documentsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureBasesLoaded: async (options = {}) => {
    const key = BASES_RESOURCE_KEY;
    const state = get();
    if (!options.force && isResourceFresh(state.basesMeta, { ...options, key })) return;
    if (basesRequest?.revision === state.basesMeta.revision && !options.force) {
      return basesRequest.promise;
    }
    if (basesRequest) {
      await basesRequest.promise;
      return get().ensureBasesLoaded(options);
    }

    const revision = state.basesMeta.revision;
    set((state) => ({
      loading: true,
      basesMeta: { ...state.basesMeta, status: 'loading', key },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const bases = await invoke<KnowledgeBase[]>('list_knowledge_bases');
        if (get().basesMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            bases,
            loading: false,
            error: null,
            basesMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().basesMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            error: String(e),
            loading: false,
            basesMeta: { ...current.basesMeta, status: 'error' },
          }));
        }
      } finally {
        basesRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureBasesLoaded();
    })();
    basesRequest = { revision, promise };
    return promise;
  },

  invalidateBases: (_reason) => set((state) => ({
    basesMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.basesMeta.revision + 1,
    },
  })),

  loadBases: () => get().ensureBasesLoaded({ force: true }),

  createBase: async (input) => {
    try {
      const base = await invoke<KnowledgeBase>('create_knowledge_base', { input });
      set((s) => ({
        bases: [...s.bases, base],
        error: null,
        basesMeta: mutateBasesMeta(s.basesMeta),
      }));
      return base;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  updateBase: async (id, input) => {
    try {
      const updated = await invoke<KnowledgeBase>('update_knowledge_base', { id, input });
      set((s) => ({
        bases: s.bases.map((b) => (b.id === id ? updated : b)),
        error: null,
        basesMeta: mutateBasesMeta(s.basesMeta),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteBase: async (id) => {
    try {
      await invoke('delete_knowledge_base', { id });
      set((s) => ({
        bases: s.bases.filter((b) => b.id !== id),
        documents: s.documentsMeta.key === id ? [] : s.documents,
        error: null,
        basesMeta: mutateBasesMeta(s.basesMeta),
        documentsMeta: s.documentsMeta.key === id ? {
          status: 'idle',
          key: null,
          loadedAt: null,
          revision: s.documentsMeta.revision + 1,
        } : s.documentsMeta,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  reorderBases: async (baseIds) => {
    const prev = get().bases;
    const reordered = baseIds
      .map((id) => prev.find((b) => b.id === id))
      .filter(Boolean) as KnowledgeBase[];
    set((state) => ({
      bases: reordered,
      basesMeta: mutateBasesMeta(state.basesMeta),
    }));
    try {
      await invoke('reorder_knowledge_bases', { baseIds });
      set((state) => ({
        bases: baseIds
          .map((id) => state.bases.find((base) => base.id === id))
          .filter(Boolean) as KnowledgeBase[],
        basesMeta: mutateBasesMeta(state.basesMeta),
      }));
    } catch (e) {
      set((state) => ({
        bases: prev,
        error: String(e),
        basesMeta: mutateBasesMeta(state.basesMeta),
      }));
    }
  },

  ensureDocumentsLoaded: async (baseId, options = {}) => {
    const state = get();
    if (!options.force && isResourceFresh(state.documentsMeta, { ...options, key: baseId })) return;
    const pending = documentRequests.get(baseId);
    if (
      pending?.revision === state.documentsMeta.revision
      && state.documentsMeta.key === baseId
      && !options.force
    ) return pending.promise;
    if (pending) {
      await pending.promise;
      return get().ensureDocumentsLoaded(baseId, options);
    }

    const revision = state.documentsMeta.revision;
    set((state) => ({
      loading: true,
      documentsMeta: { ...state.documentsMeta, status: 'loading', key: baseId },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const documents = await invoke<KnowledgeDocument[]>('list_knowledge_documents', { baseId });
        const current = get().documentsMeta;
        if (current.revision !== revision) {
          reloadAfterCompletion = current.key === null || current.key === baseId;
          set({ loading: false });
        } else if (current.key === baseId) {
          set({
            documents,
            loading: false,
            error: null,
            documentsMeta: { status: 'ready', key: baseId, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        const current = get().documentsMeta;
        if (current.revision !== revision) {
          reloadAfterCompletion = current.key === null || current.key === baseId;
          set({ loading: false });
        } else if (current.key === baseId) {
          set({
            error: String(e),
            loading: false,
            documentsMeta: { ...current, status: 'error' },
          });
        }
      } finally {
        if (documentRequests.get(baseId)?.promise === promise) documentRequests.delete(baseId);
      }
      if (reloadAfterCompletion) await get().ensureDocumentsLoaded(baseId);
    })();
    documentRequests.set(baseId, { revision, promise });
    return promise;
  },

  invalidateDocuments: (_reason) => set((state) => ({
    documentsMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.documentsMeta.revision + 1,
    },
  })),

  loadDocuments: (baseId) => get().ensureDocumentsLoaded(baseId, { force: true }),

  addDocument: async (baseId, title, sourcePath, mimeType) => {
    try {
      await invoke('add_knowledge_document', { baseId, title, sourcePath, mimeType });
      await get().loadDocuments(baseId);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteDocument: async (knowledgeBaseId, documentId) => {
    try {
      await invoke('delete_knowledge_document', { baseId: knowledgeBaseId, id: documentId });
      await get().loadDocuments(knowledgeBaseId);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  setSelectedBaseId: (id) => {
    set({ selectedBaseId: id });
  },
}));
