import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Avatar,
  Button,
  Card,
  Divider,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  message,
  theme,
} from 'antd';
import type { InputRef, MenuProps } from 'antd';
import { ChevronDown, Download, Edit3, Plus, Search, Trash2, User, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useConversationStore,
  useMcpStore,
  useProviderStore,
  useRoleStore,
  useSettingsStore,
  useSkillStore,
  useUIStore,
} from '@/stores';
import { IconEditor } from '@/components/shared/IconEditor';
import { ModelParamSliders } from '@/components/common/ModelParamSliders';
import { McpServerIcon } from '@/components/shared/McpServerIcon';
import { OpeningQuestionsEditor } from '@/components/roles/OpeningQuestionsEditor';
import { applyRoleWithRollback, buildApplyRoleUpdate, roleSkillNames } from '@/lib/applyRole';
import {
  normalizeOpeningQuestions,
  parseOpeningQuestionList,
  type OpeningQuestionDraft,
} from '@/lib/openingQuestions';
import { getRoleErrorMessage, validateRoleDraft, type RoleDraftValidation } from '@/lib/roleErrorMessage';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import type { CreateRoleInput, MarketplaceRole, Role, RoleOpeningQuestion, UpdateRoleInput } from '@/types';
import type { AvatarType } from '@/stores/userProfileStore';

/** Keep modal inside the app window with room for margins; header/footer stay visible. */
const ROLE_MODAL_CONTAINER_STYLE: CSSProperties = {
  maxHeight: 'calc(100vh - 48px)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};
const ROLE_MODAL_BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
};
const ROLE_MODAL_HEADER_STYLE: CSSProperties = {
  flexShrink: 0,
};
const ROLE_MODAL_FOOTER_STYLE: CSSProperties = {
  flexShrink: 0,
};

const { Text, Paragraph, Title } = Typography;

interface RoleDraft {
  name: string;
  description: string;
  systemPrompt: string;
  openingMessage: string;
  openingQuestions: OpeningQuestionDraft[];
  tags: string[];
  avatarType: string | null;
  avatarValue: string;
  temperature: number | null;
  topP: number | null;
  enabledMcpServerIds: string[];
  enabledSkillNames: string[];
}

const emptyDraft: RoleDraft = {
  name: '',
  description: '',
  systemPrompt: '',
  openingMessage: '',
  openingQuestions: [],
  tags: [],
  avatarType: null,
  avatarValue: '',
  temperature: null,
  topP: null,
  enabledMcpServerIds: [],
  enabledSkillNames: [],
};

let didAutoOpenMarketplace = false;

function roleToDraft(role: Role): RoleDraft {
  return {
    name: role.name,
    description: role.description ?? '',
    systemPrompt: role.system_prompt,
    openingMessage: role.opening_message ?? '',
    openingQuestions: questionsToDraft(role.opening_questions),
    tags: role.tags,
    avatarType: role.avatar_type ?? (role.avatar ? inferAvatarType(role.avatar) : null),
    avatarValue: role.avatar_value ?? role.avatar ?? '',
    temperature: role.temperature,
    topP: role.top_p,
    enabledMcpServerIds: role.enabled_mcp_server_ids ?? [],
    enabledSkillNames: role.enabled_skill_names ?? [],
  };
}

function draftToCreateInput(draft: RoleDraft): CreateRoleInput {
  const avatarValue = draft.avatarValue.trim();
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    system_prompt: draft.systemPrompt.trim(),
    opening_message: draft.openingMessage.trim() || null,
    opening_questions: draftOpeningQuestions(draft),
    tags: cleanList(draft.tags),
    avatar: draft.avatarType === 'emoji' ? avatarValue || null : null,
    avatar_type: draft.avatarType,
    avatar_value: avatarValue || null,
    temperature: draft.temperature,
    top_p: draft.topP,
    enabled_mcp_server_ids: draft.enabledMcpServerIds,
    enabled_skill_names: draft.enabledSkillNames,
    source_kind: 'local',
    source_ref: null,
  };
}

