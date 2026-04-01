import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Tag, Modal, Input, theme, Tooltip, Button, Checkbox } from 'antd';
import { Search, Settings, Pin, PinOff, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, Wrench, Lightbulb, Mic, MessageSquare, Check } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { useTranslation } from 'react-i18next';
import { useProviderStore, useConversationStore, useSettingsStore, useUIStore } from '@/stores';
import { getShortcutBinding, formatShortcutForDisplay } from '@/lib/shortcuts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { getVisibleModelCapabilities } from '@/lib/modelCapabilities';
import type { ModelCapability, Model } from '@/types';

const PINNED_MODELS_KEY = 'aqbot_pinned_models';

const CAPABILITY_COLORS: Record<ModelCapability, string> = {
  TextChat: 'blue', Vision: 'green', FunctionCalling: 'purple', Reasoning: 'orange', RealtimeVoice: 'red',
};
const CAPABILITY_ICONS: Record<ModelCapability, React.ReactNode> = {
  TextChat: <MessageSquare size={11} />, Vision: <Eye size={11} />, FunctionCalling: <Wrench size={11} />,
  Reasoning: <Lightbulb size={11} />, RealtimeVoice: <Mic size={11} />,
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) { const m = tokens / 1000000; return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`; }
  if (tokens >= 1000) { const k = tokens / 1000; return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`; }
  return `${tokens}`;
}

