import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionToolbarSnapshot, SelectionToolbarToolView } from '@/types';

const invokeMock = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));

const translateTool: SelectionToolbarToolView = {
  id: 'translate',
  kind: 'ai',
  builtin_key: 'translate',
  name: null,
  icon: 'languages',
};

const explainTool: SelectionToolbarToolView = {
  id: 'explain',
  kind: 'ai',
  builtin_key: 'explain',
  name: null,
  icon: 'sparkles',
};

const modelA = { provider_id: 'provider-a', model_id: 'model-a' };
const modelB = { provider_id: 'provider-b', model_id: 'model-b' };

function receipt(requestId: string, model = modelA) {
  return { request_id: requestId, model_target: model };
}

function snapshot(overrides: Partial<SelectionToolbarSnapshot> = {}): SelectionToolbarSnapshot {
  return {
    runtime: {
      state: 'running',
      platform: 'macos',
      permission: 'granted',
      last_error: null,
      global_dismissal_supported: true,
    },
    session: {
      selection_id: 'selection-1',
      tools: [translateTool, explainTool],
      theme: 'light',
      language: 'en-US',
      display_mode: 'full',
      resolved_placement: 'below',
      pinned: false,
      input_kind: 'text',
    },
    run: null,
    history: [],
    capture_error: null,
    ...overrides,
  };
}

async function initializeStore(current = snapshot()) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'selection_toolbar_get_snapshot') return current;
    if (command === 'selection_toolbar_execute_tool') return receipt('request-1', modelA);
    if (command === 'selection_toolbar_follow_up') return receipt('request-2', modelB);
    if (command === 'selection_toolbar_regenerate') return receipt('request-3', modelB);
    return undefined;
  });
  const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
  await useSelectionToolbarStore.getState().initialize();
  return useSelectionToolbarStore;
}

describe('selection toolbar model override', () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('stores a temporary model without sending a request', async () => {
    const store = await initializeStore();
    store.getState().selectModelTarget(modelB);
    expect(store.getState().selectedModelTarget).toEqual(modelB);
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_follow_up', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_regenerate', expect.anything());
  });

  it('sends the selected model on first execute, follow-up, and regenerate', async () => {
    const store = await initializeStore();
    store.getState().selectModelTarget(modelB);
    await store.getState().executeTool({ ...translateTool, direct_send: true });
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.objectContaining({
      options: expect.objectContaining({ model_target: modelB }),
    }));
    expect(store.getState().run).toMatchObject({
      request_id: 'request-1',
      model_target: modelA,
    });

    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'completed',
        request_id: 'request-1',
        selection_id: 'selection-1',
        output: 'answer A',
      },
    });
    store.getState().selectModelTarget(modelB);
    await store.getState().followUp('Why?');
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_follow_up', expect.objectContaining({
      selectionId: 'selection-1',
      text: 'Why?',
      modelTarget: modelB,
    }));
    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'completed',
        request_id: 'request-2',
        selection_id: 'selection-1',
        output: 'answer B',
      },
    });
    await store.getState().regenerate();
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_regenerate', expect.objectContaining({
      selectionId: 'selection-1',
      requestId: 'request-2',
      modelTarget: modelB,
    }));
  });

  it('keeps the temporary model when translate languages change and clears it when switching tools', async () => {
    const store = await initializeStore();
    store.getState().selectModelTarget(modelB);
    await store.getState().setTranslateLanguages('en', 'ja');
    expect(store.getState().selectedModelTarget).toEqual(modelB);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.objectContaining({
      options: expect.objectContaining({ model_target: modelB, target_language: 'ja' }),
    }));

    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'completed',
        request_id: 'request-1',
        selection_id: 'selection-1',
        output: 'translated',
      },
    });
    await store.getState().executeTool({ ...explainTool, direct_send: true });
    expect(store.getState().selectedModelTarget).toBeNull();
  });

  it('clears the temporary model for a new selection and on close', async () => {
    const store = await initializeStore();
    store.getState().selectModelTarget(modelB);
    listeners.get('selection-toolbar://session')?.({
      payload: {
        selection_id: 'selection-2',
        tools: [translateTool],
        theme: 'dark',
        language: 'zh-CN',
      },
    });
    expect(store.getState().selectedModelTarget).toBeNull();

    store.getState().selectModelTarget(modelB);
    await store.getState().close('close_button');
    expect(store.getState().selectedModelTarget).toBeNull();
  });

  it('retries a frontend-only first-turn failure through execute instead of regenerate', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') return snapshot();
      if (command === 'selection_toolbar_execute_tool') {
        throw new Error('No default Chat model is configured');
      }
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();
    await useSelectionToolbarStore.getState().executeTool({ ...translateTool, direct_send: true });
    expect(useSelectionToolbarStore.getState().run?.request_id).toMatch(/^frontend-error-/);
    expect(useSelectionToolbarStore.getState().lastSubmission).toMatchObject({
      selection_id: 'selection-1',
      tool_id: 'translate',
    });

    useSelectionToolbarStore.getState().selectModelTarget(modelB);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_execute_tool') return receipt('request-fixed', modelB);
      return undefined;
    });
    await useSelectionToolbarStore.getState().regenerate();
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.objectContaining({
      options: expect.objectContaining({ model_target: modelB }),
    }));
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_regenerate', expect.anything());
    expect(useSelectionToolbarStore.getState().run).toMatchObject({
      request_id: 'request-fixed',
      model_target: modelB,
    });
  });

  it('keeps streamed output when the started event arrives before the receipt', async () => {
    let resolveExecute!: (value: unknown) => void;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') return snapshot();
      if (command === 'selection_toolbar_execute_tool') {
        return new Promise((resolve) => { resolveExecute = resolve; });
      }
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();
    const sending = useSelectionToolbarStore.getState().executeTool({ ...translateTool, direct_send: true });
    await Promise.resolve();
    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'started',
        request_id: 'request-live',
        selection_id: 'selection-1',
        tool_id: 'translate',
        mode: 'new_tool',
        user_input: null,
        model_target: modelA,
      },
    });
    listeners.get('selection-toolbar://run')?.({
      payload: { kind: 'delta', request_id: 'request-live', selection_id: 'selection-1', delta: 'partial' },
    });
    resolveExecute(receipt('request-live', modelA));
    await sending;
    expect(useSelectionToolbarStore.getState().run).toMatchObject({
      request_id: 'request-live',
      output: 'partial',
      model_target: modelA,
    });
  });
});
