import React, { useState, useEffect } from 'react';
import { App, Modal, Input, InputNumber, Button, Tooltip, Card, theme } from 'antd';
import { Info, Undo2, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConversationStore, useProviderStore, useSettingsStore } from '@/stores';
import { CONV_ICON_KEY, type ConvIconType, type ConvIcon } from '@/lib/convIcon';
import { IconEditor } from '@/components/shared/IconEditor';
import { ModelParamSliders } from '@/components/common/ModelParamSliders';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { findModelByIds } from '@/lib/modelCapabilities';
import { resolveModelParamDefaults } from '@/lib/modelParams';
import {
  COMPRESSION_KEEP_LAST_N_MAX,
  COMPRESSION_KEEP_LAST_N_MIN,
  DEFAULT_COMPRESSION_KEEP_LAST_N,
  isContextStrategy,
  normalizeCompressionKeepLastN,
  normalizeContextStrategy,
} from '@/lib/contextStrategy';
import { ConversationModelIcon } from './ConversationModelIcon';
import type { MenuProps } from 'antd';
import type { ContextStrategy, MultiModelDisplayMode } from '@/types';

interface ConversationSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const LEGACY_CONTEXT_LIMIT_KEY = (id: string) => `aqbot_context_limit_${id}`;
/** Values ≥ this mean unlimited (matches backend CONTEXT_MESSAGE_LIMIT_UNLIMITED). */
const CONTEXT_LIMIT_UNLIMITED = 50;
const CONTEXT_LIMIT_CUSTOM_MAX = CONTEXT_LIMIT_UNLIMITED - 1;
const DEFAULT_CUSTOM_CONTEXT_LIMIT = 10;

type ContextLimitMode = 'inherit' | 'unlimited' | 'custom';
type KeepLastMode = 'inherit' | 'custom';
type ContextStrategyMode = 'inherit' | ContextStrategy;
type MultiModelDisplayModeSetting = 'inherit' | MultiModelDisplayMode;

interface ContextLimitControlState {
  mode: ContextLimitMode;
  value: number;
}

function normalizeCustomContextLimit(value: number | string | null | undefined): number {
  const numericValue = typeof value === 'number' ? value : Number(value ?? DEFAULT_CUSTOM_CONTEXT_LIMIT);
  if (!Number.isFinite(numericValue)) return DEFAULT_CUSTOM_CONTEXT_LIMIT;
  return Math.min(CONTEXT_LIMIT_CUSTOM_MAX, Math.max(0, Math.trunc(numericValue)));
}

function resolveInitialContextLimit(
  conversationId: string,
  storedLimit: number | null | undefined,
  globalDefault: number | null | undefined,
): ContextLimitControlState {
  if (storedLimit != null && Number.isFinite(storedLimit)) {
    return storedLimit >= CONTEXT_LIMIT_UNLIMITED
      ? { mode: 'unlimited', value: normalizeCustomContextLimit(globalDefault) }
      : { mode: 'custom', value: normalizeCustomContextLimit(storedLimit) };
  }
  // One-time migration from the old localStorage-only setting.
  try {
    const legacy = localStorage.getItem(LEGACY_CONTEXT_LIMIT_KEY(conversationId));
    if (legacy != null) {
      const parsed = Number(legacy);
      if (Number.isFinite(parsed)) {
        return parsed >= CONTEXT_LIMIT_UNLIMITED
          ? { mode: 'unlimited', value: normalizeCustomContextLimit(globalDefault) }
          : { mode: 'custom', value: normalizeCustomContextLimit(parsed) };
      }
    }
  } catch {
    // ignore storage errors
  }
  return { mode: 'inherit', value: normalizeCustomContextLimit(globalDefault) };
}

