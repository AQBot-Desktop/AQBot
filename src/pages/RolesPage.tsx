import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Button,
  Card,
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
import { useConversationStore, useProviderStore, useRoleStore, useSettingsStore, useUIStore } from '@/stores';
import { IconEditor } from '@/components/shared/IconEditor';
import { ModelParamSliders } from '@/components/common/ModelParamSliders';
import { CONV_ICON_KEY } from '@/lib/convIcon';
import { saveRoleIntro } from '@/lib/roleIntro';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import type { CreateRoleInput, MarketplaceRole, Role, UpdateRoleInput } from '@/types';
import type { AvatarType } from '@/stores/userProfileStore';

const { Text, Paragraph, Title } = Typography;

interface RoleDraft {
  name: string;
  description: string;
  systemPrompt: string;
  openingMessage: string;
  openingQuestions: string[];
  tags: string[];
  avatarType: string | null;
  avatarValue: string;
  temperature: number | null;
  topP: number | null;
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
};

let didAutoOpenMarketplace = false;

function roleToDraft(role: Role): RoleDraft {
  return {
    name: role.name,
    description: role.description ?? '',
    systemPrompt: role.system_prompt,
    openingMessage: role.opening_message ?? '',
    openingQuestions: role.opening_questions,
    tags: role.tags,
    avatarType: role.avatar_type ?? (role.avatar ? inferAvatarType(role.avatar) : null),
    avatarValue: role.avatar_value ?? role.avatar ?? '',
    temperature: role.temperature,
    topP: role.top_p,
  };
}

function draftToCreateInput(draft: RoleDraft): CreateRoleInput {
  const avatarValue = draft.avatarValue.trim();
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    system_prompt: draft.systemPrompt.trim(),
    opening_message: draft.openingMessage.trim() || null,
    opening_questions: cleanList(draft.openingQuestions),
    tags: cleanList(draft.tags),
    avatar: draft.avatarType === 'emoji' ? avatarValue || null : null,
    avatar_type: draft.avatarType,
    avatar_value: avatarValue || null,
    temperature: draft.temperature,
    top_p: draft.topP,
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
    opening_questions: cleanList(draft.openingQuestions),
    tags: cleanList(draft.tags),
    avatar: draft.avatarType === 'emoji' ? avatarValue || null : null,
    avatar_type: draft.avatarType,
    avatar_value: avatarValue || null,
    temperature: draft.temperature,
    top_p: draft.topP,
  };
}

