import { create } from 'zustand';
import {
  EMPTY_CONVERSATION_TABS,
  closeTabs,
  reconcileTabs,
  rememberOpen,
  type ConversationTabsState,
  type TabConversation,
} from '@/lib/conversationTabs';

type ConversationTabsStore = ConversationTabsState & {
  hasAttemptedRestore: boolean;
  remember: (id: string | null | undefined) => void;
  closeIds: (
    ids: string[],
    conversations: TabConversation[],
    activeId: string | null,
  ) => string | null;
  reconcile: (conversations: TabConversation[]) => void;
  markRestoreAttempted: () => void;
};

export const useConversationTabsStore = create<ConversationTabsStore>((set, get) => ({
  ...EMPTY_CONVERSATION_TABS,
  hasAttemptedRestore: false,
  remember: (id) => set(rememberOpen(get(), id)),
  closeIds: (ids, conversations, activeId) => {
    const result = closeTabs(get(), conversations, ids, activeId);
    set(result.state);
    return result.nextActiveId;
  },
  reconcile: (conversations) => set(reconcileTabs(get(), conversations)),
  markRestoreAttempted: () => set({ hasAttemptedRestore: true }),
}));
