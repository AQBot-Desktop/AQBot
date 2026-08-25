import { useEffect } from 'react';
import { Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@/lib/invoke';
import { useConversationStore, useProviderStore } from '@/stores';
import { ChatView } from './ChatView';

export function ConversationPopoutInner({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const ensureConversationsLoaded = useConversationStore((state) => state.ensureConversationsLoaded);
  const setActiveConversation = useConversationStore((state) => state.setActiveConversation);
  const ensureProvidersLoaded = useProviderStore((state) => state.ensureProvidersLoaded);
  const conversations = useConversationStore((state) => state.conversations);
  const archivedConversations = useConversationStore((state) => state.archivedConversations);
  const multiModelTargets = useConversationStore((state) => state.multiModelTargets);
  const pendingCompanionModels = useConversationStore((state) => state.pendingCompanionModels);
  const conversationTitle = conversations.find((conversation) => conversation.id === conversationId)?.title
    ?? archivedConversations.find((conversation) => conversation.id === conversationId)?.title;
  const isMultiModel = (pendingCompanionModels.length > 0 ? pendingCompanionModels : multiModelTargets).length > 0;
  const title = isMultiModel ? t('chat.multiModel.popoutWindowTitle') : conversationTitle;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([ensureConversationsLoaded(), ensureProvidersLoaded()]);
      if (!cancelled) setActiveConversation(conversationId);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, ensureConversationsLoaded, ensureProvidersLoaded, setActiveConversation]);

  useEffect(() => {
    if (!title || !isTauri()) return;
    void import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
      void getCurrentWebviewWindow().setTitle(title);
    });
  }, [title]);

  return (
    <div
      data-testid="conversation-popout"
      className="flex h-full min-h-0 flex-col"
      style={{ backgroundColor: token.colorBgElevated }}
    >
      {conversationTitle || conversationId ? (
        <ChatView />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Typography.Text type="secondary">{t('chat.multiModel.popoutMissingConversation')}</Typography.Text>
        </div>
      )}
    </div>
  );
}