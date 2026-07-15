import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type {
  EnsureLoadedOptions,
  ResourceInvalidationReason,
  ResourceMeta,
} from '@/lib/resourceState';
import type { ConversationCategory } from '@/types';

const CATEGORIES_RESOURCE_KEY = 'conversation-categories';
let categoriesRequest: { revision: number; promise: Promise<void> } | null = null;

function mutateCategoriesMeta(meta: ResourceMeta): ResourceMeta {
  const remainsComplete = meta.status === 'ready' && meta.key === CATEGORIES_RESOURCE_KEY;
  return {
    status: remainsComplete ? 'ready' : 'idle',
    key: remainsComplete ? CATEGORIES_RESOURCE_KEY : null,
    loadedAt: remainsComplete ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

interface CategoryState {
  categories: ConversationCategory[];
  loading: boolean;
  categoriesMeta: ResourceMeta;
  ensureCategoriesLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateCategories: (reason: ResourceInvalidationReason) => void;
  fetchCategories: () => Promise<void>;
  createCategory: (input: {
    name: string;
    icon_type?: string | null;
    icon_value?: string | null;
    system_prompt?: string | null;
    default_provider_id?: string | null;
    default_model_id?: string | null;
    default_temperature?: number | null;
    default_max_tokens?: number | null;
    default_top_p?: number | null;
    default_frequency_penalty?: number | null;
  }) => Promise<ConversationCategory>;
  updateCategory: (
    id: string,
    input: {
      name?: string;
      icon_type?: string | null;
      icon_value?: string | null;
      system_prompt?: string | null;
      default_provider_id?: string | null;
      default_model_id?: string | null;
      default_temperature?: number | null;
      default_max_tokens?: number | null;
      default_top_p?: number | null;
      default_frequency_penalty?: number | null;
    },
  ) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  reorderCategories: (categoryIds: string[]) => Promise<void>;
  setCollapsed: (id: string, collapsed: boolean) => Promise<void>;
}

export const useCategoryStore = create<CategoryState>((set, get) => ({
  categories: [],
  loading: false,
  categoriesMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureCategoriesLoaded: async (options = {}) => {
    const state = get();
    const key = CATEGORIES_RESOURCE_KEY;
    if (!options.force && isResourceFresh(state.categoriesMeta, { ...options, key })) return;
    if (categoriesRequest?.revision === state.categoriesMeta.revision && !options.force) {
      return categoriesRequest.promise;
    }
    if (categoriesRequest) {
      await categoriesRequest.promise;
      return get().ensureCategoriesLoaded(options);
    }

    const revision = state.categoriesMeta.revision;
    set((current) => ({
      loading: true,
      categoriesMeta: { ...current.categoriesMeta, status: 'loading', key },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const categories = await invoke<ConversationCategory[]>('list_conversation_categories');
        if (get().categoriesMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            categories,
            loading: false,
            categoriesMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (error) {
        if (get().categoriesMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            loading: false,
            categoriesMeta: { ...current.categoriesMeta, status: 'error' },
          }));
          throw error;
        }
      } finally {
        categoriesRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureCategoriesLoaded();
    })();
    categoriesRequest = { revision, promise };
    return promise;
  },

  invalidateCategories: (_reason) => set((state) => ({
    categoriesMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.categoriesMeta.revision + 1,
    },
  })),

  fetchCategories: async () => {
    try {
      await get().ensureCategoriesLoaded({ force: true });
    } catch (error) {
      console.error('[categoryStore] fetchCategories failed:', error);
    }
  },

  createCategory: async (input) => {
    const category = await invoke<ConversationCategory>(
      'create_conversation_category',
      { input },
    );
    set((s) => ({
      categories: [...s.categories, category],
      categoriesMeta: mutateCategoriesMeta(s.categoriesMeta),
    }));
    return category;
  },

  updateCategory: async (id, input) => {
    const updated = await invoke<ConversationCategory>(
      'update_conversation_category',
      { id, input },
    );
    set((s) => ({
      categories: s.categories.map((c) => (c.id === id ? updated : c)),
      categoriesMeta: mutateCategoriesMeta(s.categoriesMeta),
    }));
  },

  deleteCategory: async (id) => {
    await invoke('delete_conversation_category', { id });
    set((s) => ({
      categories: s.categories.filter((c) => c.id !== id),
      categoriesMeta: mutateCategoriesMeta(s.categoriesMeta),
    }));
  },

  reorderCategories: async (categoryIds) => {
    await invoke('reorder_conversation_categories', { categoryIds });
    set((s) => {
      const ordered = categoryIds
        .map((id, i) => {
          const c = s.categories.find((c) => c.id === id);
          return c ? { ...c, sort_order: i } : null;
        })
        .filter(Boolean) as ConversationCategory[];
      return {
        categories: ordered,
        categoriesMeta: mutateCategoriesMeta(s.categoriesMeta),
      };
    });
  },

  setCollapsed: async (id, collapsed) => {
    set((s) => ({
      categories: s.categories.map((c) =>
        c.id === id ? { ...c, is_collapsed: collapsed } : c,
      ),
      categoriesMeta: mutateCategoriesMeta(s.categoriesMeta),
    }));
    await invoke('set_conversation_category_collapsed', { id, collapsed });
    set((s) => ({
      categories: s.categories.map((c) =>
        c.id === id ? { ...c, is_collapsed: collapsed } : c,
      ),
      categoriesMeta: mutateCategoriesMeta(s.categoriesMeta),
    }));
  },
}));
