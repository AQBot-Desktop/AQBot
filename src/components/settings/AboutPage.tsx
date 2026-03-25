import { Button, Card, Divider, Typography, message, App, Progress } from 'antd';
import { Github, RefreshCw, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isTauri, invoke } from '@/lib/invoke';
import logoUrl from '@/assets/image/logo.png';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import { useSettingsStore } from '@/stores';

const NodeRenderer = lazy(() => import('markstream-react'));

const { Text } = Typography;

export function AboutPage() {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const themeMode = useSettingsStore((s) => s.settings.theme_mode);
  const isDarkMode = useResolvedDarkMode(themeMode);
  const [checking, setChecking] = useState(false);
  const [appVersion, setAppVersion] = useState('...');

  useEffect(() => {
    if (isTauri()) {
      import('@tauri-apps/api/app').then(({ getVersion }) => {
        getVersion().then(v => setAppVersion(v));
      });
    }
  }, []);

  const handleCheckUpdate = async () => {
    setChecking(true);
    try {
      const update = await check();
      if (update) {
        modal.confirm({
          title: t('settings.updateAvailable'),
          content: (
            <div>
              <p>{t('settings.newVersion')}: {update.version}</p>
              {update.body && (
                <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 8 }}>
                  <Suspense fallback={<div style={{ whiteSpace: 'pre-wrap', fontSize: 13, opacity: 0.85 }}>{update.body}</div>}>
                    <NodeRenderer content={update.body} isDark={isDarkMode} final />
                  </Suspense>
                </div>
              )}
            </div>
          ),
          okText: t('settings.updateNow'),
          cancelText: t('settings.updateLater'),
          onOk: async () => {
            let cancelled = false;
            const handleCancel = async () => {
              cancelled = true;
              try { await update.close(); } catch { /* ignore */ }
            };
            const renderContent = (percent: number, status: 'active' | 'success') => (
              <div>
                <Progress percent={percent} status={status} />
                {status !== 'success' && (
                  <div style={{ textAlign: 'right', marginTop: 12 }}>
                    <Button onClick={handleCancel}>{t('settings.cancelUpdate')}</Button>
                  </div>
                )}
              </div>
            );
            const progressModal = modal.info({
              title: t('settings.updating', '正在更新...'),
              content: renderContent(0, 'active'),
              closable: false,
              footer: null,
              maskClosable: false,
              keyboard: false,
            });
            try {
              let totalSize = 0;
              let downloaded = 0;
              await update.downloadAndInstall((event) => {
                if (event.event === 'Started' && event.data.contentLength) {
                  totalSize = event.data.contentLength;
                } else if (event.event === 'Progress') {
                  downloaded += event.data.chunkLength;
                  if (totalSize > 0) {
                    progressModal.update({
                      content: renderContent(Math.round((downloaded / totalSize) * 100), 'active'),
                    });
                  }
                } else if (event.event === 'Finished') {
                  progressModal.update({
                    content: renderContent(100, 'success'),
                  });
                }
              });
              await relaunch();
            } catch (e) {
              progressModal.destroy();
              if (!cancelled) {
                message.error(String(e));
              }
            }
          },
        });
      } else {
        message.success(t('settings.noUpdate'));
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes('Could not fetch') || msg.includes('release JSON') || msg.includes('404')) {
        message.warning(t('settings.noUpdate'));
      } else {
        message.error(t('settings.checkUpdateFailed'));
      }
    } finally {
      setChecking(false);
    }
  };

  const rowStyle = { padding: '4px 0' };

  const handleOpenDevTools = useCallback(async () => {
    if (isTauri()) {
      try {
        await invoke('open_devtools');
      } catch (e) {
        message.error(String(e));
      }
    }
  }, []);

  return (
    <div className="p-6 pb-12">
      {/* Logo + App Name (macOS-style) */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '32px 0 24px',
      }}>
        <img
          src={logoUrl}
          alt="AQBot"
          style={{ width: 96, height: 96, borderRadius: 20, marginBottom: 16 }}
          draggable={false}
        />
        <div style={{ fontSize: 22, fontWeight: 600 }}>AQBot</div>
        <Text type="secondary" style={{ marginTop: 4 }}>
          {t('settings.version')} {appVersion}
        </Text>
      </div>

      <Card size="small" title={t('settings.groupAppInfo')} style={{ marginBottom: 16 }}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.version')}</span>
          <Text type="secondary">{appVersion}</Text>
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.openSource')}</span>
          <Text type="secondary">AGPL-3.0</Text>
        </div>
      </Card>
      <Card size="small" title={t('settings.groupLinks')}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>GitHub</span>
          <Button
            icon={<Github size={16} />}
            href="https://github.com/AQBot-Desktop/AQBot"
            target="_blank"
            type="link"
          >
            {t('settings.github')}
          </Button>
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.checkUpdate')}</span>
          <Button
            icon={<RefreshCw size={16} className={checking ? 'animate-spin' : ''} />}
            onClick={handleCheckUpdate}
            loading={checking}
          >
            {t('settings.checkUpdate')}
          </Button>
        </div>
        {isTauri() && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <div style={rowStyle} className="flex items-center justify-between">
              <span>{t('settings.developerTools')}</span>
              <Button
                icon={<Terminal size={16} />}
                onClick={handleOpenDevTools}
              >
                {t('settings.openDevTools')}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
