import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayPage } from '../GatewayPage';

const fetchRequestLogs = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/gatewayStore', () => ({
  useGatewayStore: () => ({
    fetchRequestLogs,
  }),
}));

vi.mock('@/components/gateway', () => ({
  GatewayOverview: ({ onViewMoreLogs }: { onViewMoreLogs?: () => void }) => (
    <button type="button" onClick={onViewMoreLogs}>
      gateway.viewMoreLogs
    </button>
  ),
  GatewayKeys: () => <div>gateway-keys-content</div>,
  GatewayMetrics: () => <div>gateway-metrics-content</div>,
  GatewaySettings: () => <div>gateway-settings-content</div>,
  GatewayDiagnostics: () => <div>gateway-diagnostics-content</div>,
  GatewayTemplates: () => <div>gateway-templates-content</div>,
  QuickConnectCycleIcon: () => null,
}));

describe('GatewayPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('switches to the logs tab and refreshes logs when overview view more is clicked', async () => {
    render(<GatewayPage />);

    await userEvent.click(screen.getByRole('button', { name: 'gateway.viewMoreLogs' }));

    await waitFor(() => {
      expect(fetchRequestLogs).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('gateway-diagnostics-content')).toBeInTheDocument();
  });
});
