import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamTerminalEvent } from '../conversationStore';
import type { Message } from '@/types';
import {
  deferred,
  flushPromises,
  makeConversation,
  makeMessage,
  makePage,
} from './conversationStore.testUtils';

const invokeMock = vi.fn();
const listenMock = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
let tauriAvailable = true;
let sendSequence = 0;
let failNextSend = false;
let failNextRegeneration = false;

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: listenMock,
  isTauri: () => tauriAvailable,
}));

function sentContents(): string[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === 'send_message')
    .map(([, input]) => String(input.content));
}

async function emitTerminal(payload: ChatStreamTerminalEvent): Promise<void> {
  const listener = listeners.get('chat-stream-terminal');
  expect(listener).toBeTypeOf('function');
  listener?.({ payload });
  await flushPromises();
}

describe('conversationStore chat queue', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    listeners.clear();
    tauriAvailable = true;
    sendSequence = 0;
    failNextSend = false;
    failNextRegeneration = false;

    listenMock.mockImplementation(async (
      eventName: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      listeners.set(eventName, handler);
      return () => {
        if (listeners.get(eventName) === handler) listeners.delete(eventName);
      };
    });
    invokeMock.mockImplementation((command: string, input?: Record<string, unknown>) => {
      if (command === 'list_active_conversation_runs') {
        return Promise.resolve([]);
      }
      if (command === 'get_conversation_run_snapshot') {
        return Promise.resolve(null);
      }
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({
          conversationId: String(input?.conversationId ?? 'conv-a'),
          revision: 0,
          activeRun: null,
        });
      }
      if (command === 'send_message') {
        if (failNextSend) {
          failNextSend = false;
          return Promise.reject(new Error('dispatch unavailable'));
        }
        sendSequence += 1;
        const conversationId = String(input?.conversationId ?? 'conv-a');
        const message: Message = {
          ...makeMessage(sendSequence * 2 - 1, conversationId),
          content: String(input?.content ?? ''),
        };
        return Promise.resolve(message);
      }
      if (command === 'list_messages_page') {
        return Promise.resolve(makePage([], false));
      }
      if (command === 'regenerate_message') {
        if (failNextRegeneration) {
          failNextRegeneration = false;
          return Promise.reject(new Error('regeneration setup unavailable'));
        }
        return Promise.resolve(undefined);
      }
      if (command === 'cancel_stream') return Promise.resolve(undefined);
      throw new Error(`unexpected command: ${command}`);
    });

    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [makeConversation('conv-a'), makeConversation('conv-b')] as never[],
      activeConversationId: 'conv-a',
      messages: [],
      loading: false,
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      activeStreamId: null,
      observedStream: null,
      observedStreamsByConversation: {},
      runsByConversation: {},
      runWatermarksByConversation: {},
      multiModelTargets: [],
      chatQueueByConversation: {},
      error: null,
    });
  });

  it('dispatches one item at a time and advances FIFO only after complete sync', async () => {
    const { useConversationStore } = await import('../conversationStore');

    const first = await useConversationStore.getState().submitChatMessage('first');
    const second = await useConversationStore.getState().submitChatMessage('second');
    const third = await useConversationStore.getState().submitChatMessage('third');

    expect(first.kind).toBe('started');
    expect(second.kind).toBe('queued');
    expect(third.kind).toBe('queued');
    expect(sentContents()).toEqual(['first']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'dispatching',
      paused: false,
      messages: [
        { content: 'first', status: 'dispatching' },
        { content: 'second', status: 'queued' },
        { content: 'third', status: 'queued' },
      ],
    });

    const firstStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId;
    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: firstStreamId!,
      outcome: 'complete',
    });

    const invokedCommands = invokeMock.mock.calls.map((call) => String(call[0]));
    expect(invokedCommands.indexOf('list_messages_page'))
      .toBeLessThan(invokedCommands.lastIndexOf('send_message'));
    expect(sentContents()).toEqual(['first', 'second']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a'].messages.map((item) => ({
      content: item.content,
      status: item.status,
    }))).toEqual([
      { content: 'second', status: 'dispatching' },
      { content: 'third', status: 'queued' },
    ]);

    const secondStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId;
    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-2',
      stream_id: secondStreamId!,
      outcome: 'complete',
    });
    expect(sentContents()).toEqual(['first', 'second', 'third']);

    const thirdStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId;
    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-3',
      stream_id: thirdStreamId!,
      outcome: 'complete',
    });
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toBeUndefined();
  });

  it('shows an automatically dispatched item in the active conversation immediately', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const firstStreamId = useConversationStore.getState()
      .chatQueueByConversation['conv-a'].drainingStreamId!;

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: firstStreamId,
      outcome: 'complete',
    });

    const state = useConversationStore.getState();
    expect(sentContents()).toEqual(['first', 'second']);
    expect(state.messages).toContainEqual(expect.objectContaining({
      role: 'user',
      content: 'second',
    }));
    expect(state.messages).toContainEqual(expect.objectContaining({
      id: state.streamingMessageId,
      role: 'assistant',
      status: 'partial',
    }));
  });

  it('uses terminal as the only final refresh before automatically dispatching the next item', async () => {
    vi.useFakeTimers();
    const originalInvoke = invokeMock.getMockImplementation() as (
      command: string,
      input?: Record<string, unknown>,
    ) => unknown;
    const terminalSync = deferred<ReturnType<typeof makePage>>();
    const delayedChunkSync = deferred<ReturnType<typeof makePage>>();
    let messagePageCalls = 0;
    invokeMock.mockImplementation((command: string, input?: Record<string, unknown>) => {
      if (command === 'list_messages_page') {
        messagePageCalls += 1;
        return messagePageCalls === 1 ? terminalSync.promise : delayedChunkSync.promise;
      }
      return originalInvoke(command, input);
    });

    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const firstStreamId = useConversationStore.getState()
      .chatQueueByConversation['conv-a'].drainingStreamId!;
    const chunkListener = listeners.get('chat-stream-chunk');
    expect(chunkListener).toBeTypeOf('function');
    chunkListener?.({
      payload: {
        conversation_id: 'conv-a',
        message_id: 'assistant-1',
        stream_id: firstStreamId,
        model_id: 'model-1',
        provider_id: 'provider-1',
        chunk: {
          content: 'first reply',
          thinking: null,
          done: true,
          is_final: true,
          usage: null,
        },
      },
    });
    await flushPromises();

    const terminal = useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: firstStreamId,
      outcome: 'complete',
    });
    await flushPromises();
    expect(messagePageCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(120);
    await flushPromises();
    expect(messagePageCalls).toBe(1);

    const firstRound = [
      { ...makeMessage(1, 'conv-a'), content: 'first' },
      {
        ...makeMessage(2, 'conv-a'),
        id: 'assistant-1',
        content: 'first reply',
        parent_message_id: 'msg-1',
      },
    ];
    terminalSync.resolve(makePage(firstRound, false));
    await terminal;
    expect(sentContents()).toEqual(['first', 'second']);
    expect(useConversationStore.getState().messages).toContainEqual(expect.objectContaining({
      role: 'user',
      content: 'second',
    }));

    expect(useConversationStore.getState().messages).toContainEqual(expect.objectContaining({
      id: useConversationStore.getState().streamingMessageId,
      role: 'assistant',
      status: 'partial',
    }));
  });

  it('does not schedule a chunk refresh for a stopped queue-owned stream', async () => {
    vi.useFakeTimers();
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const firstStreamId = useConversationStore.getState()
      .chatQueueByConversation['conv-a'].drainingStreamId!;
    useConversationStore.setState({
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      activeStreamId: null,
    });

    listeners.get('chat-stream-chunk')?.({
      payload: {
        conversation_id: 'conv-a',
        message_id: 'assistant-1',
        stream_id: firstStreamId,
        model_id: 'model-1',
        provider_id: 'provider-1',
        chunk: {
          content: '',
          thinking: null,
          done: true,
          is_final: true,
          usage: null,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(80);
    await flushPromises();

    expect(invokeMock.mock.calls.filter(([command]) => command === 'list_messages_page'))
      .toHaveLength(0);
  });

  it('allows role conversations through the ordinary single-model queue', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [
        makeConversation('conv-a', { mode: 'role' }),
        makeConversation('conv-b'),
      ] as never[],
    });

    const result = await useConversationStore.getState().submitChatMessage('role prompt');

    expect(result.kind).toBe('started');
    expect(sentContents()).toEqual(['role prompt']);
  });

  it('retains a failed dispatch and retries the same item after resume', async () => {
    failNextSend = true;
    const { useConversationStore } = await import('../conversationStore');

    const result = await useConversationStore.getState().submitChatMessage('keep me');

    expect(result).toMatchObject({ kind: 'queued' });
    expect(sentContents()).toEqual(['keep me']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      paused: true,
      pauseReason: 'dispatch-error',
      error: 'Error: dispatch unavailable',
      messages: [{ content: 'keep me', status: 'failed', error: 'Error: dispatch unavailable' }],
    });

    await useConversationStore.getState().resumeChatQueue('conv-a');

    expect(sentContents()).toEqual(['keep me', 'keep me']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'dispatching',
      paused: false,
      messages: [{ content: 'keep me', status: 'dispatching', error: null }],
    });
  });

  it.each([
    { outcome: 'error' as const, pauseReason: 'error', error: 'provider failed' },
    { outcome: 'cancelled' as const, pauseReason: 'cancelled', error: null },
  ])('pauses the remaining FIFO on $outcome and resumes only by explicit action', async ({
    outcome,
    pauseReason,
    error,
  }) => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const streamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId;

    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: streamId!,
      outcome,
      error,
    });

    expect(sentContents()).toEqual(['first']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      paused: true,
      pauseReason,
      error,
      messages: [{ content: 'second', status: 'queued', error }],
    });

    await useConversationStore.getState().resumeChatQueue('conv-a');
    expect(sentContents()).toEqual(['first', 'second']);
  });

  it('keeps the remaining FIFO paused when a manual stop request misses the active guard', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const streamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;
    invokeMock.mockRejectedValueOnce(new Error('no matching active stream'));

    useConversationStore.getState().cancelCurrentStream();
    await flushPromises();

    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      paused: true,
      pauseReason: 'cancel-error',
      error: 'Error: no matching active stream',
    });

    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: streamId,
      outcome: 'complete',
    });

    expect(sentContents()).toEqual(['first']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      paused: true,
      pauseReason: 'cancel-error',
      messages: [{ content: 'second', status: 'queued' }],
    });
  });

  it('keeps a no-match retry paused until the original stream reaches terminal', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    invokeMock.mockRejectedValueOnce(new Error('cancel transport unavailable'));

    useConversationStore.getState().cancelCurrentStream();
    await flushPromises();
    const bucket = useConversationStore.getState().chatQueueByConversation['conv-a'];
    expect(bucket).toMatchObject({
      phase: 'paused',
      pauseReason: 'cancel-error',
    });
    invokeMock.mockRejectedValueOnce(new Error(
      'No active stream matched the cancellation request for conversation conv-a',
    ));

    expect(await useConversationStore.getState().sendQueuedChatMessageNow(
      'conv-a',
      bucket.messages[1].id,
    )).toBe(false);
    expect(sentContents()).toEqual(['first']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      paused: true,
      pauseReason: 'cancel-error',
      sendNowMessageId: bucket.messages[1].id,
    });

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: bucket.drainingStreamId!,
      outcome: 'complete',
    });
    expect(sentContents()).toEqual(['first', 'second']);
  });

  it('does not overlap dispatch when send-now cancellation misses a not-yet-registered stream', async () => {
    const { useConversationStore } = await import('../conversationStore');
    let resolveFirstSend!: (message: Message) => void;
    invokeMock.mockImplementation((command: string, input?: Record<string, unknown>) => {
      if (command === 'get_multi_model_run_snapshot') {
        return Promise.resolve({ conversationId: 'conv-a', revision: 0, activeRun: null });
      }
      if (command === 'send_message') {
        const content = String(input?.content ?? '');
        if (content === 'first pending') {
          return new Promise<Message>((resolve) => {
            resolveFirstSend = resolve;
          });
        }
        return Promise.resolve({ ...makeMessage(3, 'conv-a'), content });
      }
      if (command === 'cancel_stream') {
        return Promise.reject(new Error(
          'No active stream matched the cancellation request for conversation conv-a',
        ));
      }
      if (command === 'list_messages_page') return Promise.resolve(makePage([], false));
      throw new Error(`unexpected command: ${command}`);
    });
    const firstSubmission = useConversationStore.getState().submitChatMessage('first pending');
    await flushPromises();
    const second = await useConversationStore.getState().submitChatMessage('second waiting');
    if (second.kind !== 'queued') return;
    const firstBucket = useConversationStore.getState().chatQueueByConversation['conv-a'];
    expect(await useConversationStore.getState().sendQueuedChatMessageNow(
      'conv-a',
      second.queueId,
    )).toBe(false);
    expect(sentContents()).toEqual(['first pending']);
    resolveFirstSend({
      ...makeMessage(1, 'conv-a'),
      content: 'first pending',
    });
    await firstSubmission;
    expect(sentContents()).toEqual(['first pending']);

    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-pending',
      stream_id: firstBucket.drainingStreamId!,
      outcome: 'complete',
    });
    expect(sentContents()).toEqual(['first pending', 'second waiting']);
  });

  it('does not dequeue or advance on stream chunks without a terminal event', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const state = useConversationStore.getState();
    const streamId = state.chatQueueByConversation['conv-a'].drainingStreamId!;
    const messageId = state.streamingMessageId!;
    const onChunk = listeners.get('chat-stream-chunk');
    expect(onChunk).toBeTypeOf('function');

    onChunk?.({
      payload: {
        conversation_id: 'conv-a',
        message_id: messageId,
        stream_id: streamId,
        chunk: {
          content: 'partial',
          thinking: null,
          tool_calls: null,
          done: false,
          usage: null,
        },
      },
    });
    onChunk?.({
      payload: {
        conversation_id: 'conv-a',
        message_id: messageId,
        stream_id: streamId,
        chunk: {
          content: '',
          thinking: null,
          tool_calls: null,
          done: true,
          is_final: true,
          usage: null,
        },
      },
    });
    await flushPromises();

    expect(sentContents()).toEqual(['first']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a'].messages.map((item) => item.content))
      .toEqual(['first', 'second']);
  });

  it('does not advance after complete until a failed final sync is retried', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const streamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;
    invokeMock.mockRejectedValueOnce(new Error('final sync unavailable'));

    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: streamId,
      outcome: 'complete',
    });

    expect(sentContents()).toEqual(['first']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'ready',
      messages: [{ content: 'second', status: 'queued' }],
    });
    await useConversationStore.getState().submitChatMessage('third');
    expect(sentContents()).toEqual(['first']);

    useConversationStore.getState().setActiveConversation('conv-a');
    await flushPromises();

    expect(sentContents()).toEqual(['first', 'second']);
  });

  it('edits, removes, and immediately promotes a queued item without duplicating dispatch', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    const second = await useConversationStore.getState().submitChatMessage('second');
    const third = await useConversationStore.getState().submitChatMessage('third');
    expect(second.kind).toBe('queued');
    expect(third.kind).toBe('queued');
    if (second.kind !== 'queued' || third.kind !== 'queued') return;

    expect(useConversationStore.getState().updateQueuedChatMessage('conv-a', second.queueId, {
      content: 'second edited',
    })).toBe(true);
    expect(useConversationStore.getState().removeQueuedChatMessage('conv-a', second.queueId)).toBe(true);
    expect(await useConversationStore.getState().sendQueuedChatMessageNow('conv-a', third.queueId)).toBe(true);
    expect(sentContents()).toEqual(['first']);
    expect(invokeMock).toHaveBeenCalledWith('cancel_stream', expect.objectContaining({
      conversationId: 'conv-a',
    }));

    const bucket = useConversationStore.getState().chatQueueByConversation['conv-a'];
    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: bucket.drainingStreamId!,
      outcome: 'cancelled',
    });

    expect(sentContents()).toEqual(['first', 'third']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'dispatching',
      paused: false,
      messages: [{ content: 'third', status: 'dispatching' }],
    });
  });

  it('keeps relative order around a promoted middle item and retains it if cancel IPC rejects', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const third = await useConversationStore.getState().submitChatMessage('third');
    await useConversationStore.getState().submitChatMessage('fourth');
    if (third.kind !== 'queued') return;

    invokeMock.mockRejectedValueOnce(new Error('cancel IPC unavailable'));
    expect(await useConversationStore.getState().sendQueuedChatMessageNow('conv-a', third.queueId)).toBe(false);

    let bucket = useConversationStore.getState().chatQueueByConversation['conv-a'];
    expect(bucket.messages.map((message) => message.content)).toEqual([
      'first',
      'third',
      'second',
      'fourth',
    ]);
    expect(bucket).toMatchObject({
      phase: 'paused',
      paused: true,
      pauseReason: 'cancel-error',
      error: 'Error: cancel IPC unavailable',
      sendNowMessageId: third.queueId,
    });
    expect(useConversationStore.getState().streaming).toBe(true);
    expect(sentContents()).toEqual(['first']);

    // The failed cancellation leaves the original stream running. Once it
    // completes naturally, the promoted item can safely start without loss.
    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: bucket.drainingStreamId!,
      outcome: 'complete',
    });

    bucket = useConversationStore.getState().chatQueueByConversation['conv-a'];
    expect(sentContents()).toEqual(['first', 'third']);
    expect(bucket.messages.map((message) => message.content)).toEqual(['third', 'second', 'fourth']);
    expect(bucket.messages[0]?.status).toBe('dispatching');
  });

  it('does not clear a newly dispatched stream when cancelled terminal wins the IPC race', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    const second = await useConversationStore.getState().submitChatMessage('second');
    if (second.kind !== 'queued') return;
    const oldStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;
    let resolveCancellation!: () => void;
    invokeMock.mockImplementationOnce((command: string) => {
      expect(command).toBe('cancel_stream');
      return new Promise<void>((resolve) => {
        resolveCancellation = resolve;
      });
    });

    const promotePromise = useConversationStore.getState().sendQueuedChatMessageNow(
      'conv-a',
      second.queueId,
    );
    await flushPromises();
    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: oldStreamId,
      outcome: 'cancelled',
    });
    resolveCancellation();

    expect(await promotePromise).toBe(true);
    const state = useConversationStore.getState();
    expect(state.streaming).toBe(true);
    expect(state.activeStreamId).not.toBe(oldStreamId);
    expect(state.chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'dispatching',
      messages: [{ content: 'second', status: 'dispatching' }],
    });
  });

  it('keeps a stopped stream as the blocker until its cancelled terminal arrives', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const third = await useConversationStore.getState().submitChatMessage('third');
    if (third.kind !== 'queued') return;
    const oldStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;

    useConversationStore.getState().cancelCurrentStream();
    expect(useConversationStore.getState().streaming).toBe(false);
    expect(await useConversationStore.getState().sendQueuedChatMessageNow('conv-a', third.queueId)).toBe(true);
    expect(sentContents()).toEqual(['first']);

    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: oldStreamId,
      outcome: 'cancelled',
    });

    expect(sentContents()).toEqual(['first', 'third']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'dispatching',
      messages: [
        { content: 'third', status: 'dispatching' },
        { content: 'second', status: 'queued' },
      ],
    });
  });

  it('creates an empty blocker when Stop happens before the first queued message', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      streaming: true,
      streamingMessageId: 'direct-assistant',
      streamingConversationId: 'conv-a',
      activeStreamId: 'direct-stream',
      chatQueueByConversation: {},
    });

    useConversationStore.getState().cancelCurrentStream();
    const result = await useConversationStore.getState().submitChatMessage('submitted after stop');

    expect(result.kind).toBe('queued');
    expect(sentContents()).toEqual([]);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'waiting',
      drainingMessageId: null,
      drainingStreamId: 'direct-stream',
      messages: [{ content: 'submitted after stop', status: 'queued' }],
    });

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'direct-assistant',
      stream_id: 'direct-stream',
      outcome: 'cancelled',
    });
    await flushPromises();

    expect(sentContents()).toEqual([]);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      pauseReason: 'cancelled',
      messages: [{ content: 'submitted after stop', status: 'queued' }],
    });
  });

  it('keeps an empty stopped-stream blocker after deleting its last queued item', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      streaming: true,
      streamingMessageId: 'direct-assistant',
      streamingConversationId: 'conv-a',
      activeStreamId: 'direct-stream',
    });

    useConversationStore.getState().cancelCurrentStream();
    const firstQueued = await useConversationStore.getState().submitChatMessage('delete me');
    if (firstQueued.kind !== 'queued') return;
    expect(useConversationStore.getState().removeQueuedChatMessage('conv-a', firstQueued.queueId)).toBe(true);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'waiting',
      drainingStreamId: 'direct-stream',
      messages: [],
    });

    const secondQueued = await useConversationStore.getState().submitChatMessage('must still wait');
    expect(secondQueued.kind).toBe('queued');
    expect(sentContents()).toEqual([]);

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'direct-assistant',
      stream_id: 'direct-stream',
      outcome: 'cancelled',
    });
    await flushPromises();
    expect(sentContents()).toEqual([]);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      pauseReason: 'cancelled',
      messages: [{ content: 'must still wait', status: 'queued' }],
    });
  });

  it('refreshes final messages on a terminal event even when no queue exists', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      streaming: true,
      streamingMessageId: 'direct-assistant',
      streamingConversationId: 'conv-a',
      activeStreamId: 'direct-stream',
      chatQueueByConversation: {},
    });

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'direct-assistant',
      stream_id: 'direct-stream',
      outcome: 'complete',
    });

    expect(invokeMock).toHaveBeenCalledWith('list_messages_page', expect.objectContaining({
      conversationId: 'conv-a',
    }));
    expect(useConversationStore.getState()).toMatchObject({
      streaming: false,
      activeStreamId: null,
    });
  });

  it('clears a pending refresh after terminal sync before advancing the queue', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { conversationRuntime } = await import('../conversationStoreSupport');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const streamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;
    conversationRuntime.pendingConversationRefresh.add('conv-a');

    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: streamId,
      outcome: 'complete',
    });

    expect(conversationRuntime.pendingConversationRefresh.has('conv-a')).toBe(false);
    expect(sentContents()).toEqual(['first', 'second']);
  });

  it('ignores a stale terminal after a newer observed stream takes over the queue blocker', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { bindWaitingChatQueueToStream } = await import('../conversationStoreQueueActions');
    useConversationStore.setState({
      observedStream: {
        conversationId: 'conv-a',
        streaming: true,
        streamId: 'old-stream',
        streamingMessageId: 'old-assistant',
        multiModelParentId: null,
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
    });
    await useConversationStore.getState().submitChatMessage('wait for latest');
    useConversationStore.setState({
      observedStream: {
        conversationId: 'conv-a',
        streaming: true,
        streamId: 'new-stream',
        streamingMessageId: 'new-assistant',
        multiModelParentId: null,
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
    });
    bindWaitingChatQueueToStream(useConversationStore.setState, 'conv-a', 'new-stream');

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'old-assistant',
      stream_id: 'old-stream',
      outcome: 'complete',
    });
    expect(useConversationStore.getState().observedStream?.streamId).toBe('new-stream');
    expect(sentContents()).toEqual([]);

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'new-assistant',
      stream_id: 'new-stream',
      outcome: 'complete',
    });
    expect(sentContents()).toEqual(['wait for latest']);
  });

  it('does not let an older terminal sync overtake a newly-bound direct stream', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { bindWaitingChatQueueToStream } = await import('../conversationStoreQueueActions');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const oldStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;
    let resolveFinalSync!: (page: ReturnType<typeof makePage>) => void;
    invokeMock.mockImplementationOnce((command: string) => {
      expect(command).toBe('list_messages_page');
      return new Promise((resolve) => {
        resolveFinalSync = resolve;
      });
    });

    const oldTerminal = useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: oldStreamId,
      outcome: 'complete',
    });
    await flushPromises();
    useConversationStore.setState({
      streaming: true,
      streamingMessageId: 'direct-assistant',
      streamingConversationId: 'conv-a',
      activeStreamId: 'direct-stream',
    });
    bindWaitingChatQueueToStream(useConversationStore.setState, 'conv-a', 'direct-stream');
    resolveFinalSync(makePage([], false));
    await oldTerminal;

    expect(sentContents()).toEqual(['first']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId)
      .toBe('direct-stream');

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'direct-assistant',
      stream_id: 'direct-stream',
      outcome: 'complete',
    });
    expect(sentContents()).toEqual(['first', 'second']);
  });

  it('does not re-cancel a released stream while its terminal message sync is pending', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    const second = await useConversationStore.getState().submitChatMessage('second');
    if (second.kind !== 'queued') return;
    const streamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;
    let resolveFinalSync!: (page: ReturnType<typeof makePage>) => void;
    invokeMock.mockImplementationOnce((command: string) => {
      expect(command).toBe('list_messages_page');
      return new Promise((resolve) => {
        resolveFinalSync = resolve;
      });
    });

    const terminal = useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: streamId,
      outcome: 'complete',
    });
    await flushPromises();
    expect(await useConversationStore.getState().sendQueuedChatMessageNow(
      'conv-a',
      second.queueId,
    )).toBe(true);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'cancel_stream')).toHaveLength(0);

    resolveFinalSync(makePage([], false));
    await terminal;
    expect(sentContents()).toEqual(['first', 'second']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'dispatching',
      paused: false,
      error: null,
    });
  });

  it('clears a direct-stream blocker while preserving an already-paused queue', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const { bindWaitingChatQueueToStream } = await import('../conversationStoreQueueActions');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const firstStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;
    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: firstStreamId,
      outcome: 'error',
      error: 'provider failed',
    });
    useConversationStore.setState({
      streaming: true,
      streamingMessageId: 'direct-assistant',
      streamingConversationId: 'conv-a',
      activeStreamId: 'direct-stream',
    });
    bindWaitingChatQueueToStream(useConversationStore.setState, 'conv-a', 'direct-stream');

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'direct-assistant',
      stream_id: 'direct-stream',
      outcome: 'complete',
    });
    const pausedBucket = useConversationStore.getState().chatQueueByConversation['conv-a'];
    expect(pausedBucket).toMatchObject({
      phase: 'paused',
      pauseReason: 'error',
      drainingStreamId: null,
      messages: [{ content: 'second', status: 'queued' }],
    });

    expect(await useConversationStore.getState().sendQueuedChatMessageNow(
      'conv-a',
      pausedBucket.messages[0].id,
    )).toBe(true);
    expect(sentContents()).toEqual(['first', 'second']);
  });

  it('does not let a late Stop rejection pause a newer resumed queue stream', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    await useConversationStore.getState().submitChatMessage('second');
    const oldStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId!;
    let rejectCancellation!: (error: Error) => void;
    invokeMock.mockImplementationOnce((command: string) => {
      expect(command).toBe('cancel_stream');
      return new Promise((_, reject) => {
        rejectCancellation = reject;
      });
    });

    useConversationStore.getState().cancelCurrentStream();
    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: oldStreamId,
      outcome: 'cancelled',
    });
    await useConversationStore.getState().resumeChatQueue('conv-a');
    rejectCancellation(new Error('late cancellation rejection'));
    await flushPromises();

    expect(sentContents()).toEqual(['first', 'second']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'dispatching',
      paused: false,
      messages: [{ content: 'second', status: 'dispatching' }],
    });
  });

  it('pauses and releases a waiting queue when regeneration setup fails before a terminal', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const userMessage = makeMessage(1, 'conv-a');
    const assistantMessage = {
      ...makeMessage(2, 'conv-a'),
      parent_message_id: userMessage.id,
    };
    useConversationStore.setState({ messages: [userMessage, assistantMessage] });
    failNextRegeneration = true;

    const regeneration = useConversationStore.getState().regenerateMessage(assistantMessage.id);
    const queued = await useConversationStore.getState().submitChatMessage('after regeneration');
    expect(queued.kind).toBe('queued');
    await regeneration;
    await flushPromises();

    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      paused: true,
      pauseReason: 'error',
      error: 'Error: regeneration setup unavailable',
      drainingStreamId: null,
      messages: [{ content: 'after regeneration', status: 'queued' }],
    });
    expect(sentContents()).toEqual([]);
  });

  it('does not bypass an error terminal even when send-now was requested', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('first');
    const second = await useConversationStore.getState().submitChatMessage('second');
    if (second.kind !== 'queued') return;

    await useConversationStore.getState().sendQueuedChatMessageNow('conv-a', second.queueId);
    const bucket = useConversationStore.getState().chatQueueByConversation['conv-a'];
    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-1',
      stream_id: bucket.drainingStreamId!,
      outcome: 'error',
      error: 'cancel raced with provider error',
    });

    expect(sentContents()).toEqual(['first']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'paused',
      pauseReason: 'error',
      messages: [{ content: 'second', status: 'queued' }],
    });
  });

  it('snapshots attachments and search settings when enqueueing behind a local stream', async () => {
    const { useConversationStore } = await import('../conversationStore');
    const attachments = [{
      file_name: 'draft.txt',
      file_type: 'text/plain',
      file_size: 4,
      data: 'data',
    }];
    useConversationStore.setState({
      streaming: true,
      streamingConversationId: 'conv-a',
      streamingMessageId: 'legacy-assistant',
      activeStreamId: 'legacy-stream',
    });

    const result = await useConversationStore.getState().submitChatMessage(
      'queued with file',
      attachments,
      'search-provider',
    );
    attachments[0].file_name = 'mutated.txt';
    attachments[0].data = 'changed';
    attachments.push({
      file_name: 'extra.txt',
      file_type: 'text/plain',
      file_size: 1,
      data: 'x',
    });

    expect(result.kind).toBe('queued');
    expect(sentContents()).toEqual([]);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'waiting',
      messages: [{
        content: 'queued with file',
        searchProviderId: 'search-provider',
        attachments: [{ file_name: 'draft.txt', data: 'data' }],
      }],
    });
  });

  it('queues behind an observed stream without starting a competing local dispatch', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      observedStream: {
        conversationId: 'conv-a',
        streaming: true,
        streamId: 'remote-stream',
        streamingMessageId: 'remote-assistant',
        multiModelParentId: null,
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
    });

    const result = await useConversationStore.getState().submitChatMessage('wait for remote');

    expect(result.kind).toBe('queued');
    expect(sentContents()).toEqual([]);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'waiting',
      messages: [{ content: 'wait for remote', status: 'queued' }],
    });
    if (result.kind !== 'queued') return;
    expect(await useConversationStore.getState().sendQueuedChatMessageNow('conv-a', result.queueId)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('cancel_stream', {
      conversationId: 'conv-a',
      streamId: 'remote-stream',
    });

    await useConversationStore.getState().handleChatStreamTerminal({
      conversation_id: 'conv-a',
      message_id: 'remote-assistant',
      stream_id: 'remote-stream',
      outcome: 'complete',
    });
    await flushPromises();

    expect(useConversationStore.getState().observedStream).toBeNull();
    expect(sentContents()).toEqual(['wait for remote']);
  });

  it('lets another conversation send while the first conversation keeps generating', async () => {
    const { useConversationStore } = await import('../conversationStore');
    await useConversationStore.getState().submitChatMessage('a-first');
    await useConversationStore.getState().submitChatMessage('a-second');
    const aStreamId = useConversationStore.getState().chatQueueByConversation['conv-a'].drainingStreamId;

    useConversationStore.setState({ activeConversationId: 'conv-b', messages: [] });
    const startedB = await useConversationStore.getState().submitChatMessage('b-draft');
    expect(startedB.kind).toBe('started');
    expect(sentContents()).toEqual(['a-first', 'b-draft']);
    expect(useConversationStore.getState().runsByConversation['conv-a']).toBeTruthy();
    expect(useConversationStore.getState().runsByConversation['conv-b']).toBeTruthy();

    await emitTerminal({
      conversation_id: 'conv-a',
      message_id: 'assistant-a',
      stream_id: aStreamId!,
      outcome: 'complete',
    });
    await flushPromises();

    expect(sentContents()).toEqual(['a-first', 'b-draft', 'a-second']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toMatchObject({
      phase: 'dispatching',
      messages: [{ content: 'a-second', status: 'dispatching' }],
    });
  });

  it('drains the visible conversation queue while another conversation is still generating', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-b',
      streaming: true,
      streamingMessageId: 'assistant-a',
      streamingConversationId: 'conv-a',
      activeStreamId: 'stream-a',
      runsByConversation: {
        'conv-a': {
          conversationId: 'conv-a',
          runId: 'stream-a',
          streamId: 'stream-a',
          streamingMessageId: 'assistant-a',
          phase: 'streaming',
          mode: 'chat',
          revision: 1,
          multiModelParentId: null,
          pendingCompanionModels: [],
          multiModelDoneMessageIds: [],
        },
      },
      chatQueueByConversation: {
        'conv-b': {
          messages: [{
            id: 'b-ready',
            conversationId: 'conv-b',
            content: 'b-ready-message',
            attachments: [],
            searchProviderId: null,
            status: 'queued',
            error: null,
            createdAt: 1,
            updatedAt: 1,
          }],
          phase: 'ready',
          paused: false,
          pauseReason: null,
          error: null,
          drainingMessageId: null,
          drainingStreamId: null,
          sendNowMessageId: null,
        },
      },
    });

    await useConversationStore.getState().drainChatQueue('conv-b');
    await flushPromises();

    expect(sentContents()).toEqual(['b-ready-message']);
    expect(useConversationStore.getState().chatQueueByConversation['conv-b']).toMatchObject({
      phase: 'dispatching',
      messages: [{ content: 'b-ready-message', status: 'dispatching' }],
    });
  });

  it('does not block a ready queue because another conversation is observed streaming', async () => {
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-b',
      observedStream: {
        conversationId: 'conv-a',
        streaming: true,
        streamId: 'remote-a',
        streamingMessageId: 'remote-assistant-a',
        multiModelParentId: null,
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
      chatQueueByConversation: {
        'conv-b': {
          messages: [{
            id: 'b-ready',
            conversationId: 'conv-b',
            content: 'wait for remote a',
            attachments: [],
            searchProviderId: null,
            status: 'queued',
            error: null,
            createdAt: 1,
            updatedAt: 1,
          }],
          phase: 'ready',
          paused: false,
          pauseReason: null,
          error: null,
          drainingMessageId: null,
          drainingStreamId: null,
          sendNowMessageId: null,
        },
      },
    });

    await useConversationStore.getState().drainChatQueue('conv-b');
    expect(sentContents()).toEqual(['wait for remote a']);
  });

  it('uses the same complete transition in browser mode so queued work continues', async () => {
    vi.useFakeTimers();
    tauriAvailable = false;
    const { useConversationStore } = await import('../conversationStore');

    const firstPromise = useConversationStore.getState().submitChatMessage('browser-first');
    await flushPromises();
    const second = await useConversationStore.getState().submitChatMessage('browser-second');
    expect(second.kind).toBe('queued');

    await vi.advanceTimersByTimeAsync(600);
    await firstPromise;
    await flushPromises();
    expect(sentContents()).toEqual(['browser-first', 'browser-second']);

    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    expect(useConversationStore.getState().chatQueueByConversation['conv-a']).toBeUndefined();
    vi.useRealTimers();
  });
});
