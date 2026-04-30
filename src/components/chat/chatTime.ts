const UNIX_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

export function normalizeChatTimestamp(timestamp: number): number {
  return Math.abs(timestamp) < UNIX_MILLISECONDS_THRESHOLD ? timestamp * 1000 : timestamp;
}

export function formatChatTime(timestamp: number): string {
  const date = new Date(normalizeChatTimestamp(timestamp));
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
