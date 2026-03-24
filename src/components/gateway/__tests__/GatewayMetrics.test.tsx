import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GatewayMetrics } from '../GatewayMetrics';

const fetchUsageByDay = vi.fn();
const fetchUsageByProvider = vi.fn();
const fetchUsageByKey = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/gatewayStore', () => ({
  useGatewayStore: () => ({
    usageByDay: [
      {
        date: '2025-03-24',
        request_count: 3,
        token_count: 3500,
        request_tokens: 1200,
        response_tokens: 2300,
      },
    ],
    usageByProvider: [
      {
        provider_id: 'provider-1',
        provider_name: 'DeepSeek',
        request_count: 3,
        token_count: 3500,
        request_tokens: 1200,
        response_tokens: 2300,
      },
    ],
    usageByKey: [
      {
        key_id: 'key-1',
        key_name: 'Gateway Key',
        request_count: 3,
        token_count: 3500,
        request_tokens: 1200,
        response_tokens: 2300,
      },
    ],
    fetchUsageByDay,
    fetchUsageByProvider,
    fetchUsageByKey,
  }),
}));

describe('GatewayMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders split request and response token columns for aggregate tables', () => {
    render(<GatewayMetrics />);

    expect(screen.getAllByText('gateway.logRequestTokens').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gateway.logResponseTokens').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gateway.totalTokens').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1.2k').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2.3k').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3.5k').length).toBeGreaterThan(0);
  });
});
