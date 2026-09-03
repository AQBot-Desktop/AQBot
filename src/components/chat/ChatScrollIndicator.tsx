import {
  useEffect,
  useRef,
  useState,
  useCallback,
  memo,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { CHAT_SCROLL_BOX_SELECTOR } from './chatScroll';

const SCROLLBAR_HIDE_DELAY = 1200;

interface ThumbState {
  top: number;
  height: number;
  opacity: number;
  canScroll: boolean;
}

interface ScrollMetrics {
  top: number;
  height: number;
  maxScroll: number;
  isReversed: boolean;
}

interface ChatScrollIndicatorProps {
  onUserScrollIntent?: () => void;
  /** Scope that contains the Bubble.List scroll box. Defaults to the document. */
  scrollRoot?: RefObject<ParentNode | null>;
  /** Keep the thumb visible while the bound list can scroll. */
  persistWhenScrollable?: boolean;
}

function resolveIndicatorRoot(
  scrollRoot?: RefObject<ParentNode | null>,
): ParentNode {
  return scrollRoot?.current ?? document;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function measureThumb(el: HTMLElement): ScrollMetrics | null {
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight <= clientHeight + 1) return null;

  const maxScroll = scrollHeight - clientHeight;
  const height = Math.max((clientHeight / scrollHeight) * clientHeight, 24);
  const isReversed = getComputedStyle(el).flexDirection === 'column-reverse';
  const rawProgress = isReversed ? 1 + scrollTop / maxScroll : scrollTop / maxScroll;
  const progress = clamp(rawProgress, 0, 1);
  const top = progress * (clientHeight - height);

  return { top, height, maxScroll, isReversed };
}

/**
 * Lightweight, draggable scroll position indicator for the chat
 * message area (antd Bubble.List).
 *
 * antd's Bubble.List uses `flex-direction: column-reverse` for auto-scroll,
 * which inverts the scroll coordinate system (scrollTop=0 = bottom of content).
 * OverlayScrollbars cannot handle this, so we render a small custom indicator
 * that correctly accounts for the reversed layout.
 *
 * The indicator auto-shows on hover/scroll and fades out after inactivity.
 */
function ChatScrollIndicatorInner({
  onUserScrollIntent,
  scrollRoot,
  persistWhenScrollable = false,
}: ChatScrollIndicatorProps) {
  const [thumb, setThumb] = useState<ThumbState>({ top: 0, height: 0, opacity: 0, canScroll: false });
  const [dragging, setDragging] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const elRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragOffsetRef = useRef(0);
  const draggingRef = useRef(false);
  const hoveringRef = useRef(false);

  const clearHideTimer = useCallback(() => {
    clearTimeout(hideTimer.current);
  }, []);

  const scheduleHide = useCallback(() => {
    if (persistWhenScrollable || hoveringRef.current || draggingRef.current) return;
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      setThumb((state) => ({ ...state, opacity: 0 }));
    }, SCROLLBAR_HIDE_DELAY);
  }, [clearHideTimer, persistWhenScrollable]);

  const updateThumb = useCallback((visible = hoveringRef.current || draggingRef.current) => {
    const el = elRef.current;
    if (!el) return;

    const metrics = measureThumb(el);
    if (!metrics) {
      setThumb((state) => (state.canScroll ? { ...state, opacity: 0, canScroll: false } : state));
      return;
    }

    setThumb({
      top: metrics.top,
      height: metrics.height,
      opacity: persistWhenScrollable || visible ? 1 : 0,
      canScroll: true,
    });
  }, [persistWhenScrollable]);

  const handleScroll = useCallback(() => {
    updateThumb(true);
    scheduleHide();
  }, [scheduleHide, updateThumb]);

  const handlePointerEnter = useCallback(() => {
    hoveringRef.current = true;
    clearHideTimer();
    updateThumb(true);
  }, [clearHideTimer, updateThumb]);

  const handlePointerLeave = useCallback(() => {
    hoveringRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  const scrollToPointer = useCallback((clientY: number, thumbOffset: number) => {
    const el = elRef.current;
    const track = trackRef.current;
    if (!el || !track) return;

    const metrics = measureThumb(el);
    if (!metrics) return;

    const trackRect = track.getBoundingClientRect();
    const maxThumbTop = Math.max(0, trackRect.height - metrics.height);
    const nextTop = clamp(clientY - trackRect.top - thumbOffset, 0, maxThumbTop);
    const progress = maxThumbTop === 0 ? 1 : nextTop / maxThumbTop;
    el.scrollTop = metrics.isReversed
      ? (progress - 1) * metrics.maxScroll
      : progress * metrics.maxScroll;
    updateThumb(true);
  }, [updateThumb]);

  const beginDrag = useCallback(() => {
    onUserScrollIntent?.();
    draggingRef.current = true;
    setDragging(true);
    clearHideTimer();
    updateThumb(true);
  }, [clearHideTimer, onUserScrollIntent, updateThumb]);

  const handleThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!thumb.canScroll) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    dragOffsetRef.current = event.clientY - rect.top;
    beginDrag();
  }, [beginDrag, thumb.canScroll]);

  const handleTrackPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!thumb.canScroll || event.target !== event.currentTarget) return;
    event.preventDefault();
    dragOffsetRef.current = thumb.height / 2;
    beginDrag();
    scrollToPointer(event.clientY, dragOffsetRef.current);
  }, [beginDrag, scrollToPointer, thumb.canScroll, thumb.height]);

  useEffect(() => {
    const attach = () => {
      const root = resolveIndicatorRoot(scrollRoot);
      const el = (root instanceof Element || root instanceof Document
        ? root.querySelector<HTMLElement>(CHAT_SCROLL_BOX_SELECTOR)
        : null)
        ?? (root instanceof HTMLElement && root.matches(CHAT_SCROLL_BOX_SELECTOR) ? root : null);
      if (!el || el === elRef.current) return;
      elRef.current?.removeEventListener('scroll', handleScroll);
      elRef.current?.removeEventListener('pointerenter', handlePointerEnter);
      elRef.current?.removeEventListener('pointerleave', handlePointerLeave);
      elRef.current = el;
      el.addEventListener('scroll', handleScroll, { passive: true });
      el.addEventListener('pointerenter', handlePointerEnter);
      el.addEventListener('pointerleave', handlePointerLeave);
      handleScroll();
    };

    const raf = requestAnimationFrame(attach);
    const observer = new MutationObserver(attach);
    const observed = scrollRoot?.current instanceof Node ? scrollRoot.current : document.body;
    observer.observe(observed, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      elRef.current?.removeEventListener('scroll', handleScroll);
      elRef.current?.removeEventListener('pointerenter', handlePointerEnter);
      elRef.current?.removeEventListener('pointerleave', handlePointerLeave);
      clearTimeout(hideTimer.current);
    };
  }, [handlePointerEnter, handlePointerLeave, handleScroll, scrollRoot]);

  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (event: PointerEvent) => {
      onUserScrollIntent?.();
      event.preventDefault();
      scrollToPointer(event.clientY, dragOffsetRef.current);
    };

    const handlePointerUp = () => {
      draggingRef.current = false;
      setDragging(false);
      updateThumb(hoveringRef.current);
      scheduleHide();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [dragging, onUserScrollIntent, scheduleHide, scrollToPointer, updateThumb]);

  return (
    <div
      ref={trackRef}
      className={`chat-scroll-indicator-track${dragging ? ' is-dragging' : ''}`}
      onPointerDown={handleTrackPointerDown}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 10,
        pointerEvents: thumb.canScroll ? 'auto' : 'none',
        zIndex: 2,
      }}
    >
      <div
        className="chat-scroll-indicator"
        onPointerDown={handleThumbPointerDown}
        style={{
          position: 'absolute',
          right: 2,
          top: thumb.top,
          width: 5,
          height: thumb.height,
          borderRadius: 3,
          opacity: thumb.opacity,
          transition: dragging ? 'background-color 0.15s ease' : 'opacity 0.2s ease, background-color 0.15s ease',
          cursor: 'grab',
        }}
      />
    </div>
  );
}

export const ChatScrollIndicator = memo(ChatScrollIndicatorInner);
