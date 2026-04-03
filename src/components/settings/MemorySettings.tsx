import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Tag,
  Typography,
  Empty,
  Divider,
  Dropdown,
  Popconfirm,
  theme,
  message,
  Spin,
  Tooltip,
} from 'antd';
import type { MenuProps } from 'antd';
import { Plus, Trash2, Trash, Pencil, Search, Zap, Settings, GripVertical, MoreHorizontal } from 'lucide-react';
import { invoke } from '@/lib/invoke';
import { useTranslation } from 'react-i18next';
import { useMemoryStore } from '@/stores';
import { EmbeddingModelSelect } from '@/components/shared/EmbeddingModelSelect';
import { IconEditor } from '@/components/shared/IconEditor';
import { NamespaceIcon } from '@/components/shared/NamespaceIcon';
import { listen } from '@tauri-apps/api/event';
import type { MemorySource, MemoryNamespace, MemoryItem } from '@/types';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface VectorSearchResult {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  score: number;
}

const SOURCE_TAG_COLOR: Record<MemorySource, string> = {
  manual: 'blue',
  auto_extract: 'green',
};

const INDEX_STATUS_CONFIG: Record<string, { color: string; labelKey: string }> = {
  pending: { color: 'default', labelKey: 'settings.indexStatus.pending' },
  indexing: { color: 'processing', labelKey: 'settings.indexStatus.indexing' },
  ready: { color: 'success', labelKey: 'settings.indexStatus.indexed' },
  failed: { color: 'error', labelKey: 'settings.indexStatus.failed' },
  skipped: { color: 'warning', labelKey: 'settings.indexStatus.notConfigured' },
};

// ── Sortable Namespace Item ──────────────────────────────

