import { useEffect } from 'react';
import { theme } from 'antd';
import { useConversationStore, useProviderStore } from '@/stores';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { ChatView } from '@/components/chat/ChatView';

export function ChatPage() {
  const { token } = theme.useToken();
  const fetchConversations = useConversationStore((s) => s.fetchConversations);
  const conversationCount = useConversationStore((s) => s.conversations.length);
  const startStreamListening = useConversationStore((s) => s.startStreamListening);
  const stopStreamListening = useConversationStore((s) => s.stopStreamListening);
  const fetchProviders = useProviderStore((s) => s.fetchProviders);
  const providerCount = useProviderStore((s) => s.providers.length);

  useEffect(() => {
    if (conversationCount === 0) {
      fetchConversations();
    }
    if (providerCount === 0) {
      fetchProviders();
    }
    startStreamListening();
    return () => stopStreamListening();
  }, [conversationCount, fetchConversations, fetchProviders, providerCount, startStreamListening, stopStreamListening]);

  return (
    <div className="flex h-full" style={{ overflow: 'hidden' }}>
      <div
        className="w-64 h-full"
        style={{
          borderRight: '1px solid var(--border-color)',
          backgroundColor: token.colorBgContainer,
        }}
      >
        <ChatSidebar />
      </div>
      <div
        style={{
          flex: 1,
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
