import { create } from 'zustand';
import { invoke, listen, type UnlistenFn } from '@/lib/invoke';
import type {
  AgentSession,
  ToolCallState,
  ToolUseEvent,
  ToolStartEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  AskUserEvent,
  AgentStatusEvent,
  AgentDoneEvent,
} from '@/types/agent';
import type { ToolExecution } from '@/types/mcp';

interface QueryStats {
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

const toolHistoryRequests = new Map<string, Promise<void>>();
const toolHistoryGenerations = new Map<string, number>();
const agentConversationLru = new Map<string, true>();
const queryStatConversationIds = new Map<string, string>();

export const AGENT_CACHE_MAX_CONVERSATIONS = 8;
export const AGENT_TOOL_CALL_MAX_PER_CONVERSATION = 256;
export const AGENT_TOOL_CALL_MAX_BYTES_PER_CONVERSATION = 8 * 1024 * 1024;
export const AGENT_QUERY_STATS_MAX = 512;

interface AgentStore {
  // Session cache (truth lives in backend DB)
  sessions: Record<string, AgentSession>;

  // Runtime state
  agentStatus: Record<string, string>; // conversationId → status message
  pendingPermissions: Record<string, PermissionRequestEvent>; // toolUseId → request
  pendingAskUser: Record<string, AskUserEvent>; // askId → request
  toolCalls: Record<string, ToolCallState>; // toolUseId or execId → state
  sdkIdToExecId: Record<string, string>; // SDK toolUseId → DB execution ID mapping
  queryStats: Record<string, QueryStats>; // assistantMessageId → cost stats
  toolHistoryLoaded: Record<string, true>;
  conversationRevisions: Record<string, number>;
  visibleConversationId: string | null;

  // Actions
  fetchSession: (conversationId: string) => Promise<AgentSession | null>;
  updateCwd: (conversationId: string, cwd: string) => Promise<void>;
  updatePermissionMode: (conversationId: string, mode: string) => Promise<void>;
  approveToolUse: (conversationId: string, toolUseId: string, decision: string) => Promise<void>;

  // Event handlers
  handleToolUse: (event: ToolUseEvent) => void;
  handleToolStart: (event: ToolStartEvent) => void;
  handleToolResult: (event: ToolResultEvent) => void;
  handlePermissionRequest: (event: PermissionRequestEvent) => void;
  handlePermissionResolved: (toolUseId: string, decision: string) => void;
  handleAskUser: (event: AskUserEvent) => void;
  handleAskUserResolved: (askId: string) => void;
  respondAskUser: (askId: string, answer: string) => Promise<void>;
  handleStatus: (conversationId: string, message: string) => void;
  clearStatus: (conversationId: string) => void;
  handleDone: (event: AgentDoneEvent) => void;

  // History
  ensureToolHistoryLoaded: (conversationId: string) => Promise<void>;
  loadToolHistory: (conversationId: string) => Promise<void>;

  // Cleanup
  clearConversation: (conversationId: string) => void;
  setVisibleConversation: (conversationId: string | null) => void;
}

type AgentCacheFields = Pick<AgentStore,
  | 'sessions'
  | 'agentStatus'
  | 'pendingPermissions'
  | 'pendingAskUser'
  | 'toolCalls'
  | 'sdkIdToExecId'
  | 'queryStats'
  | 'toolHistoryLoaded'
  | 'conversationRevisions'
>;

function filterRecord<T>(
  record: Record<string, T>,
  keep: (key: string, value: T) => boolean,
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => keep(key, value)));
}

function estimateToolCallBytes(toolCall: ToolCallState): number {
  const serializedInput = JSON.stringify(toolCall.input);
  if (serializedInput === undefined) {
    throw new TypeError(`Tool call ${toolCall.toolUseId} input is not serializable JSON`);
  }
  const inputBytes = serializedInput.length * 2;
  return inputBytes
    + (toolCall.output?.length ?? 0) * 2
    + toolCall.toolName.length * 2
    + toolCall.assistantMessageId.length * 2
    + 256;
}