function SortableNamespaceItem({
  ns,
  isSelected,
  onSelect,
  onDelete,
}: {
  ns: MemoryNamespace;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ns.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    borderRadius: token.borderRadius,
    backgroundColor: isSelected ? token.colorPrimaryBg : undefined,
  };

  const menuItems: MenuProps['items'] = [
    {
      key: 'delete',
      label: t('settings.memory.deleteNamespace', '删除命名空间'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: (e) => {
        e.domEvent.stopPropagation();
        Modal.confirm({
          title: t('settings.memory.deleteConfirm'),
          okButtonProps: { danger: true },
          onOk: onDelete,
        });
      },
    },
  ];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center cursor-pointer px-3 py-2.5 transition-colors"
      onClick={onSelect}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = token.colorFillQuaternary;
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = isSelected ? token.colorPrimaryBg : '';
      }}
    >
      <div
        {...attributes}
        {...listeners}
        className="flex items-center mr-2 cursor-grab"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={14} style={{ color: token.colorTextQuaternary }} />
      </div>
      <div style={{ marginRight: 8 }}>
        <NamespaceIcon ns={ns} size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <span style={{ color: isSelected ? token.colorPrimary : undefined }}>{ns.name}</span>
      </div>
      <Tag
        color={ns.embeddingProvider ? 'green' : 'default'}
        style={{ marginRight: 4, fontSize: 11 }}
      >
        {ns.embeddingProvider ? t('settings.memory.vectorReady', '就绪') : t('settings.memory.vectorNotConfigured', '未配置')}
      </Tag>
      <Dropdown menu={{ items: menuItems }} trigger={['click']}>
        <Button
          type="text"
          size="small"
          icon={<MoreHorizontal size={14} />}
          onClick={(e) => e.stopPropagation()}
        />
      </Dropdown>
    </div>
  );
}

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
  const reorderNamespaces = useMemoryStore((s) => s.reorderNamespaces);
  const deleteNamespace = useMemoryStore((s) => s.deleteNamespace);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = namespaces.findIndex((n) => n.id === active.id);
    const newIndex = namespaces.findIndex((n) => n.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = [...namespaces];
    const [moved] = newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, moved);
    reorderNamespaces(newOrder.map((n) => n.id));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {namespaces.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.memory.empty', '暂无命名空间')} />
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={namespaces.map((n) => n.id)} strategy={verticalListSortingStrategy}>
              {namespaces.map((ns) => (
                <SortableNamespaceItem
                  key={ns.id}
                  ns={ns}
                  isSelected={selectedId === ns.id}
                  onSelect={() => onSelect(ns.id)}
                  onDelete={() => deleteNamespace(ns.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
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
  const { items, loading, loadItems, addItem, deleteItem, updateItem, updateNamespace } = useMemoryStore();
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MemoryItem | null>(null);
  const [itemForm] = Form.useForm();
  const [messageApi, contextHolder] = message.useMessage();

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    name: '',
    embeddingProvider: undefined as string | undefined,
    embeddingDimensions: undefined as number | undefined,
    retrievalThreshold: undefined as number | undefined,
    retrievalTopK: undefined as number | undefined,
  });
  // Track original embedding provider for change detection
  const [originalProvider, setOriginalProvider] = useState<string | undefined>(undefined);

  // Pending embedding provider change (for confirmation)
  const [pendingProvider, setPendingProvider] = useState<string | undefined>(undefined);
  const [providerConfirmOpen, setProviderConfirmOpen] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<VectorSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Index status
  const [rebuildingIndex, setRebuildingIndex] = useState(false);
  const rebuildingRef = useRef(false);

  useEffect(() => {
    loadItems(namespace.id);
  }, [namespace.id, loadItems]);

  // Listen for indexing events
  useEffect(() => {
    const unlistenIndexed = listen<{ itemId: string; success: boolean; status?: string; error?: string; isRebuild?: boolean }>(
      'memory-item-indexed',
      () => {
        loadItems(namespace.id);
      },
    );
    const unlistenRebuild = listen<{ namespaceId: string }>(
      'memory-rebuild-complete',
      (event) => {
        if (event.payload.namespaceId === namespace.id) {
          setRebuildingIndex(false);
          rebuildingRef.current = false;
          loadItems(namespace.id);
        }
      },
    );
    return () => {
      unlistenIndexed.then((fn) => fn());
      unlistenRebuild.then((fn) => fn());
    };
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

  const handleEditItem = async () => {
    if (!editingItem) return;
    try {
      const values = await itemForm.validateFields();
      await updateItem(namespace.id, editingItem.id, {
        content: values.content,
        title: values.content.slice(0, 50),
      });
      setEditingItem(null);
      itemForm.resetFields();
      messageApi.success(t('settings.memory.updateSuccess', '更新成功'));
    } catch {
      // validation error
    }
  };

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !namespace.embeddingProvider) return;
    setSearching(true);
    try {
      const results = await invoke<VectorSearchResult[]>('search_memory', {
        namespaceId: namespace.id,
        query: searchQuery,
        topK: 5,
      });
      setSearchResults([...results].sort((a, b) => a.score - b.score));
    } catch (e) {
      messageApi.error(String(e));
    } finally {
      setSearching(false);
    }
  }, [searchQuery, namespace.id, namespace.embeddingProvider, messageApi]);

  const itemColumns = [
    {
      title: t('settings.memory.itemContent'),
      dataIndex: 'content',
      key: 'content',
      ellipsis: { showTitle: true },
    },
    {
      title: t('settings.memory.indexStatusLabel', '索引状态'),
      dataIndex: 'indexStatus',
      key: 'indexStatus',
      width: 100,
      render: (status: string, record: MemoryItem) => {
        const cfg = INDEX_STATUS_CONFIG[status] || INDEX_STATUS_CONFIG.pending;
        const tag = (
          <Tag color={cfg.color} style={{ fontSize: 11 }}>
            {status === 'indexing' && <Spin size="small" style={{ marginRight: 4 }} />}
            {t(cfg.labelKey)}
          </Tag>
        );
        if (status === 'failed' && record.indexError) {
          return <Tooltip title={record.indexError}>{tag}</Tooltip>;
        }
        return tag;
      },
    },
    {
      title: t('settings.memory.source'),
      dataIndex: 'source',
      key: 'source',
      width: 90,
      render: (source: MemorySource) => (
        <Tag color={SOURCE_TAG_COLOR[source]}>
          {t(`settings.memory.${source === 'auto_extract' ? 'autoExtract' : 'manual'}`)}
        </Tag>
      ),
    },
    {
      key: 'actions',
      width: 120,
      render: (_: unknown, record: MemoryItem) => (
        <div className="flex gap-1">
          <Tooltip title={t('settings.memory.editItem', '编辑')}>
            <Button
              size="small"
              type="text"
              icon={<Pencil size={14} />}
              onClick={() => {
                setEditingItem(record);
                itemForm.setFieldsValue({ content: record.content });
              }}
            />
          </Tooltip>
          <Popconfirm
            title={t('settings.memory.rebuildItemConfirm', '确定重新索引该记录？')}
            placement="bottom"
            onConfirm={async () => {
              await invoke('reindex_memory_item', { namespaceId: namespace.id, itemId: record.id }).catch((e) => {
                messageApi.error(String(e));
              });
              loadItems(namespace.id);
            }}
          >
            <Tooltip title={t('settings.memory.reindexItem', '重新索引')}>
              <Button
                size="small"
                type="text"
                icon={<Zap size={14} />}
                loading={record.indexStatus === 'indexing'}
                disabled={!namespace.embeddingProvider}
              />
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            title={t('settings.memory.deleteConfirm')}
            onConfirm={() => deleteItem(namespace.id, record.id)}
          >
            <Button size="small" danger type="text" icon={<Trash2 size={14} />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 pb-12 overflow-y-auto h-full">
      {contextHolder}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <IconEditor
            iconType={namespace.iconType}
            iconValue={namespace.iconValue}
            onChange={(type, value) => updateNamespace(namespace.id, { iconType: type ?? undefined, iconValue: value ?? undefined, updateIcon: true })}
            size={28}
            defaultIcon={<NamespaceIcon ns={namespace} size={28} />}
          />
          <span style={{ fontWeight: 600, fontSize: 16 }}>{namespace.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <Tag
            color={namespace.embeddingProvider ? 'green' : 'default'}
            style={{ fontSize: 12 }}
          >
            {namespace.embeddingProvider ? t('settings.memory.vectorReady', '就绪') : t('settings.memory.vectorNotConfigured', '未配置')}
          </Tag>
          <Tooltip title={t('settings.memory.namespaceSettings', '命名空间设置')}>
            <Button
              size="small"
              type="text"
              icon={<Settings size={14} />}
              onClick={() => {
                setSettingsForm({
                  name: namespace.name,
                  embeddingProvider: namespace.embeddingProvider ?? undefined,
                  embeddingDimensions: namespace.embeddingDimensions ?? undefined,
                  retrievalThreshold: namespace.retrievalThreshold ?? 0.1,
                  retrievalTopK: namespace.retrievalTopK ?? 5,
                });
                setOriginalProvider(namespace.embeddingProvider ?? undefined);
                setSettingsOpen(true);
              }}
            />
          </Tooltip>
        </div>
      </div>

      {/* Settings Modal */}
      <Modal
        title={t('settings.memory.namespaceSettings', '命名空间设置')}
        open={settingsOpen}
        onOk={async () => {
          const providerChanged = settingsForm.embeddingProvider !== originalProvider;
          // If embedding provider changed and was previously set, show confirmation
          if (providerChanged && originalProvider) {
            setPendingProvider(settingsForm.embeddingProvider);
            setProviderConfirmOpen(true);
            return;
          }
          // Apply all settings
          await updateNamespace(namespace.id, {
            name: settingsForm.name,
            embeddingProvider: settingsForm.embeddingProvider,
            updateEmbeddingProvider: providerChanged,
            embeddingDimensions: settingsForm.embeddingDimensions,
            updateEmbeddingDimensions: true,
            retrievalThreshold: settingsForm.retrievalThreshold,
            updateRetrievalThreshold: true,
            retrievalTopK: settingsForm.retrievalTopK,
            updateRetrievalTopK: true,
          });
          setSettingsOpen(false);
        }}
        onCancel={() => setSettingsOpen(false)}
        mask={{ enabled: true, blur: true }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span>{t('settings.memory.namespaceName')}</span>
            <Input
              value={settingsForm.name}
              onChange={(e) => setSettingsForm(s => ({ ...s, name: e.target.value }))}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.memory.embeddingModel', '向量模型')}</span>
            <EmbeddingModelSelect
              value={settingsForm.embeddingProvider}
              onChange={(val) => setSettingsForm(s => ({ ...s, embeddingProvider: val || undefined }))}
              placeholder={t('settings.memory.embeddingModelPlaceholder', '选择向量模型')}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.memory.embeddingDimensions', '嵌入维度')}</span>
            <InputNumber
              value={settingsForm.embeddingDimensions}
              onChange={(val) => setSettingsForm(s => ({ ...s, embeddingDimensions: val ?? undefined }))}
              placeholder={t('settings.memory.embeddingDimensionsAuto', '自动')}
              min={1}
              max={65536}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.memory.retrievalThreshold', '检索阈值')}</span>
            <InputNumber
              value={settingsForm.retrievalThreshold}
              onChange={(val) => setSettingsForm(s => ({ ...s, retrievalThreshold: val ?? 0.1 }))}
              min={0}
              max={2}
              step={0.01}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.memory.retrievalTopK', '检索记录数')}</span>
            <InputNumber
              value={settingsForm.retrievalTopK}
              onChange={(val) => setSettingsForm(s => ({ ...s, retrievalTopK: val ?? 5 }))}
              min={1}
              max={100}
              style={{ width: 280 }}
            />
          </div>
        </div>
      </Modal>

      {/* Embedding provider change confirmation */}
      <Modal
        title={t('settings.memory.changeEmbeddingTitle', '更换向量模型')}
        open={providerConfirmOpen}
        onOk={async () => {
          await updateNamespace(namespace.id, {
            name: settingsForm.name,
            embeddingProvider: pendingProvider,
            updateEmbeddingProvider: true,
            embeddingDimensions: settingsForm.embeddingDimensions,
            updateEmbeddingDimensions: true,
            retrievalThreshold: settingsForm.retrievalThreshold,
            updateRetrievalThreshold: true,
            retrievalTopK: settingsForm.retrievalTopK,
            updateRetrievalTopK: true,
          });
          setProviderConfirmOpen(false);
          setPendingProvider(undefined);
          setSettingsOpen(false);
          // Trigger rebuild
          if (pendingProvider) {
            setRebuildingIndex(true);
            invoke('rebuild_memory_index', { namespaceId: namespace.id }).catch((e) => {
              setRebuildingIndex(false);
              messageApi.error(String(e));
            });
          }
        }}
        onCancel={() => { setProviderConfirmOpen(false); setPendingProvider(undefined); }}
        okButtonProps={{ danger: true }}
        mask={{ enabled: true, blur: true }}
      >
        <p>{t('settings.memory.changeEmbeddingWarning', '更换向量模型后，该命名空间下所有记忆条目将自动重新进行向量索引。此操作不可撤销，是否继续？')}</p>
      </Modal>

      {/* Toolbar: add + rebuild on left, search + clear on right */}
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-2">
          <Tooltip title={t('settings.memory.addItem', '添加')}>
            <Button icon={<Plus size={14} />} onClick={() => {
              setEditingItem(null);
              itemForm.resetFields();
              setItemModalOpen(true);
            }} />
          </Tooltip>
          <Popconfirm
            title={t('settings.memory.rebuildIndexConfirm', '确定重建索引？将重新生成所有记录的向量嵌入。')}
            placement="bottom"
            onConfirm={async () => {
              setRebuildingIndex(true);
              rebuildingRef.current = true;
              try {
                await invoke('rebuild_memory_index', { namespaceId: namespace.id });
                loadItems(namespace.id);
              } catch (e) {
                setRebuildingIndex(false);
                rebuildingRef.current = false;
                messageApi.error(String(e));
              }
            }}
          >
            <Tooltip title={t('settings.memory.rebuildIndex', '重建索引')}>
              <Button
                icon={<Zap size={14} />}
                loading={rebuildingIndex}
                disabled={!namespace.embeddingProvider}
              />
            </Tooltip>
          </Popconfirm>
        </div>
        <div className="flex items-center gap-2">
          {namespace.embeddingProvider && (
            <>
              <Input
                placeholder={t('settings.memory.searchPlaceholder', '检索记忆...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onPressEnter={handleSearch}
                style={{ width: 200 }}
                allowClear
                onClear={() => setSearchResults(null)}
              />
              <Tooltip title={t('settings.memory.search', '搜索')}>
                <Button
                  icon={<Search size={14} />}
                  loading={searching}
                  onClick={handleSearch}
                  disabled={!searchQuery.trim()}
                />
              </Tooltip>
            </>
          )}
          <Popconfirm
            title={t('settings.memory.clearIndexConfirm', '确定清空所有索引？此操作不可撤销。')}
            onConfirm={async () => {
              try {
                await invoke('clear_memory_index', { namespaceId: namespace.id });
                loadItems(namespace.id);
                messageApi.success(t('settings.memory.clearSuccess', '索引已清空'));
              } catch (e) {
                messageApi.error(String(e));
              }
            }}
          >
            <Tooltip title={t('settings.memory.clearIndex', '清空索引')}>
              <Button
                danger
                icon={<Trash size={14} />}
                disabled={!namespace.embeddingProvider}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      </div>

      {/* Search results */}
      <Modal
        title={`${t('settings.memory.searchResults', '搜索结果')} (${searchResults?.length || 0})`}
        open={searchResults !== null}
        onCancel={() => setSearchResults(null)}
        footer={null}
        width={700}
        mask={{ enabled: true, blur: true }}
      >
        {searchResults && searchResults.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.memory.noResults', '无匹配结果')} />
        ) : (
          <Table
            dataSource={searchResults || []}
            rowKey={(_, i) => String(i)}
            pagination={{ pageSize: 10, size: 'small' }}
            size="small"
            bordered
            columns={[
              {
                title: 'ID',
                dataIndex: 'document_id',
                key: 'document_id',
                width: 100,
                ellipsis: true,
                render: (id: string) => <span style={{ fontSize: 12 }}>{id.slice(0, 8)}</span>,
              },
              {
                title: t('settings.memory.itemContent', '内容'),
                dataIndex: 'content',
                key: 'content',
                ellipsis: { showTitle: false },
                render: (content: string) => (
                  <Typography.Paragraph
                    ellipsis={{ rows: 2 }}
                    style={{ margin: 0, fontSize: 13 }}
                  >
                    {content}
                  </Typography.Paragraph>
                ),
              },
              {
                title: t('settings.memory.similarity', '相似度'),
                dataIndex: 'score',
                key: 'score',
                width: 90,
                defaultSortOrder: 'ascend' as const,
                sorter: (a: VectorSearchResult, b: VectorSearchResult) => a.score - b.score,
                render: (score: number) => (
                  <Tag color="blue" style={{ fontSize: 11 }}>{(1 / (1 + score)).toFixed(4)}</Tag>
                ),
              },
            ]}
          />
        )}
      </Modal>

      <Table
        dataSource={items}
        columns={itemColumns}
        rowKey="id"
        pagination={false}
        loading={loading}
        size="small"
        bordered
      />

      {/* Add / Edit Modal */}
      <Modal
        title={editingItem ? t('settings.memory.editItem', '编辑记忆') : t('settings.memory.addItem')}
        open={itemModalOpen || !!editingItem}
        onOk={editingItem ? handleEditItem : handleAddItem}
        onCancel={() => { setItemModalOpen(false); setEditingItem(null); itemForm.resetFields(); }}
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
