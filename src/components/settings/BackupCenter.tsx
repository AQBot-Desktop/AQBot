import { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Tag, Space, Typography, Form, Select,
  Popconfirm, App, InputNumber, Switch, Divider, Tooltip, Input,
} from 'antd';
import {
  CloudUpload, Trash2, Undo2, FolderOpen,
  Settings2, HardDrive, FileJson,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useBackupStore } from '@/stores';
import type { BackupManifest } from '@/types';

const { Text } = Typography;

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export default function BackupCenter() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const {
    backups, loading, loadBackups, createBackup, restoreBackup,
    deleteBackup, batchDeleteBackups,
    selectedIds, setSelectedIds, backupSettings, loadBackupSettings,
    updateBackupSettings,
  } = useBackupStore();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupManifest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [form] = Form.useForm();
  const [settingsForm] = Form.useForm();
  const effectiveBackupDir = backupSettings?.backupDir || t('backup.defaultDir');

  useEffect(() => {
    loadBackups();
    loadBackupSettings();
  }, [loadBackups, loadBackupSettings]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const result = await createBackup(values.format);
      if (result) {
        message.success(t('backup.createSuccess'));
        setCreateModalOpen(false);
        form.resetFields();
      }
    } catch {
      message.error(t('error.saveFailed'));
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    try {
      await restoreBackup(restoreTarget.id);
      message.success(t('backup.restoreSuccess'));
      setRestoreTarget(null);
    } catch {
      message.error(t('error.unknown'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteBackup(id);
      message.success(t('backup.deleteSuccess'));
    } catch {
      message.error(t('error.deleteFailed'));
    }
  };

  const handleBatchDelete = async () => {
    try {
      await batchDeleteBackups(selectedIds);
      message.success(t('backup.batchDeleteSuccess'));
    } catch {
      message.error(t('error.deleteFailed'));
    }
  };

  const handleOpenFolder = async (filePath: string) => {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(filePath);
    } catch {
      message.error(t('error.unknown'));
    }
  };

  const handleChooseDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        settingsForm.setFieldValue('backupDir', selected as string);
      }
    } catch {
      // User cancelled or not available
    }
  };

  const handleSaveSettings = async () => {
    try {
      const values = await settingsForm.validateFields();
      await updateBackupSettings({
        enabled: values.enabled,
        intervalHours: values.intervalHours,
        maxCount: values.maxCount,
        backupDir: values.backupDir || null,
      });
      message.success(t('common.saveSuccess'));
      setSettingsOpen(false);
    } catch {
      message.error(t('error.saveFailed'));
    }
  };

  const columns = [
    {
      title: t('gateway.created'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (val: string) => new Date(val).toLocaleString(),
    },
    {
      title: t('backup.format'),
      dataIndex: 'version',
      key: 'version',
      width: 100,
      render: (val: string) => (
        <Tag icon={val === 'sqlite' ? <HardDrive size={12} /> : <FileJson size={12} />}>
          {val.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: t('backup.fileSize'),
      dataIndex: 'fileSize',
      key: 'fileSize',
      width: 100,
      render: (val: number) => <Text type="secondary">{formatFileSize(val)}</Text>,
    },
    {
      title: t('backup.filePath'),
      dataIndex: 'filePath',
      key: 'filePath',
      ellipsis: true,
      render: (val: string | null) => (
        <Tooltip title={val}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {val ? val.split('/').pop() : '-'}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('backup.appVersion'),
      dataIndex: 'sourceAppVersion',
      key: 'sourceAppVersion',
      width: 80,
      render: (val: string) => <Text type="secondary">v{val}</Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 160,
      render: (_: unknown, record: BackupManifest) => (
        <Space size="small">
          {record.version === 'sqlite' && (
            <Tooltip title={t('backup.restore')}>
              <Button
                size="small"
                icon={<Undo2 size={14} />}
                onClick={() => setRestoreTarget(record)}
              />
            </Tooltip>
          )}
          {record.filePath && (
            <Tooltip title={t('backup.openFolder')}>
              <Button
                size="small"
                icon={<FolderOpen size={14} />}
                onClick={() => handleOpenFolder(record.filePath!)}
              />
            </Tooltip>
          )}
          <Popconfirm
            title={t('backup.deleteConfirm')}
            onConfirm={() => handleDelete(record.id)}
          >
            <Button size="small" danger icon={<Trash2 size={14} />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const rowSelection = {
    selectedRowKeys: selectedIds,
    onChange: (keys: React.Key[]) => setSelectedIds(keys as string[]),
  };

  return (
    <div className="p-6 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <Space>
          <Popconfirm
            title={t('backup.batchDeleteConfirm', { count: selectedIds.length })}
            onConfirm={handleBatchDelete}
            disabled={selectedIds.length === 0}
          >
            <Button
              danger
              icon={<Trash2 size={16} />}
              disabled={selectedIds.length === 0}
            >
              {t('backup.batchDelete', { count: selectedIds.length })}
            </Button>
          </Popconfirm>
        </Space>
        <Space>
          <Button
            icon={<Settings2 size={16} />}
            onClick={() => {
              if (backupSettings) {
                settingsForm.setFieldsValue(backupSettings);
              }
              setSettingsOpen(true);
            }}
          >
            {t('backup.autoBackup')}
          </Button>
          <Button
            type="primary"
            icon={<CloudUpload size={16} />}
            onClick={() => setCreateModalOpen(true)}
          >
            {t('backup.create')}
          </Button>
        </Space>
      </div>

      {/* Backup table */}
      <Table
        dataSource={backups}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="small"
        rowSelection={rowSelection}
        locale={{ emptyText: t('backup.noBackups') }}
      />

      {/* Create backup modal */}
      <Modal
        title={t('backup.create')}
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={() => {
          setCreateModalOpen(false);
          form.resetFields();
        }}
        confirmLoading={loading}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={form} layout="vertical" initialValues={{ format: 'sqlite' }}>
          <Form.Item name="format" label={t('backup.format')}>
            <Select
              options={[
                { label: 'SQLite (' + t('backup.formatSqliteDesc') + ')', value: 'sqlite' },
                { label: 'JSON (' + t('backup.formatJsonDesc') + ')', value: 'json' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Restore confirmation modal */}
      <Modal
        title={t('backup.restore')}
        open={!!restoreTarget}
        onOk={handleRestore}
        onCancel={() => setRestoreTarget(null)}
        okButtonProps={{ danger: true }}
        confirmLoading={loading}
        mask={{ enabled: true, blur: true }}
      >
        <Text type="warning">{t('backup.restoreWarning')}</Text>
      </Modal>

      {/* Auto-backup settings modal */}
      <Modal
        title={t('backup.autoBackupSettings')}
        open={settingsOpen}
        onOk={handleSaveSettings}
        onCancel={() => setSettingsOpen(false)}
        mask={{ enabled: true, blur: true }}
      >
        <Form
          form={settingsForm}
          layout="vertical"
          initialValues={backupSettings || {
            enabled: false,
            intervalHours: 24,
            maxCount: 10,
            backupDir: '',
          }}
        >
          <Form.Item name="enabled" label={t('backup.autoBackupEnabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Divider />
          <Form.Item name="intervalHours" label={t('backup.intervalHours')}>
            <InputNumber
              min={1}
              max={720}
              addonAfter={<span style={{ whiteSpace: 'nowrap' }}>{t('backup.hours')}</span>}
              style={{ width: 200 }}
            />
          </Form.Item>
          <Form.Item name="maxCount" label={t('backup.maxCount')}>
            <InputNumber
              min={1}
              max={100}
              addonAfter={<span style={{ whiteSpace: 'nowrap' }}>{t('backup.copies')}</span>}
              style={{ width: 200 }}
            />
          </Form.Item>
          <Form.Item name="backupDir" label={t('backup.backupDir')}>
            <div className="flex flex-col gap-2">
              <Input
                readOnly
                placeholder={effectiveBackupDir}
                addonAfter={
                  <FolderOpen
                    size={14}
                    style={{ cursor: 'pointer' }}
                    onClick={handleChooseDir}
                  />
                }
              />
              <Text data-testid="backup-effective-dir" type="secondary" style={{ fontSize: 12 }}>
                {t('backup.effectiveDir')}: {effectiveBackupDir}
              </Text>
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
