import { useEffect } from 'react';
import { restoreCandidate } from '@/lib/conversationTabs';
import { useConversationStore } from '@/stores/conversationStore';
import { useConversationTabsStore } from '@/stores/conversationTabsStore';
import { useSettingsStore } from '@/stores/settingsStore';

export function useConversationTabsCoordinator(enabled = true) {
  const conversations = useConversationStore((state) => state.conversations);
  const conversationsMeta = useConversationStore((state) => state.conversationsMeta);
  const activeConversationId = useConversationStore((state) => state.activeConversationId);
  const setActiveConversation = useConversationStore((state) => state.setActiveConversation);
  const lastSelectedId = useSettingsStore((state) => state.settings.last_selected_conversation_id);
  const settingsLoading = useSettingsStore((state) => state.loading);

  useEffect(() => {
    if (!enabled || !activeConversationId) return;
    useConversationTabsStore.getState().remember(activeConversationId);
  }, [activeConversationId, enabled]);

  useEffect(() => {
    if (!enabled || conversationsMeta.status !== 'ready') return;
    const tabs = useConversationTabsStore.getState();
    tabs.reconcile(conversations);
    if (activeConversationId || tabs.hasAttemptedRestore || tabs.suppressAutoSelect || settingsLoading) {
      if (activeConversationId && !tabs.hasAttemptedRestore) {
        tabs.markRestoreAttempted();
      }
      return;
    }
    tabs.markRestoreAttempted();
    const candidate = restoreCandidate(lastSelectedId, conversations);
    if (candidate) setActiveConversation(candidate);
  }, [
    activeConversationId,
    conversations,
    conversationsMeta.status,
    lastSelectedId,
    setActiveConversation,
    settingsLoading,
    enabled,
  ]);

  useEffect(() => {
    if (!enabled || !activeConversationId) return;
    if (activeConversationId === lastSelectedId) return;
    let idleId: number | null = null;
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const timeoutId = window.setTimeout(() => {
      const persist = () => {
        void useSettingsStore.getState().saveSettings({
          last_selected_conversation_id: activeConversationId,
        });
      };
      if (typeof win.requestIdleCallback === 'function') {
        idleId = win.requestIdleCallback(persist, { timeout: 1000 });
      } else {
        persist();
      }
    }, 250);
    return () => {
      window.clearTimeout(timeoutId);
      if (idleId != null && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleId);
      }
    };
  }, [activeConversationId, enabled, lastSelectedId]);
}
