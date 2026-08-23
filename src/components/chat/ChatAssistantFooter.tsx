import { usePageSuspendCleanup, usePageTransientOpenState } from '@/components/layout/PageLifecycle';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import {
  getMessageVersionGroupKey,
  getModelVersionGroupKey,
  hasMultipleModelVersions,
} from '@/lib/chatMultiModel';
import { useConversationStore } from '@/stores';
import type { ConversationStats, Message, MultiModelDisplayMode } from '@/types';
import Actions from '@ant-design/x/es/actions';
import { ModelIcon } from '@lobehub/icons';
import { App, Button, Dropdown, Input, Modal, Popconfirm, Popover, Spin, Tooltip, Typography, theme } from 'antd';
import {
  AlertCircle,
  ArrowDown,
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Brain,
  ChartNoAxesColumn,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coins,
  Copy,
  GitBranch,
  MessageSquare,
  Pencil,
  RotateCcw,
  TextCursorInput,
  Timer,
  Trash2,
  User,
  Zap,
} from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration, formatSpeed, formatTokenCount } from '../gateway/tokenFormat';
import { ModelSelector } from './ModelSelector';
import { LayoutSwitcher } from './MultiModelDisplay';
import { SaveToMemoryPopover } from './SaveToMemoryPopover';

// ── Version pagination component for multi-version AI replies ──────────

function VersionPagination({
  msg,
  conversationId,
  allVersions,
}: {
  msg: Message;
  conversationId: string;
  allVersions: Message[];
}) {
  const { token } = theme.useToken();
  const switchMessageVersion = useConversationStore((s) => s.switchMessageVersion);

  // Scope to current model's versions
  const currentModelKey = getMessageVersionGroupKey(msg);
  const modelVersions = allVersions.filter(
    (version) => getMessageVersionGroupKey(version) === currentModelKey,
  );

  if (modelVersions.length <= 1) return null;

  const sorted = [...modelVersions].sort((a, b) => a.version_index - b.version_index);
  const currentIdx = sorted.findIndex((v) => v.id === msg.id);
  const current = currentIdx >= 0 ? currentIdx : sorted.findIndex((v) => v.is_active);

  const handlePrev = () => {
    if (current > 0 && msg.parent_message_id) {
      switchMessageVersion(conversationId, msg.parent_message_id, sorted[current - 1].id);
    }
  };
  const handleNext = () => {
    if (current < sorted.length - 1 && msg.parent_message_id) {
      switchMessageVersion(conversationId, msg.parent_message_id, sorted[current + 1].id);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginRight: 8 }}>
      <Button
        type="text"
        size="small"
        icon={<ChevronLeft size={14} />}
        disabled={current <= 0}
        onClick={handlePrev}
        style={{ minWidth: 20, padding: '0 2px' }}
      />
      <Typography.Text style={{ fontSize: 11, color: token.colorTextSecondary }}>
        {current + 1}/{sorted.length}
      </Typography.Text>
      <Button
        type="text"
        size="small"
        icon={<ChevronRight size={14} />}
        disabled={current >= sorted.length - 1}
        onClick={handleNext}
        style={{ minWidth: 20, padding: '0 2px' }}
      />
    </span>
  );
}

export function findLatestLocalGeneratedVersion(
  parentMessageId: string | null | undefined,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): Message | null {
  if (!parentMessageId) return null;
  const versions = useConversationStore.getState().messages.filter((message) =>
    message.role === 'assistant'
    && message.parent_message_id === parentMessageId
    && (message.provider_id ?? null) === (providerId ?? null)
    && (message.model_id ?? null) === (modelId ?? null)
  );

  return [...versions].sort((left, right) =>
    right.version_index - left.version_index
    || right.created_at - left.created_at
    || right.id.localeCompare(left.id)
  )[0] ?? null;
}

