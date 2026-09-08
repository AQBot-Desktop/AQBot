import { beforeEach, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/invoke', () => ({ invoke }));

beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

it('excludes the dedicated icon reference from ordinary settings writes', async () => {
  invoke.mockResolvedValueOnce({
    tray_icon_file_id: 'current-icon',
    use_tray_icon_as_app_icon: true,
  }).mockResolvedValueOnce({ saved: true });
  const { useSettingsStore } = await import('../settingsStore');
  await useSettingsStore.getState().fetchSettings();
  await useSettingsStore.getState().saveSettings({
    theme_mode: 'dark',
    tray_icon_file_id: 'stale-icon',
    use_tray_icon_as_app_icon: false,
  });
  expect(invoke.mock.calls[1][1].settings).not.toHaveProperty('tray_icon_file_id');
  expect(invoke.mock.calls[1][1].settings).not.toHaveProperty('use_tray_icon_as_app_icon');
  expect(useSettingsStore.getState().settings.tray_icon_file_id).toBe('current-icon');
  expect(useSettingsStore.getState().settings.use_tray_icon_as_app_icon).toBe(true);
});

it('does not undo a concurrent icon change when an unrelated settings write fails', async () => {
  invoke.mockResolvedValueOnce({ tray_icon_file_id: 'old-icon' });
  const { useSettingsStore } = await import('../settingsStore');
  await useSettingsStore.getState().fetchSettings();
  let reject!: (error: Error) => void;
  invoke.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const pending = useSettingsStore.getState().saveSettings({ theme_mode: 'dark' });
  useSettingsStore.setState((state) => ({
    settings: {
      ...state.settings,
      tray_icon_file_id: 'new-icon',
      use_tray_icon_as_app_icon: true,
    },
  }));
  reject(new Error('DB unavailable'));
  await pending;
  expect(useSettingsStore.getState().settings.tray_icon_file_id).toBe('new-icon');
  expect(useSettingsStore.getState().settings.use_tray_icon_as_app_icon).toBe(true);
  expect(useSettingsStore.getState().error).toContain('DB unavailable');
});

it('rethrows when throwOnError is set', async () => {
  invoke.mockResolvedValueOnce({ language: 'zh-CN' });
  const { useSettingsStore } = await import('../settingsStore');
  await useSettingsStore.getState().fetchSettings();
  invoke.mockRejectedValueOnce(new Error('save blocked'));
  await expect(useSettingsStore.getState().saveSettings(
    { model_test_prompt: 'ping' },
    { throwOnError: true },
  )).rejects.toThrow('save blocked');
});
