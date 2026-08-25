import { Button, Modal, Progress, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import { useEmbeddingArtifact } from '@/lib/useEmbeddingArtifact';
import { SettingsGroup } from './SettingsGroup';

const STATUS_LABEL_KEYS = {
  missing: 'settings.localRetrieval.status.missing',
  downloading: 'settings.localRetrieval.status.downloading',
  installed: 'settings.localRetrieval.status.installed',
  corrupted: 'settings.localRetrieval.status.corrupted',
  failed: 'settings.localRetrieval.status.failed',
} as const;

function statusLabelKey(status: string): string {
  return STATUS_LABEL_KEYS[status as keyof typeof STATUS_LABEL_KEYS]
    ?? STATUS_LABEL_KEYS.missing;
}

export function LocalRetrievalEngineCard() {
  const { t } = useTranslation();
  const { status, currentStatus, downloaded, total, refresh } = useEmbeddingArtifact();
  const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;

  const handleUninstall = () => {
    Modal.confirm({
      title: t('settings.localRetrieval.uninstallConfirm'),
      okButtonProps: { danger: true },
      okText: t('settings.localRetrieval.uninstall'),
      onOk: async () => {
        await invoke('uninstall_embedding_artifact');
        await refresh();
      },
    });
  };

  return (
    <SettingsGroup title={t('settings.localRetrieval.title')}>
      <div className="flex flex-col gap-2" style={{ padding: '8px 0' }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div>{t('settings.localRetrieval.builtinModelId')}</div>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              {t(statusLabelKey(currentStatus))}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              {t('settings.localRetrieval.meta', {
                license: status?.license ?? 'MIT',
                sizeMb: Math.round((status?.sizeBytes ?? 118_054_593) / 1024 / 1024),
                path: status?.path ?? '~/.aqbot/models/embeddings/',
              })}
            </Typography.Paragraph>
          </div>
          <div className="shrink-0">
            {currentStatus === 'downloading' ? (
              <Button onClick={() => void invoke('cancel_embedding_artifact_install')}>
                {t('settings.localRetrieval.cancel')}
              </Button>
            ) : currentStatus === 'installed' ? (
              <Button danger onClick={handleUninstall}>
                {t('settings.localRetrieval.uninstall')}
              </Button>
            ) : (
              <Button
                type="primary"
                onClick={() => void invoke('install_embedding_artifact').then(() => refresh())}
              >
                {t('settings.localRetrieval.install')}
              </Button>
            )}
          </div>
        </div>
        {currentStatus === 'downloading' ? (
          <Progress percent={percent} size="small" />
        ) : null}
      </div>
    </SettingsGroup>
  );
}
