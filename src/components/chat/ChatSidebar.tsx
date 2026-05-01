import { useState, useMemo, useCallback, useEffect, useRef, memo } from 'react'
import { Button, Input, App, theme, Tooltip, Avatar, Checkbox, Dropdown, Empty } from 'antd'
import { MessageSquarePlus, Search, Archive, ListTodo, Trash2, Pencil, Share, Pin, PinOff, Loader, X, Undo2, ArrowLeft, FileImage, FileCode, FileType, FileText, FolderPlus, FolderOpen, GripVertical, ChevronRight, MessageSquareText } from 'lucide-react'
import { ModelIcon } from '@lobehub/icons'
import { getConvIcon } from '@/lib/convIcon'
import { exportAsMarkdown, exportAsText, exportAsPNG, exportAsJSON } from '@/lib/exportChat'
import { invoke } from '@/lib/invoke'
import Conversations from '@ant-design/x/es/conversations'
import type { ConversationItemType } from '@ant-design/x/es/conversations/interface'
import { useTranslation } from 'react-i18next'
import { useConversationStore, useProviderStore, useSettingsStore, useCategoryStore } from '@/stores'
import { getShortcutBinding, formatShortcutForDisplay } from '@/lib/shortcuts'
import type { ShortcutAction } from '@/lib/shortcuts'
import type { Conversation, Message, ConversationCategory } from '@/types'
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc'
import type { AvatarType } from '@/stores/userProfileStore'
import { CategoryEditModal, type CategoryEditFormData } from './CategoryEditModal'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core'

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

