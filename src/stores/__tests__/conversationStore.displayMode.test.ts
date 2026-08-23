import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Conversation, MultiModelDisplayMode } from '@/types';
import { deferred, flushPromises, makeConversation } from './conversationStore.testUtils';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => false,
}));

function conversation(
  id: string,
  mode: MultiModelDisplayMode | null,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    ...makeConversation(id),
    multi_model_display_mode_override: mode,
    ...overrides,
  } as Conversation;
}

describe('conversationStore multi-model display mode persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('optimistically updates a conversation and persists its display mode', async () => {
    const save = deferred<Conversation>();
    invokeMock.mockReturnValue(save.promise);
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation('conv-1', null)],
      archivedConversations: [],
      error: null,
    });

    const pending = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-1', 'side-by-side');

    expect(useConversationStore.getState().conversations[0]?.multi_model_display_mode_override)
      .toBe('side-by-side');
    await flushPromises();
    expect(invokeMock).toHaveBeenCalledWith('update_conversation', {
      id: 'conv-1',
      input: { multi_model_display_mode_override: 'side-by-side' },
    });

    save.resolve(conversation('conv-1', 'side-by-side'));
    await pending;
  });

  it('persists null when clearing a conversation display-mode override', async () => {
    invokeMock.mockResolvedValue(conversation('conv-1', null));
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation('conv-1', 'stacked')],
      archivedConversations: [],
    });

    await useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-1', null);

    expect(invokeMock).toHaveBeenCalledWith('update_conversation', {
      id: 'conv-1',
      input: { multi_model_display_mode_override: null },
    });
    expect(useConversationStore.getState().conversations[0]?.multi_model_display_mode_override)
      .toBeNull();
  });

  it('serializes writes for one conversation without letting an older completion overwrite the latest choice', async () => {
    const firstSave = deferred<Conversation>();
    const secondSave = deferred<Conversation>();
    invokeMock
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation('conv-1', null)],
      archivedConversations: [],
      error: null,
    });

    const first = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-1', 'tabs');
    const second = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-1', 'stacked');
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().conversations[0]?.multi_model_display_mode_override)
      .toBe('stacked');

    firstSave.resolve(conversation('conv-1', 'tabs'));
    await first;
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useConversationStore.getState().conversations[0]?.multi_model_display_mode_override)
      .toBe('stacked');

    secondSave.resolve(conversation('conv-1', 'stacked'));
    await second;
    expect(invokeMock.mock.calls.map(([, args]) => args.input.multi_model_display_mode_override))
      .toEqual(['tabs', 'stacked']);
  });

  it('keeps a newer optimistic choice when an older request fails', async () => {
    const firstSave = deferred<Conversation>();
    const secondSave = deferred<Conversation>();
    invokeMock
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation('conv-1', null)],
      archivedConversations: [],
      error: 'existing error',
    });

    const first = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-1', 'tabs');
    const second = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-1', 'stacked');
    await flushPromises();
    firstSave.reject(new Error('first save failed'));
    await expect(first).rejects.toThrow('first save failed');
    await flushPromises();

    expect(useConversationStore.getState().conversations[0]?.multi_model_display_mode_override)
      .toBe('stacked');
    expect(useConversationStore.getState().error).toBe('existing error');
    expect(invokeMock).toHaveBeenCalledTimes(2);

    secondSave.resolve(conversation('conv-1', 'stacked'));
    await second;
  });

  it('rolls the latest failed archived-conversation write back to the last confirmed value', async () => {
    const firstSave = deferred<Conversation>();
    const secondSave = deferred<Conversation>();
    invokeMock
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [],
      archivedConversations: [conversation('conv-1', null, { is_archived: true })],
      error: null,
    });

    const first = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-1', 'side-by-side');
    const second = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-1', 'stacked');
    expect(useConversationStore.getState().archivedConversations[0]?.multi_model_display_mode_override)
      .toBe('stacked');

    firstSave.resolve(conversation('conv-1', 'side-by-side', { is_archived: true }));
    await first;
    await flushPromises();
    secondSave.reject(new Error('latest save failed'));
    await expect(second).rejects.toThrow('latest save failed');

    expect(useConversationStore.getState().archivedConversations[0]?.multi_model_display_mode_override)
      .toBe('side-by-side');
    expect(useConversationStore.getState().error).toBeNull();
  });

  it('runs writes for different conversations in parallel', async () => {
    const firstConversationSave = deferred<Conversation>();
    const secondConversationSave = deferred<Conversation>();
    invokeMock.mockImplementation((_command: string, args: { id: string }) => (
      args.id === 'conv-a' ? firstConversationSave.promise : secondConversationSave.promise
    ));
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [conversation('conv-a', null), conversation('conv-b', null)],
      archivedConversations: [],
    });

    const first = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-a', 'tabs');
    const second = useConversationStore.getState()
      .setConversationMultiModelDisplayMode('conv-b', 'side-by-side');
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    firstConversationSave.resolve(conversation('conv-a', 'tabs'));
    secondConversationSave.resolve(conversation('conv-b', 'side-by-side'));
    await Promise.all([first, second]);
  });

  it('does not inherit the current conversation display mode when creating a conversation', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'create_conversation') {
        return Promise.resolve(conversation('conv-new', null));
      }
      if (command === 'update_conversation') {
        return Promise.resolve(conversation('conv-new', null));
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    const { useSettingsStore } = await import('../settingsStore');
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        inherit_conversation_preferences_on_create: true,
      },
    }));
    useConversationStore.setState({
      conversations: [conversation('conv-old', 'stacked')],
      activeConversationId: 'conv-old',
      archivedConversations: [],
    });

    await useConversationStore.getState().createConversation(
      'new conversation',
      'model-1',
      'provider-1',
    );

    const updateInput = invokeMock.mock.calls.find(([command]) => command === 'update_conversation')?.[1].input;
    expect(updateInput).not.toHaveProperty('multi_model_display_mode_override');
  });
});
