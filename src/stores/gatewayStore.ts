import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type {
  GatewayStatus,
  GatewayKey,
  GatewayMetrics,
  CreateGatewayKeyResult,
  UsageByKey,
  UsageByProvider,
  UsageByDay,
  ConnectedProgram,
  GatewayDiagnostic,
  ProgramPolicy,
  GatewayTemplate,
  GatewayRequestLog,
  CliToolInfo,
  QuickConnectProtocol,
} from '@/types';

interface GatewayState {
  status: GatewayStatus;
  keys: GatewayKey[];
  metrics: GatewayMetrics | null;
  usageByKey: UsageByKey[];
  usageByProvider: UsageByProvider[];
  usageByDay: UsageByDay[];
  connectedPrograms: ConnectedProgram[];
  loading: boolean;
  error: string | null;
  diagnostics: GatewayDiagnostic[];
  programPolicies: ProgramPolicy[];
  gatewayTemplates: GatewayTemplate[];
  requestLogs: GatewayRequestLog[];
  requestLogsLoading: boolean;
  cliTools: CliToolInfo[];
  cliToolsLoading: boolean;
  loadDiagnostics: () => Promise<void>;
  loadProgramPolicies: () => Promise<void>;
  saveProgramPolicy: (input: {
    programName: string;
    allowedProviderIds: string[];
    allowedModelIds: string[];
    defaultProviderId?: string;
    defaultModelId?: string;
    rateLimitPerMinute?: number;
  }) => Promise<ProgramPolicy>;
  loadGatewayTemplates: () => Promise<void>;
  copyGatewayTemplate: (templateId: string) => Promise<string>;
  fetchKeys: () => Promise<void>;
  createKey: (name: string) => Promise<CreateGatewayKeyResult>;
  deleteKey: (id: string) => Promise<void>;
  toggleKey: (id: string, enabled: boolean) => Promise<void>;
  startGateway: () => Promise<void>;
  stopGateway: () => Promise<void>;
  fetchStatus: () => Promise<void>;
  fetchMetrics: () => Promise<void>;
  fetchUsageByKey: () => Promise<void>;
  fetchUsageByProvider: () => Promise<void>;
  fetchUsageByDay: (days?: number) => Promise<void>;
  fetchConnectedPrograms: () => Promise<void>;
  listRequestLogs: (limit?: number, offset?: number) => Promise<GatewayRequestLog[]>;
  fetchRequestLogs: (limit?: number, offset?: number) => Promise<void>;
  clearRequestLogs: () => Promise<void>;
  fetchCliToolStatuses: () => Promise<void>;
  connectCliTool: (tool: string, keyId: string, protocol: QuickConnectProtocol) => Promise<void>;
  disconnectCliTool: (tool: string, restoreBackup: boolean) => Promise<void>;
}

