import React, { useMemo, useState, useRef, useEffect, createContext, useContext, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, Typography, theme } from 'antd';
import { ChevronDown, User } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { useConversationStore, useProviderStore, useSettingsStore } from '@/stores';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import { stripAqbotTags } from '@/lib/chatMarkdown';
import { invoke } from '@/lib/invoke';
import type { Message, MessageSummary } from '@/types';

// ── Scroll context — provided by ChatView ──

type ScrollToFn = (messageId: string) => void;
interface MinimapContextValue {
  scrollTo: ScrollToFn;
  scrollBoxRef: React.RefObject<HTMLElement | null>;
  /** Set by programmatic scroll — suppresses detection updates */
  scrollLockRef: React.MutableRefObject<number>;
  /** Forced active ID set by click — overrides detection during lock */
  forcedActiveRef: React.MutableRefObject<string | null>;
}
const MinimapScrollContext = createContext<MinimapContextValue | null>(null);

export function MinimapScrollProvider({
  children,
  scrollTo,
  scrollBoxRef,
}: {
  children: React.ReactNode;
  scrollTo: ScrollToFn;
  scrollBoxRef: React.RefObject<HTMLElement | null>;
}) {
  const scrollLockRef = useRef(0);
  const forcedActiveRef = useRef<string | null>(null);
  const wrappedScrollTo = useCallback<ScrollToFn>((messageId) => {
    // Lock detection for 800ms after programmatic scroll
    scrollLockRef.current = Date.now() + 800;
    forcedActiveRef.current = messageId;
    scrollTo(messageId);
  }, [scrollTo]);
  const value = useMemo(() => ({ scrollTo: wrappedScrollTo, scrollBoxRef, scrollLockRef, forcedActiveRef }), [wrappedScrollTo, scrollBoxRef]);
  return <MinimapScrollContext.Provider value={value}>{children}</MinimapScrollContext.Provider>;
}

function useMinimapContext(): MinimapContextValue {
  const ctx = useContext(MinimapScrollContext);
  return ctx ?? { scrollTo: () => {}, scrollBoxRef: { current: null }, scrollLockRef: { current: 0 }, forcedActiveRef: { current: null } };
}

// ── Types ──

interface MinimapEntry {
  index: number;
  msg: MessageSummary;
  role: 'user' | 'assistant';
  summary: string;
  modelId?: string | null;
  providerId?: string | null;
}

// ── Helpers ──

const MINIMAP_VIRTUAL_OVERSCAN = 4;
const FAQ_ITEM_HEIGHT = 18;
const FAQ_DEFAULT_HEIGHT = 480;
const STICKY_ITEM_HEIGHT = 34;
const STICKY_DROPDOWN_HEIGHT = 300;

function summarize(content: string, maxLen: number, role: 'user' | 'assistant'): string {
  const stripped = stripAqbotTags(content, { stripThink: role === 'assistant' })
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\n+/g, ' ')
    .trim();
  return stripped.length > maxLen ? stripped.slice(0, maxLen) + '…' : stripped;
}

function summaryFromMessage(message: Message): MessageSummary | null {
  if (message.is_active === false) return null;
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  return {
    id: message.id,
    role: message.role,
    content_preview: message.content.slice(0, 500),
    provider_id: message.provider_id,
    model_id: message.model_id,
    created_at: message.created_at,
    parent_message_id: message.parent_message_id,
  };
}

function buildEntries(summaries: MessageSummary[]): MinimapEntry[] {
  const entries: MinimapEntry[] = [];
  const parentToIdx = new Map<string, number>();
  let idx = 0;

  for (const msg of summaries) {
    if (msg.role === 'user') {
      entries.push({
        index: idx++,
        msg,
        role: 'user',
        summary: summarize(msg.content_preview, 30, 'user'),
      });
      continue;
    }

    const parentKey = msg.parent_message_id || msg.id;
    const existing = parentToIdx.get(parentKey);
    const entry: MinimapEntry = {
      index: existing !== undefined ? entries[existing].index : idx++,
      msg,
      role: 'assistant',
      summary: summarize(msg.content_preview, 30, 'assistant'),
      modelId: msg.model_id,
      providerId: msg.provider_id,
    };
    if (existing !== undefined) {
      entries[existing] = entry;
    } else {
      parentToIdx.set(parentKey, entries.length);
      entries.push(entry);
    }
  }

  return entries;
}

