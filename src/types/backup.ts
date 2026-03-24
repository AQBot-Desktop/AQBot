export type BackupJobKind = 'backup' | 'restore' | 'indexing';
export type BackupJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
export type BackupTargetKind = 'local' | 'webdav' | 's3';

export type BackupManifest = {
  id: string;
  version: string;
  createdAt: string;
  encrypted: boolean;
  checksum: string;
  objectCountsJson: string;
  sourceAppVersion: string;
  filePath: string | null;
  fileSize: number;
};

export type AutoBackupSettings = {
  enabled: boolean;
  intervalHours: number;
  maxCount: number;
  backupDir: string | null;
};

export type BackupJob = {
  id: string;
  kind: BackupJobKind;
  status: BackupJobStatus;
  progress: number;
  message?: string;
  createdAt: string;
  updatedAt: string;
};

export type BackupTarget = {
  kind: BackupTargetKind;
  configJson: string;
};

export type CreateBackupJobInput = {
  target: BackupTarget;
  includeAttachments: boolean;
  includeKnowledgeFiles: boolean;
  includeGatewayConfig: boolean;
  passphrase?: string;
};

export type ProgramPolicy = {
  id: string;
  programName: string;
  allowedProviderIds: string[];
  allowedModelIds: string[];
  defaultProviderId?: string;
  defaultModelId?: string;
  rateLimitPerMinute?: number;
};

export type GatewayDiagnosticCategory = 'provider_latency' | 'provider_error' | 'proxy' | 'auth' | 'port';
export type GatewayDiagnosticStatus = 'ok' | 'warning' | 'error';

export type GatewayDiagnostic = {
  id: string;
  category: GatewayDiagnosticCategory;
  status: GatewayDiagnosticStatus;
  message: string;
  createdAt: string;
};

export type GatewayRequestLog = {
  id: string;
  keyId: string;
  keyName: string;
  method: string;
  path: string;
  model: string | null;
  providerId: string | null;
  statusCode: number;
  durationMs: number;
  requestTokens: number;
  responseTokens: number;
  errorMessage: string | null;
  createdAt: number;
};

export type GatewayTemplateTarget = 'cursor' | 'vscode' | 'claude_code' | 'openai_compatible';
export type GatewayTemplateFormat = 'json' | 'yaml' | 'markdown';

export type GatewayTemplate = {
  id: string;
  name: string;
  target: GatewayTemplateTarget;
  format: GatewayTemplateFormat;
  content: string;
  copyHint?: string;
};

// CLI Tool Integration
export type CliToolStatus = 'not_installed' | 'not_connected' | 'connected';
export type QuickConnectProtocol = 'http' | 'https';

export type CliToolInfo = {
  id: string;
  name: string;
  status: CliToolStatus;
  version: string | null;
  configPath: string | null;
  hasBackup: boolean;
  connectedProtocol: QuickConnectProtocol | null;
};

export type DesktopCapabilityKey = 'tray' | 'global_shortcut' | 'protocol_handler' | 'mini_window' | 'artifact_window' | 'notification';

export type DesktopCapability = {
  key: DesktopCapabilityKey;
  supported: boolean;
  reason?: string;
};

export type TrayAction = 'show_main' | 'open_mini_window' | 'resume_voice_call' | 'run_quick_backup' | 'quit';

export type ProtocolLaunchPayload = {
  source: 'browser' | 'os_protocol';
  route: 'chat' | 'gateway' | 'settings';
  query?: Record<string, string>;
};

export type WindowStateSnapshot = {
  windowKey: 'main' | 'mini' | 'voice' | 'artifact';
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  visible: boolean;
};

export type DesktopNotification = {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  actionLabel?: string;
};
