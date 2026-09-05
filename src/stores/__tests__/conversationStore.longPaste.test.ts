import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, makeConversation, makeMessage } from './conversationStore.testUtils';

const invokeMock = vi.fn();
const listenMock = vi.fn();
let tauriAvailable = true;

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: listenMock,
  isTauri: () => tauriAvailable,
}));

describe('conversationStore long pasted content', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    tauriAvailable = true;
    listenMock.mockResolvedValue(() => {});
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      conversations: [],
      activeConversationId: null,
      messages: [],
      ragDisplayByMessageId: {},
      searchDisplayByMessageId: {},
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      hasOlderMessages: false,
      hasNewerMessages: false,
      totalActiveCount: 0,
      oldestLoadedMessageId: null,
      newestLoadedMessageId: null,
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      activeStreamId: null,
      streamActivityByMessageId: {},
      thinkingActiveMessageIds: new Set<string>(),
      error: null,
      searchEnabled: false,
      searchProviderId: null,
      enabledMcpServerIds: [],
      thinkingBudget: null,
      thinkingLevel: null,
      enabledKnowledgeBaseIds: [],
      enabledMemoryNamespaceIds: [],
      archivedConversations: [],
      workspaceSnapshot: null,
    });
  });

  it('forwards a payload over the old 96k paste cap to send_message without rewriting it', async () => {
    const payload = `${'x'.repeat(96_001)}TAIL-END`;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'send_message') {
        return Promise.resolve({
          ...makeMessage(1),
          id: 'user-real',
          role: 'user',
          content: payload,
          provider_id: null,
          model_id: null,
        });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { useConversationStore } = await import('../conversationStore');
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1')] as never[],
      messages: [],
    });

    const sent = await useConversationStore.getState().sendMessage(payload);
    await flushPromises();

    expect(sent?.content).toBe(payload);
    const sendCalls = invokeMock.mock.calls.filter(([command]) => command === 'send_message');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toEqual([
      'send_message',
      expect.objectContaining({
        conversationId: 'conv-1',
        content: payload,
      }),
    ]);
    const forwarded = sendCalls[0][1] as { content: string };
    expect(forwarded.content).toBe(payload);
    expect(forwarded.content.length).toBe(payload.length);
    expect(forwarded.content.endsWith('TAIL-END')).toBe(true);
  });
});
