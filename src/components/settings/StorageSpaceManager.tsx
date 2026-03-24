import { useEffect, useState } from 'react';
import { Card, Typography, Button, Space, Spin, List, App } from 'antd';
import { FolderOpen, Image, FileText, CloudUpload, HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';

const { Text, Title } = Typography;

interface BucketStats {
  bucket: string;
  file_count: number;
  total_bytes: number;
}

interface StorageInventory {
  buckets: BucketStats[];
  documents_root: string;
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
  const { message } = App.useApp();
  const [inventory, setInventory] = useState<StorageInventory | null>(null);
  const [loading, setLoading] = useState(true);

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

  const totalBytes = inventory?.buckets.reduce((sum, b) => sum + b.total_bytes, 0) ?? 0;
  const totalFiles = inventory?.buckets.reduce((sum, b) => sum + b.file_count, 0) ?? 0;

  return (
    <div className="p-6 pb-12">
      <div className="flex items-center justify-between mb-4">
        <Space align="center">
          <HardDrive size={20} />
          <Title level={5} style={{ margin: 0 }}>
            {t('settings.storage.title')}
          </Title>
        </Space>
        <Button icon={<FolderOpen size={16} />} onClick={handleOpenFolder}>
          {t('settings.storage.openFolder')}
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spin />
        </div>
      ) : inventory ? (
        <>
          <Card size="small" style={{ marginBottom: 16 }}>
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
          </Card>

          <Card size="small">
            <div className="flex items-center justify-between">
              <Text>{t('settings.storage.totalUsage')}</Text>
              <Space size="large">
                <Text type="secondary">
                  {totalFiles} {t('settings.storage.fileCount')}
                </Text>
                <Text>{formatBytes(totalBytes)}</Text>
              </Space>
            </div>
          </Card>

          {inventory.documents_root && (
            <div className="mt-3">
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('settings.storage.documentsRoot')}: {inventory.documents_root}
              </Text>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
