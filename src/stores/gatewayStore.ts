import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type { EnsureLoadedOptions, ResourceInvalidationReason, ResourceMeta } from '@/lib/resourceState';
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
  CodexSessionVisibilityStatus,
  CodexSessionVisibilityRepairResult,
} from '@/types';

let statusRequest: { revision: number; promise: Promise<void> } | null = null;
let metricsRequest: { revision: number; promise: Promise<void> } | null = null;
let keysRequest: { revision: number; promise: Promise<void> } | null = null;
let requestLogsRequest: { revision: number; key: string; promise: Promise<void> } | null = null;
let usageRequest: { revision: number; key: string; promise: Promise<void> } | null = null;
let diagnosticsRequest: { revision: number; promise: Promise<void> } | null = null;
let cliToolsRequest: { revision: number; promise: Promise<void> } | null = null;

const DIAGNOSTICS_RESOURCE_KEY = 'gateway-diagnostics';
const CLI_TOOLS_RESOURCE_KEY = 'gateway-cli-tools';
const requestLogsResourceKey = (limit: number, offset: number) =>
  `gateway-request-logs:${limit}:${offset}`;
const usageResourceKey = (days: number) => `gateway-usage:${days}`;

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
  statusMeta: ResourceMeta;
  metricsMeta: ResourceMeta;
  keysMeta: ResourceMeta;
  requestLogsMeta: ResourceMeta;
  usageMeta: ResourceMeta;
  diagnosticsMeta: ResourceMeta;
  cliToolsMeta: ResourceMeta;
  ensureStatusLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  ensureMetricsLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  ensureKeysLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  ensureRequestLogsLoaded: (
    limit?: number,
    offset?: number,
    options?: EnsureLoadedOptions,
  ) => Promise<void>;
  ensureUsageLoaded: (days?: number, options?: EnsureLoadedOptions) => Promise<void>;
  ensureDiagnosticsLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  ensureCliToolStatusesLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateGatewayResources: (reason: ResourceInvalidationReason) => void;
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
  decryptKey: (id: string) => Promise<string>;
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
  getCodexSessionVisibilityStatus: () => Promise<CodexSessionVisibilityStatus>;
  repairCodexSessionVisibility: (createBackup: boolean) => Promise<CodexSessionVisibilityRepairResult>;
}

