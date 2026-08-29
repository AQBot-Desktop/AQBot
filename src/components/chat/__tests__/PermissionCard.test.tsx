import { App } from 'antd';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import PermissionCard from '../PermissionCard';

const approveToolUse = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores', () => ({
  useAgentStore: (selector: (state: { approveToolUse: typeof approveToolUse }) => unknown) =>
    selector({ approveToolUse }),
}));

function renderCard(props: Partial<ComponentProps<typeof PermissionCard>> = {}) {
  return render(
    <App>
      <PermissionCard
        conversationId="conv-1"
        toolUseId="tool-1"
        toolName="Bash"
        input={{ command: 'curl -X POST https://example.test', timeout: 30 }}
        status="pending"
        workingDirectory="/tmp/workspace-conv-1"
        riskLevel="execute"
        {...props}
      />
    </App>,
  );
}

describe('PermissionCard', () => {
  beforeEach(() => {
    approveToolUse.mockReset();
    approveToolUse.mockResolvedValue(undefined);
  });

  it('shows bash command, starting cwd, risk, and timeout without expanding JSON', () => {
    renderCard();

    expect(screen.getByText('curl -X POST https://example.test')).toBeInTheDocument();
    expect(screen.getByText('/tmp/workspace-conv-1')).toBeInTheDocument();
    expect(screen.getByText('common.riskExecute')).toBeInTheDocument();
    expect(screen.getByText('common.timeout')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.queryByText(/example.test/)).toBeInTheDocument();
    expect(screen.queryByText(/"command"/)).not.toBeInTheDocument();
  });

  it('only offers allow once and deny for execute risk', () => {
    renderCard();

    expect(screen.getByRole('button', { name: 'common.allowOnce' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.deny' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.allowAlways' })).not.toBeInTheDocument();
  });

  it('passes conversationId, toolUseId, and allow_once to the store', async () => {
    renderCard();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'common.allowOnce' }));
    });

    expect(approveToolUse).toHaveBeenCalledWith('conv-1', 'tool-1', 'allow_once');
  });

  it('keeps custom options unchanged even for execute risk', () => {
    renderCard({
      options: [
        { id: 'allow_always', label: 'Custom always', variant: 'default' },
        { id: 'deny', label: 'Custom deny', variant: 'danger' },
      ],
    });

    expect(screen.getByRole('button', { name: 'Custom always' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom deny' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.allowOnce' })).not.toBeInTheDocument();
  });

  it('still offers always allow for write risk', () => {
    renderCard({
      toolName: 'write_file',
      riskLevel: 'write',
      input: { path: '/tmp/a.txt' },
    });

    expect(screen.getByRole('button', { name: 'common.allowAlways' })).toBeInTheDocument();
  });
});
