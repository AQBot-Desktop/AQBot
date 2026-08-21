import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalShortcutManager } from '../useGlobalShortcutManager';

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
      },
    };
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
    };

    render(<Harness />);

    await waitFor(() => expect(mocks.unregisterAll).toHaveBeenCalled());
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.callbacks.size).toBe(0);
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
