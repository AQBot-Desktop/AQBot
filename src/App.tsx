import { lazy, Suspense, useEffect, useRef, useCallback, useDeferredValue, useState } from 'react';
import { ConfigProvider, App as AntdApp, Layout, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useTranslation } from 'react-i18next';
import { Sidebar } from '@/components/layout/Sidebar';
import { TitleBar } from '@/components/layout/TitleBar';
import { ContentArea } from '@/components/layout/ContentArea';
import { ChatChromeContext } from '@/lib/chatChrome';
import {
  conversationIdFromPopoutLabel,
  frontendKindForWindow,
  getCurrentWindowLabel,
} from '@/lib/windowKind';
import CommandPalette from '@/components/layout/CommandPalette';
import { GlobalCopyMenu } from '@/components/layout/GlobalCopyMenu';
import { CrashRecoveryModal } from '@/components/layout/CrashRecoveryModal';
import { useCommandPalette } from '@/hooks/useCommandPalette';
import { useUIStore, useSettingsStore, useConversationStore } from '@/stores';
import { useAppStartup } from '@/hooks/useAppStartup';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useConversationTabsCoordinator } from '@/hooks/useConversationTabsCoordinator';
import { useGlobalShortcutManager } from '@/hooks/useGlobalShortcutManager';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import { useGlobalOverlayScrollbars } from '@/hooks/useGlobalOverlayScrollbars';
import { useUpdateChecker } from '@/hooks/useUpdateChecker';
import { useTrayMenuActions } from '@/hooks/useTrayMenuActions';
import { ProviderDeepLinkDialog } from '@/hooks/useProviderDeepLink';
import { useShadcnTheme } from '@/theme/shadcnTheme';
import { isTauri, invoke, listen } from '@/lib/invoke';
import { applyAppFonts } from '@/lib/applyAppFonts';
import { cssFontStack, DEFAULT_CODE_FONT_FALLBACK, DEFAULT_UI_FONT_FALLBACK } from '@/lib/cssFontFamily';
import { preloadChatRenderers } from '@/lib/preloadChatRenderers';
import { useSystemFontFaces } from '@/hooks/useSystemFontFaces';
import { setupAgentEventListeners } from '@/stores/agentStore';
import { enableD2 } from 'markstream-react';
import { applyMarkstreamI18nMap } from '@/lib/markstreamI18n';
import { closeStartupWindow, formatStartupError, presentStartupWindow, writeStartupDiagnostic } from '@/lib/startupDiagnostics';
import './i18n';

const { Sider, Content } = Layout;
const { useToken } = theme;
const ConversationPopoutInner = lazy(async () => {
  const module = await import('@/components/chat/ConversationPopoutInner');
  return { default: module.ConversationPopoutInner };
});

export function runQuitFlow(
  confirmOnQuit: boolean,
  showConfirmation: () => void,
  quit: () => void,
) {
  if (confirmOnQuit) showConfirmation();
  else quit();
}

