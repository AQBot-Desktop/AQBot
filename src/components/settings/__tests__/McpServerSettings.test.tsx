import { App } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import McpServerSettings from '../McpServerSettings';

const loadServers = vi.fn();
const createServer = vi.fn();
const updateServer = vi.fn();
const deleteServer = vi.fn();
const loadToolDescriptors = vi.fn();
const discoverTools = vi.fn();

let mcpState = {
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
  loadServers,
  createServer,
  updateServer,
  deleteServer,
  loadToolDescriptors,
  discoverTools,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
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
      loadServers,
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

  it('persists environment variables as env object on blur', async () => {
    render(
      <App>
        <McpServerSettings />
      </App>,
    );

    const textarea = await screen.findByPlaceholderText('settings.mcpServers.envVarsPlaceholder');
    await userEvent.type(textarea, 'TAVILY_API_KEY=secret');
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
