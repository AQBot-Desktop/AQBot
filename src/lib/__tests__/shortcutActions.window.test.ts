import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  window: {
    isVisible: vi.fn(), isMinimized: vi.fn(), hide: vi.fn(),
    unminimize: vi.fn(), show: vi.fn(), setFocus: vi.fn(),
  },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => mocks.window,
  getAllWindows: async () => [mocks.window],
}));
vi.mock('@/lib/invoke', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: { shortcut_trigger_toast_enabled: false } }) },
}));
vi.mock('@/stores/uiStore', () => ({ useUIStore: {} }));
vi.mock('antd', () => ({ message: {} }));

import { executeShortcutAction } from '../shortcutActions';

describe('window visibility shortcuts', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.window)) fn.mockReset().mockResolvedValue(undefined);
    mocks.window.isVisible.mockResolvedValue(true);
    mocks.window.isMinimized.mockResolvedValue(false);
  });

  it.each(['toggleCurrentWindow', 'toggleAllWindows'] as const)('%s restores a minimized startup window instead of hiding it', async (action) => {
    mocks.window.isMinimized.mockResolvedValue(true);
    await executeShortcutAction(action);
    expect(mocks.window.hide).not.toHaveBeenCalled();
    expect(mocks.window.unminimize).toHaveBeenCalledTimes(1);
    expect(mocks.window.show).toHaveBeenCalledTimes(1);
    expect(mocks.window.setFocus).toHaveBeenCalledTimes(1);
    expect(mocks.window.unminimize.mock.invocationCallOrder[0]).toBeLessThan(mocks.window.show.mock.invocationCallOrder[0]);
  });

  it.each(['toggleCurrentWindow', 'toggleAllWindows'] as const)('%s still hides a visible window', async (action) => {
    await executeShortcutAction(action);
    expect(mocks.window.hide).toHaveBeenCalledTimes(1);
    expect(mocks.window.unminimize).not.toHaveBeenCalled();
    expect(mocks.window.show).not.toHaveBeenCalled();
  });

  it('restores a hidden window before focusing it', async () => {
    mocks.window.isVisible.mockResolvedValue(false);
    await executeShortcutAction('toggleCurrentWindow');
    expect(mocks.window.unminimize).toHaveBeenCalledTimes(1);
    expect(mocks.window.show).toHaveBeenCalledTimes(1);
    expect(mocks.window.setFocus).toHaveBeenCalledTimes(1);
  });
});
