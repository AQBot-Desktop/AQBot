import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from 'antd';
import { useSettingsStore } from '@/stores/settingsStore';
import { GatewaySettings } from '../GatewaySettings';

const { invoke, startGateway, stopGateway } = vi.hoisted(() => ({
  invoke: vi.fn(),
  startGateway: vi.fn(),
  stopGateway: vi.fn(),
}));

vi.mock('@/lib/invoke', () => ({ invoke }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../GatewayProviderPrefixes', () => ({ GatewayProviderPrefixes: () => null }));
vi.mock('@/stores/gatewayStore', () => ({
  useGatewayStore: () => ({
    status: { is_running: false },
    ensureStatusLoaded: vi.fn(),
    fetchStatus: vi.fn(),
    startGateway,
    stopGateway,
  }),
}));

const initialSettings = useSettingsStore.getState().settings;

function autoStartSwitch() {
  const row = screen.getByText('gateway.autoStart').parentElement!;
  return within(row).getByRole('switch');
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue({ saved: true });
  useSettingsStore.setState({
    settings: { ...initialSettings, gateway_auto_start: false },
    _loaded: true,
    settingsMeta: { status: 'ready', key: 'settings', loadedAt: Date.now(), revision: 0 },
    error: null,
  });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })),
  });
});

describe('GatewaySettings auto start', () => {
  it('persists enabling and disabling auto start without starting or stopping the gateway', async () => {
    render(<GatewaySettings />);
    await userEvent.click(autoStartSwitch());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_settings', {
      settings: expect.objectContaining({ gateway_auto_start: true }),
    }));
    expect(autoStartSwitch()).toBeChecked();

    await userEvent.click(autoStartSwitch());
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('save_settings', {
      settings: expect.objectContaining({ gateway_auto_start: false }),
    }));
    expect(autoStartSwitch()).not.toBeChecked();
    expect(startGateway).not.toHaveBeenCalled();
    expect(stopGateway).not.toHaveBeenCalled();
  });

  it('shows a failed save and restores the persisted switch value', async () => {
    invoke.mockRejectedValueOnce(new Error('database is read-only'));
    const error = vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
    render(<GatewaySettings />);

    await userEvent.click(autoStartSwitch());

    await waitFor(() => expect(error).toHaveBeenCalledWith('Error: database is read-only'));
    expect(autoStartSwitch()).not.toBeChecked();
    expect(useSettingsStore.getState().error).toContain('database is read-only');
    error.mockRestore();
  });
});
