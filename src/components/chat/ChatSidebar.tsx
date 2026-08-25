import { useState, useMemo, useCallback, useEffect, useRef, memo } from 'react'
import { Button, Input, App, theme, Tooltip, Checkbox, Dropdown, Empty } from 'antd'
import { MessageSquarePlus, Search, Archive, ListTodo, Trash2, Pencil, Share, Pin, PinOff, Loader, X, Undo2, ArrowLeft, FileImage, FileCode, FileType, FileText, FolderPlus, FolderOpen, GripVertical, ChevronRight, MessageSquareText, Sparkles } from 'lucide-react'
import { exportAsMarkdown, exportAsText, exportMessagesAsPNG, exportAsJSON } from '@/lib/exportChat'
import { buildExportOptions } from '@/lib/exportChatPresentation'
import { invoke } from '@/lib/invoke'
import { useUserProfileStore } from '@/stores/userProfileStore'
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc'
import type { ConversationItemType } from '@ant-design/x/es/conversations/interface'
import { useTranslation } from 'react-i18next'
import { useConversationStore, useProviderStore, useSettingsStore, useCategoryStore } from '@/stores'
import { getShortcutBinding, formatShortcutForDisplay } from '@/lib/shortcuts'
import type { ShortcutAction } from '@/lib/shortcuts'
import type { Conversation, Message, ConversationCategory } from '@/types'
import type { AvatarType } from '@/stores/userProfileStore'
import { CategoryEditModal, type CategoryEditFormData } from './CategoryEditModal'
import { ConversationIcon } from './ConversationIcon'
import { ConversationList, type ConversationMenuFactory } from './ConversationList'
import { ArchivedConversationList } from './ArchivedConversationList'
import {
  buildConversationRows,
  compareConversationOrder,
  getUncategorizedConversationGroup,
  planConversationReorder,
  UNCATEGORIZED_GROUP_ORDER,
  type ConversationListRow,
} from './conversationListModel'
import { usePageSuspendCleanup } from '@/components/layout/PageLifecycle'
import {
  DndContext,
  closestCenter,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  type CollisionDetection,
} from '@dnd-kit/core'

const categoryDragId = (categoryId: string) => `category:${categoryId}`
const conversationDragId = (conversationId: string) => `conversation:${conversationId}`

function parseNamespacedDragId(rawId: string | number): {
  type: 'category' | 'conversation' | null
  id: string
} {
  const id = String(rawId)
  if (id.startsWith('category:')) return { type: 'category', id: id.slice('category:'.length) }
  if (id.startsWith('conversation:')) return { type: 'conversation', id: id.slice('conversation:'.length) }
  return { type: null, id }
}

interface ConversationDragSnapshot {
  conversationId: string
  group: string
  categoryId: string | null
  conversationIds: string[]
  sortOrderById: Map<string, number>
}

function applyConversationOrder(conversationIds: readonly string[]) {
  const sortOrderById = new Map(conversationIds.map((id, index) => [id, index]))
  useConversationStore.setState((state) => ({
    conversations: state.conversations.map((conversation) => {
      const sortOrder = sortOrderById.get(conversation.id)
      return sortOrder === undefined
        ? conversation
        : { ...conversation, sort_order: sortOrder }
    }),
  }))
}

function restoreConversationOrder(snapshot: ConversationDragSnapshot) {
  useConversationStore.setState((state) => ({
    conversations: state.conversations.map((conversation) => {
      const sortOrder = snapshot.sortOrderById.get(conversation.id)
      return sortOrder === undefined
        ? conversation
        : { ...conversation, sort_order: sortOrder }
    }),
  }))
}

type DeleteShortcutEvent = Pick<React.MouseEvent<HTMLElement>, 'ctrlKey' | 'metaKey'>

function isDirectDeleteEvent(event?: DeleteShortcutEvent): boolean {
  return Boolean(event?.ctrlKey || event?.metaKey)
}

function getDirectDeleteShortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl'
  const platform = navigator.platform || ''
  const userAgent = navigator.userAgent || ''
  const isMac = /Mac|iPhone|iPad|iPod/i.test(platform)
    || (/Mac OS/i.test(userAgent) && !/Windows|Linux|Android/i.test(userAgent))
  return isMac ? '⌘' : 'Ctrl'
}

function ConversationTitleText({ title, className = '' }: { title: string; className?: string }) {
  const mergedClassName = ['aqbot-chat-conversation-title', className].filter(Boolean).join(' ')
  return (
    <span
      className={mergedClassName}
      title={title}
      style={{
        display: 'block',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {title}
    </span>
  )
}

const CategoryIcon = memo(function CategoryIcon({ cat, size = 14 }: { cat: ConversationCategory; size?: number }) {
  const resolvedSrc = useResolvedAvatarSrc((cat.icon_type as AvatarType) ?? 'icon', cat.icon_value ?? '')
  if (cat.icon_type === 'emoji' && cat.icon_value) {
    return <span style={{ fontSize: size - 1 }}>{cat.icon_value}</span>
  }
  if (cat.icon_type === 'url' && cat.icon_value) {
    return <img src={cat.icon_value} alt="" style={{ width: size, height: size, borderRadius: 2, objectFit: 'cover' }} />
  }
  if (cat.icon_type === 'file' && cat.icon_value) {
    const src = resolvedSrc ?? (cat.icon_value.startsWith('data:') ? cat.icon_value : undefined)
    if (src) return <img src={src} alt="" style={{ width: size, height: size, borderRadius: 2, objectFit: 'cover' }} />
  }
  return <FolderOpen size={size - 1} />
})

function SortableCategoryLabel({
  cat,
  onCreateConversation,
  onEdit,
  onDelete,
  menuActionRef,
  newConversationLabel,
  editLabel,
  deleteLabel,
  systemPromptLabel,
  disabled,
}: {
  cat: ConversationCategory
  onCreateConversation: () => void
  onEdit: () => void
  onDelete: () => void
  menuActionRef: React.MutableRefObject<boolean>
  newConversationLabel: string
  editLabel: string
  deleteLabel: string
  systemPromptLabel: string
  disabled: boolean
}) {
  const dragId = categoryDragId(cat.id)
  const dragData = { type: 'category', categoryId: cat.id }
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: dragId,
    data: dragData,
    disabled,
  })
  const { setNodeRef: setDropRef } = useDroppable({
    id: dragId,
    data: dragData,
    disabled,
  })
  const mergedRef = useCallback((node: HTMLDivElement | null) => {
    setDragRef(node)
    setDropRef(node)
  }, [setDragRef, setDropRef])

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items: [
          { key: 'new', label: newConversationLabel, icon: <MessageSquarePlus size={14} /> },
          { key: 'edit', label: editLabel, icon: <Pencil size={14} /> },
          { key: 'delete', label: deleteLabel, icon: <Trash2 size={14} />, danger: true },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation()
          menuActionRef.current = true
          setTimeout(() => { menuActionRef.current = false }, 100)
          if (key === 'new') onCreateConversation()
          else if (key === 'edit') onEdit()
          else if (key === 'delete') onDelete()
        },
      }}
    >
      <div
        ref={mergedRef}
        className="flex items-center gap-1"
        style={{ opacity: isDragging ? 0.3 : 1, cursor: 'pointer', userSelect: 'none', flex: 1 }}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={12} style={{ opacity: 0.4, cursor: 'grab', flexShrink: 0 }} />
        <CategoryIcon cat={cat} size={14} />
        <span className="truncate">{cat.name}</span>
        {cat.system_prompt && (
          <Tooltip title={systemPromptLabel}>
            <MessageSquareText size={12} style={{ opacity: 0.45, flexShrink: 0 }} />
          </Tooltip>
        )}
      </div>
    </Dropdown>
  )
}

function SortableConversationLabel({
  conversation,
  group,
  reorderLabel,
  children,
}: {
  conversation: Conversation
  group: string
  reorderLabel: string
  children: React.ReactNode
}) {
  const dragId = conversationDragId(conversation.id)
  const dragData = {
    type: 'conversation',
    conversationId: conversation.id,
    group,
  }
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id: dragId, data: dragData })
  const { setNodeRef: setDropRef } = useDroppable({
    id: dragId,
    data: dragData,
  })
  const mergedRef = useCallback((node: HTMLSpanElement | null) => {
    setDragRef(node)
    setDropRef(node)
  }, [setDragRef, setDropRef])

  return (
    <span
      ref={mergedRef}
      className="aqbot-chat-conversation-label"
      style={{ opacity: isDragging ? 0.35 : 1 }}
    >
      <span
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        aria-label={reorderLabel}
        title={reorderLabel}
        onClick={(event) => event.stopPropagation()}
        style={{
          alignItems: 'center',
          cursor: 'grab',
          display: 'inline-flex',
          flexShrink: 0,
          lineHeight: 0,
        }}
      >
        <GripVertical size={12} aria-hidden="true" style={{ opacity: 0.45 }} />
      </span>
      {children}
    </span>
  )
}

