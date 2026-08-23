import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessageVersionGroupResourceKey } from '@/stores/conversationStoreSupport';
import { useConversationStore } from '@/stores';
import type { Message } from '@/types';
import { useMessageVersionGroups } from '../useMessageVersionGroups';

function message(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    id: overrides.id,
    conversation_id: 'conv-1',
    role: overrides.role ?? 'assistant',
    content: overrides.content ?? overrides.id,
    provider_id: overrides.provider_id ?? 'provider-1',
    model_id: overrides.model_id ?? 'model-1',
    token_count: null,
    prompt_tokens: null,
    completion_tokens: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: overrides.created_at ?? 1,
    parent_message_id: overrides.parent_message_id ?? 'user-1',
    version_index: overrides.version_index ?? 0,
    is_active: overrides.is_active ?? true,
    status: overrides.status ?? 'complete',
    tokens_per_second: null,
    first_token_latency_ms: null,
  };
}

function readyResource(versions: Message[], revision = 1) {
  const key = getMessageVersionGroupResourceKey('conv-1', 'user-1');
  return {
    [key]: {
      conversationId: 'conv-1',
      parentMessageId: 'user-1',
      versions,
      error: null,
      meta: { status: 'ready' as const, key, loadedAt: 1, revision },
    },
  };
}

describe('useMessageVersionGroups', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    useConversationStore.setState({
      messageVersionGroups: {},
      ensureMessageVersionGroupsLoaded: vi.fn(async () => undefined),
    });
  });

  it('keeps snapshot membership while overlaying matching live messages', () => {
    const snapshotA = message({ id: 'answer-a', content: 'snapshot-a' });
    const snapshotB = message({
      id: 'answer-b',
      model_id: 'model-2',
      content: 'snapshot-b',
      is_active: false,
      version_index: 1,
    });
    const liveA = { ...snapshotA, content: 'live-a' };
    useConversationStore.setState({
      messageVersionGroups: readyResource([snapshotA, snapshotB]),
    });
    const retainedParents = new Set(['user-1']);
    const { result, rerender } = renderHook(
      ({ messages }: { messages: Message[] }) => useMessageVersionGroups({
        conversationId: 'conv-1',
        messages,
        visibleMessages: messages.filter((item) => item.is_active !== false),
        retainedParentMessageIds: retainedParents,
        multiModelParentId: null,
        pendingCompanionModelCount: 0,
        multiModelDoneMessageIds: [],
      }),
      { initialProps: { messages: [liveA] } },
    );

    expect(result.current.renderableVersionsByParentId['user-1'])
      .toEqual([liveA, snapshotB]);

    act(() => {
      useConversationStore.setState({
        messageVersionGroups: readyResource([snapshotA], 2),
      });
    });
    rerender({ messages: [liveA, snapshotB] });

    expect(result.current.renderableVersionsByParentId['user-1'])
      .toEqual([liveA]);
  });

  it('reloads an invalidated visible group and prunes it after it leaves the retained window', async () => {
    const snapshot = message({ id: 'answer-a' });
    const ensureLoaded = vi.fn(async () => undefined);
    useConversationStore.setState({
      messageVersionGroups: readyResource([snapshot]),
      ensureMessageVersionGroupsLoaded: ensureLoaded,
    });
    const { rerender } = renderHook(
      ({ retainedParents }: { retainedParents: ReadonlySet<string> }) => useMessageVersionGroups({
        conversationId: 'conv-1',
        messages: [snapshot],
        visibleMessages: [snapshot],
        retainedParentMessageIds: retainedParents,
        multiModelParentId: null,
        pendingCompanionModelCount: 0,
        multiModelDoneMessageIds: [],
      }),
      { initialProps: { retainedParents: new Set(['user-1']) } },
    );

    act(() => {
      useConversationStore.getState().invalidateMessageVersionGroups('conv-1', ['user-1']);
    });
    await waitFor(() => {
      expect(ensureLoaded).toHaveBeenCalledWith('conv-1', ['user-1']);
    });

    rerender({ retainedParents: new Set() });
    await waitFor(() => {
      expect(useConversationStore.getState().messageVersionGroups).toEqual({});
    });
  });
});
