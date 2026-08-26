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

  it('treats a ready empty version snapshot as authoritative', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
    };
    const oldAssistant = {
      ...makeMessage(2),
      id: 'answer-a',
      parent_message_id: user.id,
      role: 'assistant' as const,
    };
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, oldAssistant],
    });

    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      user.id,
      [],
    );

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource).toMatchObject({
      conversationId: 'conv-1',
      parentMessageId: user.id,
      versions: [],
      error: null,
      meta: { status: 'ready' },
    });
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([user.id]);
  });

  it('rejects version queries and preserves a non-empty resource error', async () => {
    const queryError = new Error('version query unavailable');
    invokeMock.mockRejectedValue(queryError);
    const { useConversationStore } = await import('../conversationStore');
    const version = {
      ...makeMessage(2),
      id: 'answer-a',
      parent_message_id: 'user-1',
      role: 'assistant' as const,
    };
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      'user-1',
      [version],
    );
    useConversationStore.getState().invalidateMessageVersionGroups('conv-1', ['user-1']);

    await expect(useConversationStore.getState().listMessageVersions('conv-1', 'user-1'))
      .rejects.toThrow('version query unavailable');
    await expect(useConversationStore.getState().listMessageVersionsBatch('conv-1', ['user-1']))
      .rejects.toThrow('version query unavailable');
    await expect(useConversationStore.getState().ensureMessageVersionGroupsLoaded('conv-1', ['user-1']))
      .rejects.toThrow('version query unavailable');

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.versions.map((message) => message.id)).toEqual(['answer-a']);
    expect(resource.meta.status).toBe('error');
    expect(resource.meta.loadedAt).not.toBeNull();
    expect(resource.error).toContain('version query unavailable');
  });

  it('keeps the last successful snapshot authoritative during a force reload', async () => {
    const reload = deferred<Record<string, ReturnType<typeof makeMessage>[]>>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_message_versions_batch') return reload.promise;
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const [{ useConversationStore, hasAuthoritativeMessageVersionSnapshot }, { selectRenderableVersionSet }] = await Promise.all([
      import('../conversationStore'),
      import('@/lib/chatMultiModel'),
    ]);
    const snapshotA = {
      ...makeMessage(2),
      id: 'answer-a',
      content: 'persisted-a',
      parent_message_id: 'user-1',
      role: 'assistant' as const,
    };
    const snapshotB = {
      ...makeMessage(4),
      id: 'answer-b',
      parent_message_id: 'user-1',
      role: 'assistant' as const,
    };
    const liveA = { ...snapshotA, content: 'live-a' };
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      'user-1',
      [snapshotA, snapshotB],
    );

    const loading = useConversationStore.getState()
      .ensureMessageVersionGroupsLoaded('conv-1', ['user-1'], { force: true });
    await flushPromises();

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.meta.status).toBe('loading');
    expect(hasAuthoritativeMessageVersionSnapshot(resource)).toBe(true);
    expect(selectRenderableVersionSet(resource.versions, [liveA])).toEqual([liveA, snapshotB]);

    reload.resolve({ 'user-1': [snapshotA, snapshotB] });
    await loading;
  });

  it('ignores an older version request after the group revision changes', async () => {
    const staleRequest = deferred<Record<string, ReturnType<typeof makeMessage>[]>>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_message_versions_batch') return staleRequest.promise;
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    const freshA = {
      ...makeMessage(2),
      id: 'answer-a',
      parent_message_id: 'user-1',
      role: 'assistant' as const,
      content: 'fresh',
    };
    const staleB = {
      ...makeMessage(4),
      id: 'answer-b',
      parent_message_id: 'user-1',
      role: 'assistant' as const,
    };

    const loading = useConversationStore.getState()
      .ensureMessageVersionGroupsLoaded('conv-1', ['user-1']);
    await flushPromises();
    useConversationStore.getState().invalidateMessageVersionGroups('conv-1', ['user-1']);
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      'user-1',
      [freshA],
    );
    staleRequest.resolve({ 'user-1': [freshA, staleB] });
    await loading;

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.versions.map((message) => message.id)).toEqual(['answer-a']);
    expect(resource.versions[0]?.content).toBe('fresh');
  });

  it('starts a fresh request after invalidation and pruning while an older request is pending', async () => {
    const staleRequest = deferred<Record<string, ReturnType<typeof makeMessage>[]>>();
    const freshRequest = deferred<Record<string, ReturnType<typeof makeMessage>[]>>();
    let requestCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command !== 'list_message_versions_batch') {
        if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
      }
      requestCount += 1;
      return requestCount === 1 ? staleRequest.promise : freshRequest.promise;
    });
    const { useConversationStore } = await import('../conversationStore');
    const freshA = {
      ...makeMessage(2),
      id: 'answer-a',
      parent_message_id: 'user-1',
      role: 'assistant' as const,
      content: 'fresh',
    };
    const staleB = {
      ...makeMessage(4),
      id: 'answer-b',
      parent_message_id: 'user-1',
      role: 'assistant' as const,
    };

    const staleLoading = useConversationStore.getState()
      .ensureMessageVersionGroupsLoaded('conv-1', ['user-1']);
    await flushPromises();
    useConversationStore.getState().invalidateMessageVersionGroups('conv-1', ['user-1']);
    useConversationStore.setState({ messageVersionGroups: {} });
    const freshLoading = useConversationStore.getState()
      .ensureMessageVersionGroupsLoaded('conv-1', ['user-1']);
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    freshRequest.resolve({ 'user-1': [freshA] });
    await freshLoading;
    staleRequest.reject(new Error(`stale response included ${staleB.id}`));
    await expect(staleLoading).resolves.toBeUndefined();

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.versions.map((message) => message.id)).toEqual(['answer-a']);
    expect(resource.versions[0]?.content).toBe('fresh');
  });

  it('keeps the latest active version when switch refreshes complete out of order', async () => {
    const staleRefresh = deferred<Record<string, ReturnType<typeof makeMessage>[]>>();
    const freshRefresh = deferred<Record<string, ReturnType<typeof makeMessage>[]>>();
    let refreshCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'switch_message_version') return Promise.resolve();
      if (command === 'list_message_versions_batch') {
        refreshCount += 1;
        return refreshCount === 1 ? staleRefresh.promise : freshRefresh.promise;
      }
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    const user = { ...makeMessage(1), id: 'user-1', role: 'user' as const };
    const answerA = {
      ...makeMessage(2),
      id: 'answer-a',
      parent_message_id: user.id,
      role: 'assistant' as const,
      is_active: true,
    };
    const answerB = {
      ...makeMessage(3),
      id: 'answer-b',
      parent_message_id: user.id,
      role: 'assistant' as const,
      is_active: false,
    };
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, answerA, answerB],
    });
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      user.id,
      [answerA, answerB],
    );

    const switchToB = useConversationStore.getState()
      .switchMessageVersion('conv-1', user.id, answerB.id);
    await vi.waitFor(() => expect(refreshCount).toBe(1));
    const switchBackToA = useConversationStore.getState()
      .switchMessageVersion('conv-1', user.id, answerA.id);
    await vi.waitFor(() => expect(refreshCount).toBe(2));

    freshRefresh.resolve({
      [user.id]: [
        { ...answerA, is_active: true },
        { ...answerB, is_active: false },
      ],
    });
    await switchBackToA;
    staleRefresh.resolve({
      [user.id]: [
        { ...answerA, is_active: false },
        { ...answerB, is_active: true },
      ],
    });
    await switchToB;

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.versions.find((version) => version.is_active)?.id).toBe(answerA.id);
    expect(useConversationStore.getState().messages.find((message) => (
      message.role === 'assistant' && message.is_active
    ))?.id)
      .toBe(answerA.id);
  });

  it('retains but invalidates a complete snapshot after an active-only message refresh', async () => {
    const user = {
      ...makeMessage(1),
      id: 'user-1',
      role: 'user' as const,
    };
    const activeA = {
      ...makeMessage(2),
      id: 'answer-a',
      parent_message_id: user.id,
      role: 'assistant' as const,
      is_active: true,
    };
    const inactiveB = {
      ...makeMessage(4),
      id: 'answer-b',
      parent_message_id: user.id,
      role: 'assistant' as const,
      is_active: false,
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_messages_page') {
        return Promise.resolve(makePage([user, activeA], false));
      }
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore, hasAuthoritativeMessageVersionSnapshot } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [user, activeA, inactiveB],
    });
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      user.id,
      [activeA, inactiveB],
    );

    await useConversationStore.getState().fetchMessages('conv-1');

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.meta.status).toBe('idle');
    expect(hasAuthoritativeMessageVersionSnapshot(resource)).toBe(true);
    expect(resource.versions.map((message) => message.id)).toEqual(['answer-a', 'answer-b']);
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual(['user-1', 'answer-a']);
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
    const conversation = {
      ...makeConversation('conv-1'),
      multi_model_display_mode_override: null,
    };
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
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      messages: [],
      multiModelContinuationMode: 'per_model',
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
    const conversation = {
      ...makeConversation('conv-1'),
      multi_model_display_mode_override: null,
    };
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
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
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

    expect(invokeMock).toHaveBeenCalledWith('start_multi_model_run', expect.objectContaining({
      historyMode: 'per_model',
      targets: [
        { providerId: 'provider-a', modelId: 'shared-model' },
        { providerId: 'provider-b', modelId: 'shared-model' },
      ],
    }));
    const streamingState = useConversationStore.getState();
    expect(streamingState.multiModelParentId).toBe(user.id);

    useConversationStore.getState().cancelCurrentStream();
    await pending;
  });

  it('scopes pending model status to the optimistic user message before the backend responds', async () => {
    tauriAvailable = true;
    const conversation = {
      ...makeConversation('conv-1'),
      multi_model_display_mode_override: null,
    };
    const persistedUser = {
      ...makeMessage(1),
      id: 'user-persisted',
      role: 'user' as const,
      content: 'show progress immediately',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const sendMessage = deferred<typeof persistedUser>();
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'update_conversation') {
        return Promise.resolve({ ...conversation, ...(args.input as Record<string, unknown>) });
      }
      if (command === 'send_message') return sendMessage.promise;
      if (command === 'regenerate_with_model') return Promise.resolve(undefined);
      if (command === 'list_message_versions') return Promise.resolve([]);
      if (command === 'cancel_stream') return Promise.resolve(undefined);
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      messages: [],
    });

    const pending = useConversationStore.getState().sendMultiModelMessage({
      content: persistedUser.content,
      targetModels: [
        { providerId: 'provider-a', modelId: 'model-a' },
        { providerId: 'provider-b', modelId: 'model-b' },
      ],
    });
    await flushPromises();

    const optimisticState = useConversationStore.getState();
    expect(invokeMock).toHaveBeenCalledWith('start_multi_model_run', expect.objectContaining({
      conversationId: conversation.id,
      content: persistedUser.content,
    }));
    expect(optimisticState.multiModelParentId).toBe('user-1');

    useConversationStore.getState().cancelCurrentStream();
    await pending;
  });

  it('reparents a completed first response when it finishes before the user message persists', async () => {
    tauriAvailable = true;
    const listeners = new Map<string, (event: any) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: any) => void) => {
      listeners.set(eventName, handler);
      return () => {};
    });
    const conversation = {
      ...makeConversation('conv-1'),
      multi_model_display_mode_override: null,
    };
    const persistedUser = {
      ...makeMessage(1),
      id: 'user-persisted',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const sendMessage = deferred<typeof persistedUser>();
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'update_conversation') {
        return Promise.resolve({ ...conversation, ...(args.input as Record<string, unknown>) });
      }
      if (command === 'send_message') return sendMessage.promise;
      if (command === 'regenerate_with_model') return Promise.resolve(undefined);
      if (command === 'list_message_versions') return Promise.resolve([]);
      if (command === 'cancel_stream') return Promise.resolve(undefined);
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      messages: [],
    });

    const pending = useConversationStore.getState().sendMultiModelMessage({
      content: 'fast response',
      targetModels: [
        { providerId: 'provider-a', modelId: 'model-a' },
        { providerId: 'provider-b', modelId: 'model-b' },
      ],
    });
    await flushPromises();
    const optimisticParentId = useConversationStore.getState().multiModelParentId;
    const onChunk = listeners.get('chat-stream-chunk');
    onChunk?.({
      payload: {
        conversation_id: conversation.id,
        message_id: 'assistant-fast',
        model_id: 'model-a',
        provider_id: 'provider-a',
        chunk: { content: 'fast', thinking: null, tool_calls: null, done: false, usage: null },
      },
    });
    onChunk?.({
      payload: {
        conversation_id: conversation.id,
        message_id: 'assistant-fast',
        model_id: 'model-a',
        provider_id: 'provider-a',
        chunk: { content: null, thinking: null, tool_calls: null, done: true, is_final: true, usage: null },
      },
    });
    expect(useConversationStore.getState().messages.find((message) => message.id === 'assistant-fast'))
      .toMatchObject({ parent_message_id: optimisticParentId, status: 'complete' });

    sendMessage.resolve(persistedUser);
    await flushPromises();
    expect(useConversationStore.getState().messages.find((message) => message.id === 'assistant-fast'))
      .toMatchObject({ parent_message_id: optimisticParentId, status: 'complete' });

    useConversationStore.getState().cancelCurrentStream();
    await pending;
  });

  it('does not start companion models when the first request is cancelled before persistence', async () => {
    tauriAvailable = true;
    const conversation = {
      ...makeConversation('conv-1'),
      multi_model_display_mode_override: null,
    };
    const persistedUser = {
      ...makeMessage(1),
      id: 'user-persisted',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const sendMessage = deferred<typeof persistedUser>();
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'update_conversation') {
        return Promise.resolve({ ...conversation, ...(args.input as Record<string, unknown>) });
      }
      if (command === 'send_message') return sendMessage.promise;
      if (command === 'cancel_stream') return Promise.resolve(undefined);
      if (command === 'list_messages_page') return Promise.resolve(makePage([persistedUser], false));
      if (command === 'regenerate_with_model') return Promise.resolve(undefined);
      if (command === 'list_message_versions') return Promise.resolve([]);
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      messages: [],
    });

    const pending = useConversationStore.getState().sendMultiModelMessage({
      content: 'cancel me',
      targetModels: [
        { providerId: 'provider-a', modelId: 'model-a' },
        { providerId: 'provider-b', modelId: 'model-b' },
      ],
    });
    await flushPromises();
    useConversationStore.getState().cancelCurrentStream();
    sendMessage.resolve(persistedUser);
    await flushPromises();

    expect(invokeMock).not.toHaveBeenCalledWith('regenerate_with_model', expect.anything());
    expect(useConversationStore.getState()).toMatchObject({
      multiModelParentId: null,
      pendingCompanionModels: [],
    });
    await pending;
  });

  it('does not reuse an older user message when the first multi-model request fails', async () => {
    tauriAvailable = true;
    const conversation = {
      ...makeConversation('conv-1'),
      multi_model_display_mode_override: null,
    };
    const oldUser = {
      ...makeMessage(1),
      id: 'user-old',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'update_conversation') {
        return Promise.resolve({ ...conversation, ...(args.input as Record<string, unknown>) });
      }
      if (command === 'send_message') return Promise.reject(new Error('first request failed'));
      if (command === 'regenerate_with_model') return Promise.resolve(undefined);
      if (command === 'list_message_versions') return Promise.resolve([]);
      if (command === 'cancel_stream') return Promise.resolve(undefined);
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      messages: [oldUser],
    });

    const pending = useConversationStore.getState().sendMultiModelMessage({
      content: 'must not attach to old user',
      targetModels: [
        { providerId: 'provider-a', modelId: 'model-a' },
        { providerId: 'provider-b', modelId: 'model-b' },
      ],
    });
    await flushPromises();

    expect(invokeMock).not.toHaveBeenCalledWith('regenerate_with_model', expect.anything());
    useConversationStore.getState().cancelCurrentStream();
    await pending;
  });

  it('does not let a cancelled run finalizer clear the next multi-model request', async () => {
    tauriAvailable = true;
    const conversation = {
      ...makeConversation('conv-1'),
      multi_model_display_mode_override: null,
    };
    const firstUser = {
      ...makeMessage(1),
      id: 'user-first',
      role: 'user' as const,
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    };
    const nextUser = { ...firstUser, id: 'user-next', created_at: 2 };
    const nextSendMessage = deferred<typeof nextUser>();
    const restore = deferred<ReturnType<typeof makeConversation>>();
    let sendCount = 0;
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'update_conversation') {
        const input = args.input as Record<string, unknown>;
        if (input.provider_id === conversation.provider_id && input.model_id === conversation.model_id) {
          return restore.promise;
        }
        return Promise.resolve({ ...conversation, ...input });
      }
      if (command === 'send_message') {
        sendCount++;
        return sendCount === 1 ? Promise.resolve(firstUser) : nextSendMessage.promise;
      }
      if (command === 'regenerate_with_model') return Promise.resolve(undefined);
      if (command === 'list_message_versions') return Promise.resolve([]);
      if (command === 'list_messages_page') return Promise.resolve(makePage([firstUser], false));
      if (command === 'cancel_stream') return Promise.resolve(undefined);
      if (command === 'start_multi_model_run') {
        return Promise.resolve({
          conversationId: 'conv-1',
          revision: 1,
          activeRun: {
            runId: 'run-1',
            conversationId: 'conv-1',
            parentMessageId: 'user-1',
            mode: 'parallel',
            intervalSeconds: 3,
            phase: 'running',
            nextStartAt: null,
            targets: [],
          },
        });
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 0, activeRun: null });
      }
      if (command === 'stop_multi_model_run' || command === 'skip_multi_model_target') {
        return Promise.resolve({ conversationId: 'conv-1', revision: 2, activeRun: null });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      messages: [],
    });

    const firstPending = useConversationStore.getState().sendMultiModelMessage({
      content: 'first run',
      targetModels: [
        { providerId: 'provider-a', modelId: 'model-a' },
        { providerId: 'provider-b', modelId: 'model-b' },
      ],
    });
    await flushPromises();
    useConversationStore.getState().cancelCurrentStream();

    const nextPending = useConversationStore.getState().sendMultiModelMessage({
      content: 'next run',
      targetModels: [
        { providerId: 'provider-c', modelId: 'model-c' },
        { providerId: 'provider-d', modelId: 'model-d' },
      ],
    });
    await flushPromises();
    const nextOptimisticParentId = useConversationStore.getState().multiModelParentId;
    expect(nextOptimisticParentId).toBe('user-1');

    restore.resolve(conversation);
    await flushPromises();
    await flushPromises();
    expect(useConversationStore.getState().multiModelParentId).toBe(nextOptimisticParentId);

    nextSendMessage.resolve(nextUser);
    await flushPromises();
    useConversationStore.getState().cancelCurrentStream();
    await Promise.all([firstPending, nextPending]);
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
      multiModelContinuationMode: 'per_model',
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
      multiModelContinuationMode: 'per_model',
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