function draftToUpdateInput(draft: RoleDraft): UpdateRoleInput {
  const avatarValue = draft.avatarValue.trim();
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    system_prompt: draft.systemPrompt.trim(),
    opening_message: draft.openingMessage.trim() || null,
    opening_questions: draftOpeningQuestions(draft),
    tags: cleanList(draft.tags),
    avatar: draft.avatarType === 'emoji' ? avatarValue || null : null,
    avatar_type: draft.avatarType,
    avatar_value: avatarValue || null,
    temperature: draft.temperature,
    top_p: draft.topP,
    enabled_mcp_server_ids: draft.enabledMcpServerIds,
    enabled_skill_names: draft.enabledSkillNames,
  };
}

function cleanList(values: string[]): string[] {
  return values.map((item) => item.trim()).filter(Boolean);
}

function questionsToDraft(value: Role['opening_questions']): OpeningQuestionDraft[] {
  return (parseOpeningQuestionList(value) ?? []).map((item) => ({
    title: item.title ?? '',
    content: item.content,
  }));
}

function draftOpeningQuestions(draft: RoleDraft): RoleOpeningQuestion[] {
  const normalized = normalizeOpeningQuestions(draft.openingQuestions);
  return normalized.ok ? normalized.items : [];
}

function inferAvatarType(value: string): string {
  return value.startsWith('http://') || value.startsWith('https://') ? 'url' : 'emoji';
}

function getRoleAvatar(role: Pick<Role | MarketplaceRole, 'avatar' | 'avatar_type' | 'avatar_value'>) {
  const value = role.avatar_value ?? role.avatar ?? '';
  return {
    type: role.avatar_type ?? (value ? inferAvatarType(value) : null),
    value,
  };
}

function RoleAvatar({ role }: { role: Pick<Role | MarketplaceRole, 'name' | 'avatar' | 'avatar_type' | 'avatar_value'> }) {
  const avatar = getRoleAvatar(role);
  const resolvedSrc = useResolvedAvatarSrc((avatar.type as AvatarType) ?? 'icon', avatar.value);
  if (avatar.type === 'emoji' && avatar.value) {
    return (
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-fill-alter)',
          fontSize: 20,
          flexShrink: 0,
        }}
      >
        {avatar.value}
      </div>
    );
  }
  if ((avatar.type === 'url' || avatar.type === 'file') && avatar.value) {
    const direct = avatar.value.slice(0, 64).toLowerCase().startsWith('data:image/')
      || avatar.value.startsWith('http://')
      || avatar.value.startsWith('https://')
      || avatar.value.startsWith('aqbot-media://');
    const src = avatar.type === 'file'
      ? (resolvedSrc ?? (direct ? avatar.value : undefined))
      : avatar.value;
    return <Avatar size={36} shape="square" src={src} style={{ flexShrink: 0, borderRadius: 8 }} />;
  }
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-fill-alter)',
        fontSize: 20,
        flexShrink: 0,
      }}
    >
      {role.name.slice(0, 1) || 'R'}
    </div>
  );
}

