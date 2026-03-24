import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ChatPage } from '../ChatPage';

const fetchConversations = vi.fn();
const startStreamListening = vi.fn();
const stopStreamListening = vi.fn();
const fetchProviders = vi.fn();

const conversationState = {
  conversations: [] as Array<{ id: string }>,
  fetchConversations,
  startStreamListening,
  stopStreamListening,
};

const providerState = {
  providers: [] as Array<{ id: string }>,
  fetchProviders,
};

vi.mock('antd', () => ({
  theme: {
    useToken: () => ({
      token: {
        colorBgContainer: '#111',
        colorBgElevated: '#222',
      },
    }),
  },
}));

vi.mock('@/stores', () => ({
  useConversationStore: (selector: (state: typeof conversationState) => unknown) => selector(conversationState),
  useProviderStore: (selector: (state: typeof providerState) => unknown) => selector(providerState),
}));

vi.mock('@/components/chat/ChatSidebar', () => ({
  ChatSidebar: () => <div>sidebar</div>,
}));

vi.mock('@/components/chat/ChatView', () => ({
  ChatView: () => <div>chat-view</div>,
}));

describe('ChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationState.conversations = [];
    providerState.providers = [];
  });

  it('fetches conversations and providers only when the stores are empty', () => {
    const { unmount } = render(<ChatPage />);

    expect(fetchConversations).toHaveBeenCalledTimes(1);
    expect(fetchProviders).toHaveBeenCalledTimes(1);
    expect(startStreamListening).toHaveBeenCalledTimes(1);

    unmount();

    expect(stopStreamListening).toHaveBeenCalledTimes(1);
  });

  it('skips refetching when conversations and providers are already loaded', () => {
    conversationState.conversations = [{ id: 'conv-1' }];
    providerState.providers = [{ id: 'provider-1' }];

    render(<ChatPage />);

    expect(fetchConversations).not.toHaveBeenCalled();
    expect(fetchProviders).not.toHaveBeenCalled();
    expect(startStreamListening).toHaveBeenCalledTimes(1);
  });
});
