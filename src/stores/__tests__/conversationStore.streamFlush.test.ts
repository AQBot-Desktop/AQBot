import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMessage } from './conversationStore.testUtils';

const STREAM_UI_FLUSH_INTERVAL_MS = 32;
const MODEL_COUNT = 6;

function assistantMessage(index: number) {
  return {
    ...makeMessage(index + 2),
    id: `assistant-${index}`,
    role: 'assistant' as const,
    content: '',
    status: 'partial' as const,
    parent_message_id: 'user-1',
    provider_id: `provider-${index}`,
    model_id: `model-${index}`,
    version_index: index,
    is_active: index === 0,
  };
}

describe('conversationStore multi-model stream flush scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    const { useConversationStore } = await import('../conversationStore');
    const support = await import('../conversationStoreSupport');
    support.conversationRuntime.isMultiModelActive = true;
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      streaming: true,
      streamingConversationId: 'conv-1',
      streamingMessageId: 'assistant-0',
      multiModelParentId: 'user-1',
      pendingCompanionModels: Array.from({ length: MODEL_COUNT }, (_, index) => ({
        providerId: `provider-${index}`,
        modelId: `model-${index}`,
      })),
      messages: [
        { ...makeMessage(1), id: 'user-1', role: 'user', content: 'prompt' },
        ...Array.from({ length: MODEL_COUNT }, (_, index) => assistantMessage(index)),
      ],
    });
    return { useConversationStore, support };
  }

  function appendAll(
    support: Awaited<ReturnType<typeof setup>>['support'],
    useConversationStore: Awaited<ReturnType<typeof setup>>['useConversationStore'],
    contents: string[],
  ) {
    contents.forEach((content, index) => {
      support.appendStreamChunk(
        useConversationStore.setState,
        useConversationStore.getState,
        `assistant-${index}`,
        content,
        'conv-1',
        `model-${index}`,
        `provider-${index}`,
      );
    });
  }

  it('shows each model first chunk immediately and then flushes one model per 32ms', async () => {
    const { useConversationStore, support } = await setup();
    const updates = new Map<string, number>();
    for (let index = 0; index < MODEL_COUNT; index += 1) {
      const messageId = `assistant-${index}`;
      updates.set(messageId, 0);
      support.subscribeLiveStreamContent(messageId, () => {
        updates.set(messageId, (updates.get(messageId) ?? 0) + 1);
      });
    }

    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, (_, index) => `A${index}`));

    for (let index = 0; index < MODEL_COUNT; index += 1) {
      expect(support.getLiveStreamContent(`assistant-${index}`)).toBe(`A${index}`);
      expect(updates.get(`assistant-${index}`)).toBe(1);
    }

    const secondWave = Array.from({ length: MODEL_COUNT }, (_, index) => `B${index}`);
    for (let round = 0; round < 10; round += 1) {
      appendAll(support, useConversationStore, secondWave);
    }

    for (let index = 0; index < MODEL_COUNT; index += 1) {
      expect(support.getLiveStreamContent(`assistant-${index}`)).toBe(`A${index}`);
      expect(updates.get(`assistant-${index}`)).toBe(1);
    }

    await vi.advanceTimersByTimeAsync(STREAM_UI_FLUSH_INTERVAL_MS);
    expect(support.getLiveStreamContent('assistant-0')).toBe(`A0${'B0'.repeat(10)}`);
    expect(updates.get('assistant-0')).toBe(2);
    for (let index = 1; index < MODEL_COUNT; index += 1) {
      expect(support.getLiveStreamContent(`assistant-${index}`)).toBe(`A${index}`);
      expect(updates.get(`assistant-${index}`)).toBe(1);
    }

    for (let step = 1; step < MODEL_COUNT; step += 1) {
      await vi.advanceTimersByTimeAsync(STREAM_UI_FLUSH_INTERVAL_MS);
      expect(support.getLiveStreamContent(`assistant-${step}`)).toBe(`A${step}${`B${step}`.repeat(10)}`);
    }

    for (let index = 0; index < MODEL_COUNT; index += 1) {
      expect(support.getLiveStreamContent(`assistant-${index}`)).toBe(`A${index}${`B${index}`.repeat(10)}`);
    }
  });

  it('requeues a model at the tail when more chunks arrive after its turn', async () => {
    const { useConversationStore, support } = await setup();
    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, () => 'A'));
    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, () => 'B'));

    await vi.advanceTimersByTimeAsync(STREAM_UI_FLUSH_INTERVAL_MS);
    expect(support.getLiveStreamContent('assistant-0')).toBe('AB');
    support.appendStreamChunk(
      useConversationStore.setState,
      useConversationStore.getState,
      'assistant-0',
      'C',
      'conv-1',
      'model-0',
      'provider-0',
    );

    await vi.advanceTimersByTimeAsync(STREAM_UI_FLUSH_INTERVAL_MS);
    expect(support.getLiveStreamContent('assistant-1')).toBe('AB');
    expect(support.getLiveStreamContent('assistant-0')).toBe('AB');

    await vi.advanceTimersByTimeAsync(STREAM_UI_FLUSH_INTERVAL_MS * 5);
    expect(support.getLiveStreamContent('assistant-0')).toBe('ABC');
    for (let index = 1; index < MODEL_COUNT; index += 1) {
      expect(support.getLiveStreamContent(`assistant-${index}`)).toBe('AB');
    }
  });

  it('flushes only the completed model and keeps other pending content', async () => {
    const { useConversationStore, support } = await setup();
    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, () => 'A'));
    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, () => 'B'));

    support.flushPendingStreamChunk(
      useConversationStore.setState,
      useConversationStore.getState,
      'assistant-2',
    );

    expect(support.getLiveStreamContent('assistant-2')).toBe('AB');
    expect(support.getLiveStreamContent('assistant-0')).toBe('A');
    expect(support.getLiveStreamContent('assistant-1')).toBe('A');
    expect([...support.conversationRuntime.pendingUiChunks.keys()]).toEqual([
      'assistant-0',
      'assistant-1',
      'assistant-3',
      'assistant-4',
      'assistant-5',
    ]);
    expect(support.collectActiveStreamingMessageIds(useConversationStore.getState(), 'conv-1'))
      .toEqual(expect.arrayContaining([
        'assistant-0',
        'assistant-1',
        'assistant-2',
        'assistant-3',
        'assistant-4',
        'assistant-5',
      ]));
  });

  it('flushes every pending model on global cancel and does not leave a timer', async () => {
    const { useConversationStore, support } = await setup();
    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, () => 'A'));
    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, () => 'B'));

    useConversationStore.getState().cancelCurrentStream();

    for (let index = 0; index < MODEL_COUNT; index += 1) {
      expect(useConversationStore.getState().messages.find((message) => message.id === `assistant-${index}`)?.content)
        .toBe('AB');
    }
    expect(support.conversationRuntime.pendingUiChunks.size).toBe(0);
    expect(support.conversationRuntime.streamUiFlushTimer).toBeNull();

    const before = support.getLiveStreamContent('assistant-0');
    await vi.advanceTimersByTimeAsync(STREAM_UI_FLUSH_INTERVAL_MS * MODEL_COUNT);
    expect(support.getLiveStreamContent('assistant-0')).toBe(before);
  });

  it('resetPendingStreamUi drops pending chunks and cancels the timer', async () => {
    const { useConversationStore, support } = await setup();
    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, () => 'A'));
    appendAll(support, useConversationStore, Array.from({ length: MODEL_COUNT }, () => 'B'));

    support.resetPendingStreamUi();

    expect(support.conversationRuntime.pendingUiChunks.size).toBe(0);
    expect(support.conversationRuntime.streamUiFlushTimer).toBeNull();
    for (let index = 0; index < MODEL_COUNT; index += 1) {
      expect(support.getLiveStreamContent(`assistant-${index}`)).toBe('A');
    }
    await vi.advanceTimersByTimeAsync(STREAM_UI_FLUSH_INTERVAL_MS * MODEL_COUNT);
    for (let index = 0; index < MODEL_COUNT; index += 1) {
      expect(support.getLiveStreamContent(`assistant-${index}`)).toBe('A');
    }
  });
});
