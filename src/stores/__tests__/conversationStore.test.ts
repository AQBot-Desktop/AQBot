import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessagePage, MessageWindow } from '@/types';
import { parseSearchContent } from '@/lib/searchUtils';

const invokeMock = vi.fn();
const listenMock = vi.fn();
let tauriAvailable = false;

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: listenMock,
  isTauri: () => tauriAvailable,
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

function makeWindow(messages: Message[], hasOlder: boolean, hasNewer: boolean): MessageWindow {
  return {
    messages,
    has_older: hasOlder,
    has_newer: hasNewer,
    oldest_message_id: messages[0]?.id ?? null,
    newest_message_id: messages[messages.length - 1]?.id ?? null,
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
    thinking_level: null,
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
  for (let index = 0; index < 16; index += 1) {
    await Promise.resolve();
  }
}

describe('conversationStore pagination', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tauriAvailable = false;
    listenMock.mockResolvedValue(() => {});
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [],
      activeConversationId: null,
      messages: [],
      ragDisplayByMessageId: {},
      searchDisplayByMessageId: {},
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      hasOlderMessages: false,
      hasNewerMessages: false,
      totalActiveCount: 0,
      oldestLoadedMessageId: null,
      newestLoadedMessageId: null,
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      activeStreamId: null,
      streamActivityByMessageId: {},
      thinkingActiveMessageIds: new Set<string>(),
      error: null,
      searchEnabled: false,
      searchProviderId: null,
      enabledMcpServerIds: [],
      thinkingBudget: null,
      thinkingLevel: null,
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

  it('restores persisted RAG tags when preserving just-streamed local content', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const localMessage = {
      ...makeMessage(2),
      id: 'assistant-rag',
      content: '<think>local thinking</think>\n\nfresh streamed answer',
      token_count: null,
    };
    const dbMessage = {
      ...localMessage,
      content: '<knowledge-retrieval status="done" data-aqbot="1">\n[{"source_type":"knowledge","container_id":"kb-1","items":[{"content":"hit","score":0.2,"document_id":"doc-1","id":"chunk-1"}]}]\n</knowledge-retrieval>\n\nstale db answer',
      token_count: 123,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [localMessage],
      loading: false,
    });
    invokeMock.mockResolvedValueOnce(makePage([dbMessage], false));

    await useConversationStore.getState().fetchMessages('conv-1', ['assistant-rag']);

    const merged = useConversationStore.getState().messages.find((message) => message.id === 'assistant-rag');
    expect(merged?.content).toContain('<knowledge-retrieval status="done" data-aqbot="1">');
    expect(merged?.content).toContain('fresh streamed answer');
    expect(merged?.content).not.toContain('stale db answer');
    expect(merged?.token_count).toBe(123);
  });

  it('registers RAG stream listener before invoking send_message', async () => {
    vi.useFakeTimers();
    const registeredEvents: string[] = [];
    listenMock.mockImplementation(async (eventName: string) => {
      registeredEvents.push(eventName);
      return () => {};
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'send_message') {
        expect(registeredEvents).toContain('rag-context-retrieved');
        return Promise.resolve({
          ...makeMessage(1),
          id: 'user-real',
          role: 'user',
          content: 'question',
          provider_id: null,
          model_id: null,
        });
      }
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1', { enabled_knowledge_base_ids: ['kb-1'] })] as never[],
      enabledKnowledgeBaseIds: ['kb-1'],
      enabledMemoryNamespaceIds: [],
      messages: [],
    });

    const pending = useConversationStore.getState().sendMessage('question');
    await flushPromises();
    expect(Object.values(useConversationStore.getState().ragDisplayByMessageId)[0]).toContain('status="searching"');
    await vi.advanceTimersByTimeAsync(600);
    await pending;

    expect(invokeMock).toHaveBeenCalledWith('send_message', expect.objectContaining({
      conversationId: 'conv-1',
      enabledKnowledgeBaseIds: ['kb-1'],
    }));
    vi.useRealTimers();
  });

  it('filters stale conversation capability ids before sending a message', async () => {
    vi.useFakeTimers();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'send_message') {
        return Promise.resolve({
          ...makeMessage(1),
          id: 'user-real',
          role: 'user',
          content: 'question',
          provider_id: null,
          model_id: null,
        });
      }
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }
      if (cmd === 'update_conversation') {
        return Promise.resolve(makeConversation('conv-1', {
          enabled_mcp_server_ids: ['mcp-valid'],
          enabled_knowledge_base_ids: ['kb-valid'],
          enabled_memory_namespace_ids: ['mem-valid'],
        }));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    const { useKnowledgeStore } = await import('../knowledgeStore');
    const { useMemoryStore } = await import('../memoryStore');
    const { useMcpStore } = await import('../mcpStore');

    useKnowledgeStore.setState({
      bases: [{ id: 'kb-valid', name: 'Visible KB' }] as never[],
    });
    useMemoryStore.setState({
      namespaces: [{ id: 'mem-valid', name: 'Visible Memory' }] as never[],
    });
    useMcpStore.setState({
      servers: [
        { id: 'mcp-valid', enabled: true, name: 'Visible MCP' },
        { id: 'mcp-disabled', enabled: false, name: 'Disabled MCP' },
      ] as never[],
    });
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      enabledKnowledgeBaseIds: ['kb-valid', 'kb-deleted'],
      enabledMemoryNamespaceIds: ['mem-valid', 'mem-deleted'],
      enabledMcpServerIds: ['mcp-valid', 'mcp-disabled', 'mcp-deleted'],
      messages: [],
    });

    const pending = useConversationStore.getState().sendMessage('question');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(600);
    await pending;

    expect(invokeMock).toHaveBeenCalledWith('send_message', expect.objectContaining({
      conversationId: 'conv-1',
      enabledKnowledgeBaseIds: ['kb-valid'],
      enabledMemoryNamespaceIds: ['mem-valid'],
      enabledMcpServerIds: ['mcp-valid'],
    }));
    expect(useConversationStore.getState().enabledKnowledgeBaseIds).toEqual(['kb-valid']);
    expect(useConversationStore.getState().enabledMemoryNamespaceIds).toEqual(['mem-valid']);
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-valid']);
    vi.useRealTimers();
  });

  it('uses contextual query for web search while keeping the original user content in send_message', async () => {
    vi.useFakeTimers();
    listenMock.mockResolvedValue(() => {});
    let searchQuery = '';
    let sentContent = '';
    let sentContentPrefix = '';
    const searchResponse = deferred<unknown>();
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'execute_search') {
        searchQuery = args.query as string;
        return searchResponse.promise;
      }
      if (cmd === 'generate_search_query') {
        return Promise.resolve('AQBot Desktop 0.0.76 Windows 下载地址');
      }
      if (cmd === 'send_message') {
        sentContent = args.content as string;
        sentContentPrefix = args.contentPrefix as string;
        return Promise.resolve({
          ...makeMessage(5),
          id: 'user-real',
          role: 'user',
          content: sentContent,
          provider_id: null,
          model_id: null,
        });
      }
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      messages: [
        {
          ...makeMessage(1),
          role: 'user',
          content: '我要更改网站权限，让浏览器允许访问这个页面。',
        },
        {
          ...makeMessage(2),
          role: 'assistant',
          content: '可以打开浏览器站点设置，然后允许对应权限。',
        },
      ],
    });

    const pending = useConversationStore.getState().sendMessage('我已经给你权限了，继续', [], 'search-1');
    await flushPromises();

    const searchDisplayDuringSearch = Object.values(
      useConversationStore.getState().searchDisplayByMessageId,
    ).join('');
    expect(searchDisplayDuringSearch).toContain('status="searching"');
    expect(searchDisplayDuringSearch).toContain('query="AQBot Desktop 0.0.76 Windows 下载地址"');
    expect(searchDisplayDuringSearch).toContain('<web-search-query status="done"');

    searchResponse.resolve({
      ok: true,
      query: searchQuery,
      results: [
        {
          title: '权限设置说明',
          content: '浏览器网站权限可以在站点设置中调整。',
          url: 'https://example.com/permissions',
        },
      ],
      latencyMs: 12,
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(600);
    await pending;

    expect(invokeMock).toHaveBeenCalledWith('generate_search_query', {
      conversationId: 'conv-1',
      content: '我已经给你权限了，继续',
    });
    expect(searchQuery).toBe('AQBot Desktop 0.0.76 Windows 下载地址');
    expect(sentContent).toContain('以下是与问题相关的网络搜索结果，请参考回答');
    expect(sentContent).toContain('我已经给你权限了，继续');
    expect(parseSearchContent(sentContent).userContent).toBe('我已经给你权限了，继续');
    expect(parseSearchContent(sentContent).query).toBe('AQBot Desktop 0.0.76 Windows 下载地址');
    expect(sentContentPrefix).toContain('<web-search-query status="done"');
    expect(sentContentPrefix).toContain('<web-search status="done"');
    expect(sentContentPrefix).toContain('权限设置说明');
    vi.useRealTimers();
  });

  it('keeps query summary errors visible while continuing with fallback search', async () => {
    vi.useFakeTimers();
    listenMock.mockResolvedValue(() => {});
    let sentContent = '';
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'execute_search') {
        return Promise.resolve({
          ok: true,
          query: args.query,
          results: [],
          latencyMs: 8,
        });
      }
      if (cmd === 'generate_search_query') {
        return Promise.reject(new Error('model unavailable'));
      }
      if (cmd === 'send_message') {
        sentContent = args.content as string;
        return Promise.resolve({
          ...makeMessage(5),
          id: 'user-real',
          role: 'user',
          content: sentContent,
          provider_id: null,
          model_id: null,
        });
      }
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      messages: [
        {
          ...makeMessage(1),
          role: 'user',
          content: '帮我搜索 AQBot 下载地址',
        },
      ],
    });

    const pending = useConversationStore.getState().sendMessage('继续', [], 'search-1');
    await flushPromises();

    const searchDisplay = Object.values(useConversationStore.getState().searchDisplayByMessageId).join('');
    expect(searchDisplay).toContain('status="done"');
    expect(searchDisplay).toContain('<web-search-query status="error"');
    expect(searchDisplay).toContain('model unavailable');
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(parseSearchContent(sentContent).userContent).toBe('继续');
    expect(parseSearchContent(sentContent).queryError).toContain('model unavailable');
    expect(parseSearchContent(sentContent).userContent).not.toContain('搜索语句总结失败');
    vi.useRealTimers();
  });

  it('keeps search execution errors visible', async () => {
    vi.useFakeTimers();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'execute_search') {
        return Promise.resolve({
          ok: false,
          query: args.query,
          results: [],
          latencyMs: 8,
          error: 'Tavily request failed',
        });
      }
      if (cmd === 'generate_search_query') {
        return Promise.resolve('AQBot 下载');
      }
      if (cmd === 'send_message') {
        return Promise.resolve({
          ...makeMessage(5),
          id: 'user-real',
          role: 'user',
          content: args.content as string,
          provider_id: null,
          model_id: null,
        });
      }
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      messages: [],
    });

    const pending = useConversationStore.getState().sendMessage('搜索 AQBot 下载', [], 'search-1');
    await flushPromises();

    const searchDisplay = Object.values(useConversationStore.getState().searchDisplayByMessageId).join('');
    expect(searchDisplay).toContain('status="error"');
    expect(searchDisplay).toContain('Tavily request failed');
    expect(searchDisplay).toContain('<web-search-query status="done"');
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    vi.useRealTimers();
  });

  it('keeps a visible web-search prefix when search returns zero results', async () => {
    vi.useFakeTimers();
    listenMock.mockResolvedValue(() => {});
    let sentContent = '';
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'execute_search') {
        return Promise.resolve({
          ok: true,
          query: args.query,
          results: [],
          latencyMs: 8,
        });
      }
      if (cmd === 'generate_search_query') {
        return Promise.resolve('不存在的主题');
      }
      if (cmd === 'send_message') {
        sentContent = args.content as string;
        return Promise.resolve({
          ...makeMessage(5),
          id: 'user-real',
          role: 'user',
          content: sentContent,
          provider_id: null,
          model_id: null,
        });
      }
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      messages: [],
    });

    const pending = useConversationStore.getState().sendMessage('查一下不存在的主题', [], 'search-1');
    await flushPromises();

    const searchDisplay = Object.values(useConversationStore.getState().searchDisplayByMessageId).join('');
    expect(searchDisplay).toContain('<web-search status="done" data-aqbot="1"');
    expect(searchDisplay).toContain('[]');
    await vi.advanceTimersByTimeAsync(600);
    await pending;

    expect(parseSearchContent(sentContent).userContent).toBe('查一下不存在的主题');
    expect(parseSearchContent(sentContent).status).toBe('done');
    expect(parseSearchContent(sentContent).sources).toEqual([]);
    vi.useRealTimers();
  });

  it('keeps RAG display state when the streaming assistant resolves from temp to real id', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');
    const searching = '<knowledge-retrieval status="searching" data-aqbot="1"></knowledge-retrieval>';

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      ragDisplayByMessageId: {
        'temp-assistant-1': searching,
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('rag-context-retrieved')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        sources: [
          {
            source_type: 'knowledge',
            container_id: 'kb-1',
            items: [
              {
                content: 'hit',
                score: 0.2,
                document_id: 'doc-1',
                id: 'chunk-1',
              },
            ],
          },
        ],
      },
    });
    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: 'answer',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(35);

    const message = useConversationStore.getState().messages[0];
    const displayById = useConversationStore.getState().ragDisplayByMessageId;
    expect(message?.id).toBe('assistant-1');
    expect(message?.content).toBe('');
    expect(getLiveStreamContent('assistant-1')).toBe('answer');
    expect(displayById['assistant-1']).toContain('<knowledge-retrieval status="done" data-aqbot="1">');
    expect(displayById['assistant-1']).toContain('"content":"hit"');
    vi.useRealTimers();
  });

  it('keeps search display state when the streaming assistant resolves from temp to real id', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');
    const display = '<web-search status="done" data-aqbot="1" query="AQBot 下载">[]</web-search>';

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      searchDisplayByMessageId: {
        'temp-assistant-1': display,
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: 'answer',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(35);

    const displayById = useConversationStore.getState().searchDisplayByMessageId;
    expect(displayById['assistant-1']).toContain('query="AQBot 下载"');
    expect(useConversationStore.getState().messages[0]?.content).toBe('');
    expect(getLiveStreamContent('assistant-1')).toBe('answer');
    vi.useRealTimers();
  });

  it('tracks stream activity from temporary placeholder to real message id', async () => {
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
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      streamActivityByMessageId: {
        'temp-assistant-1': {
          startedAt: 1_000,
          firstChunkAt: null,
          lastChunkAt: null,
          providerId: 'provider-temp',
          modelId: 'model-temp',
          phase: 'waiting_first_packet',
        },
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });

    vi.setSystemTime(2_000);
    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        model_id: 'model-1',
        provider_id: 'provider-1',
        chunk: {
          content: 'answer',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    const activityById = useConversationStore.getState().streamActivityByMessageId;
    expect(activityById['temp-assistant-1']).toBeUndefined();
    expect(activityById['assistant-1']).toMatchObject({
      startedAt: 1_000,
      firstChunkAt: 2_000,
      lastChunkAt: 2_000,
      providerId: 'provider-1',
      modelId: 'model-1',
      phase: 'streaming',
    });
    vi.useRealTimers();
  });

  it('keeps token chunks in live stream content until the stream completes', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'assistant-1',
      streamingConversationId: 'conv-1',
      messages: [
        {
          ...makeMessage(2),
          id: 'assistant-1',
          role: 'assistant',
          content: 'Hello',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-chunk')?.({
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
    await vi.advanceTimersByTimeAsync(35);

    expect(getLiveStreamContent('assistant-1')).toBe('Hello world');
    expect(useConversationStore.getState().messages[0]?.content).toBe('Hello');

    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: '',
          thinking: null,
          tool_calls: null,
          done: true,
          is_final: true,
          usage: null,
        },
      },
    });

    expect(getLiveStreamContent('assistant-1')).toBeUndefined();
    expect(useConversationStore.getState().messages[0]?.content).toBe('Hello world');
    expect(useConversationStore.getState().messages[0]?.status).toBe('complete');
    vi.useRealTimers();
  });

  it('migrates live stream content when a temporary assistant id resolves', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: 'answer',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(35);

    expect(getLiveStreamContent('temp-assistant-1')).toBeUndefined();
    expect(getLiveStreamContent('assistant-1')).toBe('answer');
    expect(useConversationStore.getState().messages[0]?.id).toBe('assistant-1');
    expect(useConversationStore.getState().messages[0]?.content).toBe('');
    vi.useRealTimers();
  });

  it('keeps partial streamed content when the stream later errors', async () => {
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
      streamActivityByMessageId: {
        'assistant-1': {
          startedAt: 1_000,
          firstChunkAt: 2_000,
          lastChunkAt: 3_000,
          providerId: 'provider-1',
          modelId: 'model-1',
          phase: 'streaming',
        },
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'assistant-1',
          role: 'assistant',
          content: '已生成的前半段',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-error')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        model_id: 'model-1',
        provider_id: 'provider-1',
        error: '模型响应空闲超时，已超过 90 秒未收到新内容',
        kind: 'idle_timeout',
        timeout_secs: 90,
      },
    });

    const message = useConversationStore.getState().messages[0];
    expect(message?.status).toBe('error');
    expect(message?.content).toContain('已生成的前半段');
    expect(message?.content).toContain('模型响应空闲超时');
    expect(useConversationStore.getState().streamActivityByMessageId['assistant-1']).toBeUndefined();
  });

  it('materializes live stream content before appending stream errors', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'assistant-1',
      streamingConversationId: 'conv-1',
      messages: [
        {
          ...makeMessage(2),
          id: 'assistant-1',
          role: 'assistant',
          content: '已生成',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: '的前半段',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(35);

    expect(getLiveStreamContent('assistant-1')).toBe('已生成的前半段');
    expect(useConversationStore.getState().messages[0]?.content).toBe('已生成');

    listeners.get('chat-stream-error')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        error: '模型响应空闲超时',
        kind: 'idle_timeout',
        timeout_secs: 90,
      },
    });

    const message = useConversationStore.getState().messages[0];
    expect(getLiveStreamContent('assistant-1')).toBeUndefined();
    expect(message?.status).toBe('error');
    expect(message?.content).toContain('已生成的前半段');
    expect(message?.content).toContain('模型响应空闲超时');
    vi.useRealTimers();
  });

  it('ignores stale stream events from a previous stream id', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'assistant-current',
      streamingConversationId: 'conv-1',
      activeStreamId: 'stream-current',
      messages: [
        {
          ...makeMessage(2),
          id: 'assistant-current',
          role: 'assistant',
          content: 'current',
          status: 'partial',
        },
      ],
    } as never);

    await useConversationStore.getState().startStreamListening();
    const onChunk = listeners.get('chat-stream-chunk');
    const onError = listeners.get('chat-stream-error');
    expect(onChunk).toBeTypeOf('function');
    expect(onError).toBeTypeOf('function');

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-old',
        stream_id: 'stream-old',
        chunk: {
          content: 'old done',
          thinking: null,
          tool_calls: null,
          done: true,
          is_final: true,
          usage: null,
        },
      },
    });

    expect(useConversationStore.getState().streaming).toBe(true);
    expect(useConversationStore.getState().streamingMessageId).toBe('assistant-current');
    expect(useConversationStore.getState().messages[0]?.content).toBe('current');

    onError?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-old',
        stream_id: 'stream-old',
        error: 'old timeout',
        kind: 'idle_timeout',
        timeout_secs: 90,
      },
    });

    expect(useConversationStore.getState().streaming).toBe(true);
    expect(useConversationStore.getState().streamingMessageId).toBe('assistant-current');
    expect(useConversationStore.getState().messages[0]?.content).toBe('current');

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-current',
        stream_id: 'stream-current',
        chunk: {
          content: ' answer',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(useConversationStore.getState().streaming).toBe(true);
    expect(useConversationStore.getState().messages[0]?.content).toBe('current');
    expect(getLiveStreamContent('assistant-current')).toBe('current answer');
    vi.useRealTimers();
  });

  it('rolls back optimistic send when the backend rejects an overlapping stream', async () => {
    vi.useFakeTimers();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'send_message') {
        return Promise.reject(new Error('当前会话已有回复正在生成，请等待完成或停止后再发送'));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    const activeUser = {
      ...makeMessage(1),
      id: 'user-active',
      role: 'user' as const,
      content: 'first',
    };
    const activeAssistant = {
      ...makeMessage(2),
      id: 'assistant-active',
      role: 'assistant' as const,
      content: 'still streaming',
      parent_message_id: activeUser.id,
      status: 'partial' as const,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      streaming: true,
      streamingMessageId: activeAssistant.id,
      streamingConversationId: 'conv-1',
      activeStreamId: 'stream-active',
      messages: [activeUser, activeAssistant],
    } as never);

    await useConversationStore.getState().sendMessage('second');

    const state = useConversationStore.getState();
    expect(state.streaming).toBe(true);
    expect(state.streamingMessageId).toBe(activeAssistant.id);
    expect(state.activeStreamId).toBe('stream-active');
    expect(state.messages.map((message) => message.id)).toEqual(['user-active', 'assistant-active']);
    expect(state.messages[1]?.content).toBe('still streaming');
    vi.useRealTimers();
  });

  it('cancels stale backend stream state when an overlapping stream rejection happens while locally idle', async () => {
    tauriAvailable = true;
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'send_message') {
        return Promise.reject(new Error('当前会话已有回复正在生成，请等待完成或停止后再发送'));
      }
      if (cmd === 'cancel_stream') {
        return Promise.resolve(undefined);
      }
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([makeMessage(1), makeMessage(2)], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      activeStreamId: null,
      messages: [makeMessage(1), makeMessage(2)],
    } as never);

    await useConversationStore.getState().sendMessage('second');
    await flushPromises();

    const state = useConversationStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.streamingMessageId).toBeNull();
    expect(state.activeStreamId).toBeNull();
    expect(state.messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
    expect(invokeMock).toHaveBeenCalledWith('cancel_stream', {
      conversationId: 'conv-1',
      streamId: null,
    });
    expect(invokeMock).toHaveBeenCalledWith('list_messages_page', {
      conversationId: 'conv-1',
      limit: 10,
      beforeMessageId: null,
    });
  });

  it('keeps rendered search tags in local assistant content when model thinking starts streaming', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');
    const display = '<web-search-query status="done" data-aqbot="1" query="AQBot 产品详情"></web-search-query>\n\n<web-search status="done" data-aqbot="1">[]</web-search>\n\n';

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      searchDisplayByMessageId: {
        'temp-assistant-1': display,
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          role: 'assistant',
          content: display,
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: '<think data-aqbot="1">\n正在分析搜索结果',
          thinking: '',
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    const message = useConversationStore.getState().messages[0];
    expect(message?.id).toBe('assistant-1');
    expect(message?.content).toContain('<web-search-query status="done"');
    expect(message?.content).toContain('<web-search status="done"');
    expect(getLiveStreamContent('assistant-1')).toContain('<think data-aqbot="1">');
    expect(useConversationStore.getState().searchDisplayByMessageId['assistant-1']).toContain('AQBot 产品详情');
    vi.useRealTimers();
  });

  it('keeps search display state when a stream finishes before any content chunk', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { useConversationStore } = await import('../conversationStore');
    const display = '<web-search status="error" data-aqbot="1" query-status="error" query-error="bad query">Search failed</web-search>';

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      searchDisplayByMessageId: {
        'temp-assistant-1': display,
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([
          {
            ...makeMessage(2),
            id: 'assistant-1',
            role: 'assistant',
            content: 'answer',
            status: 'complete',
          },
        ], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: '',
          thinking: null,
          tool_calls: null,
          done: true,
          is_final: true,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(160);
    await flushPromises();

    const displayById = useConversationStore.getState().searchDisplayByMessageId;
    expect(displayById['assistant-1']).toContain('query-error="bad query"');
    vi.useRealTimers();
  });

  it('keeps a final no-content stream complete when the database row is still partial', async () => {
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
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([
          {
            ...makeMessage(2),
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            status: 'partial',
          },
        ], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        chunk: {
          content: '',
          thinking: null,
          tool_calls: null,
          done: true,
          is_final: true,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(160);
    await flushPromises();

    const messages = useConversationStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('assistant-1');
    expect(messages[0]?.status).toBe('complete');
    expect(useConversationStore.getState().streaming).toBe(false);
    expect(useConversationStore.getState().streamingMessageId).toBeNull();
    vi.useRealTimers();
  });

  it('keeps the initial streaming think tag when later chunks flush separately', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      thinkingActiveMessageIds: new Set<string>(),
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          conversation_id: 'conv-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    const onChunk = listeners.get('chat-stream-chunk');
    expect(onChunk).toBeTypeOf('function');

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        model_id: 'deepseek-v4-pro',
        provider_id: 'provider-1',
        chunk: {
          content: '<think data-aqbot="1">\n嗯',
          thinking: '',
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        model_id: 'deepseek-v4-pro',
        provider_id: 'provider-1',
        chunk: {
          content: '，',
          thinking: '',
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(35);

    const message = useConversationStore.getState().messages.find((item) => item.id === 'assistant-1');
    expect(message?.content).toBe('');
    expect(getLiveStreamContent('assistant-1')).toBe('<think data-aqbot="1">\n嗯，');
    expect(Array.from(useConversationStore.getState().thinkingActiveMessageIds)).toEqual(['assistant-1']);
    vi.useRealTimers();
  });

  it('preserves local streaming think content when a message refresh races with chunks', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      conversation_id: 'conv-1',
      role: 'user' as const,
      content: '你好',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const placeholder = {
      ...makeMessage(2),
      id: 'temp-assistant-1',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: '',
      status: 'partial' as const,
      parent_message_id: user.id,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: placeholder.id,
      streamingConversationId: 'conv-1',
      thinkingActiveMessageIds: new Set<string>(),
      messages: [user, placeholder],
    });

    await useConversationStore.getState().startStreamListening();
    const onChunk = listeners.get('chat-stream-chunk');
    expect(onChunk).toBeTypeOf('function');

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        model_id: 'deepseek-v4-pro',
        provider_id: 'provider-1',
        chunk: {
          content: '<think data-aqbot="1">\n嗯',
          thinking: '',
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(20);

    invokeMock.mockResolvedValueOnce(makePage([
      user,
      {
        ...placeholder,
        id: 'assistant-1',
        content: '',
      },
    ], false));
    await useConversationStore.getState().fetchMessages('conv-1');

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        model_id: 'deepseek-v4-pro',
        provider_id: 'provider-1',
        chunk: {
          content: '，',
          thinking: '',
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(35);

    const message = useConversationStore.getState().messages.find((item) => item.id === 'assistant-1');
    expect(message?.content).toBe('');
    expect(getLiveStreamContent('assistant-1')).toBe('<think data-aqbot="1">\n嗯，');
    vi.useRealTimers();
  });

  it('preserves local streaming think content when version hydration races with chunks', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      conversation_id: 'conv-1',
      role: 'user' as const,
      content: '你好',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const previousVersion = {
      ...makeMessage(2),
      id: 'assistant-old',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: '<think>old</think>\n\nold answer',
      status: 'complete' as const,
      parent_message_id: user.id,
      provider_id: 'provider-1',
      model_id: 'deepseek-v4-pro',
      version_index: 0,
      is_active: false,
    };
    const streamingVersion = {
      ...makeMessage(3),
      id: 'assistant-1',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: '<think data-aqbot="1">\n嗯',
      status: 'partial' as const,
      parent_message_id: user.id,
      provider_id: 'provider-1',
      model_id: 'deepseek-v4-pro',
      version_index: 1,
      is_active: true,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: streamingVersion.id,
      streamingConversationId: 'conv-1',
      thinkingActiveMessageIds: new Set([streamingVersion.id]),
      messages: [user, previousVersion, streamingVersion],
    });

    useConversationStore.getState().hydrateMessageVersions(user.id, [
      previousVersion,
      {
        ...streamingVersion,
        content: '',
      },
    ]);

    const message = useConversationStore.getState().messages.find((item) => item.id === streamingVersion.id);
    expect(message?.content).toBe('<think data-aqbot="1">\n嗯');
    expect(message?.status).toBe('partial');
  });

  it('applies early RAG retrieval events to the temporary streaming assistant', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      ragDisplayByMessageId: {
        'temp-assistant-1': '<knowledge-retrieval status="searching" data-aqbot="1"></knowledge-retrieval>',
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          conversation_id: 'conv-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('rag-context-retrieved')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        sources: [
          {
            source_type: 'knowledge',
            container_id: 'kb-1',
            items: [
              {
                content: 'hit',
                score: 0.2,
                document_id: 'doc-1',
                id: 'chunk-1',
              },
            ],
          },
        ],
      },
    });

    const message = useConversationStore.getState().messages[0];
    const displayById = useConversationStore.getState().ragDisplayByMessageId;
    expect(message?.id).toBe('temp-assistant-1');
    expect(message?.content).toBe('');
    expect(displayById['temp-assistant-1']).toContain('<knowledge-retrieval status="done" data-aqbot="1">');
    expect(displayById['assistant-1']).toContain('"content":"hit"');
  });

  it('replaces RAG searching display with failure when retrieval reports errors', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      ragDisplayByMessageId: {
        'temp-assistant-1': '<knowledge-retrieval status="searching" data-aqbot="1"></knowledge-retrieval>',
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          conversation_id: 'conv-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('rag-context-retrieved')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        sources: [],
        errors: [
          {
            source_type: 'knowledge',
            container_id: 'kb-1',
            message: 'Embedding 服务无响应',
          },
        ],
      },
    });

    const displayById = useConversationStore.getState().ragDisplayByMessageId;
    expect(displayById['temp-assistant-1']).toContain('<knowledge-retrieval status="error" data-aqbot="1">');
    expect(displayById['temp-assistant-1']).toContain('检索失败：Embedding 服务无响应');
  });

  it('keeps RAG display when retrieval returns no results after threshold filtering', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: 'temp-assistant-1',
      streamingConversationId: 'conv-1',
      ragDisplayByMessageId: {
        'temp-assistant-1': '<knowledge-retrieval status="searching" data-aqbot="1"></knowledge-retrieval>',
      },
      messages: [
        {
          ...makeMessage(2),
          id: 'temp-assistant-1',
          conversation_id: 'conv-1',
          role: 'assistant',
          content: '',
          status: 'partial',
        },
      ],
    });

    await useConversationStore.getState().startStreamListening();
    listeners.get('rag-context-retrieved')?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-1',
        sources: [],
        errors: [],
        empty_results: [
          {
            source_type: 'knowledge',
            container_id: 'kb-1',
            reason: 'threshold_filtered',
          },
        ],
      },
    });

    const displayById = useConversationStore.getState().ragDisplayByMessageId;
    expect(displayById['temp-assistant-1']).toContain(
      '<knowledge-retrieval status="empty" data-aqbot="1" reason="threshold_filtered">',
    );
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

  it('loads a bounded window around a minimap target', async () => {
    invokeMock.mockResolvedValue(makeWindow([makeMessage(40), makeMessage(41), makeMessage(42)], true, true));
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [makeMessage(98), makeMessage(99)],
      hasOlderMessages: true,
      hasNewerMessages: false,
      oldestLoadedMessageId: 'msg-98',
      newestLoadedMessageId: 'msg-99',
    });

    await useConversationStore.getState().loadMessagesAround('msg-41', 20, 30);

    expect(invokeMock).toHaveBeenCalledWith('list_messages_window', {
      conversationId: 'conv-1',
      anchorMessageId: 'msg-41',
      beforeLimit: 20,
      afterLimit: 30,
    });
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([
      'msg-40',
      'msg-41',
      'msg-42',
    ]);
    expect(useConversationStore.getState().hasOlderMessages).toBe(true);
    expect(useConversationStore.getState().hasNewerMessages).toBe(true);
    expect(useConversationStore.getState().oldestLoadedMessageId).toBe('msg-40');
    expect(useConversationStore.getState().newestLoadedMessageId).toBe('msg-42');
  });

  it('appends newer pages after jumping into an older message window', async () => {
    invokeMock.mockResolvedValue(makeWindow([makeMessage(43), makeMessage(44)], true, false));
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [makeMessage(40), makeMessage(41), makeMessage(42)],
      hasOlderMessages: true,
      hasNewerMessages: true,
      oldestLoadedMessageId: 'msg-40',
      newestLoadedMessageId: 'msg-42',
    });

    await useConversationStore.getState().loadNewerMessages();

    expect(invokeMock).toHaveBeenCalledWith('list_messages_after', {
      conversationId: 'conv-1',
      afterMessageId: 'msg-42',
      limit: 10,
    });
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([
      'msg-40',
      'msg-41',
      'msg-42',
      'msg-43',
      'msg-44',
    ]);
    expect(useConversationStore.getState().hasNewerMessages).toBe(false);
    expect(useConversationStore.getState().newestLoadedMessageId).toBe('msg-44');
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
          thinking_level: 'medium',
          enabled_mcp_server_ids: ['mcp-a'],
          enabled_knowledge_base_ids: ['kb-a'],
          enabled_memory_namespace_ids: ['mem-a'],
        }),
        makeConversation('conv-b', {
          search_enabled: false,
          search_provider_id: null,
          thinking_budget: null,
          thinking_level: null,
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
    expect(useConversationStore.getState().thinkingLevel).toBe('medium');
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-a']);
    expect(useConversationStore.getState().enabledKnowledgeBaseIds).toEqual(['kb-a']);
    expect(useConversationStore.getState().enabledMemoryNamespaceIds).toEqual(['mem-a']);

    useConversationStore.getState().setActiveConversation('conv-b');
    await flushPromises();

    expect(useConversationStore.getState().searchEnabled).toBe(false);
    expect(useConversationStore.getState().searchProviderId).toBeNull();
    expect(useConversationStore.getState().thinkingBudget).toBeNull();
    expect(useConversationStore.getState().thinkingLevel).toBeNull();
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

  it('inherits current capability preferences for newly created conversations by default', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'create_conversation') {
        return Promise.resolve(makeConversation('conv-new'));
      }

      if (cmd === 'update_conversation') {
        return Promise.resolve(makeConversation('conv-new', {
          search_enabled: true,
          search_provider_id: 'search-old',
          thinking_budget: 4096,
          thinking_level: 'high',
          enabled_mcp_server_ids: ['mcp-old'],
          enabled_knowledge_base_ids: ['kb-old'],
          enabled_memory_namespace_ids: ['mem-old'],
        }));
      }

      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }

      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-old',
      conversations: [makeConversation('conv-old')] as never[],
      searchEnabled: true,
      searchProviderId: 'search-old',
      thinkingBudget: 4096,
      thinkingLevel: 'high',
      enabledMcpServerIds: ['mcp-old'],
      enabledKnowledgeBaseIds: ['kb-old'],
      enabledMemoryNamespaceIds: ['mem-old'],
    });

    await useConversationStore.getState().createConversation(
      'new conversation',
      'model-1',
      'provider-1',
    );

    expect(invokeMock).toHaveBeenCalledWith('update_conversation', {
      id: 'conv-new',
      input: {
        search_enabled: true,
        search_provider_id: 'search-old',
        thinking_budget: 4096,
        thinking_level: 'high',
        enabled_mcp_server_ids: ['mcp-old'],
        enabled_knowledge_base_ids: ['kb-old'],
        enabled_memory_namespace_ids: ['mem-old'],
      },
    });
    expect(useConversationStore.getState().searchEnabled).toBe(true);
    expect(useConversationStore.getState().searchProviderId).toBe('search-old');
    expect(useConversationStore.getState().thinkingBudget).toBe(4096);
    expect(useConversationStore.getState().thinkingLevel).toBe('high');
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual(['mcp-old']);
    expect(useConversationStore.getState().enabledKnowledgeBaseIds).toEqual(['kb-old']);
    expect(useConversationStore.getState().enabledMemoryNamespaceIds).toEqual(['mem-old']);
  });

  it('starts newly created conversations with empty capability preferences when inheritance is disabled', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'create_conversation') {
        return Promise.resolve(makeConversation('conv-new'));
      }

      if (cmd === 'update_conversation') {
        return Promise.resolve(makeConversation('conv-new'));
      }

      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }

      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    const { useSettingsStore } = await import('../settingsStore');

    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        inherit_conversation_preferences_on_create: false,
      },
    }));
    useConversationStore.setState({
      activeConversationId: 'conv-old',
      conversations: [makeConversation('conv-old')] as never[],
      searchEnabled: true,
      searchProviderId: 'search-old',
      thinkingBudget: 4096,
      thinkingLevel: 'high',
      enabledMcpServerIds: ['mcp-old'],
      enabledKnowledgeBaseIds: ['kb-old'],
      enabledMemoryNamespaceIds: ['mem-old'],
    });

    await useConversationStore.getState().createConversation(
      'new conversation',
      'model-1',
      'provider-1',
    );

    expect(invokeMock).toHaveBeenCalledWith('update_conversation', {
      id: 'conv-new',
      input: {
        search_enabled: false,
        search_provider_id: null,
        thinking_budget: null,
        thinking_level: null,
        enabled_mcp_server_ids: [],
        enabled_knowledge_base_ids: [],
        enabled_memory_namespace_ids: [],
      },
    });
    expect(useConversationStore.getState().searchEnabled).toBe(false);
    expect(useConversationStore.getState().searchProviderId).toBeNull();
    expect(useConversationStore.getState().thinkingBudget).toBeNull();
    expect(useConversationStore.getState().thinkingLevel).toBeNull();
    expect(useConversationStore.getState().enabledMcpServerIds).toEqual([]);
    expect(useConversationStore.getState().enabledKnowledgeBaseIds).toEqual([]);
    expect(useConversationStore.getState().enabledMemoryNamespaceIds).toEqual([]);
  });

  it('tracks context compression loading by conversation id', async () => {
    const summary = {
      id: 'summary-1',
      conversation_id: 'conv-1',
      summary_text: 'compressed context',
      compressed_until_message_id: 'msg-1',
      token_count: 12,
      model_used: 'summary-model',
      created_at: 1,
      updated_at: 1,
    };
    const compression = deferred<typeof summary>();
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'compress_context') {
        expect(args.conversationId).toBe('conv-1');
        return compression.promise;
      }
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([makeMessage(1, 'conv-1')], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [
        makeConversation('conv-1'),
        makeConversation('conv-2'),
      ] as never[],
      messages: [makeMessage(1, 'conv-1')],
    });

    const pending = useConversationStore.getState().compressContext();
    await flushPromises();

    expect(useConversationStore.getState().compressingConversationId).toBe('conv-1');
    useConversationStore.setState({ activeConversationId: 'conv-2' });
    expect(useConversationStore.getState().compressingConversationId).toBe('conv-1');

    compression.resolve(summary);
    await pending;

    expect(useConversationStore.getState().compressingConversationId).toBeNull();
  });

  it('applies compression events only to the matching active conversation', async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { useConversationStore } = await import('../conversationStore');
    const marker = {
      ...makeMessage(50, 'conv-1'),
      role: 'system',
      content: '<!-- context-compressed -->',
    };
    const otherMarker = {
      ...makeMessage(60, 'conv-2'),
      role: 'system',
      content: '<!-- context-compressed -->',
    };
    const summary = {
      id: 'summary-1',
      conversation_id: 'conv-1',
      summary_text: 'compressed context',
      compressed_until_message_id: 'msg-1',
      token_count: 12,
      model_used: 'summary-model',
      created_at: 1,
      updated_at: 1,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [
        makeConversation('conv-1'),
        makeConversation('conv-2'),
      ] as never[],
      messages: [makeMessage(1, 'conv-1')],
    });

    await useConversationStore.getState().startStreamListening();

    listeners.get('conversation:compressed')?.({
      payload: {
        conversation_id: 'conv-2',
        marker_message: otherMarker,
        summary: { ...summary, conversation_id: 'conv-2' },
      },
    });
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual(['msg-1']);

    listeners.get('conversation:compressed')?.({
      payload: {
        conversation_id: 'conv-1',
        marker_message: marker,
        summary,
      },
    });

    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual(['msg-1', 'msg-50']);
  });

  it('persists reasoning level changes separately from legacy thinking budget', async () => {
    invokeMock.mockResolvedValueOnce(makeConversation('conv-1', { thinking_budget: 4096, thinking_level: 'high' }));
    const { useConversationStore } = await import('../conversationStore');

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      thinkingLevel: null,
      thinkingBudget: 4096,
    });

    useConversationStore.getState().setThinkingLevel('high');
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith('update_conversation', {
      id: 'conv-1',
      input: {
        thinking_level: 'high',
      },
    });
    expect(useConversationStore.getState().thinkingLevel).toBe('high');
    expect(useConversationStore.getState().thinkingBudget).toBe(4096);
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

  it('can regenerate a selected inactive model version without activating the new response', async () => {
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
      version_index: 1,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, active, inactive],
      enabledMcpServerIds: [],
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      thinkingBudget: null,
    });

    const returned = await useConversationStore.getState().regenerateWithModel(inactive.id, 'provider-b', 'model-b', { activate: false });

    expect(invokeMock).toHaveBeenCalledWith('regenerate_with_model', expect.objectContaining({
      conversationId: 'conv-1',
      userMessageId: user.id,
      targetProviderId: 'provider-b',
      targetModelId: 'model-b',
      isCompanion: true,
    }));

    const placeholder = useConversationStore.getState().messages.find(
      (message) => message.id.startsWith('temp-assistant-') && message.model_id === 'model-b',
    );
    expect(returned).toBeDefined();
    expect(returned.id).toBe(placeholder?.id);
    expect(placeholder).toMatchObject({
      provider_id: 'provider-b',
      is_active: false,
      status: 'partial',
    });
  });

  it('can regenerate a selected active model version as the active response', async () => {
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
      version_index: 1,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, active, inactive],
      enabledMcpServerIds: [],
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      thinkingBudget: null,
    });

    await useConversationStore.getState().regenerateWithModel(active.id, 'provider-a', 'model-a', { activate: true });

    expect(invokeMock).toHaveBeenCalledWith('regenerate_with_model', expect.objectContaining({
      conversationId: 'conv-1',
      userMessageId: user.id,
      targetProviderId: 'provider-a',
      targetModelId: 'model-a',
      isCompanion: undefined,
    }));

    const placeholder = useConversationStore.getState().messages.find(
      (message) => message.id.startsWith('temp-assistant-') && message.model_id === 'model-a',
    );
    expect(placeholder).toMatchObject({
      provider_id: 'provider-a',
      is_active: true,
      status: 'partial',
    });
  });

  it('keeps the same-model regenerate placeholder active while the new answer streams', async () => {
    vi.useFakeTimers();
    const regenerate = deferred<void>();
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
    const active = {
      ...makeMessage(2),
      id: 'assistant-a',
      content: 'old answer',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'complete' as const,
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'regenerate_message') return regenerate.promise;
      if (cmd === 'list_messages_page') return Promise.resolve(makePage([user, active], false));
      throw new Error(`unexpected command: ${cmd}`);
    });

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, active],
      enabledMcpServerIds: [],
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      thinkingBudget: null,
    });

    const pending = useConversationStore.getState().regenerateMessage(active.id);
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith('regenerate_message', expect.objectContaining({
      conversationId: 'conv-1',
      userMessageId: user.id,
    }));

    const messages = useConversationStore.getState().messages;
    const placeholder = messages.find((message) => message.id.startsWith('temp-assistant-'));
    expect(messages.find((message) => message.id === active.id)?.is_active).toBe(false);
    expect(placeholder).toMatchObject({
      content: '',
      is_active: true,
      parent_message_id: user.id,
      provider_id: active.provider_id,
      model_id: active.model_id,
      status: 'partial',
    });
    expect(useConversationStore.getState().streamingMessageId).toBe(placeholder?.id);

    regenerate.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toMatchObject({
      id: placeholder?.id,
      parent_message_id: user.id,
      model_id: active.model_id,
      is_active: true,
      status: 'partial',
    });
    vi.useRealTimers();
  });

  it('does not send temp user ids to regenerate_message', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'temp-user-1',
      role: 'user' as const,
      content: 'question still saving',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const assistant = {
      ...makeMessage(2),
      id: 'temp-assistant-1',
      content: '',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'partial' as const,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, assistant],
      enabledMcpServerIds: [],
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      thinkingBudget: null,
    });

    await expect(useConversationStore.getState().regenerateMessage(assistant.id))
      .rejects
      .toThrow('消息仍在保存');

    expect(invokeMock).not.toHaveBeenCalledWith('regenerate_message', expect.anything());
    expect(useConversationStore.getState().messages).toHaveLength(2);
  });

  it('resolves a same-model regenerated temp placeholder to the active partial database version', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const oldVersion = {
      ...makeMessage(2),
      id: 'assistant-old',
      content: 'old answer',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: false,
      status: 'complete' as const,
      version_index: 0,
    };
    const tempPlaceholder = {
      ...makeMessage(6),
      id: 'temp-assistant-1',
      content: '',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'partial' as const,
      version_index: 1,
    };
    const dbPlaceholder = {
      ...tempPlaceholder,
      id: 'assistant-new',
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: tempPlaceholder.id,
      streamingConversationId: 'conv-1',
      messages: [user, oldVersion, tempPlaceholder],
    });

    useConversationStore.getState().hydrateMessageVersions(user.id, [oldVersion, dbPlaceholder]);

    const messages = useConversationStore.getState().messages;
    expect(useConversationStore.getState().streamingMessageId).toBe(dbPlaceholder.id);
    expect(messages.map((message) => message.id)).toEqual(['user-1', 'assistant-old', 'assistant-new']);
    expect(messages.find((message) => message.id === dbPlaceholder.id)).toMatchObject({
      is_active: true,
      status: 'partial',
    });
  });

  it('preserves the local temp placeholder when hydration only returns old same-model versions', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const oldVersion = {
      ...makeMessage(2),
      id: 'assistant-old',
      content: 'old answer',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: false,
      status: 'complete' as const,
      version_index: 0,
    };
    const tempPlaceholder = {
      ...makeMessage(6),
      id: 'temp-assistant-1',
      content: '',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'partial' as const,
      version_index: 1,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: tempPlaceholder.id,
      streamingConversationId: 'conv-1',
      messages: [user, oldVersion, tempPlaceholder],
    });

    useConversationStore.getState().hydrateMessageVersions(user.id, [oldVersion]);

    const messages = useConversationStore.getState().messages;
    expect(useConversationStore.getState().streamingMessageId).toBe(tempPlaceholder.id);
    expect(messages.map((message) => message.id)).toEqual(['user-1', 'assistant-old', 'temp-assistant-1']);
    expect(messages.find((message) => message.id === tempPlaceholder.id)).toMatchObject({
      is_active: true,
      status: 'partial',
    });
  });

  it('switches to a temporary assistant version locally without calling the backend', async () => {
    invokeMock.mockResolvedValue([]);
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
      id: 'assistant-active',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'complete' as const,
      version_index: 0,
    };
    const temp = {
      ...makeMessage(6),
      id: 'temp-assistant-1',
      provider_id: 'provider-b',
      model_id: 'model-b',
      parent_message_id: user.id,
      is_active: false,
      status: 'partial' as const,
      version_index: 1,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, active, temp],
    });

    await useConversationStore.getState().switchMessageVersion('conv-1', user.id, temp.id);

    expect(invokeMock).not.toHaveBeenCalledWith('switch_message_version', expect.anything());
    const messages = useConversationStore.getState().messages;
    expect(messages.find((message) => message.id === active.id)?.is_active).toBe(false);
    expect(messages.find((message) => message.id === temp.id)?.is_active).toBe(true);
  });

  it('syncs a locally selected temporary version after hydration resolves its real id', async () => {
    invokeMock.mockResolvedValue([]);
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
      id: 'assistant-active',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'complete' as const,
      version_index: 0,
    };
    const temp = {
      ...makeMessage(6),
      id: 'temp-assistant-1',
      provider_id: 'provider-b',
      model_id: 'model-b',
      parent_message_id: user.id,
      is_active: false,
      status: 'partial' as const,
      version_index: 1,
    };
    const resolved = {
      ...temp,
      id: 'assistant-resolved',
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, active, temp],
    });

    await useConversationStore.getState().switchMessageVersion('conv-1', user.id, temp.id);
    invokeMock.mockClear();

    useConversationStore.getState().hydrateMessageVersions(user.id, [active, resolved]);
    await flushPromises();

    const messages = useConversationStore.getState().messages;
    expect(messages.map((message) => message.id)).toEqual(['user-1', 'assistant-active', 'assistant-resolved']);
    expect(messages.find((message) => message.id === active.id)?.is_active).toBe(false);
    expect(messages.find((message) => message.id === resolved.id)?.is_active).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('switch_message_version', {
      conversationId: 'conv-1',
      parentMessageId: user.id,
      messageId: resolved.id,
    });
    expect(invokeMock).not.toHaveBeenCalledWith('switch_message_version', {
      conversationId: 'conv-1',
      parentMessageId: user.id,
      messageId: temp.id,
    });
  });

  it('keeps the locally active real version when hydration still marks the first version active', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const firstLocal = {
      ...makeMessage(2),
      id: 'assistant-first',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: false,
      status: 'partial' as const,
      version_index: 0,
    };
    const secondLocal = {
      ...makeMessage(6),
      id: 'assistant-second',
      provider_id: 'provider-b',
      model_id: 'model-b',
      parent_message_id: user.id,
      is_active: true,
      status: 'partial' as const,
      version_index: 1,
    };
    const firstFromDb = {
      ...firstLocal,
      is_active: true,
    };
    const secondFromDb = {
      ...secondLocal,
      is_active: false,
    };

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, firstLocal, secondLocal],
    });

    useConversationStore.getState().hydrateMessageVersions(user.id, [firstFromDb, secondFromDb]);

    const messages = useConversationStore.getState().messages;
    expect(messages.find((message) => message.id === firstLocal.id)?.is_active).toBe(false);
    expect(messages.find((message) => message.id === secondLocal.id)?.is_active).toBe(true);
  });

  it('regenerates the specified user message instead of falling back to the last user message', async () => {
    vi.useFakeTimers();
    const regenerate = deferred<void>();
    const { useConversationStore } = await import('../conversationStore');
    const firstUser = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      content: 'first question',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const firstAssistant = {
      ...makeMessage(2),
      id: 'assistant-1',
      content: 'first answer',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: firstUser.id,
      is_active: true,
      status: 'complete' as const,
    };
    const lastUser = {
      ...makeMessage(3),
      id: 'user-2',
      role: 'user' as const,
      content: 'last question',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const lastAssistant = {
      ...makeMessage(4),
      id: 'assistant-2',
      content: 'last answer',
      provider_id: 'provider-b',
      model_id: 'model-b',
      parent_message_id: lastUser.id,
      is_active: true,
      status: 'complete' as const,
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'regenerate_message') return regenerate.promise;
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([firstUser, firstAssistant, lastUser, lastAssistant], false));
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [firstUser, firstAssistant, lastUser, lastAssistant],
      enabledMcpServerIds: [],
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      thinkingBudget: null,
    });

    const pending = useConversationStore.getState().regenerateMessage(firstUser.id);
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith('regenerate_message', expect.objectContaining({
      userMessageId: firstUser.id,
    }));

    const messages = useConversationStore.getState().messages;
    const placeholder = messages.find((message) => message.id.startsWith('temp-assistant-'));
    expect(messages.find((message) => message.id === firstAssistant.id)?.is_active).toBe(false);
    expect(messages.find((message) => message.id === lastAssistant.id)?.is_active).toBe(true);
    expect(placeholder).toMatchObject({
      is_active: true,
      parent_message_id: firstUser.id,
      provider_id: firstAssistant.provider_id,
      model_id: firstAssistant.model_id,
      status: 'partial',
    });

    regenerate.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    vi.useRealTimers();
  });

  it('keeps an inactive companion model visible while streaming chunks arrive and after final refresh', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: unknown) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const { getLiveStreamContent, useConversationStore } = await import('../conversationStore');
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
      content: 'old answer',
      provider_id: 'provider-a',
      model_id: 'model-a',
      parent_message_id: user.id,
      is_active: true,
      status: 'complete' as const,
    };
    const companionPlaceholder = {
      ...makeMessage(4),
      id: 'temp-assistant-c',
      content: '',
      provider_id: 'provider-c',
      model_id: 'model-c',
      parent_message_id: user.id,
      is_active: false,
      status: 'partial' as const,
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_messages_page') {
        return Promise.resolve(makePage([user, active], false));
      }
      return Promise.resolve(undefined);
    });

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingMessageId: companionPlaceholder.id,
      streamingConversationId: 'conv-1',
      messages: [user, active, companionPlaceholder],
    });

    await useConversationStore.getState().startStreamListening();
    const onChunk = listeners.get('chat-stream-chunk');
    expect(onChunk).toBeTypeOf('function');

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-c',
        model_id: 'model-c',
        provider_id: 'provider-c',
        chunk: {
          content: 'streamed',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    vi.advanceTimersByTime(20);

    expect(getLiveStreamContent('assistant-c')).toBe('streamed');
    expect(useConversationStore.getState().messages.find((message) => message.id === 'assistant-c')).toMatchObject({
      content: '',
      is_active: false,
      parent_message_id: user.id,
      status: 'partial',
    });
    expect(useConversationStore.getState().messages.find((message) => message.id === active.id)?.is_active).toBe(true);

    onChunk?.({
      payload: {
        conversation_id: 'conv-1',
        message_id: 'assistant-c',
        model_id: 'model-c',
        provider_id: 'provider-c',
        chunk: {
          content: null,
          thinking: null,
          tool_calls: null,
          done: true,
          is_final: true,
          usage: null,
        },
      },
    });
    vi.advanceTimersByTime(130);
    await flushPromises();

    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-a',
      'assistant-c',
    ]);
    expect(useConversationStore.getState().messages.find((message) => message.id === 'assistant-c')).toMatchObject({
      content: 'streamed',
      is_active: false,
      status: 'complete',
    });

    vi.useRealTimers();
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
            thinking_level: null,
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
