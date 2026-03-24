import { useEffect } from 'react';
import { ConfigProvider, App as AntdApp, Layout, theme, Modal } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useTranslation } from 'react-i18next';
import { Sidebar } from '@/components/layout/Sidebar';
import { TitleBar } from '@/components/layout/TitleBar';
import { ContentArea } from '@/components/layout/ContentArea';
import CommandPalette from '@/components/layout/CommandPalette';
import { useCommandPalette } from '@/hooks/useCommandPalette';
import { useUIStore, useSettingsStore } from '@/stores';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useGlobalShortcutManager } from '@/hooks/useGlobalShortcutManager';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import { useShadcnTheme } from '@/theme/shadcnTheme';
import { isTauri } from '@/lib/invoke';
import { preloadChatRenderers } from '@/lib/preloadChatRenderers';
import { enableD2, setDefaultI18nMap } from 'markstream-react';
import './i18n';

const { Sider, Content } = Layout;
const { useToken } = theme;

function AppInner() {
  const { token } = useToken();
  const { t } = useTranslation();
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

  // Auto-check for updates on startup (delayed to let app initialize first)
  useEffect(() => {
    if (!isTauri()) return;
    const timer = setTimeout(async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (!update) return;
        Modal.confirm({
          title: t('settings.updateAvailable'),
          content: `${t('settings.newVersion')}: ${update.version}`,
          okText: t('settings.updateNow'),
          cancelText: t('settings.updateLater'),
          onOk: async () => {
            try {
              await update.downloadAndInstall();
              const { relaunch } = await import('@tauri-apps/plugin-process');
              await relaunch();
            } catch (e) {
              console.error('Update install failed:', e);
            }
          },
        });
      } catch (e) {
        console.warn('Auto update check failed:', e);
      }
    }, 3000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-screen" style={{ backgroundColor: token.colorBgContainer }}>
      <TitleBar />
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
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

  // Load persisted settings from backend on startup, then apply native settings
  useEffect(() => {
    const init = async () => {
      await useSettingsStore.getState().fetchSettings();

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

  const themeConfig = useShadcnTheme(isDark, primaryColor, fontSize, borderRadius);

  return (
    <ConfigProvider
      locale={i18n.language === 'zh-CN' ? zhCN : undefined}
      theme={themeConfig}
    >
      <AntdApp>
        <AppInner />
      </AntdApp>
    </ConfigProvider>
  );
}

export default AppRoot;
