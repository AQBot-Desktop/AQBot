import { describe, expect, it } from 'vitest';
import {
  CHAT_SCROLL_IS_REVERSED,
  getDistanceToHistoryTop,
  getScrollTopAfterPrepend,
  hasScrollLayoutMetricsChanged,
  shouldIgnoreScrollDepartureFromBottom,
  shouldKeepAutoScroll,
  shouldStickToBottomOnLayoutChange,
  shouldShowScrollToBottom,
} from '../chatScroll';

describe('chat scroll helpers', () => {
  it('exposes the chat bubble list as a reversed scroll container', () => {
    expect(CHAT_SCROLL_IS_REVERSED).toBe(true);
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
    expect(shouldKeepAutoScroll(2000, 0, 800, true)).toBe(true);
    expect(shouldKeepAutoScroll(2000, -12, 800, true)).toBe(false);
    expect(shouldKeepAutoScroll(2000, 1200, 800, false)).toBe(true);
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
  });

  it('ignores non-user scroll departures caused by async layout shifts while pinned', () => {
    expect(shouldIgnoreScrollDepartureFromBottom(false, true, false)).toBe(true);
    expect(shouldIgnoreScrollDepartureFromBottom(false, true, true)).toBe(false);
    expect(shouldIgnoreScrollDepartureFromBottom(true, true, false)).toBe(false);
    expect(shouldIgnoreScrollDepartureFromBottom(false, false, false)).toBe(false);
  });

  it('preserves the viewport anchor when older messages are prepended in reversed chat mode', () => {
    expect(getScrollTopAfterPrepend(0, 1200, 1600, true)).toBe(-400);
    expect(getScrollTopAfterPrepend(-240, 1200, 1600, true)).toBe(-640);
  });

  it('preserves the viewport anchor when older messages are prepended in regular scroll mode', () => {
    expect(getScrollTopAfterPrepend(0, 1200, 1600, false)).toBe(400);
    expect(getScrollTopAfterPrepend(240, 1200, 1600, false)).toBe(640);
  });
});