function loadPinnedModels(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_MODELS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePinnedModels(ids: string[]) {
  localStorage.setItem(PINNED_MODELS_KEY, JSON.stringify(ids));
}

interface ModelSelectorProps {
  style?: React.CSSProperties;
  /** Custom select callback. When provided, overrides the default conversation/settings update. */
  onSelect?: (providerId: string, modelId: string) => void;
  /** Override which model is highlighted as current (e.g. for per-message model switching). */
  overrideCurrentModel?: { providerId: string; modelId: string } | null;
  /** Custom trigger element. When provided, renders this instead of the default Tag. */
  children?: React.ReactNode;
  /** Controlled open state */
  open?: boolean;
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void;
  /** Enable multi-select mode (checkboxes + confirm button) */
  multiSelect?: boolean;
  /** Callback for multi-select mode. Returns array of selected models. */
  onMultiSelect?: (models: Array<{ providerId: string; modelId: string }>) => void;
  /** Pre-selected models for multi-select mode */
  defaultSelectedModels?: Array<{ providerId: string; modelId: string }>;
  /** Model keys to exclude from the list (format: "providerId::modelId") */
  excludeModelKeys?: string[];
}

export function ModelSelector({ style, onSelect, overrideCurrentModel, children, open: controlledOpen, onOpenChange, multiSelect, onMultiSelect, defaultSelectedModels, excludeModelKeys }: ModelSelectorProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { providers } = useProviderStore();
  const { activeConversationId, conversations, updateConversation } =
    useConversationStore();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = useCallback((v: boolean) => {
    if (onOpenChange) onOpenChange(v);
    if (!isControlled) setInternalOpen(v);
  }, [isControlled, onOpenChange]);
  const [search, setSearch] = useState('');
  const [pinnedModels, setPinnedModels] = useState<string[]>(loadPinnedModels);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const listParentRef = useRef<HTMLDivElement>(null);
  const setActivePage = useUIStore((s) => s.setActivePage);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);
  const setSelectedProviderId = useUIStore((s) => s.setSelectedProviderId);

  // Multi-select state
  const [multiSelectedKeys, setMultiSelectedKeys] = useState<Set<string>>(new Set());

  // Reset multi-select state when modal opens with default selections
  useEffect(() => {
    if (open && multiSelect) {
      const initial = new Set(
        (defaultSelectedModels ?? []).map((m) => `${m.providerId}::${m.modelId}`),
      );
      setMultiSelectedKeys(initial);
    }
  }, [open, multiSelect, defaultSelectedModels]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId),
    [conversations, activeConversationId],
  );

  const currentModel = useMemo(() => {
    let pid: string | undefined;
    let mid: string | undefined;
    if (activeConversation) {
      pid = activeConversation.provider_id;
      mid = activeConversation.model_id;
    } else if (settings.default_provider_id && settings.default_model_id) {
      pid = settings.default_provider_id;
      mid = settings.default_model_id;
    } else {
      for (const p of providers) {
        if (!p.enabled) continue;
        const m = p.models.find((m) => m.enabled);
        if (m) { pid = p.id; mid = m.model_id; break; }
      }
    }
    if (!pid || !mid) return null;
    const provider = providers.find((p) => p.id === pid);
    const model = provider?.models.find((m) => m.model_id === mid);
    return { pid, mid, name: model?.name ?? mid, providerName: provider?.name ?? '' };
  }, [activeConversation, settings.default_provider_id, settings.default_model_id, providers]);

  const currentValue = overrideCurrentModel
    ? `${overrideCurrentModel.providerId}::${overrideCurrentModel.modelId}`
    : currentModel ? `${currentModel.pid}::${currentModel.mid}` : undefined;

  // All enabled models flat list (for pinned section)
  const allEnabledModels = useMemo(() => {
    const result: { pid: string; mid: string; name: string; providerName: string; model: Model }[] = [];
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        if (!m.enabled) continue;
        const key = `${p.id}::${m.model_id}`;
        if (excludeModelKeys?.includes(key)) continue;
        result.push({ pid: p.id, mid: m.model_id, name: m.name, providerName: p.name, model: m });
      }
    }
    return result;
  }, [providers, excludeModelKeys]);

  // Pinned models resolved with search filter
  const pinnedItems = useMemo(() => {
    const q = search.toLowerCase().trim();
    return pinnedModels
      .map((key) => {
        const model = allEnabledModels.find((m) => `${m.pid}::${m.mid}` === key);
        return model ? { ...model, key } : null;
      })
      .filter((item): item is NonNullable<typeof item> =>
        item !== null && (!q || item.name.toLowerCase().includes(q) || item.mid.toLowerCase().includes(q)),
      );
  }, [pinnedModels, allEnabledModels, search]);

  // Filtered providers and models (excluding search)
  const filteredProviders = useMemo(() => {
    const q = search.toLowerCase().trim();
    return providers
      .filter((p) => p.enabled)
      .map((p) => ({
        ...p,
        models: p.models.filter(
          (m) => {
            if (!m.enabled) return false;
            if (excludeModelKeys?.includes(`${p.id}::${m.model_id}`)) return false;
            if (!q) return true;
            return m.name.toLowerCase().includes(q) || m.model_id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
          },
        ),
      }))
      .filter((p) => p.models.length > 0);
  }, [providers, search, excludeModelKeys]);

  const handleSelect = useCallback(
    (providerId: string, modelId: string) => {
      if (multiSelect) {
        // In multi-select mode, toggle the selection
        const key = `${providerId}::${modelId}`;
        setMultiSelectedKeys((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }
      if (onSelect) {
        onSelect(providerId, modelId);
      } else if (activeConversationId) {
        updateConversation(activeConversationId, {
          provider_id: providerId,
          model_id: modelId,
        });
      } else {
        saveSettings({ default_provider_id: providerId, default_model_id: modelId });
      }
      setOpen(false);
      setSearch('');
    },
    [activeConversationId, updateConversation, saveSettings, onSelect, setOpen, multiSelect],
  );

  const handleMultiConfirm = useCallback(() => {
    if (!onMultiSelect) return;
    const models = Array.from(multiSelectedKeys).map((key) => {
      const [providerId, modelId] = key.split('::');
      return { providerId, modelId };
    });
    onMultiSelect(models);
    setOpen(false);
    setSearch('');
  }, [multiSelectedKeys, onMultiSelect, setOpen]);

  const togglePin = useCallback((key: string) => {
    setPinnedModels((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      savePinnedModels(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onToggle = () => setOpen(!open);
    window.addEventListener('aqbot:toggle-model-selector', onToggle);
    return () => {
      window.removeEventListener('aqbot:toggle-model-selector', onToggle);
    };
  }, [open, setOpen]);

  // Auto-expand all groups when providers change or modal opens
  const providerIds = useMemo(() => filteredProviders.map((p) => p.id), [filteredProviders]);
  useEffect(() => {
    if (open) setExpandedGroups(providerIds);
  }, [open, providerIds]);

  const allGroupsExpanded = expandedGroups.length >= providerIds.length;

  const toggleGroupExpand = useCallback((providerId: string) => {
    setExpandedGroups((prev) =>
      prev.includes(providerId) ? prev.filter((id) => id !== providerId) : [...prev, providerId],
    );
  }, []);

  const toggleAllGroups = useCallback(() => {
    setExpandedGroups((prev) => (prev.length >= providerIds.length ? [] : [...providerIds]));
    listParentRef.current?.scrollTo({ top: 0 });
  }, [providerIds]);

  // Flatten into virtualizable rows
  type ListRow =
    | { type: 'pinned-header' }
    | { type: 'pinned-model'; pid: string; mid: string; name: string; providerName: string; key: string; model: Model }
    | { type: 'pinned-divider' }
    | { type: 'group'; provider: typeof filteredProviders[number] }
    | { type: 'model'; providerId: string; model: typeof filteredProviders[number]['models'][number]; providerName: string };

  const hasSearchQuery = search.trim().length > 0;
  const flatRows = useMemo<ListRow[]>(() => {
    const rows: ListRow[] = [];
    if (pinnedItems.length > 0) {
      rows.push({ type: 'pinned-header' });
      for (const item of pinnedItems) {
        rows.push({ type: 'pinned-model', ...item });
      }
      rows.push({ type: 'pinned-divider' });
    }
    for (const provider of filteredProviders) {
      rows.push({ type: 'group', provider });
      // When searching, always expand all groups to avoid timing issues with expandedGroups state
      if (hasSearchQuery || expandedGroups.includes(provider.id)) {
        for (const model of provider.models) {
          rows.push({ type: 'model', providerId: provider.id, model, providerName: provider.name });
        }
      }
    }
    return rows;
  }, [pinnedItems, filteredProviders, expandedGroups, hasSearchQuery]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: (index) => {
      const row = flatRows[index];
      if (row.type === 'pinned-divider') return 12;
      if (row.type === 'pinned-header') return 32;
      if (row.type === 'group') return 40;
      return 36;
    },
    getItemKey: (index) => {
      const row = flatRows[index];
      switch (row.type) {
        case 'pinned-header': return 'ph';
        case 'pinned-divider': return 'pd';
        case 'pinned-model': return `pm-${row.key}`;
        case 'group': return `g-${row.provider.id}`;
        case 'model': return `m-${row.providerId}::${row.model.model_id}`;
      }
    },
    overscan: 10,
  });

  const renderModelItem = (
    providerId: string,
    modelId: string,
    modelName: string,
    providerName: string,
    isPinned: boolean,
    showProviderTag: boolean,
    model?: Model,
  ) => {
    const key = `${providerId}::${modelId}`;
    const isActive = multiSelect ? multiSelectedKeys.has(key) : currentValue === key;
    const isHovered = hoveredKey === key;
    const visibleCaps = model ? getVisibleModelCapabilities(model) : [];
    return (
      <div
        className="flex items-center gap-2 cursor-pointer"
        style={{
          backgroundColor: isActive ? token.colorPrimaryBg : isHovered ? token.colorFillSecondary : undefined,
          borderRadius: 6,
          margin: '0 6px',
          padding: '5px 10px',
          transition: 'background-color 0.15s',
        }}
        onClick={() => handleSelect(providerId, modelId)}
        onMouseEnter={() => setHoveredKey(key)}
        onMouseLeave={() => setHoveredKey(null)}
      >
        {multiSelect && (
          <Checkbox
            checked={isActive}
            style={{ pointerEvents: 'none' }}
          />
        )}
        <ModelIcon model={modelId} size={20} type="avatar" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 flex-wrap">
            {showProviderTag && providerName && (
              <Tag style={{ fontSize: 11, margin: 0, padding: '0 4px', lineHeight: '18px', flexShrink: 0, color: token.colorPrimary, backgroundColor: token.colorPrimaryBg, border: 'none' }}>{providerName}</Tag>
            )}
            <span style={{ fontSize: 13, color: isActive ? token.colorPrimary : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelName}</span>
            {visibleCaps.map((cap) => (
              <Tooltip key={cap} title={t(`settings.capability.${cap}`, cap)}>
                <Tag color={CAPABILITY_COLORS[cap]} bordered={false} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                  {CAPABILITY_ICONS[cap]}
                </Tag>
              </Tooltip>
            ))}
            {model?.max_tokens != null && model.max_tokens > 0 && (
              <Tag bordered={false} color="default" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                {formatTokenCount(model.max_tokens)}
              </Tag>
            )}
          </div>
        </div>
        {!multiSelect && (
          <div className="flex items-center gap-1" style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            <span
              style={{ cursor: 'pointer', color: isPinned ? token.colorPrimary : token.colorTextQuaternary, fontSize: 14 }}
              onClick={() => togglePin(key)}
            >
              {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
            </span>
          </div>
        )}
        {multiSelect && isActive && (
          <Check size={14} style={{ color: token.colorPrimary, flexShrink: 0 }} />
        )}
      </div>
    );
  };

  return (
    <>
      {children ? (
        <span onClick={() => setOpen(true)}>{children}</span>
      ) : (
        <Tooltip title={`${t('chat.switchModel', '切换模型')} (${formatShortcutForDisplay(getShortcutBinding(settings, 'toggleModelSelector'))})`} placement="bottom">
        <Tag
          onClick={() => setOpen(true)}
          style={{
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            fontSize: 13,
            borderRadius: 6,
            ...style,
          }}
        >
          {currentModel && (
            <>
              <ModelIcon model={currentModel.mid} size={16} type="avatar" />
              {currentModel.providerName && (
                <Tag style={{ fontSize: 11, margin: 0, padding: '0 4px', lineHeight: '16px', color: token.colorPrimary, backgroundColor: token.colorPrimaryBg, border: 'none' }}>{currentModel.providerName}</Tag>
              )}
              <span>{currentModel.name}</span>
            </>
          )}
        </Tag>
        </Tooltip>
      )}

      <Modal
        open={open}
        onCancel={() => { setOpen(false); setSearch(''); }}
        mask={{ enabled: true, blur: true }}
        footer={multiSelect ? (
          <div className="flex items-center justify-between" style={{ padding: '8px 12px' }}>
            <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
              {t('chat.multiModel.selectedCount', '已选 {{count}} 个模型').replace('{{count}}', String(multiSelectedKeys.size))}
            </span>
            <Button type="primary" size="small" onClick={handleMultiConfirm}>
              {t('common.confirm', '确认')}
            </Button>
          </div>
        ) : null}
        title={multiSelect ? t('chat.multiModel.selectTitle', '选择同时回答的模型') : null}
        closable={false}
        width={420}
        styles={{
          body: { padding: 0, maxHeight: '60vh', display: 'flex', flexDirection: 'column' },
        }}
        rootClassName="model-selector-modal"
        style={{ borderRadius: 12 }}
      >
        {/* Search + Expand/Collapse */}
        <div className="flex items-center gap-2" style={{ padding: '8px 8px 4px' }}>
          <Input
            prefix={<Search size={14} style={{ color: token.colorTextSecondary }} />}
            placeholder={t('chat.searchModelOrProvider', '搜索模型或服务商')}
            variant="borderless"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            style={{
              flex: 1,
              borderRadius: 8,
              backgroundColor: token.colorFillTertiary,
            }}
          />
          <Tooltip title={allGroupsExpanded ? t('common.collapseAll', '全部收起') : t('common.expandAll', '全部展开')}>
            <span
              style={{ cursor: 'pointer', color: token.colorTextSecondary, flexShrink: 0, display: 'flex', alignItems: 'center', padding: 4 }}
              onClick={toggleAllGroups}
            >
              {allGroupsExpanded ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
            </span>
          </Tooltip>
        </div>

        {/* Virtualized model list */}
        <div
          ref={listParentRef}
          data-os-scrollbar
          style={{ overflowY: 'auto', flex: 1, padding: '2px 0 4px' }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = flatRows[virtualRow.index];

              if (row.type === 'pinned-header') {
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="flex items-center px-3 pt-2 pb-0.5"
                    style={{
                      position: 'absolute', top: 0, left: 0, width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                      color: token.colorTextSecondary, fontSize: 12, fontWeight: 500,
                    }}
                  >
                    <PinOff size={11} style={{ marginRight: 4 }} />
                    <span>{t('chat.pinnedModels', '置顶模型')}</span>
                  </div>
                );
              }

              if (row.type === 'pinned-model') {
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute', top: 0, left: 0, width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {renderModelItem(row.pid, row.mid, row.name, row.providerName, true, true, row.model)}
                  </div>
                );
              }

              if (row.type === 'pinned-divider') {
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute', top: 0, left: 0, width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                      padding: '4px 14px',
                    }}
                  >
                    <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }} />
                  </div>
                );
              }

              if (row.type === 'group') {
                const isExpanded = hasSearchQuery || expandedGroups.includes(row.provider.id);
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute', top: 0, left: 0, width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                      padding: '2px 6px',
                    }}
                  >
                    <div
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer"
                      style={{ userSelect: 'none', background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))' }}
                      onClick={() => toggleGroupExpand(row.provider.id)}
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <ModelIcon model={row.provider.models[0]?.model_id ?? row.provider.name} size={20} type="avatar" />
                      <span style={{ fontWeight: 600 }}>{row.provider.name}</span>
                      <Tag style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>{row.provider.models.length}</Tag>
                      <div style={{ flex: 1 }} />
                      <Settings
                        size={14}
                        style={{ cursor: 'pointer', color: token.colorTextQuaternary }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          setSearch('');
                          setActivePage('settings');
                          setSettingsSection('providers');
                          setSelectedProviderId(row.provider.id);
                        }}
                      />
                    </div>
                  </div>
                );
              }

              // type === 'model'
              const isPinned = pinnedModels.includes(`${row.providerId}::${row.model.model_id}`);
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderModelItem(row.providerId, row.model.model_id, row.model.name, row.providerName, isPinned, false, row.model)}
                </div>
              );
            })}
          </div>
        </div>
      </Modal>
    </>
  );
}
