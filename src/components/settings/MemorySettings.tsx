import { useEffect, useState } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Tag,
  Typography,
  Popconfirm,
  Empty,
  Divider,
  theme,
} from 'antd';
import { Plus, Trash2, Brain, RefreshCw, Trash } from 'lucide-react';
import { invoke } from '@/lib/invoke';
import { useTranslation } from 'react-i18next';
import { useMemoryStore } from '@/stores';
import { EmbeddingModelSelect } from '@/components/shared/EmbeddingModelSelect';
import type { MemorySource, MemoryNamespace } from '@/types';

const SOURCE_TAG_COLOR: Record<MemorySource, string> = {
  manual: 'blue',
  auto_extract: 'green',
};

// ── Left Sidebar: Namespace List ──────────────────────────

function NamespaceList({
  namespaces,
  selectedId,
  onSelect,
  onAdd,
}: {
  namespaces: MemoryNamespace[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {namespaces.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.memory.empty', '暂无命名空间')} />
          </div>
        ) : (
          namespaces.map((ns) => {
            const isSelected = selectedId === ns.id;
            return (
              <div
                key={ns.id}
                className="flex items-center cursor-pointer px-3 py-2.5 transition-colors"
                style={{
                  borderRadius: token.borderRadius,
                  backgroundColor: isSelected ? token.colorPrimaryBg : undefined,
                }}
                onClick={() => onSelect(ns.id)}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = token.colorFillQuaternary;
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = '';
                }}
              >
                <Brain size={16} style={{ marginRight: 8, flexShrink: 0, color: token.colorTextSecondary }} />
                <div className="min-w-0 flex-1">
                  <span style={{ color: isSelected ? token.colorPrimary : undefined }}>{ns.name}</span>
                </div>
                <Tag
                  color={ns.embeddingProvider ? 'green' : 'default'}
                  style={{ marginRight: 4, fontSize: 11 }}
                >
                  {ns.embeddingProvider ? t('settings.memory.vectorReady', '就绪') : t('settings.memory.vectorNotConfigured', '未配置')}
                </Tag>
                <Popconfirm
                  title={t('settings.memory.deleteConfirm')}
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    useMemoryStore.getState().deleteNamespace(ns.id);
                  }}
                  okButtonProps={{ danger: true }}
                >
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<Trash2 size={14} />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </div>
            );
          })
        )}
      </div>
      <div className="shrink-0 p-2 pt-0">
        <Button
          type="dashed"
          block
          icon={<Plus size={14} />}
          onClick={onAdd}
        >
          {t('settings.memory.addNamespace')}
        </Button>
      </div>
    </div>
  );
}

// ── Right Panel: Memory Items ─────────────────────────────

