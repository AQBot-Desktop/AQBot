import { App } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import McpServerSettings from '../McpServerSettings';
import type { McpServer } from '@/types';

const loadServers = vi.fn();
const createServer = vi.fn();
const updateServer = vi.fn();
const deleteServer = vi.fn();
const loadToolDescriptors = vi.fn();
const discoverTools = vi.fn();

type McpStoreMockState = {
  servers: McpServer[];
  toolDescriptors: Record<string, unknown[]>;
  ensureServersLoaded: typeof loadServers;
  createServer: typeof createServer;
  updateServer: typeof updateServer;
  deleteServer: typeof deleteServer;
  loadToolDescriptors: typeof loadToolDescriptors;
  discoverTools: typeof discoverTools;
};

let mcpState: McpStoreMockState = {
  servers: [
    {
      id: 'mcp-1',
      name: 'Custom MCP',
      transport: 'stdio',
      command: 'npx',
      argsJson: '["-y","mcp-server"]',
      endpoint: undefined,
      envJson: null,
      enabled: false,
      permissionPolicy: 'ask',
      source: 'custom',
      discoverTimeoutSecs: 30,
      executeTimeoutSecs: 30,
      headersJson: null,
      iconType: null,
      iconValue: null,
    },
  ],
  toolDescriptors: {} as Record<string, unknown[]>,
  ensureServersLoaded: loadServers,
  createServer,
  updateServer,
  deleteServer,
  loadToolDescriptors,
  discoverTools,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('@/stores', () => ({
  useMcpStore: (selector?: (state: typeof mcpState) => unknown) =>
    selector ? selector(mcpState) : mcpState,
}));

vi.mock('@/components/shared/McpServerIcon', () => ({
  McpServerIcon: () => <div>mcp-icon</div>,
}));

vi.mock('@/components/shared/IconEditor', () => ({
  IconEditor: () => <div>icon-editor</div>,
}));

describe('McpServerSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpState = {
      ...mcpState,
      servers: [
        {
          id: 'mcp-1',
          name: 'Custom MCP',
          transport: 'stdio',
          command: 'npx',
          argsJson: '["-y","mcp-server"]',
          endpoint: undefined,
          envJson: null,
          enabled: false,
          permissionPolicy: 'ask',
          source: 'custom',
          discoverTimeoutSecs: 30,
          executeTimeoutSecs: 30,
          headersJson: null,
          iconType: null,
          iconValue: null,
        },
      ],
      toolDescriptors: {},
      ensureServersLoaded: loadServers,
      createServer,
      updateServer,
      deleteServer,
      loadToolDescriptors,
      discoverTools,
    };
    updateServer.mockResolvedValue(undefined);
    loadServers.mockResolvedValue(undefined);
    loadToolDescriptors.mockResolvedValue(undefined);
    discoverTools.mockResolvedValue([]);

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

  it('persists custom headers JSON for HTTP servers on blur', async () => {
    mcpState = {
      ...mcpState,
      servers: [
        {
          ...mcpState.servers[0],
          transport: 'http',
          endpoint: 'https://example.com/mcp',
          headersJson: null,
        },
      ],
    };

    render(
      <App>
        <McpServerSettings />
      </App>,
    );

    const textarea = await screen.findByPlaceholderText(/Authorization=Bearer/);
    fireEvent.change(textarea, { target: { value: 'Authorization=Bearer token' } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(updateServer).toHaveBeenCalledWith('mcp-1', {
        headersJson: JSON.stringify({ Authorization: 'Bearer token' }),
      });
    });
  });

  it('clears custom headers with null when the HTTP header field is emptied', async () => {
    mcpState = {
      ...mcpState,
      servers: [
        {
          ...mcpState.servers[0],
          transport: 'http',
          endpoint: 'https://example.com/mcp',
          headersJson: JSON.stringify({ Authorization: 'Bearer old' }),
        },
      ],
    };

    render(
      <App>
        <McpServerSettings />
      </App>,
    );

    const textarea = await screen.findByDisplayValue('Authorization=Bearer old');
    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(updateServer).toHaveBeenCalledWith('mcp-1', {
        headersJson: null,
      });
    });
  });

  it('replaces old custom headers with the latest edited value', async () => {
    mcpState = {
      ...mcpState,
      servers: [
        {
          ...mcpState.servers[0],
          transport: 'http',
          endpoint: 'https://example.com/mcp',
          headersJson: JSON.stringify({ Authorization: 'Bearer old' }),
        },
      ],
    };

    render(
      <App>
        <McpServerSettings />
      </App>,
    );

    const textarea = await screen.findByDisplayValue('Authorization=Bearer old');
    fireEvent.change(textarea, { target: { value: 'Authorization=Bearer new' } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(updateServer).toHaveBeenCalledWith('mcp-1', {
        headersJson: JSON.stringify({ Authorization: 'Bearer new' }),
      });
    });
  });

  it('imports streamablehttp server config with headers', async () => {
    createServer.mockResolvedValue(undefined);

    render(
      <App>
        <McpServerSettings />
      </App>,
    );

    fireEvent.click(screen.getByText('settings.mcpServers.add'));
    fireEvent.click(await screen.findByText('settings.mcpServers.tabImport'));

    const textarea = screen.getByPlaceholderText('settings.mcpServers.importPlaceholder');
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          mcpServers: {
            'my-coffee': {
              type: 'streamablehttp',
              url: 'https://gwmcp.lkcoffee.com/order/user/mcp',
              headers: {
                Authorization: 'Bearer xxxx',
              },
            },
          },
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => {
      expect(createServer).toHaveBeenCalledWith({
        name: 'my-coffee',
        transport: 'http',
        command: undefined,
        args: undefined,
        endpoint: 'https://gwmcp.lkcoffee.com/order/user/mcp',
        enabled: false,
        headersJson: JSON.stringify({ Authorization: 'Bearer xxxx' }),
      });
    });
  });

  it('persists environment variables as env object on blur', async () => {
    render(
      <App>
        <McpServerSettings />
      </App>,
    );

    const textarea = await screen.findByPlaceholderText('settings.mcpServers.envVarsPlaceholder');
    fireEvent.change(textarea, { target: { value: 'TAVILY_API_KEY=secret' } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(updateServer).toHaveBeenCalledWith('mcp-1', {
        env: {
          TAVILY_API_KEY: 'secret',
        },
      });
    });
  });
});
