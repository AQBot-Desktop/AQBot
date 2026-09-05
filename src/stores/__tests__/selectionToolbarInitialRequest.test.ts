import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionToolbarInput, SelectionToolbarSnapshot, SelectionToolbarToolView } from '@/types';

const invokeMock = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));

const tool: SelectionToolbarToolView = {
  id: 'translate', kind: 'ai', builtin_key: 'translate', name: null, icon: 'languages', direct_send: false,
};
let input: SelectionToolbarInput;
let snapshot: SelectionToolbarSnapshot;
let requestNumber: number;

function receipt(requestId: string) {
  return { request_id: requestId, model_target: { provider_id: 'provider-1', model_id: 'model-1' } };
}

async function initializeStore() {
  const { useSelectionToolbarStore: store } = await import('../selectionToolbarStore');
  await store.getState().initialize();
  return store;
}

describe('selection toolbar initial requests', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listeners.clear();
    requestNumber = 0;
    input = { kind: 'text', text: 'Original selection' };
    snapshot = {
      runtime: { state: 'running', platform: 'macos', permission: 'granted', last_error: null, global_dismissal_supported: true },
      session: {
        selection_id: 'selection', tools: [tool], theme: 'light', language: 'en-US',
        input_kind: 'text', display_mode: 'full', resolved_placement: 'below', pinned: false,
      },
      run: null, history: [], capture_error: null,
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'selection_toolbar_get_snapshot') return snapshot;
      if (command === 'selection_toolbar_get_input') return input;
      if (command === 'selection_toolbar_execute_tool') return receipt(`request-${++requestNumber}`);
      if (command === 'selection_toolbar_prepare_overflow') return 'below';
      return undefined;
    });
  });

  afterEach(() => vi.useRealTimers());

  it('prepares editable source without sending, then sends source and instructions separately as the first turn', async () => {
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_get_input', { selectionId: 'selection' });
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.anything());
    expect(store.getState()).toMatchObject({ surface: 'result', run: null, pendingRequest: { input } });

    store.getState().updatePendingRequest({ sourceText: 'Edited source', userInput: '  Use a formal tone  ' });
    expect(await store.getState().submitInitial()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', {
      selectionId: 'selection', toolId: 'translate',
      options: { source_language: 'auto', target_language: null, source_text: 'Edited source', user_input: 'Use a formal tone' },
    });
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_follow_up', expect.anything());
    expect(input).toEqual({ kind: 'text', text: 'Original selection' });
    expect(store.getState()).toMatchObject({
      pendingRequest: null,
      lastSubmission: { input: { kind: 'text', text: 'Edited source' }, user_input: 'Use a formal tone' },
      run: { mode: 'new_tool', user_input: 'Use a formal tone' },
    });
  });

  it('requires nonblank source but accepts an empty optional instruction', async () => {
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    store.getState().updatePendingRequest({ sourceText: ' \n ' });
    expect(await store.getState().submitInitial()).toBe(false);
    expect(store.getState().error).toBe('selection_toolbar_source_text_required');
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.anything());
    store.getState().updatePendingRequest({ sourceText: 'Valid source' });
    expect(await store.getState().submitInitial()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.objectContaining({
      options: expect.objectContaining({ source_text: 'Valid source', user_input: null }),
    }));
  });

  it('retains a rejected draft for retry and only clears it when accepted', async () => {
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    store.getState().updatePendingRequest({ userInput: 'Keep this instruction' });
    const pending = store.getState().pendingRequest;
    invokeMock.mockRejectedValueOnce('selection_toolbar_vision_required');
    expect(await store.getState().submitInitial()).toBe(false);
    expect(store.getState()).toMatchObject({
      pendingRequest: pending,
      run: null,
      lastSubmission: { user_input: 'Keep this instruction' },
    });
    expect(store.getState().error).toBe('selection_toolbar_vision_required');
    expect(await store.getState().submitInitial()).toBe(true);
    expect(store.getState().pendingRequest).toBeNull();
  });

  it('stops a previous stream and ignores its events while preparing a new manual request', async () => {
    snapshot.run = {
      request_id: 'old-request', selection_id: 'selection', tool_id: 'old-tool', mode: 'new_tool',
      user_input: null, status: 'streaming', output: 'Old answer', error: null,
    };
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    const commands = invokeMock.mock.calls.map(([command]) => command);
    expect(commands.indexOf('selection_toolbar_stop_generation')).toBeLessThan(commands.indexOf('selection_toolbar_get_input'));
    listeners.get('selection-toolbar://run')?.({ payload: {
      kind: 'started', request_id: 'old-request', selection_id: 'selection', tool_id: 'old-tool',
      mode: 'new_tool', user_input: null,
    } });
    listeners.get('selection-toolbar://run')?.({ payload: {
      kind: 'completed', request_id: 'old-request', selection_id: 'selection', output: 'Old answer',
    } });
    expect(store.getState().run).toBeNull();
    expect(store.getState().pendingRequest?.tool_id).toBe('translate');
  });

  it.each(['started', 'streaming'] as const)('stops an existing %s run before executing a direct-send tool', async (status) => {
    snapshot.run = {
      request_id: 'old-request', selection_id: 'selection', tool_id: 'old-tool', mode: 'new_tool',
      user_input: null, status, output: 'Old answer', error: null,
    };
    const store = await initializeStore();
    await store.getState().executeTool({ ...tool, direct_send: true });
    const commands = invokeMock.mock.calls.map(([command]) => command);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_stop_generation', { requestId: 'old-request' });
    expect(commands.indexOf('selection_toolbar_stop_generation')).toBeLessThan(commands.indexOf('selection_toolbar_execute_tool'));
    expect(store.getState().run).toMatchObject({ request_id: 'request-1', tool_id: 'translate' });
  });

  it('does not send a new request or replace the old run when stopping it fails', async () => {
    snapshot.run = {
      request_id: 'old-request', selection_id: 'selection', tool_id: 'old-tool', mode: 'new_tool',
      user_input: null, status: 'streaming', output: 'Old answer', error: null,
    };
    const store = await initializeStore();
    invokeMock.mockRejectedValueOnce('Could not stop the active request');
    await store.getState().executeTool({ ...tool, direct_send: true });
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.anything());
    expect(store.getState()).toMatchObject({
      busy: false, error: 'Could not stop the active request',
      run: { request_id: 'old-request', status: 'streaming', output: 'Old answer' },
    });
  });

  it('does not send the queued initial request if a new screenshot session arrives while stopping the old run', async () => {
    snapshot.run = {
      request_id: 'old-request', selection_id: 'selection', tool_id: 'old-tool', mode: 'new_tool',
      user_input: null, status: 'streaming', output: 'Old answer', error: null,
    };
    const store = await initializeStore();
    let finishStop!: () => void;
    invokeMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    const switching = store.getState().executeTool({ ...tool, direct_send: true });
    listeners.get('selection-toolbar://session')?.({ payload: {
      ...snapshot.session, selection_id: 'screenshot-selection', input_kind: 'screenshot',
    } });
    finishStop();
    await switching;
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.anything());
    expect(store.getState()).toMatchObject({
      session: { selection_id: 'screenshot-selection' }, run: null, pendingRequest: null, busy: false, error: null,
    });
  });

  it.each([
    { operation: 'followUp', rejects: false },
    { operation: 'followUp', rejects: true },
    { operation: 'regenerate', rejects: false },
    { operation: 'regenerate', rejects: true },
  ] as const)('ignores a stale $operation response (rejects=$rejects) after a screenshot replaces its session', async ({ operation, rejects }) => {
    snapshot.run = {
      request_id: 'old-request', selection_id: 'selection', tool_id: 'old-tool', mode: 'new_tool',
      user_input: null, status: 'completed', output: 'Old answer', error: null,
    };
    const store = await initializeStore();
    let finishOld!: (value: string) => void;
    let rejectOld!: (reason: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = resolve; rejectOld = reject; }));
    const previousRequest = operation === 'followUp'
      ? store.getState().followUp('Old question')
      : store.getState().regenerate();
    listeners.get('selection-toolbar://session')?.({ payload: {
      ...snapshot.session, selection_id: 'screenshot-selection', input_kind: 'screenshot',
    } });
    input = { kind: 'screenshot', width: 200, height: 100 };
    await store.getState().executeTool(tool);
    store.getState().updatePendingRequest({ userInput: 'New screenshot instruction' });
    const pending = store.getState().pendingRequest;
    if (rejects) rejectOld('An error from the old text session');
    else finishOld('old-response');
    await previousRequest;
    expect(store.getState()).toMatchObject({
      session: { selection_id: 'screenshot-selection' }, pendingRequest: pending,
      run: null, history: [], busy: false, error: null,
    });
  });

  it('accepts started and streaming events received before the initial invoke resolves', async () => {
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    invokeMock.mockImplementationOnce(async () => {
      listeners.get('selection-toolbar://run')?.({ payload: {
        kind: 'started', request_id: 'new-request', selection_id: 'selection', tool_id: 'translate',
        mode: 'new_tool', user_input: null,
      } });
      listeners.get('selection-toolbar://run')?.({ payload: {
        kind: 'delta', request_id: 'new-request', selection_id: 'selection', delta: 'Early text',
      } });
      return receipt('new-request');
    });
    expect(await store.getState().submitInitial()).toBe(true);
    expect(store.getState().run?.output).toBe('Early text');
    expect(store.getState().pendingRequest).toBeNull();
  });

  it('does not reset output or the saved initial input when a started event arrives after the invoke response', async () => {
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    store.getState().updatePendingRequest({ sourceText: 'Edited source' });
    await store.getState().submitInitial();
    listeners.get('selection-toolbar://run')?.({ payload: {
      kind: 'delta', request_id: 'request-1', selection_id: 'selection', delta: 'Current output',
    } });
    listeners.get('selection-toolbar://run')?.({ payload: {
      kind: 'started', request_id: 'request-1', selection_id: 'selection', tool_id: 'translate',
      mode: 'new_tool', user_input: null,
    } });
    expect(store.getState().lastSubmission?.input).toEqual({ kind: 'text', text: 'Edited source' });
    expect(store.getState().run?.output).toBe('Current output');
  });

  it('updates draft languages without sending and reuses submitted source and instructions on later language changes', async () => {
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    store.getState().updatePendingRequest({ sourceText: 'Edited text', userInput: 'Friendly tone' });
    await store.getState().setTranslateLanguages('en', 'ja');
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.anything());
    await store.getState().submitInitial();
    await store.getState().setTranslateLanguages('en', 'de');
    expect(invokeMock).toHaveBeenLastCalledWith('selection_toolbar_execute_tool', {
      selectionId: 'selection', toolId: 'translate',
      options: { source_language: 'en', target_language: 'de', source_text: 'Edited text', user_input: 'Friendly tone' },
    });
    expect(store.getState().pendingRequest).toBeNull();
  });

  it('preserves pending contents through More and copy close timers', async () => {
    vi.useFakeTimers();
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    store.getState().updatePendingRequest({ userInput: 'Keep draft' });
    await store.getState().executeTool({ id: 'copy', kind: 'action', builtin_key: 'copy', name: null, icon: 'copy' });
    await vi.advanceTimersByTimeAsync(800);
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_close', expect.anything());
    const opening = store.getState().toggleOverflow();
    await vi.advanceTimersByTimeAsync(30);
    await opening;
    await store.getState().toggleOverflow();
    expect(store.getState()).toMatchObject({ surface: 'result', pendingRequest: { user_input: 'Keep draft' } });
  });

  it.each(['copy', 'search'] as const)('cancels the %s auto-close timer when screenshot capture starts', async (action) => {
    vi.useFakeTimers();
    const store = await initializeStore();
    await store.getState().executeTool({ id: action, kind: 'action', builtin_key: action, name: null, icon: action });
    listeners.get('selection-toolbar://capture-start')?.({ payload: null });
    await vi.advanceTimersByTimeAsync(800);
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_close', expect.anything());
    expect(store.getState().session?.selection_id).toBe('selection');
  });

  it.each(['copy', 'search'] as const)('does not schedule auto-close for an in-flight %s during capture, and resumes after capture ends', async (action) => {
    vi.useFakeTimers();
    const store = await initializeStore();
    let finishAction!: (value?: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { finishAction = resolve; }));
    const actionTool: SelectionToolbarToolView = { id: action, kind: 'action', builtin_key: action, name: null, icon: action };
    const runningAction = store.getState().executeTool(actionTool);
    expect(store.getState().busy).toBe(true);
    listeners.get('selection-toolbar://capture-start')?.({ payload: null });
    finishAction();
    await runningAction;
    await vi.advanceTimersByTimeAsync(800);
    expect(store.getState()).toMatchObject({ busy: false, session: { selection_id: 'selection' } });
    expect(invokeMock).not.toHaveBeenCalledWith('selection_toolbar_close', expect.anything());

    listeners.get('selection-toolbar://capture-end')?.({ payload: null });
    await store.getState().executeTool(actionTool);
    await vi.advanceTimersByTimeAsync(800);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_close', { reason: `${action}_completed` });
  });

  it('ignores an input response after the active selection changes', async () => {
    const store = await initializeStore();
    let resolveInput!: (value: SelectionToolbarInput) => void;
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { resolveInput = resolve; }));
    const preparing = store.getState().executeTool(tool);
    listeners.get('selection-toolbar://session')?.({ payload: { ...snapshot.session, selection_id: 'new-selection' } });
    resolveInput(input);
    await preparing;
    expect(store.getState()).toMatchObject({ session: { selection_id: 'new-selection' }, pendingRequest: null, busy: false });
  });

  it('does not restore a submitted request after the window is hidden', async () => {
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    let resolveRequest!: (value: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const submitting = store.getState().submitInitial();
    listeners.get('selection-toolbar://hidden')?.({ payload: 'escape' });
    resolveRequest(receipt('old-request'));
    expect(await submitting).toBe(false);
    expect(store.getState()).toMatchObject({ session: null, pendingRequest: null, lastSubmission: null, run: null });
  });

  it('submits screenshot drafts without text and keeps an existing draft when capture fails', async () => {
    input = { kind: 'screenshot', width: 100, height: 80 };
    const store = await initializeStore();
    await store.getState().executeTool(tool);
    const pending = store.getState().pendingRequest;
    listeners.get('selection-toolbar://capture-error')?.({ payload: {
      code: 'capture_permission_required', detail: 'Denied', theme: 'dark', language: 'zh-CN',
    } });
    expect(store.getState().pendingRequest).toEqual(pending);
    await store.getState().clearCaptureError();
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_clear_capture_error');
    expect(store.getState()).toMatchObject({ captureError: null, surface: 'result', pendingRequest: pending });
    expect(await store.getState().submitInitial()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('selection_toolbar_execute_tool', expect.objectContaining({
      options: expect.objectContaining({ source_text: null, user_input: null }),
    }));
  });

  it('restores capture failures from snapshots even without an active session', async () => {
    snapshot.session = null;
    snapshot.capture_error = { code: 'capture_unavailable', detail: 'Unsupported', language: 'ja', theme: 'dark' };
    const store = await initializeStore();
    expect(store.getState()).toMatchObject({ session: null, surface: 'result', captureError: snapshot.capture_error });
    await store.getState().close('capture_error');
    expect(store.getState().captureError).toBeNull();
  });
});
