import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => true,
}));

describe('openConversationPopout', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { setCurrentWindowLabel } = await import('../windowKind');
    setCurrentWindowLabel('main');
  });

  it('asks the desktop shell to open a compact conversation window', async () => {
    const { openConversationPopout } = await import('../conversationPopout');
    const { setCurrentWindowLabel } = await import('../windowKind');
    setCurrentWindowLabel('main');

    await openConversationPopout('conv-1');

    expect(invoke).toHaveBeenCalledWith('open_conversation_popout', { conversationId: 'conv-1' });
  });

  it('does not reopen the same conversation in an already-popped window', async () => {
    const { openConversationPopout } = await import('../conversationPopout');
    const { setCurrentWindowLabel } = await import('../windowKind');
    setCurrentWindowLabel('conversation-popout:conv-1');

    await openConversationPopout('conv-1');

    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports when the independent window has been shown', async () => {
    const { notifyConversationPopoutReady } = await import('../conversationPopout');
    await notifyConversationPopoutReady('conv-1');
    expect(invoke).toHaveBeenCalledWith('report_conversation_popout_ready', { conversationId: 'conv-1' });
  });
});