export function ChatSidebar() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message: messageApi, modal } = App.useApp()

  const conversations = useConversationStore((s) => s.conversations)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const createConversation = useConversationStore((s) => s.createConversation)
  const deleteConversation = useConversationStore((s) => s.deleteConversation)
  const updateConversation = useConversationStore((s) => s.updateConversation)
  const togglePin = useConversationStore((s) => s.togglePin)
  const toggleArchive = useConversationStore((s) => s.toggleArchive)
  const archivedConversations = useConversationStore((s) => s.archivedConversations)
  const fetchArchivedConversations = useConversationStore((s) => s.fetchArchivedConversations)
  const batchDelete = useConversationStore((s) => s.batchDelete)
  const batchArchive = useConversationStore((s) => s.batchArchive)
  const batchMoveToCategory = useConversationStore((s) => s.batchMoveToCategory)
  const reorderConversations = useConversationStore((s) => s.reorderConversations)
  const streamingConversationId = useConversationStore((s) => (
    s.streaming
      ? s.streamingConversationId
      : (s.observedStream?.streaming ? s.observedStream.conversationId : s.streamingConversationId)
  ))
  const titleGeneratingConversationId = useConversationStore((s) => s.titleGeneratingConversationId)
  const regenerateTitle = useConversationStore((s) => s.regenerateTitle)

  const providers = useProviderStore((s) => s.providers)
  const settings = useSettingsStore((s) => s.settings)
  const settingsLoading = useSettingsStore((s) => s.loading)
  const profile = useUserProfileStore((s) => s.profile)

  const categories = useCategoryStore((s) => s.categories)
  const ensureCategoriesLoaded = useCategoryStore((s) => s.ensureCategoriesLoaded)
  const createCategory = useCategoryStore((s) => s.createCategory)
  const updateCategory = useCategoryStore((s) => s.updateCategory)
  const deleteCategory = useCategoryStore((s) => s.deleteCategory)
  const setCollapsed = useCategoryStore((s) => s.setCollapsed)
  const conversationById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  )
  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  )
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )
  const dndCollisionDetection = useCallback<CollisionDetection>((args) => {
    const activeType = args.active.data.current?.type
    if (activeType !== 'category' && activeType !== 'conversation') return []
    const collisionDetection = activeType === 'conversation' ? pointerWithin : closestCenter
    return collisionDetection({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => container.data.current?.type === activeType,
      ),
    })
  }, [])

  const [activeDragCatId, setActiveDragCatId] = useState<string | null>(null)
  const [activeDragConversationId, setActiveDragConversationId] = useState<string | null>(null)
  const [conversationReorderSaving, setConversationReorderSaving] = useState(false)
  const dragInitialOrderRef = useRef<string[]>([])
  const conversationDragSnapshotRef = useRef<ConversationDragSnapshot | null>(null)
  const conversationDragPreviewOrderRef = useRef<string[] | null>(null)
  const conversationDragLastOverIdRef = useRef<string | null>(null)
  const conversationReorderSavingRef = useRef(false)
  const conversationReorderQueueRef = useRef<Promise<void>>(Promise.resolve())

  const handleCategoryDragStart = useCallback((event: DragStartEvent) => {
    const parsed = parseNamespacedDragId(event.active.id)
    const categoryId = String(event.active.data.current?.categoryId ?? parsed.id)
    setActiveDragCatId(categoryId)
    dragInitialOrderRef.current = categories.map((c) => c.id)
  }, [categories])

  const handleCategoryDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    if (active.data.current?.type !== 'category' || over.data.current?.type !== 'category') return
    const activeId = String(active.data.current.categoryId ?? parseNamespacedDragId(active.id).id)
    const overId = String(over.data.current.categoryId ?? parseNamespacedDragId(over.id).id)
    const ids = categories.map((c) => c.id)
    const oldIndex = ids.indexOf(activeId)
    const newIndex = ids.indexOf(overId)
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return
    const newIds = [...ids]
    newIds.splice(oldIndex, 1)
    newIds.splice(newIndex, 0, activeId)
    useCategoryStore.setState((s) => ({
      categories: newIds
        .map((id, i) => {
          const c = s.categories.find((cat) => cat.id === id)
          return c ? { ...c, sort_order: i } : null
        })
        .filter(Boolean) as ConversationCategory[],
    }))
  }, [categories])

  const handleCategoryDragEnd = useCallback(
    (_event: DragEndEvent) => {
      setActiveDragCatId(null)
      // Always persist current order (onDragOver already updated store)
      const ids = useCategoryStore.getState().categories.map((c) => c.id)
      void invoke('reorder_conversation_categories', { categoryIds: ids })
    },
    [],
  )

  const handleCategoryDragCancel = useCallback(() => {
    setActiveDragCatId(null)
    const initial = dragInitialOrderRef.current
    if (initial.length > 0) {
      useCategoryStore.setState((s) => ({
        categories: initial
          .map((id, i) => {
            const c = s.categories.find((cat) => cat.id === id)
            return c ? { ...c, sort_order: i } : null
          })
          .filter(Boolean) as ConversationCategory[],
      }))
    }
  }, [])

  const shortcutHint = useCallback((label: string, action: ShortcutAction) => {
    if (!settings) return label
    const binding = getShortcutBinding(settings, action)
    return `${label} (${formatShortcutForDisplay(binding)})`
  }, [settings])

  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showArchived, setShowArchived] = useState(false)
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<Set<string>>(new Set())
  const [archivedMultiSelect, setArchivedMultiSelect] = useState(false)
  const [rightClickedConvId, setRightClickedConvId] = useState<string | null>(null)
  const [categoryModalOpen, setCategoryModalOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<ConversationCategory | null>(null)
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(new Set())
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const [directDeleteMode, setDirectDeleteMode] = useState(false)
  const listScrollRef = useRef<HTMLDivElement>(null)

  usePageSuspendCleanup(() => {
    setCategoryModalOpen(false)
    setEditingCategory(null)
    setRightClickedConvId(null)
    setDirectDeleteMode(false)
  })

  useEffect(() => {
    const updateFromKeyboard = (event: KeyboardEvent) => {
      setDirectDeleteMode(event.ctrlKey || event.metaKey)
    }
    const reset = () => setDirectDeleteMode(false)

    window.addEventListener('keydown', updateFromKeyboard)
    window.addEventListener('keyup', updateFromKeyboard)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', updateFromKeyboard)
      window.removeEventListener('keyup', updateFromKeyboard)
      window.removeEventListener('blur', reset)
    }
  }, [])

  // Auto-expand parent when active conversation is a child
  useEffect(() => {
    if (!activeConversationId) return
    const active = conversationById.get(activeConversationId)
    if (active?.parent_conversation_id && !expandedParentIds.has(active.parent_conversation_id)) {
      setExpandedParentIds((prev) => new Set(prev).add(active.parent_conversation_id!))
    }
  }, [activeConversationId, conversationById, expandedParentIds])

  // Auto-select conversation: restore last selected, or fall back to first
  useEffect(() => {
    if (!activeConversationId && conversations.length > 0 && !settingsLoading) {
      const lastId = settings.last_selected_conversation_id
      const lastConv = lastId ? conversationById.get(lastId) : null
      if (lastConv) {
        setActiveConversation(lastConv.id)
      } else {
        const sorted = [...conversations].sort((a, b) => {
          if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
          return b.updated_at - a.updated_at
        })
        setActiveConversation(sorted[0].id)
      }
    }
  }, [activeConversationId, conversationById, conversations, setActiveConversation, settings.last_selected_conversation_id, settingsLoading])

  // Persist last selected conversation
  useEffect(() => {
    if (activeConversationId && activeConversationId !== settings.last_selected_conversation_id) {
      let idleId: number | null = null
      const win = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
        cancelIdleCallback?: (handle: number) => void
      }
      const timeoutId = window.setTimeout(() => {
        const persist = () => {
          void useSettingsStore.getState().saveSettings({ last_selected_conversation_id: activeConversationId })
        }
        if (typeof win.requestIdleCallback === 'function') {
          idleId = win.requestIdleCallback(persist, { timeout: 1000 })
        } else {
          persist()
        }
      }, 250)
      return () => {
        window.clearTimeout(timeoutId)
        if (idleId !== null && typeof win.cancelIdleCallback === 'function') {
          win.cancelIdleCallback(idleId)
        }
      }
    }
  }, [activeConversationId, settings.last_selected_conversation_id])

  useEffect(() => {
    void ensureCategoriesLoaded().catch((error) => {
      console.error('[ChatSidebar] category load failed:', error)
      messageApi.error(String(error))
    })
  }, [ensureCategoriesLoaded, messageApi])

  const activeConversation = useMemo(
    () => activeConversationId ? conversationById.get(activeConversationId) ?? null : null,
    [activeConversationId, conversationById],
  )

  const activeConversationCategory = useMemo(() => {
    if (!activeConversation?.category_id) return null
    return categoryById.get(activeConversation.category_id) ?? null
  }, [activeConversation?.category_id, categoryById])

  const handleNewConversation = useCallback(async (categoryId?: string | null) => {
    let provider: typeof providers[0] | undefined
    let model: typeof providers[0]['models'][0] | undefined

    if (settings.default_provider_id && settings.default_model_id) {
      provider = providers.find((p) => p.id === settings.default_provider_id && p.enabled)
      model = provider?.models.find((m) => m.model_id === settings.default_model_id && m.enabled)
    }

    if (!provider || !model) {
      if (activeConversation?.provider_id && activeConversation?.model_id) {
        provider = providers.find((p) => p.id === activeConversation.provider_id && p.enabled)
        model = provider?.models.find((m) => m.model_id === activeConversation.model_id && m.enabled)
      }
    }

    if (!provider || !model) {
      provider = providers.find((p) => p.enabled && p.models.some((m) => m.enabled))
      model = provider?.models.find((m) => m.enabled)
    }

    if (!provider || !model) {
      messageApi.warning(t('chat.noModelsAvailable'))
      return
    }

    const templateCategoryId = categoryId ?? null
    await createConversation(
      t('chat.newConversation'),
      model.model_id,
      provider.id,
      { categoryId: templateCategoryId },
    )
  }, [providers, settings, activeConversation, createConversation, messageApi, t])

  const newConversationMenuItems = useMemo(() => {
    if (!activeConversationCategory) return []
    return [
      {
        key: 'current-category',
        label: t('chat.newConversationInCurrentCategory', { category: activeConversationCategory.name }),
        icon: <FolderOpen size={14} />,
      },
      {
        key: 'standalone',
        label: t('chat.newStandaloneConversation'),
        icon: <MessageSquarePlus size={14} />,
      },
    ]
  }, [activeConversationCategory, t])

  const handleNewConversationMenuClick = useCallback(
    ({ key }: { key: string }) => {
      if (key === 'current-category' && activeConversationCategory) {
        void handleNewConversation(activeConversationCategory.id)
        return
      }
      void handleNewConversation(null)
    },
    [activeConversationCategory, handleNewConversation],
  )

  useEffect(() => {
    const onShortcutNewConversation = () => {
      void handleNewConversation(null);
    };
    window.addEventListener('aqbot:new-conversation', onShortcutNewConversation);
    return () => {
      window.removeEventListener('aqbot:new-conversation', onShortcutNewConversation);
    };
  }, [handleNewConversation]);

  const openGlobalSearch = useCallback(() => {
    window.dispatchEvent(new CustomEvent('aqbot:open-conversation-search'))
  }, [])

  const filteredConversations = useMemo(() => {
    // Categorized conversations first (by category sort_order), then uncategorized
    const categorized = conversations.filter((c) => c.category_id)
    const uncategorized = conversations.filter((c) => !c.category_id)
    const catOrderMap = new Map(categories.map((cat) => [cat.id, cat.sort_order]))
    const uncategorizedGroupOrder = new Map<string, number>(
      UNCATEGORIZED_GROUP_ORDER.map((group, index) => [group, index]),
    )
    const nowSeconds = Date.now() / 1000
    categorized.sort((a, b) => {
      const oa = catOrderMap.get(a.category_id!) ?? 0
      const ob = catOrderMap.get(b.category_id!) ?? 0
      if (oa !== ob) return oa - ob
      return compareConversationOrder(a, b)
    })
    uncategorized.sort((a, b) => {
      const aGroup = getUncategorizedConversationGroup(a, nowSeconds)
      const bGroup = getUncategorizedConversationGroup(b, nowSeconds)
      const groupOrderDiff = (uncategorizedGroupOrder.get(aGroup) ?? Number.MAX_SAFE_INTEGER)
        - (uncategorizedGroupOrder.get(bGroup) ?? Number.MAX_SAFE_INTEGER)
      return groupOrderDiff || compareConversationOrder(a, b)
    })
    return [...categorized, ...uncategorized]
  }, [conversations, categories])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const exitMultiSelect = useCallback(() => {
    setMultiSelectMode(false)
    setSelectedIds(new Set())
  }, [])

  const isAllSelected = useMemo(
    () => filteredConversations.length > 0 && selectedIds.size === filteredConversations.length,
    [filteredConversations, selectedIds],
  )

  const handleSelectAll = useCallback(() => {
    if (isAllSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredConversations.map((c) => c.id)))
    }
  }, [isAllSelected, filteredConversations])

  const isAllArchivedSelected = useMemo(
    () => archivedConversations.length > 0 && archivedSelectedIds.size === archivedConversations.length,
    [archivedConversations, archivedSelectedIds],
  )

  const handleSelectAllArchived = useCallback(() => {
    if (isAllArchivedSelected) {
      setArchivedSelectedIds(new Set())
    } else {
      setArchivedSelectedIds(new Set(archivedConversations.map((c) => c.id)))
    }
  }, [isAllArchivedSelected, archivedConversations])

  const handleBatchDelete = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    modal.confirm({
      title: t('chat.deleteConfirm'),
      content: t('chat.batchDeleteContent', { count: ids.length }),
      mask: { enabled: true, blur: true },
      okButtonProps: { danger: true },
      onOk: async () => {
        await batchDelete(ids)
        exitMultiSelect()
      },
    })
  }, [selectedIds, batchDelete, exitMultiSelect, modal, t])

  const handleBatchArchive = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    await batchArchive(ids)
    exitMultiSelect()
    messageApi.success(t('chat.archivedSuccess', { count: ids.length }))
  }, [selectedIds, batchArchive, exitMultiSelect, messageApi, t])

  const handleBatchMoveToCategory = useCallback(async (categoryId: string | null) => {
    const ids = filteredConversations
      .filter((conversation) => selectedIds.has(conversation.id))
      .map((conversation) => conversation.id)
    if (ids.length === 0) return
    try {
      const moved = await batchMoveToCategory(ids, categoryId)
      exitMultiSelect()
      if (moved > 0) {
        messageApi.success(t('chat.batchMovedSuccess', { count: moved }))
      }
    } catch {
      messageApi.error(t('error.saveFailed'))
    }
  }, [selectedIds, filteredConversations, batchMoveToCategory, exitMultiSelect, messageApi, t])

  const handleShowArchived = useCallback(async () => {
    await fetchArchivedConversations()
    setShowArchived(true)
    setArchivedMultiSelect(false)
    setArchivedSelectedIds(new Set())
  }, [fetchArchivedConversations])

  const handleBackFromArchived = useCallback(() => {
    setShowArchived(false)
    setArchivedMultiSelect(false)
    setArchivedSelectedIds(new Set())
  }, [])

  const toggleArchivedSelect = useCallback((id: string) => {
    setArchivedSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleBatchUnarchive = useCallback(async () => {
    const ids = archivedConversations
      .filter((conversation) => archivedSelectedIds.has(conversation.id))
      .map((conversation) => conversation.id)
    if (ids.length === 0) return
    try {
      // Each unarchived root enters its target container at the top. Applying
      // the visible selection in reverse preserves the original row order.
      for (const id of [...ids].reverse()) {
        await toggleArchive(id)
      }
    } catch (error) {
      await fetchArchivedConversations()
      useConversationStore.setState({ error: String(error) })
      messageApi.error(t('error.saveFailed'))
      return
    }
    await fetchArchivedConversations()
    setArchivedSelectedIds(new Set())
    setArchivedMultiSelect(false)
  }, [archivedConversations, archivedSelectedIds, toggleArchive, fetchArchivedConversations, messageApi, t])

  const handleBatchDeleteArchived = useCallback(async () => {
    const ids = Array.from(archivedSelectedIds)
    if (ids.length === 0) return
    modal.confirm({
      title: t('chat.deleteConfirm'),
      content: t('chat.batchDeleteContent', { count: ids.length }),
      mask: { enabled: true, blur: true },
      okButtonProps: { danger: true },
      onOk: async () => {
        await batchDelete(ids)
        await fetchArchivedConversations()
        setArchivedSelectedIds(new Set())
        setArchivedMultiSelect(false)
      },
    })
  }, [archivedSelectedIds, batchDelete, fetchArchivedConversations, modal, t])

  const buildIcon = useCallback((conv: Conversation) => {
    return <ConversationIcon conv={conv} isStreaming={streamingConversationId === conv.id} />
  }, [streamingConversationId])

  const directDeleteShortcutLabel = useMemo(() => getDirectDeleteShortcutLabel(), [])
  const directDeleteHint = t('chat.directDeleteHint', { shortcut: directDeleteShortcutLabel })

  const handleDelete = useCallback(
    (
      item: Pick<ConversationItemType, 'key'>,
      event?: DeleteShortcutEvent,
      afterDelete?: () => void | Promise<void>,
    ) => {
      const id = String(item.key)
      const runDelete = async () => {
        await deleteConversation(id)
        await afterDelete?.()
      }

      if (isDirectDeleteEvent(event)) {
        void runDelete()
        return
      }

      modal.confirm({
        title: t('chat.deleteConfirm'),
        mask: { enabled: true, blur: true },
        okButtonProps: { danger: true },
        onOk: runDelete,
      })
    },
    [deleteConversation, t, modal],
  )

  const syncDirectDeleteModeFromMouse = useCallback((event: DeleteShortcutEvent) => {
    const next = isDirectDeleteEvent(event)
    setDirectDeleteMode((current) => (current === next ? current : next))
  }, [])

  const expandedGroupKeySet = useMemo(() => new Set(expandedKeys), [expandedKeys])
  const conversationRows = useMemo(
    () => buildConversationRows({
      conversations: filteredConversations,
      categories,
      expandedParentIds,
      expandedGroupKeys: expandedGroupKeySet,
    }),
    [categories, filteredConversations, expandedParentIds, expandedGroupKeySet],
  )

  const handleConversationDragStart = useCallback((event: DragStartEvent) => {
    if (conversationReorderSavingRef.current) return
    const parsed = parseNamespacedDragId(event.active.id)
    const conversationId = String(event.active.data.current?.conversationId ?? parsed.id)
    const activeRow = conversationRows.find((row) => (
      row.type === 'conversation' && row.conversation.id === conversationId
    ))
    if (activeRow?.type !== 'conversation' || activeRow.isChild) return

    const categoryId = activeRow.conversation.category_id ?? null
    const conversationIds = conversationRows
      .filter((row): row is Extract<ConversationListRow, { type: 'conversation' }> => (
        row.type === 'conversation'
        && !row.isChild
        && (row.conversation.category_id ?? null) === categoryId
      ))
      .map((row) => row.conversation.id)
    const sortOrderById = new Map(
      useConversationStore.getState().conversations
        .filter((conversation) => conversationIds.includes(conversation.id))
        .map((conversation, index) => [
          conversation.id,
          Number.isFinite(conversation.sort_order) ? conversation.sort_order : index,
        ]),
    )
    conversationDragSnapshotRef.current = {
      conversationId,
      group: activeRow.group,
      categoryId,
      conversationIds,
      sortOrderById,
    }
    conversationDragPreviewOrderRef.current = conversationIds
    conversationDragLastOverIdRef.current = null
    setActiveDragConversationId(conversationId)
    setActiveDragCatId(null)
  }, [conversationRows])

  const handleConversationDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event
    if (!over || active.data.current?.type !== 'conversation') return
    if (over.data.current?.type !== 'conversation') return
    const activeId = String(
      active.data.current.conversationId ?? parseNamespacedDragId(active.id).id,
    )
    const overId = String(
      over.data.current.conversationId ?? parseNamespacedDragId(over.id).id,
    )
    if (conversationDragLastOverIdRef.current === overId) return
    conversationDragLastOverIdRef.current = overId

    const reorderPlan = planConversationReorder(conversationRows, activeId, overId)
    if (!reorderPlan) return
    const snapshot = conversationDragSnapshotRef.current
    if (!snapshot || snapshot.categoryId !== reorderPlan.categoryId) return
    conversationDragPreviewOrderRef.current = reorderPlan.conversationIds
    applyConversationOrder(reorderPlan.conversationIds)
  }, [conversationRows])

  const resetConversationDragState = useCallback(() => {
    setActiveDragConversationId(null)
    conversationDragSnapshotRef.current = null
    conversationDragPreviewOrderRef.current = null
    conversationDragLastOverIdRef.current = null
  }, [])

  const handleConversationDragCancel = useCallback(() => {
    const snapshot = conversationDragSnapshotRef.current
    if (snapshot) restoreConversationOrder(snapshot)
    resetConversationDragState()
  }, [resetConversationDragState])

  const handleConversationDragEnd = useCallback((event: DragEndEvent) => {
    const snapshot = conversationDragSnapshotRef.current
    const previewOrder = conversationDragPreviewOrderRef.current
    const overData = event.over?.data.current
    const overId = event.over
      ? String(overData?.conversationId ?? parseNamespacedDragId(event.over.id).id)
      : null
    const isValidDrop = Boolean(
      snapshot
      && previewOrder
      && overData?.type === 'conversation'
      && typeof overData.conversationId === 'string'
      && overData.group === snapshot.group
      && overId !== snapshot.conversationId,
    )
    const orderChanged = Boolean(
      snapshot
      && previewOrder
      && previewOrder.some((id, index) => id !== snapshot.conversationIds[index]),
    )

    resetConversationDragState()
    if (!snapshot || !previewOrder || !isValidDrop || !orderChanged) {
      if (snapshot) restoreConversationOrder(snapshot)
      return
    }

    conversationReorderSavingRef.current = true
    setConversationReorderSaving(true)
    const savePromise = conversationReorderQueueRef.current
      .catch(() => undefined)
      .then(() => reorderConversations(snapshot.categoryId, previewOrder))
    conversationReorderQueueRef.current = savePromise
    void savePromise
      .catch(() => {
        restoreConversationOrder(snapshot)
        messageApi.error(t('error.saveFailed'))
      })
      .finally(() => {
        conversationReorderSavingRef.current = false
        setConversationReorderSaving(false)
      })
  }, [messageApi, reorderConversations, resetConversationDragState, t])

  const handleSidebarDragStart = useCallback((event: DragStartEvent) => {
    if (event.active.data.current?.type === 'conversation') {
      handleConversationDragStart(event)
      return
    }
    if (event.active.data.current?.type === 'category') {
      handleCategoryDragStart(event)
    }
  }, [handleCategoryDragStart, handleConversationDragStart])

  const handleSidebarDragOver = useCallback((event: DragOverEvent) => {
    if (event.active.data.current?.type === 'conversation') {
      handleConversationDragOver(event)
      return
    }
    if (event.active.data.current?.type === 'category') {
      handleCategoryDragOver(event)
    }
  }, [handleCategoryDragOver, handleConversationDragOver])

  const handleSidebarDragEnd = useCallback((event: DragEndEvent) => {
    if (event.active.data.current?.type === 'conversation') {
      handleConversationDragEnd(event)
      return
    }
    if (event.active.data.current?.type === 'category') {
      handleCategoryDragEnd(event)
    }
  }, [handleCategoryDragEnd, handleConversationDragEnd])

  const handleSidebarDragCancel = useCallback(() => {
    if (conversationDragSnapshotRef.current) {
      handleConversationDragCancel()
      return
    }
    handleCategoryDragCancel()
  }, [handleCategoryDragCancel, handleConversationDragCancel])

  const getConversationItem = useCallback(
    (row: Exclude<ConversationListRow, { type: 'groupHeader' }>): ConversationItemType => {
      if (row.type === 'emptyCategory') {
        return {
          key: `__empty_cat_${row.category.id}`,
          label: (
            <span style={{ color: token.colorTextQuaternary, fontSize: 12, fontStyle: 'italic' }}>
              {t('chat.noConversations')}
            </span>
          ),
          icon: null,
          group: row.group,
          disabled: true,
          style: { pointerEvents: 'none', minHeight: 28, opacity: 0.6 },
        }
      }

      const { conversation: conv, isChild, childCount, expanded } = row
      const icon = buildIcon(conv)
      const isGeneratingTitle = titleGeneratingConversationId === conv.id
      const pinNode = conv.is_pinned && !isChild
        ? <Pin size={12} style={{ color: token.colorTextQuaternary, flexShrink: 0 }} />
        : null
      const generatingTitleNode = isGeneratingTitle ? (
        <Tooltip title={t('chat.generatingTitle')}>
          <span
            className="aqbot-chat-conversation-title-generating"
            role="status"
            aria-label={t('chat.generatingTitle')}
            style={{
              color: token.colorPrimary,
              width: 14,
              height: 14,
              minWidth: 14,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Loader size={12} aria-hidden="true" style={{ animation: 'spin 1s linear infinite' }} />
          </span>
        </Tooltip>
      ) : null
      const expandToggleNode = childCount > 0 ? (
        <span
          onClick={(event) => {
            event.stopPropagation()
            setExpandedParentIds((previous) => {
              const next = new Set(previous)
              if (next.has(conv.id)) next.delete(conv.id)
              else next.add(conv.id)
              return next
            })
          }}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', flexShrink: 0 }}
        >
          <ChevronRight
            size={12}
            style={{
              color: token.colorTextQuaternary,
              transition: 'transform 0.2s',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          />
        </span>
      ) : null
      const labelContent = (
        <>
          {expandToggleNode}
          <ConversationTitleText title={conv.title} className="flex-1" />
          {generatingTitleNode}
          {pinNode}
        </>
      )
      const label = isChild || multiSelectMode || conversationReorderSaving ? (
        <span className="aqbot-chat-conversation-label">{labelContent}</span>
      ) : (
        <SortableConversationLabel
          conversation={conv}
          group={row.group}
          reorderLabel={t('chat.reorderConversation')}
        >
          {labelContent}
        </SortableConversationLabel>
      )

      return {
        key: conv.id,
        label,
        icon: multiSelectMode ? (
          <span className="flex items-center gap-1.5">
            <Checkbox
              checked={selectedIds.has(conv.id)}
              onChange={() => toggleSelect(conv.id)}
              onClick={(event: React.MouseEvent) => event.stopPropagation()}
            />
            {icon}
          </span>
        ) : icon,
        group: row.group,
        'data-conv-id': conv.id,
        ...(isChild ? { style: { paddingInlineStart: 20 } } : {}),
      }
    },
    [buildIcon, conversationReorderSaving, multiSelectMode, selectedIds, t, titleGeneratingConversationId, toggleSelect, token.colorPrimary, token.colorTextQuaternary],
  )

  const groupLabels: Record<string, string> = useMemo(
    () => {
      const labels: Record<string, string> = {
        pinned: t('chat.pinned'),
        today: t('chat.today'),
        yesterday: t('chat.yesterday'),
        thisWeek: t('chat.thisWeek'),
        thisMonth: t('chat.thisMonth'),
        earlier: t('chat.earlier'),
      }
      categories.forEach((cat) => {
        labels[`cat:${cat.id}`] = cat.name
      })
      return labels
    },
    [t, categories],
  )

  // Track known category IDs to detect new ones
  const knownCatIdsRef = useRef(new Set<string>())
  useEffect(() => {
    const currentIds = new Set(categories.map((c) => c.id))
    // Find newly appeared categories (initial load or newly created)
    const newCats = categories.filter((c) => !knownCatIdsRef.current.has(c.id))
    if (newCats.length > 0) {
      const newExpandedKeys = newCats.filter((c) => !c.is_collapsed).map((c) => `cat:${c.id}`)
      if (newExpandedKeys.length > 0) {
        setExpandedKeys((prev) => [...prev, ...newExpandedKeys])
      }
    }
    // Remove keys for deleted categories
    const deletedIds = [...knownCatIdsRef.current].filter((id) => !currentIds.has(id))
    if (deletedIds.length > 0) {
      const deletedKeys = new Set(deletedIds.map((id) => `cat:${id}`))
      setExpandedKeys((prev) => prev.filter((k) => !deletedKeys.has(k)))
    }
    knownCatIdsRef.current = currentIds
  }, [categories])

  // Auto-expand category of the active conversation on load
  const initialExpandDoneRef = useRef(false)
  useEffect(() => {
    if (initialExpandDoneRef.current || !activeConversationId || categories.length === 0) return
    const activeConv = conversationById.get(activeConversationId)
    if (activeConv?.category_id) {
      const key = `cat:${activeConv.category_id}`
      setExpandedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]))
    }
    initialExpandDoneRef.current = true
  }, [activeConversationId, categories, conversationById])

  // Guard to prevent menu clicks from triggering expand/collapse
  const menuActionRef = useRef(false)

  const handleGroupExpand = useCallback(
    (keys: string[]) => {
      if (menuActionRef.current) return
      setExpandedKeys(keys)
      const expandedCatIds = new Set(
        keys.filter((k) => k.startsWith('cat:')).map((k) => k.slice(4)),
      )
      categories.forEach((cat) => {
        const shouldBeCollapsed = !expandedCatIds.has(cat.id)
        if (cat.is_collapsed !== shouldBeCollapsed) {
          void setCollapsed(cat.id, shouldBeCollapsed)
        }
      })
    },
    [categories, setCollapsed],
  )

  const handleGroupToggle = useCallback((group: string) => {
    const nextKeys = expandedKeys.includes(group)
      ? expandedKeys.filter((key) => key !== group)
      : [...expandedKeys, group]
    handleGroupExpand(nextKeys)
  }, [expandedKeys, handleGroupExpand])

  const handleDeleteCategory = useCallback(
    async (catId: string) => {
      modal.confirm({
        title: t('chat.deleteCategoryConfirm'),
        mask: { enabled: true, blur: true },
        okButtonProps: { danger: true },
        onOk: async () => {
          await deleteCategory(catId)
          await useConversationStore.getState().fetchConversations()
        },
      })
    },
    [deleteCategory, modal, t],
  )

  const renderGroupLabel = useCallback(
    (group: string) => {
      if (group.startsWith('cat:')) {
        const catId = group.slice(4)
        const cat = categoryById.get(catId)
        if (!cat) return group

        return (
          <SortableCategoryLabel
            cat={cat}
            menuActionRef={menuActionRef}
            onCreateConversation={() => { void handleNewConversation(cat.id) }}
            newConversationLabel={t('chat.newConversation')}
            editLabel={t('chat.editCategory')}
            deleteLabel={t('chat.deleteCategory')}
            systemPromptLabel={t('roles.systemPrompt')}
            disabled={conversationReorderSaving}
            onEdit={() => {
              setEditingCategory(cat)
              setCategoryModalOpen(true)
            }}
            onDelete={() => void handleDeleteCategory(catId)}
          />
        )
      }
      return groupLabels[group] ?? group
    },
    [categoryById, conversationReorderSaving, groupLabels, t, handleDeleteCategory, handleNewConversation],
  )

  const groupableConfig = useMemo(
    () => ({
      label: (group: string) => renderGroupLabel(group),
      collapsible: (group: string) => group.startsWith('cat:'),
      expandedKeys,
      onExpand: handleGroupExpand,
    }),
    [expandedKeys, handleGroupExpand, renderGroupLabel],
  )

  const handleCreateCategory = useCallback(
    async (data: CategoryEditFormData) => {
      await createCategory({
        name: data.name,
        icon_type: data.icon_type,
        icon_value: data.icon_value,
        system_prompt: data.system_prompt,
        default_provider_id: data.default_provider_id,
        default_model_id: data.default_model_id,
        default_temperature: data.default_temperature,
        default_max_tokens: data.default_max_tokens,
        default_top_p: data.default_top_p,
        default_frequency_penalty: data.default_frequency_penalty,
      })
    },
    [createCategory],
  )

  const handleUpdateCategory = useCallback(
    async (data: CategoryEditFormData) => {
      if (!editingCategory) return
      await updateCategory(editingCategory.id, {
        name: data.name,
        icon_type: data.icon_type,
        icon_value: data.icon_value,
        system_prompt: data.system_prompt,
        default_provider_id: data.default_provider_id,
        default_model_id: data.default_model_id,
        default_temperature: data.default_temperature,
        default_max_tokens: data.default_max_tokens,
        default_top_p: data.default_top_p,
        default_frequency_penalty: data.default_frequency_penalty,
      })
      setEditingCategory(null)
    },
    [editingCategory, updateCategory],
  )

  const moveToCategoryMenuItems = useMemo(() => {
    return categories.map((cat) => ({
      key: `move-to-cat:${cat.id}`,
      label: (
        <span className="flex items-center gap-1.5">
          <CategoryIcon cat={cat} size={14} />
          <span>{cat.name}</span>
        </span>
      ),
    }))
  }, [categories])

  const handleRename = useCallback(
    (item: ConversationItemType) => {
      const conversation = conversationById.get(String(item.key))
      let newTitle = conversation?.title ?? (typeof item.label === 'string' ? item.label : '')
      modal.confirm({
        title: t('chat.rename'),
        mask: { enabled: true, blur: true },
        content: (
          <Input
            defaultValue={newTitle}
            onChange={(e) => {
              newTitle = e.target.value
            }}
          />
        ),
        onOk: async () => {
          if (newTitle.trim()) {
            await updateConversation(String(item.key), { title: newTitle.trim() })
          }
        },
      })
    },
    [conversationById, updateConversation, t, modal],
  )

  const handleGenerateTitle = useCallback(
    (conversationId: string) => {
      if (titleGeneratingConversationId === conversationId) return
      void regenerateTitle(conversationId)
    },
    [regenerateTitle, titleGeneratingConversationId],
  )

  const buildExportChildren = useCallback(
    (convId: string, title: string) => {
      const conv = conversationById.get(convId)
      const exportOptions = buildExportOptions({
        userName: profile.name,
        theme: {
          colorPrimary: token.colorPrimary,
          colorPrimaryBg: token.colorPrimaryBg,
          colorPrimaryBorder: token.colorPrimaryBorder,
          colorFillSecondary: token.colorFillSecondary,
        },
        providers,
        conversationModelId: conv?.model_id,
        conversationProviderId: conv?.provider_id,
      })
      return [
      {
        key: 'export-png',
        label: t('chat.exportPng'),
        icon: <FileImage size={14} />,
        onClick: async () => {
          try {
            const msgs = await invoke<Message[]>('list_messages', { conversationId: convId })
            const shareable = msgs.filter((m) => m.role === 'user' || m.role === 'assistant')
            if (shareable.length === 0) { messageApi.warning(t('chat.noMessages')); return }
            const ok = await exportMessagesAsPNG(shareable, title, {
              ...exportOptions,
              includeThinking: false,
            })
            if (ok) messageApi.success(t('chat.exportSuccess'))
          } catch (e) {
            console.error('Export PNG failed:', e)
            messageApi.error(t('chat.exportFailed'))
          }
        },
      },
      {
        key: 'export-md',
        label: t('chat.exportMd'),
        icon: <FileCode size={14} />,
        onClick: async () => {
          try {
            const msgs = await invoke<Message[]>('list_messages', { conversationId: convId })
            if (msgs.length === 0) { messageApi.warning(t('chat.noMessages')); return }
            const ok = await exportAsMarkdown(msgs, title, exportOptions)
            if (ok) messageApi.success(t('chat.exportSuccess'))
          } catch (e) {
            console.error('Export MD failed:', e)
            messageApi.error(t('chat.exportFailed'))
          }
        },
      },
      {
        key: 'export-txt',
        label: t('chat.exportTxt'),
        icon: <FileType size={14} />,
        onClick: async () => {
          try {
            const msgs = await invoke<Message[]>('list_messages', { conversationId: convId })
            if (msgs.length === 0) { messageApi.warning(t('chat.noMessages')); return }
            const ok = await exportAsText(msgs, title, exportOptions)
            if (ok) messageApi.success(t('chat.exportSuccess'))
          } catch (e) {
            console.error('Export TXT failed:', e)
            messageApi.error(t('chat.exportFailed'))
          }
        },
      },
      {
        key: 'export-json',
        label: t('chat.exportJson'),
        icon: <FileText size={14} />,
        onClick: async () => {
          try {
            const msgs = await invoke<Message[]>('list_messages', { conversationId: convId })
            if (msgs.length === 0) { messageApi.warning(t('chat.noMessages')); return }
            const ok = await exportAsJSON(msgs, title, exportOptions)
            if (ok) messageApi.success(t('chat.exportSuccess'))
          } catch (e) {
            console.error('Export JSON failed:', e)
            messageApi.error(t('chat.exportFailed'))
          }
        },
      },
      ]
    },
    [
      conversationById,
      messageApi,
      profile.name,
      providers,
      t,
      token.colorFillSecondary,
      token.colorPrimary,
      token.colorPrimaryBg,
      token.colorPrimaryBorder,
    ],
  )

  const menuConfig = useCallback<ConversationMenuFactory>(
    (item, options) => {
      if (multiSelectMode) return { items: [] }
      const includeItems = options?.includeItems ?? true
      const conv = conversationById.get(String(item.key))
      const isPinned = conv?.is_pinned ?? false
      const isGeneratingTitle = titleGeneratingConversationId === String(item.key)
      const categoryItems: any[] = []
      if (includeItems && categories.length > 0) {
        const moveChildren = moveToCategoryMenuItems.filter(
          (mi) => mi.key !== `move-to-cat:${conv?.category_id}`,
        )
        if (conv?.category_id) {
          moveChildren.unshift({
            key: 'remove-from-category',
            label: (<span className="flex items-center gap-1.5"><X size={13} /><span>{t('chat.removeFromCategory')}</span></span>),
          })
        }
        if (moveChildren.length > 0) {
          categoryItems.push({
            key: 'move-to-category',
            label: (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><FolderOpen size={14} />{t('chat.moveToCategory')}</span>),
            children: moveChildren,
          })
        }
      }
      return {
        trigger: (_conversation: ConversationItemType, info: { originNode: React.ReactNode }) => {
          // Keep Tooltip as Dropdown's direct interactive child chain without an
          // extra span around originNode: EllipsisOutlined uses stopPropagation,
          // so an intermediate wrapper would swallow the click and never open the menu.
          if (!directDeleteMode) {
            return <Tooltip title={directDeleteHint}>{info.originNode}</Tooltip>
          }
          return (
            <Tooltip title={directDeleteHint}>
              <Button
                type="text"
                danger
                size="small"
                aria-label={t('chat.delete')}
                className="ant-conversations-menu-icon aqbot-chat-conversation-menu-delete"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  handleDelete(item, event)
                }}
              >
                <Trash2 size={14} strokeWidth={2} style={{ display: 'block' }} />
              </Button>
            </Tooltip>
          )
        },
        items: directDeleteMode || !includeItems ? [] : [
          {
            key: 'pin',
            label: isPinned ? t('chat.unpin') : t('chat.pin'),
            icon: isPinned ? <PinOff size={14} /> : <Pin size={14} />,
          },
          { key: 'archive', label: t('chat.archive'), icon: <Archive size={14} /> },
          ...categoryItems,
          { key: 'rename', label: t('chat.rename'), icon: <Pencil size={14} /> },
          {
            key: 'generate-title',
            label: t('chat.generateTitle'),
            icon: isGeneratingTitle
              ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
              : <Sparkles size={14} />,
            disabled: isGeneratingTitle,
          },
          {
            key: 'export',
            label: (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Share size={14} />{t('chat.export')}</span>),
            children: buildExportChildren(String(item.key), conv?.title ?? (typeof item.label === 'string' ? item.label : '')),
          },
          { key: 'delete', label: t('chat.delete'), icon: <Trash2 size={14} />, danger: true },
        ],
        onClick: (menuInfo: { key: string; domEvent?: DeleteShortcutEvent }) => {
          if (menuInfo.key.startsWith('move-to-cat:')) {
            const catId = menuInfo.key.slice('move-to-cat:'.length)
            void updateConversation(String(item.key), { category_id: catId })
            return
          }
          if (menuInfo.key === 'remove-from-category') {
            void updateConversation(String(item.key), { category_id: null })
            return
          }
          switch (menuInfo.key) {
            case 'pin':
              togglePin(String(item.key))
              break
            case 'archive':
              toggleArchive(String(item.key))
              break
            case 'rename':
              handleRename(item)
              break
            case 'generate-title':
              handleGenerateTitle(String(item.key))
              break
            case 'delete':
              handleDelete(item, menuInfo.domEvent)
              break
          }
        },
      }
    },
    [t, conversationById, multiSelectMode, handleRename, handleGenerateTitle, handleDelete, togglePin, toggleArchive, buildExportChildren, categories, moveToCategoryMenuItems, updateConversation, directDeleteMode, directDeleteHint, titleGeneratingConversationId],
  )

  const handleConversationClick = useCallback((key: string) => {
    if (multiSelectMode) {
      toggleSelect(key)
    } else {
      setActiveConversation(key)
    }
  }, [multiSelectMode, toggleSelect, setActiveConversation])

  const rightClickMenuConfig = useMemo(() => {
    if (!rightClickedConvId) return { items: [] as any[] }
    const conv = conversationById.get(rightClickedConvId)
    if (!conv) return { items: [] as any[] }
    const isPinned = conv.is_pinned ?? false
    const isGeneratingTitle = titleGeneratingConversationId === conv.id
    const categoryItems: any[] = []
    if (categories.length > 0) {
      const moveChildren = moveToCategoryMenuItems.filter(
        (mi) => mi.key !== `move-to-cat:${conv.category_id}`,
      )
      if (conv.category_id) {
        moveChildren.unshift({
          key: 'remove-from-category',
          label: (<span className="flex items-center gap-1.5"><X size={13} /><span>{t('chat.removeFromCategory')}</span></span>),
        })
      }
      if (moveChildren.length > 0) {
        categoryItems.push({
          key: 'move-to-category',
          label: (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><FolderOpen size={14} />{t('chat.moveToCategory')}</span>),
          children: moveChildren,
        })
      }
    }
    return {
      items: [
        { key: 'pin', label: isPinned ? t('chat.unpin') : t('chat.pin'), icon: isPinned ? <PinOff size={14} /> : <Pin size={14} /> },
        { key: 'archive', label: t('chat.archive'), icon: <Archive size={14} /> },
        ...categoryItems,
        { key: 'rename', label: t('chat.rename'), icon: <Pencil size={14} /> },
        {
          key: 'generate-title',
          label: t('chat.generateTitle'),
          icon: isGeneratingTitle
            ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Sparkles size={14} />,
          disabled: isGeneratingTitle,
        },
        {
          key: 'export',
          label: (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Share size={14} />{t('chat.export')}</span>),
          children: buildExportChildren(conv.id, conv.title),
        },
        { key: 'delete', label: t('chat.delete'), icon: <Trash2 size={14} />, danger: true },
      ],
      onClick: (menuInfo: { key: string; domEvent?: DeleteShortcutEvent }) => {
        if (menuInfo.key.startsWith('move-to-cat:')) {
          const catId = menuInfo.key.slice('move-to-cat:'.length)
          void updateConversation(conv.id, { category_id: catId })
          return
        }
        if (menuInfo.key === 'remove-from-category') {
          void updateConversation(conv.id, { category_id: null })
          return
        }
        const item = { key: conv.id, label: conv.title } as ConversationItemType
        switch (menuInfo.key) {
          case 'pin': togglePin(conv.id); break
          case 'archive': toggleArchive(conv.id); break
          case 'rename': handleRename(item); break
          case 'generate-title': handleGenerateTitle(conv.id); break
          case 'delete': handleDelete(item, menuInfo.domEvent); break
        }
      },
    }
  }, [rightClickedConvId, conversationById, t, togglePin, toggleArchive, handleRename, handleGenerateTitle, handleDelete, buildExportChildren, categories, moveToCategoryMenuItems, updateConversation, titleGeneratingConversationId])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <div className="flex items-center gap-1">
          {showArchived ? (
            archivedMultiSelect ? (
              <>
                <Tooltip title={t('common.cancel')}>
                  <Button type="text" icon={<X size={16} />} size="small" onClick={() => { setArchivedMultiSelect(false); setArchivedSelectedIds(new Set()) }} />
                </Tooltip>
                <Tooltip title={t('chat.selectAll')}>
                  <Checkbox
                    checked={isAllArchivedSelected}
                    indeterminate={archivedSelectedIds.size > 0 && !isAllArchivedSelected}
                    onChange={handleSelectAllArchived}
                    style={{ marginLeft: 4 }}
                  />
                </Tooltip>
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{archivedSelectedIds.size} {t('chat.selected')}</span>
              </>
            ) : (
              <>
                <Button type="text" icon={<ArrowLeft size={16} />} size="small" onClick={handleBackFromArchived} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>{t('chat.archived')} ({archivedConversations.length})</span>
              </>
            )
          ) : multiSelectMode ? (
            <>
              <Tooltip title={t('common.cancel')}>
                <Button type="text" icon={<X size={16} />} size="small" onClick={exitMultiSelect} />
              </Tooltip>
              <Tooltip title={t('chat.selectAll')}>
                <Checkbox
                  checked={isAllSelected}
                  indeterminate={selectedIds.size > 0 && !isAllSelected}
                  onChange={handleSelectAll}
                  style={{ marginLeft: 4 }}
                />
              </Tooltip>
              <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{selectedIds.size} {t('chat.selected')}</span>
            </>
          ) : (
            <>
              <Tooltip title={t('chat.searchPlaceholder')}>
                <Button
                  type="text"
                  icon={<Search size={16} />}
                  size="small"
                  aria-label={t('chat.searchPlaceholder')}
                  onClick={openGlobalSearch}
                />
              </Tooltip>
              <Tooltip title={t('chat.archived')}>
                <Button
                  type="text"
                  icon={<Archive size={16} />}
                  size="small"
                  aria-label={t('chat.archived')}
                  onClick={handleShowArchived}
                />
              </Tooltip>
              <Tooltip title={t('chat.createCategory')}>
                <Button
                  type="text"
                  icon={<FolderPlus size={16} />}
                  size="small"
                  aria-label={t('chat.createCategory')}
                  onClick={() => { setEditingCategory(null); setCategoryModalOpen(true) }}
                />
              </Tooltip>
              <Tooltip title={shortcutHint(t('chat.newConversation'), 'newConversation')}>
                {activeConversationCategory ? (
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: newConversationMenuItems,
                      onClick: handleNewConversationMenuClick,
                    }}
                  >
                    <Button
                      type="text"
                      icon={<MessageSquarePlus size={16} />}
                      size="small"
                      aria-label={t('chat.newConversation')}
                    />
                  </Dropdown>
                ) : (
                  <Button
                    type="text"
                    icon={<MessageSquarePlus size={16} />}
                    size="small"
                    aria-label={t('chat.newConversation')}
                    onClick={() => { void handleNewConversation(null) }}
                  />
                )}
              </Tooltip>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {showArchived ? (
            archivedMultiSelect ? (
              <div className="flex items-center gap-1">
                <Tooltip title={t('chat.unarchive')}>
                  <Button
                    type="text"
                    icon={<Undo2 size={16} />}
                    size="small"
                    aria-label={t('chat.unarchive')}
                    disabled={archivedSelectedIds.size === 0}
                    onClick={handleBatchUnarchive}
                  />
                </Tooltip>
                <Tooltip title={t('chat.delete')}>
                  <Button type="text" danger icon={<Trash2 size={16} />} size="small" disabled={archivedSelectedIds.size === 0} onClick={handleBatchDeleteArchived} />
                </Tooltip>
              </div>
            ) : (
              <Tooltip title={t('chat.multiSelect')}>
                <Button
                  type="text"
                  icon={<ListTodo size={16} />}
                  size="small"
                  aria-label={t('chat.multiSelect')}
                  onClick={() => setArchivedMultiSelect(true)}
                />
              </Tooltip>
            )
          ) : multiSelectMode ? (
            <div className="flex items-center gap-1">
              <Dropdown
                disabled={selectedIds.size === 0}
                menu={{
                  items: [
                    ...categories.map((cat) => ({
                      key: `move-to-cat:${cat.id}`,
                      label: (
                        <span className="flex items-center gap-1.5">
                          <CategoryIcon cat={cat} size={14} />
                          <span>{cat.name}</span>
                        </span>
                      ),
                    })),
                    ...(categories.length > 0 ? [{ type: 'divider' as const }] : []),
                    {
                      key: 'remove-from-category',
                      label: (
                        <span className="flex items-center gap-1.5">
                          <X size={13} />
                          <span>{t('chat.removeFromCategory')}</span>
                        </span>
                      ),
                    },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'remove-from-category') {
                      void handleBatchMoveToCategory(null)
                      return
                    }
                    if (key.startsWith('move-to-cat:')) {
                      void handleBatchMoveToCategory(key.slice('move-to-cat:'.length))
                    }
                  },
                }}
              >
                <Button
                  type="text"
                  icon={<FolderOpen size={16} />}
                  size="small"
                  aria-label={t('chat.moveToCategory')}
                  disabled={selectedIds.size === 0}
                />
              </Dropdown>
              <Tooltip title={t('chat.archive')}>
                <Button type="text" icon={<Archive size={16} />} size="small" aria-label={t('chat.archive')} disabled={selectedIds.size === 0} onClick={handleBatchArchive} />
              </Tooltip>
              <Tooltip title={t('chat.delete')}>
                <Button type="text" danger icon={<Trash2 size={16} />} size="small" aria-label={t('chat.delete')} disabled={selectedIds.size === 0} onClick={handleBatchDelete} />
              </Tooltip>
            </div>
          ) : (
            <Tooltip title={t('chat.multiSelect')}>
              <Button
                type="text"
                icon={<ListTodo size={16} />}
                size="small"
                aria-label={t('chat.multiSelect')}
                onClick={() => setMultiSelectMode(true)}
              />
            </Tooltip>
          )}
        </div>
      </div>

      {showArchived ? (
        archivedConversations.length > 0 ? (
          <ArchivedConversationList
            conversations={archivedConversations}
            renderConversation={(conv) => (
                <div
                  className="flex items-center gap-2 cursor-pointer"
                  style={{ padding: '8px 12px', borderRadius: 6, margin: '0 8px' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = token.colorFillContent }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '' }}
                  onClick={() => archivedMultiSelect && toggleArchivedSelect(conv.id)}
                >
                  {archivedMultiSelect && (
                    <Checkbox
                      checked={archivedSelectedIds.has(conv.id)}
                      onChange={() => toggleArchivedSelect(conv.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                  {buildIcon(conv)}
                  <ConversationTitleText title={conv.title} className="flex-1 text-sm" />
                  {!archivedMultiSelect && (
                    <div className="flex items-center gap-1">
                      <Tooltip title={t('chat.unarchive')}>
                        <Button
                          type="text"
                          size="small"
                          aria-label={t('chat.unarchive')}
                          icon={<Undo2 size={14} />}
                          onClick={async (e) => {
                            e.stopPropagation()
                            await toggleArchive(conv.id)
                            await fetchArchivedConversations()
                          }}
                        />
                      </Tooltip>
                      <Tooltip title={directDeleteHint}>
                        <Button
                          type="text"
                          size="small"
                          danger
                          aria-label={t('chat.delete')}
                          icon={<Trash2 size={14} />}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete({ key: conv.id }, e, fetchArchivedConversations)
                          }}
                        />
                      </Tooltip>
                    </div>
                  )}
                </div>
            )}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center py-8" style={{ color: token.colorTextSecondary }}>
            {t('chat.noArchivedConversations')}
          </div>
        )
      ) : (
        <Dropdown
          menu={rightClickMenuConfig}
          trigger={['contextMenu']}
          onOpenChange={(open) => { if (!open) setRightClickedConvId(null) }}
        >
          <div ref={listScrollRef} className="flex-1 overflow-y-auto">
            <div
              onMouseMove={syncDirectDeleteModeFromMouse}
              onContextMenu={(e) => {
              if (multiSelectMode) { e.preventDefault(); e.stopPropagation(); return }
              const listItem = (e.target as HTMLElement).closest('[data-conv-id]') as HTMLElement
              if (!listItem) { e.preventDefault(); e.stopPropagation(); return }
              const convId = listItem.getAttribute('data-conv-id')
              if (!convId) { e.preventDefault(); e.stopPropagation(); return }
              setRightClickedConvId(convId)
            }}>
              <style>{`
                .ant-conversations .ant-conversations-item-active {
                  background-color: ${token.colorPrimaryBg} !important;
                }
                .ant-conversations .ant-conversations-item-active .ant-conversations-label {
                  color: ${token.colorPrimary} !important;
                }
                .ant-conversations .ant-conversations-icon {
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  flex-shrink: 0;
                  line-height: 0;
                }
                .ant-conversations .ant-conversations-label {
                  min-width: 0;
                  overflow: hidden;
                  display: flex !important;
                  align-items: center;
                  margin-bottom: 0 !important;
                  line-height: 1.25;
                }
                .ant-conversations .ant-conversations-menu {
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  flex-shrink: 0;
                  line-height: 0;
                }
                .ant-conversations .ant-conversations-item > div:has(.ant-conversations-menu-icon) {
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  flex-shrink: 0;
                  line-height: 0;
                }
                .ant-conversations .ant-conversations-menu-icon {
                  display: inline-flex !important;
                  align-items: center;
                  justify-content: center;
                  width: 22px;
                  height: 22px;
                  min-width: 22px;
                  line-height: 1;
                  font-size: 16px;
                  flex-shrink: 0;
                  box-sizing: border-box;
                }
                .aqbot-chat-conversation-title-row {
                  min-width: 0;
                  width: 100%;
                  overflow: hidden;
                }
                .aqbot-chat-conversation-menu-delete {
                  width: 22px !important;
                  height: 22px !important;
                  min-width: 22px !important;
                  padding: 0 !important;
                  display: inline-flex !important;
                  align-items: center;
                  justify-content: center;
                  line-height: 1;
                }
                .aqbot-chat-conversation-menu-delete .ant-btn-icon {
                  display: inline-flex !important;
                  align-items: center;
                  justify-content: center;
                  margin-inline-end: 0 !important;
                  line-height: 0;
                }
                .aqbot-chat-conversation-menu-delete .ant-btn-icon > svg,
                .aqbot-chat-conversation-menu-delete svg {
                  display: block;
                }
                .ant-conversations .ant-conversations-item-active .aqbot-chat-conversation-menu-delete {
                  opacity: 0;
                }
                .ant-conversations .ant-conversations-item:hover .aqbot-chat-conversation-menu-delete,
                .aqbot-chat-conversation-menu-delete:focus-visible {
                  opacity: 0.85;
                }
                .aqbot-chat-conversation-menu-delete:hover {
                  opacity: 1 !important;
                }
                .ant-conversations .ant-conversations-group-label {
                  flex: 1;
                  overflow: hidden;
                }
                .aqbot-chat-conversation-label {
                  display: flex;
                  align-items: center;
                  gap: 4px;
                  min-width: 0;
                  width: 100%;
                  overflow: hidden;
                }
                .aqbot-chat-conversation-title {
                  min-width: 0;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  white-space: nowrap;
                  display: block;
                  line-height: 1.25;
                }
                @keyframes spin {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
              `}</style>
              {conversationRows.length > 0 ? (
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={dndCollisionDetection}
                  onDragStart={handleSidebarDragStart}
                  onDragOver={handleSidebarDragOver}
                  onDragEnd={handleSidebarDragEnd}
                  onDragCancel={handleSidebarDragCancel}
                >
                  <ConversationList
                    rows={conversationRows}
                    activeKey={multiSelectMode ? undefined : (activeConversationId ?? undefined)}
                    onActiveChange={handleConversationClick}
                    getItem={getConversationItem}
                    renderGroupLabel={renderGroupLabel}
                    onGroupToggle={handleGroupToggle}
                    nativeGroupable={groupableConfig}
                    scrollElementRef={listScrollRef}
                    menu={menuConfig}
                  />
                  <DragOverlay>
                    {activeDragCatId ? (() => {
                      const cat = categoryById.get(activeDragCatId)
                      if (!cat) return null
                      return (
                        <div className="flex items-center gap-1" style={{ opacity: 0.8, cursor: 'grabbing', fontSize: 13 }}>
                          <GripVertical size={12} style={{ opacity: 0.4 }} />
                          <CategoryIcon cat={cat} size={14} />
                          <span>{cat.name}</span>
                        </div>
                      )
                    })() : activeDragConversationId ? (() => {
                      const conversation = conversationById.get(activeDragConversationId)
                      if (!conversation) return null
                      return (
                        <div className="flex items-center gap-1" style={{ opacity: 0.85, cursor: 'grabbing', fontSize: 13 }}>
                          <GripVertical size={12} style={{ opacity: 0.45 }} />
                          {buildIcon(conversation)}
                          <ConversationTitleText title={conversation.title} />
                        </div>
                      )
                    })() : null}
                  </DragOverlay>
                </DndContext>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <Empty description={t('chat.noConversations')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                </div>
              )}
            </div>
          </div>
        </Dropdown>
      )}

      <CategoryEditModal
        open={categoryModalOpen}
        onClose={() => { setCategoryModalOpen(false); setEditingCategory(null) }}
        onOk={editingCategory ? handleUpdateCategory : handleCreateCategory}
        initialName={editingCategory?.name ?? ''}
        initialIconType={editingCategory?.icon_type}
        initialIconValue={editingCategory?.icon_value}
        initialSystemPrompt={editingCategory?.system_prompt}
        initialDefaultProviderId={editingCategory?.default_provider_id}
        initialDefaultModelId={editingCategory?.default_model_id}
        initialDefaultTemperature={editingCategory?.default_temperature}
        initialDefaultMaxTokens={editingCategory?.default_max_tokens}
        initialDefaultTopP={editingCategory?.default_top_p}
        initialDefaultFrequencyPenalty={editingCategory?.default_frequency_penalty}
        title={editingCategory ? t('chat.editCategory') : t('chat.createCategory')}
      />

    </div>
  )
}
