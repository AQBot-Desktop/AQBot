import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Input, Spin, theme, Empty } from 'antd';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConversationStore } from '@/stores';
import { selectLiveStreamingConversationKey } from '@/stores/conversationStore';
import { conversationIdsFromStreamingKey } from '@/stores/conversationRunRegistry';
import type { ConversationSearchResult } from '@/types';
import { highlightMatch } from '@/lib/highlightMatch';
import { ConversationIcon } from './ConversationIcon';

export interface ConversationSearchModalProps {
  open: boolean;
  onClose: () => void;
}

const DEBOUNCE_MS = 250;

export function ConversationSearchModal({ open, onClose }: ConversationSearchModalProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const searchConversations = useConversationStore((s) => s.searchConversations);
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation);
  const streamingConversationIds = conversationIdsFromStreamingKey(
    useConversationStore(selectLiveStreamingConversationKey),
  );

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setLoading(false);
      setActiveIndex(0);
      return;
    }
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      setActiveIndex(0);
      return;
    }

    setLoading(true);
    const seq = ++requestSeq.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await searchConversations(q);
          if (seq !== requestSeq.current) return;
          setResults(next);
          setActiveIndex(0);
        } catch {
          if (seq !== requestSeq.current) return;
          setResults([]);
        } finally {
          if (seq === requestSeq.current) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query, open, searchConversations]);

  const selectResult = useCallback(
    (result: ConversationSearchResult) => {
      setActiveConversation(result.conversation.id);
      onClose();
    },
    [setActiveConversation, onClose],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (loading || results.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = results[activeIndex];
        if (target) selectResult(target);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, results, activeIndex, onClose, selectResult, loading]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-search-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const showResultsPanel = query.trim().length > 0;

  const hintItems = useMemo(
    () => [
      { keys: '↑ ↓', label: t('chat.searchNavigateHint') },
      { keys: '↵', label: t('chat.searchSelectHint') },
      { keys: 'esc', label: t('chat.searchCloseHint') },
    ],
    [t],
  );

  if (!open) return null;

  // Mask is always a dark scrim (antd colorBgMask). Hint chrome sits on the
  // scrim, so it must use light-on-dark colors in both light and dark themes.
  const maskHintColor = 'rgba(255, 255, 255, 0.78)';
  const maskKbdBorder = 'rgba(255, 255, 255, 0.28)';
  const maskKbdBg = 'rgba(255, 255, 255, 0.14)';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('chat.globalSearchPlaceholder')}
      data-testid="conversation-search-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 16px 12vh',
        background: token.colorBgMask,
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div
        style={{
          width: 'min(640px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            borderRadius: 14,
            border: `1.5px solid ${token.colorPrimary}`,
            background: token.colorBgElevated,
            boxShadow: `0 0 0 1px ${token.colorPrimaryBorder}, ${token.boxShadowSecondary}`,
            color: token.colorText,
          }}
        >
          <Search size={18} style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
          <Input
            ref={(node) => {
              inputRef.current = node?.input ?? null;
            }}
            variant="borderless"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('chat.globalSearchPlaceholder')}
            allowClear={{ clearIcon: <X size={14} /> }}
            style={{ flex: 1, fontSize: 15, padding: 0, color: token.colorText }}
            autoFocus
          />
          {loading && <Spin size="small" data-testid="conversation-search-input-spin" />}
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            justifyContent: 'center',
            color: maskHintColor,
            fontSize: 12,
          }}
        >
          {hintItems.map((item) => (
            <span key={item.keys} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <kbd
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 22,
                  height: 20,
                  padding: '0 6px',
                  borderRadius: 6,
                  border: `1px solid ${maskKbdBorder}`,
                  background: maskKbdBg,
                  color: 'rgba(255, 255, 255, 0.92)',
                  fontSize: 11,
                  fontFamily: 'inherit',
                }}
              >
                {item.keys}
              </kbd>
              <span>{item.label}</span>
            </span>
          ))}
        </div>

        {showResultsPanel && (
          <div
            ref={listRef}
            style={{
              maxHeight: 'min(420px, 48vh)',
              overflowY: 'auto',
              borderRadius: 12,
              border: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgElevated,
              boxShadow: token.boxShadowSecondary,
              color: token.colorText,
              position: 'relative',
              minHeight: loading && results.length === 0 ? 120 : undefined,
            }}
          >
            {loading && results.length === 0 ? (
              <div
                data-testid="conversation-search-loading"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  padding: 36,
                  color: token.colorTextSecondary,
                }}
              >
                <Spin />
                <span style={{ fontSize: 13 }}>{t('chat.searchingConversations')}</span>
              </div>
            ) : !loading && results.length === 0 ? (
              <div style={{ padding: 28 }}>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('chat.searchNoResults')} />
              </div>
            ) : (
              <>
                {loading && (
                  <div
                    data-testid="conversation-search-loading-overlay"
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '8px 12px',
                      fontSize: 12,
                      color: token.colorTextSecondary,
                      background: token.colorBgElevated,
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    <Spin size="small" />
                    <span>{t('chat.searchingConversations')}</span>
                  </div>
                )}
                {results.map((result, index) => {
                  const active = index === activeIndex;
                  return (
                    <button
                      key={result.conversation.id}
                      type="button"
                      data-search-index={index}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectResult(result)}
                      style={{
                        display: 'flex',
                        width: '100%',
                        gap: 12,
                        alignItems: 'flex-start',
                        textAlign: 'left',
                        padding: '12px 14px',
                        border: 'none',
                        borderBottom:
                          index < results.length - 1
                            ? `1px solid ${token.colorBorderSecondary}`
                            : 'none',
                        cursor: 'pointer',
                        background: active ? token.colorPrimaryBg : 'transparent',
                        color: token.colorText,
                        opacity: loading ? 0.72 : 1,
                      }}
                    >
                      <span style={{ marginTop: 1, flexShrink: 0, lineHeight: 0 }}>
                        <ConversationIcon
                          conv={result.conversation}
                          isStreaming={streamingConversationIds.includes(result.conversation.id)}
                          size={20}
                        />
                      </span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 14,
                            fontWeight: 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {highlightMatch(result.conversation.title, query)}
                        </span>
                        {result.matched_message_preview && (
                          <span
                            style={{
                              marginTop: 4,
                              fontSize: 12,
                              color: token.colorTextSecondary,
                              lineHeight: 1.45,
                              overflow: 'hidden',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                            } as CSSProperties}
                          >
                            {highlightMatch(result.matched_message_preview, query)}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
