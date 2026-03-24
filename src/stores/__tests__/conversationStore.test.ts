import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessagePage } from '@/types';

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: listenMock,
  isTauri: () => false,
}));

function makeMessage(index: number, conversationId = 'conv-1'): Message {
  return {
    id: `msg-${index}`,
    conversation_id: conversationId,
    role: index % 2 === 0 ? 'assistant' : 'user',
    content: `message-${index}`,
    provider_id: null,
    model_id: null,
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: index,
    parent_message_id: null,
    version_index: 0,
    is_active: true,
  };
}

function makePage(messages: Message[], hasOlder: boolean): MessagePage {
  return {
    messages,
    has_older: hasOlder,
    oldest_message_id: messages[0]?.id ?? null,
  };
}

function makeConversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `conversation-${id}`,
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
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('conversationStore pagination', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [],
      activeConversationId: null,
      messages: [],
      loading: false,
      loadingOlder: false,
      hasOlderMessages: false,
      oldestLoadedMessageId: null,
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageId: null,
      error: null,
      searchEnabled: false,
      searchProviderId: null,
      enabledMcpServerIds: [],
      thinkingBudget: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      archivedConversations: [],
      workspaceSnapshot: null,
    });
  });

  it('loads only the newest 10 messages for the initial conversation page', async () => {
    invokeMock.mockResolvedValueOnce(makePage([makeMessage(11), makeMessage(12)], true));
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.getState().setActiveConversation('conv-1');
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith('list_messages_page', {
      conversationId: 'conv-1',
      limit: 10,
      beforeMessageId: null,
    });
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual(['msg-11', 'msg-12']);
    expect(useConversationStore.getState().hasOlderMessages).toBe(true);
    expect(useConversationStore.getState().oldestLoadedMessageId).toBe('msg-11');
  });

  it('keeps loading until the newest active conversation request resolves', async () => {
    const pageA = deferred<MessagePage>();
    const pageB = deferred<MessagePage>();
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== 'list_messages_page') {
        throw new Error(`unexpected command: ${cmd}`);
      }
      if (args?.conversationId === 'conv-a') return pageA.promise;
      if (args?.conversationId === 'conv-b') return pageB.promise;
      throw new Error(`unexpected conversation: ${String(args?.conversationId)}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.getState().setActiveConversation('conv-a');
    useConversationStore.getState().setActiveConversation('conv-b');
    await flushPromises();

    pageA.resolve(makePage([makeMessage(1, 'conv-a')], false));
    await flushPromises();

    expect(useConversationStore.getState().activeConversationId).toBe('conv-b');
    expect(useConversationStore.getState().loading).toBe(true);
    expect(useConversationStore.getState().messages).toEqual([]);

    pageB.resolve(makePage([makeMessage(2, 'conv-b')], false));
    await flushPromises();

    expect(useConversationStore.getState().loading).toBe(false);
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual(['msg-2']);
  });

  it('prepends older pages without replacing already loaded messages', async () => {
    invokeMock
      .mockResolvedValueOnce(makePage([makeMessage(11), makeMessage(12)], true))
      .mockResolvedValueOnce(makePage([makeMessage(9), makeMessage(10)], false));
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.getState().setActiveConversation('conv-1');
    await flushPromises();
    await useConversationStore.getState().loadOlderMessages();

    expect(invokeMock).toHaveBeenLastCalledWith('list_messages_page', {
      conversationId: 'conv-1',
      limit: 10,
      beforeMessageId: 'msg-11',
    });
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([
      'msg-9',
      'msg-10',
      'msg-11',
      'msg-12',
    ]);
    expect(useConversationStore.getState().hasOlderMessages).toBe(false);
    expect(useConversationStore.getState().loadingOlder).toBe(false);
  });

  it('hydrates persisted conversation preferences when switching active conversations', async () => {
    invokeMock.mockResolvedValue(makePage([], false));
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      conversations: [
        makeConversation('conv-a', {
          search_enabled: true,
          search_provider_id: 'search-a',
          thinking_budget: 2048,
          enabled_mcp_server_ids: ['mcp-a'],
          enabled_knowledge_base_ids: ['kb-a'],
          enabled_memory_namespace_ids: ['mem-a'],
        }),
        makeConversation('conv-b', {
          search_enabled: false,
          search_provider_id: null,
          thinking_budget: null,
          enabled_mcp_server_ids: ['mcp-b'],
          enabled_knowledge_base_ids: [],
          enabled_memory_namespace_ids: ['mem-b'],
        }),
      ] as never[],
    });

    useConversationStore.getState().setActiveConversation('conv-a');
    await flushPromises();

    expect(useConversationStore.getState().searchEnabled).toBe(true);
    expect(useConversationStore.getState().searchProviderId).toBe('search-a');
    expect(useConversationStore.getState().thinkingBudget).toBe(2048);
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-a']);
    expect(useConversationStore.getState().enabledKnowledgeBaseIds).toEqual(['kb-a']);
    expect(useConversationStore.getState().enabledMemoryNamespaceIds).toEqual(['mem-a']);

    useConversationStore.getState().setActiveConversation('conv-b');
    await flushPromises();

    expect(useConversationStore.getState().searchEnabled).toBe(false);
    expect(useConversationStore.getState().searchProviderId).toBeNull();
    expect(useConversationStore.getState().thinkingBudget).toBeNull();
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-b']);
    expect(useConversationStore.getState().enabledKnowledgeBaseIds).toEqual([]);
    expect(useConversationStore.getState().enabledMemoryNamespaceIds).toEqual(['mem-b']);
  });

  it('persists search preference changes for the active conversation', async () => {
    invokeMock.mockResolvedValue(makePage([], false));
    invokeMock.mockResolvedValueOnce(makeConversation('conv-1'));
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
    });

    useConversationStore.getState().setSearchEnabled(true);
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith('update_conversation', {
      id: 'conv-1',
      input: {
        search_enabled: true,
      },
    });
  });

  it('rolls back optimistic MCP changes when persistence fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('save failed'));
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1', { enabled_mcp_server_ids: ['mcp-a'] })] as never[],
      enabledMcpServerIds: ['mcp-a'],
    });

    useConversationStore.getState().toggleMcpServer('mcp-b');
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-a', 'mcp-b']);

    await flushPromises();

    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-a']);
    expect(useConversationStore.getState().error).toBe('Error: save failed');
  });

  it('keeps streaming active when a non-final done chunk arrives during a tool loop', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });

    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'assistant-1',
      streamingConversationId: 'conv-1',
      messages: [
        makeMessage(1),
        makeMessage(2, 'conv-1'),
      ],
    });

    await useConversationStore.getState().startStreamListening();
    const onChunk = listeners.get('chat-stream-chunk');
    expect(onChunk).toBeTypeOf('function');

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: null,
          thinking: null,
          tool_calls: null,
          done: true,
          is_final: false,
          usage: null,
        },
      },
    });

    expect(useConversationStore.getState().streaming).toBe(true);
    expect(useConversationStore.getState().streamingMessageId).toBe('assistant-1');
  });

  it('flushes accepted streaming content before stopping the stream', async () => {
    vi.useFakeTimers();

    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });

    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'assistant-1',
      streamingConversationId: 'conv-1',
      messages: [
        {
          ...makeMessage(2, 'conv-1'),
          id: 'assistant-1',
          role: 'assistant',
          content: 'Hello',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    const onChunk = listeners.get('chat-stream-chunk');

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: ' world',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });

    useConversationStore.getState().stopStreamListening();

    expect(useConversationStore.getState().messages[0]?.content).toBe('Hello world');

    vi.useRealTimers();
  });
});
