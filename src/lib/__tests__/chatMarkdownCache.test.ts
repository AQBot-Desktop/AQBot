import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMarkdownNode } from '../chatMarkdown';
import {
  clearChatMarkdownCache,
  createChatContentFingerprint,
  getCachedChatMarkdown,
  setCachedChatMarkdown,
} from '../chatMarkdownCache';

const node = (content: string): ChatMarkdownNode[] => [{
  type: 'paragraph',
  raw: content,
} as ChatMarkdownNode];

describe('chatMarkdownCache', () => {
  beforeEach(() => clearChatMarkdownCache());

  it('reuses parsed nodes only for the same message and content fingerprint', () => {
    const parsed = node('cached');
    setCachedChatMarkdown('message-1', 'hello', parsed);

    expect(getCachedChatMarkdown('message-1', 'hello')).toBe(parsed);
    expect(getCachedChatMarkdown('message-1', 'changed')).toBeUndefined();
    expect(getCachedChatMarkdown('message-2', 'hello')).toBeUndefined();
  });

  it('creates a compact deterministic fingerprint instead of retaining full content in signatures', () => {
    const content = 'x'.repeat(100_000);
    const fingerprint = createChatContentFingerprint(content);

    expect(fingerprint).toBe(createChatContentFingerprint(content));
    expect(fingerprint).not.toContain(content.slice(0, 100));
    expect(fingerprint.length).toBeLessThan(32);
  });

  it('retains a complete 40-message render window and then evicts least-recently-used entries', () => {
    for (let index = 0; index < 40; index += 1) {
      setCachedChatMarkdown(`message-${index}`, `content-${index}`, node(String(index)));
    }
    expect(getCachedChatMarkdown('message-0', 'content-0')).toBeDefined();
    for (let index = 0; index < 40; index += 1) {
      expect(getCachedChatMarkdown(`message-${index}`, `content-${index}`)).toBeDefined();
    }
    setCachedChatMarkdown('message-40', 'content-40', node('40'));

    expect(getCachedChatMarkdown('message-0', 'content-0')).toBeUndefined();
    expect(getCachedChatMarkdown('message-1', 'content-1')).toBeDefined();
  });

  it('also bounds retained ASTs by estimated bytes', () => {
    const first = 'a'.repeat(1_000_000);
    const second = 'b'.repeat(1_000_000);
    const third = 'c'.repeat(1_000_000);
    setCachedChatMarkdown('large-1', first, node(first));
    setCachedChatMarkdown('large-2', second, node(second));
    setCachedChatMarkdown('large-3', third, node(third));

    expect(getCachedChatMarkdown('large-1', first)).toBeUndefined();
    expect(getCachedChatMarkdown('large-2', second)).toBeDefined();
    expect(getCachedChatMarkdown('large-3', third)).toBeDefined();
  });
});
