import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD,
  CHAT_SCROLL_IS_REVERSED,
  captureMessageScrollAnchor,
  getDistanceToHistoryTop,
  getScrollTopAfterPrepend,
  hasMeasuredScrollLayoutChanged,
  hasScrollLayoutMetricsChanged,
  resolveChatScrollElements,
  restoreMessageScrollAnchor,
  shouldIgnoreScrollDepartureFromBottom,
  shouldKeepAutoScroll,
  shouldStickToBottomOnLayoutChange,
  shouldShowScrollToBottom,
} from '../chatScroll';

describe('chat scroll helpers', () => {
  it('exposes the chat bubble list as a normal scroll container when Bubble.List autoScroll is disabled', () => {
    expect(CHAT_SCROLL_IS_REVERSED).toBe(false);
  });

  it('uses the app scroll mode to show the bottom button when the user leaves the latest message area', () => {
    expect(shouldShowScrollToBottom(2000, 1200, 800, CHAT_SCROLL_IS_REVERSED)).toBe(false);
    expect(shouldShowScrollToBottom(2000, 1040, 800, CHAT_SCROLL_IS_REVERSED)).toBe(false);
    expect(shouldShowScrollToBottom(2000, 900, 800, CHAT_SCROLL_IS_REVERSED)).toBe(true);
  });

  it('treats reversed bubble scroll near zero as the latest-message position', () => {
    expect(shouldShowScrollToBottom(2000, 0, 800, true)).toBe(false);
    expect(shouldShowScrollToBottom(2000, -80, 800, true)).toBe(false);
    expect(shouldShowScrollToBottom(2000, -240, 800, true)).toBe(true);
  });

  it('measures distance to the logical history top for auto-loading older pages', () => {
    expect(getDistanceToHistoryTop(2000, -1200, 800, true)).toBe(0);
    expect(getDistanceToHistoryTop(2000, 0, 800, true)).toBe(1200);
    expect(getDistanceToHistoryTop(2000, 0, 800, false)).toBe(0);
  });

  it('stops auto-scroll as soon as the user meaningfully leaves the bottom', () => {
    expect(CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD).toBe(8);
    expect(shouldKeepAutoScroll(2000, 0, 800, true)).toBe(true);
    expect(shouldKeepAutoScroll(2000, -7, 800, true)).toBe(true);
    expect(shouldKeepAutoScroll(2000, -12, 800, true)).toBe(false);
    expect(shouldKeepAutoScroll(2000, 1200, 800, false)).toBe(true);
    expect(shouldKeepAutoScroll(2000, 1193, 800, false)).toBe(true);
    expect(shouldKeepAutoScroll(2000, 1180, 800, false)).toBe(false);
  });

  it('detects layout changes that happen after content finishes rendering', () => {
    expect(hasScrollLayoutMetricsChanged(
      { scrollHeight: 1200, clientHeight: 800 },
      { scrollHeight: 1248, clientHeight: 800 },
    )).toBe(true);

    expect(hasScrollLayoutMetricsChanged(
      { scrollHeight: 1200, clientHeight: 800 },
      { scrollHeight: 1200, clientHeight: 760 },
    )).toBe(true);

    expect(hasScrollLayoutMetricsChanged(
      { scrollHeight: 1200, clientHeight: 800 },
      { scrollHeight: 1200.5, clientHeight: 800 },
    )).toBe(false);
  });

  it('does not treat the first unknown scroll measurement as a layout departure', () => {
    const hasLayoutChanged = hasMeasuredScrollLayoutChanged(
      { scrollHeight: 0, clientHeight: 0 },
      { scrollHeight: 2000, clientHeight: 800 },
    );

    expect(hasLayoutChanged).toBe(false);
    expect(shouldIgnoreScrollDepartureFromBottom(false, true, false, hasLayoutChanged)).toBe(false);
  });

  it('resolves the chat scroll elements from the message area before the Bubble.List ref is ready', () => {
    const root = document.createElement('div');
    const scrollBox = document.createElement('div');
    const scrollContent = document.createElement('div');
    scrollBox.className = 'ant-bubble-list-scroll-box';
    scrollContent.className = 'ant-bubble-list-scroll-content';
    scrollBox.appendChild(scrollContent);
    root.appendChild(scrollBox);

    expect(resolveChatScrollElements(root, null)).toEqual({ scrollBox, scrollContent });
  });

  it('keeps bottom lock on post-render layout changes only when the user was pinned', () => {
    expect(shouldStickToBottomOnLayoutChange(
      { scrollHeight: 1200, clientHeight: 800 },
      { scrollHeight: 1280, clientHeight: 800 },
      true,
    )).toBe(true);

    expect(shouldStickToBottomOnLayoutChange(
      { scrollHeight: 1200, clientHeight: 800 },
      { scrollHeight: 1280, clientHeight: 800 },
      false,
    )).toBe(false);

    expect(shouldStickToBottomOnLayoutChange(
      { scrollHeight: 1200, clientHeight: 800 },
      { scrollHeight: 1280, clientHeight: 800 },
      true,
      true,
    )).toBe(false);
  });

  it('ignores non-user scroll departures only when layout size changed while pinned', () => {
    expect(shouldIgnoreScrollDepartureFromBottom(false, true, false, true)).toBe(true);
    expect(shouldIgnoreScrollDepartureFromBottom(false, true, false, false)).toBe(false);
    expect(shouldIgnoreScrollDepartureFromBottom(false, true, true, true)).toBe(false);
    expect(shouldIgnoreScrollDepartureFromBottom(true, true, false, true)).toBe(false);
    expect(shouldIgnoreScrollDepartureFromBottom(false, false, false, true)).toBe(false);
  });

  it('preserves the viewport anchor when older messages are prepended in reversed chat mode', () => {
    expect(getScrollTopAfterPrepend(0, 1200, 1600, true)).toBe(-400);
    expect(getScrollTopAfterPrepend(-240, 1200, 1600, true)).toBe(-640);
  });

  it('preserves the viewport anchor when older messages are prepended in regular scroll mode', () => {
    expect(getScrollTopAfterPrepend(0, 1200, 1600, false)).toBe(400);
    expect(getScrollTopAfterPrepend(240, 1200, 1600, false)).toBe(640);
  });

  it('restores the first visible message anchor when both ends of the data window change', () => {
    const scrollBox = document.createElement('div');
    const hidden = document.createElement('span');
    const visible = document.createElement('span');
    const later = document.createElement('span');
    hidden.dataset.aqbotMsg = 'message-hidden';
    visible.dataset.aqbotMsg = 'message-visible';
    later.dataset.aqbotMsg = 'message-later';
    scrollBox.append(hidden, visible, later);
    Object.defineProperty(scrollBox, 'scrollTop', { value: 500, writable: true });
    vi.spyOn(scrollBox, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500 } as DOMRect);
    vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue({ top: 80, bottom: 80 } as DOMRect);
    const visibleRect = vi.spyOn(visible, 'getBoundingClientRect');
    visibleRect.mockReturnValue({ top: 140, bottom: 140 } as DOMRect);
    vi.spyOn(later, 'getBoundingClientRect').mockReturnValue({ top: 300, bottom: 300 } as DOMRect);

    const anchor = captureMessageScrollAnchor(scrollBox);
    expect(anchor).toEqual({ messageId: 'message-visible', viewportOffset: 40 });

    visibleRect.mockReturnValue({ top: 210, bottom: 210 } as DOMRect);
    expect(restoreMessageScrollAnchor(scrollBox, anchor)).toBe(true);
    expect(scrollBox.scrollTop).toBe(570);
  });

  it('anchors a tall bubble that is visible even when its zero-height marker is above the viewport', () => {
    const scrollBox = document.createElement('div');
    const tallBubble = document.createElement('div');
    const marker = document.createElement('span');
    const nextBubble = document.createElement('div');
    const nextMarker = document.createElement('span');
    tallBubble.className = 'ant-bubble-content';
    nextBubble.className = 'ant-bubble-content';
    marker.dataset.aqbotMsg = 'message-tall';
    nextMarker.dataset.aqbotMsg = 'message-next';
    tallBubble.append(marker);
    nextBubble.append(nextMarker);
    scrollBox.append(tallBubble, nextBubble);
    Object.defineProperty(scrollBox, 'scrollTop', { value: 500, writable: true });
    vi.spyOn(scrollBox, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500 } as DOMRect);
    vi.spyOn(marker, 'getBoundingClientRect').mockReturnValue({ top: -200, bottom: -200 } as DOMRect);
    const tallRect = vi.spyOn(tallBubble, 'getBoundingClientRect');
    tallRect.mockReturnValue({ top: -200, bottom: 220 } as DOMRect);
    vi.spyOn(nextBubble, 'getBoundingClientRect').mockReturnValue({ top: 220, bottom: 300 } as DOMRect);

    const anchor = captureMessageScrollAnchor(scrollBox);
    expect(anchor).toEqual({ messageId: 'message-tall', viewportOffset: -300 });

    tallRect.mockReturnValue({ top: -150, bottom: 270 } as DOMRect);
    expect(restoreMessageScrollAnchor(scrollBox, anchor)).toBe(true);
    expect(scrollBox.scrollTop).toBe(550);
  });
});
