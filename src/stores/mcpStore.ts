import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type { McpServer, CreateMcpServerInput, UpdateMcpServerInput, ToolDescriptor, ToolExecution } from '@/types';

interface McpState {
  servers: McpServer[];
  toolDescriptors: Record<string, ToolDescriptor[]>;
  toolExecutions: ToolExecution[];
  loading: boolean;
  error: string | null;

  loadServers: () => Promise<void>;
  createServer: (input: CreateMcpServerInput) => Promise<McpServer | null>;
  updateServer: (id: string, input: UpdateMcpServerInput) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  testServer: (id: string) => Promise<{ ok: boolean; error?: string }>;
  loadToolDescriptors: (serverId: string) => Promise<void>;
  loadToolExecutions: (conversationId: string) => Promise<void>;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  toolDescriptors: {},
  toolExecutions: [],
  loading: false,
  error: null,

  loadServers: async () => {
    set({ loading: true });
    try {
      const servers = await invoke<McpServer[]>('list_mcp_servers');
      set({ servers, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createServer: async (input) => {
    try {
      const server = await invoke<McpServer>('create_mcp_server', { input });
      set((s) => ({ servers: [...s.servers, server], error: null }));
      return server;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  updateServer: async (id, input) => {
    try {
      const updated = await invoke<McpServer>('update_mcp_server', { id, input });
      set((s) => ({
        servers: s.servers.map((srv) => (srv.id === id ? updated : srv)),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteServer: async (id) => {
    try {
      await invoke('delete_mcp_server', { id });
      set((s) => ({
        servers: s.servers.filter((srv) => srv.id !== id),
        toolDescriptors: Object.fromEntries(
          Object.entries(s.toolDescriptors).filter(([k]) => k !== id),
        ),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  testServer: async (id) => {
    try {
      const result = await invoke<{ ok: boolean; error?: string }>(
        'test_mcp_server',
        { id },
      );
      return result;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  loadToolDescriptors: async (serverId) => {
    try {
      const tools = await invoke<ToolDescriptor[]>('list_mcp_tools', { serverId });
      set((s) => ({
        toolDescriptors: { ...s.toolDescriptors, [serverId]: tools },
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadToolExecutions: async (conversationId) => {
    try {
      const executions = await invoke<ToolExecution[]>('list_tool_executions', {
        conversationId,
      });
      set({ toolExecutions: executions, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
