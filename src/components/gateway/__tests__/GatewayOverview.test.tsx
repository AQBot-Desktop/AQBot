import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { message } from 'antd';
import { GatewayOverview } from '../GatewayOverview';

let status = {
  is_running: false,
  listen_address: '127.0.0.1',
  port: 8000,
  ssl_enabled: true,
  started_at: null,
  https_port: 8443,
  force_ssl: false,
};
const startGateway = vi.fn();
const stopGateway = vi.fn();
const fetchStatus = vi.fn();
const fetchMetrics = vi.fn();
const fetchRequestLogs = vi.fn();
const listRequestLogs = vi.fn();
let metrics: Record<string, unknown> | null = null;
let requestLogs: Array<Record<string, unknown>> = [];
let recentLogsResponse: Array<Record<string, unknown>> = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/gatewayStore', () => ({
  useGatewayStore: () => ({
    status,
    metrics,
    requestLogs,
    requestLogsLoading: false,
    startGateway,
    stopGateway,
    fetchStatus,
    fetchMetrics,
    fetchRequestLogs,
    listRequestLogs,
  }),
}));

describe('GatewayOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status = {
      is_running: false,
      listen_address: '127.0.0.1',
      port: 8000,
      ssl_enabled: true,
      started_at: null,
      https_port: 8443,
      force_ssl: false,
    };
    metrics = null;
    requestLogs = [];
    recentLogsResponse = [];
    listRequestLogs.mockImplementation(() => Promise.resolve(recentLogsResponse));
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('shows an error message when starting the gateway fails', async () => {
    startGateway.mockRejectedValueOnce(new Error('TLS cert missing'));
    const errorSpy = vi.spyOn(message, 'error').mockImplementation(() => {
      const noop = () => {};
      return {
        then: undefined as never,
        promise: Promise.resolve(),
        close: noop,
      } as never;
    });

    render(<GatewayOverview />);

    await userEvent.click(screen.getByRole('button', { name: 'gateway.start' }));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  it('shows split request and response tokens in overview cards and recent logs', async () => {
    metrics = {
      total_requests: 12,
      total_tokens: 3500,
      total_request_tokens: 1200,
      total_response_tokens: 2300,
      active_connections: 0,
      today_requests: 2,
      today_tokens: 1500,
      today_request_tokens: 900,
      today_response_tokens: 600,
    };
    requestLogs = [
      {
        id: 'log-1',
        keyId: 'key-1',
        keyName: 'Gateway Key',
        method: 'POST',
        path: '/v1/chat/completions',
        model: 'deepseek-chat',
        providerId: 'provider-1',
        statusCode: 200,
        durationMs: 123,
        requestTokens: 900,
        responseTokens: 600,
        errorMessage: null,
        createdAt: 1_700_000_000,
      },
    ];
    recentLogsResponse = [...requestLogs];

    render(<GatewayOverview />);

    await screen.findByText('/v1/chat/completions');

    expect(screen.getAllByText('1.5k').length).toBeGreaterThan(0);
    expect(screen.getAllByText('900').length).toBeGreaterThan(0);
    expect(screen.getAllByText('600').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3.5k').length).toBeGreaterThan(0);
  });

  it('shows only the latest 10 overview logs and exposes a view more action', async () => {
    const onViewMoreLogs = vi.fn();
    recentLogsResponse = Array.from({ length: 12 }, (_, index) => ({
      id: `log-${index + 1}`,
      keyId: `key-${index + 1}`,
      keyName: `Gateway Key ${index + 1}`,
      method: 'POST',
      path: `/v1/test/${index + 1}`,
      model: 'deepseek-chat',
      providerId: 'provider-1',
      statusCode: 200,
      durationMs: 100 + index,
      requestTokens: 10 + index,
      responseTokens: 20 + index,
      errorMessage: null,
      createdAt: 1_700_000_000 + index,
    }));

    render(<GatewayOverview onViewMoreLogs={onViewMoreLogs} />);

    expect(await screen.findByText('/v1/test/1')).toBeInTheDocument();
    expect(screen.getByText('/v1/test/10')).toBeInTheDocument();
    expect(screen.queryByText('/v1/test/11')).not.toBeInTheDocument();
    expect(screen.queryByText('/v1/test/12')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'gateway.viewMoreLogs' }));

    expect(onViewMoreLogs).toHaveBeenCalledTimes(1);
  });

  it('does not auto-refresh recent logs while the gateway is stopped but still allows manual refresh', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    recentLogsResponse = [
      {
        id: 'log-1',
        keyId: 'key-1',
        keyName: 'Gateway Key',
        method: 'POST',
        path: '/v1/chat/completions',
        model: 'deepseek-chat',
        providerId: 'provider-1',
        statusCode: 200,
        durationMs: 123,
        requestTokens: 900,
        responseTokens: 600,
        errorMessage: null,
        createdAt: 1_700_000_000,
      },
    ];

    render(<GatewayOverview />);

    await waitFor(() => {
      expect(listRequestLogs).toHaveBeenCalledTimes(1);
    });
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
    expect(listRequestLogs).toHaveBeenCalledTimes(2);
    setIntervalSpy.mockRestore();
  });
});
