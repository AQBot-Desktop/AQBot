import type { ChatMarkdownNode } from './chatMarkdown';

const MAX_CHAT_MARKDOWN_CACHE_ENTRIES = 40;
const MAX_CHAT_MARKDOWN_CACHE_BYTES = 16 * 1024 * 1024;

interface ChatMarkdownCacheEntry {
  fingerprint: string;
  nodes: ChatMarkdownNode[];
  estimatedBytes: number;
}

const cache = new Map<string, ChatMarkdownCacheEntry>();
let cacheBytes = 0;

export function createChatContentFingerprint(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length.toString(36)}:${(hash >>> 0).toString(36)}`;
}

export function getCachedChatMarkdown(
  messageId: string,
  content: string,
): ChatMarkdownNode[] | undefined {
  const entry = cache.get(messageId);
  if (!entry || entry.fingerprint !== createChatContentFingerprint(content)) return undefined;
  cache.delete(messageId);
  cache.set(messageId, entry);
  return entry.nodes;
}

export function setCachedChatMarkdown(
  messageId: string,
  content: string,
  nodes: ChatMarkdownNode[],
) {
  const existing = cache.get(messageId);
  if (existing) cacheBytes -= existing.estimatedBytes;
  cache.delete(messageId);
  const estimatedBytes = content.length * 8 + nodes.length * 128;
  if (estimatedBytes > MAX_CHAT_MARKDOWN_CACHE_BYTES) return;
  cache.set(messageId, {
    fingerprint: createChatContentFingerprint(content),
    nodes,
    estimatedBytes,
  });
  cacheBytes += estimatedBytes;
  while (
    cache.size > MAX_CHAT_MARKDOWN_CACHE_ENTRIES
    || cacheBytes > MAX_CHAT_MARKDOWN_CACHE_BYTES
  ) {
    const oldestMessageId = cache.keys().next().value;
    if (!oldestMessageId) break;
    const oldest = cache.get(oldestMessageId);
    if (oldest) cacheBytes -= oldest.estimatedBytes;
    cache.delete(oldestMessageId);
  }
}

export function clearChatMarkdownCache() {
  cache.clear();
  cacheBytes = 0;
}
