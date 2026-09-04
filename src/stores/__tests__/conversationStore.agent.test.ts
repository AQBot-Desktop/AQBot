import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listeners = new Map<string, Set<(event: { payload: any }) => void>>();
const capabilityState = vi.hoisted(() => ({
  knownModel: false,
  functionCalling: true,
}));

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(async (eventName: string, callback: (event: { payload: any }) => void) => {
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

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('conversationStore agent streaming', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.clearAllMocks();
    vi.resetModules();
    listeners.clear();
    capabilityState.knownModel = false;
    capabilityState.functionCalling = true;
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (command === 'agent_query' || command === 'agent_cancel') return undefined;
      if (command === 'update_conversation') {
        return {
          ...makeConversation(args?.id),
          enabled_mcp_server_ids: args?.input?.enabled_mcp_server_ids ?? [],
          enabled_knowledge_base_ids: args?.input?.enabled_knowledge_base_ids ?? [],
          enabled_memory_namespace_ids: args?.input?.enabled_memory_namespace_ids ?? [],
        };
      }
      if (command === 'list_messages_page') {
        return { messages: [], has_older: false, oldest_message_id: null, total_active_count: 0 };
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

    useConversationStore.getState().cancelCurrentStream();
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
});
