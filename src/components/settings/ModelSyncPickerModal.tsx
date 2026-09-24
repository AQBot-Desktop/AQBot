import {
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Segmented,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  Lightbulb,
  ListChecks,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  Search,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import type {
  Model,
  ModelCapability,
  ModelCatalogStatus,
  ModelSyncCandidate,
  ModelSyncStatus,
  ProviderConfig,
} from '@/types';
import {
  MODEL_SYNC_STATUS_CONFIG,
  formatTokenCount,
  getModelGroupName,
} from '@/lib/modelSync';
import { sortGroupKeysByVersionDesc, sortModelsByVersionDesc } from '@/lib/modelVersionSort';
import { SmartModelIcon } from '@/lib/providerIcons';
import { ModelCatalogStatusBar } from './ModelCatalogStatusBar';

const { Text } = Typography;

const KNOWN_CAPABILITIES = new Set<ModelCapability>([
  'TextChat',
  'Vision',
  'FunctionCalling',
  'Reasoning',
  'RealtimeVoice',
]);

const CAPABILITY_ICONS: Record<ModelCapability, ReactNode> = {
  TextChat: <MessageSquare size={14} />,
  Vision: <Eye size={14} />,
  FunctionCalling: <Wrench size={14} />,
  Reasoning: <Lightbulb size={14} />,
  RealtimeVoice: <Mic size={14} />,
};

function isModelCapability(value: unknown): value is ModelCapability {
  return typeof value === 'string' && KNOWN_CAPABILITIES.has(value as ModelCapability);
}

function CapabilitiesSummaryTag({ capabilities }: { capabilities: ModelCapability[] }) {
  const { t } = useTranslation();
  if (capabilities.length === 0) return null;

  const label = t('settings.capabilityCount', { count: capabilities.length });
  const content = (
    <div
      style={{ maxWidth: 280 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {capabilities.map((cap) => {
          const known = isModelCapability(cap);
          const desc = known ? t(`settings.capabilityDesc.${cap}`) : '';
          const name = known ? t(`settings.capability.${cap}`) : cap;
          return (
            <div key={cap} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              {isModelCapability(cap) ? (
                <span style={{ marginTop: 2, flexShrink: 0 }}>{CAPABILITY_ICONS[cap]}</span>
              ) : null}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {name}
                </div>
                {desc ? (
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                    {desc}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <Popover content={content} trigger="hover" placement="topLeft">
      <Tag
        bordered={false}
        aria-label={label}
        style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0, cursor: 'default' }}
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </Tag>
    </Popover>
  );
}

export interface ModelSyncEntry extends ModelSyncCandidate {
  model: Model;
}

type SyncStatusFilter = 'all' | ModelSyncStatus;

const STATUS_FILTER_LABEL_KEYS: Record<ModelSyncStatus, string> = {
  'remote-only': 'settings.syncFilterNew',
  synced: 'settings.syncFilterAdded',
  'local-only': 'settings.syncFilterMissing',
  unsupported: 'settings.syncFilterUnsupported',
};

const STATUS_FILTER_ORDER: ModelSyncStatus[] = ['remote-only', 'synced', 'local-only', 'unsupported'];

interface ModelSyncPickerModalProps {
  open: boolean;
  entries: ModelSyncEntry[];
  catalog: ModelCatalogStatus | null;
  localModels: Model[];
  /** Used as icon fallback when a model_id has no brand mapping (e.g. Cohere/Voyage rerank). */
  provider?: ProviderConfig | null;
  onCancel: () => void;
  onApply: (models: Model[]) => void | Promise<void>;
}

function defaultSelection(entries: ModelSyncEntry[]): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.status !== 'unsupported' && entry.status !== 'remote-only')
      .map((entry) => entry.model.model_id),
  );
}

export function ModelSyncPickerModal({
  open,
  entries,
  catalog,
  localModels,
  provider,
  onCancel,
  onApply,
}: ModelSyncPickerModalProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SyncStatusFilter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  // Anchor model id for shift-click range selection
  const rangeAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(defaultSelection(entries));
    setSearch('');
    setStatusFilter('all');
    setCollapsed(new Set());
    setApplying(false);
    rangeAnchorRef.current = null;
  }, [open, entries]);

  const statusCounts = useMemo(() => {
    const counts: Record<ModelSyncStatus, number> = {
      synced: 0,
      'local-only': 0,
      'remote-only': 0,
      unsupported: 0,
    };
    for (const entry of entries) counts[entry.status] += 1;
    return counts;
  }, [entries]);

  const filterOptions = useMemo(() => {
    const options: { label: string; value: SyncStatusFilter }[] = [
      { label: `${t('settings.syncFilterAll')} ${entries.length}`, value: 'all' },
    ];
    for (const status of STATUS_FILTER_ORDER) {
      if (statusCounts[status] > 0) {
        options.push({
          label: `${t(STATUS_FILTER_LABEL_KEYS[status])} ${statusCounts[status]}`,
          value: status,
        });
      }
    }
    return options;
  }, [entries.length, statusCounts, t]);

  const groups = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (statusFilter !== 'all' && entry.status !== statusFilter) return false;
      if (!keyword) return true;
      return [entry.model.name, entry.model.model_id, getModelGroupName(entry.model)]
        .some((value) => value.toLowerCase().includes(keyword));
    });
    const byGroup: Record<string, ModelSyncEntry[]> = {};
    for (const entry of filtered) {
      const key = getModelGroupName(entry.model);
      if (!byGroup[key]) byGroup[key] = [];
      byGroup[key].push(entry);
    }
    for (const key of Object.keys(byGroup)) {
      byGroup[key] = sortModelsByVersionDesc(byGroup[key], (item) => item.model.model_id);
    }
    const orderedKeys = sortGroupKeysByVersionDesc(Object.keys(byGroup));
    const groupEntries = orderedKeys.map((key) => [key, byGroup[key]] as [string, ModelSyncEntry[]]);
    return { filtered, entries: groupEntries };
  }, [entries, search, statusFilter]);

  // Flatten groups into virtual rows
  type PickerRow =
    | { type: 'group'; group: string; models: ModelSyncEntry[] }
    | { type: 'model'; item: ModelSyncEntry }
    | { type: 'spacer'; beforeGroup: string };
  const flatRows = useMemo<PickerRow[]>(() => {
    const rows: PickerRow[] = [];
    const groupEntries = groups.entries;
    for (let i = 0; i < groupEntries.length; i++) {
      const [group, models] = groupEntries[i];
      if (i > 0) rows.push({ type: 'spacer', beforeGroup: group });
      rows.push({ type: 'group', group, models });
      if (!collapsed.has(group)) {
        for (const item of models) {
          rows.push({ type: 'model', item });
        }
      }
    }
    return rows;
  }, [groups.entries, collapsed]);

  // Visible model rows in display order, used for shift-click range selection
  const visibleModelRows = useMemo(
    () => flatRows.filter((row): row is Extract<PickerRow, { type: 'model' }> => row.type === 'model'),
    [flatRows],
  );

  const listParentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: (index) => (flatRows[index].type === 'spacer' ? 8 : 40),
    getItemKey: (index) => {
      const row = flatRows[index];
      if (row.type === 'spacer') return `spacer-${row.beforeGroup}`;
      if (row.type === 'group') return `group-${row.group}`;
      return `model-${row.item.model.model_id}`;
    },
    overscan: 15,
  });

  const setModelChecked = useCallback((ids: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleModel = useCallback((item: ModelSyncEntry, shiftKey: boolean) => {
    if (item.status === 'unsupported') return;
    const id = item.model.model_id;
    const checked = !selected.has(id);
    const anchor = rangeAnchorRef.current;
    if (shiftKey && anchor && anchor !== id) {
      const ids = visibleModelRows.map((row) => row.item.model.model_id);
      const from = ids.indexOf(anchor);
      const to = ids.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        const rangeIds = visibleModelRows
          .slice(start, end + 1)
          .filter((row) => row.item.status !== 'unsupported')
          .map((row) => row.item.model.model_id);
        setModelChecked(rangeIds, checked);
        rangeAnchorRef.current = id;
        return;
      }
    }
    setModelChecked([id], checked);
    rangeAnchorRef.current = id;
  }, [selected, visibleModelRows, setModelChecked]);

  // Final model list after applying the current selection: selected entries
  // plus local models whose exact catalog mode is unsupported (always kept)
  const finalModels = useMemo(() => {
    const models = entries
      .filter((entry) => entry.status !== 'unsupported' && selected.has(entry.model.model_id))
      .map((entry) => entry.model);
    const selectedIds = new Set(models.map((model) => model.model_id));
    const unsupportedIds = new Set(
      entries
        .filter((entry) => entry.status === 'unsupported')
        .map((entry) => entry.model.model_id),
    );
    for (const localModel of localModels) {
      if (unsupportedIds.has(localModel.model_id) && !selectedIds.has(localModel.model_id)) {
        models.push(localModel);
      }
    }
    return models;
  }, [entries, selected, localModels]);

  const impact = useMemo(() => {
    const localIds = new Set(localModels.map((model) => model.model_id));
    const finalIds = new Set(finalModels.map((model) => model.model_id));
    let added = 0;
    for (const id of finalIds) {
      if (!localIds.has(id)) added += 1;
    }
    const removed = localModels.filter((model) => !finalIds.has(model.model_id)).length;
    const updated = entries.filter((entry) =>
      entry.changes.length > 0
      && localIds.has(entry.model.model_id)
      && selected.has(entry.model.model_id)
      && entry.status !== 'unsupported',
    ).length;
    return { added, removed, updated };
  }, [entries, selected, localModels, finalModels]);

  const handleApply = useCallback(async () => {
    if (finalModels.length === 0) {
      onCancel();
      return;
    }
    setApplying(true);
    try {
      await onApply(finalModels);
    } finally {
      setApplying(false);
    }
  }, [finalModels, onApply, onCancel]);

  const selectableFiltered = groups.filtered.filter(({ status }) => status !== 'unsupported');
  const allFilteredChecked = selectableFiltered.length > 0
    && selectableFiltered.every(({ model }) => selected.has(model.model_id));
  const someFilteredChecked = selectableFiltered.some(({ model }) => selected.has(model.model_id));

  return (
    <Modal
      title={t('settings.syncModels')}
      open={open}
      onCancel={onCancel}
      width={640}
      styles={{ body: { padding: 0 } }}
      afterOpenChange={(nextOpen) => { if (nextOpen) virtualizer.measure(); }}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Space size={10} wrap style={{ textAlign: 'start' }}>
            {impact.added === 0 && impact.updated === 0 && impact.removed === 0 ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('settings.syncImpactNone')}
              </Text>
            ) : (
              <>
                {impact.added > 0 && (
                  <Text style={{ color: token.colorSuccess, fontSize: 12 }}>
                    {t('settings.syncImpactAdd', { count: impact.added })}
                  </Text>
                )}
                {impact.updated > 0 && (
                  <Text style={{ color: token.colorInfo, fontSize: 12 }}>
                    {t('settings.syncImpactUpdate', { count: impact.updated })}
                  </Text>
                )}
                {impact.removed > 0 && (
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {t('settings.syncImpactRemove', { count: impact.removed })}
                  </Text>
                )}
              </>
            )}
          </Space>
          <Space>
            <Button onClick={onCancel}>{t('common.cancel')}</Button>
            {impact.removed > 0 ? (
              <Popconfirm
                title={t('settings.syncRemoveConfirmTitle')}
                description={t('settings.syncRemoveConfirmDesc', { count: impact.removed })}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
                okButtonProps={{ danger: true, disabled: selected.size === 0 }}
                onConfirm={handleApply}
                placement="topRight"
              >
                <Button type="primary" danger loading={applying} disabled={selected.size === 0}>
                  {t('settings.applyModelSync')}
                </Button>
              </Popconfirm>
            ) : (
              <Button
                type="primary"
                loading={applying}
                disabled={selected.size === 0}
                onClick={handleApply}
              >
                {t('settings.applyModelSync')}
              </Button>
            )}
          </Space>
        </div>
      }
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          background: token.colorBgElevated,
          padding: '8px 24px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox
            checked={allFilteredChecked}
            indeterminate={someFilteredChecked && !allFilteredChecked}
            onChange={(e) => {
              setModelChecked(
                selectableFiltered.map(({ model }) => model.model_id),
                e.target.checked,
              );
              rangeAnchorRef.current = null;
            }}
            style={{ whiteSpace: 'nowrap' }}
          >
            {t('common.selectAll')} ({selected.size}/{entries.length})
          </Checkbox>
          <Input
            placeholder={t('settings.searchModels')}
            prefix={<Search size={14} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            size="small"
            style={{ flex: 1 }}
          />
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'select-new',
                  label: t('settings.syncSelectAllNew'),
                  disabled: statusCounts['remote-only'] === 0,
                },
                { key: 'invert', label: t('settings.invertSelection') },
                { key: 'reset', label: t('settings.resetToRecommended') },
              ],
              onClick: ({ key }) => {
                rangeAnchorRef.current = null;
                if (key === 'select-new') {
                  setModelChecked(
                    entries
                      .filter((entry) => entry.status === 'remote-only')
                      .map((entry) => entry.model.model_id),
                    true,
                  );
                } else if (key === 'invert') {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const { model } of selectableFiltered) {
                      if (next.has(model.model_id)) next.delete(model.model_id);
                      else next.add(model.model_id);
                    }
                    return next;
                  });
                } else if (key === 'reset') {
                  setSelected(defaultSelection(entries));
                }
              },
            }}
          >
            <Tooltip title={t('settings.quickSelect')}>
              <Button
                size="small"
                type="text"
                aria-label={t('settings.quickSelect')}
                icon={<ListChecks size={14} />}
              />
            </Tooltip>
          </Dropdown>
          <Tooltip title={collapsed.size === 0 ? t('settings.collapseAll') : t('settings.expandAll')}>
            <Button
              size="small"
              type="text"
              aria-label={collapsed.size === 0 ? t('settings.collapseAll') : t('settings.expandAll')}
              icon={collapsed.size === 0 ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              onClick={() => {
                if (collapsed.size === 0) {
                  setCollapsed(new Set(groups.entries.map(([group]) => group)));
                } else {
                  setCollapsed(new Set());
                }
              }}
            />
          </Tooltip>
        </div>
        {filterOptions.length > 2 && (
          <div data-os-scrollbar style={{ overflowX: 'auto' }}>
            <Segmented
              size="small"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as SyncStatusFilter)}
              options={filterOptions}
            />
          </div>
        )}
      </div>
      {catalog && <ModelCatalogStatusBar status={catalog} />}
      <div
        ref={listParentRef}
        className="model-picker-list"
        data-os-scrollbar
        style={{ maxHeight: 420, overflow: 'auto', padding: '8px 16px 12px' }}
      >
        {flatRows.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('common.noData')}
            style={{ margin: '24px 0' }}
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = flatRows[virtualRow.index];
              if (row.type === 'spacer') {
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 8, transform: `translateY(${virtualRow.start}px)` }}
                  />
                );
              }
              if (row.type === 'group') {
                const { group, models } = row;
                const selectableModels = models.filter(({ status }) => status !== 'unsupported');
                const selectedInGroup = selectableModels.filter(({ model }) => selected.has(model.model_id)).length;
                const allChecked = selectableModels.length > 0 && selectedInGroup === selectableModels.length;
                const someChecked = selectedInGroup > 0;
                const isCollapsed = collapsed.has(group);
                return (
                  <div
                    key={`g-${group}`}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <div
                      className="model-sync-group flex items-center gap-2 px-2 py-1.5 rounded-md"
                      style={{ cursor: 'pointer', userSelect: 'none', background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))' }}
                      role="button"
                      tabIndex={0}
                      aria-expanded={!isCollapsed}
                      onClick={() => setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(group)) next.delete(group); else next.add(group);
                        return next;
                      })}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(group)) next.delete(group); else next.add(group);
                          return next;
                        });
                      }}
                    >
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <div onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={allChecked}
                          indeterminate={someChecked && !allChecked}
                          disabled={selectableModels.length === 0}
                          onChange={(e) => {
                            setModelChecked(
                              selectableModels.map(({ model }) => model.model_id),
                              e.target.checked,
                            );
                            rangeAnchorRef.current = null;
                          }}
                        />
                      </div>
                      <SmartModelIcon modelId={models[0]?.model.model_id ?? group} icon={models[0]?.model.icon} provider={provider} size={20} type="avatar" />
                      <Text style={{ fontWeight: 600 }}>{group}</Text>
                      <Tag style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>
                        {selectableModels.length > 0 ? `${selectedInGroup}/${models.length}` : models.length}
                      </Tag>
                    </div>
                  </div>
                );
              }
              // model row
              const { item } = row;
              const { model: m } = item;
              const unsupported = item.status === 'unsupported';
              return (
                <div
                  key={`m-${m.model_id}`}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div
                    className={`${unsupported ? '' : 'model-sync-row '}flex items-center gap-2 px-2 py-1.5 rounded-md`}
                    style={{ paddingInlineStart: 36, userSelect: 'none' }}
                    onClick={(e) => toggleModel(item, e.shiftKey)}
                  >
                    <div onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(m.model_id)}
                        disabled={unsupported}
                        aria-label={m.model_id}
                        onChange={(e) => {
                          toggleModel(item, Boolean((e.nativeEvent as MouseEvent).shiftKey));
                        }}
                      />
                    </div>
                    <SmartModelIcon modelId={m.model_id} icon={m.icon} provider={provider} size={20} type="avatar" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span style={{ overflowWrap: 'anywhere' }}>{m.name || m.model_id}</span>
                        {m.name && m.name !== m.model_id && (
                          <Text type="secondary" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>({m.model_id})</Text>
                        )}
                        <Tag color={MODEL_SYNC_STATUS_CONFIG[item.status].color} style={{ marginInlineStart: 4 }}>
                          {t(MODEL_SYNC_STATUS_CONFIG[item.status].labelKey)}
                        </Tag>
                        {m.context_window != null && (
                          <Tooltip title={t('settings.contextWindow')}>
                            <Tag
                              bordered={false}
                              aria-label={t('settings.contextWindow')}
                              style={{ marginInlineStart: 4 }}
                            >
                              {formatTokenCount(m.context_window)}
                            </Tag>
                          </Tooltip>
                        )}
                        {m.max_output_tokens != null && (
                          <Tooltip title={t('settings.modelMaxOutputTokens')}>
                            <Tag
                              bordered={false}
                              aria-label={t('settings.modelMaxOutputTokens')}
                            >
                              {formatTokenCount(m.max_output_tokens)}
                            </Tag>
                          </Tooltip>
                        )}
                        <CapabilitiesSummaryTag capabilities={m.capabilities ?? []} />
                      </div>
                      {item.unsupported_reason && (
                        <Text type="danger" style={{ fontSize: 11 }}>
                          {item.unsupported_reason}
                        </Text>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
