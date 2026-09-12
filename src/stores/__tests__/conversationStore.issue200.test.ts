import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConversation, makeMessage, makePage, makeWindow } from './conversationStore.testUtils';

const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  isTauri: () => false,
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    listeners.set(name, listener);
    return () => { listeners.delete(name); };
  }),
}));

async function setup() {
  const { useConversationStore: store } = await import('../conversationStore');
  const user = { ...makeMessage(1), id: 'z-user', created_at: 1000 };
  const assistant = {
    ...makeMessage(2), id: 'a-assistant', parent_message_id: user.id,
    created_at: 1000, status: 'partial' as const, content: 'live answer',
  };
  store.setState({
    activeConversationId: 'conv-1',
    conversations: [{ ...makeConversation('conv-1', { message_count: 2 }), multi_model_display_mode_override: null }],
    messages: [user, assistant],
  });
  return { store, user, assistant };
}

async function startRun(store: Awaited<ReturnType<typeof setup>>['store'], messageId: string) {
  const { createConversationRun, upsertConversationRun } = await import('../conversationRunRegistry');
  store.setState(state => upsertConversationRun(state, createConversationRun({
    conversationId: 'conv-1', runId: 'run-1', streamId: 'stream-1',
    streamingMessageId: messageId, mode: 'agent', phase: 'streaming', revision: 1,
  })));
}

describe('issue 200 version snapshots and message order', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listeners.clear();
    localStorage.clear();
    invokeMock.mockImplementation(async (command: string) => {
      throw new Error(`Unexpected invoke: ${command}`);
    });
  });

  it('loads only persisted parents, including forced requests, without caching temporary parents', async () => {
    const { store, user, assistant } = await setup();
    invokeMock.mockImplementation(async (_command: string, args: { parentMessageIds: string[] }) =>
      Object.fromEntries(args.parentMessageIds.map(id => [id, id === user.id ? [assistant] : []])));
    await store.getState().ensureMessageVersionGroupsLoaded('conv-1', ['temp-user-run', user.id, user.id]);
    await store.getState().ensureMessageVersionGroupsLoaded('conv-1', ['temp-user-run'], { force: true });

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('list_message_versions_batch', {
      conversationId: 'conv-1', parentMessageIds: [user.id],
    });
    expect(Object.values(store.getState().messageVersionGroups).map(group => group.parentMessageId))
      .toEqual([user.id]);
  });

  it('keeps a real live assistant missing from a delayed snapshot, then honors an empty snapshot after completion', async () => {
    const { store, user, assistant } = await setup();
    const { clearConversationRun } = await import('../conversationRunRegistry');
    const { setLiveStreamContent } = await import('../conversationStoreSupport');
    const old = { ...assistant, id: 'old-assistant', content: 'stale', status: 'complete' as const };
    store.setState({ messages: [user, old, assistant] });
    setLiveStreamContent(old.id, 'leftover cache');
    await startRun(store, assistant.id);

    store.getState().applyMessageVersionSnapshot('conv-1', user.id, []);
    expect(store.getState().messages).toEqual([user, assistant]);

    store.setState(state => clearConversationRun(state, 'conv-1', 'stream-1'));
    store.getState().applyMessageVersionSnapshot('conv-1', user.id, []);
    expect(store.getState().messages).toEqual([user]);
  });

  it('does not retain missing messages from a different parent or another conversation run', async () => {
    const { store, user, assistant } = await setup();
    const other = { ...assistant, id: 'other-assistant', parent_message_id: 'other-user' };
    store.setState({ messages: [user, assistant, other] });
    await startRun(store, other.id);
    store.getState().applyMessageVersionSnapshot('conv-1', user.id, []);
    expect(store.getState().messages).toEqual([user, other]);

    store.setState({ activeConversationId: 'conv-2', messages: [
      { ...user, conversation_id: 'conv-2' }, { ...assistant, conversation_id: 'conv-2' },
    ] });
    store.getState().applyMessageVersionSnapshot('conv-2', user.id, []);
    expect(store.getState().messages.map(message => message.role)).toEqual(['user']);
  });

  it('preserves pending multi-model replies by their run target IDs without reviving old versions', async () => {
    const { store, user, assistant } = await setup();
    const second = { ...assistant, id: 'b-assistant', is_active: false, version_index: 1 };
    const old = { ...assistant, id: 'old-assistant', status: 'complete' as const };
    store.setState({
      messages: [user, old, assistant, second],
      streaming: true, streamingConversationId: 'conv-1', streamingMessageId: assistant.id,
      multiModelRun: {
        runId: 'mm-run', conversationId: 'conv-1', parentMessageId: user.id,
        mode: 'parallel', intervalSeconds: 0, phase: 'running', nextStartAt: null,
        targets: [assistant, second, old].map((message, index) => ({
          index, messageId: message.id, target: { providerId: 'provider-1', modelId: `model-${index}` },
          state: index === 2 ? 'complete' : 'streaming',
        })),
      },
    });
    store.getState().applyMessageVersionSnapshot('conv-1', user.id, []);
    expect(store.getState().messages.map(message => message.id)).toEqual([user.id, assistant.id, second.id]);
  });

  it('preserves database order for a refresh with a live reply created in the same second as its user', async () => {
    const { store, user, assistant } = await setup();
    const localAssistant = { ...assistant, thinking: 'inspect skill' };
    store.setState({ messages: [user, localAssistant] });
    await startRun(store, assistant.id);
    invokeMock.mockResolvedValue(makePage([user, { ...assistant, content: 'older snapshot' }], false));
    await store.getState().fetchMessages('conv-1');
    expect(store.getState().messages).toEqual([user, localAssistant]);
  });

  it.each(['older', 'newer'] as const)('keeps same-second %s pages in order and local content on overlap', async (direction) => {
    const { store, user, assistant } = await setup();
    const nextUser = { ...user, id: 'c-user', content: 'next question' };
    const current = direction === 'older' ? [assistant, nextUser] : [user, assistant];
    const incoming = direction === 'older'
      ? [user, { ...assistant, content: 'stale' }]
      : [{ ...assistant, content: 'stale' }, nextUser];
    store.setState({
      messages: current, hasOlderMessages: true, hasNewerMessages: true,
      oldestLoadedMessageId: current[0].id, newestLoadedMessageId: current[current.length - 1].id,
    });
    invokeMock.mockResolvedValue(makeWindow(incoming, false, false));
    if (direction === 'older') await store.getState().loadOlderMessages();
    else await store.getState().loadNewerMessages();
    expect(store.getState().messages).toEqual([user, assistant, nextUser]);
  });

  it('adds a same-second compression marker after existing messages without reshuffling them', async () => {
    const { store, user, assistant } = await setup();
    await store.getState().startStreamListening();
    const marker = { ...makeMessage(3), id: '0-marker', role: 'system' as const,
      content: '<!-- context-compressed -->', created_at: 1000 };
    listeners.get('conversation:compressed')?.({ payload: { conversation_id: 'conv-1', marker_message: marker } });
    expect(store.getState().messages).toEqual([user, assistant, marker]);
    store.getState().stopStreamListening();
  });
});
