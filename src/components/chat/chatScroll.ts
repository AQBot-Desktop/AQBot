export const CHAT_SCROLL_IS_REVERSED = true;

export function getDistanceToHistoryTop(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  isReversed: boolean,
) {
  return isReversed ? scrollHeight + scrollTop - clientHeight : scrollTop;
}

export function getScrollTopAfterPrepend(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
  isReversed: boolean,
) {
  const heightDelta = Math.max(0, nextScrollHeight - previousScrollHeight);
  return isReversed
    ? previousScrollTop - heightDelta
    : previousScrollTop + heightDelta;
}

export type ScrollLayoutMetrics = {
  scrollHeight: number;
  clientHeight: number;
};

export function hasScrollLayoutMetricsChanged(
  previous: ScrollLayoutMetrics,
  next: ScrollLayoutMetrics,
  threshold = 1,
) {
  return Math.abs(next.scrollHeight - previous.scrollHeight) > threshold
    || Math.abs(next.clientHeight - previous.clientHeight) > threshold;
}

export function shouldStickToBottomOnLayoutChange(
  previous: ScrollLayoutMetrics,
  next: ScrollLayoutMetrics,
  wasStickingToBottom: boolean,
  threshold = 1,
) {
  return wasStickingToBottom && hasScrollLayoutMetricsChanged(previous, next, threshold);
}

export function shouldIgnoreScrollDepartureFromBottom(
  keepAutoScroll: boolean,
  wasStickingToBottom: boolean,
  hadRecentUserScrollIntent: boolean,
) {
  return !keepAutoScroll && wasStickingToBottom && !hadRecentUserScrollIntent;
}

export function shouldShowScrollToBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  isReversed: boolean,
  threshold = 160,
) {
  if (isReversed) {
    return scrollTop < -threshold;
  }
  return scrollHeight - clientHeight - scrollTop > threshold;
}

export function shouldKeepAutoScroll(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  isReversed: boolean,
  threshold = 8,
) {
  if (isReversed) {
    return scrollTop >= -threshold;
  }
  return scrollHeight - clientHeight - scrollTop <= threshold;
}
