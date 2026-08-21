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
  deferred,
  flushPromises,
  makeConversation,
  makeMessage,
  makePage,
} from './conversationStore.testUtils';

describe('conversationStore multi-model messages', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
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

  it('forwards the conversation follow-up mode for an ordinary message', async () => {
    tauriAvailable = true;
    localStorage.setItem('aqbot:multi-model-continuation-mode:conv-1', 'per_model');
    const conversation = makeConversation('conv-1');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      content: 'follow up',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === 'send_message') return Promise.resolve(user);
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      messages: [],
    });

    await useConversationStore.getState().sendMessage(user.content);

    expect(invokeMock).toHaveBeenCalledWith('send_message', expect.objectContaining({
      conversationId: conversation.id,
      content: user.content,
      historyMode: 'per_model',
    }));
  });

  it('uses the object API, locks one mode for every target, and resolves provider collisions', async () => {
    tauriAvailable = true;
    const conversation = makeConversation('conv-1');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
      content: 'continue both',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const companionVersion = {
      ...makeMessage(3),
      id: 'assistant-provider-b',
      provider_id: 'provider-b',
      model_id: 'shared-model',
      parent_message_id: user.id,
      version_index: 1,
      is_active: false,
    };
    const firstVersion = {
      ...makeMessage(2),
      id: 'assistant-provider-a',
      provider_id: 'provider-a',
      model_id: 'shared-model',
      parent_message_id: user.id,
      version_index: 0,
      is_active: true,
    };
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'update_conversation') {
        return Promise.resolve({ ...conversation, ...(args.input as Record<string, unknown>) });
      }
      if (command === 'send_message') return Promise.resolve(user);
      if (command === 'regenerate_with_model') return Promise.resolve(undefined);
      if (command === 'list_message_versions') {
        // Companion first exposes model-id-only matching bugs.
        return Promise.resolve([companionVersion, firstVersion]);
      }
      if (command === 'cancel_stream') return Promise.resolve(undefined);
      if (command === 'list_messages_page') return Promise.resolve(makePage([user, firstVersion], false));
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      messages: [],
    });

    const pending = useConversationStore.getState().sendMultiModelMessage({
      content: user.content,
      targetModels: [
        { providerId: 'provider-a', modelId: 'shared-model' },
        { providerId: 'provider-b', modelId: 'shared-model' },
      ],
      historyMode: 'per_model',
    });
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith('send_message', expect.objectContaining({
      historyMode: 'per_model',
    }));
    expect(invokeMock).toHaveBeenCalledWith('regenerate_with_model', expect.objectContaining({
      targetProviderId: 'provider-b',
      targetModelId: 'shared-model',
      historyMode: 'per_model',
    }));
    expect(useConversationStore.getState().streamingMessageId).toBe(firstVersion.id);
    expect(useConversationStore.getState().messages.find((message) => message.id === firstVersion.id))
      .toMatchObject({ provider_id: 'provider-a', model_id: 'shared-model' });

    useConversationStore.getState().cancelCurrentStream();
    await pending;
  });

  it('adds a new model response as an inactive card when the parent already has multi-model versions', async () => {
    localStorage.setItem('aqbot:multi-model-continuation-mode:conv-1', 'per_model');
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
      historyMode: 'per_model',
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
    localStorage.setItem('aqbot:multi-model-continuation-mode:conv-1', 'per_model');
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
      historyMode: 'per_model',
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
});
