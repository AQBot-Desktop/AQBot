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
    status: 'complete',
  };
}

function makePage(messages: Message[], hasOlder: boolean): MessagePage {
  return {
    messages,
    has_older: hasOlder,
    oldest_message_id: messages[0]?.id ?? null,
    total_active_count: messages.length,
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
      thinkingActiveMessageIds: new Set<string>(),
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

    useConversationStore.getState().cancelCurrentStream();

    expect(useConversationStore.getState().messages[0]?.content).toBe('Hello world');

    vi.useRealTimers();
  });

  it('hydrates inactive assistant versions into the store for multi-model rendering', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      content: 'question',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const activeError = {
      ...makeMessage(2),
      id: 'active-error',
      content: 'boom',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'error' as const,
      version_index: 0,
    };
    const inactiveSuccess = {
      ...makeMessage(4),
      id: 'inactive-success',
      content: 'ok',
      provider_id: 'provider-b',
      model_id: 'model-b',
      parent_message_id: user.id,
      is_active: false,
      status: 'complete' as const,
      version_index: 1,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, activeError],
    });

    useConversationStore.getState().hydrateMessageVersions(
      user.id,
      [activeError, inactiveSuccess],
      activeError.id,
    );

    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([
      'user-1',
      'active-error',
      'inactive-success',
    ]);
    expect(useConversationStore.getState().messages.find((message) => message.id === 'active-error')?.is_active).toBe(true);
    expect(useConversationStore.getState().messages.find((message) => message.id === 'inactive-success')?.is_active).toBe(false);
  });

  it('resolves a temp streaming id when hydrating the matching database version', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const tempAssistant = {
      ...makeMessage(2),
      id: 'temp-assistant-1',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'partial' as const,
    };
    const dbAssistant = {
      ...tempAssistant,
      id: 'db-assistant-1',
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: tempAssistant.id,
      messages: [user, tempAssistant],
    });

    useConversationStore.getState().hydrateMessageVersions(user.id, [dbAssistant], dbAssistant.id);

    expect(useConversationStore.getState().streamingMessageId).toBe('db-assistant-1');
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([
      'user-1',
      'db-assistant-1',
    ]);
  });

  it('adds a new model response as an inactive card when the parent already has multi-model versions', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const active = {
      ...makeMessage(2),
      id: 'assistant-a',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'complete' as const,
    };
    const inactive = {
      ...makeMessage(4),
      id: 'assistant-b',
      provider_id: 'provider-b',
      model_id: 'model-b',
      parent_message_id: user.id,
      is_active: false,
      status: 'complete' as const,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, active, inactive],
      enabledMcpServerIds: [],
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      thinkingBudget: null,
    });

    await useConversationStore.getState().regenerateWithModel(active.id, 'provider-c', 'model-c');

    expect(invokeMock).toHaveBeenCalledWith('regenerate_with_model', expect.objectContaining({
      conversationId: 'conv-1',
      userMessageId: user.id,
      targetProviderId: 'provider-c',
      targetModelId: 'model-c',
      isCompanion: true,
    }));

    const messages = useConversationStore.getState().messages;
    expect(messages.find((message) => message.id === active.id)?.is_active).toBe(true);
    const placeholder = messages.find((message) => message.model_id === 'model-c');
    expect(placeholder).toMatchObject({
      provider_id: 'provider-c',
      is_active: false,
      status: 'partial',
      parent_message_id: user.id,
    });
  });

  it('creates a new conversation from a category template when a category id is supplied', async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'create_conversation') {
        expect(args).toEqual({
          title: 'template-conversation',
          modelId: 'template-model',
          providerId: 'template-provider',
          systemPrompt: 'Category prompt',
        });
        return Promise.resolve(makeConversation('conv-template', {
          provider_id: 'template-provider',
          model_id: 'template-model',
          system_prompt: 'Category prompt',
        }));
      }

      if (cmd === 'update_conversation') {
        expect(args).toEqual({
          id: 'conv-template',
          input: {
            category_id: 'cat-template',
            system_prompt: 'Category prompt',
            temperature: 0.2,
            max_tokens: 8192,
            top_p: 0.95,
            frequency_penalty: 0.4,
            search_enabled: false,
            search_provider_id: null,
            thinking_budget: null,
            enabled_mcp_server_ids: [],
            enabled_knowledge_base_ids: [],
            enabled_memory_namespace_ids: [],
          },
        });

        return Promise.resolve(makeConversation('conv-template', {
          provider_id: 'template-provider',
          model_id: 'template-model',
          category_id: 'cat-template',
          system_prompt: 'Category prompt',
          temperature: 0.2,
          max_tokens: 8192,
          top_p: 0.95,
          frequency_penalty: 0.4,
        }));
      }

      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }

      throw new Error(`unexpected command: ${cmd}`);
    });

    const { useConversationStore } = await import('../conversationStore');
    const { useCategoryStore } = await import('../categoryStore');

    useCategoryStore.setState({
      categories: [{
        id: 'cat-template',
        name: 'Template',
        icon_type: null,
        icon_value: null,
        system_prompt: 'Category prompt',
        default_provider_id: 'template-provider',
        default_model_id: 'template-model',
        default_temperature: 0.2,
        default_max_tokens: 8192,
        default_top_p: 0.95,
        default_frequency_penalty: 0.4,
        sort_order: 0,
        is_collapsed: false,
        created_at: 1,
        updated_at: 1,
      }] as never[],
      loading: false,
    });

    const conversation = await useConversationStore.getState().createConversation(
      'template-conversation',
      'fallback-model',
      'fallback-provider',
      { categoryId: 'cat-template' },
    );

    expect(conversation.category_id).toBe('cat-template');
    expect(conversation.provider_id).toBe('template-provider');
    expect(conversation.model_id).toBe('template-model');
    expect(conversation.temperature).toBe(0.2);
    expect(conversation.max_tokens).toBe(8192);
  });
});
