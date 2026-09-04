import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  label: 'main',
  getSettings: vi.fn(),
  layout: vi.fn(),
  nativeSettings: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  invoke: vi.fn(),
  diagnostics: vi.fn(),
  closeListeners: new Set<() => void>(),
  contentMounted: vi.fn(),
  contentError: null as Error | null,
}));
vi.mock('@/lib/invoke', () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
  listen: async (event: string, callback: () => void) => {
    if (event === 'app-close-requested') mocks.closeListeners.add(callback);
    return () => mocks.closeListeners.delete(callback);
  },
}));
const createStoreMocks = async () => ({
  useSettingsStore: (await import('@/stores/settingsStore')).useSettingsStore,
  useUIStore: (select: (state: object) => unknown) => select({ activePage: 'chat', settingsSection: 'general' }),
  useConversationStore: (select: (state: object) => unknown) => select({
    startStreamListening: () => {}, stopStreamListening: () => {},
  }),
  useMultiModelColumnLayoutStore: { getState: () => ({ ensureLoaded: mocks.layout }) },
});
vi.mock('antd', () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    ConfigProvider: Container,
    App: Object.assign(Container, { useApp: () => ({ modal: {} }) }),
    Layout: Object.assign(Container, { Sider: Container, Content: Container }),
    theme: { useToken: () => ({ token: {} }) },
  };
});
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN', dir: () => 'ltr', getFixedT: () => (key: string) => key },
  }),
}));
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/TitleBar', () => ({ TitleBar: () => null }));
vi.mock('@/components/layout/ContentArea', async () => {
  const { useEffect } = await import('react');
  return { ContentArea: () => {
    useEffect(() => { mocks.contentMounted(); }, []);
    if (mocks.contentError) throw mocks.contentError;
    return <div>application content</div>;
  } };
});
vi.mock('@/components/layout/CommandPalette', () => ({ default: () => null }));
vi.mock('@/components/layout/GlobalCopyMenu', () => ({ GlobalCopyMenu: () => null }));
vi.mock('@/components/layout/CrashRecoveryModal', () => ({ CrashRecoveryModal: () => null }));
vi.mock('@/components/chat/ConversationPopoutInner', () => ({ ConversationPopoutInner: () => null }));
vi.mock('@/hooks/useCommandPalette', () => ({ useCommandPalette: () => ({ open: false, setOpen: vi.fn() }) }));
vi.mock('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => {} }));
vi.mock('@/hooks/useGlobalShortcutManager', () => ({ useGlobalShortcutManager: () => {} }));
vi.mock('@/hooks/useConversationTabsCoordinator', () => ({ useConversationTabsCoordinator: () => {} }));
vi.mock('@/hooks/useGlobalOverlayScrollbars', () => ({ useGlobalOverlayScrollbars: () => {} }));
vi.mock('@/hooks/useTrayMenuActions', () => ({ useTrayMenuActions: () => {} }));
vi.mock('@/hooks/useProviderDeepLink', () => ({ ProviderDeepLinkDialog: () => null }));
vi.mock('@/hooks/useResolvedDarkMode', () => ({ useResolvedDarkMode: () => false }));
vi.mock('@/hooks/useSystemFontFaces', () => ({ useSystemFontFaces: () => [] }));
vi.mock('@/hooks/useUpdateChecker', () => ({ useUpdateChecker: () => ({ checkForUpdate: () => {} }) }));
vi.mock('@/theme/shadcnTheme', () => ({ useShadcnTheme: () => ({}) }));
vi.mock('@/stores/acpStore', () => ({ useAcpStore: { getState: () => ({ warmBootstrap: () => {} }) } }));
vi.mock('@/stores/agentStore', () => ({ setupAgentEventListeners: () => () => {} }));
vi.mock('@/lib/preloadChatRenderers', () => ({ preloadChatRenderers: () => Promise.resolve() }));
vi.mock('markstream-react', () => ({ enableD2: () => {}, setDefaultI18nMap: () => {} }));

async function mount() {
  const { setCurrentWindowLabel } = await import('@/lib/windowKind');
  setCurrentWindowLabel(mocks.label);
  const { default: App } = await import('../App');
  return render(<StrictMode><App /></StrictMode>);
}

describe('native startup presentation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.closeListeners.clear();
    mocks.contentError = null;
    vi.doMock('@/stores', createStoreMocks);
    mocks.label = 'main';
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      metadata: { currentWindow: { label: mocks.label }, currentWebview: { label: mocks.label } },
      invoke: (command: string, args: object) => {
        if (command === 'plugin:window|show') return mocks.show();
        if (command === 'plugin:window|set_focus') return mocks.focus();
        if (command === 'plugin:autostart|enable') return mocks.enable();
        if (command === 'plugin:autostart|disable') return mocks.disable();
        return mocks.diagnostics(command, args);
      },
    } });
    for (const fn of [mocks.getSettings, mocks.layout, mocks.nativeSettings, mocks.enable, mocks.disable,
      mocks.show, mocks.focus, mocks.diagnostics]) fn.mockResolvedValue(undefined);
    mocks.getSettings.mockResolvedValue({ auto_check_update: false });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_settings') return mocks.getSettings();
      if (command === 'apply_startup_settings' || command === 'set_always_on_top') return mocks.nativeSettings();
      return Promise.resolve();
    });
  });

  it('can close the visible startup screen while settings are still pending', async () => {
    mocks.getSettings.mockReturnValue(new Promise(() => {}));
    await mount();
    await waitFor(() => expect(mocks.closeListeners.size).toBe(1));
    for (const callback of mocks.closeListeners) callback();
    expect(mocks.invoke).toHaveBeenCalledWith('force_quit');
  });

  it('keeps the existing application mounted when settings are subsequently refreshed', async () => {
    await mount();
    expect(await screen.findByText('application content')).toBeInTheDocument();
    const mountCount = mocks.contentMounted.mock.calls.length;
    const { useSettingsStore } = await import('@/stores/settingsStore');
    act(() => useSettingsStore.getState().invalidateSettings('restore'));
    expect(screen.getByText('application content')).toBeInTheDocument();
    expect(mocks.contentMounted).toHaveBeenCalledTimes(mountCount);
    expect(screen.queryByText('startup.loading')).not.toBeInTheDocument();
  });

  it('does not confirm a successful startup if the first application render throws', async () => {
    mocks.contentError = new Error('application content render failed');
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false);
    const { createRoot } = await import('react-dom/client');
    const { default: App } = await import('../App');
    const onUncaughtError = vi.fn();
    const root = createRoot(document.createElement('div'), { onUncaughtError });
    try {
      root.render(<App />);
      await waitFor(() => expect(onUncaughtError).toHaveBeenCalled());
      expect(mocks.show).toHaveBeenCalledTimes(1);
      expect(mocks.diagnostics).not.toHaveBeenCalledWith('report_startup_presented', { kind: 'app' });
    } finally {
      root.unmount();
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    }
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it.each(['settings', 'layout', 'native', 'autostart'])('shows after commit while %s remains pending', async (phase) => {
    const pending = new Promise(() => {});
    const dependency = { settings: mocks.getSettings, layout: mocks.layout, native: mocks.nativeSettings,
      autostart: mocks.disable }[phase]!;
    dependency.mockReturnValue(pending);
    await mount();
    await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
    await waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
    if (phase === 'settings') expect(screen.getByText('startup.loading')).toBeInTheDocument();
    if (phase === 'settings') {
      expect(mocks.diagnostics).not.toHaveBeenCalledWith('report_startup_presented', { kind: 'app' });
    } else {
      await waitFor(() => expect(mocks.diagnostics).toHaveBeenCalledWith('report_startup_presented', { kind: 'app' }));
    }
    expect(mocks.layout).toHaveBeenCalledTimes(1);
  });

  it('shows the settings error without applying defaults after the store resolves a failed fetch', async () => {
    mocks.getSettings.mockRejectedValue(new Error('settings database unavailable'));
    await mount();
    expect(await screen.findByText('startup.settingsFailed')).toBeInTheDocument();
    expect(screen.getByText('Error: settings database unavailable')).toBeInTheDocument();
    expect(mocks.nativeSettings).not.toHaveBeenCalled();
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.disable).not.toHaveBeenCalled();
    expect(mocks.diagnostics).not.toHaveBeenCalledWith('report_startup_presented', { kind: 'app' });
    await waitFor(() => expect(mocks.diagnostics).toHaveBeenCalledWith('report_startup_presented', { kind: 'error' }));
    expect(mocks.diagnostics).toHaveBeenCalledWith('write_diagnostic_log', expect.objectContaining({
      level: 'error', message: expect.stringContaining('settings database unavailable'),
    }));
  });

  it('does not confirm success while settings are pending and subsequently fail', async () => {
    let rejectSettings!: (reason: Error) => void;
    mocks.getSettings.mockImplementation(() => new Promise((_, reject) => { rejectSettings = reject; }));
    await mount();
    await waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
    expect(mocks.diagnostics).not.toHaveBeenCalledWith('report_startup_presented', expect.anything());
    await act(async () => rejectSettings(new Error('late settings failure')));
    expect(await screen.findByText('startup.settingsFailed')).toBeInTheDocument();
    await waitFor(() => expect(mocks.diagnostics).toHaveBeenCalledWith('report_startup_presented', { kind: 'error' }));
    expect(mocks.diagnostics).not.toHaveBeenCalledWith('report_startup_presented', { kind: 'app' });
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });

  it.each(['layout', 'native', 'autostart'])('keeps the window visible and logs %s failures', async (phase) => {
    const dependency = { layout: mocks.layout, native: mocks.nativeSettings, autostart: mocks.disable }[phase]!;
    dependency.mockRejectedValue(new Error(`${phase} failed`));
    await mount();
    await waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.diagnostics).toHaveBeenCalledWith('write_diagnostic_log', expect.objectContaining({
      level: 'error', message: expect.stringContaining(`${phase} failed`),
    })));
  });

  it('preserves popout readiness without changing main-window tray or autostart settings', async () => {
    mocks.label = 'conversation-popout:conversation-1';
    const runtime = Reflect.get(window, '__TAURI_INTERNALS__');
    runtime.metadata.currentWindow.label = mocks.label;
    runtime.metadata.currentWebview.label = mocks.label;
    await mount();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('report_conversation_popout_ready', {
      conversationId: 'conversation-1',
    }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('set_always_on_top', { enabled: false }));
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalledWith('apply_startup_settings', expect.anything());
    expect(mocks.diagnostics).not.toHaveBeenCalledWith('report_startup_presented', expect.anything());
    expect(mocks.disable).not.toHaveBeenCalled();
    expect(mocks.closeListeners.size).toBe(0);
  });
});
