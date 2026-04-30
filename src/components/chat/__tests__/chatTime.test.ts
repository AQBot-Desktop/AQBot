import { describe, expect, it } from 'vitest';
import { formatChatTime, normalizeChatTimestamp } from '../chatTime';

describe('chatTime', () => {
  it('formats backend unix-second timestamps the same as millisecond timestamps', () => {
    const timestampMs = Date.UTC(2026, 3, 30, 13, 0, 0);
    const timestampSeconds = Math.floor(timestampMs / 1000);

    expect(normalizeChatTimestamp(timestampSeconds)).toBe(timestampMs);
    expect(formatChatTime(timestampSeconds, timestampMs)).toBe(formatChatTime(timestampMs, timestampMs));
  });

  it('keeps frontend millisecond timestamps unchanged', () => {
    const timestampMs = Date.UTC(2026, 3, 30, 13, 45, 0);

    expect(normalizeChatTimestamp(timestampMs)).toBe(timestampMs);
  });

  it('shows only the time for messages from today', () => {
    const messageTime = new Date(2026, 3, 30, 21, 0, 5).getTime();
    const now = new Date(2026, 3, 30, 21, 30, 0).getTime();

    expect(formatChatTime(messageTime, now)).toBe('21:00:05');
  });

  it('shows the local date and time for messages outside today', () => {
    const messageTime = new Date(2026, 3, 29, 21, 0, 5).getTime();
    const now = new Date(2026, 3, 30, 21, 30, 0).getTime();

    expect(formatChatTime(messageTime, now)).toBe('2026-04-29 21:00:05');
  });
});
