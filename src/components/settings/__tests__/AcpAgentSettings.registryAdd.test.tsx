import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAgentsFile, RegistryAddPreview, RegistryFile } from '@/types/acp';

const mocks = vi.hoisted(() => ({
  previewFromRegistry: vi.fn(),
  addFromRegistry: vi.fn(),
  loadConfig: vi.fn(),
  loadRegistry: vi.fn(),
  setAgentEnabled: vi.fn(),
  saveGeneral: vi.fn(),
  upsertCustom: vi.fn(),
  removeAgent: vi.fn(),
  reorderAgents: vi.fn(),
  modalConfirm: vi.fn(),
}));

const config: AcpAgentsFile = {
  general: {
    idleTimeoutSecs: 1800,
    maxConcurrentProcesses: 0,
    permissionDefault: 'default',
    registryRefresh: 'on_start',
  },
  agents: [],
};

const registry: RegistryFile = {
  version: '1',
  agents: [
    { id: 'grok-build', name: 'Grok Build', version: '1.0.0' },
    { id: 'codex-acp', name: 'Codex', version: '1.1.13' },
  ],
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, options?: Record<string, string>) => {
      if (key === 'settings.acpAgents.catalogVersion') return `目录版本 ${options?.version}`;
      if (key === 'settings.acpAgents.addSuccess') return `已添加 ${options?.name}`;
      if (key === 'settings.acpAgents.installConfirmContent') return `将执行：${options?.command}`;
      return key;
    },
  }),
}));

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Modal: Object.assign(actual.Modal, {
      confirm: mocks.modalConfirm,
      info: vi.fn(),
    }),
    message: {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
    },
  };
});

vi.mock('@/components/shared/IconEditor', () => ({
  IconEditor: () => null,
}));

vi.mock('@/lib/acpAgentIcon', () => ({
  AcpAgentIcon: () => <span data-testid="acp-agent-icon" />,
  decodeAcpAgentIcon: () => ({ type: null, value: null }),
  encodeAcpAgentIcon: () => null,
}));

vi.mock('@/stores/acpStore', () => ({
  useAcpStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    config,
    registry,
    loading: false,
    loadConfig: mocks.loadConfig,
    loadRegistry: mocks.loadRegistry,
    setAgentEnabled: mocks.setAgentEnabled,
    previewFromRegistry: mocks.previewFromRegistry,
    addFromRegistry: mocks.addFromRegistry,
    saveGeneral: mocks.saveGeneral,
    upsertCustom: mocks.upsertCustom,
    removeAgent: mocks.removeAgent,
    reorderAgents: mocks.reorderAgents,
  }),
}));

describe('AcpAgentSettings registry add', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.agents = [];
  });

  it('reuses a local Agent without showing install confirmation', async () => {
    mocks.previewFromRegistry.mockResolvedValue({
      agentId: 'grok-build',
      outcome: 'reuseLocal',
      command: '/opt/grok',
      args: ['agent', 'stdio'],
      kind: 'binary',
      source: 'local',
      approvalToken: 'token-local',
    } satisfies RegistryAddPreview);
    mocks.addFromRegistry.mockResolvedValue(undefined);

    const { AcpAgentSettings } = await import('../AcpAgentSettings');
    render(<AcpAgentSettings />);
    fireEvent.click(screen.getAllByText('settings.acpAgents.addFromRegistry')[0]);
    fireEvent.click(screen.getAllByText('settings.acpAgents.add')[0]);

    await waitFor(() => {
      expect(mocks.addFromRegistry).toHaveBeenCalledWith('grok-build', {
        allowInstaller: false,
        approvalToken: 'token-local',
      });
    });
    expect(mocks.modalConfirm).not.toHaveBeenCalled();
  });

  it('does not add when install confirmation is cancelled', async () => {
    mocks.previewFromRegistry.mockResolvedValue({
      agentId: 'grok-build',
      outcome: 'installRequired',
      command: 'npx',
      args: ['-y', '@xai-official/grok@1.0.0'],
      kind: 'npx',
      source: 'npx',
      approvalToken: 'token-install',
    } satisfies RegistryAddPreview);
    mocks.modalConfirm.mockImplementation(({ onCancel }: { onCancel: () => void }) => {
      onCancel();
    });

    const { AcpAgentSettings } = await import('../AcpAgentSettings');
    render(<AcpAgentSettings />);
    fireEvent.click(screen.getAllByText('settings.acpAgents.addFromRegistry')[0]);
    fireEvent.click(screen.getAllByText('settings.acpAgents.add')[0]);

    await waitFor(() => {
      expect(mocks.modalConfirm).toHaveBeenCalled();
    });
    expect(mocks.addFromRegistry).not.toHaveBeenCalled();
  });

  it('adds once with approval after install confirmation', async () => {
    mocks.previewFromRegistry.mockResolvedValue({
      agentId: 'grok-build',
      outcome: 'installRequired',
      command: 'npx',
      args: ['-y', '@xai-official/grok@1.0.0', 'agent', 'stdio'],
      kind: 'npx',
      source: 'npx',
      approvalToken: 'token-install',
    } satisfies RegistryAddPreview);
    mocks.modalConfirm.mockImplementation(({ onOk }: { onOk: () => void }) => {
      onOk();
    });
    mocks.addFromRegistry.mockResolvedValue(undefined);

    const { AcpAgentSettings } = await import('../AcpAgentSettings');
    render(<AcpAgentSettings />);
    fireEvent.click(screen.getAllByText('settings.acpAgents.addFromRegistry')[0]);
    fireEvent.click(screen.getAllByText('settings.acpAgents.add')[0]);

    await waitFor(() => {
      expect(mocks.addFromRegistry).toHaveBeenCalledWith('grok-build', {
        allowInstaller: true,
        approvalToken: 'token-install',
      });
    });
    expect(mocks.addFromRegistry).toHaveBeenCalledTimes(1);
  });

  it('disables add for an already configured id', async () => {
    config.agents = [{
      id: 'grok-build',
      name: 'Grok Build',
      enabled: true,
      source: 'registry',
      command: '/opt/grok',
      args: ['agent', 'stdio'],
      sort: 0,
    }];

    const { AcpAgentSettings } = await import('../AcpAgentSettings');
    render(<AcpAgentSettings />);
    fireEvent.click(screen.getAllByText('settings.acpAgents.addFromRegistry')[0]);
    const grokAdd = screen.getAllByText('settings.acpAgents.added')[0].closest('button');
    expect(grokAdd).toBeDisabled();
    expect(mocks.addFromRegistry).not.toHaveBeenCalled();
    expect(mocks.previewFromRegistry).not.toHaveBeenCalled();
  });

  it('labels Registry versions as catalog versions', async () => {
    const { AcpAgentSettings } = await import('../AcpAgentSettings');
    render(<AcpAgentSettings />);
    fireEvent.click(screen.getAllByText('settings.acpAgents.addFromRegistry')[0]);
    expect(screen.getByText(/目录版本 1\.0\.0/)).toBeInTheDocument();
  });
});
