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