function ModelTags({
  msg,
  conversationId,
  allVersions,
  getModelDisplayInfo,
}: {
  msg: Message;
  conversationId: string;
  allVersions: Message[];
  getModelDisplayInfo: (modelId?: string | null, providerId?: string | null) => { modelName: string; providerName: string };
}) {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const switchMessageVersion = useConversationStore((s) => s.switchMessageVersion);
  const pendingCompanionModels = useConversationStore((s) => s.pendingCompanionModels);
  const multiModelParentId = useConversationStore((s) => s.multiModelParentId);
  const multiModelDoneMessageIds = useConversationStore((s) => s.multiModelDoneMessageIds);

  // Only show pending/streaming indicators for the specific multi-model target message
  const isMultiModelTarget = msg.parent_message_id === multiModelParentId;

  const modelGroups = useMemo(() => {
    const groups = new Map<string, Message[]>();
    for (const v of allVersions) {
      const key = getMessageVersionGroupKey(v);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(v);
    }
    return groups;
  }, [allVersions]);

  // Pending companions that haven't generated a version yet
  const pendingModels = useMemo(() => {
    if (!isMultiModelTarget || !pendingCompanionModels.length) return [];
    return pendingCompanionModels.filter(
      (cm) => !modelGroups.has(getModelVersionGroupKey(cm.providerId, cm.modelId)),
    );
  }, [isMultiModelTarget, pendingCompanionModels, modelGroups]);

  // Check if a model is currently streaming (has a version but not yet completed)
  const streamingModelKeys = useMemo(() => {
    const ids = new Set<string>();
    if (!isMultiModelTarget) return ids;
    for (const cm of pendingCompanionModels) {
      const modelKey = getModelVersionGroupKey(cm.providerId, cm.modelId);
      if (modelGroups.has(modelKey)) {
        // Check if this model's version has completed (per-model tracking)
        const versions = modelGroups.get(modelKey)!;
        const isDone = versions.some((v) => multiModelDoneMessageIds.includes(v.id));
        if (!isDone) ids.add(modelKey);
      }
    }
    return ids;
  }, [isMultiModelTarget, pendingCompanionModels, modelGroups, multiModelDoneMessageIds]);

  if (modelGroups.size <= 1 && pendingModels.length === 0) return null;

  const currentModelKey = getMessageVersionGroupKey(msg);

  const handleTagClick = (modelKey: string) => {
    if (modelKey === currentModelKey || !msg.parent_message_id) return;
    const versions = modelGroups.get(modelKey);
    if (!versions || versions.length === 0) return;
    const sorted = [...versions].sort((a, b) => b.version_index - a.version_index);
    switchMessageVersion(conversationId, msg.parent_message_id, sorted[0].id);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {Array.from(modelGroups.keys()).map((modelKey) => {
        const firstVersion = modelGroups.get(modelKey)?.[0];
        const modelId = firstVersion?.model_id ?? '';
        const isActive = modelKey === currentModelKey;
        const isStreaming = streamingModelKeys.has(modelKey);
        const { modelName } = getModelDisplayInfo(modelId, firstVersion?.provider_id);
        return (
          <Tooltip key={modelKey} title={modelName} mouseEnterDelay={0.3}>
            <div
              onClick={() => handleTagClick(modelKey)}
              className={isStreaming ? 'model-tag-streaming' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: '50%',
                border: `1.5px solid ${isActive ? token.colorPrimary : 'transparent'}`,
                cursor: isActive ? 'default' : 'pointer',
                transition: 'border-color 0.2s',
                flexShrink: 0,
              }}
            >
              <ModelIcon model={modelId} size={20} type="avatar" />
            </div>
          </Tooltip>
        );
      })}
      {/* Pending companion models waiting to stream */}
      {pendingModels.map((cm) => {
        const { modelName } = getModelDisplayInfo(cm.modelId, cm.providerId);
        return (
          <Tooltip
            key={`pending-${getModelVersionGroupKey(cm.providerId, cm.modelId)}`}
            title={`${modelName} (${t('chat.streamingStatus.waitingProvider')})`}
            mouseEnterDelay={0.3}
          >
            <div
              className="model-tag-pending"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: '50%',
                border: `1.5px dashed ${token.colorTextQuaternary}`,
                opacity: 0.5,
                flexShrink: 0,
              }}
            >
              <ModelIcon model={cm.modelId} size={20} type="avatar" />
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

// 3-button delete popover for last AI version
function DeleteLastVersionPopover({
  msg,
  conversationId,
  deleteMessage,
  deleteMessageGroup,
  messageApi,
  token,
}: {
  msg: Message;
  conversationId: string;
  deleteMessage: (messageId: string) => Promise<void>;
  deleteMessageGroup: (convId: string, parentMsgId: string) => Promise<void>;
  messageApi: ReturnType<typeof App.useApp>['message'];
  token: ReturnType<typeof theme.useToken>['token'];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = usePageTransientOpenState();

  const handleDeleteThisOnly = async () => {
    setOpen(false);
    try {
      await deleteMessage(msg.id);
    } catch (e) {
      messageApi.error(String(e));
    }
  };

  const handleDeleteAll = async () => {
    setOpen(false);
    try {
      if (msg.parent_message_id) {
        await deleteMessageGroup(conversationId, msg.parent_message_id);
      } else if (msg.id.startsWith('temp-')) {
        // No parent link (e.g. error before backend persisted) — remove locally
        useConversationStore.setState((s) => ({
          messages: s.messages.filter((m) => m.id !== msg.id),
        }));
      }
    } catch (e) {
      messageApi.error(String(e));
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="top"
      content={
        <div style={{ maxWidth: 280 }}>
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <AlertCircle size={16} style={{ color: token.colorWarning, marginTop: 2, flexShrink: 0 }} />
            <span>{t('chat.deleteLastVersionHint')}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button size="small" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="small" onClick={handleDeleteThisOnly}>
              {t('chat.deleteThisOnly')}
            </Button>
            <Button size="small" danger type="primary" onClick={handleDeleteAll}>
              {t('chat.deleteAll')}
            </Button>
          </div>
        </div>
      }
    >
      <Tooltip title={t('chat.delete')}>
        <span className="aqbot-action-item" style={{ color: token.colorError }}>
          <Trash2 size={14} />
        </span>
      </Tooltip>
    </Popover>
  );
}

export function AssistantFooter({
  msg,
  conversationId,
  versions,
  assistantCopyText,
  getModelDisplayInfo,
  onEditMessage,
  isStreaming = false,
  displayMode,
  onDisplayModeChange,
  onRegeneratedVersionCreated,
}: {
  msg: Message;
  conversationId: string;
  versions?: Message[];
  assistantCopyText: string;
  getModelDisplayInfo: (modelId?: string | null, providerId?: string | null) => { modelName: string; providerName: string };
  onEditMessage: (messageId: string, content: string, role: 'user' | 'assistant') => void;
  isStreaming?: boolean;
  displayMode?: MultiModelDisplayMode;
  onDisplayModeChange?: (parentMsgId: string, mode: MultiModelDisplayMode) => void;
  onRegeneratedVersionCreated?: (message: Message) => void;
}) {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const regenerateMessage = useConversationStore((s) => s.regenerateMessage);
  const regenerateWithModel = useConversationStore((s) => s.regenerateWithModel);
  const deleteMessageGroup = useConversationStore((s) => s.deleteMessageGroup);
  const deleteMessage = useConversationStore((s) => s.deleteMessage);
  const branchConversation = useConversationStore((s) => s.branchConversation);
  const { copy: copyAssistant, isCopied: assistantCopied } = useCopyToClipboard();
  // Branch modal state
  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [branchAsChild, setBranchAsChild] = useState(false);
  const [branchTitle, setBranchTitle] = useState('');
  usePageSuspendCleanup(() => {
    setBranchModalOpen(false);
    setBranchTitle('');
  });
  const conversations = useConversationStore((s) => s.conversations);
  const currentConvTitle = conversations.find((c) => c.id === conversationId)?.title ?? '';
  const pendingCompanionModelCount = useConversationStore((s) => s.pendingCompanionModels.length);
  const multiModelParentId = useConversationStore((s) => s.multiModelParentId);
  const mergedVersions = versions ?? [msg];

  // Keep multi-model controls visible while sibling model versions are still pending.
  const hasMultiModels = useMemo(() => (
    hasMultipleModelVersions(mergedVersions)
    || (msg.parent_message_id === multiModelParentId && pendingCompanionModelCount > 1)
  ), [mergedVersions, msg.parent_message_id, multiModelParentId, pendingCompanionModelCount]);

  // Current message's model for ModelSelector highlight
  const currentModelOverride = useMemo(() => {
    if (msg.provider_id && msg.model_id) {
      return { providerId: msg.provider_id, modelId: msg.model_id };
    }
    return null;
  }, [msg.provider_id, msg.model_id]);

  const handleModelSelect = useCallback(async (providerId: string, modelId: string) => {
    try {
      let pending: Promise<Message>;
      if (providerId === msg.provider_id && modelId === msg.model_id) {
        // Same model → regular regenerate
        pending = regenerateMessage(msg.id);
      } else {
        // Different model → generate with new model
        pending = regenerateWithModel(msg.id, providerId, modelId);
      }
      const localGenerated = findLatestLocalGeneratedVersion(msg.parent_message_id, providerId, modelId);
      if (localGenerated) onRegeneratedVersionCreated?.(localGenerated);
      const generated = await pending;
      onRegeneratedVersionCreated?.(
        findLatestLocalGeneratedVersion(msg.parent_message_id, providerId, modelId) ?? generated,
      );
    } catch (e) {
      messageApi.error(String(e));
    }
  }, [messageApi, msg.id, msg.model_id, msg.parent_message_id, msg.provider_id, onRegeneratedVersionCreated, regenerateMessage, regenerateWithModel]);
  const totalTokens = (msg.prompt_tokens ?? 0) + (msg.completion_tokens ?? 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {!isStreaming && (msg.prompt_tokens != null || msg.completion_tokens != null || msg.tokens_per_second != null || msg.first_token_latency_ms != null) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: token.colorTextDescription, lineHeight: '16px', marginTop: -6, marginBottom: 4, flexWrap: 'wrap' }}>
          {msg.prompt_tokens != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <ArrowUp size={10} />
              {formatTokenCount(msg.prompt_tokens)} tokens
            </span>
          )}
          {msg.completion_tokens != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <ArrowDown size={10} />
              {formatTokenCount(msg.completion_tokens)} tokens
            </span>
          )}
          {totalTokens > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <Coins size={10} />
              {formatTokenCount(totalTokens)} tokens
            </span>
          )}
          {msg.tokens_per_second != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <Zap size={10} />
              {formatSpeed(msg.tokens_per_second)}
            </span>
          )}
          {msg.first_token_latency_ms != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <TextCursorInput size={10} />
              {formatDuration(msg.first_token_latency_ms)}
            </span>
          )}
        </div>
      )}
      {!isStreaming && (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <VersionPagination msg={msg} conversationId={conversationId} allVersions={mergedVersions} />
          <Actions
          items={[
            {
              key: 'copy',
              icon: assistantCopied ? <Check size={14} style={{ color: token.colorSuccess }} /> : <Copy size={14} />,
              label: t('chat.copy'),
              onItemClick: () => {
                void copyAssistant(assistantCopyText).then(ok => {
                  if (ok) messageApi.success(t('chat.copied'));
                });
              },
            },
            {
              key: 'regenerate',
              icon: <RotateCcw size={14} />,
              label: t('chat.regenerate'),
              onItemClick: async () => {
                try {
                  const pending = regenerateMessage(msg.id);
                  const localGenerated = findLatestLocalGeneratedVersion(msg.parent_message_id, msg.provider_id, msg.model_id);
                  if (localGenerated) onRegeneratedVersionCreated?.(localGenerated);
                  const generated = await pending;
                  onRegeneratedVersionCreated?.(
                    findLatestLocalGeneratedVersion(msg.parent_message_id, msg.provider_id, msg.model_id) ?? generated,
                  );
                } catch (e) {
                  messageApi.error(String(e));
                }
              },
            },
            ...(msg.role === 'assistant' ? [{
              key: 'edit',
              icon: <Pencil size={14} />,
              label: t('chat.editMessage'),
              onItemClick: () => {
                onEditMessage(msg.id, msg.content, 'assistant');
              },
            }] : []),
            {
              key: 'model',
              actionRender: () => (
                <ModelSelector
                  onSelect={handleModelSelect}
                  overrideCurrentModel={currentModelOverride}
                >
                  <Tooltip title={t('chat.switchModel')}>
                    <span className="aqbot-action-item" style={{ color: token.colorTextSecondary }}>
                      <ArrowLeftRight size={14} />
                    </span>
                  </Tooltip>
                </ModelSelector>
              ),
            },
            {
              key: 'branch',
              actionRender: () => (
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: 'independent',
                        label: t('chat.branchIndependent'),
                        onClick: () => {
                          setBranchAsChild(false);
                          setBranchTitle(currentConvTitle);
                          setBranchModalOpen(true);
                        },
                      },
                      {
                        key: 'child',
                        label: t('chat.branchChild'),
                        onClick: () => {
                          setBranchAsChild(true);
                          setBranchTitle(currentConvTitle);
                          setBranchModalOpen(true);
                        },
                      },
                    ],
                  }}
                  trigger={['click']}
                  placement="bottom"
                >
                  <Tooltip title={t('chat.branchConversation')}>
                    <span className="aqbot-action-item" style={{ color: token.colorTextSecondary }}>
                      <GitBranch size={14} />
                    </span>
                  </Tooltip>
                </Dropdown>
              ),
            },
            {
              key: 'save-memory',
              actionRender: () => {
                const disabled = !assistantCopyText.trim();
                return (
                  <SaveToMemoryPopover content={assistantCopyText} disabled={disabled}>
                    <Tooltip title={t('chat.memory.save')}>
                      <Button
                        aria-label={t('chat.memory.save')}
                        disabled={disabled}
                        icon={<Brain size={14} />}
                        size="small"
                        type="text"
                      />
                    </Tooltip>
                  </SaveToMemoryPopover>
                );
              },
            },
            {
              key: 'delete',
              actionRender: () => {
                const isLastVersion = mergedVersions.filter((v) => v.id !== msg.id).length === 0;

                if (isLastVersion) {
                  // Last version — Popover with 3 buttons
                  return (
                    <DeleteLastVersionPopover
                      msg={msg}
                      conversationId={conversationId}
                      deleteMessage={deleteMessage}
                      deleteMessageGroup={deleteMessageGroup}
                      messageApi={messageApi}
                      token={token}
                    />
                  );
                }

                // Multiple versions — standard Popconfirm
                return (
                  <Popconfirm
                    title={t('chat.confirmDeleteVersion')}
                    onConfirm={async () => {
                      try {
                        await deleteMessage(msg.id);
                      } catch (e) {
                        messageApi.error(String(e));
                      }
                    }}
                    okText={t('common.confirm')}
                    cancelText={t('common.cancel')}
                  >
                    <Tooltip title={t('chat.delete')}>
                      <span className="aqbot-action-item" style={{ color: token.colorError }}>
                        <Trash2 size={14} />
                      </span>
                    </Tooltip>
                  </Popconfirm>
                );
              },
            },
          ]}
        />
      </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
        {hasMultiModels && displayMode && onDisplayModeChange && msg.parent_message_id && (
          <LayoutSwitcher
            currentMode={displayMode}
            parentMessageId={msg.parent_message_id}
            onModeChange={(mode) => onDisplayModeChange(msg.parent_message_id!, mode)}
          />
        )}
        <ModelTags msg={msg} conversationId={conversationId} allVersions={mergedVersions} getModelDisplayInfo={getModelDisplayInfo} />
      </div>
      <Modal
        open={branchModalOpen}
        title={t('chat.branchConversation')}
        onCancel={() => setBranchModalOpen(false)}
        onOk={async () => {
          try {
            const title = branchTitle.trim() || currentConvTitle;
            await branchConversation(conversationId, msg.id, branchAsChild, title);
            messageApi.success(t('chat.branchCreated'));
            setBranchModalOpen(false);
          } catch (e) {
            messageApi.error(String(e));
          }
        }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        width={400}
        destroyOnClose
      >
        <Input
          value={branchTitle}
          onChange={(e) => setBranchTitle(e.target.value)}
          placeholder={t('chat.branchTitlePlaceholder')}
          autoFocus
          onPressEnter={async () => {
            try {
              const title = branchTitle.trim() || currentConvTitle;
              await branchConversation(conversationId, msg.id, branchAsChild, title);
              messageApi.success(t('chat.branchCreated'));
              setBranchModalOpen(false);
            } catch (e) {
              messageApi.error(String(e));
            }
          }}
        />
      </Modal>
    </div>
  );
}


