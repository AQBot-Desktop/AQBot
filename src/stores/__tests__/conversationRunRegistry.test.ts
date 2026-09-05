import { describe, expect, it } from 'vitest';
import type { ConversationRunStateSlice } from '../conversationRunRegistry';
import {
  clearConversationRun,
  createConversationRun,
  isConversationStreaming,
  selectLiveStreamingConversationIds,
  selectUiStreaming,
  selectUiStreamingMessageId,
  shouldApplyRunRevision,
  snapshotStreamSyncState,
  upsertConversationRun,
  upsertObservedStream,
} from '../conversationRunRegistry';

function state(overrides: Partial<ConversationRunStateSlice> = {}): ConversationRunStateSlice {
  return {
    activeConversationId: 'conv-b',
    streaming: false,
    streamingConversationId: null,
    streamingMessageId: null,
    activeStreamId: null,
    observedStream: null,
    observedStreamsByConversation: {},
    runsByConversation: {},
    runWatermarksByConversation: {},
    pendingCompanionModels: [],
    multiModelParentId: null,
    multiModelDoneMessageIds: [],
    ...overrides,
  };
}

describe('conversation run registry', () => {
  it('does not treat another conversation\'s owned stream as the active composer stream', () => {
    const current = state({
      activeConversationId: 'conv-b',
      streaming: true,
      streamingConversationId: 'conv-a',
      streamingMessageId: 'assistant-a',
      activeStreamId: 'stream-a',
      runsByConversation: {
        'conv-a': createConversationRun({
          conversationId: 'conv-a',
          runId: 'stream-a',
          streamId: 'stream-a',
          streamingMessageId: 'assistant-a',
          phase: 'streaming',
        }),
      },
    });

    expect(isConversationStreaming(current, 'conv-a')).toBe(true);
    expect(selectUiStreaming(current)).toBe(false);
    expect(selectUiStreamingMessageId(current)).toBeNull();
    expect(selectLiveStreamingConversationIds(current)).toEqual(['conv-a']);
  });

  it('keeps A and B live at the same time and mirrors only the visible conversation', () => {
    let current = state({ activeConversationId: 'conv-a' });
    current = {
      ...current,
      ...upsertConversationRun(current, createConversationRun({
        conversationId: 'conv-a',
        runId: 'run-a',
        streamId: 'stream-a',
        streamingMessageId: 'assistant-a',
        phase: 'streaming',
      })),
    } as ConversationRunStateSlice;
    current = {
      ...current,
      activeConversationId: 'conv-b',
      ...upsertConversationRun({
        ...current,
        activeConversationId: 'conv-b',
      }, createConversationRun({
        conversationId: 'conv-b',
        runId: 'run-b',
        streamId: 'stream-b',
        streamingMessageId: 'assistant-b',
        phase: 'streaming',
      })),
    } as ConversationRunStateSlice;

    expect(selectLiveStreamingConversationIds(current)).toEqual(['conv-a', 'conv-b']);
    expect(selectUiStreaming(current)).toBe(true);
    expect(selectUiStreamingMessageId(current)).toBe('assistant-b');
    expect(current.streamingConversationId).toBe('conv-b');
    expect(current.runsByConversation['conv-a']?.streamId).toBe('stream-a');
  });

  it('ignores stale revisions so an old terminal cannot resurrect a finished run', () => {
    expect(shouldApplyRunRevision({ runId: 'run-2', revision: 4 }, { runId: 'run-1', revision: 3 })).toBe(false);
    expect(shouldApplyRunRevision({ runId: 'run-2', revision: 4 }, { runId: 'run-2', revision: 4 })).toBe(true);
    expect(shouldApplyRunRevision({ runId: 'run-2', revision: 4 }, { runId: 'run-3', revision: 5 })).toBe(true);

    let current = state({ activeConversationId: 'conv-a' });
    current = {
      ...current,
      ...upsertConversationRun(current, createConversationRun({
        conversationId: 'conv-a',
        runId: 'run-2',
        revision: 4,
        phase: 'streaming',
      })),
    } as ConversationRunStateSlice;
    const ignored = upsertConversationRun(current, createConversationRun({
      conversationId: 'conv-a',
      runId: 'run-1',
      revision: 3,
      phase: 'streaming',
    }));
    expect(ignored).toEqual({});

    current = {
      ...current,
      ...clearConversationRun(current, 'conv-a', 'run-2'),
    } as ConversationRunStateSlice;
    expect(current.runsByConversation['conv-a']).toBeUndefined();
    expect(selectUiStreaming(current)).toBe(false);
  });

  it('tracks observed streams per conversation instead of a single slot', () => {
    let current = state({ activeConversationId: 'conv-b' });
    current = {
      ...current,
      ...upsertObservedStream(current, 'conv-a', {
        streaming: true,
        streamId: 'remote-a',
        streamingMessageId: 'assistant-a',
        multiModelParentId: null,
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      }),
    } as ConversationRunStateSlice;
    current = {
      ...current,
      ...upsertObservedStream(current, 'conv-b', {
        streaming: true,
        streamId: 'remote-b',
        streamingMessageId: 'assistant-b',
        multiModelParentId: 'user-b',
        pendingCompanionModels: [{ providerId: 'p2', modelId: 'm2' }],
        multiModelDoneMessageIds: [],
      }),
    } as ConversationRunStateSlice;

    expect(selectLiveStreamingConversationIds(current)).toEqual(['conv-a', 'conv-b']);
    expect(selectUiStreaming(current)).toBe(true);
    expect(selectUiStreamingMessageId(current)).toBe('assistant-b');
    expect(snapshotStreamSyncState(current, 'conv-a')).toMatchObject({
      streaming: true,
      streamId: 'remote-a',
    });
  });
});
