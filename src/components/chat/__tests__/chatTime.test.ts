import { describe, expect, it } from 'vitest';
import { formatChatTime, normalizeChatTimestamp } from '../chatTime';

describe('chatTime', () => {
  it('formats backend unix-second timestamps the same as millisecond timestamps', () => {
    const timestampMs = Date.UTC(2026, 3, 30, 13, 0, 0);
    const timestampSeconds = Math.floor(timestampMs / 1000);

    expect(normalizeChatTimestamp(timestampSeconds)).toBe(timestampMs);
    expect(formatChatTime(timestampSeconds)).toBe(formatChatTime(timestampMs));
  });

  it('keeps frontend millisecond timestamps unchanged', () => {
    const timestampMs = Date.UTC(2026, 3, 30, 13, 45, 0);

    expect(normalizeChatTimestamp(timestampMs)).toBe(timestampMs);
  });
});
