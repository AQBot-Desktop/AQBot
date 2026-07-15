import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  collectRetainedChatCacheKeys,
  getOrParseThinkingNodes,
  retainMapKeys,
  retainSetValues,
} from '../chatRetainedCaches';

type MessageIdentity = {
  id: string;
  parent_message_id: string | null;
  is_active: boolean;
};

function message(
  id: string,
  parentMessageId: string | null = null,
  isActive = true,
): MessageIdentity {
  return {
    id,
    parent_message_id: parentMessageId,
    is_active: isActive,
  };
}

describe('chat retained caches', () => {
  it('wires window pruning and conversation-switch cleanup into ChatView', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/chat/ChatView.tsx'),
      'utf8',
    );

    expect(source).toContain('collectRetainedChatCacheKeys(');
    expect(source).toContain('multiModelVersionsRef.current = retainMapKeys(');
    expect(source).toContain('contentRendererMessageIdsRef.current = retainSetValues(');
    expect(source).toContain('setDisplayModeOverrides((prev) => retainMapKeys(');
    expect(source).toContain('setDisplayVersionOverrides((prev) => retainMapKeys(');
    expect(source).toContain('setPendingDisplayVersionSelections((prev) => retainMapKeys(');
    expect(source).toContain('multiModelVersionsRef.current.clear();');
    expect(source).toContain('contentRendererMessageIdsRef.current.clear();');
  });

  it('bounds retained message keys to the current 40-message window and linked versions', () => {
    const messages = Array.from({ length: 45 }, (_, index) => (
      message(`message-${index}`, index % 2 === 1 ? `message-${index - 1}` : null)
    ));
    messages.push(message('old-version', 'message-0', false));
    messages.push(message('visible-version', 'message-6', false));

    const keys = collectRetainedChatCacheKeys(messages, 40, ['streaming-message']);

    expect(keys.messageIds.has('message-0')).toBe(false);
    expect(keys.messageIds.has('message-5')).toBe(true);
    expect(keys.messageIds.has('visible-version')).toBe(true);
    expect(keys.messageIds.has('old-version')).toBe(false);
    expect(keys.messageIds.has('streaming-message')).toBe(true);
    expect(keys.parentIds.has('message-4')).toBe(true);
    expect(keys.parentIds.has('message-0')).toBe(false);
  });

  it('returns the original Map and Set when nothing needs pruning', () => {
    const map = new Map([['parent-1', 'value']]);
    const set = new Set(['message-1']);

    expect(retainMapKeys(map, new Set(['parent-1']))).toBe(map);
    expect(retainSetValues(set, new Set(['message-1']))).toBe(set);
  });

  it('drops entries outside the current message window', () => {
    const map = new Map([
      ['parent-1', 'current'],
      ['parent-old', 'stale'],
    ]);
    const set = new Set(['message-1', 'message-old']);

    expect(Array.from(retainMapKeys(map, new Set(['parent-1'])))).toEqual([
      ['parent-1', 'current'],
    ]);
    expect(Array.from(retainSetValues(set, new Set(['message-1'])))).toEqual([
      'message-1',
    ]);
  });

  it('retains only the latest AST while thinking content is streaming', () => {
    const cache = new Map<string, string[]>();
    const parse = vi.fn((content: string) => [content]);

    for (let index = 0; index < 30; index += 1) {
      getOrParseThinkingNodes(cache, `stream-${index}`.repeat(1_000), true, parse);
      expect(cache.size).toBe(1);
    }

    const latestContent = 'stream-29'.repeat(1_000);
    expect(cache.get(latestContent)).toEqual([latestContent]);
    expect(parse).toHaveBeenCalledTimes(30);
  });

  it('uses the normal bounded cache after thinking completes', () => {
    const cache = new Map<string, string[]>();
    const parse = vi.fn((content: string) => [content]);

    getOrParseThinkingNodes(cache, 'streaming', true, parse);
    for (let index = 0; index < 25; index += 1) {
      getOrParseThinkingNodes(cache, `complete-${index}`, false, parse);
    }
    const latest = getOrParseThinkingNodes(cache, 'complete-24', false, parse);

    expect(cache.size).toBe(24);
    expect(cache.has('streaming')).toBe(false);
    expect(cache.has('complete-0')).toBe(false);
    expect(cache.has('complete-24')).toBe(true);
    expect(latest).toEqual(['complete-24']);
    expect(parse).toHaveBeenCalledTimes(26);
  });
});
