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
  Popconfirm,
  Empty,
  Divider,
  Dropdown,
  theme,
  message,
  Tooltip,
  Spin,
} from 'antd';
import type { MenuProps } from 'antd';
import { Plus, Trash2, Trash, Settings, GripVertical, MoreHorizontal, Search, FileText, Zap, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useKnowledgeStore } from '@/stores';
import { EmbeddingModelSelect } from '@/components/shared/EmbeddingModelSelect';
import { IconEditor } from '@/components/shared/IconEditor';
import { KnowledgeBaseIcon } from '@/components/shared/KnowledgeBaseIcon';
import { invoke } from '@/lib/invoke';
import type { KnowledgeBase, KnowledgeDocument, IndexingStatus } from '@/types';
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

const INDEX_STATUS_CONFIG: Record<string, { color: string; labelKey: string }> = {
  pending: { color: 'default', labelKey: 'settings.indexStatus.pending' },
  indexing: { color: 'processing', labelKey: 'settings.indexStatus.indexing' },
  ready: { color: 'success', labelKey: 'settings.indexStatus.indexed' },
  failed: { color: 'error', labelKey: 'settings.indexStatus.failed' },
};

// ── Sortable Knowledge Base Item ─────────────────────────

function SortableKnowledgeBaseItem({
  kb,
  isSelected,
  onSelect,
  onDelete,
}: {
  kb: KnowledgeBase;
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
  } = useSortable({ id: kb.id });

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
      label: t('settings.knowledge.deleteKnowledgeBase', '删除知识库'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: (e) => {
        e.domEvent.stopPropagation();
        Modal.confirm({
          title: t('settings.knowledge.deleteConfirm'),
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
        <KnowledgeBaseIcon kb={kb} size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <span style={{ color: isSelected ? token.colorPrimary : undefined }}>{kb.name}</span>
      </div>
      <Tag
        color={kb.embeddingProvider ? 'green' : 'default'}
        style={{ marginRight: 4, fontSize: 11 }}
      >
        {kb.embeddingProvider ? t('settings.knowledge.vectorReady', '就绪') : t('settings.knowledge.vectorNotConfigured', '未配置')}
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
  const reorderBases = useKnowledgeStore((s) => s.reorderBases);
  const deleteBase = useKnowledgeStore((s) => s.deleteBase);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = bases.findIndex((b) => b.id === active.id);
    const newIndex = bases.findIndex((b) => b.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = [...bases];
    const [moved] = newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, moved);
    reorderBases(newOrder.map((b) => b.id));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {bases.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.knowledge.empty', '暂无知识库')} />
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={bases.map((b) => b.id)} strategy={verticalListSortingStrategy}>
              {bases.map((kb) => (
                <SortableKnowledgeBaseItem
                  key={kb.id}
                  kb={kb}
                  isSelected={selectedId === kb.id}
                  onSelect={() => onSelect(kb.id)}
                  onDelete={() => deleteBase(kb.id)}
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
          {t('settings.knowledge.add')}
        </Button>
      </div>
    </div>
  );
}

// ── Right Panel: Knowledge Base Detail ────────────────────

interface VectorSearchResult {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  score: number;
  has_embedding: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function KnowledgeBaseDetail({
  base,
}: {
  base: KnowledgeBase;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { documents, loading, updateBase, loadDocuments, addDocument, deleteDocument } =
    useKnowledgeStore();
  const [messageApi, contextHolder] = message.useMessage();

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    name: '',
    embeddingProvider: undefined as string | undefined,
    description: '' as string | undefined,
    embeddingDimensions: undefined as number | undefined,
    retrievalThreshold: undefined as number | undefined,
    retrievalTopK: undefined as number | undefined,
    chunkSize: undefined as number | undefined,
    chunkOverlap: undefined as number | undefined,
    separator: undefined as string | undefined,
  });
  const [originalProvider, setOriginalProvider] = useState<string | undefined>(undefined);
  const [pendingProvider, setPendingProvider] = useState<string | undefined>(undefined);
  const [providerConfirmOpen, setProviderConfirmOpen] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<VectorSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Chunks modal state
  const [chunksModalOpen, setChunksModalOpen] = useState(false);
  const [chunksDocTitle, setChunksDocTitle] = useState('');
  const [chunksDocId, setChunksDocId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<VectorSearchResult[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);

  // Chunk view/edit modal state
  const [chunkViewOpen, setChunkViewOpen] = useState(false);
  const [chunkViewContent, setChunkViewContent] = useState('');
  const [chunkViewId, setChunkViewId] = useState<string | null>(null);
  const [chunkEditing, setChunkEditing] = useState(false);
  const [chunkSaving, setChunkSaving] = useState(false);

  // Add chunk state
  const [addChunkOpen, setAddChunkOpen] = useState(false);
  const [addChunkContent, setAddChunkContent] = useState('');
  const [addChunkSaving, setAddChunkSaving] = useState(false);
  const [addChunkDocId, setAddChunkDocId] = useState<string | null>(null);

  // Rebuild state
  const [rebuildingIndex, setRebuildingIndex] = useState(false);
  const rebuildingRef = useRef(false);
  const [reindexingChunkIds, setReindexingChunkIds] = useState<Set<string>>(new Set());
  const [rebuildingDocIds, setRebuildingDocIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadDocuments(base.id);
  }, [base.id, loadDocuments]);

  // Listen for indexing completion events to refresh document status in real-time
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenChunk: (() => void) | undefined;
    let unlistenRebuild: (() => void) | undefined;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ documentId: string; success: boolean }>('knowledge-document-indexed', (event) => {
        loadDocuments(base.id);
        setRebuildingDocIds(prev => {
          const next = new Set(prev);
          next.delete(event.payload.documentId);
          return next;
        });
      });
      unlistenChunk = await listen<{ chunkId: string; success: boolean }>('knowledge-chunk-reindexed', (event) => {
        setReindexingChunkIds(prev => {
          const next = new Set(prev);
          next.delete(event.payload.chunkId);
          return next;
        });
        if (event.payload.success) {
          setChunks(prev => prev.map(c =>
            c.id === event.payload.chunkId ? { ...c, has_embedding: true } : c
          ));
        }
      });
      unlistenRebuild = await listen<{ baseId: string }>('knowledge-rebuild-complete', () => {
        loadDocuments(base.id);
        if (rebuildingRef.current) {
          setRebuildingIndex(false);
          rebuildingRef.current = false;
        }
      });
    })();
    return () => { unlisten?.(); unlistenChunk?.(); unlistenRebuild?.(); };
  }, [base.id, loadDocuments]);

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

  const handleAddDocuments = useCallback(async () => {
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
      loadDocuments(base.id);
    } catch {
      // user cancelled or error
    }
  }, [base.id, addDocument, loadDocuments, t]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !base.embeddingProvider) return;
    setSearching(true);
    try {
      const results = await invoke<VectorSearchResult[]>('search_knowledge_base', {
        baseId: base.id,
        query: searchQuery,
        topK: 5,
      });
      setSearchResults([...results].sort((a, b) => a.score - b.score));
    } catch (e) {
      messageApi.error(String(e));
    } finally {
      setSearching(false);
    }
  }, [searchQuery, base.id, base.embeddingProvider, messageApi]);

  const handleViewChunks = useCallback(async (doc: KnowledgeDocument) => {
    setChunksDocTitle(doc.title);
    setChunksDocId(doc.id);
    setChunksModalOpen(true);
    setChunksLoading(true);
    try {
      const result = await invoke<VectorSearchResult[]>('list_knowledge_document_chunks', {
        baseId: base.id,
        documentId: doc.id,
      });
      setChunks(result);
    } catch (e) {
      messageApi.error(String(e));
      setChunks([]);
    } finally {
      setChunksLoading(false);
    }
  }, [base.id, messageApi]);

  const handleRebuildIndex = useCallback(async () => {
    if (rebuildingRef.current) return; // Prevent double-click
    setRebuildingIndex(true);
    rebuildingRef.current = true;
    try {
      await invoke('rebuild_knowledge_index', { baseId: base.id });
      loadDocuments(base.id);
    } catch (e) {
      setRebuildingIndex(false);
      rebuildingRef.current = false;
      messageApi.error(String(e));
    }
  }, [base.id, loadDocuments, messageApi]);

  const docColumns = [
    {
      title: t('settings.knowledge.name'),
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
    },
    {
      title: t('settings.knowledge.size', '大小'),
      dataIndex: 'sizeBytes',
      key: 'sizeBytes',
      width: 90,
      render: (bytes: number) => <span style={{ fontSize: 12 }}>{formatBytes(bytes)}</span>,
    },
    {
      title: t('settings.knowledge.docType', '类型'),
      dataIndex: 'docType',
      key: 'docType',
      width: 80,
      render: (docType: string) => (
        <Tag style={{ fontSize: 11 }}>
          {t(`settings.knowledge.docType${docType.charAt(0).toUpperCase() + docType.slice(1)}`, docType)}
        </Tag>
      ),
    },
    {
      title: t('settings.knowledge.statusLabel', '状态'),
      dataIndex: 'indexingStatus',
      key: 'indexingStatus',
      width: 100,
      render: (status: IndexingStatus, record: KnowledgeDocument) => {
        const cfg = INDEX_STATUS_CONFIG[status] || INDEX_STATUS_CONFIG.pending;
        const tag = (
          <Tag color={cfg.color} style={{ fontSize: 11, cursor: status === 'failed' && record.indexError ? 'pointer' : undefined }}>
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
      key: 'actions',
      width: 120,
      render: (_: unknown, record: KnowledgeDocument) => (
        <div className="flex items-center gap-1">
          <Tooltip title={t('settings.knowledge.viewChunks', '分段')}>
            <Button
              size="small"
              type="text"
              icon={<FileText size={14} />}
              disabled={record.indexingStatus === 'indexing'}
              onClick={() => handleViewChunks(record)}
            />
          </Tooltip>
          <Popconfirm
            title={t('settings.knowledge.rebuildDocConfirm', '确定重建该文档的索引？')}
            placement="bottom"
            onConfirm={async () => {
              if (rebuildingDocIds.has(record.id)) return;
              setRebuildingDocIds(prev => new Set(prev).add(record.id));
              try {
                await invoke('rebuild_knowledge_document', { baseId: base.id, documentId: record.id });
                loadDocuments(base.id);
              } catch (e) {
                setRebuildingDocIds(prev => { const next = new Set(prev); next.delete(record.id); return next; });
                messageApi.error(String(e));
              }
            }}
          >
            <Tooltip title={t('settings.knowledge.rebuildDocIndex', '重建索引')}>
              <Button
                size="small"
                type="text"
                icon={<Zap size={14} />}
                loading={record.indexingStatus === 'indexing' || rebuildingDocIds.has(record.id)}
                disabled={!base.embeddingProvider}
              />
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            title={t('settings.knowledge.deleteDocConfirm')}
            onConfirm={() => deleteDocument(base.id, record.id)}
          >
            <Button size="small" type="text" danger icon={<Trash2 size={14} />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  // Chunks table columns
  const chunkColumns = [
    {
      title: t('settings.knowledge.chunkIndex', '序号'),
      dataIndex: 'chunk_index',
      key: 'chunk_index',
      width: 70,
      render: (idx: number) => <Tag style={{ fontSize: 11 }}>#{idx}</Tag>,
    },
    {
      title: t('settings.knowledge.chunkContent', '内容'),
      dataIndex: 'content',
      key: 'content',
      ellipsis: { showTitle: false },
      render: (content: string, record: VectorSearchResult) => (
        <Typography.Paragraph
          ellipsis={{ rows: 2 }}
          style={{ margin: 0, fontSize: 13, cursor: 'pointer' }}
          onClick={() => {
            setChunkViewId(record.id);
            setChunkViewContent(content);
            setChunkEditing(false);
            setChunkViewOpen(true);
          }}
        >
          {content}
        </Typography.Paragraph>
      ),
    },
    {
      title: t('settings.knowledge.statusLabel', '状态'),
      key: 'indexStatus',
      width: 100,
      render: (_: unknown, record: VectorSearchResult) => {
        if (reindexingChunkIds.has(record.id)) {
          return (
            <Tag color="processing" style={{ fontSize: 11 }}>
              <Spin size="small" style={{ marginRight: 4 }} />
              {t('settings.knowledge.indexStatusIndexing', '索引中')}
            </Tag>
          );
        }
        if (record.has_embedding) {
          return (
            <Tag color="success" style={{ fontSize: 11 }}>
              {t('settings.knowledge.indexStatusReady', '已索引')}
            </Tag>
          );
        }
        return (
          <Tag color="default" style={{ fontSize: 11 }}>
            {t('settings.knowledge.indexStatusPending', '未索引')}
          </Tag>
        );
      },
    },
    {
      title: t('settings.knowledge.chars', '字符'),
      key: 'charCount',
      width: 80,
      render: (_: unknown, record: VectorSearchResult) => (
        <span style={{ fontSize: 12 }}>{record.content.length}</span>
      ),
    },
    {
      key: 'actions',
      width: 120,
      render: (_: unknown, record: VectorSearchResult) => (
        <div className="flex items-center gap-1">
          <Tooltip title={t('settings.knowledge.editChunk', '编辑')}>
            <Button
              size="small"
              type="text"
              icon={<Pencil size={14} />}
              onClick={() => {
                setChunkViewId(record.id);
                setChunkViewContent(record.content);
                setChunkEditing(true);
                setChunkViewOpen(true);
              }}
            />
          </Tooltip>
          <Popconfirm
            title={t('settings.knowledge.rebuildChunkConfirm', '确定重新索引该分段？')}
            placement="bottom"
            onConfirm={async () => {
              setReindexingChunkIds(prev => new Set(prev).add(record.id));
              try {
                await invoke('reindex_knowledge_chunk', { baseId: base.id, chunkId: record.id });
              } catch (e) {
                setReindexingChunkIds(prev => {
                  const next = new Set(prev);
                  next.delete(record.id);
                  return next;
                });
                messageApi.error(String(e));
              }
            }}
          >
            <Tooltip title={t('settings.knowledge.rebuildDocIndex', '重建索引')}>
              <Button
                size="small"
                type="text"
                icon={<Zap size={14} />}
                loading={reindexingChunkIds.has(record.id)}
                disabled={!base.embeddingProvider}
              />
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            title={t('settings.knowledge.deleteChunkConfirm', '确定删除此分段？')}
            onConfirm={async () => {
              try {
                await invoke('delete_knowledge_chunk', { baseId: base.id, chunkId: record.id });
                setChunks(prev => prev.filter(c => c.id !== record.id));
              } catch (e) {
                messageApi.error(String(e));
              }
            }}
          >
            <Button size="small" type="text" danger icon={<Trash2 size={14} />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 pb-12 overflow-y-auto h-full">
      {contextHolder}
      {/* Header: Icon + Name + Tag + Settings */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <IconEditor
            iconType={base.iconType}
            iconValue={base.iconValue}
            onChange={(type, value) => updateBase(base.id, { iconType: type, iconValue: value, updateIcon: true })}
            size={28}
            defaultIcon={<KnowledgeBaseIcon kb={base} size={28} />}
          />
          <span style={{ fontWeight: 600, fontSize: 16 }}>{base.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <Tag
            color={base.embeddingProvider ? 'green' : 'default'}
            style={{ fontSize: 12 }}
          >
            {base.embeddingProvider ? t('settings.knowledge.vectorReady', '就绪') : t('settings.knowledge.vectorNotConfigured', '未配置')}
          </Tag>
          <Tooltip title={t('settings.knowledge.knowledgeBaseSettings', '知识库设置')}>
            <Button
              size="small"
              type="text"
              icon={<Settings size={14} />}
              onClick={() => {
                setSettingsForm({
                  name: base.name,
                  embeddingProvider: base.embeddingProvider ?? undefined,
                  description: base.description ?? '',
                  embeddingDimensions: base.embeddingDimensions ?? undefined,
                  retrievalThreshold: base.retrievalThreshold ?? 0.1,
                  retrievalTopK: base.retrievalTopK ?? 5,
                  chunkSize: base.chunkSize ?? undefined,
                  chunkOverlap: base.chunkOverlap ?? undefined,
                  separator: base.separator ?? undefined,
                });
                setOriginalProvider(base.embeddingProvider ?? undefined);
                setSettingsOpen(true);
              }}
            />
          </Tooltip>
        </div>
      </div>

      {/* Settings Modal */}
      <Modal
        title={t('settings.knowledge.knowledgeBaseSettings', '知识库设置')}
        open={settingsOpen}
        onOk={async () => {
          const providerChanged = settingsForm.embeddingProvider !== originalProvider;
          if (providerChanged && originalProvider) {
            setPendingProvider(settingsForm.embeddingProvider);
            setProviderConfirmOpen(true);
            return;
          }
          await updateBase(base.id, {
            name: settingsForm.name,
            description: settingsForm.description || undefined,
            embeddingProvider: settingsForm.embeddingProvider,
            embeddingDimensions: settingsForm.embeddingDimensions,
            updateEmbeddingDimensions: true,
            retrievalThreshold: settingsForm.retrievalThreshold,
            updateRetrievalThreshold: true,
            retrievalTopK: settingsForm.retrievalTopK,
            updateRetrievalTopK: true,
            chunkSize: settingsForm.chunkSize,
            updateChunkSize: true,
            chunkOverlap: settingsForm.chunkOverlap,
            updateChunkOverlap: true,
            separator: settingsForm.separator,
            updateSeparator: true,
          });
          setSettingsOpen(false);
        }}
        onCancel={() => setSettingsOpen(false)}
        mask={{ enabled: true, blur: true }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.name')}</span>
            <Input
              value={settingsForm.name}
              onChange={(e) => setSettingsForm(s => ({ ...s, name: e.target.value }))}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.embeddingModel')}</span>
            <EmbeddingModelSelect
              value={settingsForm.embeddingProvider}
              onChange={(val) => setSettingsForm(s => ({ ...s, embeddingProvider: val || undefined }))}
              placeholder={t('settings.knowledge.embeddingModelPlaceholder')}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.embeddingDimensions', '嵌入维度')}</span>
            <InputNumber
              value={settingsForm.embeddingDimensions}
              onChange={(val) => setSettingsForm(s => ({ ...s, embeddingDimensions: val ?? undefined }))}
              placeholder={t('settings.knowledge.embeddingDimensionsAuto', '自动')}
              min={1}
              max={65536}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.retrievalThreshold', '检索阈值')}</span>
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
            <span>{t('settings.knowledge.retrievalTopK', '检索记录数')}</span>
            <InputNumber
              value={settingsForm.retrievalTopK}
              onChange={(val) => setSettingsForm(s => ({ ...s, retrievalTopK: val ?? 5 }))}
              min={1}
              max={100}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('settings.knowledge.chunkingConfig', '分段配置')}
          </Typography.Text>
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.chunkSize', '分段大小')}</span>
            <InputNumber
              value={settingsForm.chunkSize}
              onChange={(val) => setSettingsForm(s => ({ ...s, chunkSize: val ?? undefined }))}
              placeholder="2000"
              min={100}
              max={100000}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.chunkOverlap', '重叠大小')}</span>
            <InputNumber
              value={settingsForm.chunkOverlap}
              onChange={(val) => setSettingsForm(s => ({ ...s, chunkOverlap: val ?? undefined }))}
              placeholder="200"
              min={0}
              max={10000}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex items-center justify-between">
            <span>{t('settings.knowledge.separator', '自定义分隔符')}</span>
            <Input
              value={settingsForm.separator}
              onChange={(e) => setSettingsForm(s => ({ ...s, separator: e.target.value || undefined }))}
              placeholder={t('settings.knowledge.separatorPlaceholder', '留空使用默认策略')}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: 0 }} />
          <div className="flex flex-col gap-1">
            <span>{t('settings.knowledge.description', '描述')}</span>
            <Input.TextArea
              value={settingsForm.description}
              onChange={(e) => setSettingsForm(s => ({ ...s, description: e.target.value }))}
              rows={3}
              placeholder={t('settings.knowledge.descriptionPlaceholder', '可选的知识库描述')}
            />
          </div>
        </div>
      </Modal>

      {/* Embedding provider change confirmation */}
      <Modal
        title={t('settings.knowledge.changeEmbeddingTitle', '更换向量模型')}
        open={providerConfirmOpen}
        onOk={async () => {
          await updateBase(base.id, {
            name: settingsForm.name,
            description: settingsForm.description || undefined,
            embeddingProvider: pendingProvider,
            embeddingDimensions: settingsForm.embeddingDimensions,
            updateEmbeddingDimensions: true,
            retrievalThreshold: settingsForm.retrievalThreshold,
            updateRetrievalThreshold: true,
            retrievalTopK: settingsForm.retrievalTopK,
            updateRetrievalTopK: true,
            chunkSize: settingsForm.chunkSize,
            updateChunkSize: true,
            chunkOverlap: settingsForm.chunkOverlap,
            updateChunkOverlap: true,
            separator: settingsForm.separator,
            updateSeparator: true,
          });
          setProviderConfirmOpen(false);
          setPendingProvider(undefined);
          setSettingsOpen(false);
          if (pendingProvider) {
            rebuildingRef.current = true;
            invoke('rebuild_knowledge_index', { baseId: base.id }).catch((e) => {
              rebuildingRef.current = false;
              messageApi.error(String(e));
            });
          }
        }}
        onCancel={() => { setProviderConfirmOpen(false); setPendingProvider(undefined); }}
        okButtonProps={{ danger: true }}
        mask={{ enabled: true, blur: true }}
      >
        <p>{t('settings.knowledge.changeEmbeddingWarning', '更换向量模型后，该知识库下所有文档将自动重新进行向量索引。此操作不可撤销，是否继续？')}</p>
      </Modal>

      {/* Toolbar: add + rebuild on left, search + clear on right */}
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-2">
          <Tooltip title={t('settings.knowledge.addDocument')}>
            <Button icon={<Plus size={14} />} onClick={handleAddDocuments} />
          </Tooltip>
          <Popconfirm
            title={t('settings.knowledge.rebuildIndexConfirm', '确定重建索引？将重新生成所有分段的向量嵌入。')}
            placement="bottom"
            onConfirm={handleRebuildIndex}
          >
            <Tooltip title={t('settings.knowledge.rebuildIndex', '重建索引')}>
              <Button
                icon={<Zap size={14} />}
                loading={rebuildingIndex}
                disabled={!base.embeddingProvider}
              />
            </Tooltip>
          </Popconfirm>
        </div>
        <div className="flex items-center gap-2">
          {base.embeddingProvider && (
            <>
              <Input
                placeholder={t('settings.knowledge.searchPlaceholder', '检索知识库...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onPressEnter={handleSearch}
                style={{ width: 200 }}
                allowClear
                onClear={() => setSearchResults(null)}
              />
              <Tooltip title={t('settings.knowledge.search', '搜索')}>
                <Button
                  icon={<Search size={14} />}
                  loading={searching}
                  onClick={handleSearch}
                />
              </Tooltip>
            </>
          )}
          <Popconfirm
            title={t('settings.knowledge.clearIndexConfirm', '确定清空所有索引？此操作不可撤销。')}
            onConfirm={async () => {
              try {
                await invoke('clear_knowledge_index', { baseId: base.id });
                loadDocuments(base.id);
                messageApi.success(t('settings.knowledge.clearSuccess', '索引已清空'));
              } catch (e) {
                messageApi.error(String(e));
              }
            }}
          >
            <Tooltip title={t('settings.knowledge.clearIndex', '清空索引')}>
              <Button
                icon={<Trash size={14} />}
                danger
                disabled={!base.embeddingProvider}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      </div>

      {/* Search Results */}
      <Modal
        title={`${t('settings.knowledge.searchResults', '检索结果')} (${searchResults?.length || 0})`}
        open={searchResults !== null}
        onCancel={() => setSearchResults(null)}
        footer={null}
        width={700}
        mask={{ enabled: true, blur: true }}
      >
        {searchResults && searchResults.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.knowledge.noResults', '未找到结果')} />
        ) : (
          <Table
            dataSource={searchResults || []}
            rowKey="id"
            pagination={{ pageSize: 10, size: 'small' }}
            size="small"
            bordered
            columns={[
              {
                title: t('settings.knowledge.chunkIndex', '序号'),
                dataIndex: 'chunk_index',
                key: 'chunk_index',
                width: 70,
                render: (idx: number) => <Tag style={{ fontSize: 11 }}>#{idx}</Tag>,
              },
              {
                title: t('settings.knowledge.docTitle', '文档'),
                dataIndex: 'document_id',
                key: 'document_id',
                width: 120,
                ellipsis: true,
                render: (docId: string) => {
                  const doc = documents.find(d => d.id === docId);
                  return <span style={{ fontSize: 12 }}>{doc?.title || docId.slice(0, 8)}</span>;
                },
              },
              {
                title: t('settings.knowledge.chunkContent', '内容'),
                dataIndex: 'content',
                key: 'content',
                ellipsis: { showTitle: false },
                render: (content: string) => (
                  <Typography.Paragraph
                    ellipsis={{ rows: 2 }}
                    style={{ margin: 0, fontSize: 13, cursor: 'pointer' }}
                    onClick={() => {
                      setChunkViewId(null);
                      setChunkViewContent(content);
                      setChunkEditing(false);
                      setChunkViewOpen(true);
                    }}
                  >
                    {content}
                  </Typography.Paragraph>
                ),
              },
              {
                title: t('settings.knowledge.score', '相似度'),
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
        dataSource={documents}
        columns={docColumns}
        rowKey="id"
        pagination={false}
        loading={loading}
        size="small"
        bordered
      />

      {/* Chunks Modal */}
      <Modal
        title={`${t('settings.knowledge.viewChunks', '分段')} - ${chunksDocTitle}`}
        open={chunksModalOpen}
        onCancel={() => { setChunksModalOpen(false); setChunks([]); }}
        footer={null}
        width={700}
        mask={{ enabled: true, blur: true }}
      >
        {chunksLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spin />
          </div>
        ) : chunks.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('settings.knowledge.noChunks', '暂无分段数据')}
          />
        ) : (
          <>
            <div className="flex items-center justify-between mb-3">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('settings.knowledge.totalChunks', '共 {{count}} 个分段', { count: chunks.length })}
              </Typography.Text>
              <Button
                size="small"
                icon={<Plus size={14} />}
                disabled={!base.embeddingProvider}
                onClick={() => {
                  setAddChunkDocId(chunksDocId);
                  setAddChunkContent('');
                  setAddChunkOpen(true);
                }}
              >
                {t('settings.knowledge.addChunk', '添加分段')}
              </Button>
            </div>
            <Table
              dataSource={chunks}
              columns={chunkColumns}
              rowKey="id"
              pagination={{ pageSize: 10, size: 'small' }}
              loading={chunksLoading}
              size="small"
              bordered
            />
          </>
        )}
      </Modal>

      {/* Chunk View/Edit Modal */}
      <Modal
        title={chunkEditing ? t('settings.knowledge.editChunk', '编辑') : t('settings.knowledge.viewChunks', '分段')}
        open={chunkViewOpen}
        onCancel={() => { setChunkViewOpen(false); setChunkViewId(null); setChunkSaving(false); }}
        onOk={chunkEditing ? async () => {
          if (!chunkViewId) return;
          setChunkSaving(true);
          try {
            await invoke('update_knowledge_chunk', { baseId: base.id, chunkId: chunkViewId, content: chunkViewContent });
            setChunks(prev => prev.map(c => c.id === chunkViewId ? { ...c, content: chunkViewContent } : c));
            setChunkViewOpen(false);
            // Reindex only this chunk, not the entire knowledge base
            setReindexingChunkIds(prev => new Set(prev).add(chunkViewId));
            invoke('reindex_knowledge_chunk', { baseId: base.id, chunkId: chunkViewId }).catch((e: unknown) => {
              setReindexingChunkIds(prev => {
                const next = new Set(prev);
                next.delete(chunkViewId);
                return next;
              });
              messageApi.error(String(e));
            });
          } catch (e) {
            messageApi.error(String(e));
          } finally {
            setChunkSaving(false);
          }
        } : undefined}
        footer={chunkEditing ? undefined : null}
        confirmLoading={chunkSaving}
        width={600}
        mask={{ enabled: true, blur: true }}
      >
        <Input.TextArea
          value={chunkViewContent}
          onChange={chunkEditing ? (e) => setChunkViewContent(e.target.value) : undefined}
          readOnly={!chunkEditing}
          autoSize={{ minRows: 8, maxRows: 20 }}
          style={{ fontSize: 13 }}
        />
      </Modal>

      {/* Add Chunk Modal */}
      <Modal
        title={t('settings.knowledge.addChunk', '添加分段')}
        open={addChunkOpen}
        onCancel={() => { setAddChunkOpen(false); setAddChunkContent(''); setAddChunkSaving(false); }}
        onOk={async () => {
          if (!addChunkDocId || !addChunkContent.trim()) return;
          setAddChunkSaving(true);
          try {
            await invoke('add_knowledge_chunk', {
              baseId: base.id,
              documentId: addChunkDocId,
              content: addChunkContent,
            });
            // Refresh chunks list
            const result = await invoke<VectorSearchResult[]>('list_knowledge_document_chunks', {
              baseId: base.id,
              documentId: addChunkDocId,
            });
            setChunks(result);
            setAddChunkOpen(false);
            setAddChunkContent('');
          } catch (e) {
            messageApi.error(String(e));
          } finally {
            setAddChunkSaving(false);
          }
        }}
        confirmLoading={addChunkSaving}
        width={600}
        mask={{ enabled: true, blur: true }}
      >
        <Input.TextArea
          value={addChunkContent}
          onChange={(e) => setAddChunkContent(e.target.value)}
          placeholder={t('settings.knowledge.addChunkPlaceholder', '请输入分段内容...')}
          autoSize={{ minRows: 8, maxRows: 20 }}
          style={{ fontSize: 13 }}
        />
      </Modal>
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
