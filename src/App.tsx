import { lazy, Suspense, useEffect, useRef, useCallback, useDeferredValue } from 'react';
import { ConfigProvider, App as AntdApp, Layout, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useTranslation } from 'react-i18next';
import { Sidebar } from '@/components/layout/Sidebar';
import { TitleBar } from '@/components/layout/TitleBar';
import { ContentArea } from '@/components/layout/ContentArea';
import { ChatChromeContext } from '@/lib/chatChrome';
import { notifyConversationPopoutReady } from '@/lib/conversationPopout';
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
import { useAcpStore } from '@/stores/acpStore';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useConversationTabsCoordinator } from '@/hooks/useConversationTabsCoordinator';
import { useGlobalShortcutManager } from '@/hooks/useGlobalShortcutManager';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import { useGlobalOverlayScrollbars } from '@/hooks/useGlobalOverlayScrollbars';
import { useUpdateChecker } from '@/hooks/useUpdateChecker';
import { useTrayMenuActions } from '@/hooks/useTrayMenuActions';
import { useProviderDeepLink } from '@/hooks/useProviderDeepLink';
import { useShadcnTheme } from '@/theme/shadcnTheme';
import { isTauri, invoke, listen } from '@/lib/invoke';
import { preloadChatRenderers } from '@/lib/preloadChatRenderers';
import { setupAgentEventListeners } from '@/stores/agentStore';
import { enableD2 } from 'markstream-react';
import { applyMarkstreamI18nMap } from '@/lib/markstreamI18n';
import './i18n';

const { Sider, Content } = Layout;
const { useToken } = theme;
const DEFAULT_CHAT_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const ConversationPopoutInner = lazy(async () => {
  const module = await import('@/components/chat/ConversationPopoutInner');
  return { default: module.ConversationPopoutInner };
});

/** Show the main window (it starts hidden to avoid white flash). */
async function showWindow() {
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const window = getCurrentWebviewWindow();
    await window.show();
    await window.setFocus();
  } catch (e) {
    console.warn('Failed to show window:', e);
  }
}

function AppInner() {
  const { token } = useToken();
  const { t } = useTranslation();
  const { modal, message } = AntdApp.useApp();
  const appRootRef = useRef<HTMLDivElement>(null);
  const activePage = useUIStore((s) => s.activePage);
  const renderedActivePage = useDeferredValue(activePage);
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const isInSettings = renderedActivePage === 'settings';
  const windowLabel = getCurrentWindowLabel();
  const frontendKind = frontendKindForWindow(windowLabel);
  const popoutConversationId = conversationIdFromPopoutLabel(windowLabel);
  const isConversationPopout = frontendKind === 'conversation-popout';
  useConversationTabsCoordinator(!isConversationPopout);
  useProviderDeepLink({ modal, message });
  useTrayMenuActions();
  useGlobalOverlayScrollbars(appRootRef);

  // Handle app close confirmation from backend
  const handleCloseRequested = useCallback(() => {
    modal.confirm({
      title: t('desktop.closeConfirmTitle'),
      content: t('desktop.closeConfirmContent'),
      okText: t('desktop.closeConfirmOk'),
      cancelText: t('desktop.closeConfirmCancel'),
      okButtonProps: { danger: true },
      onOk: () => invoke('force_quit'),
    });
  }, [modal, t]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen('app-close-requested', handleCloseRequested);
    return () => { unlisten.then((fn) => fn()); };
  }, [handleCloseRequested]);

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

