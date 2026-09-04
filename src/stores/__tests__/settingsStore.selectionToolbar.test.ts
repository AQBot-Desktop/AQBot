import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

describe('selection toolbar settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('adds backward-compatible defaults when the backend has no toolbar settings', async () => {
    invokeMock.mockResolvedValueOnce({});
    const { useSettingsStore } = await import('../settingsStore');

    await useSettingsStore.getState().fetchSettings();

    expect(useSettingsStore.getState().settings.selection_toolbar).toMatchObject({
      enabled: false,
      theme_follow: false,
      display_mode: 'full',
      placement: 'below',
      result_pinned_by_default: false,
      trigger_mode: 'selection',
      trigger_shortcut: 'CmdOrCtrl+Shift+E',
      screenshot_shortcut: '',
    });
    expect(useSettingsStore.getState().settings.selection_toolbar.tools).toHaveLength(6);
    expect(useSettingsStore.getState().settings.selection_toolbar.search_url)
      .toBe('https://www.google.com/search?q=%s');
  });

  it('inserts explain after translate when fetched tools use the legacy shape', async () => {
    invokeMock.mockResolvedValueOnce({
      selection_toolbar: {
        tools: [
          {
            kind: 'builtin_ai',
            builtin_key: 'translate',
            enabled: true,
            ai: {
              prompt: 'Translate {selection}',
              provider_id: null,
              model_id: null,
              temperature: null,
              top_p: null,
              max_tokens: null,
            },
          },
          { kind: 'builtin_action', builtin_key: 'copy', enabled: true },
        ],
      },
    });
    const { useSettingsStore } = await import('../settingsStore');

    await useSettingsStore.getState().fetchSettings();

    expect(
      useSettingsStore.getState().settings.selection_toolbar.tools.map((tool) =>
        tool.kind === 'custom_ai' ? tool.id : tool.builtin_key),
    ).toEqual(['translate', 'explain', 'copy', 'search']);
    expect(useSettingsStore.getState().settings.selection_toolbar).toMatchObject({
      placement: 'below',
      result_pinned_by_default: false,
      screenshot_shortcut: '',
    });
    const translate = useSettingsStore.getState().settings.selection_toolbar.tools[0];
    expect(translate).toMatchObject({ ai: { text_direct_send: true, screenshot_direct_send: true } });
  });

  it('preserves explicitly disabled direct-send preferences', async () => {
    invokeMock.mockResolvedValueOnce({
      selection_toolbar: {
        screenshot_shortcut: 'Control+Shift+X',
        tools: [{
          kind: 'custom_ai',
          id: 'custom',
          name: 'Custom',
          icon: 'sparkles',
          enabled: true,
          ai: { prompt: '{selection}', text_direct_send: false, screenshot_direct_send: false },
        }],
      },
    });
    const { useSettingsStore } = await import('../settingsStore');
    await useSettingsStore.getState().fetchSettings();
    expect(useSettingsStore.getState().settings.selection_toolbar).toMatchObject({
      screenshot_shortcut: 'Control+Shift+X',
      tools: expect.arrayContaining([
        expect.objectContaining({
          id: 'custom',
          ai: expect.objectContaining({ text_direct_send: false, screenshot_direct_send: false }),
        }),
      ]),
    });
  });

  it('rolls back an optimistic toolbar update when persistence fails', async () => {
    invokeMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('save failed'));
    const { useSettingsStore } = await import('../settingsStore');
    await useSettingsStore.getState().fetchSettings();

    await useSettingsStore.getState().saveSettings({
      selection_toolbar: {
        ...useSettingsStore.getState().settings.selection_toolbar,
        enabled: true,
      },
    });

    expect(useSettingsStore.getState().settings.selection_toolbar.enabled).toBe(false);
    expect(useSettingsStore.getState().error).toContain('save failed');
  });
});
