import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';

const invokeMock = vi.fn();
const listeners = new Map<string, Set<(event: { payload: any }) => void>>();
let listenerGate: Promise<void> | null = null;
let persistedMessages: Message[] = [];
const capabilityState = vi.hoisted(() => ({
  knownModel: false,
  functionCalling: true,
}));

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(async (eventName: string, callback: (event: { payload: any }) => void) => {
    if (listenerGate) await listenerGate;
    const set = listeners.get(eventName) ?? new Set();
    set.add(callback);
    listeners.set(eventName, set);
    return () => {
      set.delete(callback);
    };
  }),
  isTauri: () => true,
}));

vi.mock('@/lib/modelCapabilities', () => ({
  supportsReasoning: () => false,
  supportsFunctionCalling: (model: { capabilities?: string[] } | null) =>
    model?.capabilities?.includes('FunctionCalling') ?? false,
  findModelByIds: () => capabilityState.knownModel
    ? { capabilities: capabilityState.functionCalling ? ['FunctionCalling'] : [] }
    : null,
}));

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({ providers: [] }),
  },
}));

function emit(eventName: string, payload: any) {
  for (const callback of listeners.get(eventName) ?? []) {
    callback({ payload });
  }
}

function makeConversation(id = 'conv-1') {
  return {
    id,
    title: 'Agent',
    model_id: 'model-1',
    provider_id: 'provider-1',
    system_prompt: null,
    temperature: null,
    max_tokens: null,
    top_p: null,
    frequency_penalty: null,
    search_enabled: false,
    search_provider_id: null,
    thinking_budget: null,
    enabled_mcp_server_ids: [],
    enabled_knowledge_base_ids: [],
    enabled_memory_namespace_ids: [],
    category_id: null,
    parent_conversation_id: null,
    is_pinned: false,
    is_archived: false,
    message_count: 0,
    sort_order: 0,
    created_at: 1,
    updated_at: 1,
    mode: 'agent',
  };
}

function storedMessage(id: string, content: string, status: Message['status'] = 'complete'): Message {
  return {
    id, conversation_id: 'conv-1', role: 'assistant', content, status,
    provider_id: 'provider-1', model_id: 'model-1', token_count: null,
    attachments: [], thinking: null, tool_calls_json: null, tool_call_id: null,
    created_at: 1_000, parent_message_id: 'persisted-user-1', version_index: 0, is_active: true,
  };
}

async function flushPromises() {
  for (let index = 0; index < 24; index += 1) {
    await Promise.resolve();
  }
}

