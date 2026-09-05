import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

function receipt(requestId: string, modelId = 'model-1') {
  return { request_id: requestId, model_target: { provider_id: 'provider-1', model_id: modelId } };
}

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));

describe('selection toolbar store', () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('ignores stale run chunks and resets result state for a new selection', async () => {
    invokeMock.mockResolvedValue({
      runtime: {
        state: 'running',
        platform: 'macos',
        permission: 'granted',
        last_error: null,
        global_dismissal_supported: true,
      },
      session: {
        selection_id: 'selection-1',
        tools: [],
        theme: 'light',
        language: 'en-US',
      },
      run: null,
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'started',
        request_id: 'request-1',
        selection_id: 'selection-1',
        tool_id: 'summarize',
        mode: 'new_tool',
        user_input: null,
      },
    });
    listeners.get('selection-toolbar://run')?.({
      payload: { kind: 'delta', request_id: 'request-1', selection_id: 'selection-1', delta: 'kept' },
    });
    listeners.get('selection-toolbar://run')?.({
      payload: { kind: 'delta', request_id: 'request-old', selection_id: 'selection-1', delta: 'ignored' },
    });
    expect(useSelectionToolbarStore.getState().run?.output).toBe('kept');

    listeners.get('selection-toolbar://session')?.({
      payload: {
        selection_id: 'selection-2',
        tools: [],
        theme: 'dark',
        language: 'zh-CN',
      },
    });
    expect(useSelectionToolbarStore.getState().session?.selection_id).toBe('selection-2');
    expect(useSelectionToolbarStore.getState().history).toEqual([]);
    expect(useSelectionToolbarStore.getState().run).toBeNull();
  });

  it('restores history and archives the current turn when a follow-up starts', async () => {
    invokeMock.mockResolvedValue({
      runtime: {
        state: 'running',
        platform: 'macos',
        permission: 'granted',
        last_error: null,
        global_dismissal_supported: true,
      },
      session: {
        selection_id: 'selection-1',
        tools: [],
        theme: 'light',
        language: 'en-US',
        display_mode: 'full',
        resolved_placement: 'below',
        pinned: false,
      },
      history: [
        {
          request_id: 'request-1',
          mode: 'new_tool',
          user_input: null,
          status: 'completed',
          output: 'first answer',
          error: null,
        },
        {
          request_id: 'request-2',
          mode: 'follow_up',
          user_input: 'first question',
          status: 'completed',
          output: 'second answer',
          error: null,
        },
      ],
      run: {
        request_id: 'request-2',
        selection_id: 'selection-1',
        tool_id: 'summarize',
        mode: 'follow_up',
        user_input: 'first question',
        status: 'completed',
        output: 'second answer',
        error: null,
      },
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    expect(useSelectionToolbarStore.getState().history).toHaveLength(1);
    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'started',
        request_id: 'request-3',
        selection_id: 'selection-1',
        tool_id: 'summarize',
        mode: 'follow_up',
        user_input: 'second question',
      },
    });

    expect(useSelectionToolbarStore.getState().history).toEqual([
      expect.objectContaining({ request_id: 'request-1', output: 'first answer' }),
      expect.objectContaining({ request_id: 'request-2', output: 'second answer' }),
    ]);
    expect(useSelectionToolbarStore.getState().run).toMatchObject({
      request_id: 'request-3',
      mode: 'follow_up',
      user_input: 'second question',
      status: 'started',
    });

    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'started',
        request_id: 'request-4',
        selection_id: 'selection-1',
        tool_id: 'explain',
        mode: 'new_tool',
        user_input: null,
      },
    });
    expect(useSelectionToolbarStore.getState().history).toEqual([]);
  });

  it('hides the replaced latest turn when restoring an in-flight regeneration', async () => {
    invokeMock.mockResolvedValue({
      runtime: {
        state: 'running',
        platform: 'macos',
        permission: 'granted',
        last_error: null,
        global_dismissal_supported: true,
      },
      session: {
        selection_id: 'selection-1',
        tools: [],
        theme: 'light',
        language: 'en-US',
        display_mode: 'full',
        resolved_placement: 'below',
        pinned: false,
      },
      // The backend omits the turn being replaced while regeneration is active.
      history: [{
        request_id: 'request-1',
        mode: 'new_tool',
        user_input: null,
        status: 'completed',
        output: 'first answer',
        error: null,
      }],
      run: {
        request_id: 'request-3',
        selection_id: 'selection-1',
        tool_id: 'summarize',
        mode: 'regenerate',
        user_input: 'Why?',
        status: 'streaming',
        output: 'new',
        error: null,
      },
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    expect(useSelectionToolbarStore.getState().history).toEqual([
      expect.objectContaining({ request_id: 'request-1' }),
    ]);
    expect(useSelectionToolbarStore.getState().run).toMatchObject({
      request_id: 'request-3',
      output: 'new',
    });
  });

  it('refreshes the active session without discarding an in-flight run', async () => {
    invokeMock.mockResolvedValue({
      runtime: {
        state: 'running',
        platform: 'macos',
        permission: 'granted',
        last_error: null,
        global_dismissal_supported: true,
      },
      session: {
        selection_id: 'selection-1',
        tools: [],
        theme: 'light',
        language: 'en-US',
      },
      run: {
        request_id: 'request-1',
        selection_id: 'selection-1',
        tool_id: 'summarize',
        status: 'streaming',
        output: 'partial',
        error: null,
      },
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    listeners.get('selection-toolbar://session')?.({
      payload: {
        selection_id: 'selection-1',
        tools: [{ id: 'copy', kind: 'action', icon: 'copy', label_key: 'copy' }],
        theme: 'dark',
        language: 'zh-CN',
      },
    });

    expect(useSelectionToolbarStore.getState().run?.output).toBe('partial');
    expect(useSelectionToolbarStore.getState().surface).toBe('result');
    expect(useSelectionToolbarStore.getState().session?.theme).toBe('dark');
  });

  it('shows execution preflight failures in the result surface', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [],
            theme: 'light',
            language: 'en-US',
          },
          run: null,
        };
      }
      if (command === 'selection_toolbar_execute_tool') {
        throw new Error('Configured model is disabled');
      }
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    await useSelectionToolbarStore.getState().executeTool({
      id: 'translate',
      kind: 'ai',
      icon: 'languages',
      builtin_key: 'translate',
      name: null,
    });

    expect(useSelectionToolbarStore.getState().surface).toBe('result');
    expect(useSelectionToolbarStore.getState().run).toMatchObject({
      selection_id: 'selection-1',
      tool_id: 'translate',
      status: 'error',
      output: '',
      error: 'Error: Configured model is disabled',
    });
  });

  it('does not let an older snapshot overwrite a session event received during startup', async () => {
    let resolveSnapshot!: (value: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command !== 'selection_toolbar_get_snapshot') return Promise.resolve(undefined);
      return new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    const initializing = useSelectionToolbarStore.getState().initialize();
    await Promise.resolve();
    await Promise.resolve();

    listeners.get('selection-toolbar://session')?.({
      payload: {
        selection_id: 'selection-new',
        tools: [],
        theme: 'dark',
        language: 'zh-CN',
      },
    });
    resolveSnapshot({
      runtime: {
        state: 'running',
        platform: 'macos',
        permission: 'granted',
        last_error: null,
        global_dismissal_supported: true,
      },
      session: {
        selection_id: 'selection-old',
        tools: [],
        theme: 'light',
        language: 'en-US',
      },
      run: null,
    });
    await initializing;

    expect(useSelectionToolbarStore.getState().session?.selection_id).toBe('selection-new');
    expect(useSelectionToolbarStore.getState().runtime.state).toBe('running');
  });

  it('re-runs translate with the panel languages and persists target changes', async () => {
    const translateTool = {
      id: 'translate',
      kind: 'ai' as const,
      icon: 'languages',
      builtin_key: 'translate' as const,
      name: null,
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [translateTool],
            theme: 'light',
            language: 'en-US',
            translate_target_language: null,
          },
          run: null,
        };
      }
      if (command === 'selection_toolbar_execute_tool') return receipt('request-9');
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    await useSelectionToolbarStore.getState().setTranslateLanguages('en', 'ja');

    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_set_translate_target', {
      language: 'ja',
    });
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', {
      selectionId: 'selection-1',
      toolId: 'translate',
      options: { source_language: 'en', target_language: 'ja' },
    });

    // A plain re-click on the translate tool keeps the chosen languages.
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (command: string) =>
      command === 'selection_toolbar_execute_tool' ? receipt('request-10') : undefined,
    );
    await useSelectionToolbarStore.getState().executeTool(translateTool);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', {
      selectionId: 'selection-1',
      toolId: 'translate',
      options: { source_language: 'en', target_language: 'ja' },
    });
  });

  it('sends no language options for non-translate tools', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [],
            theme: 'light',
            language: 'en-US',
          },
          run: null,
        };
      }
      if (command === 'selection_toolbar_execute_tool') return receipt('request-11');
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    await useSelectionToolbarStore.getState().executeTool({
      id: 'summarize',
      kind: 'ai',
      icon: 'list-collapse',
      builtin_key: 'summarize',
      name: null,
    });

    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', {
      selectionId: 'selection-1',
      toolId: 'summarize',
      options: null,
    });
  });

  it('routes copy and search actions to dedicated commands', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [
              { id: 'copy', kind: 'action', icon: 'copy', builtin_key: 'copy', name: null },
              { id: 'search', kind: 'action', icon: 'search', builtin_key: 'search', name: null },
            ],
            theme: 'light',
            language: 'en-US',
          },
          run: null,
        };
      }
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    await useSelectionToolbarStore.getState().executeTool({
      id: 'search',
      kind: 'action',
      icon: 'search',
      builtin_key: 'search',
      name: null,
    });
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_search_selection', {
      selectionId: 'selection-1',
    });

    await useSelectionToolbarStore.getState().executeTool({
      id: 'copy',
      kind: 'action',
      icon: 'copy',
      builtin_key: 'copy',
      name: null,
    });
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_copy_selection', {
      selectionId: 'selection-1',
    });
  });

  it('routes stop, result copy, and close through request and selection identifiers', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [],
            theme: 'light',
            language: 'en-US',
          },
          run: {
            request_id: 'request-1',
            selection_id: 'selection-1',
            tool_id: 'summarize',
            status: 'stopped',
            output: 'partial',
            error: null,
          },
        };
      }
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    await useSelectionToolbarStore.getState().stop();
    await useSelectionToolbarStore.getState().copyResult();
    await useSelectionToolbarStore.getState().close('close_button');

    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_stop_generation', {
      requestId: 'request-1',
    });
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_copy_result', {
      requestId: 'request-1',
    });
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_close', {
      reason: 'close_button',
    });
    expect(useSelectionToolbarStore.getState().session).toBeNull();
  });

  it('routes follow-up, regenerate, pin, and drag-ended through their dedicated commands', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [],
            theme: 'light',
            language: 'en-US',
            display_mode: 'full',
            resolved_placement: 'below',
            pinned: false,
          },
          history: [],
          run: {
            request_id: 'request-1',
            selection_id: 'selection-1',
            tool_id: 'summarize',
            mode: 'new_tool',
            user_input: null,
            status: 'completed',
            output: 'answer',
            error: null,
          },
        };
      }
      if (command === 'selection_toolbar_follow_up') return receipt('request-2');
      if (command === 'selection_toolbar_regenerate') return receipt('request-3');
      if (command === 'selection_toolbar_set_pinned') return false;
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    await useSelectionToolbarStore.getState().followUp('  Why?  ');
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_follow_up', {
      selectionId: 'selection-1',
      text: 'Why?',
    });
    expect(useSelectionToolbarStore.getState().history).toEqual([
      expect.objectContaining({ request_id: 'request-1', output: 'answer' }),
    ]);
    expect(useSelectionToolbarStore.getState().run).toMatchObject({
      request_id: 'request-2',
      mode: 'follow_up',
      user_input: 'Why?',
    });

    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'completed',
        request_id: 'request-2',
        selection_id: 'selection-1',
        output: 'because',
      },
    });
    await useSelectionToolbarStore.getState().copyResult();
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_copy_result', {
      requestId: 'request-2',
    });
    await useSelectionToolbarStore.getState().regenerate();
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_regenerate', {
      selectionId: 'selection-1',
      requestId: 'request-2',
    });
    expect(useSelectionToolbarStore.getState()).toMatchObject({
      history: [expect.objectContaining({ request_id: 'request-1' })],
      run: expect.objectContaining({
        request_id: 'request-3',
        mode: 'regenerate',
        user_input: 'Why?',
      }),
    });

    await useSelectionToolbarStore.getState().setPinned(true);
    await useSelectionToolbarStore.getState().dragEnded();
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_set_pinned', {
      selectionId: 'selection-1',
      pinned: true,
    });
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_drag_ended', {
      selectionId: 'selection-1',
    });
    // The backend is authoritative if platform/runtime policy changes the request.
    expect(useSelectionToolbarStore.getState().session?.pinned).toBe(false);
  });

  it('keeps the current answer available when a follow-up command fails', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [],
            theme: 'light',
            language: 'en-US',
            display_mode: 'full',
            resolved_placement: 'below',
            pinned: false,
          },
          history: [{
            request_id: 'request-1',
            mode: 'new_tool',
            user_input: null,
            status: 'completed',
            output: 'answer',
            error: null,
          }],
          run: {
            request_id: 'request-1',
            selection_id: 'selection-1',
            tool_id: 'summarize',
            mode: 'new_tool',
            user_input: null,
            status: 'completed',
            output: 'answer',
            error: null,
          },
        };
      }
      if (command === 'selection_toolbar_follow_up') {
        throw new Error('context limit');
      }
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();

    const sent = await useSelectionToolbarStore.getState().followUp('Why?');

    expect(sent).toBe(false);
    expect(useSelectionToolbarStore.getState()).toMatchObject({
      history: [],
      run: expect.objectContaining({ request_id: 'request-1', output: 'answer' }),
      busy: false,
      error: 'Error: context limit',
    });
  });

  it('allows a follow-up after stopping a run with partial output', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [],
            theme: 'light',
            language: 'en-US',
            display_mode: 'full',
            resolved_placement: 'below',
            pinned: false,
          },
          history: [],
          run: {
            request_id: 'request-1',
            selection_id: 'selection-1',
            tool_id: 'summarize',
            mode: 'new_tool',
            user_input: null,
            status: 'streaming',
            output: 'partial',
            error: null,
          },
        };
      }
      if (command === 'selection_toolbar_follow_up') return receipt('request-2');
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();
    listeners.get('selection-toolbar://run')?.({
      payload: {
        kind: 'stopped',
        request_id: 'request-1',
        selection_id: 'selection-1',
        output: 'partial',
      },
    });

    const sent = await useSelectionToolbarStore.getState().followUp('Continue');

    expect(sent).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_follow_up', {
      selectionId: 'selection-1',
      text: 'Continue',
    });
    expect(useSelectionToolbarStore.getState().history).toEqual([
      expect.objectContaining({ request_id: 'request-1', status: 'stopped' }),
    ]);
  });

  it('rejects follow-up for error turns and stopped turns without output', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [],
            theme: 'light',
            language: 'en-US',
            display_mode: 'full',
            resolved_placement: 'below',
            pinned: false,
          },
          history: [],
          run: {
            request_id: 'request-1',
            selection_id: 'selection-1',
            tool_id: 'summarize',
            mode: 'new_tool',
            user_input: null,
            status: 'error',
            output: 'partial',
            error: 'provider failed',
          },
        };
      }
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    await useSelectionToolbarStore.getState().initialize();
    invokeMock.mockClear();

    expect(await useSelectionToolbarStore.getState().followUp('Why?')).toBe(false);
    useSelectionToolbarStore.setState((state) => ({
      run: state.run ? { ...state.run, status: 'stopped', output: '   ', error: null } : null,
    }));
    expect(await useSelectionToolbarStore.getState().followUp('Continue')).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('opens overflow with its measured height and keeps the backend direction', async () => {
    let readSurface = () => 'uninitialized';
    let surfaceWhenNativeFrameChanged = '';
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') {
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
            tools: [],
            theme: 'light',
            language: 'en-US',
          },
          run: null,
        };
      }
      if (command === 'selection_toolbar_prepare_overflow') return 'above';
      if (command === 'selection_toolbar_set_surface') {
        surfaceWhenNativeFrameChanged = readSurface();
        return 'above';
      }
      return undefined;
    });
    const { useSelectionToolbarStore } = await import('../selectionToolbarStore');
    readSurface = () => useSelectionToolbarStore.getState().surface;
    await useSelectionToolbarStore.getState().initialize();

    await useSelectionToolbarStore.getState().toggleOverflow(119);

    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_prepare_overflow', {
      overflowHeight: 119,
    });
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_set_surface', {
      surface: 'overflow',
      overflowHeight: 119,
    });
    expect(useSelectionToolbarStore.getState()).toMatchObject({
      surface: 'overflow',
      overflowDirection: 'above',
    });
    expect(surfaceWhenNativeFrameChanged).toBe('overflow');

    await useSelectionToolbarStore.getState().toggleOverflow();
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_set_surface', {
      surface: 'toolbar',
      overflowHeight: null,
    });
    expect(useSelectionToolbarStore.getState()).toMatchObject({
      surface: 'toolbar',
      overflowDirection: 'below',
    });
    expect(surfaceWhenNativeFrameChanged).toBe('overflow');
  });
});
