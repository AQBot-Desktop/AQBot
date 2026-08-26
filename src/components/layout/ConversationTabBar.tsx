import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { App, Badge, Dropdown, Tooltip, theme } from 'antd';
import type { MenuProps } from 'antd';
import { ChevronLeft, ChevronRight, Pin, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConversationIcon } from '@/components/chat/ConversationIcon';
import { closeConversationTab, closeConversationTabs } from '@/lib/conversationTabsActions';
import {
  classifyOverflowTabs,
  computeCenteredScrollLeft,
  listVisibleTabIds,
  tabIdsToClose,
  type CloseTabsScope,
} from '@/lib/conversationTabs';
import { formatShortcutForDisplay, getShortcutBinding } from '@/lib/shortcuts';
import { useConversationStore } from '@/stores/conversationStore';
import { useConversationTabsStore } from '@/stores/conversationTabsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Conversation } from '@/types';

function tabOffsetInScroller(scroller: HTMLElement, tab: HTMLElement) {
  const scrollerRect = scroller.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  return tabRect.left - scrollerRect.left + scroller.scrollLeft;
}

function measureOverflow(element: HTMLDivElement) {
  const tabs = [...element.querySelectorAll<HTMLElement>('[data-conversation-tab]')];
  return classifyOverflowTabs({
    containerWidth: element.clientWidth,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
    tabs: tabs.map((tab) => ({
      id: tab.dataset.conversationTab ?? '',
      offsetLeft: tabOffsetInScroller(element, tab),
      width: tab.getBoundingClientRect().width || tab.offsetWidth,
    })).filter((tab) => tab.id),
  });
}

