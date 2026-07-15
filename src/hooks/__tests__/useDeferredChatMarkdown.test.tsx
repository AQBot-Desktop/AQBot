import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMarkdownNode } from '@/lib/chatMarkdown';
import { clearChatMarkdownCache } from '@/lib/chatMarkdownCache';
import { useDeferredChatMarkdown } from '../useDeferredChatMarkdown';

const parseMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/chatMarkdownWorker', () => ({
  parseChatMarkdownOffMainThread: parseMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('useDeferredChatMarkdown', () => {
  beforeEach(() => {
    parseMock.mockReset();
    clearChatMarkdownCache();
  });

  it('resolves deferred nodes and reuses the module cache for the same message content', async () => {
    const pending = deferred<ChatMarkdownNode[]>();
    const nodes = [{ type: 'paragraph', raw: 'large' } as ChatMarkdownNode];
    parseMock.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useDeferredChatMarkdown({
      cacheKey: 'message-1',
      content: 'x'.repeat(20_001),
      enabled: true,
    }));

    expect(result.current).toBeUndefined();
    await act(async () => pending.resolve(nodes));
    await waitFor(() => expect(result.current).toBe(nodes));
    unmount();

    const cached = renderHook(() => useDeferredChatMarkdown({
      cacheKey: 'message-1',
      content: 'x'.repeat(20_001),
      enabled: true,
    }));
    expect(cached.result.current).toBe(nodes);
    expect(parseMock).toHaveBeenCalledTimes(1);
  });

  it('aborts obsolete parsing when content changes', () => {
    parseMock.mockImplementation(() => new Promise(() => {}));
    const { rerender } = renderHook(
      ({ content }) => useDeferredChatMarkdown({
        cacheKey: 'message-1',
        content,
        enabled: true,
      }),
      { initialProps: { content: 'a'.repeat(20_001) } },
    );
    const firstSignal = parseMock.mock.calls[0]?.[1] as AbortSignal;

    rerender({ content: 'b'.repeat(20_001) });

    expect(firstSignal.aborted).toBe(true);
  });
});
