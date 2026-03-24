import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GatewayDiagnostics } from '../GatewayDiagnostics';

const fetchRequestLogs = vi.fn();
const clearRequestLogs = vi.fn();
let requestLogs = [
  {
    id: 'log-1',
    keyId: 'key-1',
    keyName: 'Gateway Key',
    method: 'POST',
    path: '/v1/chat/completions',
    model: 'deepseek-chat',
    providerId: 'provider-1',
    statusCode: 502,
    durationMs: 234,
    requestTokens: 1200,
    responseTokens: 2300,
    errorMessage: 'Upstream timeout waiting for provider response.',
    createdAt: 1_700_000_000,
  },
];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/gatewayStore', () => ({
  useGatewayStore: () => ({
    requestLogs,
    requestLogsLoading: false,
    fetchRequestLogs,
    clearRequestLogs,
  }),
}));

describe('GatewayDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestLogs = [
      {
        id: 'log-1',
        keyId: 'key-1',
        keyName: 'Gateway Key',
        method: 'POST',
        path: '/v1/chat/completions',
        model: 'deepseek-chat',
        providerId: 'provider-1',
        statusCode: 502,
        durationMs: 234,
        requestTokens: 1200,
        responseTokens: 2300,
        errorMessage: 'Upstream timeout waiting for provider response.',
        createdAt: 1_700_000_000,
      },
    ];
  });

  it('only refreshes logs on mount and manual click, without background auto refresh', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const user = userEvent.setup();

    render(<GatewayDiagnostics />);

    expect(fetchRequestLogs).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'common.refresh' }));
    expect(fetchRequestLogs).toHaveBeenCalledTimes(2);
    setIntervalSpy.mockRestore();
  });

  it('shows error previews on one line and opens a modal with the full error text', async () => {
    const user = userEvent.setup();

    render(<GatewayDiagnostics />);

    expect(screen.getAllByText('gateway.logRequestTokens').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gateway.logResponseTokens').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gateway.totalTokens').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1.2k').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2.3k').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3.5k').length).toBeGreaterThan(0);

    const errorText = screen.getByText('Upstream timeout waiting for provider response.');
    expect(errorText.closest('button')).not.toBeNull();
    expect(errorText).toHaveStyle({
      color: '#ff4d4f',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
    });

    await user.click(errorText);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByText('Upstream timeout waiting for provider response.').length).toBeGreaterThan(0);
  });
});
