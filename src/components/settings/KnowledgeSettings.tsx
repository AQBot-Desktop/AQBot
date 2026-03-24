import { useEffect, useState } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Switch,
  Divider,
  Tag,
  Typography,
  Popconfirm,
  Empty,
  theme,
} from 'antd';
import { Plus, Trash2, BookOpen, RefreshCw, Trash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useKnowledgeStore } from '@/stores';
import { EmbeddingModelSelect } from '@/components/shared/EmbeddingModelSelect';
import { invoke } from '@/lib/invoke';
import type { KnowledgeBase, IndexingStatus } from '@/types';

const STATUS_TAG_COLOR: Record<IndexingStatus, string> = {
  pending: 'default',
  indexing: 'processing',
  ready: 'success',
  failed: 'error',
};

// ── Left Sidebar: Knowledge Base List ─────────────────────

function KnowledgeBaseList({
  bases,
  selectedId,
  onSelect,
  onAdd,
}: {
  bases: KnowledgeBase[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {bases.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.knowledge.empty', '暂无知识库')} />
          </div>
        ) : (
          bases.map((b) => {
            const isSelected = selectedId === b.id;
            return (
              <div
                key={b.id}
                className="flex items-center cursor-pointer px-3 py-2.5 transition-colors"
                style={{
                  borderRadius: token.borderRadius,
                  backgroundColor: isSelected ? token.colorPrimaryBg : undefined,
                }}
                onClick={() => onSelect(b.id)}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = token.colorFillQuaternary;
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = '';
                }}
              >
                <BookOpen size={16} style={{ marginRight: 8, flexShrink: 0, color: token.colorTextSecondary }} />
                <div className="min-w-0 flex-1">
                  <span style={{ color: isSelected ? token.colorPrimary : undefined }}>{b.name}</span>
                </div>
                <Switch
                  size="small"
                  checked={b.enabled}
                  onClick={(_, e) => e.stopPropagation()}
                  onChange={() => useKnowledgeStore.getState().updateBase(b.id, { enabled: !b.enabled })}
                />
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
          {t('settings.knowledge.add')}
        </Button>
      </div>
    </div>
  );
}

// ── Right Panel: Knowledge Base Detail ────────────────────

function KnowledgeBaseDetail({
  base,
  onDeleted,
}: {
  base: KnowledgeBase;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { documents, loading, updateBase, deleteBase, loadDocuments, addDocument, deleteDocument } =
    useKnowledgeStore();

  useEffect(() => {
    loadDocuments(base.id);
  }, [base.id, loadDocuments]);

  const rowStyle = { padding: '4px 0' };

  const handleFieldChange = async (field: string, value: unknown) => {
    await updateBase(base.id, { [field]: value });
  };

  const handleDelete = async () => {
    await deleteBase(base.id);
    onDeleted();
  };

  const MIME_MAP: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    htm: 'text/html',
  };

  const handleAddDocuments = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: true,
        filters: [
          { name: t('settings.knowledge.documentTypes', '文档文件'), extensions: ['pdf', 'txt', 'md', 'doc', 'docx', 'csv', 'json', 'html', 'htm'] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const filePath of paths) {
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';
        const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
        await addDocument(base.id, fileName, filePath, mimeType);
      }
    } catch {
      // user cancelled or error
    }
  };

  const docColumns = [
    { title: t('settings.knowledge.name'), dataIndex: 'title', key: 'title' },
    { title: t('settings.knowledge.sourcePath'), dataIndex: 'sourcePath', key: 'sourcePath' },
    {
      title: t('settings.knowledge.status'),
      dataIndex: 'indexingStatus',
      key: 'indexingStatus',
      render: (status: IndexingStatus) => <Tag color={STATUS_TAG_COLOR[status]}>{status}</Tag>,
    },
    {
      key: 'actions',
      render: (_: unknown, record: { id: string }) => (
        <Popconfirm
          title={t('settings.knowledge.deleteConfirm')}
          onConfirm={() => deleteDocument(base.id, record.id)}
        >
          <Button size="small" danger icon={<Trash2 size={14} />} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div className="p-6 pb-12 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-4">
        <span style={{ fontWeight: 600, fontSize: 16 }}>{base.name}</span>
        <Popconfirm
          title={t('settings.knowledge.deleteConfirm')}
          onConfirm={handleDelete}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
        >
          <Button danger size="small" icon={<Trash2 size={14} />}>
            {t('common.delete')}
          </Button>
        </Popconfirm>
      </div>

      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.knowledge.name')}</span>
        <Input
          value={base.name}
          onChange={(e) => handleFieldChange('name', e.target.value)}
          style={{ width: 280 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.knowledge.embeddingModel')}</span>
        <EmbeddingModelSelect
          value={base.embeddingProvider ?? undefined}
          onChange={(val) => handleFieldChange('embeddingProvider', val || undefined)}
          placeholder={t('settings.knowledge.embeddingModelPlaceholder')}
          style={{ width: 280 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('common.enabled')}</span>
        <Switch
          checked={base.enabled}
          onChange={(val) => handleFieldChange('enabled', val)}
        />
      </div>

      {/* Vector Operations */}
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.knowledge.vectorOps', '向量操作')}</span>
        <div className="flex gap-2">
          <Button
            size="small"
            icon={<RefreshCw size={14} />}
            disabled={!base.embeddingProvider}
            onClick={() => {
              invoke('rebuild_knowledge_index', { baseId: base.id }).catch(console.error);
            }}
          >
            {t('settings.knowledge.rebuildIndex', '重建索引')}
          </Button>
          <Button
            size="small"
            danger
            icon={<Trash size={14} />}
            disabled={!base.embeddingProvider}
            onClick={() => {
              invoke('clear_knowledge_index', { baseId: base.id }).catch(console.error);
            }}
          >
            {t('settings.knowledge.clearIndex', '清空索引')}
          </Button>
        </div>
      </div>

      {/* Documents Section */}
      <Divider />
      <div className="flex items-center justify-between mb-3">
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('settings.knowledge.documents')}
        </Typography.Title>
        <Button size="small" icon={<Plus size={14} />} onClick={handleAddDocuments}>
          {t('settings.knowledge.addDocument')}
        </Button>
      </div>

      <Table
        dataSource={documents}
        columns={docColumns}
        rowKey="id"
        pagination={false}
        loading={loading}
        size="small"
      />
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

export default function KnowledgeSettings() {
  const { t } = useTranslation();
  const { bases, loadBases, createBase, setSelectedBaseId } = useKnowledgeStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadBases();
  }, [loadBases]);

  useEffect(() => {
    if (!selectedId && bases.length > 0) {
      setSelectedId(bases[0].id);
    }
  }, [bases, selectedId]);

  // Sync with store's selectedBaseId
  useEffect(() => {
    if (selectedId) {
      setSelectedBaseId(selectedId);
    }
  }, [selectedId, setSelectedBaseId]);

  const selectedBase = bases.find((b) => b.id === selectedId) ?? null;

  const handleAdd = () => {
    form.resetFields();
    setModalOpen(true);
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      await createBase(values);
      setModalOpen(false);
      form.resetFields();
    } catch {
      // validation error
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 pt-2" style={{ borderRight: '1px solid var(--border-color)' }}>
        <KnowledgeBaseList
          bases={bases}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={handleAdd}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selectedBase ? (
          <KnowledgeBaseDetail
            key={selectedBase.id}
            base={selectedBase}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('settings.knowledge.selectOrAdd', '请选择或添加知识库')}
            />
          </div>
        )}
      </div>

      <Modal
        title={t('settings.knowledge.add')}
        open={modalOpen}
        onOk={handleCreate}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('settings.knowledge.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="embeddingProvider"
            label={t('settings.knowledge.embeddingModel')}
            rules={[{ required: true, message: t('settings.knowledge.embeddingModelPlaceholder') }]}
          >
            <EmbeddingModelSelect
              value={form.getFieldValue('embeddingProvider')}
              onChange={(val) => form.setFieldValue('embeddingProvider', val)}
              placeholder={t('settings.knowledge.embeddingModelPlaceholder')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
