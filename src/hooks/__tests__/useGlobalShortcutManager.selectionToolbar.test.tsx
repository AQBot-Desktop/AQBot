import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalShortcutManager } from '../useGlobalShortcutManager';
import { setCurrentWindowLabel } from '@/lib/windowKind';

const mocks = vi.hoisted(() => ({
  callbacks: new Map<string, (event: { state: string; shortcut: string }) => Promise<void>>(),
  invoke: vi.fn(async () => undefined),
  isRegistered: vi.fn(async () => true),
  register: vi.fn(async (
    shortcut: string,
    callback: (event: { state: string; shortcut: string }) => Promise<void>,
  ) => {
    mocks.callbacks.set(shortcut, callback);
  }),
  unregisterAll: vi.fn(async () => undefined),
  setGlobalShortcutStatus: vi.fn(),
  settingsStatus: 'ready',
  settings: {
    value: {
      global_shortcuts_enabled: true,
      shortcut_registration_logs_enabled: false,
      shortcut_toggle_current_window: 'CmdOrCtrl+Shift+A',
      shortcut_toggle_all_windows: 'CmdOrCtrl+Shift+Alt+A',
      shortcut_close_window: 'CmdOrCtrl+Shift+W',
      selection_toolbar: {
        enabled: true,
        trigger_mode: 'shortcut',
        trigger_shortcut: 'CmdOrCtrl+Shift+E',
        screenshot_shortcut: '',
      },
    },
  },
}));

vi.mock('@/lib/invoke', () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
}));

vi.mock('@/lib/shortcutActions', () => ({
  executeShortcutAction: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  isRegistered: mocks.isRegistered,
  register: mocks.register,
  unregisterAll: mocks.unregisterAll,
}));

vi.mock('@/stores', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    settings: mocks.settings.value,
    settingsMeta: { status: mocks.settingsStatus },
    setGlobalShortcutStatus: mocks.setGlobalShortcutStatus,
  }),
}));

function Harness() {
  useGlobalShortcutManager();
  return null;
}

