export type TabConversation = {
  id: string;
  is_archived?: boolean;
  is_pinned?: boolean;
  tab_pin_order: number | null;
  updated_at?: number;
};

export type ConversationTabsState = {
  openIds: string[];
  /** Closed ids hidden until pin/archive/delete state catches up. */
  dismissedIds: string[];
  suppressAutoSelect: boolean;
};

export const EMPTY_CONVERSATION_TABS: ConversationTabsState = {
  openIds: [],
  dismissedIds: [],
  suppressAutoSelect: false,
};

function isLive(conversation: TabConversation): boolean {
  return conversation.is_archived !== true;
}

function conversationById(conversations: TabConversation[]): Map<string, TabConversation> {
  return new Map(conversations.map((conversation) => [conversation.id, conversation]));
}

export function rememberOpen(
  state: ConversationTabsState,
  id: string | null | undefined,
): ConversationTabsState {
  if (!id) return state;
  const openIds = state.openIds.includes(id) ? state.openIds : [...state.openIds, id];
  return {
    openIds,
    dismissedIds: state.dismissedIds.filter((item) => item !== id),
    suppressAutoSelect: false,
  };
}

export function listVisibleTabIds(
  state: ConversationTabsState,
  conversations: TabConversation[],
  hiddenIds: Iterable<string> = [],
): string[] {
  const hidden = new Set([...state.dismissedIds, ...hiddenIds]);
  const byId = conversationById(conversations);
  const pinned = conversations
    .filter((conversation) => (
      isLive(conversation)
      && conversation.tab_pin_order != null
      && !hidden.has(conversation.id)
    ))
    .sort((left, right) => {
      const order = (left.tab_pin_order ?? 0) - (right.tab_pin_order ?? 0);
      return order !== 0 ? order : left.id.localeCompare(right.id);
    })
    .map((conversation) => conversation.id);
  const pinnedSet = new Set(pinned);
  const opened = state.openIds.filter((id) => {
    if (hidden.has(id) || pinnedSet.has(id)) return false;
    const conversation = byId.get(id);
    return conversation != null && isLive(conversation);
  });
  return [...pinned, ...opened];
}

export function adjacentTabId(visibleIds: string[], closedId: string): string | null {
  const index = visibleIds.indexOf(closedId);
  if (index < 0) return visibleIds[0] ?? null;
  return visibleIds[index + 1] ?? visibleIds[index - 1] ?? null;
}

export function nextActiveAfterRemoving(
  visibleIds: string[],
  removedIds: Iterable<string>,
  activeId: string | null,
): string | null {
  const removed = new Set(removedIds);
  if (activeId && !removed.has(activeId) && visibleIds.includes(activeId)) {
    return activeId;
  }
  if (!activeId || !removed.has(activeId)) {
    return visibleIds.find((id) => !removed.has(id)) ?? null;
  }
  const index = visibleIds.indexOf(activeId);
  const after = visibleIds.slice(index + 1).find((id) => !removed.has(id));
  if (after) return after;
  return [...visibleIds.slice(0, Math.max(index, 0))].reverse().find((id) => !removed.has(id)) ?? null;
}

export function closeTabs(
  state: ConversationTabsState,
  conversations: TabConversation[],
  closedIds: string[],
  activeId: string | null,
): { state: ConversationTabsState; nextActiveId: string | null } {
  if (closedIds.length === 0) {
    return { state, nextActiveId: activeId };
  }
  const closed = new Set(closedIds);
  const visibleBeforeClose = listVisibleTabIds(state, conversations);
  const openIds = state.openIds.filter((id) => !closed.has(id));
  const dismissedIds = [...state.dismissedIds];
  for (const id of closedIds) {
    if (!dismissedIds.includes(id)) dismissedIds.push(id);
  }
  const remaining = listVisibleTabIds({ ...state, openIds, dismissedIds }, conversations);
  return {
    state: {
      openIds,
      dismissedIds,
      suppressAutoSelect: remaining.length === 0 ? true : state.suppressAutoSelect,
    },
    nextActiveId: nextActiveAfterRemoving(visibleBeforeClose, closedIds, activeId),
  };
}

export function closeTab(
  state: ConversationTabsState,
  conversations: TabConversation[],
  closedId: string,
  activeId: string | null,
): { state: ConversationTabsState; nextActiveId: string | null } {
  return closeTabs(state, conversations, [closedId], activeId);
}

export function reconcileTabs(
  state: ConversationTabsState,
  conversations: TabConversation[],
): ConversationTabsState {
  const byId = conversationById(conversations);
  return {
    ...state,
    openIds: state.openIds.filter((id) => {
      const conversation = byId.get(id);
      return conversation != null && isLive(conversation);
    }),
    dismissedIds: state.dismissedIds.filter((id) => {
      const conversation = byId.get(id);
      return conversation != null && isLive(conversation) && conversation.tab_pin_order != null;
    }),
  };
}

export function restoreCandidate(
  lastSelectedId: string | null | undefined,
  conversations: TabConversation[],
): string | null {
  const live = conversations.filter(isLive);
  if (lastSelectedId && live.some((conversation) => conversation.id === lastSelectedId)) {
    return lastSelectedId;
  }
  const sorted = [...live].sort((left, right) => {
    if (Boolean(left.is_pinned) !== Boolean(right.is_pinned)) {
      return left.is_pinned ? -1 : 1;
    }
    return (right.updated_at ?? 0) - (left.updated_at ?? 0);
  });
  return sorted[0]?.id ?? null;
}

export type CloseTabsScope = 'others' | 'otherUnpinned' | 'left' | 'right';

export function tabIdsToClose(
  visibleIds: string[],
  targetId: string,
  conversations: TabConversation[],
  scope: CloseTabsScope,
): string[] {
  const index = visibleIds.indexOf(targetId);
  if (index < 0) return [];
  const byId = conversationById(conversations);
  switch (scope) {
    case 'others':
      return visibleIds.filter((id) => id !== targetId);
    case 'otherUnpinned':
      return visibleIds.filter((id) => id !== targetId && byId.get(id)?.tab_pin_order == null);
    case 'left':
      return visibleIds.slice(0, index);
    case 'right':
      return visibleIds.slice(index + 1);
  }
}

export function classifyOverflowTabs(args: {
  containerWidth: number;
  scrollLeft: number;
  tabs: Array<{ id: string; offsetLeft: number; width: number }>;
}): { leftIds: string[]; rightIds: string[] } {
  const viewStart = args.scrollLeft;
  const viewEnd = args.scrollLeft + args.containerWidth;
  const leftIds: string[] = [];
  const rightIds: string[] = [];
  const epsilon = 1;
  for (const tab of args.tabs) {
    const start = tab.offsetLeft;
    const end = tab.offsetLeft + tab.width;
    if (end <= viewStart + epsilon || start < viewStart - epsilon) {
      leftIds.push(tab.id);
    } else if (start >= viewEnd - epsilon || end > viewEnd + epsilon) {
      rightIds.push(tab.id);
    }
  }
  return { leftIds, rightIds };
}

export function computeCenteredScrollLeft(args: {
  containerWidth: number;
  scrollWidth: number;
  tabOffsetLeft: number;
  tabWidth: number;
}): number {
  const { containerWidth, scrollWidth, tabOffsetLeft, tabWidth } = args;
  const max = Math.max(0, scrollWidth - containerWidth);
  const target = tabOffsetLeft + tabWidth / 2 - containerWidth / 2;
  return Math.min(max, Math.max(0, target));
}
