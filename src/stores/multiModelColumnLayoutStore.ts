import { create } from 'zustand';
import { invoke, listen } from '@/lib/invoke';
import {
  emptyMultiModelColumnLayout,
  normalizeMultiModelSideBySideWidthMode,
  type MultiModelColumnLayout,
  type MultiModelColumnLayoutView,
} from '@/lib/multiModelColumnLayout';

export const MULTI_MODEL_COLUMN_LAYOUT_EVENT = 'aqbot:multi-model-column-layout';

interface MultiModelColumnLayoutState {
  layout: MultiModelColumnLayout;
  loaded: boolean;
  error: string | null;
  ensureLoaded: () => Promise<void>;
  invalidate: () => void;
  applyLayout: (layout: MultiModelColumnLayout) => void;
  setWidthMode: (
    view: MultiModelColumnLayoutView,
    mode: MultiModelColumnLayout['mainWidthMode'],
  ) => Promise<void>;
  setColumnWidth: (input: {
    view: MultiModelColumnLayoutView;
    providerId: string;
    modelId: string;
    widthPx: number | null;
  }) => Promise<void>;
}

function normalizeLayout(value: Partial<MultiModelColumnLayout> | null | undefined): MultiModelColumnLayout {
  return {
    mainWidthMode: normalizeMultiModelSideBySideWidthMode(value?.mainWidthMode),
    popoutWidthMode: normalizeMultiModelSideBySideWidthMode(value?.popoutWidthMode),
    columnWidths: { ...(value?.columnWidths ?? {}) },
  };
}

let loadPromise: Promise<void> | null = null;
let listening = false;

async function ensureLayoutListener(): Promise<void> {
  if (listening) return;
  listening = true;
  await listen<MultiModelColumnLayout>(MULTI_MODEL_COLUMN_LAYOUT_EVENT, (event) => {
    useMultiModelColumnLayoutStore.getState().applyLayout(event.payload);
  });
}

export const useMultiModelColumnLayoutStore = create<MultiModelColumnLayoutState>((set, get) => ({
  layout: emptyMultiModelColumnLayout(),
  loaded: false,
  error: null,

  applyLayout: (layout) => {
    set({
      layout: normalizeLayout(layout),
      loaded: true,
      error: null,
    });
  },

  invalidate: () => {
    set({ loaded: false });
    void get().ensureLoaded();
  },

  ensureLoaded: async () => {
    if (get().loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        await ensureLayoutListener();
        const layout = await invoke<MultiModelColumnLayout>('get_multi_model_column_layout');
        get().applyLayout(layout);
      } catch (error) {
        set({ error: String(error) });
        throw error;
      } finally {
        loadPromise = null;
      }
    })();
    return loadPromise;
  },

  setWidthMode: async (view, mode) => {
    const previous = get().layout;
    const next = {
      ...previous,
      ...(view === 'popout' ? { popoutWidthMode: mode } : { mainWidthMode: mode }),
    };
    set({ layout: next, error: null });
    try {
      const saved = await invoke<MultiModelColumnLayout>('set_multi_model_side_by_side_width_mode', {
        view,
        mode,
      });
      get().applyLayout(saved);
    } catch (error) {
      set({ layout: previous, error: String(error) });
      throw error;
    }
  },

  setColumnWidth: async ({ view, providerId, modelId, widthPx }) => {
    const previous = get().layout;
    const key = `${providerId}:${modelId}`;
    const columnWidths = { ...previous.columnWidths };
    if (widthPx == null) {
      delete columnWidths[key];
    } else {
      columnWidths[key] = widthPx;
    }
    const next: MultiModelColumnLayout = {
      ...previous,
      columnWidths,
      ...(widthPx == null
        ? {}
        : view === 'popout'
          ? { popoutWidthMode: 'scroll' as const }
          : { mainWidthMode: 'scroll' as const }),
    };
    set({ layout: next, error: null });
    try {
      const saved = await invoke<MultiModelColumnLayout>('set_multi_model_column_width', {
        view,
        providerId,
        modelId,
        widthPx,
      });
      get().applyLayout(saved);
    } catch (error) {
      set({ layout: previous, error: String(error) });
      throw error;
    }
  },
}));
