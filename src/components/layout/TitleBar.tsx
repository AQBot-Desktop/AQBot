import { useCallback, useRef, useEffect, useState } from 'react';
import { Dropdown, Tooltip, App, theme, Popover, Divider, Typography, Space, Spin } from 'antd';
import type { MenuProps } from 'antd';
import { Settings, XCircle, Sun, Moon, Monitor, Globe, Pin, PinOff, RotateCcw, CloudUpload, Github, Star, MessageSquarePlus, Bug, ArrowDownCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore, useSettingsStore } from '@/stores';
import { useBackupStore } from '@/stores/backupStore';
import { isTauri, invoke } from '@/lib/invoke';
import { getShortcutBinding, formatShortcutForDisplay } from '@/lib/shortcuts';
import { useUpdateChecker } from '@/hooks/useUpdateChecker';

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
  const { modal, message } = App.useApp();
  const activePage = useUIStore((s) => s.activePage);
  const enterSettings = useUIStore((s) => s.enterSettings);
  const exitSettings = useUIStore((s) => s.exitSettings);
  const themeMode = useSettingsStore((s) => s.settings.theme_mode);
  const alwaysOnTop = useSettingsStore((s) => s.settings.always_on_top);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const settings = useSettingsStore((s) => s.settings);

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

  const { checkForUpdate } = useUpdateChecker();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const handleCheckUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    try {
      await checkForUpdate();
    } finally {
      setCheckingUpdate(false);
    }
  }, [checkForUpdate]);

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

  // Quick Backup state
  const [backupPopoverOpen, setBackupPopoverOpen] = useState(false);
  const [backingUp, setBackingUp] = useState<'local' | 'webdav' | null>(null);
  const [lastLocalBackup, setLastLocalBackup] = useState<string | null>(null);
  const [lastWebDavSync, setLastWebDavSync] = useState<string | null>(null);
  // Timestamps (ms) for next scheduled backups
  const [nextLocalTs, setNextLocalTs] = useState<number | null>(null);
  const [nextWebDavTs, setNextWebDavTs] = useState<number | null>(null);
  // Live countdown strings (updated every second)
  const [countdownText, setCountdownText] = useState<string | null>(null);
  const [popoverLocalCountdown, setPopoverLocalCountdown] = useState<string | null>(null);
  const [popoverWebDavCountdown, setPopoverWebDavCountdown] = useState<string | null>(null);

  const { backupSettings, loadBackupSettings } = useBackupStore();

  const fmtCountdown = (ms: number) => {
    if (ms <= 0) return t('titlebar.now', '即将执行');
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Fetch backup info on mount and when popover opens
  useEffect(() => {
    loadBackupSettings();

    invoke<{ lastSyncTime: string | null }>('get_webdav_sync_status')
      .then((s) => {
        if (s.lastSyncTime) {
          const d = new Date(s.lastSyncTime);
          if (!Number.isNaN(d.getTime())) {
            setLastWebDavSync(d.toLocaleString());
          }
        }
      })
      .catch(() => {});

    invoke<Array<{ createdAt: string }>>('list_backups')
      .then((list) => {
        if (list.length > 0) {
          const raw = list[0].createdAt;
          const d = new Date(raw.includes('T') || raw.includes('Z') ? raw : raw + 'Z');
          if (!Number.isNaN(d.getTime())) setLastLocalBackup(d.toLocaleString());
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupPopoverOpen]);

  // Calculate next WebDAV sync timestamp (re-run when settings or lastWebDavSync change)
  useEffect(() => {
    if (!lastWebDavSync) {
      setNextWebDavTs(null);
      return;
    }
    const d = new Date(lastWebDavSync);
    if (Number.isNaN(d.getTime())) return;
    const interval = settings.webdav_sync_interval_minutes ?? 60;
    if (settings.webdav_sync_enabled && interval > 0) {
      setNextWebDavTs(d.getTime() + interval * 60000);
    } else {
      setNextWebDavTs(null);
    }
  }, [settings.webdav_sync_enabled, settings.webdav_sync_interval_minutes, lastWebDavSync]);

  // Calculate next local backup timestamp from backup settings
  useEffect(() => {
    if (!backupSettings?.enabled) {
      setNextLocalTs(null);
      return;
    }
    const intervalMs = (backupSettings.intervalHours ?? 24) * 3600000;
    if (lastLocalBackup) {
      const lastTime = new Date(lastLocalBackup).getTime();
      if (!Number.isNaN(lastTime)) {
        setNextLocalTs(lastTime + intervalMs);
        return;
      }
    }
    // No previous backup — next backup at now + interval
    setNextLocalTs(Date.now() + intervalMs);
  }, [backupSettings, lastLocalBackup]);

  // Live countdown on button — tick every second while any backup is scheduled
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      let soonest: number | null = null;
      if (nextLocalTs) {
        if (!soonest || nextLocalTs < soonest) soonest = nextLocalTs;
      }
      if (nextWebDavTs && nextWebDavTs - now > 0) {
        if (!soonest || nextWebDavTs < soonest) soonest = nextWebDavTs;
      }
      if (soonest) {
        setCountdownText(fmtCountdown(soonest - now));
      } else {
        setCountdownText(null);
      }
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextLocalTs, nextWebDavTs]);

  // Live countdown in popover — tick every second only when open
  useEffect(() => {
    if (!backupPopoverOpen) return;
    const tick = () => {
      const now = Date.now();
      if (nextLocalTs && nextLocalTs > now) {
        setPopoverLocalCountdown(`${new Date(nextLocalTs).toLocaleString()} (${fmtCountdown(nextLocalTs - now)})`);
      } else {
        setPopoverLocalCountdown(null);
      }
      if (nextWebDavTs && nextWebDavTs > now) {
        setPopoverWebDavCountdown(`${new Date(nextWebDavTs).toLocaleString()} (${fmtCountdown(nextWebDavTs - now)})`);
      } else {
        setPopoverWebDavCountdown(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [backupPopoverOpen, nextLocalTs, nextWebDavTs]);

  const handleQuickBackup = useCallback(async (type: 'local' | 'webdav') => {
    setBackingUp(type);
    try {
      if (type === 'local') {
        await invoke('create_backup', { format: 'sqlite' });
      } else {
        await invoke('webdav_backup');
      }
      message.success(t('backup.backupSuccess', '备份成功'));
      setBackupPopoverOpen(false);
    } catch (e) {
      message.error(String(e));
    } finally {
      setBackingUp(null);
    }
  }, [message, t]);

  const GITHUB_REPO = 'https://github.com/AQBot-Desktop/AQBot';
  const githubMenuItems: MenuProps['items'] = [
    {
      key: 'feature',
      icon: <MessageSquarePlus size={14} />,
      label: t('titlebar.submitFeature', '提交建议'),
    },
    {
      key: 'bug',
      icon: <Bug size={14} />,
      label: t('titlebar.submitBug', '提交 BUG'),
    },
    { type: 'divider' },
    {
      key: 'star',
      icon: <Star size={14} />,
      label: t('titlebar.giveStar', '给个 Star ⭐'),
    },
  ];
  const handleGithubClick: MenuProps['onClick'] = ({ key }) => {
    let url = GITHUB_REPO;
    if (key === 'feature') url = `${GITHUB_REPO}/issues/new?labels=enhancement&template=feature_request.yml`;
    else if (key === 'bug') url = `${GITHUB_REPO}/issues/new?labels=bug&template=bug_report.yml`;
    if (isTauri()) {
      import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url)).catch(() => window.open(url, '_blank'));
    } else {
      window.open(url, '_blank');
    }
  };

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

        {/* Quick Backup */}
        <Popover
          open={backupPopoverOpen}
          onOpenChange={setBackupPopoverOpen}
          trigger="click"
          placement="bottomRight"
          destroyTooltipOnHide
          content={
            <div style={{ width: 240 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                {t('titlebar.lastBackup', '上次备份')}
              </Typography.Text>
              <Space direction="vertical" size={2} style={{ width: '100%', marginTop: 4 }}>
                {lastLocalBackup && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('titlebar.lastLocal', '本地')}: {lastLocalBackup}
                  </Typography.Text>
                )}
                {lastWebDavSync && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    WebDAV: {lastWebDavSync}
                  </Typography.Text>
                )}
                {!lastLocalBackup && !lastWebDavSync && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('titlebar.noBackupYet', '暂无备份记录')}
                  </Typography.Text>
                )}
              </Space>

              {(popoverLocalCountdown || popoverWebDavCountdown) && (
                <>
                  <Divider style={{ margin: '6px 0' }} />
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {t('titlebar.nextBackup', '下次自动备份')}
                  </Typography.Text>
                  <Space direction="vertical" size={2} style={{ width: '100%', marginTop: 4 }}>
                    {popoverLocalCountdown && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('titlebar.lastLocal', '本地')}: {popoverLocalCountdown}
                      </Typography.Text>
                    )}
                    {popoverWebDavCountdown && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        WebDAV: {popoverWebDavCountdown}
                      </Typography.Text>
                    )}
                  </Space>
                </>
              )}

              <Divider style={{ margin: '6px 0' }} />
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <button
                  onClick={() => handleQuickBackup('local')}
                  disabled={backingUp !== null}
                  style={{
                    width: '100%',
                    padding: '4px 8px',
                    borderRadius: token.borderRadius,
                    border: `1px solid ${token.colorBorder}`,
                    backgroundColor: 'transparent',
                    cursor: backingUp ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    color: token.colorText,
                  }}
                >
                  {backingUp === 'local' ? <Spin size="small" /> : <CloudUpload size={14} />}
                  {t('titlebar.localBackup', '本地备份')}
                </button>
                <button
                  onClick={() => handleQuickBackup('webdav')}
                  disabled={backingUp !== null}
                  style={{
                    width: '100%',
                    padding: '4px 8px',
                    borderRadius: token.borderRadius,
                    border: `1px solid ${token.colorBorder}`,
                    backgroundColor: 'transparent',
                    cursor: backingUp ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    color: token.colorText,
                  }}
                >
                  {backingUp === 'webdav' ? <Spin size="small" /> : <CloudUpload size={14} />}
                  {t('titlebar.webdavBackup', 'WebDAV 备份')}
                </button>
              </Space>
            </div>
          }
        >
          <Tooltip title={t('titlebar.quickBackup', '快速备份')}>
            <button
              style={{
                ...buttonBase,
                color: countdownText ? token.colorPrimary : token.colorTextSecondary,
                width: countdownText ? 'auto' : 28,
                paddingInline: countdownText ? 4 : 0,
                gap: 2,
                fontSize: 11,
              }}
              {...hoverHandlers(countdownText ? token.colorPrimary : token.colorTextSecondary)}
            >
              <CloudUpload size={14} />
              {countdownText && <span>({countdownText})</span>}
            </button>
          </Tooltip>
        </Popover>

        {/* GitHub */}
        <Dropdown
          menu={{ items: githubMenuItems, onClick: handleGithubClick }}
          trigger={['click']}
          placement="bottomRight"
          destroyOnHidden
        >
          <button
            style={{ ...buttonBase, color: token.colorTextSecondary }}
            {...hoverHandlers(token.colorTextSecondary)}
          >
            <Github size={14} />
          </button>
        </Dropdown>

        {/* Check Update */}
        {isTauri() && (
          <Tooltip title={t('settings.checkUpdate', '检查更新')}>
            <button
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              style={{ ...buttonBase, color: token.colorTextSecondary, opacity: checkingUpdate ? 0.5 : 1 }}
              {...hoverHandlers(token.colorTextSecondary)}
            >
              {checkingUpdate ? <Spin size="small" /> : <ArrowDownCircle size={14} />}
            </button>
          </Tooltip>
        )}

        {/* Reload Page */}
        <Tooltip title={t('desktop.reloadPage')}>
          <button
            onClick={handleReload}
            style={{ ...buttonBase, color: token.colorTextSecondary }}
            {...hoverHandlers(token.colorTextSecondary)}
          >
            <RotateCcw size={14} />
          </button>
        </Tooltip>

        {/* Settings Toggle */}
        <Tooltip title={`${isInSettings ? t('settings.closeSettings', '关闭设置') : t('settings.openSettings', '设置')} (${formatShortcutForDisplay(getShortcutBinding(settings, 'openSettings'))})`}>
        <button
          onClick={(e) => {
            handleSettingsToggle();
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.blur();
          }}
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
        </Tooltip>
      </div>
    </div>
  );
}
