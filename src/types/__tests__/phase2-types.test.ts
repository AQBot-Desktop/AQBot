import { describe, it, expect } from 'vitest';
import type {
  SearchProvider,
  McpServer,
  KnowledgeBase,
  MemoryNamespace,
  Artifact,
  BackupManifest,
  ContextSource,
  ConversationBranch,
  ConversationWorkspaceSnapshot,
  ProgramPolicy,
  GatewayDiagnostic,
  GatewayTemplate,
  DesktopCapability,
} from '@/types';

describe('Phase-2 type contracts', () => {
  it('SearchProvider has required fields', () => {
    const sp: SearchProvider = {
      id: 'sp1',
      name: 'Tavily',
      providerType: 'tavily',
      hasApiKey: false,
      enabled: true,
      resultLimit: 10,
      timeoutMs: 5000,
    };
    expect(sp.id).toBe('sp1');
    expect(sp.providerType).toBe('tavily');
  });

  it('McpServer has required fields', () => {
    const ms: McpServer = {
      id: 'ms1',
      name: 'Local MCP',
      transport: 'stdio',
      enabled: true,
      permissionPolicy: 'ask',
      source: 'custom',
    };
    expect(ms.transport).toBe('stdio');
  });

  it('KnowledgeBase has required fields', () => {
    const kb: KnowledgeBase = {
      id: 'kb1',
      name: 'Test KB',
      enabled: true,
    };
    expect(kb.enabled).toBe(true);
  });

  it('MemoryNamespace has required fields', () => {
    const mn: MemoryNamespace = {
      id: 'mn1',
      name: 'Global',
      scope: 'global',
    };
    expect(mn.scope).toBe('global');
  });

  it('Artifact has required fields', () => {
    const a: Artifact = {
      id: 'a1',
      conversationId: 'c1',
      kind: 'draft',
      title: 'Test',
      content: 'content',
      format: 'markdown',
      pinned: false,
      updatedAt: '2025-01-01',
    };
    expect(a.kind).toBe('draft');
  });

  it('BackupManifest has required fields', () => {
    const bm: BackupManifest = {
      id: 'bm1',
      version: '1.0',
      createdAt: '2025-01-01',
      encrypted: false,
      checksum: 'abc123',
      objectCountsJson: '{}',
      sourceAppVersion: '2.0',
      filePath: '/path/to/backup.db',
      fileSize: 1024,
    };
    expect(bm.encrypted).toBe(false);
  });

  it('ConversationWorkspaceSnapshot has required fields', () => {
    const ws: ConversationWorkspaceSnapshot = {
      searchPolicy: { enabled: false, queryMode: 'manual', resultLimit: 10 },
      toolBinding: { serverIds: [], approvalMode: 'ask' },
      knowledgeBinding: { knowledgeBaseIds: [], autoAttach: false },
      memoryPolicy: { enabled: false, writeBack: false },
      toggles: {
        searchEnabled: false,
        enabledKnowledgeBaseIds: [],
        enabledMcpServerIds: [],
        memoryEnabled: false,
        memoryWriteBack: false,
      },
      researchMode: false,
      pinnedArtifactIds: [],
    };
    expect(ws.researchMode).toBe(false);
  });

  it('ProgramPolicy has required fields', () => {
    const pp: ProgramPolicy = {
      id: 'pp1',
      programName: 'cursor',
      allowedProviderIds: [],
      allowedModelIds: [],
    };
    expect(pp.programName).toBe('cursor');
  });

  it('GatewayDiagnostic has required fields', () => {
    const gd: GatewayDiagnostic = {
      id: 'gd1',
      category: 'provider_latency',
      status: 'ok',
      message: 'All good',
      createdAt: '2025-01-01',
    };
    expect(gd.status).toBe('ok');
  });

  it('GatewayTemplate has required fields', () => {
    const gt: GatewayTemplate = {
      id: 'gt1',
      name: 'Cursor',
      target: 'cursor',
      format: 'json',
      content: '{}',
    };
    expect(gt.target).toBe('cursor');
  });

  it('DesktopCapability has required fields', () => {
    const dc: DesktopCapability = {
      key: 'tray',
      supported: true,
    };
    expect(dc.supported).toBe(true);
  });

  it('ContextSource has required fields', () => {
    const cs: ContextSource = {
      id: 'cs1',
      conversationId: 'c1',
      type: 'search',
      refId: 'ref1',
      title: 'Search result',
      enabled: true,
    };
    expect(cs.type).toBe('search');
  });

  it('ConversationBranch has required fields', () => {
    const cb: ConversationBranch = {
      id: 'cb1',
      conversationId: 'c1',
      parentMessageId: 'm1',
      branchLabel: 'Branch 1',
      branchIndex: 0,
      createdAt: '2025-01-01',
    };
    expect(cb.branchIndex).toBe(0);
  });
});