function AppInner() {
  const { token } = useToken();
  const { t } = useTranslation();
  const { modal } = AntdApp.useApp();
  const appRootRef = useRef<HTMLDivElement>(null);
  const activePage = useUIStore((s) => s.activePage);
  const settingsSection = useUIStore((s) => s.settingsSection);
  const renderedActivePage = useDeferredValue(activePage);
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const isInSettings = renderedActivePage === 'settings';
  const providersSettingsVisible = isInSettings && settingsSection === 'providers';
  const confirmOnQuit = useSettingsStore((s) => s.settings.confirm_on_quit ?? true);
  const windowLabel = getCurrentWindowLabel();
  const frontendKind = frontendKindForWindow(windowLabel);
  const popoutConversationId = conversationIdFromPopoutLabel(windowLabel);
  const isConversationPopout = frontendKind === 'conversation-popout';
  useKeyboardShortcuts();
  useConversationTabsCoordinator(!isConversationPopout);
  useTrayMenuActions();
  useGlobalOverlayScrollbars(appRootRef);
  useEffect(() => { void presentStartupWindow('app'); }, []);

  // Handle app close confirmation from backend
  const handleCloseRequested = useCallback(() => {
    runQuitFlow(
      confirmOnQuit,
      () => {
        modal.confirm({
          title: t('desktop.closeConfirmTitle'),
          content: t('desktop.closeConfirmContent'),
          okText: t('desktop.closeConfirmOk'),
          cancelText: t('desktop.closeConfirmCancel'),
          okButtonProps: { danger: true },
          onOk: () => invoke('force_quit'),
        });
      },
      () => { void invoke('force_quit'); },
    );
  }, [confirmOnQuit, modal, t]);

  useEffect(() => {
    if (!isTauri() || windowLabel !== 'main') return;
    const unlisten = listen('app-close-requested', handleCloseRequested);
    return () => { unlisten.then((fn) => fn()); };
  }, [handleCloseRequested, windowLabel]);

  // Sync Ant Design tokens to CSS custom properties for global usage
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--border-color', token.colorBorderSecondary);
    root.style.setProperty('--color-bg-container', token.colorBgContainer);
    root.style.setProperty('--color-bg-elevated', token.colorBgElevated);
    root.style.setProperty('--color-text', token.colorText);
    root.style.setProperty('--color-text-secondary', token.colorTextSecondary);
    root.style.setProperty('--color-primary', token.colorPrimary);
    root.style.setProperty('--color-fill-alter', token.colorFillAlter);
    // Markdown renderer (markstream-react) CSS variables
    root.style.setProperty('--table-border', token.colorBorderSecondary);
    root.style.setProperty('--hr-border-color', token.colorBorderSecondary);
    root.style.setProperty('--blockquote-border-color', token.colorBorderSecondary);
  }, [token]);

  // Global stream event listeners — persist across page navigation
  const startStreamListening = useConversationStore((s) => s.startStreamListening);
  const stopStreamListening = useConversationStore((s) => s.stopStreamListening);
  useEffect(() => {
    startStreamListening();
    return () => stopStreamListening();
  }, [startStreamListening, stopStreamListening]);

  useEffect(() => setupAgentEventListeners(), []);

  // Auto-check for updates on startup and periodically (gated by auto_check_update)
  const { checkForUpdate } = useUpdateChecker();
  const autoCheckUpdate = useSettingsStore((s) => s.settings.auto_check_update ?? true);
  const updateCheckInterval = useSettingsStore((s) => s.settings.update_check_interval ?? 60);
  const updateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isTauri() || !autoCheckUpdate) return;
    // Initial check after 3s delay
    const timer = setTimeout(() => checkForUpdate({ silent: true }), 3000);
    return () => clearTimeout(timer);
  }, [autoCheckUpdate, checkForUpdate]);

  useEffect(() => {
    if (!isTauri() || !autoCheckUpdate || !updateCheckInterval) return;
    if (updateIntervalRef.current) clearInterval(updateIntervalRef.current);
    const intervalMs = Math.max(updateCheckInterval, 1) * 60 * 1000;
    updateIntervalRef.current = setInterval(() => checkForUpdate({ silent: true }), intervalMs);
    return () => {
      if (updateIntervalRef.current) clearInterval(updateIntervalRef.current);
    };
  }, [autoCheckUpdate, updateCheckInterval, checkForUpdate]);

  return (
    <div
      ref={appRootRef}
      className="flex flex-col h-screen"
      style={{ backgroundColor: token.colorBgContainer }}
    >
      <TitleBar variant={isConversationPopout ? 'popout' : 'main'} />
      <ProviderDeepLinkDialog providersSettingsVisible={providersSettingsVisible} />
      {!isConversationPopout && (
        <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
      )}
      <GlobalCopyMenu />
      {!isConversationPopout && <CrashRecoveryModal />}
      {isConversationPopout ? (
        <ChatChromeContext.Provider value={{ kind: 'popout' }}>
          <div className="flex-1 overflow-hidden min-h-0">
            {popoutConversationId ? (
              <Suspense fallback={null}>
                <ConversationPopoutInner conversationId={popoutConversationId} />
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center">
                {t('chat.multiModel.popoutMissingConversation')}
              </div>
            )}
          </div>
        </ChatChromeContext.Provider>
      ) : (
      <Layout className="flex-1 overflow-hidden" style={{ backgroundColor: 'transparent' }}>
        {!isInSettings && (
          <Sider
            width={48}
            style={{
              backgroundColor: 'transparent',
              borderRight: '1px solid var(--border-color)',
            }}
          >
            <Sidebar />
          </Sider>
        )}
        <Content className="overflow-hidden">
          <ContentArea activePage={renderedActivePage} />
        </Content>
      </Layout>
      )}
    </div>
  );
}

function StartupScreen({ failed, error }: { failed: boolean; error: string | null }) {
  const { t } = useTranslation();
  const { token } = useToken();
  useEffect(() => {
    if (failed) void presentStartupWindow('error');
  }, [failed]);
  return (
    <div className="flex h-screen flex-col" style={{ background: token.colorBgContainer, color: token.colorText }}>
      <div data-tauri-drag-region className="flex h-9 shrink-0 items-center justify-end px-3">
        <button type="button" onClick={() => { void closeStartupWindow(); }}>{t('common.close')}</button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8" role={failed ? 'alert' : 'status'}>
        <p>{t(failed ? 'startup.settingsFailed' : 'startup.loading')}</p>
        {failed && <>
          <p>{t('startup.logInstructions')}</p>
          <pre className="max-w-full whitespace-pre-wrap break-words">{error}</pre>
        </>}
      </div>
    </div>
  );
}