export const useGatewayStore = create<GatewayState>((set) => ({
  status: {
    is_running: false,
    listen_address: '127.0.0.1',
    port: 8080,
    ssl_enabled: false,
    started_at: null,
    https_port: null,
    force_ssl: false,
  },
  keys: [],
  metrics: null,
  usageByKey: [],
  usageByProvider: [],
  usageByDay: [],
  connectedPrograms: [],
  loading: false,
  error: null,
  diagnostics: [],
  programPolicies: [],
  gatewayTemplates: [],
  requestLogs: [],
  requestLogsLoading: false,
  cliTools: [],
  cliToolsLoading: false,

  fetchKeys: async () => {
    set({ loading: true });
    try {
      const keys = await invoke<GatewayKey[]>('list_gateway_keys');
      set({ keys, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createKey: async (name) => {
    try {
      const result = await invoke<CreateGatewayKeyResult>('create_gateway_key', { name });
      set((s) => ({ keys: [...s.keys, result.gateway_key], error: null }));
      return result;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteKey: async (id) => {
    try {
      await invoke('delete_gateway_key', { id });
      set((s) => ({ keys: s.keys.filter((k) => k.id !== id), error: null }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  toggleKey: async (id, enabled) => {
    try {
      await invoke('toggle_gateway_key', { id, enabled });
      set((s) => ({
        keys: s.keys.map((k) => (k.id === id ? { ...k, enabled } : k)),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  startGateway: async () => {
    try {
      await invoke('start_gateway');
      const status = await invoke<GatewayStatus>('get_gateway_status');
      set({ status, error: null });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  stopGateway: async () => {
    try {
      await invoke('stop_gateway');
      const status = await invoke<GatewayStatus>('get_gateway_status');
      set({ status, error: null });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  fetchStatus: async () => {
    try {
      const status = await invoke<GatewayStatus>('get_gateway_status');
      set({ status });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchMetrics: async () => {
    try {
      const metrics = await invoke<GatewayMetrics>('get_gateway_metrics');
      set({ metrics });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchUsageByKey: async () => {
    try {
      const usageByKey = await invoke<UsageByKey[]>('get_gateway_usage_by_key');
      set({ usageByKey });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchUsageByProvider: async () => {
    try {
      const usageByProvider = await invoke<UsageByProvider[]>('get_gateway_usage_by_provider');
      set({ usageByProvider });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchUsageByDay: async (days = 30) => {
    try {
      const usageByDay = await invoke<UsageByDay[]>('get_gateway_usage_by_day', { days });
      set({ usageByDay });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchConnectedPrograms: async () => {
    try {
      const connectedPrograms = await invoke<ConnectedProgram[]>('get_connected_programs');
      set({ connectedPrograms });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadDiagnostics: async () => {
    try {
      const diagnostics = await invoke<GatewayDiagnostic[]>('get_gateway_diagnostics');
      set({ diagnostics });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadProgramPolicies: async () => {
    try {
      const programPolicies = await invoke<ProgramPolicy[]>('get_program_policies');
      set({ programPolicies });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  saveProgramPolicy: async (input) => {
    try {
      const policy = await invoke<ProgramPolicy>('save_program_policy', { input });
      set((s) => ({
        programPolicies: [...s.programPolicies.filter((p) => p.id !== policy.id), policy],
        error: null,
      }));
      return policy;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  loadGatewayTemplates: async () => {
    try {
      const gatewayTemplates = await invoke<GatewayTemplate[]>('list_gateway_templates');
      set({ gatewayTemplates });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  copyGatewayTemplate: async (templateId: string) => {
    try {
      const content = await invoke<string>('copy_gateway_template', { templateId: templateId });
      return content;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  fetchRequestLogs: async (limit = 100, offset = 0) => {
    set({ requestLogsLoading: true });
    try {
      const requestLogs = await invoke<GatewayRequestLog[]>('list_gateway_request_logs', { limit, offset });
      set({ requestLogs, requestLogsLoading: false });
    } catch (e) {
      set({ error: String(e), requestLogsLoading: false });
    }
  },

  listRequestLogs: async (limit = 100, offset = 0) => {
    try {
      const requestLogs = await invoke<GatewayRequestLog[]>('list_gateway_request_logs', { limit, offset });
      set({ error: null });
      return requestLogs;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  clearRequestLogs: async () => {
    try {
      await invoke('clear_gateway_request_logs');
      set({ requestLogs: [] });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchCliToolStatuses: async () => {
    set({ cliToolsLoading: true });
    try {
      const cliTools = await invoke<CliToolInfo[]>('get_all_cli_tool_statuses');
      set({ cliTools, cliToolsLoading: false });
    } catch (e) {
      set({ error: String(e), cliToolsLoading: false });
    }
  },

  connectCliTool: async (tool, keyId, protocol) => {
    try {
      await invoke('connect_cli_tool', { tool, keyId, protocol });
      // Refresh statuses after connect
      const cliTools = await invoke<CliToolInfo[]>('get_all_cli_tool_statuses');
      set({ cliTools, error: null });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  disconnectCliTool: async (tool, restoreBackup) => {
    try {
      await invoke('disconnect_cli_tool', { tool, restoreBackup });
      // Refresh statuses after disconnect
      const cliTools = await invoke<CliToolInfo[]>('get_all_cli_tool_statuses');
      set({ cliTools, error: null });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
}));
