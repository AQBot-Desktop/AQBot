import { useEffect, useRef } from 'react';
import { ConfigProvider, App as AntdApp, Layout, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useTranslation } from 'react-i18next';
import { Sidebar } from '@/components/layout/Sidebar';
import { TitleBar } from '@/components/layout/TitleBar';
import { ContentArea } from '@/components/layout/ContentArea';
import CommandPalette from '@/components/layout/CommandPalette';
import { GlobalCopyMenu } from '@/components/layout/GlobalCopyMenu';
import { useCommandPalette } from '@/hooks/useCommandPalette';
import { useUIStore, useSettingsStore, useConversationStore } from '@/stores';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useGlobalShortcutManager } from '@/hooks/useGlobalShortcutManager';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import { useGlobalOverlayScrollbars } from '@/hooks/useGlobalOverlayScrollbars';
import { useUpdateChecker } from '@/hooks/useUpdateChecker';
import { useShadcnTheme } from '@/theme/shadcnTheme';
import { isTauri } from '@/lib/invoke';
import { preloadChatRenderers } from '@/lib/preloadChatRenderers';
import { enableD2, setDefaultI18nMap } from 'markstream-react';
import './i18n';

const { Sider, Content } = Layout;
const { useToken } = theme;

/** Show the main window (it starts hidden to avoid white flash). */
async function showWindow() {
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    await getCurrentWebviewWindow().show();
  } catch (e) {
    console.warn('Failed to show window:', e);
  }
}

function AppInner() {
  const { token } = useToken();
  const activePage = useUIStore((s) => s.activePage);
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const isInSettings = activePage === 'settings';

  // Sync Ant Design tokens to CSS custom properties for global usage
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--border-color', token.colorBorderSecondary);
    root.style.setProperty('--color-bg-container', token.colorBgContainer);
    root.style.setProperty('--color-bg-elevated', token.colorBgElevated);
    root.style.setProperty('--color-text', token.colorText);
    root.style.setProperty('--color-text-secondary', token.colorTextSecondary);
    root.style.setProperty('--color-primary', token.colorPrimary);
  }, [token]);

  // Global stream event listeners — persist across page navigation
  const startStreamListening = useConversationStore((s) => s.startStreamListening);
  const stopStreamListening = useConversationStore((s) => s.stopStreamListening);
  useEffect(() => {
    startStreamListening();
    return () => stopStreamListening();
  }, [startStreamListening, stopStreamListening]);

  // Auto-check for updates on startup and periodically
  const { checkForUpdate } = useUpdateChecker();
  const updateCheckInterval = useSettingsStore((s) => s.settings.update_check_interval ?? 60);
  const updateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    // Initial check after 3s delay
    const timer = setTimeout(() => checkForUpdate({ silent: true }), 3000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isTauri() || !updateCheckInterval) return;
    if (updateIntervalRef.current) clearInterval(updateIntervalRef.current);
    const intervalMs = Math.max(updateCheckInterval, 1) * 60 * 1000;
    updateIntervalRef.current = setInterval(() => checkForUpdate({ silent: true }), intervalMs);
    return () => {
      if (updateIntervalRef.current) clearInterval(updateIntervalRef.current);
    };
  }, [updateCheckInterval, checkForUpdate]);

  return (
    <div className="flex flex-col h-screen" style={{ backgroundColor: token.colorBgContainer }}>
      <TitleBar />
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
      <GlobalCopyMenu />
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
          <ContentArea activePage={activePage} />
        </Content>
      </Layout>
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
  const borderRadius = useSettingsStore((s) => s.settings.border_radius);
  const isDark = useResolvedDarkMode(themeMode);

  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  }, [isDark]);

  useEffect(() => {
    enableD2(() => import('@terrastruct/d2'));
    void preloadChatRenderers();
  }, []);

  useKeyboardShortcuts();
  useGlobalShortcutManager();
  useGlobalOverlayScrollbars();

  // Load persisted settings from backend on startup, then apply native settings
  useEffect(() => {
    const init = async () => {
      try {
        await useSettingsStore.getState().fetchSettings();
      } catch (e) {
        console.warn('Failed to fetch settings:', e);
      }

      if (!isTauri()) return;
      const settings = useSettingsStore.getState().settings;

      // Apply native window settings
      try {
        const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
        await tauriInvoke('apply_startup_settings', {
          alwaysOnTop: settings.always_on_top ?? false,
          closeToTray: settings.close_to_tray ?? true,
        });
      } catch (e) {
        console.warn('Failed to apply native settings:', e);
      }

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
    };
    init();
  }, []);

  // Sync i18n language with settings store
  useEffect(() => {
    const lang = useSettingsStore.getState().settings.language;
    if (i18n.language !== lang) {
      i18n.changeLanguage(lang);
    }
  }, [i18n]);

  useEffect(() => {
    const t = i18n.getFixedT(i18n.language);
    setDefaultI18nMap({
      'common.close': t('common.close'),
      'common.collapse': t('common.collapse'),
      'common.copied': t('common.copied'),
      'common.copy': t('common.copy'),
      'common.decrease': t('common.decrease'),
      'common.expand': t('common.expand'),
      'common.export': t('common.export'),
      'common.increase': t('common.increase'),
      'common.minimize': t('common.minimize'),
      'common.open': t('common.open'),
      'common.preview': t('common.preview'),
      'common.reset': t('common.reset'),
      'common.resetZoom': t('common.resetZoom'),
      'common.source': t('common.source'),
      'common.zoomIn': t('common.zoomIn'),
      'common.zoomOut': t('common.zoomOut'),
      'image.loadError': t('image.loadError'),
      'image.loading': t('image.loading'),
    });
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
  }, [fontWeight, fontFamily, codeFontFamily]);

  const themeConfig = useShadcnTheme(isDark, primaryColor, fontSize, borderRadius, fontFamily || undefined, codeFontFamily || undefined);

  return (
    <ConfigProvider
      locale={i18n.language === 'zh-CN' ? zhCN : undefined}
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
