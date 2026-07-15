export const CHAT_SCROLL_IS_REVERSED = false;
export const CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD = 8;
export const CHAT_SCROLL_TO_BOTTOM_VISIBILITY_THRESHOLD = 160;
export const CHAT_SCROLL_BOX_SELECTOR = '.ant-bubble-list-scroll-box';
export const CHAT_SCROLL_CONTENT_SELECTOR = '.ant-bubble-list-scroll-content';

export type ChatScrollElements = {
  scrollBox: HTMLElement | null;
  scrollContent: HTMLElement | null;
};

export type MessageScrollAnchor = {
  messageId: string;
  viewportOffset: number;
};

function getMessageAnchorElement(marker: HTMLElement): HTMLElement {
  return marker.closest<HTMLElement>('.ant-bubble-content') ?? marker;
}

export function captureMessageScrollAnchor(scrollBox: HTMLElement): MessageScrollAnchor | null {
  const viewportRect = scrollBox.getBoundingClientRect();
  const markers = scrollBox.querySelectorAll<HTMLElement>('[data-aqbot-msg]');
  for (const marker of markers) {
    const messageId = marker.dataset.aqbotMsg;
    if (!messageId) continue;
    const rect = getMessageAnchorElement(marker).getBoundingClientRect();
    if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom) continue;
    return {
      messageId,
      viewportOffset: rect.top - viewportRect.top,
    };
  }
  return null;
}

export function restoreMessageScrollAnchor(
  scrollBox: HTMLElement,
  anchor: MessageScrollAnchor | null,
): boolean {
  if (!anchor) return false;
  const marker = Array.from(scrollBox.querySelectorAll<HTMLElement>('[data-aqbot-msg]'))
    .find((candidate) => candidate.dataset.aqbotMsg === anchor.messageId);
  if (!marker) return false;
  const viewportTop = scrollBox.getBoundingClientRect().top;
  const currentOffset = getMessageAnchorElement(marker).getBoundingClientRect().top - viewportTop;
  scrollBox.scrollTop += currentOffset - anchor.viewportOffset;
  return true;
}

export function resolveChatScrollElements(
  root: ParentNode | null | undefined,
  scrollBoxCandidate?: HTMLElement | null,
): ChatScrollElements {
  const rootNode = root as Node | null | undefined;
  const candidateBelongsToRoot = Boolean(
    scrollBoxCandidate
      && (!rootNode || rootNode === scrollBoxCandidate || rootNode.contains(scrollBoxCandidate)),
  );
  const scrollBox: HTMLElement | null = candidateBelongsToRoot && scrollBoxCandidate
    ? scrollBoxCandidate
    : root?.querySelector<HTMLElement>(CHAT_SCROLL_BOX_SELECTOR) ?? null;
  const scrollContent = scrollBox?.querySelector<HTMLElement>(CHAT_SCROLL_CONTENT_SELECTOR)
    ?? (scrollBox?.firstElementChild as HTMLElement | null)
    ?? null;

  return { scrollBox, scrollContent };
}

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

export function hasMeasuredScrollLayout(metrics: ScrollLayoutMetrics) {
  return metrics.scrollHeight > 0 && metrics.clientHeight > 0;
}

export function hasMeasuredScrollLayoutChanged(
  previous: ScrollLayoutMetrics,
  next: ScrollLayoutMetrics,
  threshold = 1,
) {
  return hasMeasuredScrollLayout(previous)
    && hasScrollLayoutMetricsChanged(previous, next, threshold);
}

export function shouldStickToBottomOnLayoutChange(
  previous: ScrollLayoutMetrics,
  next: ScrollLayoutMetrics,
  wasStickingToBottom: boolean,
  hadRecentUserScrollIntent = false,
  threshold = 1,
) {
  return wasStickingToBottom
    && !hadRecentUserScrollIntent
    && hasMeasuredScrollLayoutChanged(previous, next, threshold);
}

export function shouldIgnoreScrollDepartureFromBottom(
  keepAutoScroll: boolean,
  wasStickingToBottom: boolean,
  hadRecentUserScrollIntent: boolean,
  hasLayoutChanged: boolean,
) {
  return !keepAutoScroll && wasStickingToBottom && !hadRecentUserScrollIntent && hasLayoutChanged;
}

export function shouldShowScrollToBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  isReversed: boolean,
  threshold = CHAT_SCROLL_TO_BOTTOM_VISIBILITY_THRESHOLD,
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
  threshold = CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD,
) {
  if (isReversed) {
    return scrollTop >= -threshold;
  }
  return scrollHeight - clientHeight - scrollTop <= threshold;
}