describe('selection toolbar global shortcut registration', () => {
  beforeEach(() => {
    mocks.callbacks.clear();
    mocks.settingsStatus = 'ready';
    setCurrentWindowLabel('main');
    mocks.invoke.mockClear();
    mocks.isRegistered.mockClear();
    mocks.register.mockClear();
    mocks.unregisterAll.mockClear();
    mocks.setGlobalShortcutStatus.mockClear();
    mocks.settings.value = {
      ...mocks.settings.value,
      global_shortcuts_enabled: true,
      selection_toolbar: {
        enabled: true,
        trigger_mode: 'shortcut',
        trigger_shortcut: 'CmdOrCtrl+Shift+E',
        screenshot_shortcut: '',
      },
    };
  });

  it.each(['idle', 'loading', 'error'])('does not touch native shortcuts before settings are ready (%s)', async (status) => {
    mocks.settingsStatus = status;
    const { unmount } = render(<Harness />);
    unmount();
    await vi.dynamicImportSettled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.unregisterAll).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not replace main-window shortcuts from a popout', async () => {
    setCurrentWindowLabel('conversation-popout:conversation-1');
    const { unmount } = render(<Harness />);
    unmount();
    await vi.dynamicImportSettled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.unregisterAll).not.toHaveBeenCalled();
  });

  it('keeps registered shortcuts when a later settings refresh is pending and fails', async () => {
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(mocks.setGlobalShortcutStatus).toHaveBeenCalled());
    const registrationCount = mocks.register.mock.calls.length;
    expect(mocks.unregisterAll).toHaveBeenCalledTimes(1);

    for (const status of ['idle', 'loading', 'error']) {
      mocks.settingsStatus = status;
      rerender(<Harness />);
      await vi.dynamicImportSettled();
      expect(mocks.unregisterAll).toHaveBeenCalledTimes(1);
      expect(mocks.register).toHaveBeenCalledTimes(registrationCount);
    }
    await mocks.callbacks.get('CommandOrControl+Shift+E')?.({
      state: 'Pressed', shortcut: 'CommandOrControl+Shift+E',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('selection_toolbar_trigger');
  });

  it('registers and dispatches the configured selection toolbar shortcut', async () => {
    render(<Harness />);

    await waitFor(() => expect(mocks.callbacks.has(
      'CommandOrControl+Shift+E',
    )).toBe(true));
    await mocks.callbacks.get('CommandOrControl+Shift+E')?.({
      state: 'Pressed',
      shortcut: 'CommandOrControl+Shift+E',
    });

    expect(mocks.invoke).toHaveBeenCalledWith('selection_toolbar_trigger');
  });

  it('registers an explicit Control shortcut without converting it to CommandOrControl', async () => {
    mocks.settings.value = {
      ...mocks.settings.value,
      selection_toolbar: {
        ...mocks.settings.value.selection_toolbar,
        trigger_shortcut: 'Control+D',
      },
    };

    render(<Harness />);

    await waitFor(() => expect(mocks.callbacks.has('Control+D')).toBe(true));
    expect(mocks.callbacks.has('CommandOrControl+D')).toBe(false);
  });

  it('does not register the toolbar shortcut in automatic selection mode', async () => {
    mocks.settings.value = {
      ...mocks.settings.value,
      selection_toolbar: {
        ...mocks.settings.value.selection_toolbar,
        trigger_mode: 'selection',
      },
    };

    render(<Harness />);

    await waitFor(() => expect(mocks.register).toHaveBeenCalled());
    expect(mocks.callbacks.has('CommandOrControl+Shift+E')).toBe(false);
  });

  it('does not register any shortcut when the global shortcut switch is off', async () => {
    mocks.settings.value = {
      ...mocks.settings.value,
      global_shortcuts_enabled: false,
      selection_toolbar: {
        ...mocks.settings.value.selection_toolbar,
        screenshot_shortcut: 'Control+Shift+X',
      },
    };

    render(<Harness />);

    await waitFor(() => expect(mocks.unregisterAll).toHaveBeenCalled());
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.callbacks.size).toBe(0);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'selection_toolbar_register_screenshot_shortcut', expect.anything(),
    );
  });

  it('registers screenshots natively in the shared pass even in selection mode', async () => {
    mocks.settings.value.selection_toolbar = {
      ...mocks.settings.value.selection_toolbar,
      trigger_mode: 'selection',
      screenshot_shortcut: 'Control+Shift+X',
    };
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'selection_toolbar_register_screenshot_shortcut', { shortcut: 'Control+Shift+X' },
    ));
    expect(mocks.register).not.toHaveBeenCalledWith('Control+Shift+X', expect.anything());
    expect(mocks.isRegistered).toHaveBeenCalledWith('Control+Shift+X');
    await waitFor(() => expect(mocks.setGlobalShortcutStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ registered: expect.arrayContaining(['Control+Shift+X']) }),
    ));
    unmount();
    await waitFor(() => expect(mocks.unregisterAll).toHaveBeenCalledTimes(2));
  });

  it.each([false, true])('skips screenshot registration when cleared or toolbar enabled=%s', async (enabled) => {
    mocks.settings.value.selection_toolbar = {
      ...mocks.settings.value.selection_toolbar,
      enabled,
      screenshot_shortcut: enabled ? '' : 'Control+Shift+X',
    };
    render(<Harness />);
    await waitFor(() => expect(mocks.setGlobalShortcutStatus).toHaveBeenCalled());
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'selection_toolbar_register_screenshot_shortcut', expect.anything(),
    );
  });

  it('reports native screenshot registration failures through the shared diagnostics', async () => {
    mocks.settings.value = {
      ...mocks.settings.value,
      shortcut_registration_logs_enabled: true,
      selection_toolbar: {
        ...mocks.settings.value.selection_toolbar,
        screenshot_shortcut: 'Control+Shift+X',
      },
    };
    mocks.invoke.mockRejectedValueOnce(new Error('already registered'));
    render(<Harness />);
    await waitFor(() => expect(mocks.setGlobalShortcutStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        failed: [{ shortcut: 'Control+Shift+X', reason: 'Error: already registered' }],
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ action: 'selectionToolbarScreenshot', phase: 'register', level: 'error' }),
        ]),
      }),
    ));
  });

  it('records an explicit diagnostic when triggering without a valid selection', async () => {
    mocks.settings.value = {
      ...mocks.settings.value,
      shortcut_registration_logs_enabled: true,
    };
    mocks.invoke.mockRejectedValueOnce(new Error('No active text selection is available'));
    render(<Harness />);

    await waitFor(() => expect(mocks.callbacks.has(
      'CommandOrControl+Shift+E',
    )).toBe(true));
    await mocks.callbacks.get('CommandOrControl+Shift+E')?.({
      state: 'Pressed',
      shortcut: 'CommandOrControl+Shift+E',
    });

    expect(mocks.setGlobalShortcutStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            action: 'selectionToolbar',
            phase: 'trigger',
            reason: 'Error: No active text selection is available',
          }),
        ]),
      }),
    );
  });
});
