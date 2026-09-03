import { Button, theme } from 'antd';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatScrollIndicator } from './ChatScrollIndicator';
import {
  isReversedScrollBox,
  resolveChatScrollElements,
  shouldShowScrollToBottom,
} from './chatScroll';

export function MultiModelColumnScroll({
  children,
  onScroll,
}: {
  children: ReactNode;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const rootRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const updateButton = useCallback(() => {
    const { scrollBox } = resolveChatScrollElements(rootRef.current);
    if (!scrollBox) {
      setShowScrollToBottom(false);
      return;
    }
    setShowScrollToBottom(shouldShowScrollToBottom(
      scrollBox.scrollHeight,
      scrollBox.scrollTop,
      scrollBox.clientHeight,
      isReversedScrollBox(scrollBox),
    ));
  }, []);

  const handleScrollCapture = useCallback((event: UIEvent<HTMLDivElement>) => {
    updateButton();
    onScroll?.(event);
  }, [onScroll, updateButton]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const handleNativeScroll = () => updateButton();
    root.addEventListener('scroll', handleNativeScroll, true);
    const mutationObserver = new MutationObserver(updateButton);
    mutationObserver.observe(root, { childList: true, subtree: true });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateButton);
    resizeObserver?.observe(root);
    updateButton();
    return () => {
      root.removeEventListener('scroll', handleNativeScroll, true);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, [updateButton]);

  const handleScrollToBottom = useCallback(() => {
    const { scrollBox } = resolveChatScrollElements(rootRef.current);
    if (!scrollBox) return;
    const reversed = isReversedScrollBox(scrollBox);
    scrollBox.scrollTo({
      top: reversed ? 0 : scrollBox.scrollHeight,
      behavior: 'smooth',
    });
    setShowScrollToBottom(false);
  }, []);

  return (
    <div
      ref={rootRef}
      data-testid="multi-model-column-scroll"
      onScrollCapture={handleScrollCapture}
      style={{
        position: 'relative',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {children}
      <ChatScrollIndicator scrollRoot={rootRef} persistWhenScrollable />
      {showScrollToBottom ? (
        <Button
          size="small"
          shape="round"
          data-testid="multi-model-column-scroll-to-bottom"
          icon={<ChevronDown size={14} />}
          onClick={handleScrollToBottom}
          aria-label={t('chat.scrollToBottom')}
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 12,
            zIndex: 3,
            transform: 'translateX(-50%)',
            boxShadow: token.boxShadowSecondary,
          }}
        >
          {t('chat.scrollToBottom')}
        </Button>
      ) : null}
    </div>
  );
}