function useEntries(enabled: boolean, conversationId: string | null): MinimapEntry[] {
  const messages = useConversationStore((s) => s.messages);
  const [summaries, setSummaries] = useState<MessageSummary[]>([]);

  useEffect(() => {
    if (!enabled || !conversationId) {
      setSummaries([]);
      return;
    }

    let cancelled = false;
    invoke<MessageSummary[]>('list_message_summaries', { conversationId })
      .then((items) => {
        if (!cancelled) setSummaries(items);
      })
      .catch((error) => {
        console.warn('[ChatMinimap] failed to load message summaries:', error);
        if (!cancelled) setSummaries([]);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, enabled]);

  return useMemo(() => {
    if (!enabled) return [];
    const byId = new Map(summaries.map((item) => [item.id, item]));
    for (const message of messages) {
      const summary = summaryFromMessage(message);
      if (summary) byId.set(summary.id, summary);
    }
    const merged = Array.from(byId.values())
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    return buildEntries(merged);
  }, [enabled, messages, summaries]);
}

function useVirtualEntries<T>(items: T[], itemHeight: number, defaultHeight: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(defaultHeight);

  useEffect(() => {
    setScrollTop(0);
  }, [items]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const updateHeight = () => setHeight(el.clientHeight || defaultHeight);
    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [defaultHeight]);

  const range = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - MINIMAP_VIRTUAL_OVERSCAN);
    const end = Math.min(
      items.length,
      Math.ceil((scrollTop + height) / itemHeight) + MINIMAP_VIRTUAL_OVERSCAN,
    );
    return { start, end };
  }, [height, itemHeight, items.length, scrollTop]);

  const visible = useMemo(() => (
    items.slice(range.start, range.end).map((item, offset) => {
      const index = range.start + offset;
      return { item, index, top: index * itemHeight };
    })
  ), [itemHeight, items, range.end, range.start]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  return {
    ref,
    onScroll,
    totalHeight: items.length * itemHeight,
    visible,
  };
}

/** Find the bubble wrapper element for a data-aqbot-msg marker */
function findBubbleEl(marker: Element, scrollBox: HTMLElement): Element {
  let el: Element = marker;
  // Walk up until we find an element whose parent is the scroll box or its first child container
  for (;;) {
    const parent: Element | null = el.parentElement;
    if (!parent || parent === scrollBox) return el;
    if (parent.parentElement === scrollBox) return el;
    el = parent;
  }
}