export function ConversationTabBar() {
  const { t, i18n } = useTranslation();
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const direction = typeof i18n.dir === 'function' ? i18n.dir() : 'ltr';
  const conversations = useConversationStore((state) => state.conversations);
  const activeConversationId = useConversationStore((state) => state.activeConversationId);
  const setActiveConversation = useConversationStore((state) => state.setActiveConversation);
  const setConversationTabPinned = useConversationStore((state) => state.setConversationTabPinned);
  const streamingConversationId = useConversationStore((state) => state.streamingConversationId);
  const openIds = useConversationTabsStore((state) => state.openIds);
  const dismissedIds = useConversationTabsStore((state) => state.dismissedIds);
  const settings = useSettingsStore((state) => state.settings);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<{ leftIds: string[]; rightIds: string[] }>({
    leftIds: [],
    rightIds: [],
  });
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const tabs = useMemo(() => {
    const visibleIds = listVisibleTabIds({
      openIds,
      dismissedIds,
      suppressAutoSelect: false,
    }, conversations);
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    return visibleIds
      .map((id) => byId.get(id))
      .filter((conversation): conversation is Conversation => conversation != null);
  }, [conversations, dismissedIds, openIds]);
  const tabsById = useMemo(
    () => new Map(tabs.map((conversation) => [conversation.id, conversation])),
    [tabs],
  );
  const visibleIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const refreshOverflow = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) {
      setOverflow({ leftIds: [], rightIds: [] });
      return;
    }
    setOverflow(measureOverflow(element));
  }, []);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(refreshOverflow);
    observer.observe(element);
    refreshOverflow();
    return () => observer.disconnect();
  }, [refreshOverflow, tabs]);

  useEffect(() => {
    const container = scrollerRef.current;
    const active = container?.querySelector<HTMLElement>(`[data-conversation-tab="${activeConversationId ?? ''}"]`);
    if (!container || !active) return;
    container.scrollLeft = computeCenteredScrollLeft({
      containerWidth: container.clientWidth,
      scrollWidth: container.scrollWidth,
      tabOffsetLeft: active.offsetLeft,
      tabWidth: active.offsetWidth,
    });
    refreshOverflow();
  }, [activeConversationId, refreshOverflow, tabs]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      element.scrollLeft += direction === 'rtl' ? -delta : delta;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [direction, tabs.length]);

  const scrollByPage = useCallback((directionSign: 1 | -1) => {
    const element = scrollerRef.current;
    if (!element) return;
    const delta = Math.max(80, Math.round(element.clientWidth * 0.7)) * directionSign;
    element.scrollBy({ left: direction === 'rtl' ? -delta : delta, behavior: 'smooth' });
  }, [direction]);

  const handleClose = useCallback(async (id: string) => {
    try {
      await closeConversationTab(id);
    } catch (error) {
      message.error(String(error));
    }
  }, [message]);

  const handleCloseScope = useCallback(async (targetId: string, scope: CloseTabsScope) => {
    const ids = tabIdsToClose(visibleIds, targetId, conversations, scope);
    if (ids.length === 0) return;
    try {
      await closeConversationTabs(ids);
    } catch (error) {
      message.error(String(error));
    }
  }, [conversations, message, visibleIds]);

  const handlePin = useCallback(async (id: string, pinned: boolean) => {
    try {
      await setConversationTabPinned(id, pinned);
    } catch (error) {
      message.error(String(error));
    }
  }, [message, setConversationTabPinned]);

  const handleNewConversation = useCallback(() => {
    window.dispatchEvent(new CustomEvent('aqbot:new-conversation'));
  }, []);

  const newConversationLabel = t('titlebar.newConversation');
  const newConversationShortcut = formatShortcutForDisplay(
    getShortcutBinding(settings, 'newConversation'),
  );
  const newConversationTooltip = newConversationShortcut
    ? `${newConversationLabel} (${newConversationShortcut})`
    : newConversationLabel;

  const focusTab = useCallback((id: string) => {
    setFocusedId(id);
    scrollerRef.current
      ?.querySelector<HTMLElement>(`[data-conversation-tab="${id}"]`)
      ?.focus();
  }, []);

  const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>, id: string) => {
    const ids = tabs.map((tab) => tab.id);
    const index = ids.indexOf(id);
    if (index < 0) return;
    const rtl = direction === 'rtl';
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = (event.key === 'ArrowRight') === !rtl ? 1 : -1;
      const next = ids[index + step];
      if (next) focusTab(next);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      if (ids[0]) focusTab(ids[0]);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const last = ids[ids.length - 1];
      if (last) focusTab(last);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setActiveConversation(id);
    }
  }, [direction, focusTab, setActiveConversation, tabs]);

  const overflowMenu = useCallback((ids: string[]): MenuProps['items'] => (
    ids.map((id) => {
      const conversation = tabsById.get(id);
      return {
        key: id,
        label: (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: 220 }}>
            {conversation && (
              <ConversationIcon
                conv={conversation}
                isStreaming={streamingConversationId === conversation.id}
                size={14}
              />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {conversation?.title || t('chat.newConversation')}
            </span>
          </span>
        ),
      };
    })
  ), [streamingConversationId, t, tabsById]);

  const buttonStyle: React.CSSProperties = {
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: token.colorTextSecondary,
    cursor: 'pointer',
    borderRadius: token.borderRadiusSM ?? 4,
    flexShrink: 0,
  };

  const activateOverflowTab = useCallback((id: string) => {
    setActiveConversation(id);
    const tab = scrollerRef.current?.querySelector<HTMLElement>(`[data-conversation-tab="${id}"]`);
    tab?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [setActiveConversation]);

  const renderOverflowControl = (side: 'left' | 'right', ids: string[]) => {
    if (ids.length === 0) return null;
    const label = side === 'left' ? t('titlebar.hiddenTabsLeft') : t('titlebar.hiddenTabsRight');
    return (
      <Dropdown
        trigger={['hover', 'click']}
        menu={{
          items: overflowMenu(ids),
          onClick: ({ key, domEvent }) => {
            domEvent.preventDefault();
            domEvent.stopPropagation();
            activateOverflowTab(key);
          },
        }}
      >
        <Badge count={ids.length} size="small" offset={[-1, 1]}>
          <button
            type="button"
            className="title-bar-nodrag"
            aria-label={`${label} (${ids.length})`}
            style={buttonStyle}
            onClick={(event) => {
              event.stopPropagation();
              scrollByPage(side === 'left' ? -1 : 1);
            }}
          >
            {side === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
        </Badge>
      </Dropdown>
    );
  };

  return (
    <div
      className="conversation-tab-bar"
      dir={direction}
      style={{
        display: 'flex',
        alignItems: 'center',
        minWidth: 0,
        width: '100%',
        height: '100%',
        gap: 2,
        paddingLeft: 8,
        paddingRight: 8,
        boxSizing: 'border-box',
      }}
    >
      {renderOverflowControl('left', overflow.leftIds)}
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label={t('titlebar.conversationTabs')}
        className="conversation-tab-scroller"
        onScroll={(event) => setOverflow(measureOverflow(event.currentTarget))}
        style={{
          display: 'flex',
          alignItems: 'center',
          minWidth: 0,
          flex: '0 1 auto',
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
        }}
      >
        {tabs.map((conversation) => {
          const selected = conversation.id === activeConversationId;
          const pinned = conversation.tab_pin_order != null;
          const tabIndex = (focusedId ?? activeConversationId) === conversation.id ? 0 : -1;
          const others = tabIdsToClose(visibleIds, conversation.id, conversations, 'others');
          const otherUnpinned = tabIdsToClose(visibleIds, conversation.id, conversations, 'otherUnpinned');
          const leftIds = tabIdsToClose(visibleIds, conversation.id, conversations, 'left');
          const rightIds = tabIdsToClose(visibleIds, conversation.id, conversations, 'right');
          const menuItems: MenuProps['items'] = [
            {
              key: pinned ? 'unpin' : 'pin',
              label: pinned ? t('chat.unpinFromTab') : t('chat.pinToTab'),
            },
            { type: 'divider' },
            {
              key: 'close',
              label: t('titlebar.closeTab'),
            },
            {
              key: 'close-others',
              label: t('titlebar.closeOtherTabs'),
              disabled: others.length === 0,
            },
            {
              key: 'close-other-unpinned',
              label: t('titlebar.closeOtherUnpinnedTabs'),
              disabled: otherUnpinned.length === 0,
            },
            {
              key: 'close-left',
              label: t('titlebar.closeTabsToTheLeft'),
              disabled: leftIds.length === 0,
            },
            {
              key: 'close-right',
              label: t('titlebar.closeTabsToTheRight'),
              disabled: rightIds.length === 0,
            },
          ];
          return (
            <Dropdown
              key={conversation.id}
              trigger={['contextMenu']}
              menu={{
                items: menuItems,
                onClick: ({ key, domEvent }) => {
                  domEvent.preventDefault();
                  if (key === 'close') void handleClose(conversation.id);
                  if (key === 'close-others') void handleCloseScope(conversation.id, 'others');
                  if (key === 'close-other-unpinned') void handleCloseScope(conversation.id, 'otherUnpinned');
                  if (key === 'close-left') void handleCloseScope(conversation.id, 'left');
                  if (key === 'close-right') void handleCloseScope(conversation.id, 'right');
                  if (key === 'pin') void handlePin(conversation.id, true);
                  if (key === 'unpin') void handlePin(conversation.id, false);
                },
              }}
            >
              <div
                role="tab"
                tabIndex={tabIndex}
                aria-selected={selected}
                data-conversation-tab={conversation.id}
                className={`conversation-tab title-bar-nodrag${selected ? ' is-active' : ''}`}
                title={conversation.title}
                onClick={() => setActiveConversation(conversation.id)}
                onKeyDown={(event) => handleTabKeyDown(event, conversation.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  maxWidth: 180,
                  minWidth: 72,
                  height: 26,
                  padding: '0 8px',
                  marginInlineEnd: 4,
                  borderRadius: 6,
                  border: `1px solid ${selected ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
                  background: selected ? token.colorPrimaryBg : 'transparent',
                  color: selected ? token.colorPrimary : token.colorText,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <ConversationIcon
                  conv={conversation}
                  isStreaming={streamingConversationId === conversation.id}
                  size={16}
                />
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {conversation.title || t('chat.newConversation')}
                </span>
                {pinned && (
                  <Pin
                    size={10}
                    aria-label={t('titlebar.pinnedTab')}
                    style={{ color: token.colorPrimary, flexShrink: 0 }}
                  />
                )}
                <button
                  type="button"
                  aria-label={t('titlebar.closeTab')}
                  className="conversation-tab-close"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleClose(conversation.id);
                  }}
                  style={{
                    ...buttonStyle,
                    width: 16,
                    height: 16,
                    opacity: selected ? 1 : 0.7,
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            </Dropdown>
          );
        })}
      </div>
      <Tooltip title={newConversationTooltip}>
        <button
          type="button"
          className="conversation-tab-new title-bar-nodrag"
          aria-label={newConversationLabel}
          onClick={handleNewConversation}
          onMouseDown={(event) => event.stopPropagation()}
          style={buttonStyle}
        >
          <Plus size={14} />
        </button>
      </Tooltip>
      {renderOverflowControl('right', overflow.rightIds)}
    </div>
  );
}
