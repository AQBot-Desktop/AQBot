import { App } from 'antd';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayTemplates } from '../GatewayTemplates';

const fetchStatus = vi.fn();
const fetchCliToolStatuses = vi.fn();
const fetchKeys = vi.fn();
const connectCliTool = vi.fn();
const disconnectCliTool = vi.fn();

let storeState: Record<string, unknown>;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@lobehub/icons', () => {
  const avatar = {
    Avatar: ({ size }: { size: number }) => <span data-size={size}>avatar</span>,
  };

  return {
    ClaudeCode: avatar,
    Codex: avatar,
    OpenCode: avatar,
    Gemini: avatar,
    Cursor: avatar,
  };
});

vi.mock('@/stores/gatewayStore', () => ({
  useGatewayStore: () => storeState,
}));

function buildStoreState(overrides: Record<string, unknown> = {}) {
  return {
    status: {
      is_running: true,
      listen_address: '127.0.0.1',
      port: 8000,
      ssl_enabled: true,
      started_at: null,
      https_port: 8443,
      force_ssl: false,
    },
    cliTools: [
      {
        id: 'claude_code',
        name: 'Claude Code',
        status: 'not_connected',
        configPath: '/configs/claude.json',
        hasBackup: false,
        connectedProtocol: null,
      },
      {
        id: 'codex',
        name: 'Codex',
        status: 'connected',
        configPath: '/configs/codex.json',
        hasBackup: true,
        connectedProtocol: 'http',
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        status: 'connected',
        configPath: '/configs/opencode.json',
        hasBackup: true,
        connectedProtocol: 'https',
      },
      {
        id: 'gemini',
        name: 'Gemini CLI',
        status: 'not_installed',
        configPath: null,
        hasBackup: false,
        connectedProtocol: null,
      },
    ],
    cliToolsLoading: false,
    keys: [
      {
        id: 'key-1',
        name: 'Primary Gateway Key',
        key_hash: 'hash',
        key_prefix: 'aqb_123',
        enabled: true,
        created_at: 1,
        last_used_at: null,
        has_encrypted_key: true,
      },
    ],
    fetchStatus,
    fetchCliToolStatuses,
    fetchKeys,
    connectCliTool,
    disconnectCliTool,
    ...overrides,
  };
}

function renderWithApp() {
  return render(
    <App>
      <GatewayTemplates />
    </App>,
  );
}

async function selectProtocol(protocolLabel: string) {
  const protocolSelect = screen.getByTestId('gateway-protocol-select');
  fireEvent.mouseDown(within(protocolSelect).getByRole('combobox'));
  await userEvent.click(await screen.findByText(protocolLabel));
}