/** Track which message is currently most visible in the viewport */
function useActiveMessageId(entries: MinimapEntry[]): string | null {
  const { scrollBoxRef, scrollLockRef, forcedActiveRef } = useMinimapContext();
  const [activeId, setActiveId] = useState<string | null>(null);
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.msg.id, entry])), [entries]);

  useEffect(() => {
    if (entries.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !entryById.has(activeId)) {
      setActiveId(entries[entries.length - 1].msg.id);
    }
  }, [activeId, entries, entryById]);

  useEffect(() => {
    if (entries.length === 0) return;

    const updateActive = () => {
      // During programmatic scroll lock, use the forced active ID
      if (Date.now() < scrollLockRef.current) {
        if (forcedActiveRef.current) {
          setActiveId(forcedActiveRef.current);
        }
        return;
      }
      // Clear forced active once lock expires
      forcedActiveRef.current = null;
      const scrollBox = scrollBoxRef.current;
      if (!scrollBox) return;
      const boxRect = scrollBox.getBoundingClientRect();
      const loaded = Array.from(scrollBox.querySelectorAll('[data-aqbot-msg]'))
        .map((marker) => {
          const id = marker.getAttribute('data-aqbot-msg');
          const entry = id ? entryById.get(id) : undefined;
          if (!id || !entry) return null;
          const el = findBubbleEl(marker, scrollBox);
          return { id, index: entry.index, rect: el.getBoundingClientRect() };
        })
        .filter((item): item is { id: string; index: number; rect: DOMRect } => Boolean(item));
      if (loaded.length === 0) return;

      const firstLoaded = loaded.reduce((best, item) => (item.index < best.index ? item : best), loaded[0]);
      const lastLoaded = loaded.reduce((best, item) => (item.index > best.index ? item : best), loaded[0]);

      // Edge case: scrolled to top — first entry's top is at or below viewport top
      if (firstLoaded.rect.top >= boxRect.top - 5) {
        setActiveId(firstLoaded.id);
        return;
      }

      // Edge case: scrolled to bottom — last entry's bottom is at or above viewport bottom
      if (lastLoaded.rect.bottom <= boxRect.bottom + 5) {
        setActiveId(lastLoaded.id);
        return;
      }

      // Normal: find entry whose bubble is closest to detection line (25% from top)
      const detectY = boxRect.top + boxRect.height * 0.25;
      let best: { id: string; dist: number } | null = null;

      for (const item of loaded) {
        const rect = item.rect;
        if (rect.bottom < boxRect.top || rect.top > boxRect.bottom) continue;
        const dist = Math.abs(rect.top - detectY);
        if (!best || dist < best.dist) {
          best = { id: item.id, dist };
        }
      }
      if (best) setActiveId(best.id);
    };

    // Wait for scroll box to be available, then attach listener
    let scrollBox: HTMLElement | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;

    const attach = () => {
      scrollBox = scrollBoxRef.current;
      if (!scrollBox) {
        retryTimer = setTimeout(attach, 200);
        return;
      }
      scrollBox.addEventListener('scroll', updateActive, { passive: true });
      updateActive();
    };

    attach();

    return () => {
      clearTimeout(retryTimer);
      scrollBox?.removeEventListener('scroll', updateActive);
    };
  }, [scrollBoxRef, entries, entryById]);

  return activeId;
}

function useModelName(modelId?: string | null, providerId?: string | null): string {
  const providers = useProviderStore((s) => s.providers);
  return useMemo(() => {
    if (!modelId) return '';
    for (const p of providers) {
      if (providerId && p.id !== providerId) continue;
      const model = p.models?.find((m) => m.model_id === modelId);
      if (model) return model.name || model.model_id;
    }
    const parts = modelId.split('/');
    return parts[parts.length - 1];
  }, [modelId, providerId, providers]);
}

function ModelName({ modelId, providerId }: { modelId?: string | null; providerId?: string | null }) {
  const name = useModelName(modelId, providerId);
  return <>{name}</>;
}

/** Renders the user avatar matching the chat bubble style */
function UserAvatarIcon({ size }: { size: number }) {
  const { token } = theme.useToken();
  const profile = useUserProfileStore((s) => s.profile);
  const resolvedSrc = useResolvedAvatarSrc(profile.avatarType, profile.avatarValue);

  if (profile.avatarType === 'emoji' && profile.avatarValue) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: token.colorFillSecondary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.round(size * 0.55),
          lineHeight: 1,
        }}
      >
        {profile.avatarValue}
      </div>
    );
  }
  if ((profile.avatarType === 'url' || profile.avatarType === 'file') && profile.avatarValue) {
    const src = profile.avatarType === 'file' ? resolvedSrc : profile.avatarValue;
    return <Avatar size={size} src={src} />;
  }
  return <Avatar size={size} icon={<User size={Math.round(size * 0.5)} />} style={{ backgroundColor: token.colorPrimary }} />;
}

// ── Plan C: FAQ Index ──

