import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { useSettingsStore } from '@/stores/settingsStore';
import { TrayIconSettings } from '../TrayIconSettings';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn(), desktop: true,
  success: vi.fn(), warning: vi.fn(), error: vi.fn(),
}));
vi.mock('@/lib/invoke', () => ({
  invoke: mocks.invoke, listen: mocks.listen, isTauri: () => mocks.desktop,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const prefix = 'settings.customTrayIcon.';
let serverRevision = 0;
const status = (id: string | null, applied = true) => ({ revision: serverRevision++, trayIconFileId: id, applied, error: null, warnings: [] });
function choose() {
  fireEvent.change(screen.getByLabelText(prefix + 'choose'), {
    target: { files: [new File(['image bytes'], 'tray.png', { type: 'image/png' })] },
  });
}

describe('custom tray icon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverRevision = 0;
    mocks.desktop = true;
    mocks.listen.mockResolvedValue(mocks.unlisten);
    mocks.invoke.mockImplementation(async (command) => {
      if (command === 'get_tray_icon_status') return status(null);
      throw new Error(`Unexpected command: ${command}`);
    });
    vi.spyOn(App, 'useApp').mockReturnValue({ message: {
      success: mocks.success, warning: mocks.warning, error: mocks.error,
    } } as unknown as ReturnType<typeof App.useApp>);
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:tray-preview');
      static revokeObjectURL = vi.fn();
    });
    useSettingsStore.setState((state) => ({
      trayIconRevision: -1,
      settings: { ...state.settings, tray_icon_file_id: null, tray_enabled: true, tray_icon_style: 'color' },
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('previews locally and cancels without saving, releasing the object URL', async () => {
    render(<TrayIconSettings monochrome={false} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('get_tray_icon_status'));
    choose();
    expect(screen.getByAltText(prefix + 'preview')).toHaveAttribute('src', 'blob:tray-preview');
    fireEvent.click(screen.getByText('common.cancel'));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:tray-preview');
  });

  it('saves only after apply and uses the returned managed file ID', async () => {
    render(<TrayIconSettings monochrome={false} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    mocks.invoke.mockResolvedValueOnce(status('new-icon'));
    choose();
    fireEvent.click(screen.getByText(prefix + 'apply'));
    await waitFor(() => expect(useSettingsStore.getState().settings.tray_icon_file_id).toBe('new-icon'));
    expect(mocks.invoke).toHaveBeenLastCalledWith('set_custom_tray_icon', {
      data: btoa('image bytes'), mimeType: 'image/png',
    });
    expect(mocks.success).toHaveBeenCalledWith(prefix + 'applied');
    expect(screen.queryByText(prefix + 'apply')).not.toBeInTheDocument();
  });

  it('preserves the saved reference and pending selection when native application fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.invoke.mockResolvedValueOnce(status('old-icon'));
    render(<TrayIconSettings monochrome={false} />);
    await waitFor(() => expect(useSettingsStore.getState().settings.tray_icon_file_id).toBe('old-icon'));
    mocks.invoke.mockRejectedValueOnce(new Error('native failure'));
    choose();
    fireEvent.click(screen.getByText(prefix + 'apply'));
    await screen.findByText(prefix + 'failed');
    expect(useSettingsStore.getState().settings.tray_icon_file_id).toBe('old-icon');
    expect(screen.getByText(prefix + 'apply')).toBeInTheDocument();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('allows reset while the tray is disabled and reports deferred application', async () => {
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, tray_enabled: false } }));
    mocks.invoke.mockResolvedValueOnce(status('old-icon', false));
    render(<TrayIconSettings monochrome />);
    await waitFor(() => expect(screen.getByRole('button', { name: prefix + 'reset' })).not.toBeDisabled());
    mocks.invoke.mockResolvedValueOnce(status(null, false));
    fireEvent.click(screen.getByText(prefix + 'reset'));
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith('reset_tray_icon'));
    await waitFor(() => expect(useSettingsStore.getState().settings.tray_icon_file_id).toBeNull());
    expect(mocks.success).toHaveBeenCalledWith(prefix + 'deferred');
  });

  it('rejects oversized files without invoking the upload command', async () => {
    render(<TrayIconSettings monochrome={false} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    const file = new File(['image'], 'large.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText(prefix + 'choose'), { target: { files: [file] } });
    expect(screen.getByText(prefix + 'sizeError')).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('receives another window’s committed icon and cleans up the listener', async () => {
    const view = render(<TrayIconSettings monochrome={false} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    act(() => mocks.listen.mock.calls[0][1]({ payload: status('other-window-icon') }));
    expect(useSettingsStore.getState().settings.tray_icon_file_id).toBe('other-window-icon');
    view.unmount();
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalled());
  });

  it('disables native controls in the browser', () => {
    mocks.desktop = false;
    render(<TrayIconSettings monochrome={false} />);
    expect(screen.getByRole('button', { name: prefix + 'choose' })).toBeDisabled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not let a late mutation response overwrite a newer window event', async () => {
    render(<TrayIconSettings monochrome={false} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    let finish!: (value: ReturnType<typeof status>) => void;
    const older = status('older-icon');
    const newer = status('newer-icon');
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    choose();
    fireEvent.click(screen.getByText(prefix + 'apply'));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    act(() => mocks.listen.mock.calls[0][1]({ payload: newer }));
    await act(async () => finish(older));
    expect(useSettingsStore.getState().settings.tray_icon_file_id).toBe('newer-icon');
  });

  it('ignores a status query that completes after a newer change event', async () => {
    let finish!: (value: ReturnType<typeof status>) => void;
    const older = status('older-icon');
    const newer = status('newer-icon');
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<TrayIconSettings monochrome={false} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    act(() => mocks.listen.mock.calls[0][1]({ payload: newer }));
    await act(async () => finish(older));
    expect(useSettingsStore.getState().settings.tray_icon_file_id).toBe('newer-icon');
  });
});
