import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Avatar, Button, Empty, Input, Popover, Space, Tooltip, theme } from 'antd';
import { Search, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useConversationStore,
  useProviderStore,
  useRoleStore,
  useSettingsStore,
  useSkillStore,
} from '@/stores';
import { useUIStore } from '@/stores/uiStore';
import {
  applyRoleWithRollback,
  buildApplyRoleUpdate,
  getConversationRoleId,
  roleSkillNames,
} from '@/lib/applyRole';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import type { Role } from '@/types';
import type { AvatarType } from '@/stores/userProfileStore';

function RoleListAvatar({ role }: { role: Role }) {
  const value = role.avatar_value ?? role.avatar ?? '';
  const type = (role.avatar_type
    ?? (value ? (value.startsWith('http') ? 'url' : 'emoji') : null)) as AvatarType | null;
  const resolvedSrc = useResolvedAvatarSrc(type ?? 'icon', value);

  if (type === 'emoji' && value) {
    return (
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-fill-alter)',
          fontSize: 16,
          flexShrink: 0,
        }}
      >
        {value}
      </div>
    );
  }
  if ((type === 'url' || type === 'file') && value) {
    const src = type === 'file' ? resolvedSrc ?? value : value;
    return <Avatar size={28} shape="square" src={src} style={{ flexShrink: 0, borderRadius: 6 }} />;
  }
  return (
    <Avatar
      size={28}
      shape="square"
      style={{ flexShrink: 0, borderRadius: 6, fontSize: 12 }}
    >
      {role.name.slice(0, 1) || 'R'}
    </Avatar>
  );
}

export function RoleSwitcherPopover() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message: messageApi } = App.useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [bindingEpoch, setBindingEpoch] = useState(0);

  const roles = useRoleStore((s) => s.roles);
  const ensureRolesLoaded = useRoleStore((s) => s.ensureRolesLoaded);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const conversations = useConversationStore((s) => s.conversations);
  const archivedConversations = useConversationStore((s) => s.archivedConversations);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const createConversation = useConversationStore((s) => s.createConversation);
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation);
  const providers = useProviderStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const setActivePage = useUIStore((s) => s.setActivePage);
  const ensureSkillsLoaded = useSkillStore((s) => s.ensureSkillsLoaded);
  const toggleSkill = useSkillStore((s) => s.toggleSkill);

  const activeConversation = conversations.find((c) => c.id === activeConversationId)
    ?? archivedConversations.find((c) => c.id === activeConversationId);
  const roleBinding = useMemo(() => {
    if (!activeConversationId) return { roleId: null as string | null, error: null as unknown };
    try {
      return { roleId: getConversationRoleId(activeConversationId), error: null };
    } catch (error) {
      return { roleId: null, error };
    }
  }, [activeConversation, activeConversationId, bindingEpoch]);
  const activeRoleId = roleBinding.roleId;
  const isRoleApplied = Boolean(activeRoleId);

  useEffect(() => {
    if (!open) return;
    void ensureRolesLoaded();
    setBindingEpoch((n) => n + 1);
  }, [ensureRolesLoaded, open]);

  useEffect(() => {
    if (!roleBinding.error) return;
    console.error('[RoleSwitcherPopover] failed to read conversation role binding', roleBinding.error);
    messageApi.error({
      key: 'chat.role.bindingReadFailed',
      content: t('chat.role.bindingReadFailed'),
    });
  }, [messageApi, roleBinding.error, t]);

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

  const applyToCurrent = useCallback(async (role: Role) => {
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
      setBindingEpoch((n) => n + 1);
      setOpen(false);
    } catch (error) {
      console.error('[RoleSwitcherPopover] failed to apply role', error);
      messageApi.error(t('roles.applyFailed'));
    }
  }, [activeConversation, ensureRoleSkillsEnabled, messageApi, t, updateConversation]);

  const createWithRole = useCallback(async (role: Role) => {
    const selection = pickModel();
    if (!selection) return;
    const conversation = await createConversation(
      role.name,
      selection.model.model_id,
      selection.provider.id,
    );
    try {
      await applyRoleWithRollback(conversation.id, role, async () => {
        await updateConversation(conversation.id, buildApplyRoleUpdate(role));
      });
      await ensureRoleSkillsEnabled(role);
      setActiveConversation(conversation.id);
      setOpen(false);
    } catch (error) {
      console.error('[RoleSwitcherPopover] failed to apply role to new conversation', error);
      messageApi.error(t('roles.applyFailed'));
    }
  }, [
    createConversation,
    ensureRoleSkillsEnabled,
    messageApi,
    pickModel,
    setActiveConversation,
    t,
    updateConversation,
  ]);

  const content = (
    <div style={{ width: 280 }}>
      <Input
        size="small"
        allowClear
        prefix={<Search size={12} />}
        placeholder={t('roles.searchPlaceholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        style={{ marginBottom: 8 }}
      />
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {filteredRoles.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('roles.emptyDesc')}
            style={{ margin: '12px 0' }}
          />
        ) : (
          filteredRoles.map((role) => {
            const active = isRoleApplied && activeRoleId === role.id;
            return (
              <div
                key={role.id}
                data-active={active ? 'true' : 'false'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 4px',
                  borderRadius: 6,
                  background: active ? token.colorPrimaryBg : undefined,
                  marginBottom: 2,
                }}
              >
                <RoleListAvatar role={role} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {role.name}
                  </div>
                  {role.description ? (
                    <div style={{ fontSize: 11, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {role.description}
                    </div>
                  ) : null}
                </div>
                <Space size={4}>
                  <Button
                    type="text"
                    size="small"
                    disabled={!activeConversation}
                    onClick={() => void applyToCurrent(role)}
                    title={t('roles.applyToCurrent')}
                  >
                    {t('chat.role.apply')}
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => void createWithRole(role)}
                    title={t('roles.newConversation')}
                  >
                    {t('chat.role.new')}
                  </Button>
                </Space>
              </div>
            );
          })
        )}
      </div>
      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, marginTop: 8, paddingTop: 8 }}>
        <Button
          type="link"
          size="small"
          style={{ padding: 0, fontSize: 12 }}
          onClick={() => {
            setOpen(false);
            setActivePage('roles');
          }}
        >
          {t('chat.role.manage')}
        </Button>
      </div>
    </div>
  );

  return (
    <Popover
      trigger="click"
      placement="topLeft"
      content={content}
      arrow={false}
      open={open}
      onOpenChange={setOpen}
    >
      <Tooltip title={t('chat.role.title')} open={open ? false : undefined}>
        <Button
          type="text"
          size="small"
          aria-label={t('chat.role.title')}
          icon={<UserRound size={14} />}
          style={isRoleApplied ? { color: token.colorPrimary } : undefined}
        />
      </Tooltip>
    </Popover>
  );
}
