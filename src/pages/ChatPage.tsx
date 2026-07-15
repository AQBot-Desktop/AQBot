import { useEffect } from 'react';
import { Modal, theme } from 'antd';
import { useConversationStore, useProviderStore, useSettingsStore } from '@/stores';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { ChatView } from '@/components/chat/ChatView';
import { usePageSuspendCleanup } from '@/components/layout/PageLifecycle';

export function ChatPage() {
  const { token } = theme.useToken();
  const ensureConversationsLoaded = useConversationStore((s) => s.ensureConversationsLoaded);
  const ensureProvidersLoaded = useProviderStore((s) => s.ensureProvidersLoaded);
  const chatSidebarCollapsed = useSettingsStore((s) => s.settings.chat_sidebar_collapsed ?? false);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  usePageSuspendCleanup(() => Modal.destroyAll());

  useEffect(() => {
    void ensureConversationsLoaded();
    void ensureProvidersLoaded();
  }, [ensureConversationsLoaded, ensureProvidersLoaded]);

  useEffect(() => {
    const handleToggleChatSidebar = () => {
      const current = useSettingsStore.getState().settings.chat_sidebar_collapsed ?? false;
      void saveSettings({ chat_sidebar_collapsed: !current });
    };

    window.addEventListener('aqbot:toggle-chat-sidebar', handleToggleChatSidebar);
    return () => {
      window.removeEventListener('aqbot:toggle-chat-sidebar', handleToggleChatSidebar);
    };
  }, [saveSettings]);

  return (
    <div
      className="flex h-full"
      style={{ overflow: 'hidden', contain: 'layout paint style' }}
    >
      <div
        className="h-full shrink-0"
        data-testid="chat-sidebar-shell"
        aria-hidden={chatSidebarCollapsed}
        style={{
          width: chatSidebarCollapsed ? 0 : 256,
          borderRight: chatSidebarCollapsed ? '0 solid transparent' : '1px solid var(--border-color)',
          backgroundColor: token.colorBgContainer,
          overflow: 'hidden',
          transition: 'width 0.24s cubic-bezier(0.2, 0, 0, 1), border-color 0.24s cubic-bezier(0.2, 0, 0, 1)',
          willChange: 'width',
          contain: 'layout paint',
        }}
      >
        <div
          data-testid="chat-sidebar-content"
          style={{
            width: 256,
            height: '100%',
            opacity: chatSidebarCollapsed ? 0 : 1,
            visibility: chatSidebarCollapsed ? 'hidden' : 'visible',
            pointerEvents: chatSidebarCollapsed ? 'none' : 'auto',
            transition: 'opacity 0.12s ease',
          }}
        >
          <ChatSidebar />
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          backgroundColor: token.colorBgElevated,
        }}
      >
        <ChatView />
      </div>
    </div>
  );
}
