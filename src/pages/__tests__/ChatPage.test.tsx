import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatPage } from '../ChatPage';

const ensureConversationsLoaded = vi.fn();
const ensureProvidersLoaded = vi.fn();
const saveSettings = vi.fn();

const conversationState = {
  conversations: [] as Array<{ id: string }>,
  ensureConversationsLoaded,
};

const providerState = {
  providers: [] as Array<{ id: string }>,
  ensureProvidersLoaded,
};

const settingsState = {
  settings: {
    chat_sidebar_collapsed: false,
  },
  saveSettings,
};
const chatSidebarProps: Array<Record<string, unknown>> = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'chat.expandSidebar': '展开左侧对话栏',
      'chat.collapseSidebar': '折叠左侧对话栏',
    }[key] ?? key),
  }),
}));

vi.mock('antd', () => ({
  Button: ({ icon, onClick, 'aria-label': ariaLabel }: any) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {icon}
    </button>
  ),
  Tooltip: ({ children }: any) => <>{children}</>,
  Modal: { destroyAll: vi.fn() },
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
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('@/components/chat/ChatSidebar', () => ({
  ChatSidebar: (props: Record<string, unknown>) => {
    chatSidebarProps.push(props);
    return <div>sidebar</div>;
  },
}));

vi.mock('@/components/chat/ChatView', () => ({
  ChatView: () => <div>chat-view</div>,
}));

describe('ChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationState.conversations = [];
    providerState.providers = [];
    settingsState.settings.chat_sidebar_collapsed = false;
    chatSidebarProps.length = 0;
  });

  it('ensures conversations and providers are loaded on entry', () => {
    render(<ChatPage />);

    expect(ensureConversationsLoaded).toHaveBeenCalledTimes(1);
    expect(ensureProvidersLoaded).toHaveBeenCalledTimes(1);
  });

  it('delegates freshness decisions to resource metadata instead of array length', () => {
    conversationState.conversations = [{ id: 'conv-1' }];
    providerState.providers = [{ id: 'provider-1' }];

    render(<ChatPage />);

    expect(ensureConversationsLoaded).toHaveBeenCalledTimes(1);
    expect(ensureProvidersLoaded).toHaveBeenCalledTimes(1);
  });

  it('renders the full chat sidebar by default without passing a page-level collapse callback', () => {
    render(<ChatPage />);

    expect(screen.getByText('sidebar')).toBeInTheDocument();
    expect(chatSidebarProps[chatSidebarProps.length - 1]?.onCollapse).toBeUndefined();
  });

  it('keeps the chat sidebar mounted inside a hidden zero-width shell when collapsed', () => {
    settingsState.settings.chat_sidebar_collapsed = true;

    render(<ChatPage />);

    expect(screen.getByText('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('chat-sidebar-shell')).toHaveStyle({
      width: '0px',
      overflow: 'hidden',
    });
    expect(screen.getByTestId('chat-sidebar-content')).toHaveStyle({
      opacity: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
    });
    expect(screen.queryByRole('button', { name: '展开左侧对话栏' })).not.toBeInTheDocument();
  });
});
