import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAgentsFile, RegistryAddPreview, RegistryFile } from '@/types/acp';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(),
}));

const config: AcpAgentsFile = {
  general: {
    idleTimeoutSecs: 300,
    maxConcurrentProcesses: 0,
    permissionDefault: 'default',
    registryRefresh: 'on_start',
  },
  agents: [{
    id: 'grok-build',
    name: 'Grok Build',
    enabled: true,
    source: 'registry',
    command: '/opt/grok',
    args: ['agent', 'stdio'],
    sort: 0,
  }],
};

const emptyConfig: AcpAgentsFile = {
  ...config,
  agents: [],
};

const registry: RegistryFile = {
  version: '1',
  source: 'live',
  agents: [{ id: 'grok-build', name: 'Grok Build', version: '1.0.0' }],
};

describe('acpStore registry add and refresh policy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  it('reuses a local Agent without installer approval and prewarms once', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'acp_preview_registry_agent') {
        return {
          agentId: 'grok-build',
          outcome: 'reuseLocal',
          command: '/opt/grok',
          args: ['agent', 'stdio'],
          kind: 'binary',
          source: 'local',
          approvalToken: 'token-1',
        } satisfies RegistryAddPreview;
      }
      if (command === 'acp_add_agent_from_registry') return config;
      if (command === 'acp_prewarm_enabled_agents') {
        return [{ agentId: 'grok-build', ready: true }];
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { useAcpStore } = await import('../acpStore');
    const preview = await useAcpStore.getState().previewFromRegistry('grok-build');
    await useAcpStore.getState().addFromRegistry('grok-build', {
      allowInstaller: false,
      approvalToken: preview.approvalToken,
    });

    expect(invokeMock).toHaveBeenCalledWith('acp_preview_registry_agent', {
      agentId: 'grok-build',
    });
    expect(invokeMock).toHaveBeenCalledWith('acp_add_agent_from_registry', {
      agentId: 'grok-build',
      enabled: true,
      allowInstaller: false,
      approvalToken: 'token-1',
    });
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('acp_prewarm_enabled_agents');
    });
    expect(invokeMock.mock.calls.filter(([command]) => (
      command === 'acp_add_agent_from_registry'
    ))).toHaveLength(1);
  });

  it('does not add or prewarm when installer confirmation is skipped', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'acp_preview_registry_agent') {
        return {
          agentId: 'grok-build',
          outcome: 'installRequired',
          command: 'npx',
          args: ['-y', '@xai-official/grok@1.0.0', 'agent', 'stdio'],
          kind: 'npx',
          source: 'npx',
          approvalToken: 'token-install',
        } satisfies RegistryAddPreview;
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { useAcpStore } = await import('../acpStore');
    const preview = await useAcpStore.getState().previewFromRegistry('grok-build');
    expect(preview.outcome).toBe('installRequired');
    expect(invokeMock).not.toHaveBeenCalledWith(
      'acp_add_agent_from_registry',
      expect.anything(),
    );
    expect(invokeMock).not.toHaveBeenCalledWith('acp_prewarm_enabled_agents');
  });

  it('commits an approved exact installer once', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'acp_add_agent_from_registry') return config;
      if (command === 'acp_prewarm_enabled_agents') return [];
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { useAcpStore } = await import('../acpStore');
    await useAcpStore.getState().addFromRegistry('grok-build', {
      allowInstaller: true,
      approvalToken: 'token-install',
    });

    expect(invokeMock).toHaveBeenCalledWith('acp_add_agent_from_registry', {
      agentId: 'grok-build',
      enabled: true,
      allowInstaller: true,
      approvalToken: 'token-install',
    });
  });

  it.each([
    ['never', 0],
    ['manual', 0],
    ['on_start', 1],
  ] as const)('registryRefresh=%s refreshes on bootstrap %i time(s)', async (policy, refreshCount) => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'acp_get_config') {
        return {
          ...emptyConfig,
          general: { ...emptyConfig.general, registryRefresh: policy },
        };
      }
      if (
        command === 'acp_list_projects'
        || command === 'acp_list_all_threads'
        || command === 'acp_get_registry'
      ) return command === 'acp_get_registry' ? registry : [];
      if (command === 'acp_refresh_registry') return registry;
      if (command === 'acp_prewarm_enabled_agents') return [];
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const { useAcpStore } = await import('../acpStore');
    useAcpStore.getState().warmBootstrap();
    await vi.waitFor(() => {
      expect(useAcpStore.getState().configReady).toBe(true);
    });
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => (
        command === 'acp_refresh_registry'
      ))).toHaveLength(refreshCount);
    });
  });
});
