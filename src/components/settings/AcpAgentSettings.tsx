import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Divider,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAcpStore } from '@/stores/acpStore';
import type { AcpRegistryRefreshPolicy, ConfiguredAgent, RegistryAgent } from '@/types/acp';
import {
  AcpAgentIcon,
  decodeAcpAgentIcon,
  encodeAcpAgentIcon,
} from '@/lib/acpAgentIcon';
import { IconEditor } from '@/components/shared/IconEditor';
import { sortRegistryAgents } from '@/lib/acpRegistrySort';
import { SettingsGroup } from './SettingsGroup';
import { SettingsSelect } from './SettingsSelect';

const { Text } = Typography;

const rowStyle = { padding: '4px 0' };

function sortedAgents(agents: ConfiguredAgent[]): ConfiguredAgent[] {
  return [...agents].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

function formatRegistryFetchedAt(
  value: string | null | undefined,
  locale: string,
): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

function SortableAgentRow({
  agent,
  onToggle,
  onEdit,
  onRemove,
}: {
  agent: ConfiguredAgent;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const sortable = useSortable({ id: agent.id });

  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        alignItems: 'center',
        display: 'flex',
        gap: 10,
        opacity: sortable.isDragging ? 0.5 : 1,
        padding: '10px 4px',
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      <button
        aria-label={t('settings.acpAgents.reorder')}
        type="button"
        {...sortable.attributes}
        {...sortable.listeners}
        style={{
          background: 'none',
          border: 0,
          color: token.colorTextQuaternary,
          cursor: sortable.isDragging ? 'grabbing' : 'grab',
          padding: 2,
          touchAction: 'none',
        }}
      >
        <GripVertical size={16} />
      </button>
      <AcpAgentIcon
        agentId={agent.id}
        agentName={agent.name}
        icon={agent.icon}
        size={28}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ alignItems: 'center', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 500 }}>{agent.name}</span>
          <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
            {agent.id}
          </Tag>
          <Tag
            bordered={false}
            color={agent.source === 'custom' ? 'purple' : 'blue'}
            style={{ marginInlineEnd: 0 }}
          >
            {agent.source === 'custom'
              ? t('settings.acpAgents.sourceCustom')
              : t('settings.acpAgents.sourceRegistry')}
          </Tag>
        </div>
        <div
          style={{
            color: token.colorTextDescription,
            fontSize: 12,
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {agent.command}
          {agent.args?.length ? ` ${agent.args.join(' ')}` : ''}
        </div>
      </div>
      <Button size="small" type="text" icon={<Pencil size={14} />} onClick={onEdit}>
        {t('common.edit')}
      </Button>
      <Popconfirm
        title={t('settings.acpAgents.removeConfirmTitle')}
        description={t('settings.acpAgents.removeConfirmContent', { name: agent.name })}
        okText={t('common.delete')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
        onConfirm={() => onRemove()}
      >
        <Button
          size="small"
          type="text"
          danger
          icon={<Trash2 size={14} />}
          aria-label={t('common.delete')}
        />
      </Popconfirm>
      <Switch
        size="small"
        checked={agent.enabled}
        onChange={onToggle}
        aria-label={agent.name}
      />
    </div>
  );
}

interface AgentFormState {
  id: string;
  name: string;
  command: string;
  args: string;
  iconType: string | null;
  iconValue: string;
  source: 'custom' | 'registry';
  enabled: boolean;
  sort: number;
  env?: Record<string, string>;
}

function launchCommandLine(command: string, args: string[] | undefined): string {
  return [command, ...(args ?? [])].filter(Boolean).join(' ');
}

function emptyCustomForm(sort: number): AgentFormState {
  return {
    id: '',
    name: '',
    command: '',
    args: '',
    iconType: null,
    iconValue: '',
    source: 'custom',
    enabled: true,
    sort,
  };
}

function agentToForm(agent: ConfiguredAgent): AgentFormState {
  // decodeAcpAgentIcon strips official registry CDN URLs so IconEditor shows the
  // same brand Color default as the list (not a different CDN / OpenAI-looking SVG).
  const decoded = decodeAcpAgentIcon(agent.icon);
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    args: (agent.args ?? []).join(' '),
    iconType: decoded.type,
    iconValue: decoded.value ?? '',
    source: agent.source === 'custom' ? 'custom' : 'registry',
    enabled: agent.enabled,
    sort: agent.sort,
    env: agent.env,
  };
}

export function AcpAgentSettings() {
  const { t, i18n } = useTranslation();
  const { token } = theme.useToken();
  const config = useAcpStore((s) => s.config);
  const registry = useAcpStore((s) => s.registry);
  const loading = useAcpStore((s) => s.loading);
  const loadConfig = useAcpStore((s) => s.loadConfig);
  const loadRegistry = useAcpStore((s) => s.loadRegistry);
  const setAgentEnabled = useAcpStore((s) => s.setAgentEnabled);
  const previewFromRegistry = useAcpStore((s) => s.previewFromRegistry);
  const addFromRegistry = useAcpStore((s) => s.addFromRegistry);
  const saveGeneral = useAcpStore((s) => s.saveGeneral);
  const upsertCustom = useAcpStore((s) => s.upsertCustom);
  const removeAgent = useAcpStore((s) => s.removeAgent);
  const reorderAgents = useAcpStore((s) => s.reorderAgents);

  const [customOpen, setCustomOpen] = useState(false);
  const [customForm, setCustomForm] = useState<AgentFormState>(() => emptyCustomForm(0));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingCustom, setSavingCustom] = useState(false);

  const [registryOpen, setRegistryOpen] = useState(false);
  const [registryQuery, setRegistryQuery] = useState('');
  const [addingId, setAddingId] = useState<string | null>(null);

  useEffect(() => {
    void loadConfig();
    void loadRegistry(false);
  }, [loadConfig, loadRegistry]);

  const agents = useMemo(
    () => sortedAgents(config?.agents ?? []),
    [config?.agents],
  );
  const configuredIds = useMemo(
    () => new Set(agents.map((a) => a.id)),
    [agents],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const permissionOptions = useMemo(
    () => [
      { value: 'default', label: t('common.permissionDefault') },
      { value: 'auto_approve', label: t('common.permissionAutoApprove') },
    ],
    [t],
  );

  const refreshPolicyOptions = useMemo(
    () => [
      { value: 'on_start', label: t('settings.acpAgents.registryRefreshOnStart') },
      { value: 'manual', label: t('settings.acpAgents.registryRefreshManual') },
      { value: 'never', label: t('settings.acpAgents.registryRefreshNever') },
    ],
    [t],
  );

  const permissionValue = useMemo(() => {
    const raw = config?.general.permissionDefault ?? 'default';
    if (raw === 'prompt' || raw === 'accept_edits') return 'default';
    if (raw === 'full_access') return 'auto_approve';
    return raw;
  }, [config?.general.permissionDefault]);

  const filteredRegistry = useMemo(() => {
    const list = registry?.agents ?? [];
    const q = registryQuery.trim().toLowerCase();
    const filtered = q ? list.filter(
      (a) =>
        a.id.toLowerCase().includes(q)
        || a.name.toLowerCase().includes(q)
        || (a.description ?? '').toLowerCase().includes(q),
    ) : list;
    return sortRegistryAgents(filtered);
  }, [registry, registryQuery]);

  const openAddCustom = useCallback(() => {
    setEditingId(null);
    setCustomForm(emptyCustomForm(agents.length));
    setCustomOpen(true);
  }, [agents.length]);

  const openEditAgent = useCallback((agent: ConfiguredAgent) => {
    setEditingId(agent.id);
    setCustomForm(agentToForm(agent));
    setCustomOpen(true);
  }, []);

  const openRegistryModal = useCallback(() => {
    setRegistryQuery('');
    setRegistryOpen(true);
    void loadRegistry(false);
  }, [loadRegistry]);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const ids = agents.map((a) => a.id);
      const from = ids.indexOf(String(active.id));
      const to = ids.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      const next = [...ids];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void reorderAgents(next);
    },
    [agents, reorderAgents],
  );

  const handleSaveCustom = async () => {
    if (!customForm.id.trim() || !customForm.name.trim() || !customForm.command.trim()) {
      message.warning(t('settings.acpAgents.customRequired'));
      return;
    }
    // New custom agents must not collide with existing ids unless editing same row
    if (
      !editingId
      && configuredIds.has(customForm.id.trim())
    ) {
      message.warning(t('settings.acpAgents.idExists'));
      return;
    }
    setSavingCustom(true);
    try {
      const agent: ConfiguredAgent = {
        id: customForm.id.trim(),
        name: customForm.name.trim(),
        enabled: customForm.enabled,
        source: customForm.source === 'registry' ? 'registry' : 'custom',
        command: customForm.command.trim(),
        args: customForm.args
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
        env: customForm.env ?? {},
        icon: encodeAcpAgentIcon(customForm.iconType, customForm.iconValue || null),
        sort: customForm.sort,
      };
      await upsertCustom(agent);
      message.success(t('settings.acpAgents.saveSuccess'));
      setCustomOpen(false);
    } catch (e) {
      message.error(String(e));
    } finally {
      setSavingCustom(false);
    }
  };

  const commitFromRegistry = async (
    agent: RegistryAgent,
    options?: { allowInstaller?: boolean; approvalToken?: string | null },
  ) => {
    await addFromRegistry(agent.id, options);
    message.success(t('settings.acpAgents.addSuccess', { name: agent.name }));
  };

  const handleAddFromRegistry = async (agent: RegistryAgent) => {
    setAddingId(agent.id);
    try {
      const preview = await previewFromRegistry(agent.id);
      if (preview.outcome === 'alreadyConfigured') {
        return;
      }
      if (preview.outcome === 'quarantined') {
        message.warning(t('settings.acpAgents.quarantineBlocked'));
        return;
      }
      if (preview.outcome === 'manualRequired') {
        Modal.info({
          title: t('settings.acpAgents.manualRequiredTitle'),
          content: t('settings.acpAgents.manualRequiredContent', {
            reason: preview.manualReason ?? '',
          }),
        });
        return;
      }
      if (preview.outcome === 'installRequired') {
        const command = launchCommandLine(preview.command, preview.args);
        const confirmed = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: t('settings.acpAgents.installConfirmTitle'),
            content: (
              <div>
                <div>{t('settings.acpAgents.installConfirmContent', { command })}</div>
                <div style={{ marginTop: 8, color: token.colorTextSecondary, fontSize: 12 }}>
                  {t('settings.acpAgents.installConfirmHint')}
                </div>
              </div>
            ),
            okText: t('settings.acpAgents.installConfirmOk'),
            cancelText: t('common.cancel'),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
        if (!confirmed) return;
        await commitFromRegistry(agent, {
          allowInstaller: true,
          approvalToken: preview.approvalToken,
        });
        return;
      }
      await commitFromRegistry(agent, {
        allowInstaller: false,
        approvalToken: preview.approvalToken,
      });
    } catch (e) {
      message.error(String(e));
    } finally {
      setAddingId(null);
    }
  };

  const handleRemove = useCallback(async (agent: ConfiguredAgent) => {
    try {
      await removeAgent(agent.id);
      message.success(t('settings.acpAgents.removeSuccess'));
    } catch (e) {
      message.error(String(e));
    }
  }, [removeAgent, t]);

  const registryUpdatedLabel = useMemo(
    () => formatRegistryFetchedAt(registry?.fetchedAt, i18n.language),
    [registry?.fetchedAt, i18n.language],
  );

  const refreshTooltip = registryUpdatedLabel
    ? t('settings.acpAgents.refreshTooltipWithDate', { date: registryUpdatedLabel })
    : t('settings.acpAgents.refreshTooltip');

  return (
    <div className="p-6 pb-12" style={{ boxSizing: 'border-box', width: '100%' }}>
      <SettingsGroup title={t('settings.acpAgents.general')}>
        <div style={rowStyle} className="flex items-center justify-between gap-4">
          <span>{t('settings.acpAgents.idleTimeout')}</span>
          <InputNumber
            min={0}
            style={{ width: 140 }}
            value={config?.general.idleTimeoutSecs ?? 1800}
            onChange={(v) => {
              if (!config || v == null) return;
              void saveGeneral({ ...config.general, idleTimeoutSecs: v });
            }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between gap-4">
          <div>
            <div>{t('settings.acpAgents.maxProcesses')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t('settings.acpAgents.maxProcessesHint')}
            </div>
          </div>
          <InputNumber
            min={0}
            max={64}
            style={{ width: 140 }}
            value={config?.general.maxConcurrentProcesses ?? 0}
            onChange={(v) => {
              if (!config || v == null) return;
              void saveGeneral({ ...config.general, maxConcurrentProcesses: v });
            }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between gap-4">
          <div>
            <div>{t('settings.acpAgents.permissionDefault')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t(
                'settings.acpAgents.permissionFallbackHint',
              )}
            </div>
          </div>
          <SettingsSelect
            value={permissionValue}
            options={permissionOptions}
            onChange={(v) => {
              if (!config) return;
              void saveGeneral({ ...config.general, permissionDefault: v });
            }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between gap-4">
          <div>
            <div>{t('settings.acpAgents.registryRefreshPolicy')}</div>
            <div style={{ color: token.colorTextDescription, fontSize: 12 }}>
              {t('settings.acpAgents.registryRefreshHint')}
            </div>
          </div>
          <SettingsSelect
            value={config?.general.registryRefresh ?? 'on_start'}
            options={refreshPolicyOptions}
            onChange={(v) => {
              if (!config) return;
              void saveGeneral({
                ...config.general,
                registryRefresh: v as AcpRegistryRefreshPolicy,
              });
            }}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t('settings.acpAgents.agentsList')}
        extra={(
          <Space size={8} wrap>
            <Button size="small" icon={<Plus size={14} />} onClick={openAddCustom}>
              {t('settings.acpAgents.addCustom')}
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<Plus size={14} />}
              onClick={openRegistryModal}
            >
              {t('settings.acpAgents.addFromRegistry')}
            </Button>
          </Space>
        )}
      >
        {agents.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ maxWidth: 420, margin: '0 auto' }}>
                <Text type="secondary">{t('settings.acpAgents.emptyHint')}</Text>
              </div>
            }
            style={{ padding: '32px 16px' }}
          >
            <Space wrap>
              <Button icon={<Plus size={14} />} onClick={openAddCustom}>
                {t('settings.acpAgents.addCustom')}
              </Button>
              <Button
                type="primary"
                icon={<Plus size={14} />}
                onClick={openRegistryModal}
              >
                {t('settings.acpAgents.addFromRegistry')}
              </Button>
            </Space>
          </Empty>
        ) : (
          <DndContext
            collisionDetection={closestCenter}
            sensors={sensors}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={agents.map((a) => a.id)}
              strategy={verticalListSortingStrategy}
            >
              {agents.map((agent, index) => (
                <div key={agent.id}>
                  {index > 0 && <Divider style={{ margin: 0 }} />}
                  <SortableAgentRow
                    agent={agent}
                    onToggle={(enabled) => void setAgentEnabled(agent.id, enabled)}
                    onEdit={() => openEditAgent(agent)}
                    onRemove={() => handleRemove(agent)}
                  />
                </div>
              ))}
            </SortableContext>
          </DndContext>
        )}
      </SettingsGroup>

      {/* Custom / edit agent modal */}
      <Modal
        open={customOpen}
        title={
          editingId
            ? t('settings.acpAgents.editAgent')
            : t('settings.acpAgents.addCustom')
        }
        onCancel={() => setCustomOpen(false)}
        onOk={() => void handleSaveCustom()}
        confirmLoading={savingCustom}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnHidden
        width={480}
      >
        <div className="flex flex-col gap-3" style={{ paddingTop: 8 }}>
          <div className="flex items-center gap-3">
            <IconEditor
              size={48}
              shape="circle"
              showModelIcons
              iconType={customForm.iconType}
              iconValue={customForm.iconValue}
              defaultIcon={(
                <AcpAgentIcon
                  agentId={customForm.id || editingId || 'custom'}
                  agentName={customForm.name}
                  // Same resolution path as the list row (brand Color / Mono / Bot)
                  icon={null}
                  size={48}
                />
              )}
              onChange={(iconType, iconValue) => {
                setCustomForm((s) => ({
                  ...s,
                  iconType,
                  iconValue: iconValue ?? '',
                }));
              }}
            />
            <div style={{ flex: 1, color: token.colorTextSecondary, fontSize: 12 }}>
              {t('settings.acpAgents.iconHint')}
            </div>
          </div>
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>{t('settings.acpAgents.id')}</div>
            <Input
              placeholder={t('settings.acpAgents.idPlaceholder')}
              value={customForm.id}
              disabled={!!editingId}
              onChange={(e) => setCustomForm((s) => ({ ...s, id: e.target.value }))}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>{t('settings.acpAgents.name')}</div>
            <Input
              value={customForm.name}
              onChange={(e) => setCustomForm((s) => ({ ...s, name: e.target.value }))}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>{t('settings.acpAgents.command')}</div>
            <Input
              placeholder="npx"
              value={customForm.command}
              onChange={(e) => setCustomForm((s) => ({ ...s, command: e.target.value }))}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontSize: 13 }}>{t('settings.acpAgents.args')}</div>
            <Input
              placeholder={t('settings.acpAgents.argsPlaceholder')}
              value={customForm.args}
              onChange={(e) => setCustomForm((s) => ({ ...s, args: e.target.value }))}
            />
          </div>
        </div>
      </Modal>

      {/* Registry picker modal */}
      <Modal
        open={registryOpen}
        title={t('settings.acpAgents.addFromRegistry')}
        onCancel={() => setRegistryOpen(false)}
        footer={null}
        width={560}
        destroyOnHidden
      >
        <div
          style={{
            color: token.colorTextSecondary,
            fontSize: 12,
            marginBottom: 12,
          }}
        >
          {t('settings.acpAgents.localFirstHint')}
          {' '}
          {t('settings.acpAgents.refreshKeepsLaunchHint')}
        </div>
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            gap: 8,
            marginBottom: 12,
            width: '100%',
          }}
        >
          <Input
            prefix={<Search size={14} />}
            placeholder={t('settings.acpAgents.searchRegistry')}
            value={registryQuery}
            onChange={(e) => setRegistryQuery(e.target.value)}
            allowClear
            style={{ flex: 1, minWidth: 0 }}
          />
          <Tooltip title={refreshTooltip}>
            <Button
              icon={<RefreshCw size={14} />}
              loading={loading}
              onClick={() => void loadRegistry(true)}
              style={{ flexShrink: 0 }}
            >
              {t('settings.acpAgents.refresh')}
            </Button>
          </Tooltip>
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {filteredRegistry.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('settings.acpAgents.registryEmpty')}
            />
          ) : (
            filteredRegistry.map((row, index) => {
              const exists = configuredIds.has(row.id);
              const quarantineKey = `settings.acpAgents.quarantineReasons.${row.id}`;
              const localizedQuarantineReason = t(quarantineKey);
              return (
                <div key={row.id}>
                  {index > 0 && <Divider style={{ margin: 0 }} />}
                  <div
                    style={{
                      alignItems: 'center',
                      display: 'flex',
                      gap: 12,
                      padding: '10px 4px',
                    }}
                  >
                    <AcpAgentIcon
                      agentId={row.id}
                      agentName={row.name}
                      icon={row.icon}
                      size={32}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>{row.name}</div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {row.id}
                        {row.version
                          ? ` · ${t('settings.acpAgents.catalogVersion', { version: row.version })}`
                          : ''}
                      </Text>
                      {row.description && (
                        <div
                          style={{
                            color: token.colorTextSecondary,
                            fontSize: 12,
                            marginTop: 2,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {row.description}
                        </div>
                      )}
                      {row.quarantineReason ? (
                        <Tooltip
                          title={localizedQuarantineReason === quarantineKey
                            ? row.quarantineReason
                            : localizedQuarantineReason}
                        >
                          <Tag color="warning" style={{ marginTop: 4 }}>
                            {t('settings.acpAgents.quarantined')}
                          </Tag>
                        </Tooltip>
                      ) : null}
                    </div>
                    <Button
                      size="small"
                      type={exists ? 'default' : 'primary'}
                      icon={<Plus size={14} />}
                      loading={addingId === row.id}
                      disabled={exists || !!row.quarantineReason}
                      onClick={() => void handleAddFromRegistry(row)}
                    >
                      {exists
                        ? t('settings.acpAgents.added')
                        : t('settings.acpAgents.add')}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Modal>
    </div>
  );
}