export const useGatewayStore = create<GatewayState>((set, get) => ({
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
  statusMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  metricsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  keysMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  requestLogsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  usageMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  diagnosticsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  cliToolsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureKeysLoaded: async (options = {}) => {
    const key = 'gateway-keys';
    const state = get();
    if (!options.force && isResourceFresh(state.keysMeta, { ...options, key })) return;
    if (keysRequest?.revision === state.keysMeta.revision && !options.force) {
      return keysRequest.promise;
    }
    if (keysRequest) {
      await keysRequest.promise;
      return get().ensureKeysLoaded(options);
    }

    const revision = state.keysMeta.revision;
    set((state) => ({ loading: true, keysMeta: { ...state.keysMeta, status: 'loading', key } }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const keys = await invoke<GatewayKey[]>('list_gateway_keys');
        if (get().keysMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            keys,
            loading: false,
            error: null,
            keysMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().keysMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            error: String(e),
            loading: false,
            keysMeta: { ...current.keysMeta, status: 'error' },
          }));
        }
      } finally {
        keysRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureKeysLoaded();
    })();
    keysRequest = { revision, promise };
    return promise;
  },

  fetchKeys: () => get().ensureKeysLoaded({ force: true }),

  createKey: async (name) => {
    try {
      const result = await invoke<CreateGatewayKeyResult>('create_gateway_key', { name });
      set((s) => ({
        keys: [...s.keys, result.gateway_key],
        error: null,
        keysMeta: { ...s.keysMeta, revision: s.keysMeta.revision + 1, loadedAt: Date.now() },
      }));
      return result;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteKey: async (id) => {
    try {
      await invoke('delete_gateway_key', { id });
      set((s) => ({
        keys: s.keys.filter((k) => k.id !== id),
        error: null,
        keysMeta: { ...s.keysMeta, revision: s.keysMeta.revision + 1, loadedAt: Date.now() },
      }));
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
        keysMeta: { ...s.keysMeta, revision: s.keysMeta.revision + 1, loadedAt: Date.now() },
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  decryptKey: async (id) => {
    try {
      const plainKey = await invoke<string>('decrypt_gateway_key', { id });
      return plainKey;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  startGateway: async () => {
    try {
      await invoke('start_gateway');
      const status = await invoke<GatewayStatus>('get_gateway_status');
      set((state) => ({
        status,
        error: null,
        statusMeta: {
          status: 'ready',
          key: 'gateway-status',
          loadedAt: Date.now(),
          revision: state.statusMeta.revision + 1,
        },
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  stopGateway: async () => {
    try {
      await invoke('stop_gateway');
      const status = await invoke<GatewayStatus>('get_gateway_status');
      set((state) => ({
        status,
        error: null,
        statusMeta: {
          status: 'ready',
          key: 'gateway-status',
          loadedAt: Date.now(),
          revision: state.statusMeta.revision + 1,
        },
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  ensureStatusLoaded: async (options = {}) => {
    const key = 'gateway-status';
    const state = get();
    if (!options.force && isResourceFresh(state.statusMeta, { ...options, key })) return;
    if (statusRequest?.revision === state.statusMeta.revision && !options.force) {
      return statusRequest.promise;
    }
    if (statusRequest) {
      await statusRequest.promise;
      return get().ensureStatusLoaded(options);
    }

    const revision = state.statusMeta.revision;
    set((state) => ({ statusMeta: { ...state.statusMeta, status: 'loading', key } }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const status = await invoke<GatewayStatus>('get_gateway_status');
        if (get().statusMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set({
            status,
            error: null,
            statusMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().statusMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set((current) => ({
            error: String(e),
            statusMeta: { ...current.statusMeta, status: 'error' },
          }));
        }
      } finally {
        statusRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureStatusLoaded();
    })();
    statusRequest = { revision, promise };
    return promise;
  },

  fetchStatus: () => get().ensureStatusLoaded({ force: true }),

  ensureMetricsLoaded: async (options = {}) => {
    const key = 'gateway-metrics';
    const state = get();
    if (!options.force && isResourceFresh(state.metricsMeta, { ...options, key })) return;
    if (metricsRequest?.revision === state.metricsMeta.revision && !options.force) {
      return metricsRequest.promise;
    }
    if (metricsRequest) {
      await metricsRequest.promise;
      return get().ensureMetricsLoaded(options);
    }

    const revision = state.metricsMeta.revision;
    set((state) => ({ metricsMeta: { ...state.metricsMeta, status: 'loading', key } }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const metrics = await invoke<GatewayMetrics>('get_gateway_metrics');
        if (get().metricsMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set({
            metrics,
            error: null,
            metricsMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().metricsMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set((current) => ({
            error: String(e),
            metricsMeta: { ...current.metricsMeta, status: 'error' },
          }));
        }
      } finally {
        metricsRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureMetricsLoaded();
    })();
    metricsRequest = { revision, promise };
    return promise;
  },

  fetchMetrics: () => get().ensureMetricsLoaded({ force: true }),

  invalidateGatewayResources: (_reason) => set((state) => ({
    requestLogsLoading: false,
    cliToolsLoading: false,
    statusMeta: { status: 'idle', key: null, loadedAt: null, revision: state.statusMeta.revision + 1 },
    metricsMeta: { status: 'idle', key: null, loadedAt: null, revision: state.metricsMeta.revision + 1 },
    keysMeta: { status: 'idle', key: null, loadedAt: null, revision: state.keysMeta.revision + 1 },
    requestLogsMeta: {
      status: 'idle', key: null, loadedAt: null, revision: state.requestLogsMeta.revision + 1,
    },
    usageMeta: { status: 'idle', key: null, loadedAt: null, revision: state.usageMeta.revision + 1 },
    diagnosticsMeta: {
      status: 'idle', key: null, loadedAt: null, revision: state.diagnosticsMeta.revision + 1,
    },
    cliToolsMeta: {
      status: 'idle', key: null, loadedAt: null, revision: state.cliToolsMeta.revision + 1,
    },
  })),

  ensureUsageLoaded: async (days = 30, options = {}) => {
    const key = usageResourceKey(days);
    const state = get();
    if (!options.force && isResourceFresh(state.usageMeta, { ...options, key })) return;
    if (
      usageRequest?.revision === state.usageMeta.revision
      && usageRequest.key === key
      && !options.force
    ) return usageRequest.promise;
    if (usageRequest) {
      await usageRequest.promise;
      return get().ensureUsageLoaded(days, options);
    }

    const revision = state.usageMeta.revision;
    set((current) => ({
      usageMeta: { ...current.usageMeta, status: 'loading', key },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const [usageByKey, usageByProvider, usageByDay] = await Promise.all([
          invoke<UsageByKey[]>('get_gateway_usage_by_key'),
          invoke<UsageByProvider[]>('get_gateway_usage_by_provider'),
          invoke<UsageByDay[]>('get_gateway_usage_by_day', { days }),
        ]);
        if (get().usageMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set({
            usageByKey,
            usageByProvider,
            usageByDay,
            error: null,
            usageMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().usageMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set((current) => ({
            error: String(e),
            usageMeta: { ...current.usageMeta, status: 'error' },
          }));
        }
      } finally {
        usageRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureUsageLoaded(days);
    })();
    usageRequest = { revision, key, promise };
    return promise;
  },

  fetchUsageByKey: async () => {
    await get().ensureUsageLoaded(30, { force: true });
  },

  fetchUsageByProvider: async () => {
    await get().ensureUsageLoaded(30, { force: true });
  },

  fetchUsageByDay: async (days = 30) => {
    await get().ensureUsageLoaded(days, { force: true });
  },

  fetchConnectedPrograms: async () => {
    try {
      const connectedPrograms = await invoke<ConnectedProgram[]>('get_connected_programs');
      set({ connectedPrograms });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  ensureDiagnosticsLoaded: async (options = {}) => {
    const key = DIAGNOSTICS_RESOURCE_KEY;
    const state = get();
    if (!options.force && isResourceFresh(state.diagnosticsMeta, { ...options, key })) return;
    if (diagnosticsRequest?.revision === state.diagnosticsMeta.revision && !options.force) {
      return diagnosticsRequest.promise;
    }
    if (diagnosticsRequest) {
      await diagnosticsRequest.promise;
      return get().ensureDiagnosticsLoaded(options);
    }

    const revision = state.diagnosticsMeta.revision;
    set((current) => ({
      diagnosticsMeta: { ...current.diagnosticsMeta, status: 'loading', key },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const diagnostics = await invoke<GatewayDiagnostic[]>('get_gateway_diagnostics');
        if (get().diagnosticsMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set({
            diagnostics,
            error: null,
            diagnosticsMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().diagnosticsMeta.revision !== revision) {
          reloadAfterCompletion = true;
        } else {
          set((current) => ({
            error: String(e),
            diagnosticsMeta: { ...current.diagnosticsMeta, status: 'error' },
          }));
        }
      } finally {
        diagnosticsRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureDiagnosticsLoaded();
    })();
    diagnosticsRequest = { revision, promise };
    return promise;
  },

  loadDiagnostics: () => get().ensureDiagnosticsLoaded({ force: true }),

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

  ensureRequestLogsLoaded: async (limit = 100, offset = 0, options = {}) => {
    const key = requestLogsResourceKey(limit, offset);
    const state = get();
    if (!options.force && isResourceFresh(state.requestLogsMeta, { ...options, key })) return;
    if (
      requestLogsRequest?.revision === state.requestLogsMeta.revision
      && requestLogsRequest.key === key
      && !options.force
    ) return requestLogsRequest.promise;
    if (requestLogsRequest) {
      await requestLogsRequest.promise;
      return get().ensureRequestLogsLoaded(limit, offset, options);
    }

    const revision = state.requestLogsMeta.revision;
    set((current) => ({
      requestLogsLoading: true,
      requestLogsMeta: { ...current.requestLogsMeta, status: 'loading', key },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const requestLogs = await invoke<GatewayRequestLog[]>('list_gateway_request_logs', {
          limit,
          offset,
        });
        if (get().requestLogsMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ requestLogsLoading: false });
        } else {
          set({
            requestLogs,
            requestLogsLoading: false,
            error: null,
            requestLogsMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().requestLogsMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ requestLogsLoading: false });
        } else {
          set((current) => ({
            error: String(e),
            requestLogsLoading: false,
            requestLogsMeta: { ...current.requestLogsMeta, status: 'error' },
          }));
        }
      } finally {
        requestLogsRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureRequestLogsLoaded(limit, offset);
    })();
    requestLogsRequest = { revision, key, promise };
    return promise;
  },

  fetchRequestLogs: (limit = 100, offset = 0) =>
    get().ensureRequestLogsLoaded(limit, offset, { force: true }),

  listRequestLogs: async (limit = 100, offset = 0) => {
    await get().ensureRequestLogsLoaded(limit, offset, { maxAgeMs: 5_000 });
    return get().requestLogs;
  },

  clearRequestLogs: async () => {
    try {
      await invoke('clear_gateway_request_logs');
      set((state) => ({
        requestLogs: [],
        requestLogsMeta: {
          status: 'ready',
          key: state.requestLogsMeta.key ?? requestLogsResourceKey(100, 0),
          loadedAt: Date.now(),
          revision: state.requestLogsMeta.revision + 1,
        },
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  ensureCliToolStatusesLoaded: async (options = {}) => {
    const key = CLI_TOOLS_RESOURCE_KEY;
    const state = get();
    if (!options.force && isResourceFresh(state.cliToolsMeta, { ...options, key })) return;
    if (cliToolsRequest?.revision === state.cliToolsMeta.revision && !options.force) {
      return cliToolsRequest.promise;
    }
    if (cliToolsRequest) {
      await cliToolsRequest.promise;
      return get().ensureCliToolStatusesLoaded(options);
    }

    const revision = state.cliToolsMeta.revision;
    set((current) => ({
      cliToolsLoading: true,
      cliToolsMeta: { ...current.cliToolsMeta, status: 'loading', key },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const cliTools = await invoke<CliToolInfo[]>('get_all_cli_tool_statuses');
        if (get().cliToolsMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ cliToolsLoading: false });
        } else {
          set({
            cliTools,
            cliToolsLoading: false,
            error: null,
            cliToolsMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        if (get().cliToolsMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ cliToolsLoading: false });
        } else {
          set((current) => ({
            error: String(e),
            cliToolsLoading: false,
            cliToolsMeta: { ...current.cliToolsMeta, status: 'error' },
          }));
        }
      } finally {
        cliToolsRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureCliToolStatusesLoaded();
    })();
    cliToolsRequest = { revision, promise };
    return promise;
  },

  fetchCliToolStatuses: () => get().ensureCliToolStatusesLoaded({ force: true }),

  connectCliTool: async (tool, keyId, protocol) => {
    try {
      await invoke('connect_cli_tool', { tool, keyId, protocol });
      set((state) => ({
        error: null,
        cliToolsMeta: {
          status: 'idle',
          key: null,
          loadedAt: null,
          revision: state.cliToolsMeta.revision + 1,
        },
      }));
      await get().ensureCliToolStatusesLoaded();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  disconnectCliTool: async (tool, restoreBackup) => {
    try {
      await invoke('disconnect_cli_tool', { tool, restoreBackup });
      set((state) => ({
        error: null,
        cliToolsMeta: {
          status: 'idle',
          key: null,
          loadedAt: null,
          revision: state.cliToolsMeta.revision + 1,
        },
      }));
      await get().ensureCliToolStatusesLoaded();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  getCodexSessionVisibilityStatus: async () => {
    try {
      const status = await invoke<CodexSessionVisibilityStatus>('get_codex_session_visibility_status');
      set({ error: null });
      return status;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  repairCodexSessionVisibility: async (createBackup) => {
    try {
      const result = await invoke<CodexSessionVisibilityRepairResult>(
        'repair_codex_session_visibility',
        { createBackup },
      );
      set({ error: null });
      return result;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
}));
