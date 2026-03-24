import { useState, useMemo, useCallback, useEffect } from 'react'
import { Button, Input, App, theme, Tooltip, Avatar, Checkbox, Dropdown, Empty } from 'antd'
import { MessageSquarePlus, Search, Archive, ListTodo, Trash2, Pencil, Share, Pin, PinOff, Loader, X, Undo2, ArrowLeft, FileImage, FileCode, FileType, FileText } from 'lucide-react'
import { ModelIcon } from '@lobehub/icons'
import { getConvIcon } from '@/lib/convIcon'
import { exportAsMarkdown, exportAsText, exportAsPNG, exportAsJSON } from '@/lib/exportChat'
import { invoke } from '@/lib/invoke'
import Conversations from '@ant-design/x/es/conversations'
import type { ConversationItemType } from '@ant-design/x/es/conversations/interface'
import { useTranslation } from 'react-i18next'
import { useConversationStore, useProviderStore, useSettingsStore } from '@/stores'
import type { Conversation, Message } from '@/types'

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

  const [searchText, setSearchText] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showArchived, setShowArchived] = useState(false)
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<Set<string>>(new Set())
  const [archivedMultiSelect, setArchivedMultiSelect] = useState(false)
  const [rightClickedConvId, setRightClickedConvId] = useState<string | null>(null)

  // Auto-select first conversation if none selected
  useEffect(() => {
    if (!activeConversationId && conversations.length > 0) {
      const sorted = [...conversations].sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
        return b.updated_at - a.updated_at
      })
      setActiveConversation(sorted[0].id)
    }
  }, [activeConversationId, conversations, setActiveConversation])

  const handleNewConversation = useCallback(async () => {
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

    const conv = await createConversation(
      t('chat.newConversation'),
      model.model_id,
      provider.id,
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
    return [...filtered].sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      return b.updated_at - a.updated_at
    })
  }, [conversations, searchText])

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

  const conversationItems: ConversationItemType[] = useMemo(
    () =>
      filteredConversations.map((conv: Conversation) => {
        const icon = buildIcon(conv)
        const group = conv.is_pinned ? 'pinned' : getDateGroup(conv.updated_at)
        const label = conv.is_pinned ? (
          <span className="flex items-center gap-1">
            <span className="truncate">{conv.title}</span>
            <Pin size={12} style={{ color: token.colorTextQuaternary, flexShrink: 0 }} />
          </span>
        ) : conv.title
        if (multiSelectMode) {
          return {
            key: conv.id,
            label,
            icon: (
              <span className="flex items-center gap-1.5">
                <Checkbox
                  checked={selectedIds.has(conv.id)}
                  onChange={() => toggleSelect(conv.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                {icon}
              </span>
            ),
            group,
            'data-conv-id': conv.id,
          }
        }
        return {
          key: conv.id,
          label,
          icon,
          group,
          'data-conv-id': conv.id,
        }
      }),
    [filteredConversations, multiSelectMode, selectedIds, buildIcon, toggleSelect, token.colorTextQuaternary],
  )

  const groupLabels: Record<string, string> = useMemo(
    () => ({
      pinned: t('chat.pinned'),
      today: t('chat.today'),
      yesterday: t('chat.yesterday'),
      thisWeek: t('chat.thisWeek'),
      thisMonth: t('chat.thisMonth'),
      earlier: t('chat.earlier'),
    }),
    [t],
  )

  const handleRename = useCallback(
    (item: ConversationItemType) => {
      let newTitle = String(item.label ?? '')
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
    [updateConversation, t, modal],
  )

  const handleDelete = useCallback(
    (item: ConversationItemType) => {
      modal.confirm({
        title: t('chat.deleteConfirm'),
        mask: { enabled: true, blur: true },
        okButtonProps: { danger: true },
        onOk: () => deleteConversation(String(item.key)),
      })
    },
    [deleteConversation, t, modal],
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
      return {
        items: [
          {
            key: 'pin',
            label: isPinned ? t('chat.unpin') : t('chat.pin'),
            icon: isPinned ? <PinOff size={14} /> : <Pin size={14} />,
          },
          { key: 'archive', label: t('chat.archive'), icon: <Archive size={14} /> },
          { key: 'rename', label: t('chat.rename'), icon: <Pencil size={14} /> },
          {
            key: 'export',
            label: (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Share size={14} />{t('chat.export')}</span>),
            children: buildExportChildren(String(item.key), String(item.label ?? '')),
          },
          { key: 'delete', label: t('chat.delete'), icon: <Trash2 size={14} />, danger: true },
        ],
        onClick: (menuInfo: { key: string }) => {
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
              handleDelete(item)
              break
          }
        },
      }
    },
    [t, conversations, multiSelectMode, handleRename, handleDelete, togglePin, toggleArchive, buildExportChildren],
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
    return {
      items: [
        { key: 'pin', label: isPinned ? t('chat.unpin') : t('chat.pin'), icon: isPinned ? <PinOff size={14} /> : <Pin size={14} /> },
        { key: 'archive', label: t('chat.archive'), icon: <Archive size={14} /> },
        { key: 'rename', label: t('chat.rename'), icon: <Pencil size={14} /> },
        {
          key: 'export',
          label: (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Share size={14} />{t('chat.export')}</span>),
          children: buildExportChildren(conv.id, conv.title),
        },
        { key: 'delete', label: t('chat.delete'), icon: <Trash2 size={14} />, danger: true },
      ],
      onClick: (menuInfo: { key: string }) => {
        const item = { key: conv.id, label: conv.title } as ConversationItemType
        switch (menuInfo.key) {
          case 'pin': togglePin(conv.id); break
          case 'archive': toggleArchive(conv.id); break
          case 'rename': handleRename(item); break
          case 'delete': handleDelete(item); break
        }
      },
    }
  }, [rightClickedConvId, conversations, t, togglePin, toggleArchive, handleRename, handleDelete, buildExportChildren])

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
              <Tooltip title={t('chat.newConversation')}>
                <Button
                  type="text"
                  icon={<MessageSquarePlus size={16} />}
                  size="small"
                  onClick={handleNewConversation}
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
                      <Tooltip title={t('chat.delete')}>
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<Trash2 size={14} />}
                          onClick={(e) => {
                            e.stopPropagation()
                            modal.confirm({
                              title: t('chat.deleteConfirm'),
                              mask: { enabled: true, blur: true },
                              okButtonProps: { danger: true },
                              onOk: async () => {
                                await deleteConversation(conv.id)
                                await fetchArchivedConversations()
                              },
                            })
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
            <div onContextMenu={(e) => {
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
                @keyframes spin {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
              `}</style>
              {conversationItems.length > 0 ? (
                <Conversations
                  items={conversationItems}
                  activeKey={multiSelectMode ? undefined : (activeConversationId ?? undefined)}
                  onActiveChange={handleConversationClick}
                  groupable={{
                    label: (group) => groupLabels[group] ?? group,
                  }}
                  menu={menuConfig}
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <Empty description={t('chat.noConversations')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                </div>
              )}
            </div>
          </div>
        </Dropdown>
      )}



    </div>
  )
}
