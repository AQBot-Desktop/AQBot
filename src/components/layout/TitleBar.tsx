import { useCallback, useRef, useEffect, useState } from 'react';
import { Dropdown, Tooltip, App, theme } from 'antd';
import type { MenuProps } from 'antd';
import { Settings, XCircle, Sun, Moon, Monitor, Globe, Pin, PinOff, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore, useSettingsStore } from '@/stores';
import { isTauri, invoke } from '@/lib/invoke';

const THEME_OPTIONS = [
  { key: 'system', icon: <Monitor size={14} />, labelKey: 'settings.themeSystem' },
  { key: 'light', icon: <Sun size={14} />, labelKey: 'settings.themeLight' },
  { key: 'dark', icon: <Moon size={14} />, labelKey: 'settings.themeDark' },
] as const;

const THEME_ICONS: Record<string, React.ReactNode> = {
  system: <Monitor size={14} />,
  light: <Sun size={14} />,
  dark: <Moon size={14} />,
};

const LANG_OPTIONS = [
  { key: 'zh-CN', label: '中文', icon: '🇨🇳' },
  { key: 'en-US', label: 'English', icon: '🇺🇸' },
] as const;

export function TitleBar() {
  const { t, i18n } = useTranslation();
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const activePage = useUIStore((s) => s.activePage);
  const enterSettings = useUIStore((s) => s.enterSettings);
  const exitSettings = useUIStore((s) => s.exitSettings);
  const themeMode = useSettingsStore((s) => s.settings.theme_mode);
  const alwaysOnTop = useSettingsStore((s) => s.settings.always_on_top);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const isInSettings = activePage === 'settings';
  const [pinned, setPinned] = useState(alwaysOnTop ?? false);

  useEffect(() => {
    setPinned(alwaysOnTop ?? false);
  }, [alwaysOnTop]);

  const handlePinToggle = useCallback(async () => {
    const next = !pinned;
    setPinned(next);
    try {
      await invoke('set_always_on_top', { enabled: next });
      saveSettings({ always_on_top: next });
    } catch {
      setPinned(!next);
    }
  }, [pinned, saveSettings]);

  const themeMenuItems: MenuProps['items'] = THEME_OPTIONS.map((opt) => ({
    key: opt.key,
    icon: opt.icon,
    label: t(opt.labelKey),
  }));

  const langMenuItems: MenuProps['items'] = LANG_OPTIONS.map((opt) => ({
    key: opt.key,
    icon: <span>{opt.icon}</span>,
    label: opt.label,
  }));

  const handleThemeChange: MenuProps['onClick'] = ({ key }) => {
    saveSettings({ theme_mode: key });
  };

  const handleLangChange: MenuProps['onClick'] = ({ key }) => {
    i18n.changeLanguage(key);
    saveSettings({ language: key });
  };

  const handleSettingsToggle = () => {
    if (isInSettings) {
      exitSettings();
    } else {
      enterSettings();
    }
  };

  const handleReload = useCallback(() => {
    modal.confirm({
      title: t('desktop.reloadConfirmTitle'),
      content: t('desktop.reloadConfirmContent'),
      okText: t('desktop.reloadConfirmOk'),
      cancelText: t('desktop.reloadConfirmCancel'),
      onOk: () => {
        window.location.reload();
      },
    });
  }, [modal, t]);

  // Pre-load Tauri window module for synchronous drag calls
  const tauriWindowRef = useRef<typeof import('@tauri-apps/api/window') | null>(null);
  useEffect(() => {
    if (isTauri()) {
      import('@tauri-apps/api/window').then((mod) => {
        tauriWindowRef.current = mod;
      });
    }
  }, []);

  const handleDragMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    const mod = tauriWindowRef.current;
    if (!mod) return;

    e.preventDefault();
    mod.getCurrentWindow().startDragging();
  }, []);

  const buttonBase: React.CSSProperties = {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: token.borderRadius,
    fontSize: 14,
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
  };

  const hoverHandlers = (baseColor: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.backgroundColor = token.colorFillSecondary;
      e.currentTarget.style.color = token.colorTextBase;
    },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.backgroundColor = 'transparent';
      e.currentTarget.style.color = baseColor;
    },
  });

  return (
    <div
      className="title-bar-drag"
      data-tauri-drag-region
      onMouseDown={handleDragMouseDown}
      style={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingLeft: 72,
        paddingRight: 12,
        backgroundColor: 'transparent',
        flexShrink: 0,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div className="title-bar-nodrag" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {/* Pin Toggle */}
        <Tooltip title={t('desktop.alwaysOnTop')}>
          <button
            onClick={handlePinToggle}
            style={{
              ...buttonBase,
              color: pinned ? token.colorPrimary : token.colorTextSecondary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = pinned
                ? token.colorPrimaryBg
                : token.colorFillSecondary;
              e.currentTarget.style.color = pinned
                ? token.colorPrimary
                : token.colorTextBase;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = pinned
                ? token.colorPrimary
                : token.colorTextSecondary;
            }}
          >
            {pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
        </Tooltip>

        {/* Theme Dropdown */}
        <Dropdown
          menu={{ items: themeMenuItems, onClick: handleThemeChange, selectedKeys: [themeMode] }}
          trigger={['click']}
          placement="bottomRight"
          destroyOnHidden
        >
          <button
            style={{ ...buttonBase, color: token.colorTextSecondary }}
            {...hoverHandlers(token.colorTextSecondary)}
          >
            {THEME_ICONS[themeMode] ?? <Monitor size={14} />}
          </button>
        </Dropdown>

        {/* Language Dropdown */}
        <Dropdown
          menu={{ items: langMenuItems, onClick: handleLangChange, selectedKeys: [i18n.language] }}
          trigger={['click']}
          placement="bottomRight"
          destroyOnHidden
        >
          <button
            style={{ ...buttonBase, color: token.colorTextSecondary }}
            {...hoverHandlers(token.colorTextSecondary)}
          >
            <Globe size={14} />
          </button>
        </Dropdown>

        {/* Reload Page */}
        <Tooltip title={t('desktop.reloadPage')}>
          <button
            onClick={handleReload}
            style={{ ...buttonBase, color: token.colorTextSecondary }}
            {...hoverHandlers(token.colorTextSecondary)}
          >
            <RefreshCw size={14} />
          </button>
        </Tooltip>

        {/* Settings Toggle */}
        <button
          onClick={handleSettingsToggle}
          style={{
            ...buttonBase,
            color: isInSettings ? token.colorError : token.colorTextSecondary,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = isInSettings
              ? token.colorErrorBg
              : token.colorFillSecondary;
            e.currentTarget.style.color = isInSettings
              ? token.colorError
              : token.colorTextBase;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = isInSettings
              ? token.colorError
              : token.colorTextSecondary;
          }}
        >
          {isInSettings ? <XCircle size={14} /> : <Settings size={14} />}
        </button>
      </div>
    </div>
  );
}
