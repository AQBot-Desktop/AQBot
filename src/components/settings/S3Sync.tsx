import { useEffect, useState, useCallback } from 'react';
import {
  Button,
  Form,
  Input,
  InputNumber,
  Switch,
  Space,
  Table,
  Tag,
  Modal,
  App,
  Typography,
  Tooltip,
  Popconfirm,
  Select,
  Checkbox,
  Divider,
} from 'antd';
import {
  Cloud,
  CloudUpload,
  RefreshCw,
  Settings2,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import { getErrorMessage, isFormValidationError } from '@/lib/errorMessage';
import { createModuleResource } from '@/lib/moduleResource';
import type { S3Config, S3FileInfo } from '@/types';
import { useSettingsStore } from '@/stores';

const { Text } = Typography;

interface S3SyncStatus {
  lastSyncTime: string | null;
  lastSyncStatus: string | null;
}

const s3ConfigResource = createModuleResource<S3Config>();
const s3BackupsResource = createModuleResource<S3FileInfo[]>();
const s3SyncStatusResource = createModuleResource<S3SyncStatus>();

export function invalidateS3SyncResources() {
  s3ConfigResource.invalidate();
  s3BackupsResource.invalidate();
  s3SyncStatusResource.invalidate();
}

function s3BackupResourceKey(config: S3Config): string {
  return JSON.stringify([
    config.bucket,
    config.region,
    config.prefix,
    config.endpointUrl,
    config.forcePathStyle,
  ]);
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatSyncTime(value: string | null): string | null {
  if (!value) return null;

  const numeric = Number(value);
  const date = Number.isNaN(numeric)
    ? new Date(value)
    : new Date(value.length <= 10 ? numeric * 1000 : numeric);

  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export default function S3Sync() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { settings, saveSettings } = useSettingsStore();

  const [config, setConfig] = useState<S3Config>({
    bucket: '',
    region: 'us-east-1',
    prefix: 'aqbot/',
    endpointUrl: null,
    forcePathStyle: false,
    useDefaultCredentials: false,
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: null,
  });
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configForm] = Form.useForm();
  const useDefaultCredentials = Form.useWatch('useDefaultCredentials', configForm);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(
    null,
  );
  const [remoteBackups, setRemoteBackups] = useState<S3FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [selectedFileNames, setSelectedFileNames] = useState<string[]>([]);
  const [syncStatus, setSyncStatus] = useState<S3SyncStatus>({
    lastSyncTime: null,
    lastSyncStatus: null,
  });

  const loadConfig = useCallback(async (force = false) => {
    try {
      const cfg = await s3ConfigResource.ensure({
        force,
        load: () => invoke<S3Config>('get_s3_config'),
      });
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to load S3 config:', error);
    }
  }, []);

  const loadRemoteBackups = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const backups = await s3BackupsResource.ensure({
        key: s3BackupResourceKey(config),
        force,
        load: () => invoke<S3FileInfo[]>('s3_list_backups'),
      });
      setRemoteBackups(backups);
    } catch (e) {
      message.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [config, message]);

  const loadSyncStatus = useCallback(async (force = false) => {
    try {
      const status = await s3SyncStatusResource.ensure({
        force,
        load: () => invoke<S3SyncStatus>('get_s3_sync_status'),
      });
      setSyncStatus(status);
    } catch (error) {
      console.error('Failed to load S3 sync status:', error);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadSyncStatus();
  }, [loadConfig, loadSyncStatus]);

  useEffect(() => {
    if (config.bucket) {
      void loadRemoteBackups();
    }
  }, [config.bucket, loadRemoteBackups]);

  const buildConfigFromValues = (values: Record<string, any>): S3Config => ({
    bucket: values.bucket,
    region: values.region || 'us-east-1',
    prefix: values.prefix || 'aqbot/',
    endpointUrl: values.endpointUrl || null,
    forcePathStyle: values.forcePathStyle || false,
    useDefaultCredentials: values.useDefaultCredentials || false,
    accessKeyId: values.useDefaultCredentials ? '' : values.accessKeyId || '',
    secretAccessKey: values.useDefaultCredentials
      ? ''
      : values.secretAccessKey || '',
    sessionToken: values.useDefaultCredentials
      ? null
      : values.sessionToken || null,
  });

  const handleSaveConfig = async () => {
    try {
      const values = await configForm.validateFields();
      const newConfig = buildConfigFromValues(values);

      await invoke('save_s3_config', { config: newConfig });
      s3ConfigResource.set(newConfig);
      s3BackupsResource.invalidate();
      setConfig(newConfig);

      await saveSettings({
        s3_bucket: newConfig.bucket,
        s3_region: newConfig.region,
        s3_endpoint: newConfig.endpointUrl,
        s3_prefix: newConfig.prefix,
        s3_force_path_style: newConfig.forcePathStyle,
        s3_use_default_credentials: newConfig.useDefaultCredentials,
        s3_sync_enabled: values.syncEnabled || false,
        s3_sync_interval_minutes: values.syncIntervalMinutes || 60,
        s3_max_remote_backups: values.maxRemoteBackups || 10,
        s3_include_documents: values.includeDocuments || false,
      });

      await invoke('restart_s3_sync');

      message.success(t('common.saveSuccess'));
      setConfigModalOpen(false);
    } catch (e) {
      if (isFormValidationError(e)) {
        return;
      }
      message.error(getErrorMessage(e));
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const values = await configForm.validateFields();
      await invoke<boolean>('s3_check_connection', {
        config: buildConfigFromValues(values),
      });
      setTestResult('success');
      message.success(t('backup.s3.testSuccess'));
    } catch (e) {
      if (isFormValidationError(e)) {
        setTestResult(null);
        return;
      }
      setTestResult('error');
      message.error(t('backup.s3.testFailed') + ': ' + getErrorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const handleBackupNow = async () => {
    setSyncing(true);
    try {
      await invoke<string>('s3_backup');
      message.success(t('backup.s3.backupSuccess'));
      void loadRemoteBackups(true);
      void loadSyncStatus(true);
    } catch (e) {
      message.error(t('backup.s3.backupFailed') + ': ' + getErrorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    try {
      await invoke('s3_restore', { fileName: restoreTarget });
      message.success(t('backup.restoreSuccess'));
      setRestoreTarget(null);
    } catch (e) {
      message.error(getErrorMessage(e));
    }
  };

  const handleDelete = async (fileName: string) => {
    try {
      await invoke('s3_delete_backup', { fileName });
      message.success(t('backup.deleteSuccess'));
      setSelectedFileNames((prev) => prev.filter((n) => n !== fileName));
      void loadRemoteBackups(true);
    } catch (e) {
      message.error(getErrorMessage(e));
    }
  };

  const handleBatchDelete = async () => {
    try {
      for (const fileName of selectedFileNames) {
        await invoke('s3_delete_backup', { fileName });
      }
      message.success(t('backup.deleteSuccess'));
      setSelectedFileNames([]);
      void loadRemoteBackups(true);
    } catch (e) {
      message.error(getErrorMessage(e));
    }
  };

  const rowSelection = {
    selectedRowKeys: selectedFileNames,
    onChange: (keys: React.Key[]) => setSelectedFileNames(keys as string[]),
  };

  const columns = [
    {
      title: t('backup.s3.fileName'),
      dataIndex: 'fileName',
      key: 'fileName',
      ellipsis: { showTitle: false },
      render: (val: string) => (
        <Tooltip title={val}>
          <Text style={{ fontSize: 12 }}>{val}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('backup.fileSize'),
      dataIndex: 'size',
      key: 'size',
      width: 100,
      render: (val: number) => (
        <Text type="secondary">{formatFileSize(val)}</Text>
      ),
    },
    {
      title: t('backup.s3.device'),
      dataIndex: 'hostname',
      key: 'hostname',
      width: 140,
      ellipsis: true,
      render: (val: string) => <Tag>{val}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: S3FileInfo) => (
        <Space size="small">
          <Tooltip title={t('backup.restore')}>
            <Button
              size="small"
              icon={<Undo2 size={14} />}
              onClick={() => setRestoreTarget(record.fileName)}
            />
          </Tooltip>
          <Popconfirm
            title={t('backup.deleteConfirm')}
            onConfirm={() => handleDelete(record.fileName)}
          >
            <Button size="small" danger icon={<Trash2 size={14} />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const isConfigured = !!config.bucket;
  const formattedLastSyncTime = formatSyncTime(syncStatus.lastSyncTime);

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <Space>
          <Popconfirm
            title={t('backup.batchDeleteConfirm', { count: selectedFileNames.length })}
            onConfirm={handleBatchDelete}
            disabled={selectedFileNames.length === 0}
          >
            <Button
              danger
              icon={<Trash2 size={16} />}
              disabled={selectedFileNames.length === 0}
            >
              {t('backup.batchDelete', { count: selectedFileNames.length })}
            </Button>
          </Popconfirm>
          {formattedLastSyncTime && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('backup.s3.lastSync')}: {formattedLastSyncTime}{' '}
              {syncStatus.lastSyncStatus === 'success' ? (
                <Tag color="success" style={{ marginLeft: 4 }}>
                  ✓
                </Tag>
              ) : (
                <Tag color="error" style={{ marginLeft: 4 }}>
                  ✗
                </Tag>
              )}
            </Text>
          )}
        </Space>
        <Space>
          <Button
            icon={<Settings2 size={16} />}
            onClick={() => {
              configForm.setFieldsValue({
                bucket: config.bucket,
                region: config.region,
                prefix: config.prefix,
                endpointUrl: config.endpointUrl,
                forcePathStyle: config.forcePathStyle,
                useDefaultCredentials: config.useDefaultCredentials,
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
                sessionToken: config.sessionToken,
                syncEnabled: settings?.s3_sync_enabled || false,
                syncIntervalMinutes: settings?.s3_sync_interval_minutes || 60,
                maxRemoteBackups: settings?.s3_max_remote_backups || 10,
                includeDocuments: settings?.s3_include_documents || false,
              });
              setTestResult(null);
              setConfigModalOpen(true);
            }}
          >
            {t('backup.s3.config')}
          </Button>
          {isConfigured && (
            <>
              <Button
                icon={<RefreshCw size={16} />}
                onClick={() => void loadRemoteBackups(true)}
                loading={loading}
              >
                {t('common.refresh')}
              </Button>
              <Button
                type="primary"
                icon={<CloudUpload size={16} />}
                onClick={handleBackupNow}
                loading={syncing}
              >
                {t('backup.s3.backupNow')}
              </Button>
            </>
          )}
        </Space>
      </div>

      {!isConfigured ? (
        <div className="flex flex-col items-center justify-center py-16 opacity-50">
          <Cloud size={48} />
          <Text type="secondary" style={{ marginTop: 12 }}>
            {t('backup.s3.notConfigured')}
          </Text>
        </div>
      ) : (
        <Table
          dataSource={remoteBackups}
          columns={columns}
          rowKey="fileName"
          loading={loading}
          pagination={false}
          size="small"
          rowSelection={rowSelection}
          locale={{ emptyText: t('backup.s3.noBackups') }}
        />
      )}

      <Modal
        title={t('backup.s3.configTitle')}
        open={configModalOpen}
        onOk={handleSaveConfig}
        onCancel={() => setConfigModalOpen(false)}
        width={560}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={configForm} layout="vertical">
          <div className="flex gap-4">
            <Form.Item
              name="bucket"
              label={t('backup.s3.bucket')}
              className="flex-1"
              rules={[{ required: true, message: t('backup.s3.bucketRequired') }]}
            >
              <Input placeholder="my-aqbot-backups" />
            </Form.Item>
            <Form.Item
              name="region"
              label={t('backup.s3.region')}
              className="flex-1"
              rules={[{ required: true, message: t('backup.s3.regionRequired') }]}
            >
              <Input placeholder="us-east-1" />
            </Form.Item>
          </div>
          <div className="flex gap-4">
            <Form.Item
              name="prefix"
              label={t('backup.s3.prefix')}
              className="flex-1"
            >
              <Input placeholder="aqbot/" />
            </Form.Item>
            <Form.Item
              name="endpointUrl"
              label={t('backup.s3.endpointUrl')}
              className="flex-1"
            >
              <Input placeholder="https://s3.amazonaws.com" />
            </Form.Item>
          </div>
          <div className="flex items-center gap-4 mb-4">
            <Form.Item name="forcePathStyle" valuePropName="checked" noStyle>
              <Checkbox>{t('backup.s3.forcePathStyle')}</Checkbox>
            </Form.Item>
            <Form.Item
              name="useDefaultCredentials"
              valuePropName="checked"
              noStyle
            >
              <Checkbox>{t('backup.s3.useDefaultCredentials')}</Checkbox>
            </Form.Item>
          </div>
          <div className="flex gap-4">
            <Form.Item
              name="accessKeyId"
              label={t('backup.s3.accessKeyId')}
              className="flex-1"
              rules={[{ required: !useDefaultCredentials }]}
            >
              <Input disabled={useDefaultCredentials} />
            </Form.Item>
            <Form.Item
              name="secretAccessKey"
              label={t('backup.s3.secretAccessKey')}
              className="flex-1"
              rules={[{ required: !useDefaultCredentials }]}
            >
              <Input.Password disabled={useDefaultCredentials} />
            </Form.Item>
          </div>
          <Form.Item name="sessionToken" label={t('backup.s3.sessionToken')}>
            <Input.Password disabled={useDefaultCredentials} />
          </Form.Item>
          <div className="flex items-center gap-4 mb-4">
            <Button onClick={handleTestConnection} loading={testing}>
              {t('backup.s3.testConnection')}
            </Button>
            {testResult === 'success' && (
              <Tag color="success">{t('backup.s3.testSuccess')}</Tag>
            )}
            {testResult === 'error' && (
              <Tag color="error">{t('backup.s3.testFailed')}</Tag>
            )}
          </div>

          <Divider />

          <Form.Item
            name="syncEnabled"
            label={t('backup.s3.autoSync')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <div className="flex gap-4">
            <Form.Item
              name="syncIntervalMinutes"
              label={t('backup.s3.syncInterval')}
            >
              <Select
                style={{ width: 200 }}
                options={[
                  { label: '15 ' + t('backup.s3.minutes'), value: 15 },
                  { label: '30 ' + t('backup.s3.minutes'), value: 30 },
                  { label: '1 ' + t('backup.s3.hour'), value: 60 },
                  { label: '2 ' + t('backup.s3.hours'), value: 120 },
                  { label: '6 ' + t('backup.s3.hours'), value: 360 },
                  { label: '12 ' + t('backup.s3.hours'), value: 720 },
                  { label: '24 ' + t('backup.s3.hours'), value: 1440 },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="maxRemoteBackups"
              label={t('backup.s3.maxBackups')}
            >
              <InputNumber
                min={1}
                max={100}
                style={{ width: 120 }}
                addonAfter={t('backup.s3.perDevice')}
              />
            </Form.Item>
          </div>
          <Form.Item name="includeDocuments" valuePropName="checked">
            <Checkbox>{t('backup.s3.includeDocuments')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('backup.restore')}
        open={!!restoreTarget}
        onOk={handleRestore}
        onCancel={() => setRestoreTarget(null)}
        okButtonProps={{ danger: true }}
        mask={{ enabled: true, blur: true }}
      >
        <Text type="warning">{t('backup.restoreWarning')}</Text>
      </Modal>
    </>
  );
}
