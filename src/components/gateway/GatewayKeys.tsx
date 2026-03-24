import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Table,
  Button,
  Switch,
  Modal,
  Input,
  message,
  Popconfirm,
  Typography,
  Alert,
} from 'antd';
import { Plus, Trash2, Copy, Search } from 'lucide-react';
import { useGatewayStore } from '@/stores/gatewayStore';
import type { GatewayKey } from '@/types';

const { Text } = Typography;

export function GatewayKeys() {
  const { t } = useTranslation();
  const { keys, loading, fetchKeys, createKey, deleteKey, toggleKey } =
    useGatewayStore();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const filteredKeys = useMemo(() => {
    if (!searchText.trim()) return keys;
    const lower = searchText.toLowerCase();
    return keys.filter(
      (k) =>
        k.name.toLowerCase().includes(lower) ||
        k.key_prefix.toLowerCase().includes(lower)
    );
  }, [keys, searchText]);

  const handleCreate = async () => {
    if (!keyName.trim()) return;
    setCreating(true);
    try {
      const result = await createKey(keyName.trim());
      setCreatedKey(result.plain_key);
      setKeyName('');
    } catch (e) {
      message.error(String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleCopyKey = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      message.success(t('common.copySuccess'));
    }
  };

  const handleCloseModal = () => {
    setCreateModalOpen(false);
    setCreatedKey(null);
    setKeyName('');
  };

  const columns = [
    {
      title: t('gateway.keyName'),
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: t('settings.keyPrefix'),
      dataIndex: 'key_prefix',
      key: 'key_prefix',
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: t('common.enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean, record: GatewayKey) => (
        <Switch
          checked={enabled}
          onChange={(checked) => toggleKey(record.id, checked)}
          size="small"
        />
      ),
    },
    {
      title: t('gateway.created'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (ts: number) => new Date(ts * 1000).toLocaleDateString(),
    },
    {
      title: t('gateway.lastUsed'),
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      render: (ts: number | null) =>
        ts ? new Date(ts * 1000).toLocaleDateString() : '-',
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: unknown, record: GatewayKey) => (
        <Popconfirm
          title={t('gateway.deleteKeyConfirm')}
          onConfirm={() => deleteKey(record.id)}
        >
          <Button type="text" danger icon={<Trash2 size={14} />} size="small" />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <Button
          type="primary"
          icon={<Plus size={16} />}
          onClick={() => setCreateModalOpen(true)}
        >
          {t('gateway.createKey')}
        </Button>
        <Input
          placeholder={t('gateway.searchKeys')}
          prefix={<Search size={14} style={{ opacity: 0.45 }} />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ maxWidth: 280 }}
        />
      </div>

      <Table
        dataSource={filteredKeys}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="small"
      />

      <Modal
        title={createdKey ? t('gateway.keyCreated') : t('gateway.createKey')}
        open={createModalOpen}
        onCancel={handleCloseModal}
        footer={
          createdKey
            ? [
                <Button key="copy" icon={<Copy size={16} />} onClick={handleCopyKey}>
                  {t('gateway.copyKey')}
                </Button>,
                <Button key="close" type="primary" onClick={handleCloseModal}>
                  {t('common.confirm')}
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={handleCloseModal}>
                  {t('common.cancel')}
                </Button>,
                <Button
                  key="create"
                  type="primary"
                  onClick={handleCreate}
                  loading={creating}
                  disabled={!keyName.trim()}
                >
                  {t('common.create')}
                </Button>,
              ]
        }
      >
        {createdKey ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Alert
              message={t('gateway.copyWarning')}
              type="warning"
              showIcon
            />
            <Input.TextArea
              value={createdKey}
              readOnly
              autoSize={{ minRows: 2 }}
              className="font-mono"
            />
          </div>
        ) : (
          <Input
            placeholder={t('gateway.keyName')}
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            onPressEnter={handleCreate}
            autoFocus
          />
        )}
      </Modal>
    </div>
  );
}
