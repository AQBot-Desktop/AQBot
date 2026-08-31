import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: listenMock,
  isTauri: () => false,
}));

describe('conversationStore cross-window sync', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    listenMock.mockResolvedValue(() => {});
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [],
      loading: false,
      streaming: false,
    });
  });

  it('reloads the active conversation when another window mutates it', async () => {
    invokeMock.mockResolvedValue({
      messages: [],
      has_older: false,
      oldest_message_id: null,
      total_active_count: 0,
    });
    const { useConversationStore } = await import('../conversationStore');

    await useConversationStore.getState().applyRemoteConversationSync({
      originWindow: 'conversation-popout:conv-1',
      conversationId: 'conv-1',
      kind: 'messages-changed',
    });

    expect(invokeMock).toHaveBeenCalledWith(
      'list_messages_page',
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
  });

  it('applies another window stream snapshot without claiming stream ownership', async () => {
    invokeMock.mockResolvedValue({
      messages: [],
      has_older: false,
      oldest_message_id: null,
      total_active_count: 0,
    });
    const { useConversationStore } = await import('../conversationStore');

    await useConversationStore.getState().applyRemoteConversationSync({
      originWindow: 'conversation-popout:conv-1',
      conversationId: 'conv-1',
      kind: 'messages-changed',
      stream: {
        streaming: true,
        streamId: 'stream-a',
        streamingMessageId: 'assistant-a',
        multiModelParentId: 'user-1',
        pendingCompanionModels: [{ providerId: 'p2', modelId: 'm2' }],
        multiModelDoneMessageIds: [],
      },
    });

    expect(useConversationStore.getState().streaming).toBe(false);
    expect(useConversationStore.getState().observedStream).toEqual({
      conversationId: 'conv-1',
      streaming: true,
      streamId: 'stream-a',
      streamingMessageId: 'assistant-a',
      multiModelParentId: 'user-1',
      pendingCompanionModels: [{ providerId: 'p2', modelId: 'm2' }],
      multiModelDoneMessageIds: [],
    });
  });

  it('clears the observed stream when the other window finishes without a stream id', async () => {
    invokeMock.mockResolvedValue({
      messages: [],
      has_older: false,
      oldest_message_id: null,
      total_active_count: 0,
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      observedStream: {
        conversationId: 'conv-1',
        streaming: true,
        streamId: 'stream-a',
        streamingMessageId: 'assistant-a',
        multiModelParentId: 'user-1',
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
    });

    await useConversationStore.getState().applyRemoteConversationSync({
      originWindow: 'conversation-popout:conv-1',
      conversationId: 'conv-1',
      kind: 'messages-changed',
      stream: {
        streaming: false,
        streamId: null,
        streamingMessageId: null,
        multiModelParentId: null,
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
    });

    expect(useConversationStore.getState().observedStream).toBeNull();
  });

  it('applies the model order selected in another window', async () => {
    invokeMock.mockResolvedValue({
      messages: [],
      has_older: false,
      oldest_message_id: null,
      total_active_count: 0,
    });
    const [{ useConversationStore }, { setCurrentWindowLabel }] = await Promise.all([
      import('../conversationStore'),
      import('@/lib/windowKind'),
    ]);
    const selectedModels = [
      { providerId: 'provider-b', modelId: 'model-b' },
      { providerId: 'provider-a', modelId: 'model-a' },
    ];
    setCurrentWindowLabel('conversation-popout:conv-1');
    try {
      await useConversationStore.getState().applyRemoteConversationSync({
        originWindow: 'main',
        conversationId: 'conv-1',
        kind: 'conversation-meta',
        multiModelTargets: selectedModels,
      });

      expect(useConversationStore.getState().multiModelTargets).toEqual(selectedModels);
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      setCurrentWindowLabel('main');
    }
  });

  it('ignores sync events that originated in this window', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { getCurrentWindowLabel } = await import('@/lib/windowKind');

    await useConversationStore.getState().applyRemoteConversationSync({
      originWindow: getCurrentWindowLabel(),
      conversationId: 'conv-1',
      kind: 'messages-changed',
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
