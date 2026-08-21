import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionToolbarSettings as SelectionToolbarConfig } from '@/types';
import { SelectionToolbarSettings } from '../SelectionToolbarSettings';

const mocks = vi.hoisted(() => {
  const runtime = {
    value: {
      state: 'permission_required',
      platform: 'macos',
      permission: 'denied',
      last_error: null,
      global_dismissal_supported: true,
    },
  };
  const defaultTools = [
    {
      kind: 'builtin_ai' as const,
      builtin_key: 'translate' as const,
      enabled: true,
      ai: {
        prompt: 'Translate {selection} from {source_language} to {target_language}',
        provider_id: null,
        model_id: null,
        temperature: null,
        top_p: null,
        max_tokens: null,
      },
    },
    {
      kind: 'builtin_ai' as const,
      builtin_key: 'explain' as const,
      enabled: true,
      ai: {
        prompt: 'Explain {selection} in {app_language}',
        provider_id: null,
        model_id: null,
        temperature: null,
        top_p: null,
        max_tokens: null,
      },
    },
    {
      kind: 'builtin_ai' as const,
      builtin_key: 'polish' as const,
      enabled: true,
      ai: {
        prompt: 'Polish {selection}',
        provider_id: null,
        model_id: null,
        temperature: null,
        top_p: null,
        max_tokens: null,
      },
    },
    {
      kind: 'builtin_ai' as const,
      builtin_key: 'summarize' as const,
      enabled: true,
      ai: {
        prompt: 'Summarize {selection}',
        provider_id: null,
        model_id: null,
        temperature: null,
        top_p: null,
        max_tokens: null,
      },
    },
    {
      kind: 'builtin_action' as const,
      builtin_key: 'copy' as const,
      enabled: true,
    },
  ];
  const toolbar = {
    value: {
      enabled: false,
      theme_follow: false,
      display_mode: 'full' as const,
      trigger_mode: 'selection' as const,
      trigger_shortcut: 'CmdOrCtrl+Shift+E',
      translate_target_language: null as string | null,
      search_url: 'https://www.google.com/search?q=%s',
      app_filter_mode: 'off' as const,
      app_filter: [] as Array<{ id: string; name: string }>,
      tools: defaultTools,
    } as SelectionToolbarConfig,
  };
  const appIcons = {
    value: {} as Record<string, string>,
  };
  const globalShortcutsEnabled = { value: true };
  const globalShortcutStatus = {
    value: {
      enabled: true,
      registered: [] as string[],
      failed: [] as Array<{ shortcut: string; reason: string }>,
      diagnostics: [],
    },
  };
  const saveSettings = vi.fn(async (partial: { selection_toolbar?: typeof toolbar.value }) => {
    if (partial.selection_toolbar) {
      toolbar.value = partial.selection_toolbar;
    }
  });
  return {
    ensureProvidersLoaded: vi.fn(async () => {}),
    runtime,
    toolbar,
    appIcons,
    globalShortcutsEnabled,
    globalShortcutStatus,
    defaultTools,
    invoke: vi.fn(async (command: string) => {
      if (command === 'selection_toolbar_resolve_app_paths') {
        return [
          { id: 'com.apple.TextEdit', name: 'TextEdit', icon_data_url: null },
        ];
      }
      if (command === 'selection_toolbar_resolve_app_icons') return appIcons.value;
      if (command === 'selection_toolbar_open_permission_settings') {
        return {
          kind: 'manual_add_required',
          executable_path: '/workspace/target/debug/AQBot',
        };
      }
      return runtime.value;
    }),
    saveSettings,
  };
});

beforeEach(() => {
  mocks.runtime.value = {
    state: 'permission_required',
    platform: 'macos',
    permission: 'denied',
    last_error: null,
    global_dismissal_supported: true,
  };
  mocks.toolbar.value = {
    enabled: false,
    theme_follow: false,
    display_mode: 'full',
    trigger_mode: 'selection',
    trigger_shortcut: 'CmdOrCtrl+Shift+E',
    translate_target_language: null,
    search_url: 'https://www.google.com/search?q=%s',
    app_filter_mode: 'off',
    app_filter: [],
    tools: mocks.defaultTools,
  };
  mocks.appIcons.value = {};
  mocks.globalShortcutsEnabled.value = true;
  mocks.globalShortcutStatus.value = {
    enabled: true,
    registered: [],
    failed: [],
    diagnostics: [],
  };
  mocks.invoke.mockClear();
  mocks.saveSettings.mockClear();
});

