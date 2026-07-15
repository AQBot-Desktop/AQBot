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
import { createModuleResource } from '@/lib/moduleResource';
import type { WebDavConfig, WebDavFileInfo } from '@/types';
import { useSettingsStore } from '@/stores';

const { Text } = Typography;

interface WebDavSyncStatus {
  lastSyncTime: string | null;
  lastSyncStatus: string | null;
}

const webDavConfigResource = createModuleResource<WebDavConfig>();
const webDavBackupsResource = createModuleResource<WebDavFileInfo[]>();
const webDavSyncStatusResource = createModuleResource<WebDavSyncStatus>();

export function invalidateWebDavSyncResources() {
  webDavConfigResource.invalidate();
  webDavBackupsResource.invalidate();
  webDavSyncStatusResource.invalidate();
}

function webDavBackupResourceKey(config: WebDavConfig): string {
  return JSON.stringify([
    config.host,
    config.username,
    config.path,
    config.acceptInvalidCerts,
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

export default function WebDavSync() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { settings, saveSettings } = useSettingsStore();

  const [config, setConfig] = useState<WebDavConfig>({
    host: '',
    username: '',
    password: '',
    path: '/aqbot/',
    acceptInvalidCerts: false,
  });
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configForm] = Form.useForm();

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(
    null,
  );

  const [remoteBackups, setRemoteBackups] = useState<WebDavFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [selectedFileNames, setSelectedFileNames] = useState<string[]>([]);

  const [syncStatus, setSyncStatus] = useState<WebDavSyncStatus>({
    lastSyncTime: null,
    lastSyncStatus: null,
  });

  const loadConfig = useCallback(async (force = false) => {
    try {
      const cfg = await webDavConfigResource.ensure({
        force,
        load: () => invoke<WebDavConfig>('get_webdav_config'),
      });
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to load WebDAV config:', error);
    }
  }, []);

  const loadRemoteBackups = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const backups = await webDavBackupsResource.ensure({
        key: webDavBackupResourceKey(config),
        force,
        load: () => invoke<WebDavFileInfo[]>('webdav_list_backups'),
      });
      setRemoteBackups(backups);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [config, message]);

  const loadSyncStatus = useCallback(async (force = false) => {
    try {
      const status = await webDavSyncStatusResource.ensure({
        force,
        load: () => invoke<WebDavSyncStatus>('get_webdav_sync_status'),
      });
      setSyncStatus(status);
    } catch (error) {
      console.error('Failed to load WebDAV sync status:', error);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadSyncStatus();
  }, [loadConfig, loadSyncStatus]);

  useEffect(() => {
    if (config.host) {
      void loadRemoteBackups();
    }
  }, [config.host, loadRemoteBackups]);

  const handleSaveConfig = async () => {
    try {
      const values = await configForm.validateFields();

      // Save WebDAV connection config
      const newConfig: WebDavConfig = {
        host: values.host,
        username: values.username,
        password: values.password,
        path: values.path || '/aqbot/',
        acceptInvalidCerts: values.acceptInvalidCerts || false,
      };
      await invoke('save_webdav_config', { config: newConfig });
      webDavConfigResource.set(newConfig);
      webDavBackupsResource.invalidate();
      setConfig(newConfig);

      // Save sync settings
      await saveSettings({
        webdav_host: newConfig.host,
        webdav_username: newConfig.username,
        webdav_path: newConfig.path,
        webdav_accept_invalid_certs: newConfig.acceptInvalidCerts,
        webdav_sync_enabled: values.syncEnabled || false,
        webdav_sync_interval_minutes: values.syncIntervalMinutes || 60,
        webdav_max_remote_backups: values.maxRemoteBackups || 10,
        webdav_include_documents: values.includeDocuments || false,
      });

      // Restart sync scheduler
      await invoke('restart_webdav_sync');

      message.success(t('common.saveSuccess'));
      setConfigModalOpen(false);
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const values = await configForm.validateFields();
      const testConfig: WebDavConfig = {
        host: values.host,
        username: values.username,
        password: values.password,
        path: values.path || '/aqbot/',
        acceptInvalidCerts: values.acceptInvalidCerts || false,
      };
      await invoke<boolean>('webdav_check_connection', {
        config: testConfig,
      });
      setTestResult('success');
      message.success(t('backup.webdav.testSuccess'));
    } catch (e) {
      setTestResult('error');
      message.error(t('backup.webdav.testFailed') + ': ' + String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleBackupNow = async () => {
    setSyncing(true);
    try {
      await invoke<string>('webdav_backup');
      message.success(t('backup.webdav.backupSuccess'));
      void loadRemoteBackups(true);
      void loadSyncStatus(true);
    } catch (e) {
      message.error(t('backup.webdav.backupFailed') + ': ' + String(e));
    } finally {
      setSyncing(false);
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    try {
      await invoke('webdav_restore', { fileName: restoreTarget });
      message.success(t('backup.restoreSuccess'));
      setRestoreTarget(null);
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleDelete = async (fileName: string) => {
    try {
      await invoke('webdav_delete_backup', { fileName });
      message.success(t('backup.deleteSuccess'));
      setSelectedFileNames((prev) => prev.filter((n) => n !== fileName));
      void loadRemoteBackups(true);
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleBatchDelete = async () => {
    try {
      for (const fileName of selectedFileNames) {
        await invoke('webdav_delete_backup', { fileName });
      }
      message.success(t('backup.deleteSuccess'));
      setSelectedFileNames([]);
      void loadRemoteBackups(true);
    } catch (e) {
      message.error(String(e));
    }
  };

  const rowSelection = {
    selectedRowKeys: selectedFileNames,
    onChange: (keys: React.Key[]) => setSelectedFileNames(keys as string[]),
  };

  const columns = [
    {
      title: t('backup.webdav.fileName'),
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
      title: t('backup.webdav.device'),
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
      render: (_: unknown, record: WebDavFileInfo) => (
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

  const isConfigured = !!config.host;
  const formattedLastSyncTime = formatSyncTime(syncStatus.lastSyncTime);

  return (
    <>
      {/* Header */}
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
              {t('backup.webdav.lastSync')}:{' '}
              {formattedLastSyncTime}{' '}
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
                host: config.host,
                username: config.username,
                password: config.password,
                path: config.path,
                acceptInvalidCerts: config.acceptInvalidCerts,
                syncEnabled: settings?.webdav_sync_enabled || false,
                syncIntervalMinutes:
                  settings?.webdav_sync_interval_minutes || 60,
                maxRemoteBackups:
                  settings?.webdav_max_remote_backups || 10,
                includeDocuments:
                  settings?.webdav_include_documents || false,
              });
              setTestResult(null);
              setConfigModalOpen(true);
            }}
          >
            {t('backup.webdav.config')}
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
                {t('backup.webdav.backupNow')}
              </Button>
            </>
          )}
        </Space>
      </div>

      {/* Content */}
      {!isConfigured ? (
        <div className="flex flex-col items-center justify-center py-16 opacity-50">
          <Cloud size={48} />
          <Text type="secondary" style={{ marginTop: 12 }}>
            {t('backup.webdav.notConfigured')}
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
          locale={{ emptyText: t('backup.webdav.noBackups') }}
        />
      )}

      {/* Config Modal */}
      <Modal
        title={t('backup.webdav.configTitle')}
        open={configModalOpen}
        onOk={handleSaveConfig}
        onCancel={() => setConfigModalOpen(false)}
        width={520}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={configForm} layout="vertical">
          <Form.Item
            name="host"
            label={t('backup.webdav.host')}
            rules={[
              {
                required: true,
                message: t('backup.webdav.hostRequired'),
              },
            ]}
          >
            <Input placeholder="https://dav.example.com/dav/" />
          </Form.Item>
          <div className="flex gap-4">
            <Form.Item
              name="username"
              label={t('backup.webdav.username')}
              className="flex-1"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name="password"
              label={t('backup.webdav.password')}
              className="flex-1"
              rules={[{ required: true }]}
            >
              <Input.Password />
            </Form.Item>
          </div>
          <Form.Item name="path" label={t('backup.webdav.path')}>
            <Input placeholder="/aqbot/" />
          </Form.Item>
          <div className="flex items-center gap-4 mb-4">
            <Form.Item
              name="acceptInvalidCerts"
              valuePropName="checked"
              noStyle
            >
              <Checkbox>
                {t('backup.webdav.acceptInvalidCerts')}
              </Checkbox>
            </Form.Item>
            <Button onClick={handleTestConnection} loading={testing}>
              {t('backup.webdav.testConnection')}
            </Button>
            {testResult === 'success' && (
              <Tag color="success">
                {t('backup.webdav.testSuccess')}
              </Tag>
            )}
            {testResult === 'error' && (
              <Tag color="error">
                {t('backup.webdav.testFailed')}
              </Tag>
            )}
          </div>

          <Divider />

          <Form.Item
            name="syncEnabled"
            label={t('backup.webdav.autoSync')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <div className="flex gap-4">
            <Form.Item
              name="syncIntervalMinutes"
              label={t('backup.webdav.syncInterval')}
            >
              <Select
                style={{ width: 200 }}
                options={[
                  {
                    label:
                      '15 ' + t('backup.webdav.minutes'),
                    value: 15,
                  },
                  {
                    label:
                      '30 ' + t('backup.webdav.minutes'),
                    value: 30,
                  },
                  {
                    label: '1 ' + t('backup.webdav.hour'),
                    value: 60,
                  },
                  {
                    label:
                      '2 ' + t('backup.webdav.hours'),
                    value: 120,
                  },
                  {
                    label:
                      '6 ' + t('backup.webdav.hours'),
                    value: 360,
                  },
                  {
                    label:
                      '12 ' + t('backup.webdav.hours'),
                    value: 720,
                  },
                  {
                    label:
                      '24 ' + t('backup.webdav.hours'),
                    value: 1440,
                  },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="maxRemoteBackups"
              label={t('backup.webdav.maxBackups')}
            >
              <InputNumber
                min={1}
                max={100}
                style={{ width: 120 }}
                addonAfter={t('backup.webdav.perDevice')}
              />
            </Form.Item>
          </div>
          <Form.Item name="includeDocuments" valuePropName="checked">
            <Checkbox>
              {t('backup.webdav.includeDocuments')}
            </Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      {/* Restore Confirmation */}
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