export function RolesPage() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [messageApi, contextHolder] = message.useMessage();

  const {
    roles,
    marketplaceRoles,
    marketplaceSources,
    selectedMarketplaceSource,
    loading,
    marketplaceLoading,
    ensureRolesLoaded,
    ensureMarketplaceSourcesLoaded,
    setMarketplaceSource,
    createRole,
    updateRole,
    deleteRole,
    searchMarketplace,
    installRole,
  } = useRoleStore();
  const conversations = useConversationStore((s) => s.conversations);
  const archivedConversations = useConversationStore((s) => s.archivedConversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const createConversation = useConversationStore((s) => s.createConversation);
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation);
  const providers = useProviderStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const setActivePage = useUIStore((s) => s.setActivePage);
  const mcpServers = useMcpStore((s) => s.servers);
  const ensureMcpLoaded = useMcpStore((s) => s.ensureServersLoaded);
  const skills = useSkillStore((s) => s.skills);
  const ensureSkillsLoaded = useSkillStore((s) => s.ensureSkillsLoaded);
  const toggleSkill = useSkillStore((s) => s.toggleSkill);

  const [activeTab, setActiveTab] = useState('roles');
  const [query, setQuery] = useState('');
  const [marketplaceQuery, setMarketplaceQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<RoleDraftValidation>({});
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [draft, setDraft] = useState<RoleDraft>(emptyDraft);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [installingRef, setInstallingRef] = useState<string | null>(null);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const tagInputRef = useRef<InputRef>(null);
  const activeConversation = conversations.find((item) => item.id === activeConversationId)
    ?? archivedConversations.find((item) => item.id === activeConversationId);

  useEffect(() => {
    void Promise.resolve(ensureRolesLoaded()).finally(() => setRolesLoaded(true));
    void ensureMarketplaceSourcesLoaded();
  }, [ensureMarketplaceSourcesLoaded, ensureRolesLoaded]);

  useEffect(() => {
    if (didAutoOpenMarketplace || !rolesLoaded || roles.length > 0) return;
    didAutoOpenMarketplace = true;
    setActiveTab('marketplace');
    void searchMarketplace(marketplaceQuery);
  }, [marketplaceQuery, roles.length, rolesLoaded, searchMarketplace]);

  const filteredRoles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((role) =>
      role.name.toLowerCase().includes(q)
      || (role.description ?? '').toLowerCase().includes(q)
      || role.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [query, roles]);

  const pickModel = useCallback(() => {
    if (settings.default_provider_id && settings.default_model_id) {
      const provider = providers.find((item) => item.id === settings.default_provider_id && item.enabled);
      const model = provider?.models.find((item) => item.model_id === settings.default_model_id && item.enabled);
      if (provider && model) return { provider, model };
    }

    const active = conversations.find((item) => item.id === activeConversationId);
    if (active) {
      const provider = providers.find((item) => item.id === active.provider_id && item.enabled);
      const model = provider?.models.find((item) => item.model_id === active.model_id && item.enabled);
      if (provider && model) return { provider, model };
    }

    const provider = providers.find((item) => item.enabled && item.models.some((model) => model.enabled));
    const model = provider?.models.find((item) => item.enabled);
    return provider && model ? { provider, model } : null;
  }, [activeConversationId, conversations, providers, settings.default_model_id, settings.default_provider_id]);

  const ensureRoleSkillsEnabled = useCallback(async (role: Role) => {
    const names = roleSkillNames(role);
    if (names.length === 0) return;
    await ensureSkillsLoaded();
    const current = useSkillStore.getState().skills;
    await Promise.all(
      names.map(async (name) => {
        const skill = current.find((item) => item.name === name);
        if (skill && !skill.enabled) {
          await toggleSkill(name, true);
        }
      }),
    );
  }, [ensureSkillsLoaded, toggleSkill]);

  const applyToCurrentConversation = useCallback(async (role: Role) => {
    if (!activeConversation) {
      messageApi.error(t('roles.conversationMissing'));
      return;
    }
    try {
      await applyRoleWithRollback(activeConversation.id, role, async () => {
        await updateConversation(activeConversation.id, buildApplyRoleUpdate(role, {
          currentMode: activeConversation.mode,
        }));
      });
      await ensureRoleSkillsEnabled(role);
      setActivePage('chat');
      messageApi.success(t('roles.applied'));
    } catch (e) {
      messageApi.error(getRoleErrorMessage(e, t) || t('roles.applyFailed'));
    }
  }, [activeConversation, ensureRoleSkillsEnabled, messageApi, setActivePage, t, updateConversation]);

  const createConversationWithRole = useCallback(async (role: Role) => {
    const selection = pickModel();
    if (!selection) {
      messageApi.warning(t('chat.noModelsAvailable'));
      return;
    }
    const conversation = await createConversation(role.name, selection.model.model_id, selection.provider.id);
    try {
      await applyRoleWithRollback(conversation.id, role, async () => {
        await updateConversation(conversation.id, buildApplyRoleUpdate(role));
      });
      await ensureRoleSkillsEnabled(role);
      setActiveConversation(conversation.id);
      setActivePage('chat');
    } catch (e) {
      messageApi.error(getRoleErrorMessage(e, t) || t('roles.applyFailed'));
    }
  }, [createConversation, ensureRoleSkillsEnabled, messageApi, pickModel, setActiveConversation, setActivePage, t, updateConversation]);

  const useRole = useCallback((role: Role) => {
    void createConversationWithRole(role);
  }, [createConversationWithRole]);

  const roleActionMenu = useCallback((role: Role): MenuProps => ({
    items: [
      {
        key: 'current',
        label: t('roles.applyToCurrent'),
        icon: <Wand2 size={14} />,
        disabled: !activeConversation,
      },
    ],
    onClick: () => {
      void applyToCurrentConversation(role);
    },
  }), [activeConversation, applyToCurrentConversation, t]);

  const openCreate = useCallback(() => {
    setEditingRole(null);
    setDraft(emptyDraft);
    setFieldErrors({});
    setTagInput('');
    setModalOpen(true);
    void ensureMcpLoaded();
    void ensureSkillsLoaded();
  }, [ensureMcpLoaded, ensureSkillsLoaded]);

  const openEdit = useCallback((role: Role) => {
    setEditingRole(role);
    setDraft(roleToDraft(role));
    setFieldErrors({});
    setTagInput('');
    setModalOpen(true);
    void ensureMcpLoaded();
    void ensureSkillsLoaded();
  }, [ensureMcpLoaded, ensureSkillsLoaded]);

  const mcpSelectOptions = useMemo(() => {
    const enabled = mcpServers.filter((server) => server.enabled);
    const byId = new Map(enabled.map((server) => [server.id, server]));
    // Keep previously selected but now-disabled servers visible so they can be cleared.
    for (const id of draft.enabledMcpServerIds) {
      if (!byId.has(id)) {
        const stale = mcpServers.find((server) => server.id === id);
        if (stale) byId.set(id, stale);
      }
    }
    return Array.from(byId.values()).map((server) => ({
      value: server.id,
      label: server.name,
      server,
    }));
  }, [draft.enabledMcpServerIds, mcpServers]);

  const skillSelectOptions = useMemo(() => {
    const groups = new Map<string, { label: string; options: { value: string; label: string; description?: string }[] }>();
    for (const skill of skills) {
      const source = skill.source || 'other';
      const sourceKey = `skills.source.${source}`;
      const localizedSource = t(sourceKey);
      const group = groups.get(source) ?? {
        label: localizedSource === sourceKey ? source : localizedSource,
        options: [],
      };
      group.options.push({
        value: skill.name,
        label: skill.name,
        description: skill.description,
      });
      groups.set(source, group);
    }
    return Array.from(groups.values());
  }, [skills, t]);

  const saveDraft = useCallback(async () => {
    const errors = validateRoleDraft(draft, t);
    setFieldErrors(errors);
    if (errors.name || errors.systemPrompt || errors.openingQuestion) {
      if (errors.openingQuestionIndex != null) {
        document
          .querySelector(`[data-opening-question-index="${errors.openingQuestionIndex}"]`)
          ?.scrollIntoView({ block: 'center' });
      }
      messageApi.error(errors.name || errors.systemPrompt || errors.openingQuestion);
      return;
    }

    setSaving(true);
    try {
      if (editingRole) {
        await updateRole(editingRole.id, draftToUpdateInput(draft));
      } else {
        await createRole(draftToCreateInput(draft));
      }
      messageApi.success(t('roles.saveSuccess'));
      setModalOpen(false);
      setDraft(emptyDraft);
      setFieldErrors({});
      setEditingRole(null);
    } catch (e) {
      messageApi.error(getRoleErrorMessage(e, t));
    } finally {
      setSaving(false);
    }
  }, [createRole, draft, editingRole, messageApi, t, updateRole]);

  const handleDeleteRole = useCallback(async (roleId: string) => {
    try {
      await deleteRole(roleId);
      messageApi.success(t('roles.deleteSuccess'));
    } catch (e) {
      messageApi.error(getRoleErrorMessage(e, t) || t('roles.deleteFailed'));
    }
  }, [deleteRole, messageApi, t]);

  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key);
    if (key === 'marketplace') {
      void searchMarketplace(marketplaceQuery);
    }
  }, [marketplaceQuery, searchMarketplace]);

  const handleMarketplaceSourceChange = useCallback((sourceId: string) => {
    setMarketplaceSource(sourceId);
    void searchMarketplace(marketplaceQuery);
  }, [marketplaceQuery, searchMarketplace, setMarketplaceSource]);

  const installMarketplaceRole = useCallback(async (role: MarketplaceRole) => {
    setInstallingRef(role.source_ref);
    try {
      await installRole(role.source_kind, role.source_ref);
      messageApi.success(t('roles.installSuccess'));
    } catch (e) {
      messageApi.error(getRoleErrorMessage(e, t) || t('roles.installFailed'));
    } finally {
      setInstallingRef(null);
    }
  }, [installRole, messageApi, t]);

  const addTag = useCallback(() => {
    const value = tagInput.trim();
    if (!value) return;
    setDraft((s) => (s.tags.includes(value) ? s : { ...s, tags: [...s.tags, value] }));
    setTagInput('');
    tagInputRef.current?.focus();
  }, [tagInput]);

  const removeTag = useCallback((tag: string) => {
    setDraft((s) => ({ ...s, tags: s.tags.filter((item) => item !== tag) }));
  }, []);

  const renderRoleCard = (role: Role) => (
    <Card key={role.id} size="small" style={{ marginBottom: 8 }} styles={{ body: { padding: 14 } }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <RoleAvatar role={role} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8} wrap>
            <Text strong>{role.name}</Text>
            {role.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
          </Space>
          {role.description ? (
            <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: '4px 0 0', fontSize: 13 }}>
              {role.description}
            </Paragraph>
          ) : null}
        </div>
        <Space size={4} wrap>
          <Space.Compact>
            <Button size="small" aria-label={t('roles.use')} icon={<Wand2 size={14} />} onClick={() => useRole(role)}>
              {t('roles.use')}
            </Button>
            <Dropdown menu={roleActionMenu(role)} trigger={['click']}>
              <Button size="small" aria-label={t('roles.moreActions')} icon={<ChevronDown size={14} />} />
            </Dropdown>
          </Space.Compact>
          <Button size="small" type="text" icon={<Edit3 size={14} />} onClick={() => openEdit(role)}>
            {t('roles.edit')}
          </Button>
          <Popconfirm
            title={t('roles.deleteConfirm')}
            okText={t('roles.delete')}
            cancelText={t('common.cancel')}
            onConfirm={() => { void handleDeleteRole(role.id); }}
          >
            <Button size="small" type="text" danger icon={<Trash2 size={14} />}>
              {t('roles.delete')}
            </Button>
          </Popconfirm>
        </Space>
      </div>
    </Card>
  );

  const renderMarketplaceCard = (role: MarketplaceRole) => (
    <Card key={role.id} size="small" style={{ marginBottom: 8 }} styles={{ body: { padding: 14 } }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <RoleAvatar role={role} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8} wrap>
            <Text strong>{role.name}</Text>
            {role.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
          </Space>
          {role.description ? (
            <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: '4px 0 0', fontSize: 13 }}>
              {role.description}
            </Paragraph>
          ) : null}
        </div>
        <Button
          size="small"
          type="primary"
          icon={<Download size={14} />}
          loading={installingRef === role.source_ref}
          disabled={role.installed}
          onClick={() => installMarketplaceRole(role)}
        >
          {role.installed ? t('roles.installed') : t('roles.install')}
        </Button>
      </div>
    </Card>
  );

  const sourceOptions = (marketplaceSources.length > 0
    ? marketplaceSources
    : [{ id: 'prompts-chat', name: 'prompts.chat', default: true }]
  ).map((source) => ({ value: source.id, label: source.name }));

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: token.colorBgContainer }}>
      {contextHolder}
      <div style={{ padding: '16px 20px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} align="center">
          <Title level={4} style={{ margin: 0 }}>{t('roles.title')}</Title>
          <Button type="primary" icon={<Plus size={14} />} onClick={openCreate}>
            {t('roles.create')}
          </Button>
        </Space>
      </div>

      <div
        data-testid="roles-tabs-shell"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16 }}
      >
        <Tabs
          className="roles-page-tabs"
          activeKey={activeTab}
          onChange={handleTabChange}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
          tabBarStyle={{ flexShrink: 0 }}
          items={[
            {
              key: 'roles',
              label: t('roles.myRoles'),
              children: (
                <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <Input
                    allowClear
                    prefix={<Search size={14} />}
                    placeholder={t('roles.searchPlaceholder')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    style={{ maxWidth: 320, marginBottom: 12, flexShrink: 0 }}
                  />
                  <div
                    data-os-scrollbar
                    data-testid="roles-list-scroll"
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 }}
                  >
                    <Spin spinning={loading}>
                      {filteredRoles.length > 0
                        ? filteredRoles.map(renderRoleCard)
                        : <Empty description={t('roles.emptyDesc')} />}
                    </Spin>
                  </div>
                </div>
              ),
            },
            {
              key: 'marketplace',
              label: t('roles.marketplace'),
              children: (
                <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <Space.Compact style={{ maxWidth: 380, marginBottom: 12, flexShrink: 0 }}>
                    <Select
                      aria-label={t('roles.marketplaceSource')}
                      value={selectedMarketplaceSource}
                      options={sourceOptions}
                      onChange={handleMarketplaceSourceChange}
                      style={{ width: 150 }}
                    />
                    <Input
                      allowClear
                      prefix={<Search size={14} />}
                      placeholder={t('roles.searchPlaceholder')}
                      value={marketplaceQuery}
                      onChange={(event) => setMarketplaceQuery(event.target.value)}
                      onPressEnter={() => searchMarketplace(marketplaceQuery)}
                    />
                    <Button onClick={() => searchMarketplace(marketplaceQuery)}>
                      {t('common.search')}
                    </Button>
                  </Space.Compact>
                  <div
                    data-os-scrollbar
                    data-testid="roles-marketplace-list-scroll"
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 }}
                  >
                    {marketplaceLoading ? (
                      <div
                        data-testid="roles-marketplace-loading"
                        style={{
                          height: '100%',
                          minHeight: 180,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Spin />
                      </div>
                    ) : (
                      marketplaceRoles.length > 0
                        ? marketplaceRoles.map(renderMarketplaceCard)
                        : <Empty description={t('roles.marketplaceEmpty')} />
                    )}
                  </div>
                </div>
              ),
            },
          ]}
        />
        <style>{`
          .roles-page-tabs > .ant-tabs-content-holder {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }
          .roles-page-tabs > .ant-tabs-content-holder > .ant-tabs-content {
            flex: 1;
            min-height: 0;
          }
          .roles-page-tabs > .ant-tabs-content-holder > .ant-tabs-content > .ant-tabs-tabpane-active {
            height: 100%;
            display: flex;
            flex-direction: column;
          }
        `}</style>
      </div>

      <Modal
        title={editingRole ? t('roles.edit') : t('roles.create')}
        open={modalOpen}
        mask={{ enabled: true, blur: true }}
        onCancel={() => {
          setModalOpen(false);
          setFieldErrors({});
        }}
        onOk={saveDraft}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saving}
        destroyOnHidden
        centered
        width={560}
        style={{ maxWidth: 'calc(100vw - 48px)' }}
        styles={{
          container: ROLE_MODAL_CONTAINER_STYLE,
          header: ROLE_MODAL_HEADER_STYLE,
          body: ROLE_MODAL_BODY_STYLE,
          footer: ROLE_MODAL_FOOTER_STYLE,
        }}
      >
        <Form layout="vertical">
          <Form.Item label={t('roles.avatar')} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <IconEditor
                iconType={draft.avatarType}
                iconValue={draft.avatarValue}
                onChange={(avatarType, avatarValue) => {
                  setDraft((s) => ({ ...s, avatarType, avatarValue: avatarValue ?? '' }));
                }}
                size={84}
                defaultIcon={(
                  <Avatar
                    size={84}
                    icon={<User size={28} />}
                    style={{ backgroundColor: token.colorFillSecondary, color: token.colorTextSecondary }}
                  />
                )}
                showClear
              />
            </div>
          </Form.Item>

          <Form.Item
            label={t('roles.name')}
            required
            validateStatus={fieldErrors.name ? 'error' : undefined}
            help={fieldErrors.name}
          >
            <Input
              value={draft.name}
              onChange={(event) => {
                const name = event.target.value;
                setDraft((s) => ({ ...s, name }));
                if (fieldErrors.name) {
                  setFieldErrors((s) => ({ ...s, name: name.trim() ? undefined : s.name }));
                }
              }}
              placeholder={t('roles.namePlaceholder')}
              maxLength={80}
              showCount
            />
          </Form.Item>

          <Form.Item label={t('roles.description')}>
            <Input
              value={draft.description}
              onChange={(event) => setDraft((s) => ({ ...s, description: event.target.value }))}
              placeholder={t('roles.descriptionPlaceholder')}
            />
          </Form.Item>

          <Form.Item
            label={t('roles.systemPrompt')}
            required
            validateStatus={fieldErrors.systemPrompt ? 'error' : undefined}
            help={fieldErrors.systemPrompt}
          >
            <Input.TextArea
              rows={6}
              value={draft.systemPrompt}
              onChange={(event) => {
                const systemPrompt = event.target.value;
                setDraft((s) => ({ ...s, systemPrompt }));
                if (fieldErrors.systemPrompt) {
                  setFieldErrors((s) => ({
                    ...s,
                    systemPrompt: systemPrompt.trim() ? undefined : s.systemPrompt,
                  }));
                }
              }}
              placeholder={t('roles.systemPromptPlaceholder')}
            />
          </Form.Item>

          <Form.Item label={t('roles.openingMessage')}>
            <Input.TextArea
              rows={2}
              value={draft.openingMessage}
              onChange={(event) => setDraft((s) => ({ ...s, openingMessage: event.target.value }))}
              placeholder={t('roles.openingMessagePlaceholder')}
            />
          </Form.Item>

          <Form.Item
            label={t('roles.openingQuestions')}
            validateStatus={fieldErrors.openingQuestion ? 'error' : undefined}
            help={fieldErrors.openingQuestion}
          >
            <OpeningQuestionsEditor
              items={draft.openingQuestions}
              errorIndex={fieldErrors.openingQuestionIndex}
              onChange={(openingQuestions) => {
                setDraft((s) => ({ ...s, openingQuestions }));
                if (fieldErrors.openingQuestion) {
                  setFieldErrors((s) => ({
                    ...s,
                    openingQuestion: undefined,
                    openingQuestionIndex: undefined,
                  }));
                }
              }}
            />
          </Form.Item>

          <Form.Item label={t('roles.tags')}>
            <Space size={[6, 8]} wrap>
              {draft.tags.map((tag) => (
                <Tag key={tag} closable onClose={(event) => {
                  event.preventDefault();
                  removeTag(tag);
                }}>
                  {tag}
                </Tag>
              ))}
              <Input
                ref={tagInputRef}
                size="small"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                onPressEnter={addTag}
                onBlur={addTag}
                placeholder={t('roles.addTag')}
                style={{ width: 120 }}
              />
            </Space>
          </Form.Item>

          <Form.Item label={t('roles.modelParams')}>
            <ModelParamSliders
              values={{
                temperature: draft.temperature,
                topP: draft.topP,
                maxTokens: null,
                frequencyPenalty: null,
              }}
              onChange={(values) => {
                setDraft((s) => ({
                  ...s,
                  temperature: values.temperature !== undefined ? values.temperature : s.temperature,
                  topP: values.topP !== undefined ? values.topP : s.topP,
                }));
              }}
              defaults={{ temperature: 0.7, topP: 1 }}
              visibleParams={['temperature', 'topP']}
            />
          </Form.Item>

          <Divider style={{ margin: '8px 0 16px' }}>{t('roles.capabilities')}</Divider>

          <Form.Item
            label={t('roles.mcpServers')}
            extra={t('roles.mcpServersHint')}
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={mcpSelectOptions.length === 0 ? t('roles.mcpEmpty') : t('roles.mcpServersPlaceholder')}
              value={draft.enabledMcpServerIds}
              onChange={(ids) => setDraft((s) => ({ ...s, enabledMcpServerIds: ids }))}
              options={mcpSelectOptions}
              optionRender={(option) => (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {option.data?.server ? (
                    <McpServerIcon server={option.data.server} size={16} />
                  ) : null}
                  <span>{option.label}</span>
                </span>
              )}
              labelRender={(props) => {
                const server = mcpSelectOptions.find((item) => item.value === props.value)?.server;
                return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {server ? <McpServerIcon server={server} size={14} /> : null}
                    <span>{props.label}</span>
                  </span>
                );
              }}
              style={{ width: '100%' }}
              maxTagCount="responsive"
              notFoundContent={t('roles.mcpEmpty')}
            />
          </Form.Item>

          <Form.Item
            label={t('roles.skills')}
            extra={t('roles.skillsHint')}
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={skillSelectOptions.length === 0 ? t('roles.skillsEmpty') : t('roles.skillsPlaceholder')}
              value={draft.enabledSkillNames}
              onChange={(names) => setDraft((s) => ({ ...s, enabledSkillNames: names }))}
              options={skillSelectOptions}
              optionRender={(option) => {
                // Grouped options make antd type `option.data` as the group node;
                // leaf entries still carry `description` at runtime.
                const description = skills.find((s) => s.name === option.value)?.description;
                return (
                  <div style={{ lineHeight: 1.3 }}>
                    <div>{option.label}</div>
                    {description ? (
                      <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                        {description}
                      </div>
                    ) : null}
                  </div>
                );
              }}
              style={{ width: '100%' }}
              maxTagCount="responsive"
              notFoundContent={t('roles.skillsEmpty')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
