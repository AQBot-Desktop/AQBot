import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(),
}));

describe('agentStore tool history resource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('treats an empty history as loaded and coalesces concurrent requests', async () => {
    let resolve!: (value: unknown[]) => void;
    invokeMock.mockReturnValue(new Promise<unknown[]>((next) => { resolve = next; }));
    const { useAgentStore } = await import('../agentStore');

    const first = useAgentStore.getState().ensureToolHistoryLoaded('conv-1');
    const second = useAgentStore.getState().ensureToolHistoryLoaded('conv-1');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    resolve([]);
    await Promise.all([first, second]);
    await useAgentStore.getState().ensureToolHistoryLoaded('conv-1');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().toolHistoryLoaded.conv1).toBeUndefined();
    expect(useAgentStore.getState().toolHistoryLoaded['conv-1']).toBe(true);
  });

  it('bounds settled tool state to eight conversation buckets and reloads evicted history', async () => {
    invokeMock.mockResolvedValue([]);
    const {
      AGENT_CACHE_MAX_CONVERSATIONS,
      useAgentStore,
    } = await import('../agentStore');

    for (let index = 0; index < 12; index += 1) {
      const conversationId = `conv-${index}`;
      const toolUseId = `tool-${index}`;
      useAgentStore.getState().handleToolUse({
        conversationId,
        assistantMessageId: `message-${index}`,
        toolUseId,
        toolName: 'read',
        input: {},
      });
      useAgentStore.getState().handleToolResult({
        conversationId,
        assistantMessageId: `message-${index}`,
        toolUseId,
        toolName: 'read',
        content: 'done',
        isError: false,
      });
    }

    const retainedConversations = new Set(
      Object.values(useAgentStore.getState().toolCalls).map((toolCall) => toolCall.conversationId),
    );
    expect(retainedConversations.size).toBeLessThanOrEqual(AGENT_CACHE_MAX_CONVERSATIONS);

    for (let index = 0; index <= AGENT_CACHE_MAX_CONVERSATIONS; index += 1) {
      await useAgentStore.getState().ensureToolHistoryLoaded(`history-${index}`);
    }
    expect(useAgentStore.getState().toolHistoryLoaded['history-0']).toBeUndefined();
    await useAgentStore.getState().ensureToolHistoryLoaded('history-0');
    expect(invokeMock).toHaveBeenCalledTimes(AGENT_CACHE_MAX_CONVERSATIONS + 2);
  });

  it('protects visible and pending conversations while pruning settled background state', async () => {
    const { useAgentStore } = await import('../agentStore');
    useAgentStore.getState().setVisibleConversation('visible');
    useAgentStore.getState().handleToolUse({
      conversationId: 'visible',
      assistantMessageId: 'visible-message',
      toolUseId: 'visible-tool',
      toolName: 'read',
      input: {},
    });
    useAgentStore.getState().handleToolResult({
      conversationId: 'visible',
      assistantMessageId: 'visible-message',
      toolUseId: 'visible-tool',
      toolName: 'read',
      content: 'done',
      isError: false,
    });
    useAgentStore.getState().handlePermissionRequest({
      conversationId: 'pending',
      assistantMessageId: 'pending-message',
      toolUseId: 'pending-tool',
      toolName: 'write',
      input: {},
      riskLevel: 'write',
    });

    for (let index = 0; index < 12; index += 1) {
      const conversationId = `background-${index}`;
      const toolUseId = `background-tool-${index}`;
      useAgentStore.getState().handleToolUse({
        conversationId,
        assistantMessageId: `background-message-${index}`,
        toolUseId,
        toolName: 'read',
        input: {},
      });
      useAgentStore.getState().handleToolResult({
        conversationId,
        assistantMessageId: `background-message-${index}`,
        toolUseId,
        toolName: 'read',
        content: 'done',
        isError: false,
      });
    }

    expect(useAgentStore.getState().toolCalls['visible-tool']).toBeDefined();
    expect(useAgentStore.getState().pendingPermissions['pending-tool']).toBeDefined();
  });

  it('clears every per-conversation index and prevents stale history from repopulating it', async () => {
    let resolveHistory!: (value: unknown[]) => void;
    invokeMock.mockReturnValue(new Promise<unknown[]>((resolve) => { resolveHistory = resolve; }));
    const { useAgentStore } = await import('../agentStore');
    const historyRequest = useAgentStore.getState().loadToolHistory('conv-clear');
    useAgentStore.getState().handleToolUse({
      conversationId: 'conv-clear',
      assistantMessageId: 'message-clear',
      toolUseId: 'sdk-clear',
      executionId: 'exec-clear',
      toolName: 'read',
      input: {},
    });
    useAgentStore.getState().handlePermissionRequest({
      conversationId: 'conv-clear',
      assistantMessageId: 'message-clear',
      toolUseId: 'sdk-clear',
      toolName: 'read',
      input: {},
      riskLevel: 'read_only',
    });
    useAgentStore.getState().handleAskUser({
      conversationId: 'conv-clear',
      assistantMessageId: 'message-clear',
      askId: 'ask-clear',
      question: 'continue?',
    });
    useAgentStore.getState().handleDone({
      conversationId: 'conv-clear',
      assistantMessageId: 'message-clear',
      text: 'done',
      numTurns: 1,
    });

    useAgentStore.getState().clearConversation('conv-clear');
    resolveHistory([]);
    await historyRequest;

    const state = useAgentStore.getState();
    expect(Object.values(state.toolCalls).some((toolCall) => toolCall.conversationId === 'conv-clear'))
      .toBe(false);
    expect(state.sdkIdToExecId['sdk-clear']).toBeUndefined();
    expect(state.pendingPermissions['sdk-clear']).toBeUndefined();
    expect(state.pendingAskUser['ask-clear']).toBeUndefined();
    expect(state.queryStats['message-clear']).toBeUndefined();
    expect(state.toolHistoryLoaded['conv-clear']).toBeUndefined();
    const { getAgentResourceCacheStats } = await import('../agentStore');
    expect(getAgentResourceCacheStats().historyGenerations).toBe(0);
  });

  it('does not retain generation tombstones for cleared conversations without requests', async () => {
    const { getAgentResourceCacheStats, useAgentStore } = await import('../agentStore');

    for (let index = 0; index < 100; index += 1) {
      useAgentStore.getState().clearConversation(`deleted-${index}`);
    }

    expect(getAgentResourceCacheStats().historyGenerations).toBe(0);
  });

  it('reloads tool history invalidated while an older request is in flight', async () => {
    let resolveOld!: (value: unknown[]) => void;
    invokeMock
      .mockReturnValueOnce(new Promise<unknown[]>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce([]);
    const { invalidateAgentResources, useAgentStore } = await import('../agentStore');
    useAgentStore.getState().setVisibleConversation('conv-active');

    const pending = useAgentStore.getState().ensureToolHistoryLoaded('conv-active');
    invalidateAgentResources();
    resolveOld([]);
    await pending;

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().toolHistoryLoaded['conv-active']).toBe(true);
    expect(useAgentStore.getState().visibleConversationId).toBe('conv-active');

    invalidateAgentResources(true);
    expect(useAgentStore.getState().visibleConversationId).toBeNull();
  });

  it('does not advance an active conversation revision for background events', async () => {
    const { useAgentStore } = await import('../agentStore');
    useAgentStore.getState().setVisibleConversation('active');
    const revision = useAgentStore.getState().conversationRevisions.active;

    useAgentStore.getState().handleToolUse({
      conversationId: 'background',
      assistantMessageId: 'background-message',
      toolUseId: 'background-tool',
      toolName: 'read',
      input: {},
    });

    expect(useAgentStore.getState().conversationRevisions.active).toBe(revision);
    expect(useAgentStore.getState().conversationRevisions.background).toBeGreaterThan(0);
  });
});