function limitToolCalls(toolCalls: Record<string, ToolCallState>): Record<string, ToolCallState> {
  const statesByConversation = new Map<string, ToolCallState[]>();
  const seenStates = new Set<ToolCallState>();
  for (const toolCall of Object.values(toolCalls)) {
    if (seenStates.has(toolCall)) continue;
    seenStates.add(toolCall);
    const states = statesByConversation.get(toolCall.conversationId) ?? [];
    states.push(toolCall);
    statesByConversation.set(toolCall.conversationId, states);
  }

  const retainedStates = new Set<ToolCallState>();
  for (const states of statesByConversation.values()) {
    let retainedCount = 0;
    let retainedBytes = 0;
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const toolCall = states[index];
      const protectedCall = toolCall.executionStatus === 'queued'
        || toolCall.executionStatus === 'running'
        || toolCall.approvalStatus === 'pending';
      const bytes = estimateToolCallBytes(toolCall);
      if (
        !protectedCall
        && (retainedCount >= AGENT_TOOL_CALL_MAX_PER_CONVERSATION
          || retainedBytes + bytes > AGENT_TOOL_CALL_MAX_BYTES_PER_CONVERSATION)
      ) {
        continue;
      }
      retainedStates.add(toolCall);
      retainedCount += 1;
      retainedBytes += bytes;
    }
  }

  return filterRecord(toolCalls, (_key, toolCall) => retainedStates.has(toolCall));
}

function limitQueryStats(queryStats: Record<string, QueryStats>): Record<string, QueryStats> {
  const entries = Object.entries(queryStats);
  if (entries.length <= AGENT_QUERY_STATS_MAX) return queryStats;
  const retained = entries.slice(-AGENT_QUERY_STATS_MAX);
  const retainedIds = new Set(retained.map(([messageId]) => messageId));
  for (const messageId of queryStatConversationIds.keys()) {
    if (!retainedIds.has(messageId)) queryStatConversationIds.delete(messageId);
  }
  return Object.fromEntries(retained);
}