function cleanList(values: string[]): string[] {
  return values.map((item) => item.trim()).filter(Boolean);
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

function syncConversationRoleMetadata(conversationId: string, role: Role) {
  const avatar = getRoleAvatar(role);
  if (avatar.type && avatar.value) {
    localStorage.setItem(CONV_ICON_KEY(conversationId), JSON.stringify({ type: avatar.type, value: avatar.value }));
  } else {
    localStorage.removeItem(CONV_ICON_KEY(conversationId));
  }
  saveRoleIntro(conversationId, role);
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
    const src = avatar.type === 'file' ? resolvedSrc ?? avatar.value : avatar.value;
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
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const createConversation = useConversationStore((s) => s.createConversation);
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation);
  const providers = useProviderStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const setActivePage = useUIStore((s) => s.setActivePage);

  const [activeTab, setActiveTab] = useState('roles');
  const [query, setQuery] = useState('');
  const [marketplaceQuery, setMarketplaceQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [draft, setDraft] = useState<RoleDraft>(emptyDraft);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [installingRef, setInstallingRef] = useState<string | null>(null);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const tagInputRef = useRef<InputRef>(null);

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

  const applyToCurrentConversation = useCallback(async (role: Role) => {
    if (!activeConversationId) return;
    await updateConversation(activeConversationId, {
      system_prompt: role.system_prompt,
      temperature: role.temperature,
      top_p: role.top_p,
      mode: 'role',
    });
    syncConversationRoleMetadata(activeConversationId, role);
    setActivePage('chat');
    messageApi.success(t('roles.applied'));
  }, [activeConversationId, messageApi, setActivePage, t, updateConversation]);

  const createConversationWithRole = useCallback(async (role: Role) => {
    const selection = pickModel();
    if (!selection) {
      messageApi.warning(t('chat.noModelsAvailable'));
      return;
    }
    const conversation = await createConversation(role.name, selection.model.model_id, selection.provider.id);
    await updateConversation(conversation.id, {
      system_prompt: role.system_prompt,
      temperature: role.temperature,
      top_p: role.top_p,
      mode: 'role',
    });
    syncConversationRoleMetadata(conversation.id, role);
    setActiveConversation(conversation.id);
    setActivePage('chat');
  }, [createConversation, messageApi, pickModel, setActiveConversation, setActivePage, t, updateConversation]);

  const useRole = useCallback((role: Role) => {
    void createConversationWithRole(role);
  }, [createConversationWithRole]);

  const roleActionMenu = useCallback((role: Role): MenuProps => ({
    items: [
      {
        key: 'current',
        label: t('roles.applyToCurrent'),
        icon: <Wand2 size={14} />,
        disabled: !activeConversationId,
      },
    ],
    onClick: () => {
      void applyToCurrentConversation(role);
    },
  }), [activeConversationId, applyToCurrentConversation, t]);

  const openCreate = useCallback(() => {
    setEditingRole(null);
    setDraft(emptyDraft);
    setTagInput('');
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((role: Role) => {
    setEditingRole(role);
    setDraft(roleToDraft(role));
    setTagInput('');
    setModalOpen(true);
  }, []);

  const saveDraft = useCallback(async () => {
    setSaving(true);
    try {
      if (editingRole) {
        await updateRole(editingRole.id, draftToUpdateInput(draft));
      } else {
        await createRole(draftToCreateInput(draft));
      }
      setModalOpen(false);
      setDraft(emptyDraft);
      setEditingRole(null);
    } catch (e) {
      messageApi.error(String(e));
    } finally {
      setSaving(false);
    }
  }, [createRole, draft, editingRole, messageApi, updateRole]);

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
      messageApi.error(String(e));
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

  const addOpeningQuestion = useCallback(() => {
    setDraft((s) => ({ ...s, openingQuestions: [...s.openingQuestions, ''] }));
  }, []);

  const updateOpeningQuestion = useCallback((index: number, value: string) => {
    setDraft((s) => ({
      ...s,
      openingQuestions: s.openingQuestions.map((item, i) => (i === index ? value : item)),
    }));
  }, []);

  const removeOpeningQuestion = useCallback((index: number) => {
    setDraft((s) => ({
      ...s,
      openingQuestions: s.openingQuestions.filter((_, i) => i !== index),
    }));
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
            onConfirm={() => deleteRole(role.id)}
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
                        : <Empty description={t('roles.empty')} />}
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
        onCancel={() => setModalOpen(false)}
        onOk={saveDraft}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saving}
        destroyOnHidden
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

          <Form.Item label={t('roles.name')}>
            <Input
              value={draft.name}
              onChange={(event) => setDraft((s) => ({ ...s, name: event.target.value }))}
              placeholder={t('roles.namePlaceholder')}
            />
          </Form.Item>

          <Form.Item label={t('roles.description')}>
            <Input
              value={draft.description}
              onChange={(event) => setDraft((s) => ({ ...s, description: event.target.value }))}
              placeholder={t('roles.descriptionPlaceholder')}
            />
          </Form.Item>

          <Form.Item label={t('roles.systemPrompt')}>
            <Input.TextArea
              rows={6}
              value={draft.systemPrompt}
              onChange={(event) => setDraft((s) => ({ ...s, systemPrompt: event.target.value }))}
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

          <Form.Item label={t('roles.openingQuestions')}>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              {draft.openingQuestions.map((question, index) => (
                <Space.Compact key={index} style={{ width: '100%' }}>
                  <Input
                    value={question}
                    onChange={(event) => updateOpeningQuestion(index, event.target.value)}
                    placeholder={t('roles.openingQuestionPlaceholder')}
                  />
                  <Button
                    aria-label={t('roles.removeOpeningQuestion')}
                    icon={<Trash2 size={14} />}
                    onClick={() => removeOpeningQuestion(index)}
                  />
                </Space.Compact>
              ))}
              <Button icon={<Plus size={14} />} onClick={addOpeningQuestion}>
                {t('roles.addOpeningQuestion')}
              </Button>
            </Space>
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
        </Form>
      </Modal>
    </div>
  );
}
