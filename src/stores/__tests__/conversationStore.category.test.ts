import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();
let tauriAvailable = false;

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: listenMock,
  isTauri: () => tauriAvailable,
}));

import {
  makeConversation,
  makePage,
} from './conversationStore.testUtils';

describe('conversationStore category templates', () => {
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
            multi_model_targets: [],
            multi_model_continuation_mode: 'selected',
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
describe('conversationStore batchMoveToCategory', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tauriAvailable = false;
    listenMock.mockResolvedValue(() => {});
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [
        makeConversation('c1', { category_id: null }),
        makeConversation('c2', { category_id: 'cat-a' }),
        makeConversation('c3', { category_id: 'cat-a' }),
      ] as never[],
      activeConversationId: 'c1',
      messages: [],
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
      archivedConversations: [],
    });
  });

  it('moves selected conversations to the target category', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { id?: string; input?: { category_id?: string | null } }) => {
      if (cmd === 'update_conversation') {
        return makeConversation(args!.id!, { category_id: args!.input!.category_id });
      }
      if (cmd === 'reorder_conversations') return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });

    const { useConversationStore } = await import('../conversationStore');
    const moved = await useConversationStore.getState().batchMoveToCategory(['c1', 'c2'], 'cat-b');

    expect(moved).toBe(2);
    const byId = new Map(useConversationStore.getState().conversations.map((c) => [c.id, c]));
    expect(byId.get('c1')?.category_id).toBe('cat-b');
    expect(byId.get('c2')?.category_id).toBe('cat-b');
    expect(byId.get('c3')?.category_id).toBe('cat-a');
    expect(invokeMock).toHaveBeenCalledWith('reorder_conversations', {
      categoryId: 'cat-b',
      conversationIds: ['c1', 'c2'],
    });
  });

  it('removes category in reverse visible order and reports partial failures', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { id?: string; input?: { category_id?: string | null } }) => {
      if (cmd === 'update_conversation') {
        if (args!.id === 'c2') throw new Error('boom');
        return makeConversation(args!.id!, { category_id: args!.input!.category_id });
      }
      if (cmd === 'reorder_conversations') return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });

    const { useConversationStore } = await import('../conversationStore');
    await expect(
      useConversationStore.getState().batchMoveToCategory(['c1', 'c2', 'c3'], null),
    ).rejects.toThrow('c2: Error: boom');

    expect(invokeMock.mock.calls
      .filter(([command]) => command === 'update_conversation')
      .map(([, args]) => args.id))
      .toEqual(['c3', 'c2']);
    const byId = new Map(useConversationStore.getState().conversations.map((c) => [c.id, c]));
    expect(byId.get('c1')?.category_id).toBeNull();
    expect(byId.get('c2')?.category_id).toBe('cat-a');
    expect(byId.get('c3')?.category_id).toBeNull();
    expect(useConversationStore.getState().error).toContain('c2: Error: boom');
    expect(invokeMock).toHaveBeenCalledWith('reorder_conversations', {
      categoryId: null,
      conversationIds: ['c1', 'c3'],
    });
  });

  it('keeps selected conversations in visual order when some already belong to the target', async () => {
    invokeMock.mockImplementation(async (
      cmd: string,
      args?: { id?: string; input?: { category_id?: string | null } },
    ) => {
      if (cmd === 'update_conversation') {
        return makeConversation(args!.id!, { category_id: args!.input!.category_id });
      }
      if (cmd === 'reorder_conversations') return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [
        makeConversation('c1', { category_id: 'cat-b', sort_order: 0, updated_at: 123 }),
        makeConversation('c2', { category_id: 'cat-a', sort_order: 1 }),
        makeConversation('c3', { category_id: 'cat-b', sort_order: 2 }),
      ] as never[],
    });

    await useConversationStore.getState().batchMoveToCategory(['c1', 'c2'], 'cat-b');

    expect(invokeMock).toHaveBeenCalledWith('reorder_conversations', {
      categoryId: 'cat-b',
      conversationIds: ['c1', 'c2', 'c3'],
    });
    expect(invokeMock.mock.calls
      .filter(([command]) => command === 'update_conversation')
      .map(([, args]) => args.id))
      .toEqual(['c2']);
    expect(useConversationStore.getState().conversations.map((conversation) => ({
      id: conversation.id,
      categoryId: conversation.category_id,
      sortOrder: conversation.sort_order,
      updatedAt: conversation.updated_at,
    }))).toEqual([
      { id: 'c1', categoryId: 'cat-b', sortOrder: 0, updatedAt: 123 },
      { id: 'c2', categoryId: 'cat-b', sortOrder: 1, updatedAt: 1 },
      { id: 'c3', categoryId: 'cat-b', sortOrder: 2, updatedAt: 1 },
    ]);
  });

  it('flattens an uncategorized target in pinned and date-group order', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    invokeMock.mockImplementation(async (
      cmd: string,
      args?: { id?: string; input?: { category_id?: string | null } },
    ) => {
      if (cmd === 'update_conversation') {
        return makeConversation(args!.id!, {
          category_id: args!.input!.category_id,
          sort_order: -1,
          updated_at: nowSeconds,
        });
      }
      if (cmd === 'reorder_conversations') return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [
        makeConversation('pinned', { category_id: null, is_pinned: true }),
        makeConversation('today', { category_id: null, updated_at: nowSeconds }),
        makeConversation('earlier', { category_id: null, updated_at: 1 }),
        makeConversation('moved', { category_id: 'cat-a', updated_at: nowSeconds }),
      ] as never[],
    });

    await useConversationStore.getState().batchMoveToCategory(['moved'], null);

    expect(invokeMock).toHaveBeenCalledWith('reorder_conversations', {
      categoryId: null,
      conversationIds: ['pinned', 'moved', 'today', 'earlier'],
    });
  });

  it('persists a complete conversation order without changing updated_at', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [
        makeConversation('c1', { category_id: 'cat-a', sort_order: 0, updated_at: 100 }),
        makeConversation('c2', { category_id: 'cat-a', sort_order: 1, updated_at: 200 }),
      ] as never[],
    });

    await useConversationStore.getState().reorderConversations('cat-a', ['c2', 'c1']);

    expect(invokeMock).toHaveBeenCalledWith('reorder_conversations', {
      categoryId: 'cat-a',
      conversationIds: ['c2', 'c1'],
    });
    const byId = new Map(useConversationStore.getState().conversations.map((c) => [c.id, c]));
    expect(byId.get('c2')).toMatchObject({ sort_order: 0, updated_at: 200 });
    expect(byId.get('c1')).toMatchObject({ sort_order: 1, updated_at: 100 });
    expect(useConversationStore.getState().error).toBeNull();
  });

  it('keeps local order and exposes the real reorder error when persistence fails', async () => {
    invokeMock.mockRejectedValue(new Error('reorder failed'));
    const { useConversationStore } = await import('../conversationStore');
    const initial = [
      makeConversation('c1', { sort_order: 0 }),
      makeConversation('c2', { sort_order: 1 }),
    ];
    useConversationStore.setState({ conversations: initial as never[] });

    await expect(
      useConversationStore.getState().reorderConversations(null, ['c2', 'c1']),
    ).rejects.toThrow('reorder failed');

    expect(useConversationStore.getState().conversations).toEqual(initial);
    expect(useConversationStore.getState().error).toBe('Error: reorder failed');
  });
});
