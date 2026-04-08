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
  loadToolHistory: (conversationId: string) => Promise<void>;

  // Cleanup
  clearConversation: (conversationId: string) => void;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  sessions: {},
  agentStatus: {},
  pendingPermissions: {},
  pendingAskUser: {},
  toolCalls: {},
  sdkIdToExecId: {},
  queryStats: {},

  fetchSession: async (conversationId) => {
    try {
      const session = await invoke<AgentSession | null>('agent_get_session', {
        conversation_id: conversationId,
      });
      if (session) {
        set((s) => ({
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
      set((s) => ({
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
      set((s) => ({
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
        updates[event.executionId] = { ...toolCall, toolUseId: event.executionId };
        idMap[event.toolUseId] = event.executionId;
      }
      return {
        toolCalls: { ...s.toolCalls, ...updates },
        sdkIdToExecId: idMap,
      };
    });
  },

  handleToolStart: (event) => {
    set((s) => {
      const existing = s.toolCalls[event.toolUseId];
      const updated: ToolCallState = {
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
        updates[execId] = { ...updated, toolUseId: execId };
      }
      return { toolCalls: { ...s.toolCalls, ...updates } };
    });
  },

  handleToolResult: (event) => {
    set((s) => {
      const existing = s.toolCalls[event.toolUseId];
      const newStatus = event.isError ? 'failed' : 'success';
      const updated: ToolCallState = {
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
        updates[execId] = { ...updated, toolUseId: execId };
      }
      return { toolCalls: { ...s.toolCalls, ...updates } };
    });
  },

  handlePermissionRequest: (event) => {
    set((s) => ({
      pendingPermissions: { ...s.pendingPermissions, [event.toolUseId]: event },
    }));
  },

  handlePermissionResolved: (toolUseId, decision) => {
    set((s) => {
      const { [toolUseId]: _removed, ...rest } = s.pendingPermissions;
      const existing = s.toolCalls[toolUseId];
      const updatedToolCalls = existing
        ? {
            ...s.toolCalls,
            [toolUseId]: {
              ...existing,
              approvalStatus: decision === 'deny' ? ('denied' as const) : ('approved' as const),
            },
          }
        : s.toolCalls;
      return {
        pendingPermissions: rest,
        toolCalls: updatedToolCalls,
      };
    });
  },

  handleAskUser: (event) => {
    set((s) => ({
      pendingAskUser: { ...s.pendingAskUser, [event.askId]: event },
    }));
  },

  handleAskUserResolved: (askId) => {
    set((s) => {
      const { [askId]: _removed, ...rest } = s.pendingAskUser;
      return { pendingAskUser: rest };
    });
  },

  respondAskUser: async (askId, answer) => {
    try {
      await invoke('agent_respond_ask', { askId, answer });
      get().handleAskUserResolved(askId);
    } catch (e) {
      console.error('[agentStore] respondAskUser failed:', e);
    }
  },

  handleStatus: (conversationId, message) => {
    set((s) => ({
      agentStatus: { ...s.agentStatus, [conversationId]: message },
    }));
  },

  clearStatus: (conversationId) => {
    set((s) => {
      const { [conversationId]: _removed, ...rest } = s.agentStatus;
      return { agentStatus: rest };
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
      set((s) => ({
        queryStats: { ...s.queryStats, [event.assistantMessageId]: stats },
      }));
    }
  },

  loadToolHistory: async (conversationId) => {
    try {
      const executions = await invoke<ToolExecution[]>('list_tool_executions', {
        conversationId,
      });
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
          try { input = JSON.parse(exec.inputPreview); } catch { /* leave empty */ }
        }

        toolCalls[exec.id] = {
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

      set((s) => ({
        toolCalls: { ...toolCalls, ...s.toolCalls },
      }));
    } catch (e) {
      console.error('[agentStore] loadToolHistory failed:', e);
    }
  },

  clearConversation: (conversationId) => {
    set((s) => {
      const { [conversationId]: _session, ...sessions } = s.sessions;
      const { [conversationId]: _status, ...agentStatus } = s.agentStatus;

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

      // ToolCallState doesn't carry conversationId; filter via pendingPermissions
      // that were already associated with this conversation. A more thorough
      // cleanup happens naturally as the conversation is no longer active.
      return { sessions, agentStatus, pendingPermissions, pendingAskUser };
    });
  },
}));

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