export function ConversationSettingsModal({ open, onClose }: ConversationSettingsModalProps) {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();

  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const settings = useSettingsStore((s) => s.settings);
  const providers = useProviderStore((s) => s.providers);

  const conversation = conversations.find((c) => c.id === activeConversationId);
  const selectedModel = React.useMemo(
    () => findModelByIds(providers, conversation?.provider_id, conversation?.model_id),
    [providers, conversation?.provider_id, conversation?.model_id],
  );
  const modelParamDefaults = React.useMemo(() => {
    return resolveModelParamDefaults(selectedModel, settings);
  }, [selectedModel, settings]);

  // Form state
  const [title, setTitle] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [contextLimitMode, setContextLimitMode] = useState<ContextLimitMode>('inherit');
  const [contextLimit, setContextLimit] = useState(DEFAULT_CUSTOM_CONTEXT_LIMIT);
  const [contextStrategyMode, setContextStrategyMode] = useState<ContextStrategyMode>('inherit');
  const [keepLastMode, setKeepLastMode] = useState<KeepLastMode>('inherit');
  const [compressionKeepLastN, setCompressionKeepLastN] = useState(DEFAULT_COMPRESSION_KEEP_LAST_N);
  const [multiModelDisplayMode, setMultiModelDisplayMode] = useState<MultiModelDisplayModeSetting>('inherit');
  const [temperature, setTemperature] = useState<number | null>(null);
  const [topP, setTopP] = useState<number | null>(null);
  const [maxTokens, setMaxTokens] = useState<number | null>(null);
  const [frequencyPenalty, setFrequencyPenalty] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Icon state
  const [iconType, setIconType] = useState<ConvIconType>('model');
  const [iconValue, setIconValue] = useState('');

  // Initialize form when modal opens
  useEffect(() => {
    if (open && conversation) {
      setTitle(conversation.title);
      setSystemPrompt(conversation.system_prompt ?? '');
      setTemperature(conversation.temperature ?? null);
      setTopP(conversation.top_p ?? null);
      setMaxTokens(conversation.max_tokens ?? null);
      setFrequencyPenalty(conversation.frequency_penalty ?? null);

      const contextLimitState = resolveInitialContextLimit(
        conversation.id,
        conversation.context_message_limit,
        settings.default_context_count,
      );
      setContextLimitMode(contextLimitState.mode);
      setContextLimit(contextLimitState.value);
      setContextStrategyMode(
        isContextStrategy(conversation.context_strategy_override)
          ? conversation.context_strategy_override
          : conversation.context_strategy_override === null
            ? 'inherit'
            : conversation.context_compression
              ? 'smart_summary'
              : 'raw_truncate',
      );
      setKeepLastMode(conversation.compression_keep_last_n == null ? 'inherit' : 'custom');
      setMultiModelDisplayMode(conversation.multi_model_display_mode_override ?? 'inherit');
      setCompressionKeepLastN(
        conversation.compression_keep_last_n != null
          && Number.isFinite(conversation.compression_keep_last_n)
          ? normalizeCompressionKeepLastN(conversation.compression_keep_last_n)
          : settings.default_compression_keep_last_n != null
            && Number.isFinite(settings.default_compression_keep_last_n)
            ? normalizeCompressionKeepLastN(settings.default_compression_keep_last_n)
            : DEFAULT_COMPRESSION_KEEP_LAST_N,
      );

      // Load icon
      const iconStored = localStorage.getItem(CONV_ICON_KEY(conversation.id));
      if (iconStored) {
        try {
          const parsed: ConvIcon = JSON.parse(iconStored);
          setIconType(parsed.type);
          setIconValue(parsed.value);
        } catch {
          setIconType('model');
          setIconValue('');
        }
      } else {
        setIconType('model');
        setIconValue('');
      }
    }
  }, [
    open,
    conversation,
    settings.default_context_count,
    settings.default_context_strategy,
    settings.default_compression_keep_last_n,
  ]);

  if (!conversation) return null;


  const handleReset = () => {
    setTemperature(null);
    setTopP(null);
    setMaxTokens(null);
    setFrequencyPenalty(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const contextStrategy = contextStrategyMode === 'inherit'
        ? normalizeContextStrategy(settings.default_context_strategy)
        : contextStrategyMode;
      await updateConversation(conversation.id, {
        title,
        system_prompt: systemPrompt,
        temperature,
        max_tokens: maxTokens,
        top_p: topP,
        frequency_penalty: frequencyPenalty,
        context_message_limit: contextLimitMode === 'inherit'
          ? null
          : contextLimitMode === 'unlimited'
            ? CONTEXT_LIMIT_UNLIMITED
            : normalizeCustomContextLimit(contextLimit),
        context_strategy_override: contextStrategyMode === 'inherit' ? null : contextStrategyMode,
        context_compression: contextStrategy === 'smart_summary',
        compression_keep_last_n: keepLastMode === 'inherit'
          ? null
          : normalizeCompressionKeepLastN(compressionKeepLastN),
        multi_model_display_mode_override: multiModelDisplayMode === 'inherit'
          ? null
          : multiModelDisplayMode,
      });
      // Drop legacy localStorage key after persisting to the database.
      try {
        localStorage.removeItem(LEGACY_CONTEXT_LIMIT_KEY(conversation.id));
      } catch {
        // ignore
      }
      // Save icon
      if (iconType === 'model') {
        localStorage.removeItem(CONV_ICON_KEY(conversation.id));
      } else {
        localStorage.setItem(CONV_ICON_KEY(conversation.id), JSON.stringify({ type: iconType, value: iconValue }));
      }
      onClose();
    } catch (error) {
      console.error('Failed to update conversation settings:', error);
      messageApi.error(t('settings.conversationSettingsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const useModelIconMenuItem: MenuProps['items'] = [
    {
      key: 'use_model',
      icon: <Bot size={14} />,
      label: t('settings.useModelIcon'),
      onClick: () => { setIconType('model'); setIconValue(''); },
    },
  ];

  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    color: token.colorText,
    marginBottom: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  };

  return (
    <Modal
      title={t('settings.conversationSettings')}
      open={open}
      mask={{ enabled: true, blur: true }}
      onCancel={onClose}
      width={520}
      destroyOnHidden
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={handleSave} loading={saving}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div data-os-scrollbar style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
        {/* Avatar with IconEditor */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 16px' }}>
          <IconEditor
            iconType={iconType === 'model' ? null : iconType}
            iconValue={iconType === 'model' ? null : iconValue}
            onChange={(type, value) => {
              if (type && value) {
                setIconType(type as ConvIconType);
                setIconValue(value);
              } else {
                setIconType('model');
                setIconValue('');
              }
            }}
            size={64}
            defaultIcon={<ConversationModelIcon model={conversation.model_id} size={64} />}
            prependMenuItems={useModelIconMenuItem}
            showClear={iconType !== 'model'}
          />
        </div>

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>{t('common.name')}</div>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        {/* System Prompt */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>{t('settings.systemPromptLabel')}</div>
          <Input.TextArea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3}
            placeholder={t('settings.systemPromptPlaceholder')}
          />
        </div>

        {/* Model Settings Card */}
        <Card
          title={t('settings.modelSettings')}
          size="small"
          extra={
            <Button
              type="text"
              size="small"
              icon={<Undo2 size={14} />}
              onClick={handleReset}
            >
              {t('common.reset')}
            </Button>
          }
        >

          {/* Context Message Limit */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              {t('settings.contextMessageLimit')}
              <Tooltip title={t('settings.contextMessageLimitTooltip')}>
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
              <span style={{ marginLeft: 'auto' }}>
                <SettingsSelect
                  value={contextLimitMode}
                  onChange={(value) => setContextLimitMode(value as ContextLimitMode)}
                  options={[
                    { label: t('settings.followGlobal'), value: 'inherit' },
                    { label: t('common.unlimited'), value: 'unlimited' },
                    { label: t('settings.customValue'), value: 'custom' },
                  ]}
                />
              </span>
            </div>
            {contextLimitMode === 'custom' && (
              <InputNumber
                aria-label={t('settings.contextMessageLimit')}
                min={0}
                max={CONTEXT_LIMIT_CUSTOM_MAX}
                precision={0}
                value={contextLimit}
                onChange={(value) => setContextLimit(normalizeCustomContextLimit(value))}
                style={{ width: '100%' }}
              />
            )}
          </div>

          {/* Context strategy */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              {t('settings.contextStrategy')}
              <Tooltip title={t('settings.contextStrategyTooltip')}>
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
              <span style={{ marginLeft: 'auto' }}>
                <SettingsSelect
                  value={contextStrategyMode}
                  onChange={(value) => {
                    if (value === 'inherit' || isContextStrategy(value)) {
                      setContextStrategyMode(value);
                    }
                  }}
                  options={[
                    { label: t('settings.followGlobal'), value: 'inherit' },
                    { label: t('settings.contextStrategySmartSummary'), value: 'smart_summary' },
                    { label: t('settings.contextStrategyRawTruncate'), value: 'raw_truncate' },
                    { label: t('settings.contextStrategyRawStrict'), value: 'raw_strict' },
                  ]}
                />
              </span>
            </div>
            <div style={{ fontSize: 12, color: token.colorTextDescription }}>
              {contextStrategyMode === 'smart_summary'
                ? t('settings.contextStrategySmartSummaryDesc')
                : contextStrategyMode === 'raw_strict'
                  ? t('settings.contextStrategyRawStrictDesc')
                  : contextStrategyMode === 'raw_truncate'
                    ? t('settings.contextStrategyRawTruncateDesc')
                    : t('settings.contextStrategyFollowGlobalDesc')}
            </div>
          </div>

          {/* Compression keep last N */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              {t('settings.compressionKeepLastN')}
              <Tooltip title={t('settings.compressionKeepLastNTooltip')}>
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
              <span style={{ marginLeft: 'auto' }}>
                <SettingsSelect
                  value={keepLastMode}
                  onChange={(value) => setKeepLastMode(value as KeepLastMode)}
                  options={[
                    { label: t('settings.followGlobal'), value: 'inherit' },
                    { label: t('settings.customValue'), value: 'custom' },
                  ]}
                />
              </span>
            </div>
            {keepLastMode === 'custom' && (
              <InputNumber
                aria-label={t('settings.compressionKeepLastN')}
                min={COMPRESSION_KEEP_LAST_N_MIN}
                max={COMPRESSION_KEEP_LAST_N_MAX}
                precision={0}
                value={compressionKeepLastN}
                onChange={(value) => setCompressionKeepLastN(normalizeCompressionKeepLastN(value))}
                style={{ width: '100%' }}
              />
            )}
          </div>

          {/* Multi-model display mode */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              {t('settings.multiModelDisplayModeConversation')}
              <Tooltip title={t('settings.multiModelDisplayModeConversationDesc')}>
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
              <span style={{ marginLeft: 'auto' }}>
                <SettingsSelect
                  value={multiModelDisplayMode}
                  onChange={(value) => setMultiModelDisplayMode(value as MultiModelDisplayModeSetting)}
                  options={[
                    { label: t('settings.followGlobal'), value: 'inherit' },
                    { label: t('settings.multiModelDisplayModeTabs'), value: 'tabs' },
                    { label: t('settings.multiModelDisplayModeSideBySide'), value: 'side-by-side' },
                    { label: t('settings.multiModelDisplayModeStacked'), value: 'stacked' },
                  ]}
                />
              </span>
            </div>
            <div style={{ fontSize: 12, color: token.colorTextDescription }}>
              {t('settings.multiModelDisplayModeConversationDesc')}
            </div>
          </div>

          {/* Temperature / Top P / Max Tokens / Frequency Penalty */}
          <ModelParamSliders
            values={{
              temperature,
              topP,
              maxTokens,
              frequencyPenalty,
            }}
            onChange={(v) => {
              if ('temperature' in v) setTemperature(v.temperature!);
              if ('topP' in v) setTopP(v.topP!);
              if ('maxTokens' in v) {
                setMaxTokens(v.maxTokens == null
                  ? null
                  : Math.min(v.maxTokens, selectedModel?.max_output_tokens ?? v.maxTokens));
              }
              if ('frequencyPenalty' in v) setFrequencyPenalty(v.frequencyPenalty!);
            }}
            defaults={{
              temperature: modelParamDefaults.temperature,
              topP: modelParamDefaults.topP,
              maxTokens: modelParamDefaults.maxTokens,
              frequencyPenalty: modelParamDefaults.frequencyPenalty,
            }}
            maxTokensMax={selectedModel?.max_output_tokens ?? 1048576}
          />
          {maxTokens != null
            && selectedModel?.max_output_tokens != null
            && maxTokens > selectedModel.max_output_tokens && (
              <div style={{ color: token.colorWarning, fontSize: 12, marginTop: 4 }}>
                {t('settings.modelMaxOutputTokens')}: {selectedModel.max_output_tokens.toLocaleString()}
              </div>
            )}
        </Card>
      </div>
    </Modal>
  );
}
