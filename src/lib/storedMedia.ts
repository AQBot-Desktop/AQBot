import { invoke, isTauri } from '@/lib/invoke';

const STORED_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STORED_MEDIA_REFERENCE_PATTERN = /(?:aqbot-media:\/\/stored|https?:\/\/aqbot-media\.localhost\/stored)\/([A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_-])/gi;
const MAX_BROWSER_MEDIA_ENTRIES = 128;
const MAX_BROWSER_MEDIA_BYTES = 32 * 1024 * 1024;
const previewRequests = new Map<string, Promise<string>>();
const resolvedPreviews = new Map<string, { source: string; bytes: number }>();
let resolvedPreviewBytes = 0;
let cacheRevision = 0;

type ProtectedRange = { start: number; end: number };

function isWindowsWebView(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}

export function buildStoredMediaUrl(storedFileId: string, windows = isWindowsWebView()): string {
  if (!STORED_FILE_ID_PATTERN.test(storedFileId)) {
    throw new Error(`Invalid stored file id: ${storedFileId}`);
  }
  const encodedId = encodeURIComponent(storedFileId);
  return windows
    ? `http://aqbot-media.localhost/stored/${encodedId}`
    : `aqbot-media://stored/${encodedId}`;
}

function collectFencedCodeRanges(content: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const lines = content.match(/.*(?:\n|$)/g) ?? [];
  let offset = 0;
  let openFence: { char: '`' | '~'; length: number; start: number } | null = null;

  for (const line of lines) {
    if (!line) continue;
    const body = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (openFence) {
      const closing = body.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (
        closing
        && closing[1][0] === openFence.char
        && closing[1].length >= openFence.length
      ) {
        ranges.push({ start: openFence.start, end: offset + line.length });
        openFence = null;
      }
    } else {
      const opening = body.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opening) {
        openFence = {
          char: opening[1][0] as '`' | '~',
          length: opening[1].length,
          start: offset,
        };
      }
    }
    offset += line.length;
  }

  if (openFence) ranges.push({ start: openFence.start, end: content.length });
  return ranges;
}

function collectInlineCodeRanges(content: string, gaps: ProtectedRange[]): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  for (const gap of gaps) {
    let cursor = gap.start;
    while (cursor < gap.end) {
      if (content[cursor] !== '`') {
        cursor += 1;
        continue;
      }

      const start = cursor;
      while (cursor < gap.end && content[cursor] === '`') cursor += 1;
      const delimiterLength = cursor - start;
      let closingStart = -1;
      while (cursor < gap.end) {
        if (content[cursor] !== '`') {
          cursor += 1;
          continue;
        }
        const candidateStart = cursor;
        while (cursor < gap.end && content[cursor] === '`') cursor += 1;
        if (cursor - candidateStart === delimiterLength) {
          closingStart = candidateStart;
          break;
        }
      }

      if (closingStart >= 0) {
        ranges.push({ start, end: closingStart + delimiterLength });
        cursor = closingStart + delimiterLength;
      } else {
        cursor = start + delimiterLength;
      }
    }
  }
  return ranges;
}

function invertProtectedRanges(contentLength: number, ranges: ProtectedRange[]): ProtectedRange[] {
  const gaps: ProtectedRange[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) gaps.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < contentLength) gaps.push({ start: cursor, end: contentLength });
  return gaps;
}

/**
 * Convert persisted media references to the URL form understood by the current
 * WebView. Code examples stay byte-for-byte intact.
 */
export function normalizeStoredMediaUrlsForPlatform(
  content: string,
  windows = isWindowsWebView(),
): string {
  const lowerContent = content.toLowerCase();
  if (!lowerContent.includes('aqbot-media') || !lowerContent.includes('/stored/')) return content;

  const fencedRanges = collectFencedCodeRanges(content);
  const nonFencedRanges = invertProtectedRanges(content.length, fencedRanges);
  const protectedRanges = [...fencedRanges, ...collectInlineCodeRanges(content, nonFencedRanges)]
    .sort((a, b) => a.start - b.start);
  const renderableRanges = invertProtectedRanges(content.length, protectedRanges);
  let output = '';
  let cursor = 0;

  for (const range of renderableRanges) {
    output += content.slice(cursor, range.start);
    output += content.slice(range.start, range.end).replace(
      STORED_MEDIA_REFERENCE_PATTERN,
      (_match, storedFileId: string) => buildStoredMediaUrl(storedFileId, windows),
    );
    cursor = range.end;
  }
  output += content.slice(cursor);
  return output;
}

export async function loadStoredMediaSource(
  storedFileId: string,
  storagePath: string,
): Promise<string> {
  if (isTauri()) return buildStoredMediaUrl(storedFileId);

  const key = `${storedFileId}\u0000${storagePath}`;
  const resolved = resolvedPreviews.get(key);
  if (resolved) {
    resolvedPreviews.delete(key);
    resolvedPreviews.set(key, resolved);
    return resolved.source;
  }
  const existing = previewRequests.get(key);
  if (existing) return existing;

  const requestRevision = cacheRevision;
  let request!: Promise<string>;
  request = invoke<string>('read_attachment_preview', { filePath: storagePath })
    .then((source) => {
      if (requestRevision === cacheRevision) {
        const bytes = (key.length + source.length) * 2;
        if (bytes <= MAX_BROWSER_MEDIA_BYTES) {
          resolvedPreviews.set(key, { source, bytes });
          resolvedPreviewBytes += bytes;
          while (
            resolvedPreviews.size > MAX_BROWSER_MEDIA_ENTRIES
            || resolvedPreviewBytes > MAX_BROWSER_MEDIA_BYTES
          ) {
            const oldestKey = resolvedPreviews.keys().next().value;
            if (!oldestKey) break;
            const oldest = resolvedPreviews.get(oldestKey);
            if (oldest) resolvedPreviewBytes -= oldest.bytes;
            resolvedPreviews.delete(oldestKey);
          }
        }
      }
      return source;
    })
    .catch((error) => {
      throw error;
    })
    .finally(() => {
      if (previewRequests.get(key) === request) previewRequests.delete(key);
    });
  previewRequests.set(key, request);
  while (previewRequests.size > MAX_BROWSER_MEDIA_ENTRIES) {
    const oldestKey = previewRequests.keys().next().value;
    if (!oldestKey) break;
    previewRequests.delete(oldestKey);
  }
  return request;
}

export function clearStoredMediaSourceCache(): void {
  previewRequests.clear();
  resolvedPreviews.clear();
  resolvedPreviewBytes = 0;
  cacheRevision += 1;
}

export function getStoredMediaSourceCacheStats() {
  return {
    inFlightEntries: previewRequests.size,
    resolvedEntries: resolvedPreviews.size,
    resolvedBytes: resolvedPreviewBytes,
    maxEntries: MAX_BROWSER_MEDIA_ENTRIES,
    maxBytes: MAX_BROWSER_MEDIA_BYTES,
  };
}
