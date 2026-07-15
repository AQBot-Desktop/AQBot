export interface RetainedChatMessageIdentity {
  id: string;
  parent_message_id: string | null;
  is_active?: boolean;
}

export interface RetainedChatCacheKeys {
  messageIds: Set<string>;
  parentIds: Set<string>;
}

const COMPLETED_THINK_CACHE_MAX_ENTRIES = 24;

export function collectRetainedChatCacheKeys(
  messages: RetainedChatMessageIdentity[],
  maxActiveMessages: number,
  extraMessageIds: Iterable<string> = [],
): RetainedChatCacheKeys {
  const allActiveMessages = messages.filter((message) => message.is_active !== false);
  const retainedCount = Math.max(0, maxActiveMessages);
  const activeMessages = retainedCount === 0
    ? []
    : allActiveMessages.slice(-retainedCount);
  const messageIds = new Set(activeMessages.map((message) => message.id));
  const parentIds = new Set<string>();

  for (const message of activeMessages) {
    parentIds.add(message.id);
    if (message.parent_message_id) parentIds.add(message.parent_message_id);
  }
  for (const message of messages) {
    if (message.parent_message_id && parentIds.has(message.parent_message_id)) {
      messageIds.add(message.id);
    }
  }
  for (const messageId of extraMessageIds) {
    messageIds.add(messageId);
  }

  return { messageIds, parentIds };
}

export function retainMapKeys<K, V>(map: Map<K, V>, allowedKeys: ReadonlySet<K>): Map<K, V> {
  if (map.size === 0 || Array.from(map.keys()).every((key) => allowedKeys.has(key))) {
    return map;
  }
  return new Map(Array.from(map).filter(([key]) => allowedKeys.has(key)));
}

export function retainSetValues<T>(set: Set<T>, allowedValues: ReadonlySet<T>): Set<T> {
  if (set.size === 0 || Array.from(set).every((value) => allowedValues.has(value))) {
    return set;
  }
  return new Set(Array.from(set).filter((value) => allowedValues.has(value)));
}

export function getOrParseThinkingNodes<T>(
  cache: Map<string, T>,
  content: string,
  isStreaming: boolean,
  parse: (content: string) => T,
): T {
  const hasCached = cache.has(content);
  const cached = cache.get(content);
  if (isStreaming) {
    if (cache.size !== 1 || !hasCached) {
      cache.clear();
      cache.set(content, hasCached ? cached as T : parse(content));
    }
    return cache.get(content) as T;
  }
  if (hasCached) return cached as T;

  const parsed = parse(content);
  cache.set(content, parsed);
  while (cache.size > COMPLETED_THINK_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return parsed;
}