function FaqIndex({ entries }: { entries: MinimapEntry[] }) {
  const { token } = theme.useToken();
  const activeId = useActiveMessageId(entries);
  const virtual = useVirtualEntries(entries, FAQ_ITEM_HEIGHT, FAQ_DEFAULT_HEIGHT);

  if (entries.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        right: 4,
        top: 8,
        bottom: 8,
        width: 260,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        zIndex: 10,
        pointerEvents: 'none',
      }}
    >
      {/* Scrollable dots column */}
      <div
        ref={virtual.ref}
        onScroll={virtual.onScroll}
        style={{
          width: 28,
          maxHeight: '100%',
          overflowY: 'auto',
          scrollbarWidth: 'none',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ height: virtual.totalHeight, position: 'relative', width: '100%' }}>
          {virtual.visible.map(({ item: entry, top }) => (
            <div
              key={entry.msg.id}
              style={{
                position: 'absolute',
                top,
                left: 0,
                right: 0,
                height: FAQ_ITEM_HEIGHT,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <FaqItem entry={entry} isActive={activeId === entry.msg.id} token={token} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FaqItem({ entry, isActive, token }: {
  entry: MinimapEntry;
  isActive: boolean;
  token: ReturnType<typeof theme.useToken>['token'];
}) {
  const [hovered, setHovered] = useState(false);
  const { scrollTo } = useMinimapContext();
  const dotRef = useRef<HTMLDivElement>(null);
  const isUser = entry.role === 'user';

  // Calculate fixed position for hover card based on dot's position
  const getCardStyle = (): React.CSSProperties => {
    if (!dotRef.current) return { display: 'none' };
    const rect = dotRef.current.getBoundingClientRect();
    return {
      position: 'fixed',
      right: window.innerWidth - rect.left + 6,
      top: rect.top + rect.height / 2,
      transform: 'translateY(-50%)',
      background: token.colorBgElevated,
      border: `1px solid ${token.colorBorderSecondary}`,
      borderRadius: token.borderRadius,
      padding: '4px 8px',
      minWidth: 140,
      maxWidth: 220,
      zIndex: 1000,
      cursor: 'pointer',
      boxShadow: token.boxShadowSecondary,
      pointerEvents: 'auto' as const,
    };
  };

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Dot */}
      <div
        ref={dotRef}
        onClick={() => scrollTo(entry.msg.id)}
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 8,
          fontWeight: 600,
          cursor: 'pointer',
          color: isActive ? '#fff' : token.colorTextSecondary,
          backgroundColor: isActive ? token.colorPrimary : token.colorFillQuaternary,
          border: `1px solid ${isActive ? token.colorPrimary : token.colorBorderSecondary}`,
          transition: 'all 0.2s',
          margin: '0 auto',
          overflow: 'hidden',
          ...(hovered && !isActive ? {
            backgroundColor: token.colorPrimaryBg,
            borderColor: token.colorPrimary,
            color: token.colorPrimary,
          } : {}),
        }}
      >
        {isUser ? (
          <UserAvatarIcon size={14} />
        ) : entry.modelId ? (
          <ModelIcon model={entry.modelId} size={12} type="avatar" />
        ) : (
          entry.index + 1
        )}
      </div>

      {/* Hover card — fixed position to avoid clipping */}
      {hovered && createPortal(
        <div
          onClick={() => scrollTo(entry.msg.id)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={getCardStyle()}
        >
          <div style={{ fontSize: 10, color: isUser ? token.colorTextSecondary : token.colorPrimary }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {!isUser && entry.modelId && <ModelIcon model={entry.modelId} size={10} type="avatar" />}
              {isUser ? 'Q' : <ModelName modelId={entry.modelId} providerId={entry.providerId} />}
            </span>
          </div>
          <Typography.Text
            type="secondary"
            ellipsis
            style={{ fontSize: 10, display: 'block', marginTop: 1 }}
          >
            {entry.summary}
          </Typography.Text>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── Plan D: Sticky Header ──

function StickyHeader({ entries }: { entries: MinimapEntry[] }) {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  const activeId = useActiveMessageId(entries);
  const containerRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualEntries(entries, STICKY_ITEM_HEIGHT, STICKY_DROPDOWN_HEIGHT);

  if (entries.length === 0) return null;

  const activeIdx = entries.findIndex((e) => e.msg.id === activeId);
  const current = entries[Math.max(0, activeIdx)];

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        backdropFilter: 'blur(12px)',
        background: `${token.colorBgContainer}e6`,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 16px',
          fontSize: 13,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ color: token.colorPrimary, fontWeight: 600, flexShrink: 0 }}>
          {(activeIdx >= 0 ? activeIdx : 0) + 1} / {entries.length}
        </span>
        {current.role === 'assistant' && current.modelId && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <ModelIcon model={current.modelId} size={14} type="avatar" />
            <StickyModelName modelId={current.modelId} providerId={current.providerId} />
          </span>
        )}
        {current.role === 'user' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <UserAvatarIcon size={14} />
          </span>
        )}
        <Typography.Text
          ellipsis
          style={{ flex: 1, minWidth: 0, fontSize: 12, color: token.colorTextSecondary }}
        >
          {current.summary}
        </Typography.Text>
        <ChevronDown
          size={14}
          style={{
            color: token.colorTextSecondary,
            transition: 'transform 0.2s',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        />
      </div>

      {expanded && (
        <div
          ref={virtual.ref}
          onScroll={virtual.onScroll}
          style={{
            maxHeight: 300,
            overflowY: 'auto',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div style={{ height: virtual.totalHeight, position: 'relative' }}>
            {virtual.visible.map(({ item: entry, top }) => (
              <div
                key={entry.msg.id}
                style={{
                  position: 'absolute',
                  top,
                  left: 0,
                  right: 0,
                  height: STICKY_ITEM_HEIGHT,
                }}
              >
                <StickyDropdownItem
                  entry={entry}
                  isActive={entry.msg.id === activeId}
                  token={token}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StickyModelName({ modelId, providerId }: { modelId?: string | null; providerId?: string | null }) {
  const name = useModelName(modelId, providerId);
  const { token } = theme.useToken();
  return <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{name}</span>;
}

function StickyDropdownItem({ entry, isActive, token }: {
  entry: MinimapEntry;
  isActive: boolean;
  token: ReturnType<typeof theme.useToken>['token'];
}) {
  const { scrollTo } = useMinimapContext();
  const isUser = entry.role === 'user';
  return (
    <div
      onClick={() => scrollTo(entry.msg.id)}
      style={{
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 16px',
        cursor: 'pointer',
        fontSize: 13,
        transition: 'background 0.15s',
        backgroundColor: isActive ? token.colorPrimaryBg : 'transparent',
        borderLeft: isActive ? `2px solid ${token.colorPrimary}` : '2px solid transparent',
      }}
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = token.colorFillQuaternary; }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = isActive ? token.colorPrimaryBg : 'transparent'; }}
    >
      <span style={{ width: 24, textAlign: 'right', fontSize: 11, color: token.colorTextQuaternary, flexShrink: 0 }}>
        #{entry.index + 1}
      </span>
      <span style={{ flexShrink: 0 }}>
        {isUser ? (
          <UserAvatarIcon size={16} />
        ) : entry.modelId ? (
          <ModelIcon model={entry.modelId} size={16} type="avatar" />
        ) : (
          <Avatar size={16} style={{ backgroundColor: token.colorPrimary, fontSize: 10 }}>AI</Avatar>
        )}
      </span>
      <Typography.Text
        ellipsis
        style={{ flex: 1, minWidth: 0, fontSize: 12, color: token.colorTextSecondary }}
      >
        {entry.summary}
      </Typography.Text>
    </div>
  );
}

// ── Main Component ──

export function ChatMinimap() {
  const enabled = useSettingsStore((s) => Boolean(s.settings.chat_minimap_enabled));
  const style = useSettingsStore((s) => s.settings.chat_minimap_style ?? 'faq');
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const entries = useEntries(enabled, activeConversationId);

  if (!enabled || entries.length < 2) return null;

  switch (style) {
    case 'faq':
      return <FaqIndex entries={entries} />;
    case 'sticky':
      return <StickyHeader entries={entries} />;
    default:
      return null;
  }
}