// ── Stats Popover ──────────────────────────────────────────────────────

export function StatsPopoverContent({ stats, t, token }: {
  stats: ConversationStats | null;
  t: (key: string) => string;
  token: Record<string, any>;
}) {
  if (!stats) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 40px' }}>
        <Spin size="small" />
      </div>
    );
  }

  const items: Array<{
    icon: React.ReactNode;
    label: string;
    value: string;
    sub?: Array<{ icon: React.ReactNode; label: string; value: string }>;
  }> = [
    {
      icon: <MessageSquare size={14} />,
      label: t('chat.stats.totalMessages'),
      value: stats.total_messages.toLocaleString(),
      sub: [
        { icon: <User size={12} />, label: t('chat.stats.userMessages'), value: stats.total_user_messages.toLocaleString() },
        { icon: <Bot size={12} />, label: t('chat.stats.assistantMessages'), value: stats.total_assistant_messages.toLocaleString() },
      ],
    },
    {
      icon: <Coins size={14} />,
      label: t('chat.stats.totalTokens'),
      value: formatTokenCount(stats.total_tokens),
      sub: [
        { icon: <ArrowUpRight size={12} />, label: t('chat.stats.inputTokens'), value: formatTokenCount(stats.total_prompt_tokens) },
        { icon: <ArrowDownRight size={12} />, label: t('chat.stats.outputTokens'), value: formatTokenCount(stats.total_completion_tokens) },
      ],
    },
    ...(stats.avg_first_token_latency_ms != null ? [{
      icon: <Zap size={14} />,
      label: t('chat.stats.avgFirstToken'),
      value: formatDuration(stats.avg_first_token_latency_ms),
    }] : []),
    ...(stats.avg_response_time_ms != null ? [{
      icon: <Clock size={14} />,
      label: t('chat.stats.avgResponseTime'),
      value: formatDuration(stats.avg_response_time_ms),
    }] : []),
    ...(stats.avg_tokens_per_second != null ? [{
      icon: <Timer size={14} />,
      label: t('chat.stats.avgSpeed'),
      value: formatSpeed(stats.avg_tokens_per_second),
    }] : []),
  ];

  return (
    <div style={{ minWidth: 220, maxWidth: 280 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ChartNoAxesColumn size={14} />
        {t('chat.stats.title')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item, i) => (
          <div key={i}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: token.colorTextSecondary }}>
                {item.icon}
                {item.label}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {item.value}
              </span>
            </div>
            {item.sub && (
              <div style={{ marginLeft: 20, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {item.sub.map((s, j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: token.colorTextDescription }}>
                      {s.icon}
                      {s.label}
                    </span>
                    <span style={{ fontSize: 12, color: token.colorTextSecondary, fontVariantNumeric: 'tabular-nums' }}>
                      {s.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {i < items.length - 1 && (
              <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, marginTop: 10 }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
