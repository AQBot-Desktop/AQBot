import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AcpAgentsFile,
  AcpSessionSnapshot,
  AcpThread,
  RegistryFile,
} from '@/types/acp';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: listenMock,
}));

function thread(id: string, modeId: string | null): AcpThread {
  return {
    id,
    project_id: 'project-1',
    agent_id: 'codex-acp',
    title: id,
    runtime_status: 'idle',
    mode_id: modeId,
    is_pinned: 0,
    sort_order: 0,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
  };
}

describe('acpStore session mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('keeps an acp-error event as the local terminal state without reloading stale DB data', async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(async (eventName, handler) => {
      listeners.set(eventName, handler);
      return vi.fn();
    });
    invokeMock.mockRejectedValue(new Error('acp_list_messages must not run'));
    const { useAcpStore } = await import('../acpStore');
    useAcpStore.setState({
      activeThreadId: 'thread-1',
      messages: [{
        id: 'assistant-1',
        thread_id: 'thread-1',
        role: 'assistant',
        content: 'partial',
        status: 'streaming',
        attachments: [],
        meta_json: null,
        created_at: '2026-08-08T00:00:00Z',
      }],
      streamingText: { 'assistant-1': 'partial' },
      runningByThread: { 'thread-1': true },
    });
    const cleanup = await useAcpStore.getState().bindEvents();

    listeners.get('acp-error')?.({
      payload: {
        threadId: 'thread-1',
        messageId: 'assistant-1',
        message: 'persist failed',
        text: 'partial\n\nError: persist failed',
      },
    });

    const state = useAcpStore.getState();
    expect(state.messages[0]).toMatchObject({
      id: 'assistant-1',
      status: 'error',
      content: 'partial\n\nError: persist failed',
    });
    expect(state.runningByThread['thread-1']).toBe(false);
    expect(state.streamingText['assistant-1']).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith('acp_list_messages', expect.anything());
    cleanup();
  });

  it('syncs the accepted mode to the current project and all-thread caches', async () => {
    const snapshot: AcpSessionSnapshot = {
      sessionId: 'session-1',
      modes: {
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      configOptions: [],
      agentCapabilities: {},
    };
    invokeMock.mockResolvedValue(snapshot);

    const { useAcpStore } = await import('../acpStore');
    useAcpStore.setState({
      activeThreadId: 'thread-1',
      threads: [thread('thread-1', 'default'), thread('thread-2', 'default')],
      allThreads: [thread('thread-1', 'default'), thread('thread-2', 'default')],
      sessionByThread: {},
    });

    await useAcpStore.getState().setSessionMode('thread-1', 'plan');

    expect(invokeMock).toHaveBeenCalledWith('acp_set_mode', {
      threadId: 'thread-1',
      modeId: 'plan',
    });
    expect(useAcpStore.getState().sessionByThread['thread-1']).toEqual(snapshot);
    expect(useAcpStore.getState().threads.find((item) => item.id === 'thread-1')?.mode_id)
      .toBe('plan');
    expect(useAcpStore.getState().allThreads.find((item) => item.id === 'thread-1')?.mode_id)
      .toBe('plan');
    expect(useAcpStore.getState().threads.find((item) => item.id === 'thread-2')?.mode_id)
      .toBe('default');
    expect(useAcpStore.getState().allThreads.find((item) => item.id === 'thread-2')?.mode_id)
      .toBe('default');
  });

  it('clears a stale launch reasoning override after the Agent exposes a live control', async () => {
    const before: AcpSessionSnapshot = {
      sessionId: 'session-1',
      configOptions: [{
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }],
        _meta: { aqbotSpawnArg: '--reasoning-effort' },
      }],
      agentCapabilities: {},
    };
    const after: AcpSessionSnapshot = {
      ...before,
      configOptions: [{
        ...before.configOptions[0],
        currentValue: 'xhigh',
        _meta: null,
      }],
    };
    invokeMock.mockResolvedValue(after);

    const { useAcpStore } = await import('../acpStore');
    useAcpStore.setState({
      sessionByThread: { 'thread-1': before },
      spawnReasoningByThread: { 'thread-1': 'high' },
    });

    await useAcpStore.getState().setConfigOption('thread-1', 'reasoning_effort', 'xhigh');

    expect(useAcpStore.getState().sessionByThread['thread-1']).toEqual(after);
    expect(useAcpStore.getState().spawnReasoningByThread['thread-1']).toBeUndefined();
  });

  it('serializes live config changes so an older response cannot replace the latest choice', async () => {
    const snapshot = (value: string): AcpSessionSnapshot => ({
      sessionId: 'session-1',
      configOptions: [{
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: value,
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      }],
      agentCapabilities: {},
    });
    let resolveFirst!: (value: AcpSessionSnapshot) => void;
    const firstResponse = new Promise<AcpSessionSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    invokeMock
      .mockImplementationOnce(async () => firstResponse)
      .mockResolvedValueOnce(snapshot('high'));

    const { useAcpStore } = await import('../acpStore');
    useAcpStore.setState({
      sessionByThread: { 'thread-1': snapshot('low') },
    });

    const first = useAcpStore.getState().setConfigOption(
      'thread-1',
      'reasoning_effort',
      'low',
    );
    const second = useAcpStore.getState().setConfigOption(
      'thread-1',
      'reasoning_effort',
      'high',
    );

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    resolveFirst(snapshot('low'));
    await Promise.all([first, second]);

    expect(invokeMock.mock.calls).toEqual([
      ['acp_set_config_option', {
        threadId: 'thread-1',
        configId: 'reasoning_effort',
        value: 'low',
      }],
      ['acp_set_config_option', {
        threadId: 'thread-1',
        configId: 'reasoning_effort',
        value: 'high',
      }],
    ]);
    expect(useAcpStore.getState().sessionByThread['thread-1'].configOptions[0].currentValue)
      .toBe('high');
  });

  it.each(['config', 'mode'] as const)(
    'does not surface a late %s failure after its thread is deleted',
    async (kind) => {
      const threadId = `thread-superseded-${kind}`;
      let rejectMutation!: (error: Error) => void;
      const mutation = new Promise<never>((_, reject) => {
        rejectMutation = reject;
      });
      invokeMock.mockImplementation(async (command: string) => {
        if (command === 'acp_set_config_option' || command === 'acp_set_mode') return mutation;
        if (command === 'acp_delete_thread') return undefined;
        if (command === 'acp_list_threads' || command === 'acp_list_all_threads') return [];
        throw new Error(`Unexpected invoke: ${command}`);
      });

      const { useAcpStore } = await import('../acpStore');
      const activeThread = thread(threadId, 'default');
      useAcpStore.setState({
        activeProjectId: activeThread.project_id,
        activeThreadId: threadId,
        threads: [activeThread],
        allThreads: [activeThread],
        sessionByThread: {
          [threadId]: {
            sessionId: 'session-superseded',
            configOptions: [],
            agentCapabilities: {},
          },
        },
      });

      const updating = kind === 'config'
        ? useAcpStore.getState().setConfigOption(threadId, 'model', 'model-a')
        : useAcpStore.getState().setSessionMode(threadId, 'plan');
      await vi.waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          kind === 'config' ? 'acp_set_config_option' : 'acp_set_mode',
          expect.anything(),
        );
      });
      await useAcpStore.getState().deleteThread(threadId);
      rejectMutation(new Error('thread was deleted'));

      await expect(updating).resolves.toBeUndefined();
      expect(useAcpStore.getState().sessionByThread[threadId]).toBeUndefined();
    },
  );

  it('keeps managed Agent launches and sessions after a catalog-only Registry refresh', async () => {
    const registry: RegistryFile = {
      version: '1',
      source: 'live',
      agents: [{ id: 'codex-acp', name: 'Codex', version: '1.1.14' }],
    };
    const config: AcpAgentsFile = {
      general: {
        idleTimeoutSecs: 1800,
        maxConcurrentProcesses: 0,
        permissionDefault: 'default',
        registryRefresh: 'on_start',
      },
      agents: [{
        id: 'codex-acp',
        name: 'Codex',
        enabled: true,
        source: 'registry',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/codex-acp@1.1.13'],
        sort: 0,
      }],
    };
    const cachedSnapshot: AcpSessionSnapshot = {
      sessionId: 'session-before-refresh',
      configOptions: [],
      agentCapabilities: {},
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'acp_refresh_registry') return registry;
      if (command === 'acp_get_config') return config;
      if (command === 'acp_prewarm_enabled_agents') return [];
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { useAcpStore } = await import('../acpStore');
    useAcpStore.setState({
      config,
      threads: [thread('thread-running', null), thread('thread-idle', null)],
      allThreads: [thread('thread-running', null), thread('thread-idle', null)],
      sessionByThread: {
        'thread-running': cachedSnapshot,
        'thread-idle': cachedSnapshot,
      },
      spawnModelByThread: {
        'thread-running': 'model-a',
        'thread-idle': 'model-a',
      },
      runningByThread: {
        'thread-running': true,
        'thread-idle': false,
      },
    });
    await useAcpStore.getState().loadRegistry(true);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'acp_refresh_registry');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'acp_get_config');
    expect(useAcpStore.getState().registry).toEqual(registry);
    expect(useAcpStore.getState().config).toEqual(config);
    expect(useAcpStore.getState().sessionByThread['thread-running']).toEqual(cachedSnapshot);
    expect(useAcpStore.getState().sessionByThread['thread-idle']).toEqual(cachedSnapshot);
    expect(useAcpStore.getState().spawnModelByThread['thread-running']).toBe('model-a');
    expect(useAcpStore.getState().spawnModelByThread['thread-idle']).toBe('model-a');
    expect(invokeMock).not.toHaveBeenCalledWith('acp_prewarm_enabled_agents');
  });
});
