import { useEffect, useState } from 'react';
import { Typography, Button, Space, Spin, List, App } from 'antd';
import { FolderOpen, Image, FileText, CloudUpload, FolderEdit, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import { invalidateApplicationResources } from '@/stores/invalidateResources';
import { SettingsGroup } from './SettingsGroup';

const { Text } = Typography;

interface BucketStats {
  bucket: string;
  file_count: number;
  total_bytes: number;
}

interface StorageInventory {
  buckets: BucketStats[];
  documents_root: string;
}

interface ValidateResult {
  exists: boolean;
  is_empty: boolean;
  writable: boolean;
}

interface ChangeResult {
  files_moved: number;
  files_failed: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const BUCKET_ICONS: Record<string, React.ReactNode> = {
  images: <Image size={20} />,
  files: <FileText size={20} />,
  backups: <CloudUpload size={20} />,
};

export function StorageSpaceManager() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const [inventory, setInventory] = useState<StorageInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState(false);

  const loadInventory = async () => {
    setLoading(true);
    try {
      const data = await invoke<StorageInventory>('get_storage_inventory');
      setInventory(data);
    } catch (e) {
      console.error('Failed to load storage inventory:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInventory();
  }, []);

  const handleOpenFolder = async () => {
    try {
      await invoke('open_storage_directory');
    } catch (e) {
      message.error(String(e));
    }
  };

  const promptRestart = () => {
    modal.confirm({
      title: t('settings.storage.restartRequired'),
      okText: t('settings.storage.restartNow'),
      cancelText: t('settings.storage.restartLater'),
      onOk: async () => {
        try {
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        } catch {
          // ignore
        }
      },
    });
  };

  const handleChangeDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;

      const newPath = selected as string;

      // Validate the directory
      const validation = await invoke<ValidateResult>('validate_documents_root', { path: newPath });

      if (!validation.writable) {
        message.error(t('settings.storage.dirNotWritable'));
        return;
      }

      let migrate = false;

      if (!validation.is_empty) {
        // Target not empty — no migration allowed, just warn and confirm
        const proceed = await new Promise<boolean>((resolve) => {
          modal.confirm({
            title: t('settings.storage.changeDirTitle'),
            content: t('settings.storage.changeDirNotEmpty'),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
        if (!proceed) return;
      } else {
        // Target is empty — ask about migration
        migrate = await new Promise<boolean>((resolve) => {
          modal.confirm({
            title: t('settings.storage.migratePrompt'),
            okText: t('settings.storage.migrateYes'),
            cancelText: t('settings.storage.migrateNo'),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
      }

      setChanging(true);
      try {
        const result = await invoke<ChangeResult>('change_documents_root', {
          newPath,
          migrate,
        });

        if (migrate && result.files_moved > 0) {
          message.success(
            t('settings.storage.changeDirSuccessMigrate', { count: result.files_moved })
          );
        } else {
          message.success(t('settings.storage.changeDirSuccess'));
        }

        invalidateApplicationResources('path-change');
        await loadInventory();
        promptRestart();
      } catch (e) {
        message.error(`${t('settings.storage.changeDirFailed')}: ${e}`);
      } finally {
        setChanging(false);
      }
    } catch {
      // User cancelled the dialog
    }
  };

  const handleResetDir = async () => {
    modal.confirm({
      title: t('settings.storage.resetDirConfirm'),
      onOk: async () => {
        try {
          await invoke('reset_documents_root');
          invalidateApplicationResources('path-change');
          message.success(t('settings.storage.resetDirSuccess'));
          await loadInventory();
          promptRestart();
        } catch (e) {
          message.error(String(e));
        }
      },
    });
  };

  const totalBytes = inventory?.buckets.reduce((sum, b) => sum + b.total_bytes, 0) ?? 0;
  const totalFiles = inventory?.buckets.reduce((sum, b) => sum + b.file_count, 0) ?? 0;

  return (
    <div className="p-6 pb-12">
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin />
        </div>
      ) : inventory ? (
        <>
          <SettingsGroup
            title={t('settings.storage.title')}
            extra={
              <Button size="small" icon={<FolderOpen size={14} />} onClick={handleOpenFolder}>
                {t('settings.storage.openFolder')}
              </Button>
            }
          >
            <List
              dataSource={inventory.buckets}
              renderItem={(bucket) => (
                <List.Item>
                  <div className="flex items-center gap-3 w-full">
                    <span className="flex items-center" style={{ color: 'var(--ant-color-text-secondary)' }}>
                      {BUCKET_ICONS[bucket.bucket]}
                    </span>
                    <div className="flex-1">
                      <Text>
                        {t(`settings.storage.${bucket.bucket}`)}
                      </Text>
                    </div>
                    <Text type="secondary">
                      {bucket.file_count} {t('settings.storage.fileCount')}
                    </Text>
                    <Text style={{ minWidth: 80, textAlign: 'right' }}>
                      {formatBytes(bucket.total_bytes)}
                    </Text>
                  </div>
                </List.Item>
              )}
            />
          </SettingsGroup>

          <SettingsGroup>
            <div className="flex items-center justify-between">
              <Text>{t('settings.storage.totalUsage')}</Text>
              <Space size="large">
                <Text type="secondary">
                  {totalFiles} {t('settings.storage.fileCount')}
                </Text>
                <Text>{formatBytes(totalBytes)}</Text>
              </Space>
            </div>
          </SettingsGroup>

          {inventory.documents_root && (
            <SettingsGroup title={t('settings.storage.currentDir')}>
              <div className="flex items-center justify-between gap-4">
                <Text
                  type="secondary"
                  style={{ fontSize: 13, wordBreak: 'break-all', flex: 1 }}
                >
                  {inventory.documents_root}
                </Text>
                <Space>
                  <Button
                    size="small"
                    icon={<FolderEdit size={14} />}
                    loading={changing}
                    onClick={handleChangeDir}
                  >
                    {t('settings.storage.changeDir')}
                  </Button>
                  <Button
                    size="small"
                    icon={<RotateCcw size={14} />}
                    onClick={handleResetDir}
                  >
                    {t('settings.storage.resetDir')}
                  </Button>
                </Space>
              </div>
            </SettingsGroup>
          )}
        </>
      ) : null}
    </div>
  );
}
