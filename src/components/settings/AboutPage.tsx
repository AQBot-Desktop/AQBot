import { Button, Card, Divider, Typography, message, Modal, Progress } from 'antd';
import { Github, RefreshCw, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isTauri, invoke } from '@/lib/invoke';
import logoUrl from '@/assets/image/logo.png';

const { Text } = Typography;

export function AboutPage() {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
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
        Modal.confirm({
          title: t('settings.updateAvailable'),
          content: `${t('settings.newVersion')}: ${update.version}`,
          okText: t('settings.updateNow'),
          cancelText: t('settings.updateLater'),
          onOk: async () => {
            setUpdating(true);
            setProgress(0);
            try {
              let totalSize = 0;
              let downloaded = 0;
              await update.downloadAndInstall((event) => {
                if (event.event === 'Started' && event.data.contentLength) {
                  totalSize = event.data.contentLength;
                } else if (event.event === 'Progress') {
                  downloaded += event.data.chunkLength;
                  if (totalSize > 0) {
                    setProgress(Math.round((downloaded / totalSize) * 100));
                  }
                } else if (event.event === 'Finished') {
                  setProgress(100);
                }
              });
              await relaunch();
            } catch (e) {
              message.error(String(e));
              setUpdating(false);
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
            disabled={updating}
          >
            {t('settings.checkUpdate')}
          </Button>
        </div>
        {updating && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <div style={{ padding: '8px 0' }}>
              <Progress percent={progress} size="small" />
            </div>
          </>
        )}
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
