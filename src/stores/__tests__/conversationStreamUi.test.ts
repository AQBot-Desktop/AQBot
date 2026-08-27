import { describe, expect, it } from 'vitest';
import type { ConversationState } from '../conversationStoreSupport';
import {
  isObservedStreamingFor,
  selectUiMultiModelParentId,
  selectUiStreaming,
  selectUiStreamingMessageId,
  snapshotStreamSyncState,
} from '../conversationStoreSupport';

function state(overrides: Partial<ConversationState>): ConversationState {
  return {
    activeConversationId: 'conv-1',
    streaming: false,
    streamingMessageId: null,
    streamingConversationId: null,
    multiModelParentId: null,
    pendingCompanionModels: [],
    multiModelDoneMessageIds: [],
    observedStream: null,
    ...overrides,
  } as ConversationState;
}

describe('conversation stream UI overlay', () => {
  it('treats another window stream as live for the same conversation', () => {
    const current = state({
      observedStream: {
        conversationId: 'conv-1',
        streaming: true,
        streamId: 'stream-a',
        streamingMessageId: 'assistant-a',
        multiModelParentId: 'user-1',
        pendingCompanionModels: [{ providerId: 'p2', modelId: 'm2' }],
        multiModelDoneMessageIds: [],
      },
    });

    expect(isObservedStreamingFor(current)).toBe(true);
    expect(selectUiStreaming(current)).toBe(true);
    expect(selectUiStreamingMessageId(current)).toBe('assistant-a');
    expect(selectUiMultiModelParentId(current)).toBe('user-1');
  });

  it('ignores observed stream from a different conversation', () => {
    const current = state({
      activeConversationId: 'conv-1',
      observedStream: {
        conversationId: 'conv-2',
        streaming: true,
        streamId: 'stream-a',
        streamingMessageId: 'assistant-a',
        multiModelParentId: 'user-1',
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
    });

    expect(selectUiStreaming(current)).toBe(false);
    expect(selectUiMultiModelParentId(current)).toBeNull();
  });

  it('prefers the locally owned stream over the observed snapshot', () => {
    const current = state({
      streaming: true,
      streamingMessageId: 'local-assistant',
      multiModelParentId: 'local-user',
      observedStream: {
        conversationId: 'conv-1',
        streaming: true,
        streamId: 'stream-remote',
        streamingMessageId: 'remote-assistant',
        multiModelParentId: 'remote-user',
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
    });

    expect(selectUiStreamingMessageId(current)).toBe('local-assistant');
    expect(selectUiMultiModelParentId(current)).toBe('local-user');
  });

  it('snapshots the owned stream for cross-window sync', () => {
    expect(snapshotStreamSyncState(state({
      streaming: true,
      streamingMessageId: 'assistant-a',
      multiModelParentId: 'user-1',
      pendingCompanionModels: [{ providerId: 'p2', modelId: 'm2' }],
      multiModelDoneMessageIds: ['assistant-a'],
    }))).toEqual({
      streaming: true,
      streamingMessageId: 'assistant-a',
      multiModelParentId: 'user-1',
      pendingCompanionModels: [{ providerId: 'p2', modelId: 'm2' }],
      multiModelDoneMessageIds: ['assistant-a'],
    });
  });
});