function getDateGroup(timestamp: number): string {
  const now = new Date()
  const date = new Date(timestamp * 1000)

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000)
  const dayOfWeek = startOfToday.getDay()
  const startOfWeek = new Date(startOfToday.getTime() - dayOfWeek * 86400000)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  if (date >= startOfToday) return 'today'
  if (date >= startOfYesterday) return 'yesterday'
  if (date >= startOfWeek) return 'thisWeek'
  if (date >= startOfMonth) return 'thisMonth'
  return 'earlier'
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
}: {
  cat: ConversationCategory
  onCreateConversation: () => void
  onEdit: () => void
  onDelete: () => void
  menuActionRef: React.MutableRefObject<boolean>
  newConversationLabel: string
  editLabel: string
  deleteLabel: string
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: cat.id })
  const { setNodeRef: setDropRef } = useDroppable({ id: cat.id })
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
          <Tooltip title="System Prompt">
            <MessageSquareText size={12} style={{ opacity: 0.45, flexShrink: 0 }} />
          </Tooltip>
        )}
      </div>
    </Dropdown>
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
  const streamingConversationId = useConversationStore((s) => s.streamingConversationId)

  const providers = useProviderStore((s) => s.providers)
  const settings = useSettingsStore((s) => s.settings)
  const settingsLoading = useSettingsStore((s) => s.loading)

  const categories = useCategoryStore((s) => s.categories)
  const fetchCategories = useCategoryStore((s) => s.fetchCategories)
  const createCategory = useCategoryStore((s) => s.createCategory)
  const updateCategory = useCategoryStore((s) => s.updateCategory)
  const deleteCategory = useCategoryStore((s) => s.deleteCategory)
  const setCollapsed = useCategoryStore((s) => s.setCollapsed)
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const [activeDragCatId, setActiveDragCatId] = useState<string | null>(null)
  const dragInitialOrderRef = useRef<string[]>([])

  const handleCategoryDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragCatId(String(event.active.id))
    dragInitialOrderRef.current = categories.map((c) => c.id)
  }, [categories])

  const handleCategoryDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = categories.map((c) => c.id)
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return
    const newIds = [...ids]
    newIds.splice(oldIndex, 1)
    newIds.splice(newIndex, 0, String(active.id))
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

  const [searchText, setSearchText] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showArchived, setShowArchived] = useState(false)
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<Set<string>>(new Set())
  const [archivedMultiSelect, setArchivedMultiSelect] = useState(false)
  const [rightClickedConvId, setRightClickedConvId] = useState<string | null>(null)
  const [categoryModalOpen, setCategoryModalOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<ConversationCategory | null>(null)
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(new Set())
  const [directDeleteMode, setDirectDeleteMode] = useState(false)

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
    const active = conversations.find((c) => c.id === activeConversationId)
    if (active?.parent_conversation_id && !expandedParentIds.has(active.parent_conversation_id)) {
      setExpandedParentIds((prev) => new Set(prev).add(active.parent_conversation_id!))
    }
  }, [activeConversationId, conversations])

  // Auto-select conversation: restore last selected, or fall back to first
  useEffect(() => {
    if (!activeConversationId && conversations.length > 0 && !settingsLoading) {
      const lastId = settings.last_selected_conversation_id
      const lastConv = lastId ? conversations.find((c) => c.id === lastId) : null
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
  }, [activeConversationId, conversations, setActiveConversation, settings.last_selected_conversation_id, settingsLoading])

  // Persist last selected conversation
  useEffect(() => {
    if (activeConversationId && activeConversationId !== settings.last_selected_conversation_id) {
      void useSettingsStore.getState().saveSettings({ last_selected_conversation_id: activeConversationId })
    }
  }, [activeConversationId, settings.last_selected_conversation_id])

  useEffect(() => { void fetchCategories() }, [fetchCategories])

  const handleNewConversation = useCallback(async (categoryId?: string | null) => {
    let provider: typeof providers[0] | undefined
    let model: typeof providers[0]['models'][0] | undefined

    if (settings.default_provider_id && settings.default_model_id) {
      provider = providers.find((p) => p.id === settings.default_provider_id && p.enabled)
      model = provider?.models.find((m) => m.model_id === settings.default_model_id && m.enabled)
    }

    if (!provider || !model) {
      const activeConv = conversations.find((c) => c.id === activeConversationId)
      if (activeConv?.provider_id && activeConv?.model_id) {
        provider = providers.find((p) => p.id === activeConv.provider_id && p.enabled)
        model = provider?.models.find((m) => m.model_id === activeConv.model_id && m.enabled)
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

    const activeConv = conversations.find((c) => c.id === activeConversationId)
    const templateCategoryId = categoryId ?? activeConv?.category_id ?? null
    const conv = await createConversation(
      t('chat.newConversation'),
      model.model_id,
      provider.id,
      { categoryId: templateCategoryId },
    )
    setActiveConversation(conv.id)
  }, [providers, settings, conversations, activeConversationId, createConversation, setActiveConversation, messageApi, t])

  useEffect(() => {
    const onShortcutNewConversation = () => {
      void handleNewConversation();
    };
    window.addEventListener('aqbot:new-conversation', onShortcutNewConversation);
    return () => {
      window.removeEventListener('aqbot:new-conversation', onShortcutNewConversation);
    };
  }, [handleNewConversation]);

  const handleSearch = useCallback(
    (value: string) => {
      setSearchText(value)
    },
    [],
  )

  const filteredConversations = useMemo(() => {
    let filtered = conversations
    if (searchText.trim()) {
      const query = searchText.toLowerCase()
      filtered = filtered.filter((c: Conversation) => c.title.toLowerCase().includes(query))
    }
    // Categorized conversations first (by category sort_order), then uncategorized
    const categorized = filtered.filter((c) => c.category_id)
    const uncategorized = filtered.filter((c) => !c.category_id)
    const catOrderMap = new Map(categories.map((cat) => [cat.id, cat.sort_order]))
    categorized.sort((a, b) => {
      const oa = catOrderMap.get(a.category_id!) ?? 0
      const ob = catOrderMap.get(b.category_id!) ?? 0
      if (oa !== ob) return oa - ob
      return b.updated_at - a.updated_at
    })
    uncategorized.sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      return b.updated_at - a.updated_at
    })
    return [...categorized, ...uncategorized]
  }, [conversations, searchText, categories])

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
    const ids = Array.from(archivedSelectedIds)
    if (ids.length === 0) return
    await Promise.all(ids.map(id => toggleArchive(id)))
    await fetchArchivedConversations()
    setArchivedSelectedIds(new Set())
    setArchivedMultiSelect(false)
  }, [archivedSelectedIds, toggleArchive, fetchArchivedConversations])

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
    const isStreaming = streamingConversationId === conv.id
    const customIcon = getConvIcon(conv.id)
    let icon: React.ReactNode
    if (customIcon) {
      if (customIcon.type === 'emoji') {
        icon = <Avatar size={20} style={{ fontSize: 12, backgroundColor: token.colorPrimaryBg }}>{customIcon.value}</Avatar>
      } else {
        icon = <Avatar size={20} src={customIcon.value} />
      }
    } else if (conv.model_id) {
      icon = <ModelIcon model={conv.model_id} size={20} type="avatar" />
    } else {
      icon = <Avatar size={20} style={{ fontSize: 12, backgroundColor: token.colorPrimaryBg, color: token.colorPrimary }}>{(conv.title || '对')[0]}</Avatar>
    }
    if (conv.mode === 'agent') {
      icon = (
        <span style={{ position: 'relative', display: 'inline-flex', width: 20, height: 20 }}>
          {icon}
          <span
            style={{
              position: 'absolute',
              top: -5,
              right: -11,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              padding: '0 3px',
              height: 10,
              lineHeight: 1,
              borderRadius: 5,
              fontSize: 7,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              color: token.colorPrimary,
              background: token.colorPrimaryBg,
              border: `1px solid ${token.colorBgContainer}`,
              pointerEvents: 'none',
              transform: 'scale(0.9)',
              transformOrigin: 'right top',
            }}
          >
            Agent
          </span>
        </span>
      )
    }
    if (isStreaming) {
      icon = (
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          {icon}
          <Loader
            size={10}
            style={{
              position: 'absolute',
              bottom: -3,
              right: -3,
              color: token.colorPrimary,
              background: token.colorBgContainer,
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
            }}
          />
        </span>
      )
    }
    return icon
  }, [streamingConversationId, token.colorPrimary, token.colorPrimaryBg, token.colorBgContainer])

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

  const conversationItems: ConversationItemType[] = useMemo(
    () => {
      const items: ConversationItemType[] = []

      // Build parent→children map (max 1 level nesting)
      const childrenMap = new Map<string, Conversation[]>()
      const topLevel: Conversation[] = []
      filteredConversations.forEach((conv) => {
        if (conv.parent_conversation_id) {
          const arr = childrenMap.get(conv.parent_conversation_id) ?? []
          arr.push(conv)
          childrenMap.set(conv.parent_conversation_id, arr)
        } else {
          topLevel.push(conv)
        }
      })

      // Group conversations by category_id for ordered insertion
      const convsByCatId = new Map<string, Conversation[]>()
      const uncategorizedConvs: Conversation[] = []
      topLevel.forEach((conv) => {
        if (conv.category_id) {
          const arr = convsByCatId.get(conv.category_id) ?? []
          arr.push(conv)
          convsByCatId.set(conv.category_id, arr)
        } else {
          uncategorizedConvs.push(conv)
        }
      })

      const hasChildren = (convId: string) => (childrenMap.get(convId)?.length ?? 0) > 0
      const isExpanded = (convId: string) => expandedParentIds.has(convId)

      const buildConvItem = (conv: Conversation, group: string, isChild = false): ConversationItemType => {
        const icon = buildIcon(conv)
        const childCount = childrenMap.get(conv.id)?.length ?? 0
        const expanded = isExpanded(conv.id)

        let label: React.ReactNode
        if (conv.is_pinned && !isChild) {
          label = (
            <span className="flex items-center gap-1">
              <span className="truncate">{conv.title}</span>
              <Pin size={12} style={{ color: token.colorTextQuaternary, flexShrink: 0 }} />
            </span>
          )
        } else {
          label = conv.title
        }

        // Wrap label with expand/collapse toggle for parents with children
        if (childCount > 0) {
          label = (
            <span className="flex items-center gap-1" style={{ overflow: 'hidden' }}>
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  setExpandedParentIds((prev) => {
                    const next = new Set(prev)
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
              <span className="truncate">{typeof label === 'string' ? label : label}</span>
            </span>
          )
        }

        if (multiSelectMode) {
          return {
            key: conv.id,
            label,
            icon: (
              <span className="flex items-center gap-1.5">
                <Checkbox
                  checked={selectedIds.has(conv.id)}
                  onChange={() => toggleSelect(conv.id)}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                />
                {icon}
              </span>
            ),
            group,
            'data-conv-id': conv.id,
            ...(isChild ? { style: { paddingLeft: 20 } } : {}),
          }
        }
        return {
          key: conv.id,
          label,
          icon,
          group,
          'data-conv-id': conv.id,
          ...(isChild ? { style: { paddingLeft: 20 } } : {}),
        }
      }

      // Helper: push a conversation and its children (if expanded)
      const pushConvWithChildren = (conv: Conversation, group: string) => {
        items.push(buildConvItem(conv, group))
        if (hasChildren(conv.id) && isExpanded(conv.id)) {
          const children = childrenMap.get(conv.id)!
          children.forEach((child) => items.push(buildConvItem(child, group, true)))
        }
      }

      // Add category items in sort_order — ensures group rendering order matches drag order
      categories.forEach((cat) => {
        const catConvs = convsByCatId.get(cat.id)
        if (catConvs && catConvs.length > 0) {
          catConvs.forEach((conv) => pushConvWithChildren(conv, `cat:${cat.id}`))
        } else {
          items.push({
            key: `__empty_cat_${cat.id}`,
            label: (
              <span style={{ color: token.colorTextQuaternary, fontSize: 12, fontStyle: 'italic' }}>
                {t('chat.noConversations')}
              </span>
            ),
            icon: null,
            group: `cat:${cat.id}`,
            disabled: true,
            style: { pointerEvents: 'none', minHeight: 28, opacity: 0.6 },
          })
        }
      })

      // Add uncategorized conversations (pinned + time groups)
      uncategorizedConvs.forEach((conv) => {
        const group = conv.is_pinned ? 'pinned' : getDateGroup(conv.updated_at)
        pushConvWithChildren(conv, group)
      })

      return items
    },
    [filteredConversations, multiSelectMode, selectedIds, buildIcon, toggleSelect, token.colorTextQuaternary, categories, t, expandedParentIds],
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

  // Local state for expanded group keys (drives the UI immediately)
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])

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
    const activeConv = conversations.find((c) => c.id === activeConversationId)
    if (activeConv?.category_id) {
      const key = `cat:${activeConv.category_id}`
      setExpandedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]))
    }
    initialExpandDoneRef.current = true
  }, [activeConversationId, conversations, categories])

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
        const cat = categories.find((c) => c.id === catId)
        if (!cat) return group

        return (
          <SortableCategoryLabel
            cat={cat}
            menuActionRef={menuActionRef}
            onCreateConversation={() => { void handleNewConversation(cat.id) }}
            newConversationLabel={t('chat.newConversation')}
            editLabel={t('chat.editCategory')}
            deleteLabel={t('chat.deleteCategory')}
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
    [categories, groupLabels, t, handleDeleteCategory, handleNewConversation],
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
      const conversation = conversations.find((c) => c.id === String(item.key))
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
    [conversations, updateConversation, t, modal],
  )

  const buildExportChildren = useCallback(
    (convId: string, title: string) => [
      {
        key: 'export-png',
        label: t('chat.exportPng'),
        icon: <FileImage size={14} />,
        onClick: async () => {
          try {
            const el = document.querySelector('[data-message-area]') as HTMLElement
            if (!el) { messageApi.warning(t('chat.noMessages')); return }
            const ok = await exportAsPNG(el, title)
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
            const ok = await exportAsMarkdown(msgs, title)
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
            const ok = await exportAsText(msgs, title)
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
            const ok = await exportAsJSON(msgs, title)
            if (ok) messageApi.success(t('chat.exportSuccess'))
          } catch (e) {
            console.error('Export JSON failed:', e)
            messageApi.error(t('chat.exportFailed'))
          }
        },
      },
    ],
    [t, messageApi],
  )

  const menuConfig = useCallback(
    (item: ConversationItemType) => {
      if (multiSelectMode) return { items: [] }
      const conv = conversations.find((c) => c.id === String(item.key))
      const isPinned = conv?.is_pinned ?? false
      const categoryItems: any[] = []
      if (categories.length > 0) {
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
                icon={<Trash2 size={14} />}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  handleDelete(item, event)
                }}
              />
            </Tooltip>
          )
        },
        items: directDeleteMode ? [] : [
          {
            key: 'pin',
            label: isPinned ? t('chat.unpin') : t('chat.pin'),
            icon: isPinned ? <PinOff size={14} /> : <Pin size={14} />,
          },
          { key: 'archive', label: t('chat.archive'), icon: <Archive size={14} /> },
          ...categoryItems,
          { key: 'rename', label: t('chat.rename'), icon: <Pencil size={14} /> },
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
            case 'delete':
              handleDelete(item, menuInfo.domEvent)
              break
          }
        },
      }
    },
    [t, conversations, multiSelectMode, handleRename, handleDelete, togglePin, toggleArchive, buildExportChildren, categories, moveToCategoryMenuItems, updateConversation, directDeleteMode, directDeleteHint],
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
    const conv = conversations.find((c) => c.id === rightClickedConvId)
    if (!conv) return { items: [] as any[] }
    const isPinned = conv.is_pinned ?? false
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
          case 'delete': handleDelete(item, menuInfo.domEvent); break
        }
      },
    }
  }, [rightClickedConvId, conversations, t, togglePin, toggleArchive, handleRename, handleDelete, buildExportChildren, categories, moveToCategoryMenuItems, updateConversation])

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
                  onClick={() => setSearchVisible((v) => !v)}
                  style={{ color: searchVisible ? token.colorPrimary : undefined }}
                />
              </Tooltip>
              <Tooltip title={t('chat.archived')}>
                <Button
                  type="text"
                  icon={<Archive size={16} />}
                  size="small"
                  onClick={handleShowArchived}
                />
              </Tooltip>
              <Tooltip title={t('chat.createCategory')}>
                <Button
                  type="text"
                  icon={<FolderPlus size={16} />}
                  size="small"
                  onClick={() => { setEditingCategory(null); setCategoryModalOpen(true) }}
                />
              </Tooltip>
              <Tooltip title={shortcutHint(t('chat.newConversation'), 'newConversation')}>
                <Button
                  type="text"
                  icon={<MessageSquarePlus size={16} />}
                  size="small"
                  onClick={() => { void handleNewConversation() }}
                />
              </Tooltip>
            </>
          )}
        </div>
        <div>
          {showArchived ? (
            archivedMultiSelect ? (
              <div className="flex items-center gap-1">
                <Tooltip title={t('chat.unarchive')}>
                  <Button type="text" icon={<Undo2 size={16} />} size="small" disabled={archivedSelectedIds.size === 0} onClick={handleBatchUnarchive} />
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
                  onClick={() => setArchivedMultiSelect(true)}
                />
              </Tooltip>
            )
          ) : multiSelectMode ? (
            <div className="flex items-center gap-1">
              <Tooltip title={t('chat.archive')}>
                <Button type="text" icon={<Archive size={16} />} size="small" disabled={selectedIds.size === 0} onClick={handleBatchArchive} />
              </Tooltip>
              <Tooltip title={t('chat.delete')}>
                <Button type="text" danger icon={<Trash2 size={16} />} size="small" disabled={selectedIds.size === 0} onClick={handleBatchDelete} />
              </Tooltip>
            </div>
          ) : (
            <Tooltip title={t('chat.multiSelect')}>
              <Button
                type="text"
                icon={<ListTodo size={16} />}
                size="small"
                onClick={() => setMultiSelectMode(true)}
              />
            </Tooltip>
          )}
        </div>
      </div>

      {/* Collapsible search */}
      {!showArchived && searchVisible && !multiSelectMode && (
        <div className="chat-sidebar-search" style={{ padding: '4px 12px 8px' }}>
          <Input
            prefix={<Search size={14} />}
            placeholder={t('chat.searchPlaceholder')}
            allowClear
            value={searchText}
            onChange={(e) => handleSearch(e.target.value)}
            size="small"
            autoFocus
          />
        </div>
      )}

      {showArchived ? (
        <div className="flex-1 overflow-y-auto">
          {archivedConversations.length > 0 ? (
            <div style={{ padding: '4px 0' }}>
              {archivedConversations.map((conv) => (
                <div
                  key={conv.id}
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
                  <span className="flex-1 truncate text-sm">{conv.title}</span>
                  {!archivedMultiSelect && (
                    <div className="flex items-center gap-1">
                      <Tooltip title={t('chat.unarchive')}>
                        <Button
                          type="text"
                          size="small"
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
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center py-8" style={{ color: token.colorTextSecondary }}>
              {t('chat.noArchivedConversations')}
            </div>
          )}
        </div>
      ) : (
        <Dropdown
          menu={rightClickMenuConfig}
          trigger={['contextMenu']}
          onOpenChange={(open) => { if (!open) setRightClickedConvId(null) }}
        >
          <div className="flex-1 overflow-y-auto">
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
                .aqbot-chat-conversation-menu-delete {
                  width: 22px;
                  height: 22px;
                  min-width: 22px;
                  padding: 0;
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
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
                @keyframes spin {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
              `}</style>
              {conversationItems.length > 0 ? (
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleCategoryDragStart}
                  onDragOver={handleCategoryDragOver}
                  onDragEnd={handleCategoryDragEnd}
                  onDragCancel={handleCategoryDragCancel}
                >
                  <Conversations
                    items={conversationItems}
                    activeKey={multiSelectMode ? undefined : (activeConversationId ?? undefined)}
                    onActiveChange={handleConversationClick}
                    groupable={{
                      label: (group: string) => renderGroupLabel(group),
                      collapsible: (group: string) => group.startsWith('cat:'),
                      expandedKeys: expandedKeys,
                      onExpand: handleGroupExpand,
                    }}
                    menu={menuConfig}
                  />
                  <DragOverlay>
                    {activeDragCatId ? (() => {
                      const cat = categories.find((c) => c.id === activeDragCatId)
                      if (!cat) return null
                      return (
                        <div className="flex items-center gap-1" style={{ opacity: 0.8, cursor: 'grabbing', fontSize: 13 }}>
                          <GripVertical size={12} style={{ opacity: 0.4 }} />
                          <CategoryIcon cat={cat} size={14} />
                          <span>{cat.name}</span>
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
