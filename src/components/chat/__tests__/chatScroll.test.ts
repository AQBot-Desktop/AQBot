import { describe, expect, it } from 'vitest';
import { getDistanceToHistoryTop, shouldShowScrollToBottom } from '../chatScroll';

describe('chat scroll helpers', () => {
  it('treats reversed bubble scroll near zero as the latest-message position', () => {
    expect(shouldShowScrollToBottom(0)).toBe(false);
    expect(shouldShowScrollToBottom(-80)).toBe(false);
    expect(shouldShowScrollToBottom(-240)).toBe(true);
  });

  it('measures distance to the logical history top for auto-loading older pages', () => {
    expect(getDistanceToHistoryTop(2000, -1200, 800)).toBe(0);
    expect(getDistanceToHistoryTop(2000, 0, 800)).toBe(1200);
  });
});
