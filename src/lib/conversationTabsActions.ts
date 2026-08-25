import { useConversationStore } from '@/stores/conversationStore';
import { useConversationTabsStore } from '@/stores/conversationTabsStore';

export async function closeConversationTabs(ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return;
  const conversationState = useConversationStore.getState();
  for (const id of uniqueIds) {
    const conversation = conversationState.conversations.find((item) => item.id === id);
    if (conversation?.tab_pin_order != null) {
      await useConversationStore.getState().setConversationTabPinned(id, false);
    }
  }
  const latest = useConversationStore.getState();
  const nextActiveId = useConversationTabsStore.getState().closeIds(
    uniqueIds,
    latest.conversations,
    latest.activeConversationId,
  );
  if (latest.activeConversationId !== nextActiveId) {
    latest.setActiveConversation(nextActiveId);
  }
}

export async function closeConversationTab(id: string): Promise<void> {
  await closeConversationTabs([id]);
}

export async function closeActiveConversationTab(): Promise<void> {
  const activeId = useConversationStore.getState().activeConversationId;
  if (!activeId) return;
  await closeConversationTab(activeId);
}

export function applyRemovedConversationIds(ids: string[]): string | null {
  if (ids.length === 0) return useConversationStore.getState().activeConversationId;
  const current = useConversationStore.getState();
  return useConversationTabsStore.getState().closeIds(
    ids,
    current.conversations,
    current.activeConversationId,
  );
}
