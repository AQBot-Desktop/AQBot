import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listeners = new Map<string, Set<(event: { payload: any }) => void>>();

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
  findModelByIds: () => null,
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
    is_pinned: false,
    is_archived: false,
    message_count: 0,
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
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'agent_query' || command === 'agent_cancel') return undefined;
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
});
