import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MultiModelDisplayMode } from '@/types';
import { useMultiModelLayoutState } from '../useMultiModelLayoutState';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('useMultiModelLayoutState', () => {
  it('snapshots the effective conversation layout when a parent is first displayed', () => {
    const persistConversationDisplayMode = vi.fn(async () => {});
    const { result, rerender } = renderHook(
      ({ conversationDisplayMode }: {
        conversationDisplayMode: MultiModelDisplayMode;
      }) => useMultiModelLayoutState({
        conversationId: 'conversation-1',
        globalDisplayMode: 'tabs',
        conversationDisplayMode,
        persistConversationDisplayMode,
      }),
      { initialProps: { conversationDisplayMode: 'side-by-side' as MultiModelDisplayMode } },
    );

    expect(result.current.getDisplayMode('parent-1')).toBe('side-by-side');

    rerender({ conversationDisplayMode: 'stacked' });

    expect(result.current.getDisplayMode('parent-1')).toBe('side-by-side');
  });

  it('updates the current parent and future default without changing earlier parents', async () => {
    const persistConversationDisplayMode = vi.fn(async () => {});
    const { result } = renderHook(() => useMultiModelLayoutState({
      conversationId: 'conversation-1',
      globalDisplayMode: 'tabs',
      conversationDisplayMode: null,
      persistConversationDisplayMode,
    }));
    expect(result.current.getDisplayMode('parent-earlier')).toBe('tabs');
    expect(result.current.getDisplayMode('parent-current')).toBe('tabs');

    await act(async () => {
      await result.current.setDisplayMode('parent-current', 'side-by-side');
    });

    expect(result.current.getDisplayMode('parent-current')).toBe('side-by-side');
    expect(result.current.getDisplayMode('parent-earlier')).toBe('tabs');
    expect(result.current.futureDisplayMode).toBe('side-by-side');
    expect(result.current.getDisplayMode('parent-next')).toBe('side-by-side');
    expect(persistConversationDisplayMode).toHaveBeenCalledWith('side-by-side');
  });

  it('clears parent snapshots whenever the active conversation changes', () => {
    const persistConversationDisplayMode = vi.fn(async () => {});
    const { result, rerender } = renderHook(
      ({ conversationId, globalDisplayMode, conversationDisplayMode }: {
        conversationId: string;
        globalDisplayMode: MultiModelDisplayMode;
        conversationDisplayMode: MultiModelDisplayMode | null;
      }) => useMultiModelLayoutState({
        conversationId,
        globalDisplayMode,
        conversationDisplayMode,
        persistConversationDisplayMode,
      }),
      {
        initialProps: {
          conversationId: 'conversation-1',
          globalDisplayMode: 'tabs' as MultiModelDisplayMode,
          conversationDisplayMode: 'side-by-side' as MultiModelDisplayMode | null,
        },
      },
    );
    expect(result.current.getDisplayMode('parent-1')).toBe('side-by-side');

    rerender({
      conversationId: 'conversation-2',
      globalDisplayMode: 'tabs',
      conversationDisplayMode: 'stacked',
    });
    expect(result.current.getDisplayMode('parent-1')).toBe('stacked');

    rerender({
      conversationId: 'conversation-1',
      globalDisplayMode: 'tabs',
      conversationDisplayMode: null,
    });
    expect(result.current.getDisplayMode('parent-1')).toBe('tabs');
  });

  it('keeps the current answer layout but rolls back the future default when persistence fails', async () => {
    const saveError = new Error('save failed');
    const persistConversationDisplayMode = vi.fn(async () => {
      throw saveError;
    });
    const { result } = renderHook(() => useMultiModelLayoutState({
      conversationId: 'conversation-1',
      globalDisplayMode: 'tabs',
      conversationDisplayMode: null,
      persistConversationDisplayMode,
    }));
    expect(result.current.getDisplayMode('parent-current')).toBe('tabs');

    await act(async () => {
      await expect(
        result.current.setDisplayMode('parent-current', 'side-by-side'),
      ).rejects.toBe(saveError);
    });

    expect(result.current.getDisplayMode('parent-current')).toBe('side-by-side');
    expect(result.current.futureDisplayMode).toBe('tabs');
    expect(result.current.getDisplayMode('parent-next')).toBe('tabs');
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores an older persistence request that settles after the latest request (%s)',
    async (olderOutcome) => {
      const olderRequest = deferred();
      const latestRequest = deferred();
      const persistConversationDisplayMode = vi.fn()
        .mockImplementationOnce(() => olderRequest.promise)
        .mockImplementationOnce(() => latestRequest.promise);
      const { result } = renderHook(() => useMultiModelLayoutState({
        conversationId: 'conversation-1',
        globalDisplayMode: 'tabs',
        conversationDisplayMode: null,
        persistConversationDisplayMode,
      }));
      let olderMutation!: Promise<void>;
      let latestMutation!: Promise<void>;

      act(() => {
        olderMutation = result.current.setDisplayMode('parent-side', 'side-by-side');
      });
      act(() => {
        latestMutation = result.current.setDisplayMode('parent-stacked', 'stacked');
      });

      await act(async () => {
        latestRequest.resolve();
        await latestMutation;
      });
      await act(async () => {
        if (olderOutcome === 'reject') {
          const olderError = new Error('older save failed');
          olderRequest.reject(olderError);
          await expect(olderMutation).rejects.toBe(olderError);
        } else {
          olderRequest.resolve();
          await olderMutation;
        }
      });

      expect(result.current.futureDisplayMode).toBe('stacked');
      expect(result.current.getDisplayMode('parent-side')).toBe('side-by-side');
      expect(result.current.getDisplayMode('parent-stacked')).toBe('stacked');
    },
  );

  it('drops snapshots outside the retained parent window', () => {
    const persistConversationDisplayMode = vi.fn(async () => {});
    const { result, rerender } = renderHook(
      ({ conversationDisplayMode }: { conversationDisplayMode: MultiModelDisplayMode }) => (
        useMultiModelLayoutState({
          conversationId: 'conversation-1',
          globalDisplayMode: 'tabs',
          conversationDisplayMode,
          persistConversationDisplayMode,
        })
      ),
      { initialProps: { conversationDisplayMode: 'tabs' as MultiModelDisplayMode } },
    );
    expect(result.current.getDisplayMode('parent-evicted')).toBe('tabs');
    expect(result.current.getDisplayMode('parent-retained')).toBe('tabs');

    rerender({ conversationDisplayMode: 'stacked' });
    act(() => {
      result.current.retainDisplayModes(new Set(['parent-retained']));
    });

    expect(result.current.getDisplayMode('parent-retained')).toBe('tabs');
    expect(result.current.getDisplayMode('parent-evicted')).toBe('stacked');
  });
});