function AppRoot() {
  const { i18n } = useTranslation();
  const themeMode = useSettingsStore((s) => s.settings.theme_mode);
  const primaryColor = useSettingsStore((s) => s.settings.primary_color);
  const fontSize = useSettingsStore((s) => s.settings.font_size);
  const fontWeight = useSettingsStore((s) => s.settings.font_weight);
  const fontFamily = useSettingsStore((s) => s.settings.font_family);
  const codeFontFamily = useSettingsStore((s) => s.settings.code_font_family);
  const chatFontSize = useSettingsStore((s) => s.settings.chat_font_size);
  const chatLineHeight = useSettingsStore((s) => s.settings.chat_line_height);
  const chatFontFamily = useSettingsStore((s) => s.settings.chat_font_family);
  const chatFontWeight = useSettingsStore((s) => s.settings.chat_font_weight);
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

  useKeyboardShortcuts();
  useGlobalShortcutManager();

  // Load persisted settings from backend on startup, then apply native settings
  useEffect(() => {
    // Start ACP bootstrap immediately. The store owns the single-flight guard,
    // so React StrictMode may re-run this effect without spawning duplicate
    // Agent processes. Do not make Agent readiness wait for unrelated settings
    // or native window initialization.
    try {
      useAcpStore.getState().warmBootstrap();
    } catch (e) {
      console.warn('Failed to warm ACP store:', e);
    }

    const init = async () => {
      const isPopout = frontendKindForWindow(getCurrentWindowLabel()) === 'conversation-popout';
      const popoutConversationId = conversationIdFromPopoutLabel(getCurrentWindowLabel());

      if (isTauri() && isPopout) {
        await showWindow();
        if (popoutConversationId) {
          try {
            await notifyConversationPopoutReady(popoutConversationId);
          } catch (error) {
            console.warn('Failed to report independent window ready:', error);
          }
        }
      }

      try {
        await useSettingsStore.getState().fetchSettings();
      } catch (e) {
        console.warn('Failed to fetch settings:', e);
      }

      if (!isTauri()) return;
      const settings = useSettingsStore.getState().settings;

      // Apply native window settings
      try {
        await invoke('apply_startup_settings', {
          alwaysOnTop: settings.always_on_top ?? false,
          closeToTray: isPopout ? false : (settings.minimize_to_tray ?? false),
          releaseWebviewOnTray: isPopout ? false : (settings.release_webview_on_tray ?? false),
        });
      } catch (e) {
        console.warn('Failed to apply native settings:', e);
      }

      if (!isPopout) {
        // Autostart
        try {
          const { enable, disable } = await import('@tauri-apps/plugin-autostart');
          if (settings.auto_start) {
            await enable();
          } else {
            await disable();
          }
        } catch (e) {
          console.warn('Failed to set autostart:', e);
        }

        // Show window after initialization (window starts hidden to avoid white flash)
        await showWindow();
      }
    };
    init();
  }, []);

  // Sync i18n language with settings store
  useEffect(() => {
    if (i18n.language !== language) {
      i18n.changeLanguage(language);
    }
  }, [i18n, language]);

  useEffect(() => {
    applyMarkstreamI18nMap(i18n.getFixedT(i18n.language));
  }, [i18n, i18n.language]);

  // Sync font settings to CSS custom properties
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--font-weight', String(fontWeight));
    if (fontFamily) {
      root.style.setProperty('--font-family', fontFamily);
      document.body.style.fontFamily = fontFamily;
    } else {
      root.style.removeProperty('--font-family');
      document.body.style.removeProperty('font-family');
    }
    if (codeFontFamily) {
      root.style.setProperty('--code-font-family', codeFontFamily);
    } else {
      root.style.removeProperty('--code-font-family');
    }
    root.style.setProperty('--chat-font-size', `${chatFontSize ?? 15}px`);
    root.style.setProperty('--chat-line-height', String(chatLineHeight ?? 1.7));
    root.style.setProperty('--chat-font-family', chatFontFamily || DEFAULT_CHAT_FONT_FAMILY);
    root.style.setProperty('--chat-font-weight', String(chatFontWeight ?? 400));
  }, [fontWeight, fontFamily, codeFontFamily, chatFontSize, chatLineHeight, chatFontFamily, chatFontWeight]);

  const themeConfig = useShadcnTheme(isDark, primaryColor, fontSize, borderRadius, fontFamily || undefined, codeFontFamily || undefined);

  return (
    <ConfigProvider
      locale={i18n.language === 'zh-CN' ? zhCN : undefined}
      direction={direction}
      theme={themeConfig}
      modal={{ centered: true, styles: { mask: { backdropFilter: 'blur(4px)' } } }}
    >
      <AntdApp>
        <AppInner />
      </AntdApp>
    </ConfigProvider>
  );
}

export default AppRoot;