function AppRoot() {
  const { i18n } = useTranslation();
  const settingsStatus = useSettingsStore((s) => s.settingsMeta.status);
  const settingsError = useSettingsStore((s) => s.error);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    if (settingsStatus === 'ready') setSettingsLoaded(true);
  }, [settingsStatus]);
  useEffect(() => {
    if (!isTauri() || getCurrentWindowLabel() !== 'main' || settingsLoaded || settingsStatus === 'ready') return;
    const unlisten = listen('app-close-requested', () => {
      void invoke('force_quit').catch((error) => {
        void writeStartupDiagnostic('error', `frontend startup close failed: ${formatStartupError(error)}`);
      });
    });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, [settingsLoaded, settingsStatus]);
  const themeMode = useSettingsStore((s) => s.settings.theme_mode);
  const primaryColor = useSettingsStore((s) => s.settings.primary_color);
  const fontSize = useSettingsStore((s) => s.settings.font_size);
  const fontWeight = useSettingsStore((s) => s.settings.font_weight);
  const fontFamily = useSettingsStore((s) => s.settings.font_family);
  const fontStyle = useSettingsStore((s) => s.settings.font_style);
  const codeFontFamily = useSettingsStore((s) => s.settings.code_font_family);
  const chatFontSize = useSettingsStore((s) => s.settings.chat_font_size);
  const chatLineHeight = useSettingsStore((s) => s.settings.chat_line_height);
  const chatFontFamily = useSettingsStore((s) => s.settings.chat_font_family);
  const chatFontWeight = useSettingsStore((s) => s.settings.chat_font_weight);
  const chatFontStyle = useSettingsStore((s) => s.settings.chat_font_style);
  const interfaceFontFaces = useSystemFontFaces(fontFamily);
  const chatFontFaces = useSystemFontFaces(chatFontFamily);
  const borderRadius = useSettingsStore((s) => s.settings.border_radius);
  const language = useSettingsStore((s) => s.settings.language);
  const isDark = useResolvedDarkMode(themeMode);
  const direction = i18n.dir(i18n.language);

  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  }, [isDark]);

  useEffect(() => {
    document.documentElement.dir = direction;
  }, [direction]);

  useEffect(() => {
    enableD2(() => import('@terrastruct/d2'));
    void preloadChatRenderers();
  }, []);

  useAppStartup();
  useGlobalShortcutManager();

  // Sync i18n language with settings store
  useEffect(() => {
    if (settingsStatus === 'ready' && i18n.language !== language) {
      i18n.changeLanguage(language);
    }
  }, [i18n, language, settingsStatus]);

  useEffect(() => {
    applyMarkstreamI18nMap(i18n.getFixedT(i18n.language));
  }, [i18n, i18n.language]);

  // Sync font settings to CSS custom properties
  useEffect(() => {
    applyAppFonts({
      fontFamily,
      fontWeight,
      fontStyle,
      fontFaces: interfaceFontFaces,
      codeFontFamily,
      chatFontFamily,
      chatFontWeight,
      chatFontStyle,
      chatFontFaces,
      chatFontSize: chatFontSize ?? 15,
      chatLineHeight: chatLineHeight ?? 1.7,
    });
  }, [
    fontWeight,
    fontFamily,
    fontStyle,
    interfaceFontFaces,
    codeFontFamily,
    chatFontSize,
    chatLineHeight,
    chatFontFamily,
    chatFontWeight,
    chatFontStyle,
    chatFontFaces,
  ]);

  const themeConfig = useShadcnTheme(
    isDark,
    primaryColor,
    fontSize,
    borderRadius,
    fontFamily ? cssFontStack(fontFamily, DEFAULT_UI_FONT_FALLBACK) : undefined,
    codeFontFamily ? cssFontStack(codeFontFamily, DEFAULT_CODE_FONT_FALLBACK) : undefined,
  );

  return (
    <ConfigProvider
      locale={i18n.language === 'zh-CN' ? zhCN : undefined}
      direction={direction}
      theme={themeConfig}
      modal={{ centered: true, styles: { mask: { backdropFilter: 'blur(4px)' } } }}
    >
      <AntdApp>
        {settingsLoaded || settingsStatus === 'ready' ? <AppInner />
          : <StartupScreen failed={settingsStatus === 'error'} error={settingsError} />}
      </AntdApp>
    </ConfigProvider>
  );
}

export default AppRoot;
