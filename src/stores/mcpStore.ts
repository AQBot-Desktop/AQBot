import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type {
  EnsureLoadedOptions,
  ResourceInvalidationReason,
  ResourceMeta,
} from '@/lib/resourceState';
import type { McpServer, CreateMcpServerInput, UpdateMcpServerInput, ToolDescriptor, ToolExecution } from '@/types';

const MCP_SERVERS_RESOURCE_KEY = 'mcp-servers';
let serversRequest: { revision: number; promise: Promise<void> } | null = null;

function mutateServersMeta(meta: ResourceMeta): ResourceMeta {
  return {
    status: meta.status === 'ready' ? 'ready' : 'idle',
    key: meta.status === 'ready' ? MCP_SERVERS_RESOURCE_KEY : null,
    loadedAt: meta.status === 'ready' ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

interface McpState {
  servers: McpServer[];
  toolDescriptors: Record<string, ToolDescriptor[]>;
  toolExecutions: ToolExecution[];
  loading: boolean;
  error: string | null;
  serversMeta: ResourceMeta;

  ensureServersLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateServers: (reason: ResourceInvalidationReason) => void;
  loadServers: () => Promise<void>;
  createServer: (input: CreateMcpServerInput) => Promise<McpServer | null>;
  updateServer: (id: string, input: UpdateMcpServerInput) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  testServer: (id: string) => Promise<{ ok: boolean; error?: string }>;
  loadToolDescriptors: (serverId: string) => Promise<void>;
  discoverTools: (serverId: string) => Promise<ToolDescriptor[]>;
  loadToolExecutions: (conversationId: string) => Promise<void>;
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  toolDescriptors: {},
  toolExecutions: [],
  loading: false,
  error: null,
  serversMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureServersLoaded: async (options = {}) => {
    const state = get();
    if (!options.force && isResourceFresh(state.serversMeta, {
      ...options,
      key: MCP_SERVERS_RESOURCE_KEY,
    })) return;
    if (serversRequest?.revision === state.serversMeta.revision) {
      return serversRequest.promise;
    }

    const revision = state.serversMeta.revision;
    set((current) => ({
      loading: true,
      serversMeta: {
        ...current.serversMeta,
        status: 'loading',
        key: MCP_SERVERS_RESOURCE_KEY,
      },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const servers = await invoke<McpServer[]>('list_mcp_servers');
        if (get().serversMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            servers,
            loading: false,
            error: null,
            serversMeta: {
              status: 'ready',
              key: MCP_SERVERS_RESOURCE_KEY,
              loadedAt: Date.now(),
              revision,
            },
          });
        }
      } catch (e) {
        if (get().serversMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            error: String(e),
            loading: false,
            serversMeta: { ...current.serversMeta, status: 'error' },
          }));
        }
      } finally {
        if (serversRequest?.promise === promise) serversRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureServersLoaded();
    })();
    serversRequest = { revision, promise };
    return promise;
  },

  invalidateServers: (_reason) => set((state) => ({
    loading: false,
    serversMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.serversMeta.revision + 1,
    },
  })),

  loadServers: () => get().ensureServersLoaded({ force: true }),

  createServer: async (input) => {
    try {
      const server = await invoke<McpServer>('create_mcp_server', { input });
      set((s) => ({
        servers: [...s.servers, server],
        serversMeta: mutateServersMeta(s.serversMeta),
        error: null,
      }));
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
        serversMeta: mutateServersMeta(s.serversMeta),
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
        serversMeta: mutateServersMeta(s.serversMeta),
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

  discoverTools: async (serverId) => {
    try {
      const tools = await invoke<ToolDescriptor[]>('discover_mcp_tools', { id: serverId });
      set((s) => ({
        toolDescriptors: { ...s.toolDescriptors, [serverId]: tools },
        error: null,
      }));
      return tools;
    } catch (e) {
      set({ error: String(e) });
      throw e;
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