vi.mock('@/lib/invoke', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@/stores', () => ({
  useProviderStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ensureProvidersLoaded: mocks.ensureProvidersLoaded,
  }),
  useSettingsStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      settings: {
        selection_toolbar: mocks.toolbar.value,
        global_shortcuts_enabled: mocks.globalShortcutsEnabled.value,
      },
      globalShortcutStatus: mocks.globalShortcutStatus.value,
      saveSettings: mocks.saveSettings,
    }),
    {
      getState: () => ({
        error: null,
        settings: {
          selection_toolbar: mocks.toolbar.value,
          global_shortcuts_enabled: mocks.globalShortcutsEnabled.value,
        },
      }),
    },
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/common/ModelParamSliders', () => ({
  ModelParamSliders: () => null,
}));

vi.mock('@/components/shared/ModelSelect', () => ({
  ModelSelect: () => null,
  parseModelValue: () => null,
}));

describe('SelectionToolbarSettings', () => {
  it('renders the interactive preview as a separate module and opens More', async () => {
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      tools: [
        ...mocks.toolbar.value.tools,
        {
          kind: 'custom_ai',
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Custom 6',
          icon: 'sparkles',
          enabled: true,
          ai: {
            prompt: 'Custom {selection}',
            provider_id: null,
            model_id: null,
            temperature: null,
            top_p: null,
            max_tokens: null,
          },
        },
      ],
    };
    render(<SelectionToolbarSettings />);

    expect(screen.getByText('settings.selectionToolbar.previewTitle')).toBeInTheDocument();
    const preview = screen.getByRole('group', {
      name: 'settings.selectionToolbar.preview',
    });
    expect(within(preview).getByRole('button', {
      name: 'settings.selectionToolbar.tools.explain',
    })).toBeInTheDocument();
    expect(preview).toHaveAttribute('data-preview', 'true');
    expect(preview.querySelector('.lucide-lightbulb')).toBeInTheDocument();

    const translate = within(preview).getByRole('button', {
      name: 'settings.selectionToolbar.tools.translate',
    });
    fireEvent.mouseEnter(translate);
    expect(translate).toHaveAttribute('data-hover', 'true');

    fireEvent.pointerDown(within(preview).getByRole('button', {
      name: 'settings.selectionToolbar.more',
    }), { button: 0 });

    expect(await screen.findByRole('button', { name: 'Custom 6' })).toBeInTheDocument();
    const dropdown = screen.getByRole('menu', {
      name: 'settings.selectionToolbar.more',
    });
    expect(preview).toContainElement(dropdown);
    expect(dropdown).toHaveClass('selection-toolbar__overflow-dropdown');
    expect(screen.getByText('settings.selectionToolbar.previewTitle').parentElement?.parentElement)
      .toHaveStyle({ position: 'relative', zIndex: '10' });
    expect(document.querySelector('.selection-toolbar__preview-overflow')).not.toBeInTheDocument();
  });

  it('persists compact display mode', async () => {
    const user = userEvent.setup();
    render(<SelectionToolbarSettings />);

    await user.click(screen.getByText('settings.selectionToolbar.displayModeCompact'));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledWith({
      selection_toolbar: expect.objectContaining({ display_mode: 'compact' }),
    }));
  });

  it('shows shortcut recording only in shortcut trigger mode and persists capture', async () => {
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      trigger_mode: 'shortcut',
    };
    const user = userEvent.setup();
    render(<SelectionToolbarSettings />);

    const input = screen.getByRole('textbox', {
      name: 'settings.selectionToolbar.triggerShortcut',
    });
    await user.click(screen.getByRole('button', { name: 'settings.recordShortcut' }));
    fireEvent.keyDown(input, { key: 'K', metaKey: true, shiftKey: true });

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledWith({
      selection_toolbar: expect.objectContaining({
        trigger_mode: 'shortcut',
        trigger_shortcut: 'CmdOrCtrl+Shift+K',
      }),
    }));
  });

  it('preserves the physical Control modifier when recording on macOS', async () => {
    const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      trigger_mode: 'shortcut',
    };
    const user = userEvent.setup();
    render(<SelectionToolbarSettings />);

    const input = screen.getByRole('textbox', {
      name: 'settings.selectionToolbar.triggerShortcut',
    });
    await user.click(screen.getByRole('button', { name: 'settings.recordShortcut' }));
    fireEvent.keyDown(input, { key: 'D', ctrlKey: true });

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledWith({
      selection_toolbar: expect.objectContaining({
        trigger_mode: 'shortcut',
        trigger_shortcut: 'Control+D',
      }),
    }));
    platform.mockRestore();
  });

  it('persists shortcut trigger mode and resets its binding to the default', async () => {
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      trigger_mode: 'shortcut',
      trigger_shortcut: 'CmdOrCtrl+Shift+K',
    };
    const user = userEvent.setup();
    render(<SelectionToolbarSettings />);

    await user.click(screen.getByRole('button', {
      name: 'settings.resetShortcutSingle',
    }));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledWith({
      selection_toolbar: expect.objectContaining({
        trigger_mode: 'shortcut',
        trigger_shortcut: 'CmdOrCtrl+Shift+E',
      }),
    }));
  });

  it('shows configured shortcut conflicts and registration failures', () => {
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      trigger_mode: 'shortcut',
      trigger_shortcut: 'CmdOrCtrl+Shift+A',
    };
    mocks.globalShortcutStatus.value = {
      enabled: true,
      registered: [],
      failed: [{
        shortcut: 'CommandOrControl+Shift+A',
        reason: 'already registered',
      }],
      diagnostics: [],
    };

    render(<SelectionToolbarSettings />);

    expect(screen.getByText(
      'settings.selectionToolbar.shortcutConflict',
    )).toBeInTheDocument();
    expect(screen.getByText(
      'settings.selectionToolbar.shortcutRegisterFailed',
    )).toBeInTheDocument();
  });

  it('warns when shortcut trigger mode cannot use the global shortcut switch', () => {
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      trigger_mode: 'shortcut',
    };
    mocks.globalShortcutsEnabled.value = false;

    render(<SelectionToolbarSettings />);

    expect(screen.getByText(
      'settings.selectionToolbar.globalShortcutsDisabled',
    )).toBeInTheDocument();
  });

  it('uses the full settings content width without a page-specific maximum', () => {
    render(<SelectionToolbarSettings />);

    const page = screen.getByTestId('selection-toolbar-settings');
    expect(page).toHaveStyle({ width: '100%' });
    expect(page.style.maxWidth).toBe('');
  });

  it('explains how to add an unbundled macOS development executable', async () => {
    const user = userEvent.setup();
    render(<SelectionToolbarSettings />);

    await user.click(await screen.findByRole('button', {
      name: 'settings.selectionToolbar.openPermission',
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'settings.selectionToolbar.developmentPermissionHint',
    );
  });

  it('always shows denied permission and its authorization action independently of runtime state', async () => {
    mocks.runtime.value = {
      state: 'running',
      platform: 'macos',
      permission: 'denied',
      last_error: null,
      global_dismissal_supported: true,
    };

    render(<SelectionToolbarSettings />);

    expect(await screen.findByText(
      'settings.selectionToolbar.permission.denied',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'settings.selectionToolbar.openPermission',
    })).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'settings.selectionToolbar.requestPermission',
    })).toBeInTheDocument();
    expect(screen.getByText(
      'settings.selectionToolbar.permissionDeniedHint',
    )).toBeInTheDocument();
    expect(screen.queryByText(
      'settings.selectionToolbar.runtimeTitle',
    )).not.toBeInTheDocument();
  });

  it('opens a guided authorization flow and the macOS permission pane together', async () => {
    const user = userEvent.setup();
    render(<SelectionToolbarSettings />);

    await user.click(await screen.findByRole('button', {
      name: 'settings.selectionToolbar.requestPermission',
    }));

    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'settings.selectionToolbar.guideTitle',
    );
    expect(screen.getByText(
      'settings.selectionToolbar.guideStepEnable',
    )).toBeInTheDocument();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'selection_toolbar_request_permission',
    ));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'selection_toolbar_open_permission_settings',
    ));
  });

  it('refreshes the permission status when the settings window regains focus', async () => {
    render(<SelectionToolbarSettings />);
    expect(await screen.findByText(
      'settings.selectionToolbar.permission.denied',
    )).toBeInTheDocument();

    mocks.runtime.value = {
      state: 'running',
      platform: 'macos',
      permission: 'granted',
      last_error: null,
      global_dismissal_supported: true,
    };
    fireEvent.focus(window);

    expect(await screen.findByText(
      'settings.selectionToolbar.permission.granted',
    )).toBeInTheDocument();
  });

  it('shows translate-only language placeholders in the translate prompt hint', async () => {
    const user = userEvent.setup();
    render(<SelectionToolbarSettings />);

    expect(screen.queryByRole('combobox', {
      name: 'settings.selectionToolbar.translateTargetLanguage',
    })).not.toBeInTheDocument();
    const editButtons = await screen.findAllByRole('button', { name: 'common.edit' });
    await user.click(editButtons[0]);

    expect(screen.getByRole('combobox', {
      name: 'settings.selectionToolbar.translateTargetLanguage',
    })).toBeInTheDocument();
    expect(await screen.findByText(
      'settings.selectionToolbar.promptHintTranslate',
    )).toBeInTheDocument();
    expect(screen.queryByText(
      'settings.selectionToolbar.promptHint',
    )).not.toBeInTheDocument();
  });

  it('persists the translate target together with the translated tool edit', async () => {
    render(<SelectionToolbarSettings />);

    const editButtons = await screen.findAllByRole('button', { name: 'common.edit' });
    fireEvent.click(editButtons[0]);
    fireEvent.mouseDown(screen.getByRole('combobox', {
      name: 'settings.selectionToolbar.translateTargetLanguage',
    }));
    fireEvent.click(await screen.findByText('日本語'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledWith({
      selection_toolbar: expect.objectContaining({
        translate_target_language: 'ja',
      }),
    }));
  });

  it('hides translate language placeholders for non-translate tools', async () => {
    const user = userEvent.setup();
    render(<SelectionToolbarSettings />);

    const editButtons = await screen.findAllByRole('button', { name: 'common.edit' });
    await user.click(editButtons[1]);

    expect(await screen.findByText(
      'settings.selectionToolbar.promptHint',
    )).toBeInTheDocument();
    expect(screen.queryByText(
      'settings.selectionToolbar.promptHintTranslate',
    )).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', {
      name: 'settings.selectionToolbar.translateTargetLanguage',
    })).not.toBeInTheDocument();
  });

  it('shows app filter controls in allowlist mode', async () => {
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      app_filter_mode: 'allowlist',
      app_filter: [{ id: 'com.apple.TextEdit', name: 'TextEdit' }],
    };

    render(<SelectionToolbarSettings />);

    expect(await screen.findByText('settings.selectionToolbar.appFilterTitle')).toBeInTheDocument();
    expect(screen.getByText('settings.selectionToolbar.appFilterHintAllowlist')).toBeInTheDocument();
    expect(screen.getByText('TextEdit')).toBeInTheDocument();
    expect(screen.getByText('com.apple.TextEdit')).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'settings.selectionToolbar.appFilterAdd',
    })).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'settings.selectionToolbar.appFilterRemove',
    })).toBeInTheDocument();
  });

  it('reuses resolved app icons when the settings page is opened again', async () => {
    mocks.appIcons.value = {
      'com.example.CacheTest': 'data:image/png;base64,Y2FjaGVk',
    };
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      app_filter_mode: 'allowlist',
      app_filter: [{ id: 'com.example.CacheTest', name: 'Cache Test' }],
    };

    const first = render(<SelectionToolbarSettings />);
    await waitFor(() => expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === 'selection_toolbar_resolve_app_icons',
      ),
    ).toHaveLength(1));
    await waitFor(() => expect(document.querySelector(
      'img[src="data:image/png;base64,Y2FjaGVk"]',
    )).toBeInTheDocument());
    first.unmount();

    render(<SelectionToolbarSettings />);
    await waitFor(() => expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === 'selection_toolbar_resolve_app_icons',
      ),
    ).toHaveLength(1));
  });

  it('retries app icons that failed to resolve when the page is opened again', async () => {
    mocks.toolbar.value = {
      ...mocks.toolbar.value,
      app_filter_mode: 'allowlist',
      app_filter: [{ id: 'com.example.RetryIcon', name: 'Retry Icon' }],
    };

    const first = render(<SelectionToolbarSettings />);
    await waitFor(() => expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === 'selection_toolbar_resolve_app_icons',
      ),
    ).toHaveLength(1));
    first.unmount();

    render(<SelectionToolbarSettings />);
    await waitFor(() => expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === 'selection_toolbar_resolve_app_icons',
      ),
    ).toHaveLength(2));
  });

  it('places the app filter after tools and renders descriptions as secondary text', () => {
    render(<SelectionToolbarSettings />);

    const toolsTitle = screen.getByText('settings.selectionToolbar.toolsTitle');
    const appFilterTitle = screen.getByText('settings.selectionToolbar.appFilterTitle');
    expect(
      toolsTitle.compareDocumentPosition(appFilterTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('settings.selectionToolbar.enabledHint')).toHaveStyle({
      color: 'rgba(0, 0, 0, 0.45)',
    });
  });
});