function withAgentCacheLimits(
  state: AgentStore,
  conversationId: string,
  updates: Partial<AgentCacheFields> = {},
  visibleConversationId = state.visibleConversationId,
): AgentCacheFields {
  agentConversationLru.delete(conversationId);
  agentConversationLru.set(conversationId, true);

  const next: AgentCacheFields = {
    sessions: updates.sessions ?? state.sessions,
    agentStatus: updates.agentStatus ?? state.agentStatus,
    pendingPermissions: updates.pendingPermissions ?? state.pendingPermissions,
    pendingAskUser: updates.pendingAskUser ?? state.pendingAskUser,
    toolCalls: updates.toolCalls ?? state.toolCalls,
    sdkIdToExecId: updates.sdkIdToExecId ?? state.sdkIdToExecId,
    queryStats: updates.queryStats ?? state.queryStats,
    toolHistoryLoaded: updates.toolHistoryLoaded ?? state.toolHistoryLoaded,
    conversationRevisions: {
      ...(updates.conversationRevisions ?? state.conversationRevisions),
      [conversationId]: (state.conversationRevisions[conversationId] ?? 0) + 1,
    },
  };

  const protectedConversationIds = new Set<string>();
  if (visibleConversationId) protectedConversationIds.add(visibleConversationId);
  Object.keys(next.agentStatus).forEach((id) => protectedConversationIds.add(id));
  Object.values(next.pendingPermissions).forEach((event) => protectedConversationIds.add(event.conversationId));
  Object.values(next.pendingAskUser).forEach((event) => protectedConversationIds.add(event.conversationId));
  Object.values(next.toolCalls).forEach((toolCall) => {
    if (
      toolCall.executionStatus === 'queued'
      || toolCall.executionStatus === 'running'
      || toolCall.approvalStatus === 'pending'
    ) {
      protectedConversationIds.add(toolCall.conversationId);
    }
  });

  const evictedConversationIds = new Set<string>();
  while (agentConversationLru.size > AGENT_CACHE_MAX_CONVERSATIONS) {
    const candidate = [...agentConversationLru.keys()]
      .find((id) => !protectedConversationIds.has(id));
    if (!candidate) break;
    agentConversationLru.delete(candidate);
    evictedConversationIds.add(candidate);
  }

  if (evictedConversationIds.size > 0) {
    next.sessions = filterRecord(next.sessions, (id) => !evictedConversationIds.has(id));
    next.agentStatus = filterRecord(next.agentStatus, (id) => !evictedConversationIds.has(id));
    next.toolHistoryLoaded = filterRecord(
      next.toolHistoryLoaded,
      (id) => !evictedConversationIds.has(id),
    );
    next.conversationRevisions = filterRecord(
      next.conversationRevisions,
      (id) => !evictedConversationIds.has(id),
    );
    next.pendingPermissions = filterRecord(
      next.pendingPermissions,
      (_id, event) => !evictedConversationIds.has(event.conversationId),
    );
    next.pendingAskUser = filterRecord(
      next.pendingAskUser,
      (_id, event) => !evictedConversationIds.has(event.conversationId),
    );
    next.toolCalls = filterRecord(
      next.toolCalls,
      (_id, toolCall) => !evictedConversationIds.has(toolCall.conversationId),
    );
    next.queryStats = filterRecord(next.queryStats, (messageId) => {
      const statConversationId = queryStatConversationIds.get(messageId);
      if (!statConversationId || !evictedConversationIds.has(statConversationId)) return true;
      queryStatConversationIds.delete(messageId);
      return false;
    });
  }

  next.toolCalls = limitToolCalls(next.toolCalls);
  next.sdkIdToExecId = filterRecord(next.sdkIdToExecId, (sdkId, execId) => (
    sdkId in next.toolCalls || execId in next.toolCalls
  ));
  next.queryStats = limitQueryStats(next.queryStats);
  return next;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  sessions: {},
  agentStatus: {},
  pendingPermissions: {},
  pendingAskUser: {},
  toolCalls: {},
  sdkIdToExecId: {},
  queryStats: {},
  toolHistoryLoaded: {},
  conversationRevisions: {},
  visibleConversationId: null,

  fetchSession: async (conversationId) => {
    try {
      const session = await invoke<AgentSession | null>('agent_get_session', {
        conversation_id: conversationId,
      });
      if (session) {
        set((s) => withAgentCacheLimits(s, conversationId, {
          sessions: { ...s.sessions, [conversationId]: session },
        }));
      }
      return session;
    } catch (e) {
      console.error('[agentStore] fetchSession failed:', e);
      return null;
    }
  },

  updateCwd: async (conversationId, cwd) => {
    try {
      const session = await invoke<AgentSession>('agent_update_session', {
        conversation_id: conversationId,
        cwd,
      });
      set((s) => withAgentCacheLimits(s, conversationId, {
        sessions: { ...s.sessions, [conversationId]: session },
      }));
    } catch (e) {
      console.error('[agentStore] updateCwd failed:', e);
    }
  },

  updatePermissionMode: async (conversationId, mode) => {
    try {
      const session = await invoke<AgentSession>('agent_update_session', {
        conversation_id: conversationId,
        permission_mode: mode,
      });
      set((s) => withAgentCacheLimits(s, conversationId, {
        sessions: { ...s.sessions, [conversationId]: session },
      }));
    } catch (e) {
      console.error('[agentStore] updatePermissionMode failed:', e);
    }
  },

  approveToolUse: async (conversationId, toolUseId, decision) => {
    try {
      await invoke('agent_approve', {
        conversationId,
        toolUseId,
        decision,
      });
      get().handlePermissionResolved(toolUseId, decision);
    } catch (e) {
      console.error('[agentStore] approveToolUse failed:', e);
    }
  },

  handleToolUse: (event) => {
    set((s) => {
      const toolCall: ToolCallState = {
        conversationId: event.conversationId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        assistantMessageId: event.assistantMessageId,
        executionStatus: 'queued',
      };
      const updates: Record<string, ToolCallState> = {
        [event.toolUseId]: toolCall,
      };
      const idMap = { ...s.sdkIdToExecId };
      // Also store by DB execution ID for inline <tool-call> tag lookups
      if (event.executionId) {
        updates[event.executionId] = toolCall;
        idMap[event.toolUseId] = event.executionId;
      }
      return withAgentCacheLimits(s, event.conversationId, {
        toolCalls: { ...s.toolCalls, ...updates },
        sdkIdToExecId: idMap,
      });
    });
  },

  handleToolStart: (event) => {
    set((s) => {
      const existing = s.toolCalls[event.toolUseId];
      const updated: ToolCallState = {
        conversationId: event.conversationId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        assistantMessageId: event.assistantMessageId,
        executionStatus: 'running',
        approvalStatus: existing?.approvalStatus,
      };
      const updates: Record<string, ToolCallState> = {
        [event.toolUseId]: updated,
      };
      const execId = s.sdkIdToExecId[event.toolUseId];
      if (execId) {
        updates[execId] = updated;
      }
      return withAgentCacheLimits(s, event.conversationId, {
        toolCalls: { ...s.toolCalls, ...updates },
      });
    });
  },

  handleToolResult: (event) => {
    set((s) => {
      const existing = s.toolCalls[event.toolUseId];
      const newStatus = event.isError ? 'failed' : 'success';
      const updated: ToolCallState = {
        conversationId: event.conversationId,
        toolUseId: event.toolUseId,
        toolName: event.toolName || existing?.toolName || '',
        input: existing?.input ?? {},
        assistantMessageId: event.assistantMessageId,
        executionStatus: newStatus,
        approvalStatus: existing?.approvalStatus,
        output: event.content,
        isError: event.isError,
      };
      const updates: Record<string, ToolCallState> = {
        [event.toolUseId]: updated,
      };
      const execId = s.sdkIdToExecId[event.toolUseId];
      if (execId) {
        updates[execId] = updated;
      }
      return withAgentCacheLimits(s, event.conversationId, {
        toolCalls: { ...s.toolCalls, ...updates },
      });
    });
  },

  handlePermissionRequest: (event) => {
    set((s) => withAgentCacheLimits(s, event.conversationId, {
      pendingPermissions: { ...s.pendingPermissions, [event.toolUseId]: event },
    }));
  },

  handlePermissionResolved: (toolUseId, decision) => {
    set((s) => {
      const { [toolUseId]: _removed, ...rest } = s.pendingPermissions;
      const existing = s.toolCalls[toolUseId];
      const conversationId = s.pendingPermissions[toolUseId]?.conversationId
        ?? existing?.conversationId;
      let updatedToolCalls = s.toolCalls;
      if (existing) {
        const updated = {
          ...existing,
          approvalStatus: decision === 'deny' ? ('denied' as const) : ('approved' as const),
        };
        const execId = s.sdkIdToExecId[toolUseId];
        updatedToolCalls = {
          ...s.toolCalls,
          [toolUseId]: updated,
          ...(execId ? { [execId]: updated } : {}),
        };
      }
      const updates = {
        pendingPermissions: rest,
        toolCalls: updatedToolCalls,
      };
      return conversationId ? withAgentCacheLimits(s, conversationId, updates) : updates;
    });
  },

  handleAskUser: (event) => {
    set((s) => withAgentCacheLimits(s, event.conversationId, {
      pendingAskUser: { ...s.pendingAskUser, [event.askId]: event },
    }));
  },

  handleAskUserResolved: (askId) => {
    set((s) => {
      const { [askId]: _removed, ...rest } = s.pendingAskUser;
      const conversationId = s.pendingAskUser[askId]?.conversationId;
      const updates = { pendingAskUser: rest };
      return conversationId ? withAgentCacheLimits(s, conversationId, updates) : updates;
    });
  },

  respondAskUser: async (askId, answer) => {
    try {
      await invoke('agent_respond_ask', { askId, answer });
      // Brief delay so user sees the loading/submitted feedback
      await new Promise((r) => setTimeout(r, 500));
      get().handleAskUserResolved(askId);
    } catch (e) {
      console.error('[agentStore] respondAskUser failed:', e);
    }
  },

  handleStatus: (conversationId, message) => {
    set((s) => withAgentCacheLimits(s, conversationId, {
      agentStatus: { ...s.agentStatus, [conversationId]: message },
    }));
  },

  clearStatus: (conversationId) => {
    set((s) => {
      const { [conversationId]: _removed, ...rest } = s.agentStatus;
      return withAgentCacheLimits(s, conversationId, { agentStatus: rest });
    });
  },

  handleDone: (event) => {
    const stats: QueryStats = {};
    if (event.numTurns != null) stats.numTurns = event.numTurns;
    if (event.usage) {
      stats.inputTokens = event.usage.input_tokens;
      stats.outputTokens = event.usage.output_tokens;
    }
    if (event.costUsd != null) stats.costUsd = event.costUsd;
    if (event.assistantMessageId && Object.keys(stats).length > 0) {
      queryStatConversationIds.set(event.assistantMessageId, event.conversationId);
      set((s) => withAgentCacheLimits(s, event.conversationId, {
        queryStats: { ...s.queryStats, [event.assistantMessageId]: stats },
      }));
    }
  },

  ensureToolHistoryLoaded: async (conversationId) => {
    if (get().toolHistoryLoaded[conversationId]) return Promise.resolve();
    await get().loadToolHistory(conversationId);
    if (!get().toolHistoryLoaded[conversationId]) {
      await get().loadToolHistory(conversationId);
    }
  },

  loadToolHistory: async (conversationId) => {
    const existingRequest = toolHistoryRequests.get(conversationId);
    if (existingRequest) return existingRequest;
    const generation = toolHistoryGenerations.get(conversationId) ?? 0;

    const request = (async () => {
      const executions = await invoke<ToolExecution[]>('list_tool_executions', {
        conversationId,
      });
      if ((toolHistoryGenerations.get(conversationId) ?? 0) !== generation) return;
      const agentExecs = executions.filter((e) => e.serverId === '__agent_sdk__');

      const toolCalls: Record<string, ToolCallState> = {};
      for (const exec of agentExecs) {
        let executionStatus: ToolCallState['executionStatus'] = 'queued';
        if (exec.status === 'running') executionStatus = 'running';
        else if (exec.status === 'success') executionStatus = 'success';
        else if (exec.status === 'failed') executionStatus = 'failed';
        else if (exec.status === 'cancelled') executionStatus = 'cancelled';

        // Historical records still showing pending/running means the agent
        // was interrupted or a duplicate record was left behind.
        // Treat them as success to avoid perpetual loading spinners.
        if (executionStatus === 'queued' || executionStatus === 'running') {
          executionStatus = 'success';
        }

        let approvalStatus: ToolCallState['approvalStatus'] | undefined;
        if (exec.approvalStatus === 'approved') approvalStatus = 'approved';
        else if (exec.approvalStatus === 'denied') approvalStatus = 'denied';
        else if (exec.approvalStatus === 'pending') approvalStatus = 'pending';

        let input: Record<string, unknown> = {};
        if (exec.inputPreview) {
          try {
            input = JSON.parse(exec.inputPreview);
          } catch (error) {
            console.warn('[agentStore] Invalid persisted tool input preview:', error);
          }
        }

        toolCalls[exec.id] = {
          conversationId,
          toolUseId: exec.id,
          toolName: exec.toolName,
          input,
          assistantMessageId: exec.messageId ?? '',
          executionStatus,
          approvalStatus,
          output: exec.outputPreview ?? exec.errorMessage,
          isError: exec.status === 'failed',
        };
      }

      set((s) => withAgentCacheLimits(s, conversationId, {
        toolCalls: { ...toolCalls, ...s.toolCalls },
        toolHistoryLoaded: { ...s.toolHistoryLoaded, [conversationId]: true },
      }));
    })();
    toolHistoryRequests.set(conversationId, request);
    try {
      await request;
    } finally {
      if (toolHistoryRequests.get(conversationId) === request) {
        toolHistoryRequests.delete(conversationId);
      }
      const currentGeneration = toolHistoryGenerations.get(conversationId);
      if (currentGeneration !== undefined && currentGeneration !== generation) {
        toolHistoryGenerations.delete(conversationId);
      }
    }
  },

  clearConversation: (conversationId) => {
    agentConversationLru.delete(conversationId);
    if (toolHistoryRequests.has(conversationId)) {
      toolHistoryGenerations.set(
        conversationId,
        (toolHistoryGenerations.get(conversationId) ?? 0) + 1,
      );
    } else {
      toolHistoryGenerations.delete(conversationId);
    }
    set((s) => {
      const { [conversationId]: _session, ...sessions } = s.sessions;
      const { [conversationId]: _status, ...agentStatus } = s.agentStatus;
      const { [conversationId]: _history, ...toolHistoryLoaded } = s.toolHistoryLoaded;

      const pendingPermissions: Record<string, PermissionRequestEvent> = {};
      for (const [id, pr] of Object.entries(s.pendingPermissions)) {
        if (pr.conversationId !== conversationId) {
          pendingPermissions[id] = pr;
        }
      }

      const pendingAskUser: Record<string, AskUserEvent> = {};
      for (const [id, ask] of Object.entries(s.pendingAskUser)) {
        if (ask.conversationId !== conversationId) {
          pendingAskUser[id] = ask;
        }
      }

      const toolCalls = filterRecord(
        s.toolCalls,
        (_id, toolCall) => toolCall.conversationId !== conversationId,
      );
      const sdkIdToExecId = filterRecord(s.sdkIdToExecId, (sdkId, execId) => (
        sdkId in toolCalls || execId in toolCalls
      ));
      const queryStats = filterRecord(s.queryStats, (messageId) => {
        if (queryStatConversationIds.get(messageId) !== conversationId) return true;
        queryStatConversationIds.delete(messageId);
        return false;
      });
      const { [conversationId]: _revision, ...conversationRevisions } = s.conversationRevisions;

      return {
        sessions,
        agentStatus,
        pendingPermissions,
        pendingAskUser,
        toolCalls,
        sdkIdToExecId,
        queryStats,
        toolHistoryLoaded,
        conversationRevisions,
        visibleConversationId: s.visibleConversationId === conversationId
          ? null
          : s.visibleConversationId,
      };
    });
  },

  setVisibleConversation: (conversationId) => {
    if (!conversationId) {
      set({ visibleConversationId: null });
      return;
    }
    set((s) => ({
      visibleConversationId: conversationId,
      ...withAgentCacheLimits(s, conversationId, {}, conversationId),
    }));
  },
}));