function getToolCard(name: string) {
  const heading = screen.getByRole('heading', { name, level: 5 });
  const card = heading.closest('.ant-card');
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

describe('GatewayTemplates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectCliTool.mockResolvedValue(undefined);
    disconnectCliTool.mockResolvedValue(undefined);
    storeState = buildStoreState();

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

  it('fetches fresh status, lets users switch protocols, and passes the selected protocol to quick connect', async () => {
    renderWithApp();

    await waitFor(() => {
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(fetchCliToolStatuses).toHaveBeenCalledTimes(1);
      expect(fetchKeys).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('gateway.cliConnectedHttp')).toBeInTheDocument();
    expect(screen.getByText('gateway.cliConnectedHttps')).toBeInTheDocument();
    expect(screen.getByText('gateway.cliNotConnected')).toBeInTheDocument();
    expect(screen.getAllByText('gateway.cliNotInstalled').length).toBeGreaterThan(0);

    await selectProtocol('gateway.cliProtocolHttps');

    const codexCard = getToolCard('Codex');
    expect(within(codexCard).getByRole('button', { name: 'gateway.cliSwitchProtocolReconnect' })).toBeInTheDocument();

    const openCodeCard = getToolCard('OpenCode');
    expect(within(openCodeCard).getByRole('button', { name: 'gateway.cliDisconnect' })).toBeInTheDocument();

    const claudeCard = getToolCard('Claude Code');
    const quickConnectButton = within(claudeCard).getByRole('button', { name: 'gateway.quickConnect' });
    await waitFor(() => expect(quickConnectButton).toBeEnabled());
    await userEvent.click(quickConnectButton);

    await waitFor(() => {
      expect(connectCliTool).toHaveBeenCalledWith('claude_code', 'key-1', 'https');
    });
  });

  it('auto-selects the only available http protocol and disables switching when https is unavailable', async () => {
    storeState = buildStoreState({
      status: {
        is_running: true,
        listen_address: '127.0.0.1',
        port: 8000,
        ssl_enabled: false,
        started_at: null,
        https_port: null,
        force_ssl: false,
      },
      cliTools: [
        {
          id: 'claude_code',
          name: 'Claude Code',
          status: 'not_connected',
          configPath: '/configs/claude.json',
          hasBackup: false,
          connectedProtocol: null,
        },
      ],
    });

    renderWithApp();

    const protocolSelect = await screen.findByTestId('gateway-protocol-select');
    expect(protocolSelect).toHaveClass('ant-select-disabled');
    expect(within(protocolSelect).getByText('gateway.cliProtocolHttp')).toBeInTheDocument();

    const claudeCard = getToolCard('Claude Code');
    const quickConnectButton = within(claudeCard).getByRole('button', { name: 'gateway.quickConnect' });
    await waitFor(() => expect(quickConnectButton).toBeEnabled());
    await userEvent.click(quickConnectButton);

    await waitFor(() => {
      expect(connectCliTool).toHaveBeenCalledWith('claude_code', 'key-1', 'http');
    });
  });

  it('treats force ssl as https-only and offers reconnect when a tool is connected over http', async () => {
    storeState = buildStoreState({
      status: {
        is_running: true,
        listen_address: '127.0.0.1',
        port: 8000,
        ssl_enabled: true,
        started_at: null,
        https_port: 8443,
        force_ssl: true,
      },
    });

    renderWithApp();

    const protocolSelect = await screen.findByTestId('gateway-protocol-select');
    expect(protocolSelect).toHaveClass('ant-select-disabled');
    expect(within(protocolSelect).getByText('gateway.cliProtocolHttps')).toBeInTheDocument();

    const codexCard = getToolCard('Codex');
    expect(within(codexCard).getByText('gateway.cliConnectedHttp')).toBeInTheDocument();
    const reconnectButton = within(codexCard).getByRole('button', { name: 'gateway.cliSwitchProtocolReconnect' });
    await waitFor(() => expect(reconnectButton).toBeEnabled());
    await userEvent.click(reconnectButton);

    await waitFor(() => {
      expect(connectCliTool).toHaveBeenCalledWith('codex', 'key-1', 'https');
    });
  });

  it('treats connected tools without a reported protocol as not connected in the UI', async () => {
    storeState = buildStoreState({
      cliTools: [
        {
          id: 'codex',
          name: 'Codex',
          status: 'connected',
          configPath: '/configs/codex.json',
          hasBackup: true,
          connectedProtocol: null,
        },
      ],
    });

    renderWithApp();

    const codexCard = getToolCard('Codex');
    expect(within(codexCard).getByText('gateway.cliNotConnected')).toBeInTheDocument();
    expect(within(codexCard).queryByText('gateway.cliConnected')).not.toBeInTheDocument();
    expect(within(codexCard).getByRole('button', { name: 'gateway.quickConnect' })).toBeInTheDocument();
    expect(within(codexCard).queryByRole('button', { name: 'gateway.cliDisconnect' })).not.toBeInTheDocument();
  });

  it('shows a warning and disables quick connect actions while the gateway is stopped', async () => {
    storeState = buildStoreState({
      status: {
        is_running: false,
        listen_address: '127.0.0.1',
        port: 8000,
        ssl_enabled: true,
        started_at: null,
        https_port: 8443,
        force_ssl: false,
      },
    });

    renderWithApp();

    expect(screen.getByText('gateway.cliStartGatewayFirst')).toBeInTheDocument();

    const claudeCard = getToolCard('Claude Code');
    await waitFor(() => {
      expect(within(claudeCard).getByRole('button', { name: 'gateway.quickConnect' })).toBeDisabled();
    });

    await selectProtocol('gateway.cliProtocolHttps');

    const codexCard = getToolCard('Codex');
    await waitFor(() => {
      expect(within(codexCard).getByRole('button', { name: 'gateway.cliSwitchProtocolReconnect' })).toBeDisabled();
    });

    const protocolSelect = screen.getByTestId('gateway-protocol-select');
    expect(protocolSelect).not.toHaveClass('ant-select-disabled');
    expect(screen.getByText('Primary Gateway Key (aqb_123)')).toBeInTheDocument();
  });
});
