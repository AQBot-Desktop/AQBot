const UNIX_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

export function normalizeChatTimestamp(timestamp: number): number {
  return Math.abs(timestamp) < UNIX_MILLISECONDS_THRESHOLD ? timestamp * 1000 : timestamp;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function formatChatTime(timestamp: number, nowTimestamp: number = Date.now()): string {
  const date = new Date(normalizeChatTimestamp(timestamp));
  const now = new Date(normalizeChatTimestamp(nowTimestamp));
  const time = formatTime(date);

  if (isSameLocalDate(date, now)) {
    return time;
  }

  return `${formatDate(date)} ${time}`;
}
