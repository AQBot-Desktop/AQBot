import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatChromeContext } from '@/lib/chatChrome';

const mocks = vi.hoisted(() => ({
  ensureConversationsLoaded: vi.fn().mockResolvedValue(undefined),
  ensureProvidersLoaded: vi.fn().mockResolvedValue(undefined),
  setActiveConversation: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/invoke', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useConversationStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ensureConversationsLoaded: mocks.ensureConversationsLoaded,
    setActiveConversation: mocks.setActiveConversation,
    conversations: [{ id: 'conv-1', title: 'Popout chat' }],
    archivedConversations: [],
    multiModelTargets: [{ providerId: 'p1', modelId: 'm1' }],
    pendingCompanionModels: [],
  }),
  useProviderStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ensureProvidersLoaded: mocks.ensureProvidersLoaded,
  }),
}));

vi.mock('../ChatView', () => ({
  ChatView: () => <div data-testid="popout-chat-view">chat</div>,
}));

describe('ConversationPopoutInner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the conversation and renders chat without app chrome', async () => {
    const { ConversationPopoutInner } = await import('../ConversationPopoutInner');
    render(
      <ChatChromeContext.Provider value={{ kind: 'popout' }}>
        <ConversationPopoutInner conversationId="conv-1" />
      </ChatChromeContext.Provider>,
    );

    expect(screen.getByTestId('conversation-popout')).toBeInTheDocument();
    expect(screen.getByTestId('popout-chat-view')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-sidebar-shell')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.ensureConversationsLoaded).toHaveBeenCalled();
      expect(mocks.ensureProvidersLoaded).toHaveBeenCalled();
      expect(mocks.setActiveConversation).toHaveBeenCalledWith('conv-1');
    });
  });
});