export function invalidateAgentResources(clearVisibleConversation = false): void {
  for (const conversationId of toolHistoryRequests.keys()) {
    toolHistoryGenerations.set(
      conversationId,
      (toolHistoryGenerations.get(conversationId) ?? 0) + 1,
    );
  }
  agentConversationLru.clear();
  queryStatConversationIds.clear();
  const visibleConversationId = useAgentStore.getState().visibleConversationId;
  useAgentStore.setState({
    sessions: {},
    agentStatus: {},
    pendingPermissions: {},
    pendingAskUser: {},
    toolCalls: {},
    sdkIdToExecId: {},
    queryStats: {},
    toolHistoryLoaded: {},
    conversationRevisions: {},
    visibleConversationId: clearVisibleConversation ? null : visibleConversationId,
  });
}

export function getAgentResourceCacheStats() {
  return {
    historyRequests: toolHistoryRequests.size,
    historyGenerations: toolHistoryGenerations.size,
    conversationLruEntries: agentConversationLru.size,
    queryStatConversationEntries: queryStatConversationIds.size,
  };
}

// ── Event listener setup ─────────────────────────────────────────────────

export function setupAgentEventListeners(): () => void {
  const unlisteners: Promise<UnlistenFn>[] = [];
  const store = useAgentStore.getState();

  unlisteners.push(
    listen<ToolUseEvent>('agent-tool-use', (event) => {
      store.handleToolUse(event.payload);
    }),
  );

  unlisteners.push(
    listen<ToolStartEvent>('agent-tool-start', (event) => {
      store.handleToolStart(event.payload);
    }),
  );

  unlisteners.push(
    listen<ToolResultEvent>('agent-tool-result', (event) => {
      store.handleToolResult(event.payload);
    }),
  );

  unlisteners.push(
    listen<PermissionRequestEvent>('agent-permission-request', (event) => {
      store.handlePermissionRequest(event.payload);
    }),
  );

  unlisteners.push(
    listen<AskUserEvent>('agent-ask-user', (event) => {
      store.handleAskUser(event.payload);
    }),
  );

  unlisteners.push(
    listen<AgentStatusEvent>('agent-status', (event) => {
      store.handleStatus(event.payload.conversationId, event.payload.message);
    }),
  );

  unlisteners.push(
    listen<AgentDoneEvent>('agent-done', (event) => {
      store.clearStatus(event.payload.conversationId);
      store.handleDone(event.payload);
    }),
  );

  return () => {
    for (const p of unlisteners) {
      p.then((u) => u());
    }
  };
}
