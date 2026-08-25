import { describe, expect, it } from 'vitest';
import {
  adjacentTabId,
  classifyOverflowTabs,
  closeTab,
  closeTabs,
  computeCenteredScrollLeft,
  EMPTY_CONVERSATION_TABS,
  listVisibleTabIds,
  reconcileTabs,
  rememberOpen,
  restoreCandidate,
  tabIdsToClose,
  type TabConversation,
} from '../conversationTabs';

function conv(
  id: string,
  overrides: Partial<TabConversation> = {},
): TabConversation {
  return {
    id,
    is_archived: false,
    is_pinned: false,
    tab_pin_order: null,
    updated_at: 1,
    ...overrides,
  };
}

describe('conversationTabs', () => {
  it('remembers opened conversations in first-open order and ignores duplicates', () => {
    let state = rememberOpen(EMPTY_CONVERSATION_TABS, 'a');
    state = rememberOpen(state, 'b');
    state = rememberOpen(state, 'a');

    expect(state.openIds).toEqual(['a', 'b']);
    expect(state.suppressAutoSelect).toBe(false);
  });

  it('lists pinned tabs first by pin order, then session-open unpinned tabs', () => {
    const state = rememberOpen(rememberOpen(EMPTY_CONVERSATION_TABS, 'open-1'), 'open-2');
    const conversations = [
      conv('open-2', { updated_at: 9 }),
      conv('pinned-b', { tab_pin_order: 2 }),
      conv('open-1'),
      conv('pinned-a', { tab_pin_order: 1 }),
      conv('untouched'),
    ];

    expect(listVisibleTabIds(state, conversations)).toEqual([
      'pinned-a',
      'pinned-b',
      'open-1',
      'open-2',
    ]);
  });

  it('does not show a pinned conversation twice when it was also opened this session', () => {
    const state = rememberOpen(EMPTY_CONVERSATION_TABS, 'pinned-a');
    const conversations = [
      conv('pinned-a', { tab_pin_order: 1 }),
      conv('open-b'),
    ];

    expect(listVisibleTabIds(state, conversations)).toEqual(['pinned-a']);
  });

  it('keeps the current conversation when a non-active tab is closed', () => {
    const state = ['a', 'b', 'c'].reduce(
      (next, id) => rememberOpen(next, id),
      EMPTY_CONVERSATION_TABS,
    );
    const conversations = [conv('a'), conv('b'), conv('c')];
    const closed = closeTab(state, conversations, 'b', 'c');

    expect(closed.state.openIds).toEqual(['a', 'c']);
    expect(closed.nextActiveId).toBe('c');
    expect(closed.state.suppressAutoSelect).toBe(false);
  });

  it('selects the right neighbor, then the left neighbor, when the active tab is closed', () => {
    const conversations = [conv('a'), conv('b'), conv('c')];
    const state = ['a', 'b', 'c'].reduce(
      (next, id) => rememberOpen(next, id),
      EMPTY_CONVERSATION_TABS,
    );

    const closedMiddle = closeTab(state, conversations, 'b', 'b');
    expect(closedMiddle.nextActiveId).toBe('c');

    const closedLast = closeTab(closedMiddle.state, conversations, 'c', 'c');
    expect(closedLast.nextActiveId).toBe('a');
  });

  it('selects the next surviving neighbor when the active tab and its right neighbor are removed together', () => {
    const state = ['a', 'b', 'c', 'd'].reduce(
      (next, id) => rememberOpen(next, id),
      EMPTY_CONVERSATION_TABS,
    );
    const conversations = [conv('a'), conv('b'), conv('c'), conv('d')];
    const closed = closeTabs(state, conversations, ['b', 'c'], 'b');
    expect(closed.nextActiveId).toBe('d');
    expect(closed.state.openIds).toEqual(['a', 'd']);
  });

  it('clears the active conversation and suppresses auto-select after the last tab is closed', () => {
    const state = rememberOpen(EMPTY_CONVERSATION_TABS, 'only');
    const closed = closeTab(state, [conv('only')], 'only', 'only');

    expect(closed.state.openIds).toEqual([]);
    expect(closed.nextActiveId).toBeNull();
    expect(closed.state.suppressAutoSelect).toBe(true);
  });

  it('treats a closed pinned tab as gone even before the pin column is cleared', () => {
    const conversations = [
      conv('pinned', { tab_pin_order: 1 }),
      conv('open', { tab_pin_order: null }),
    ];
    const state = rememberOpen(EMPTY_CONVERSATION_TABS, 'open');
    const closed = closeTab(state, conversations, 'pinned', 'pinned');

    expect(listVisibleTabIds(closed.state, conversations)).toEqual(['open']);
    expect(closed.nextActiveId).toBe('open');
  });

  it('drops deleted and archived ids during reconcile', () => {
    const state = ['keep', 'deleted', 'archived'].reduce(
      (next, id) => rememberOpen(next, id),
      EMPTY_CONVERSATION_TABS,
    );
    const reconciled = reconcileTabs(state, [
      conv('keep'),
      conv('archived', { is_archived: true }),
    ]);

    expect(reconciled.openIds).toEqual(['keep']);
    expect(listVisibleTabIds(reconciled, [
      conv('keep'),
      conv('archived', { is_archived: true }),
      conv('pinned', { tab_pin_order: 1, is_archived: true }),
    ])).toEqual(['keep']);
  });

  it('restores only pinned tabs after a restart with empty session state', () => {
    const conversations = [
      conv('pinned', { tab_pin_order: 3 }),
      conv('recent-unpinned'),
    ];

    expect(listVisibleTabIds(EMPTY_CONVERSATION_TABS, conversations)).toEqual(['pinned']);
  });

  it('restores the last selected live conversation, then falls back to the first live row', () => {
    const conversations = [
      conv('older', { is_pinned: false, updated_at: 1 }),
      conv('newer', { is_pinned: true, updated_at: 2 }),
      conv('archived', { is_archived: true, updated_at: 9 }),
    ];

    expect(restoreCandidate('older', conversations)).toBe('older');
    expect(restoreCandidate('archived', conversations)).toBe('newer');
    expect(restoreCandidate(null, conversations)).toBe('newer');
    expect(restoreCandidate('missing', [])).toBeNull();
  });

  it('selects close-others, unpinned-others, left, and right targets from the visible order', () => {
    const visibleIds = ['pinned', 'a', 'b', 'c'];
    const conversations = [
      conv('pinned', { tab_pin_order: 1 }),
      conv('a'),
      conv('b'),
      conv('c'),
    ];

    expect(tabIdsToClose(visibleIds, 'b', conversations, 'others')).toEqual(['pinned', 'a', 'c']);
    expect(tabIdsToClose(visibleIds, 'b', conversations, 'otherUnpinned')).toEqual(['a', 'c']);
    expect(tabIdsToClose(visibleIds, 'b', conversations, 'left')).toEqual(['pinned', 'a']);
    expect(tabIdsToClose(visibleIds, 'b', conversations, 'right')).toEqual(['c']);
    expect(tabIdsToClose(visibleIds, 'pinned', conversations, 'left')).toEqual([]);
    expect(tabIdsToClose(['only'], 'only', [conv('only')], 'others')).toEqual([]);
  });

  it('classifies clipped tabs to the left and right overflow groups', () => {
    expect(classifyOverflowTabs({
      containerWidth: 100,
      scrollLeft: 80,
      tabs: [
        { id: 'a', offsetLeft: 0, width: 40 },
        { id: 'b', offsetLeft: 40, width: 40 },
        { id: 'c', offsetLeft: 80, width: 40 },
        { id: 'd', offsetLeft: 180, width: 40 },
        { id: 'e', offsetLeft: 220, width: 40 },
      ],
    })).toEqual({
      leftIds: ['a', 'b'],
      rightIds: ['d', 'e'],
    });
  });

  it('computes overflow-safe centered scroll offsets', () => {
    expect(adjacentTabId(['a', 'b', 'c'], 'b')).toBe('c');
    expect(adjacentTabId(['a', 'b', 'c'], 'c')).toBe('b');
    expect(adjacentTabId(['only'], 'only')).toBeNull();

    expect(computeCenteredScrollLeft({
      containerWidth: 100,
      scrollWidth: 400,
      tabOffsetLeft: 180,
      tabWidth: 40,
    })).toBe(150);
    expect(computeCenteredScrollLeft({
      containerWidth: 100,
      scrollWidth: 120,
      tabOffsetLeft: 0,
      tabWidth: 40,
    })).toBe(0);
    expect(computeCenteredScrollLeft({
      containerWidth: 100,
      scrollWidth: 140,
      tabOffsetLeft: 100,
      tabWidth: 40,
    })).toBe(40);
  });
});