function MemoryItemsPanel({
  namespace,
}: {
  namespace: MemoryNamespace;
}) {
  const { t } = useTranslation();
  const { items, loading, loadItems, addItem, deleteItem, updateNamespace } = useMemoryStore();
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [itemForm] = Form.useForm();

  useEffect(() => {
    loadItems(namespace.id);
  }, [namespace.id, loadItems]);

  const handleAddItem = async () => {
    try {
      const values = await itemForm.validateFields();
      const content: string = values.content;
      await addItem(namespace.id, content.slice(0, 50), content);
      setItemModalOpen(false);
      itemForm.resetFields();
    } catch {
      // validation error
    }
  };

  const itemColumns = [
    {
      title: t('settings.memory.itemContent'),
      dataIndex: 'content',
      key: 'content',
      render: (content: string) => (
        <Typography.Text ellipsis style={{ maxWidth: 400 }}>{content}</Typography.Text>
      ),
    },
    {
      title: t('settings.memory.source'),
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (source: MemorySource) => (
        <Tag color={SOURCE_TAG_COLOR[source]}>
          {t(`settings.memory.${source === 'auto_extract' ? 'autoExtract' : 'manual'}`)}
        </Tag>
      ),
    },
    {
      key: 'actions',
      width: 60,
      render: (_: unknown, record: { id: string }) => (
        <Popconfirm
          title={t('settings.memory.deleteConfirm')}
          onConfirm={() => deleteItem(namespace.id, record.id)}
        >
          <Button size="small" danger icon={<Trash2 size={14} />} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div className="p-6 pb-12 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-4">
        <span style={{ fontWeight: 600, fontSize: 16 }}>{namespace.name}</span>
        <Tag
          color={namespace.embeddingProvider ? 'green' : 'default'}
          style={{ fontSize: 12 }}
        >
          {namespace.embeddingProvider ? t('settings.memory.vectorReady', '就绪') : t('settings.memory.vectorNotConfigured', '未配置')}
        </Tag>
      </div>

      {/* Name (editable) */}
      <div style={{ padding: '4px 0' }} className="flex items-center justify-between">
        <span>{t('settings.memory.namespaceName')}</span>
        <Input
          value={namespace.name}
          onChange={(e) => updateNamespace(namespace.id, { name: e.target.value })}
          style={{ width: 280 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />

      {/* Embedding model selector */}
      <div style={{ padding: '4px 0' }} className="flex items-center justify-between">
        <span>{t('settings.memory.embeddingModel', '向量模型')}</span>
        <EmbeddingModelSelect
          value={namespace.embeddingProvider ?? undefined}
          onChange={(val) => updateNamespace(namespace.id, { embeddingProvider: val || undefined })}
          placeholder={t('settings.memory.embeddingModelPlaceholder', '选择向量模型')}
          style={{ width: 280 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />

      {/* Vector operations */}
      <div style={{ padding: '4px 0' }} className="flex items-center justify-between">
        <span>{t('settings.memory.vectorOps', '向量操作')}</span>
        <div className="flex gap-2">
          <Button
            size="small"
            icon={<RefreshCw size={14} />}
            disabled={!namespace.embeddingProvider}
            title={t('settings.memory.rebuildIndex', '重建向量索引')}
            onClick={() => {
              invoke('rebuild_memory_index', { namespaceId: namespace.id }).catch(console.error);
            }}
          >
            {t('settings.memory.rebuildIndex', '重建索引')}
          </Button>
          <Button
            size="small"
            danger
            icon={<Trash size={14} />}
            disabled={!namespace.embeddingProvider}
            title={t('settings.memory.clearIndex', '清空向量索引')}
            onClick={() => {
              invoke('clear_memory_index', { namespaceId: namespace.id }).catch(console.error);
            }}
          >
            {t('settings.memory.clearIndex', '清空索引')}
          </Button>
        </div>
      </div>

      <Divider />

      <div className="flex items-center justify-between mb-3">
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('settings.memory.items', '记忆条目')}
        </Typography.Title>
        <Button size="small" icon={<Plus size={14} />} onClick={() => setItemModalOpen(true)}>
          {t('settings.memory.addItem')}
        </Button>
      </div>

      <Table
        dataSource={items}
        columns={itemColumns}
        rowKey="id"
        pagination={false}
        loading={loading}
        size="small"
      />

      <Modal
        title={t('settings.memory.addItem')}
        open={itemModalOpen}
        onOk={handleAddItem}
        onCancel={() => { setItemModalOpen(false); itemForm.resetFields(); }}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={itemForm} layout="vertical">
          <Form.Item name="content" label={t('settings.memory.itemContent')} rules={[{ required: true }]}>
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

export default function MemorySettings() {
  const { t } = useTranslation();
  const { namespaces, loadNamespaces, createNamespace, setSelectedNamespaceId } = useMemoryStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nsModalOpen, setNsModalOpen] = useState(false);
  const [nsForm] = Form.useForm();

  useEffect(() => {
    loadNamespaces();
  }, [loadNamespaces]);

  useEffect(() => {
    if (!selectedId && namespaces.length > 0) {
      setSelectedId(namespaces[0].id);
    }
  }, [namespaces, selectedId]);

  useEffect(() => {
    if (selectedId) {
      setSelectedNamespaceId(selectedId);
    }
  }, [selectedId, setSelectedNamespaceId]);

  const selectedNamespace = namespaces.find((ns) => ns.id === selectedId) ?? null;

  const handleAdd = () => {
    nsForm.resetFields();
    setNsModalOpen(true);
  };

  const handleCreate = async () => {
    try {
      const values = await nsForm.validateFields();
      await createNamespace(values.name, 'global', values.embeddingProvider);
      setNsModalOpen(false);
      nsForm.resetFields();
    } catch {
      // validation error
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 pt-2" style={{ borderRight: '1px solid var(--border-color)' }}>
        <NamespaceList
          namespaces={namespaces}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={handleAdd}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selectedNamespace ? (
          <MemoryItemsPanel
            key={selectedNamespace.id}
            namespace={selectedNamespace}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('settings.memory.selectOrAdd', '请选择或添加命名空间')}
            />
          </div>
        )}
      </div>

      <Modal
        title={t('settings.memory.addNamespace')}
        open={nsModalOpen}
        onOk={handleCreate}
        onCancel={() => { setNsModalOpen(false); nsForm.resetFields(); }}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={nsForm} layout="vertical">
          <Form.Item name="name" label={t('settings.memory.namespaceName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="embeddingProvider"
            label={t('settings.memory.embeddingModel', '向量模型')}
            rules={[{ required: true, message: t('settings.memory.embeddingModelPlaceholder', '选择向量模型') }]}
          >
            <EmbeddingModelSelect
              value={nsForm.getFieldValue('embeddingProvider')}
              onChange={(val) => nsForm.setFieldValue('embeddingProvider', val)}
              placeholder={t('settings.memory.embeddingModelPlaceholder', '选择向量模型')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