describe('conversationStore agent streaming', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.clearAllMocks();
    vi.resetModules();
    listeners.clear();
    listenerGate = null;
    persistedMessages = [];
    capabilityState.knownModel = false;
    capabilityState.functionCalling = true;
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (
        command === 'agent_query'
        || command === 'agent_cancel'
        || command === 'list_active_conversation_runs'
      ) {
        return command === 'list_active_conversation_runs' ? [] : undefined;
      }
      if (command === 'update_conversation') {
        return {
          ...makeConversation(args?.id),
          enabled_mcp_server_ids: args?.input?.enabled_mcp_server_ids ?? [],
          enabled_knowledge_base_ids: args?.input?.enabled_knowledge_base_ids ?? [],
          enabled_memory_namespace_ids: args?.input?.enabled_memory_namespace_ids ?? [],
        };
      }
      if (command === 'list_messages_page') {
        const messages = persistedMessages.filter((message) => message.conversation_id === args?.conversationId);
        return {
          messages,
          has_older: false,
          oldest_message_id: messages[0]?.id ?? null,
          total_active_count: messages.length,
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
  });

  it('does not let a cancelled agent listener append the next run to the old reply', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation()] as never[],
      messages: [],
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageIds: new Set<string>(),
      enabledMcpServerIds: [],
      thinkingBudget: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
    });

    const firstRun = useConversationStore.getState().sendAgentMessage('first');
    await flushPromises();
    const firstAssistantId = useConversationStore.getState().streamingMessageId;
    const firstQuery = invokeMock.mock.calls.find((call) => call[0] === 'agent_query');
    const firstRunId = firstQuery?.[1]?.runId as string;

    persistedMessages = [storedMessage(firstAssistantId!, '', 'partial')];
    const cancelPromise = useConversationStore.getState().cancelCurrentStream();
    emit('chat-stream-terminal', {
      conversation_id: 'conv-1',
      message_id: firstAssistantId,
      stream_id: firstRunId,
      outcome: 'cancelled',
      error: null,
    });
    await cancelPromise;
    await firstRun;
    vi.advanceTimersByTime(1);

    const secondRun = useConversationStore.getState().sendAgentMessage('second');
    await flushPromises();
    const secondAssistantId = useConversationStore.getState().streamingMessageId;

    emit('agent-stream-text', {
      conversationId: 'conv-1',
      assistantMessageId: secondAssistantId,
      text: 'new answer',
    });
    vi.advanceTimersByTime(20);

    const messages = useConversationStore.getState().messages;
    expect(messages.find((message) => message.id === firstAssistantId)?.content).toBe('');
    expect(messages.find((message) => message.id === secondAssistantId)?.content).toBe('new answer');

    emit('agent-done', {
      conversationId: 'conv-1',
      assistantMessageId: secondAssistantId,
      text: 'new answer',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    await secondRun;
  });

  it('does not fetch an inactive conversation when an agent run finishes while viewing another chat', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1'), makeConversation('conv-2')] as never[],
      messages: [],
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageIds: new Set<string>(),
      enabledMcpServerIds: [],
      thinkingBudget: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
    });

    const run = useConversationStore.getState().sendAgentMessage('first');
    await flushPromises();
    const assistantId = useConversationStore.getState().streamingMessageId;

    useConversationStore.setState({
      activeConversationId: 'conv-2',
      messages: [],
    });
    invokeMock.mockClear();

    emit('agent-done', {
      conversationId: 'conv-1',
      assistantMessageId: assistantId,
      text: 'finished away',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    await run;

    expect(invokeMock).not.toHaveBeenCalledWith('list_messages_page', expect.anything());
    expect(useConversationStore.getState().streaming).toBe(false);
  });

  it('returns after agent_query starts so the composer can clear while the reply keeps streaming', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation()] as never[],
      messages: [],
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageIds: new Set<string>(),
      enabledMcpServerIds: [],
      thinkingBudget: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
    });

    const run = useConversationStore.getState().sendAgentMessage('你好呀');
    await expect(run).resolves.toBeUndefined();

    const state = useConversationStore.getState();
    expect(state.streaming).toBe(true);
    expect(state.messages.some((message) => message.role === 'user' && message.content === '你好呀')).toBe(true);
    expect(state.messages.some((message) => message.role === 'assistant' && message.status === 'partial')).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('agent_query', expect.objectContaining({
      conversationId: 'conv-1',
      prompt: '你好呀',
      enabledMcpServerIds: [],
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      streamId: expect.any(String),
      runId: expect.any(String),
    }));
  });

  it('removes stale or disabled MCP server ids before starting an agent run', async () => {
    capabilityState.knownModel = true;
    const { useConversationStore } = await import('../conversationStore');
    const { useMcpStore } = await import('../mcpStore');
    useMcpStore.setState({
      servers: [
        { id: 'mcp-active', name: 'Active MCP', enabled: true },
        { id: 'mcp-disabled', name: 'Disabled MCP', enabled: false },
      ] as never[],
      loading: false,
    });
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [{
        ...makeConversation(),
        enabled_mcp_server_ids: ['mcp-active', 'mcp-disabled', 'mcp-missing'],
      }] as never[],
      messages: [],
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageIds: new Set<string>(),
      enabledMcpServerIds: ['mcp-active', 'mcp-disabled', 'mcp-missing'],
      thinkingBudget: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
    });

    await useConversationStore.getState().sendAgentMessage('use tools');

    expect(invokeMock).toHaveBeenCalledWith('agent_query', expect.objectContaining({
      enabledMcpServerIds: ['mcp-active'],
    }));
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-active']);
  });

  it('does not pass selected MCP servers when the model explicitly lacks FunctionCalling', async () => {
    capabilityState.knownModel = true;
    capabilityState.functionCalling = false;
    const { useConversationStore } = await import('../conversationStore');
    const { useMcpStore } = await import('../mcpStore');
    useMcpStore.setState({
      servers: [{ id: 'mcp-active', name: 'Active MCP', enabled: true }] as never[],
      loading: false,
    });
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [{
        ...makeConversation(),
        enabled_mcp_server_ids: ['mcp-active'],
      }] as never[],
      messages: [],
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageIds: new Set<string>(),
      enabledMcpServerIds: ['mcp-active'],
      thinkingBudget: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
    });

    await useConversationStore.getState().sendAgentMessage('do not use tools');

    expect(invokeMock).toHaveBeenCalledWith('agent_query', expect.objectContaining({
      enabledMcpServerIds: [],
    }));
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-active']);
  });

  async function seedAgentConversation(store: typeof import('../conversationStore').useConversationStore) {
    store.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation()] as never[],
      messages: [],
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageIds: new Set<string>(),
      enabledMcpServerIds: [],
      thinkingBudget: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
    });
  }

  async function startAgentRun(
    store: typeof import('../conversationStore').useConversationStore,
    text = 'hello',
  ) {
    const promise = store.getState().sendAgentMessage(text);
    await flushPromises();
    const query = [...invokeMock.mock.calls].reverse().find((call) => call[0] === 'agent_query');
    return {
      promise,
      runId: query?.[1]?.runId as string,
      assistantId: store.getState().streamingMessageId as string,
    };
  }

  it('clears the live run after agent-done so the stop button disappears', async () => {
    const { useConversationStore, selectUiStreaming } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    const started = await startAgentRun(useConversationStore);

    expect(selectUiStreaming(useConversationStore.getState())).toBe(true);
    persistedMessages = [storedMessage(started.assistantId, 'finished')];

    emit('agent-done', {
      conversationId: 'conv-1',
      runId: started.runId,
      assistantMessageId: started.assistantId,
      text: 'finished',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    await flushPromises();

    const state = useConversationStore.getState();
    expect(selectUiStreaming(state)).toBe(false);
    expect(state.runsByConversation['conv-1']).toBeUndefined();
    expect(state.messages.find((message) => message.id === started.assistantId)?.status).toBe('complete');
  });

  it('clears the live run after agent-error', async () => {
    const { useConversationStore, selectUiStreaming } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    const started = await startAgentRun(useConversationStore);
    persistedMessages = [storedMessage(started.assistantId, 'provider failed', 'error')];

    emit('agent-error', {
      conversationId: 'conv-1',
      runId: started.runId,
      assistantMessageId: started.assistantId,
      message: 'provider failed',
    });
    await flushPromises();

    const state = useConversationStore.getState();
    expect(selectUiStreaming(state)).toBe(false);
    expect(state.runsByConversation['conv-1']).toBeUndefined();
    expect(state.messages.find((message) => message.id === started.assistantId)?.status).toBe('error');
    expect(state.messages.find((message) => message.id === started.assistantId)?.content).toBe('provider failed');
  });

  it('clears the live run when agent_query fails to start', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'agent_query') {
        throw new Error('Failed to prepare skills: Failed to create junction \'C:\\\\Users\\\\x\\\\GFE 技能\' -> \'D:\\\\skills\'');
      }
      if (command === 'list_active_conversation_runs') return [];
      if (command === 'list_messages_page') {
        return { messages: [], has_older: false, oldest_message_id: null, total_active_count: 0 };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
    const { useConversationStore, selectUiStreaming } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    await useConversationStore.getState().sendAgentMessage('use skill');
    await flushPromises();

    const state = useConversationStore.getState();
    expect(selectUiStreaming(state)).toBe(false);
    expect(state.runsByConversation['conv-1']).toBeUndefined();
    expect(state.messages.some((message) => (
      message.role === 'assistant'
      && message.status === 'error'
      && message.content.includes('Failed to create junction')
      && message.content.includes('GFE 技能')
    ))).toBe(true);
  });

  it('rekeys the run table to the real assistant message id', async () => {
    const { useConversationStore, selectUiStreaming, selectUiStreamingMessageId } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    const started = await startAgentRun(useConversationStore);

    emit('agent-message-id', {
      conversationId: 'conv-1',
      runId: started.runId,
      assistantMessageId: 'real-assistant-1',
    });
    await flushPromises();

    const state = useConversationStore.getState();
    expect(selectUiStreaming(state)).toBe(true);
    expect(selectUiStreamingMessageId(state)).toBe('real-assistant-1');
    expect(state.runsByConversation['conv-1']?.streamingMessageId).toBe('real-assistant-1');
  });

  it('clears a background agent run without fetching the visible conversation', async () => {
    const { useConversationStore, selectUiStreaming } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1'), makeConversation('conv-2')] as never[],
      messages: [],
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageIds: new Set<string>(),
      enabledMcpServerIds: [],
      thinkingBudget: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
    });
    const started = await startAgentRun(useConversationStore);
    useConversationStore.setState({
      activeConversationId: 'conv-2',
      messages: [],
    });
    invokeMock.mockClear();

    emit('agent-done', {
      conversationId: 'conv-1',
      runId: started.runId,
      assistantMessageId: started.assistantId,
      text: 'finished away',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    await started.promise;
    await flushPromises();

    expect(invokeMock).not.toHaveBeenCalledWith('list_messages_page', expect.anything());
    expect(useConversationStore.getState().runsByConversation['conv-1']).toBeUndefined();
    expect(selectUiStreaming(useConversationStore.getState())).toBe(false);
  });

  it('keeps stop waiting until the cancelled terminal arrives', async () => {
    const { useConversationStore, selectUiStreaming } = await import('../conversationStore');
    const { getOrCreateRunRuntime } = await import('../conversationStoreSupport');
    await seedAgentConversation(useConversationStore);
    const started = await startAgentRun(useConversationStore);
    const cancelPromise = useConversationStore.getState().cancelCurrentStream();
    await flushPromises();
    const stopDone = getOrCreateRunRuntime('conv-1').stopCompleted;
    let stopResolved = false;
    void stopDone?.then(() => { stopResolved = true; });
    expect(useConversationStore.getState().runsByConversation['conv-1']?.phase).toBe('stopping');
    expect(selectUiStreaming(useConversationStore.getState())).toBe(true);
    expect(stopResolved).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('agent_cancel', expect.objectContaining({
      conversationId: 'conv-1',
      streamId: started.runId,
    }));
    expect(invokeMock.mock.calls.some((call) => call[0] === 'cancel_stream')).toBe(false);

    emit('chat-stream-terminal', {
      conversation_id: 'conv-1',
      message_id: started.assistantId,
      stream_id: started.runId,
      outcome: 'cancelled',
      error: null,
    });
    await cancelPromise;
    await flushPromises();

    expect(stopResolved).toBe(true);
    expect(selectUiStreaming(useConversationStore.getState())).toBe(false);
    expect(useConversationStore.getState().runsByConversation['conv-1']).toBeUndefined();
  });

  it('ignores a late terminal from the previous agent run', async () => {
    const { useConversationStore, selectUiStreaming } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    const first = await startAgentRun(useConversationStore, 'first');
    const cancelPromise = useConversationStore.getState().cancelCurrentStream();
    emit('chat-stream-terminal', {
      conversation_id: 'conv-1',
      message_id: first.assistantId,
      stream_id: first.runId,
      outcome: 'cancelled',
      error: null,
    });
    await cancelPromise;
    await first.promise;

    const second = await startAgentRun(useConversationStore, 'second');
    emit('agent-done', {
      conversationId: 'conv-1',
      runId: first.runId,
      assistantMessageId: first.assistantId,
      text: 'stale',
    });
    emit('chat-stream-terminal', {
      conversation_id: 'conv-1',
      message_id: first.assistantId,
      stream_id: first.runId,
      outcome: 'complete',
      error: null,
    });
    await flushPromises();

    expect(selectUiStreaming(useConversationStore.getState())).toBe(true);
    expect(useConversationStore.getState().runsByConversation['conv-1']?.runId).toBe(second.runId);
    expect(useConversationStore.getState().messages.find((message) => message.id === second.assistantId)?.content).toBe('');
  });

  it('keeps a preparation error whose path contains cancel visible', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    const originalInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command: string, args?: unknown) => command === 'agent_query'
      ? Promise.reject(new Error('Cannot read C:\\Users\\cancellation\\SKILL.md'))
      : originalInvoke(command, args));
    await useConversationStore.getState().sendAgentMessage('read skill');
    expect(useConversationStore.getState().messages.find((message) => message.role === 'assistant'))
      .toMatchObject({ status: 'error', content: expect.stringContaining('cancellation') });
  });

  it('stores background thinking and tool text while another conversation is visible', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { getLoadedMessagesForConversation } = await import('../conversationStoreSupport');
    await seedAgentConversation(useConversationStore);
    useConversationStore.setState({ conversations: [makeConversation(), makeConversation('conv-2')] as never[] });
    const started = await startAgentRun(useConversationStore);
    useConversationStore.getState().setActiveConversation('conv-2');
    await flushPromises();
    const visible = useConversationStore.getState().messages;
    emit('agent-stream-thinking', { conversationId: 'conv-1', runId: started.runId, thinking: 'inspect skill' });
    vi.advanceTimersByTime(20);
    const text = '<tool-call data-aqbot="1" id="skill-1" name="Skill">GFE</tool-call>';
    emit('agent-stream-text', { conversationId: 'conv-1', runId: started.runId, text });
    vi.advanceTimersByTime(20);
    const cached = getLoadedMessagesForConversation(useConversationStore.getState(), 'conv-1');
    expect(cached.find((message) => message.id === started.assistantId))
      .toMatchObject({ thinking: 'inspect skill', content: expect.stringContaining(text) });
    expect(useConversationStore.getState().messages).toEqual(visible);
  });

  it('does not start the backend after cancellation during listener setup', async () => {
    const { useConversationStore, selectUiStreaming } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    let releaseListeners!: () => void;
    listenerGate = new Promise<void>((resolve) => { releaseListeners = resolve; });
    const originalInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command: string, args?: unknown) => command === 'agent_cancel'
      ? Promise.reject(new Error('No active agent run matched the cancellation request'))
      : originalInvoke(command, args));
    const send = useConversationStore.getState().sendAgentMessage('cancel before start');
    await flushPromises();
    await useConversationStore.getState().cancelCurrentStream();
    releaseListeners();
    await send;
    expect(invokeMock.mock.calls.filter(([command]) => command === 'agent_query')).toHaveLength(0);
    expect(selectUiStreaming(useConversationStore.getState())).toBe(false);
  });

  it('uses a registered runtime after stopping the previous run to send again', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { getRunRuntime } = await import('../conversationStoreSupport');
    await seedAgentConversation(useConversationStore);
    const first = await startAgentRun(useConversationStore);
    const second = useConversationStore.getState().sendAgentMessage('second');
    await flushPromises();
    emit('chat-stream-terminal', {
      conversation_id: 'conv-1', message_id: first.assistantId, stream_id: first.runId,
      outcome: 'cancelled', error: null,
    });
    await second;
    expect(getRunRuntime('conv-1')?.sendIpcStarted).toBe(true);
  });

  it('reports a failed cancel and allows retry instead of waiting forever', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    await startAgentRun(useConversationStore);
    const originalInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command: string, args?: unknown) => command === 'agent_cancel'
      ? Promise.reject(new Error('cancel IPC unavailable'))
      : originalInvoke(command, args));
    let settled = false;
    let failure: unknown;
    void useConversationStore.getState().cancelCurrentStream().then(
      () => { settled = true; },
      (error) => { settled = true; failure = error; },
    );
    await flushPromises();
    expect(settled).toBe(true);
    expect(String(failure)).toContain('cancel IPC unavailable');
    expect(useConversationStore.getState().runsByConversation['conv-1']?.phase).toBe('streaming');
  });

  it('does not resolve a background run stop when an older terminal arrives', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { ensureRunStopCompleted } = await import('../conversationStoreSupport');
    await seedAgentConversation(useConversationStore);
    useConversationStore.setState({ conversations: [makeConversation(), makeConversation('conv-2')] as never[] });
    const started = await startAgentRun(useConversationStore);
    useConversationStore.getState().setActiveConversation('conv-2');
    await flushPromises();
    let stopped = false;
    void ensureRunStopCompleted('conv-1').then(() => { stopped = true; });
    emit('chat-stream-terminal', {
      conversation_id: 'conv-1', message_id: 'old-id', stream_id: 'old-run',
      outcome: 'cancelled', error: null,
    });
    await flushPromises();
    expect(stopped).toBe(false);
    expect(useConversationStore.getState().runsByConversation['conv-1']?.runId).toBe(started.runId);
  });

  it('refreshes persisted messages only once for a result followed by its terminal', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    const started = await startAgentRun(useConversationStore);
    persistedMessages = [
      { ...storedMessage('persisted-user-1', 'hello'), role: 'user', parent_message_id: null },
      storedMessage('persisted-assistant-1', 'partial answer\n\n<!-- aqbot-stream-error -->\nprovider failed', 'error'),
    ];
    emit('agent-error', {
      conversationId: 'conv-1', runId: started.runId, assistantMessageId: 'persisted-assistant-1',
      message: 'provider failed',
    });
    emit('chat-stream-terminal', {
      conversation_id: 'conv-1', message_id: 'persisted-assistant-1', stream_id: started.runId,
      outcome: 'error', error: 'provider failed',
    });
    await flushPromises();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'list_messages_page')).toHaveLength(1);
    expect(useConversationStore.getState().messages).toEqual(persistedMessages);
  });

  it('waits for pending startup before issuing its cancellation', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await seedAgentConversation(useConversationStore);
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => { accept = resolve; });
    const originalInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command: string, args?: unknown) => command === 'agent_query'
      ? accepted : originalInvoke(command, args));
    const started = await startAgentRun(useConversationStore);
    const cancel = useConversationStore.getState().cancelCurrentStream();
    await flushPromises();
    expect(invokeMock.mock.calls.some(([command]) => command === 'agent_cancel')).toBe(false);
    accept();
    await flushPromises();
    expect(invokeMock.mock.calls.some(([command]) => command === 'agent_cancel')).toBe(true);
    emit('chat-stream-terminal', {
      conversation_id: 'conv-1', message_id: started.assistantId, stream_id: started.runId,
      outcome: 'cancelled', error: null,
    });
    await cancel;
    await started.promise;
  });

  it('does not overwrite the buffer with a rejected agent snapshot', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { getStreamBuffer } = await import('../conversationStoreSupport');
    await seedAgentConversation(useConversationStore);
    const started = await startAgentRun(useConversationStore);
    const originalInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command: string, args?: unknown) => command === 'list_active_conversation_runs'
      ? Promise.resolve([{
          conversationId: 'conv-1', runId: started.runId, streamId: started.runId, messageId: null,
          mode: 'agent', phase: 'preparing', revision: 1, content: 'stale content', thinking: null,
          pendingPermission: null, pendingAsk: null,
        }])
      : originalInvoke(command, args));
    await useConversationStore.getState().startStreamListening();
    await flushPromises();
    expect(getStreamBuffer('conv-1')).toBeNull();
    expect(useConversationStore.getState().runsByConversation['conv-1']?.phase).toBe('streaming');
  });
});
