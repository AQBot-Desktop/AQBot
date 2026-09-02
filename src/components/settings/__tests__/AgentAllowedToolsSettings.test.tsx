import type React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@/types';
import { defaultAgentAllowedTools } from '@/lib/agentAllowedTools';
import { AgentAllowedToolsSettings } from '../AgentAllowedToolsSettings';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
}));

let settings: Partial<AppSettings> = {};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string; count?: number; total?: number }) => {
      const labels: Record<string, string> = {
        'settings.agentAllowedToolsDesc': '限制对话 Agent 可使用的内置工具与 Skill。',
        'settings.agentAllowedToolsEnable': '启用工具白名单',
        'settings.agentAllowedToolsEnableDesc': '开启后仅勾选工具对模型可见，不会绕过权限审批。',
        'settings.agentAllowedToolsConfigure': '详细设定',
        'settings.agentAllowedToolsModalTitle': '内置工具',
        'settings.agentAllowedToolsSelectAll': '全选',
        'settings.agentAllowedToolsClear': '清空',
        'settings.agentAllowedToolsMcpNote': '会话 MCP 仍由对话中的 MCP 选择器管理。',
        'settings.agentAllowedToolsPermissionNote': '完全访问不能恢复未勾选的工具。',
        'settings.agentAllowedToolsEmptyHint': '未勾选任何内置工具时，Agent 在无 MCP 的会话中变为纯对话。',
        'settings.agentAllowedToolsGroupFile': '文件',
        'settings.agentAllowedToolsGroupExec': '执行与开发',
        'settings.agentAllowedToolsGroupWeb': '网络',
        'settings.agentAllowedToolsGroupInteractive': '交互与技能',
        'settings.agentAllowedToolsGroupTask': '任务',
        'settings.agentAllowedToolsGroupCollab': '协作与计划',
        'settings.agentAllowedToolsGroupAutomation': '自动化与配置',
        'common.close': '关闭',
      };
      if (key === 'settings.agentAllowedToolToggle') {
        return `允许 ${options?.name ?? ''}`;
      }
      if (key === 'settings.agentAllowedToolsSelectedCount') {
        return `已选 ${options?.count ?? 0}/${options?.total ?? 0}`;
      }
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('antd', () => ({
  Divider: () => <hr />,
  Switch: ({
    checked,
    disabled,
    onChange,
    'aria-label': ariaLabel,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (checked: boolean) => void;
    'aria-label'?: string;
  }) => (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => {
        if (!disabled) onChange?.(!checked);
      }}
    />
  ),
  Button: ({
    children,
    disabled,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button aria-label={ariaLabel} disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Modal: ({
    open,
    title,
    children,
    footer,
    onCancel,
  }: {
    open?: boolean;
    title?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    onCancel?: () => void;
  }) => (
    open ? (
      <div aria-label={typeof title === 'string' ? title : undefined} role="dialog">
        {title ? <div>{title}</div> : null}
        {children}
        {footer}
        <button type="button" onClick={onCancel}>
          关闭弹层
        </button>
      </div>
    ) : null
  ),
  theme: {
    useToken: () => ({
      token: {
        colorTextDescription: '#666666',
      },
    }),
  },
}));

vi.mock('@/stores', () => ({
  useSettingsStore: (selector: (state: {
    settings: Partial<AppSettings>;
    saveSettings: typeof mocks.saveSettings;
  }) => unknown) => selector({
    settings,
    saveSettings: mocks.saveSettings,
  }),
}));

const rowStyle = { padding: '8px 0' };

function openDetails() {
  fireEvent.click(screen.getByLabelText('详细设定'));
}

describe('AgentAllowedToolsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {
      agent_allowed_tools_enabled: false,
      agent_allowed_tools: defaultAgentAllowedTools(),
    };
  });

  it('keeps the tool list in a modal instead of the settings page', () => {
    render(<AgentAllowedToolsSettings rowStyle={rowStyle} />);

    expect(screen.getByLabelText('启用工具白名单')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('已选 31/31')).toBeInTheDocument();
    expect(screen.queryByLabelText('允许 Bash')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '内置工具' })).not.toBeInTheDocument();

    openDetails();

    expect(screen.getByRole('dialog', { name: '内置工具' })).toBeInTheDocument();
    expect(screen.getByLabelText('允许 Bash')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('允许 Read')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('允许 Skill')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('会话 MCP 仍由对话中的 MCP 选择器管理。')).toBeInTheDocument();
    expect(screen.getByText('完全访问不能恢复未勾选的工具。')).toBeInTheDocument();
  });

  it('shows the saved selection after opening the modal while the whitelist is off', () => {
    settings = {
      agent_allowed_tools_enabled: false,
      agent_allowed_tools: ['Read', 'Glob', 'Grep'],
    };
    render(<AgentAllowedToolsSettings rowStyle={rowStyle} />);

    expect(screen.getByText('已选 3/31')).toBeInTheDocument();
    openDetails();
    expect(screen.getByLabelText('允许 Read')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('允许 Bash')).toHaveAttribute('aria-checked', 'false');
  });

  it('disables Bash in the modal without rewriting the rest of the saved list', () => {
    settings = {
      agent_allowed_tools_enabled: true,
      agent_allowed_tools: defaultAgentAllowedTools(),
    };
    render(<AgentAllowedToolsSettings rowStyle={rowStyle} />);
    openDetails();
    fireEvent.click(screen.getByLabelText('允许 Bash'));

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      agent_allowed_tools: defaultAgentAllowedTools().filter((name) => name !== 'Bash'),
    });
  });

  it('selects every configurable tool and clears to an empty list in the modal', () => {
    settings = {
      agent_allowed_tools_enabled: true,
      agent_allowed_tools: ['Read'],
    };
    render(<AgentAllowedToolsSettings rowStyle={rowStyle} />);
    openDetails();

    fireEvent.click(screen.getByLabelText('全选'));
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      agent_allowed_tools: defaultAgentAllowedTools(),
    });

    fireEvent.click(screen.getByLabelText('清空'));
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      agent_allowed_tools: [],
    });
  });

  it('does not fill an empty saved list with the default catalog', () => {
    settings = {
      agent_allowed_tools_enabled: true,
      agent_allowed_tools: [],
    };
    render(<AgentAllowedToolsSettings rowStyle={rowStyle} />);

    expect(screen.getByText('已选 0/31')).toBeInTheDocument();
    openDetails();
    expect(screen.getByLabelText('允许 Bash')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('允许 Read')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('允许 Skill')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('未勾选任何内置工具时，Agent 在无 MCP 的会话中变为纯对话。')).toBeInTheDocument();
  });

  it('enables the whitelist without changing the stored tool list', () => {
    render(<AgentAllowedToolsSettings rowStyle={rowStyle} />);

    fireEvent.click(screen.getByLabelText('启用工具白名单'));
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      agent_allowed_tools_enabled: true,
    });
    expect(screen.queryByLabelText('允许 Bash')).not.toBeInTheDocument();
  });
});
