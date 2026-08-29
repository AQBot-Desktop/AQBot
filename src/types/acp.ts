import type { Attachment } from './index';

export type AcpRegistryRefreshPolicy = 'on_start' | 'manual' | 'never';

export interface AcpGeneralConfig {
  idleTimeoutSecs: number;
  maxConcurrentProcesses: number;
  permissionDefault: string;
  registryRefresh: AcpRegistryRefreshPolicy;
}

export type RegistryAddOutcome =
  | 'alreadyConfigured'
  | 'reuseLocal'
  | 'installRequired'
  | 'manualRequired'
  | 'quarantined';

export interface RegistryAddPreview {
  agentId: string;
  outcome: RegistryAddOutcome;
  command: string;
  args: string[];
  env?: Record<string, string>;
  kind: string;
  source: string;
  version?: string | null;
  catalogVersion?: string | null;
  installerKind?: string | null;
  installerSpec?: string | null;
  approvalToken?: string | null;
  configured?: ConfiguredAgent | null;
  quarantineReason?: string | null;
  manualReason?: string | null;
}

export interface ConfiguredAgent {
  id: string;
  name: string;
  enabled: boolean;
  source: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  icon?: string | null;
  sort: number;
}

export interface AcpAgentsFile {
  general: AcpGeneralConfig;
  agents: ConfiguredAgent[];
}

export interface RegistryAgent {
  id: string;
  name: string;
  version?: string | null;
  description?: string | null;
  repository?: string | null;
  website?: string | null;
  icon?: string | null;
  license?: string | null;
  quarantineReason?: string | null;
}

export interface RegistryFile {
  version: string;
  agents: RegistryAgent[];
  source?: 'builtin' | 'cache' | 'live' | null;
  fetchedAt?: string | null;
}

export interface AcpProject {
  id: string;
  name: string;
  root_path: string;
  kind: 'project' | 'recent' | 'recent_draft';
  sort_order: number;
  created_at: string;
  updated_at: string;
  last_opened_at?: string | null;
}

export interface AcpThread {
  id: string;
  project_id: string;
  agent_id: string;
  title: string;
  acp_session_id?: string | null;
  runtime_status: string;
  mode_id?: string | null;
  /** 0 = unpinned, non-zero = pinned */
  is_pinned: number;
  /** Manual order within project (after pin group) */
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AcpRecentThreadReceipt {
  project: AcpProject;
  thread: AcpThread;
}

export interface AcpMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  status?: string | null;
  attachments: Attachment[];
  meta_json?: string | null;
  created_at: string;
}

export interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
  _meta?: Record<string, unknown> | null;
}

export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionCapabilities {
  list?: Record<string, unknown> | null;
  delete?: Record<string, unknown> | null;
  additionalDirectories?: Record<string, unknown> | null;
  resume?: Record<string, unknown> | null;
  close?: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpAgentAuthCapabilities {
  logout?: { _meta?: Record<string, unknown> | null } | null;
  _meta?: Record<string, unknown> | null;
}

/** ACP v1 capabilities advertised by the Agent during initialize. */
export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: AcpPromptCapabilities;
  mcpCapabilities?: AcpMcpCapabilities;
  sessionCapabilities?: AcpSessionCapabilities;
  auth?: AcpAgentAuthCapabilities;
  _meta?: Record<string, unknown> | null;
}

export interface AcpPromptAccepted {
  userMessage: AcpMessage;
  assistantMessage: AcpMessage;
}

export interface AgentProbeResult {
  agentId: string;
  available: boolean;
  command: string;
  message: string;
}

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

export interface AcpSessionConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionConfigSelectGroup {
  group: string;
  name: string;
  options: AcpSessionConfigSelectOption[];
}

export interface AcpSessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | string | null;
  type: 'select' | 'boolean';
  currentValue: string | boolean;
  options?: AcpSessionConfigSelectOption[] | AcpSessionConfigSelectGroup[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionSnapshot {
  sessionId: string;
  modes?: AcpSessionModeState | null;
  configOptions: AcpSessionConfigOption[];
  agentCapabilities: AcpAgentCapabilities;
}
