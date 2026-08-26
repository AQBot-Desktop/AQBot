import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StreamActivity } from '@/lib/streamStatus';
import { useConversationStore } from '@/stores/conversationStore';
import { useStreamActivity } from '../useStreamActivity';

function activity(overrides: Partial<StreamActivity> = {}): StreamActivity {
  return {
    startedAt: 1,
    firstChunkAt: 1,
    lastChunkAt: 1,
    phase: 'streaming',
    ...overrides,
  };
}

describe('useStreamActivity', () => {
  beforeEach(() => {
    useConversationStore.setState({
      streaming: true,
      streamActivityByMessageId: {
        historical: activity({ lastChunkAt: 10 }),
      },
    });
  });

  it('keeps the same activity snapshot when a different message streams', () => {
    const { result } = renderHook(() => useStreamActivity('historical'));
    const first = result.current;

    act(() => {
      const current = useConversationStore.getState().streamActivityByMessageId;
      useConversationStore.setState({
        streamActivityByMessageId: {
          ...current,
          live: activity({ lastChunkAt: 20 }),
        },
      });
    });

    expect(result.current).toBe(first);
  });

  it('updates when the subscribed message receives a new activity object', () => {
    const { result } = renderHook(() => useStreamActivity('historical'));
    const next = activity({ lastChunkAt: 30 });

    act(() => {
      const current = useConversationStore.getState().streamActivityByMessageId;
      useConversationStore.setState({
        streamActivityByMessageId: {
          ...current,
          historical: next,
        },
      });
    });

    expect(result.current).toBe(next);
  });
});
