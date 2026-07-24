import React, { useState, useEffect } from 'react';
import { Modal, Input, Slider, Button, Tooltip, Card, theme } from 'antd';
import { Info, Undo2, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConversationStore, useProviderStore, useSettingsStore } from '@/stores';
import { CONV_ICON_KEY, type ConvIconType, type ConvIcon } from '@/lib/convIcon';
import { IconEditor } from '@/components/shared/IconEditor';
import { ModelParamSliders } from '@/components/common/ModelParamSliders';
import { findModelByIds } from '@/lib/modelCapabilities';
import { resolveModelParamDefaults } from '@/lib/modelParams';
import { ConversationModelIcon } from './ConversationModelIcon';
import type { MenuProps } from 'antd';

interface ConversationSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const CONTEXT_LIMIT_KEY = (id: string) => `aqbot_context_limit_${id}`;

export function ConversationSettingsModal({ open, onClose }: ConversationSettingsModalProps) {
  const { token } = theme.useToken();
  const { t } = useTranslation();

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
  const [contextLimit, setContextLimit] = useState(50);
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

      const stored = localStorage.getItem(CONTEXT_LIMIT_KEY(conversation.id));
      setContextLimit(stored ? Number(stored) : 50);

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
  }, [open, conversation]);

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
      await updateConversation(conversation.id, {
        title,
        system_prompt: systemPrompt,
        temperature,
        max_tokens: maxTokens,
        top_p: topP,
        frequency_penalty: frequencyPenalty,
      });
      localStorage.setItem(CONTEXT_LIMIT_KEY(conversation.id), String(contextLimit));
      // Save icon
      if (iconType === 'model') {
        localStorage.removeItem(CONV_ICON_KEY(conversation.id));
      } else {
        localStorage.setItem(CONV_ICON_KEY(conversation.id), JSON.stringify({ type: iconType, value: iconValue }));
      }
      onClose();
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

  const sliderRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  };

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
              <span style={{ marginLeft: 'auto', color: token.colorTextSecondary, fontSize: 12 }}>
                {contextLimit >= 50 ? t('common.unlimited') : contextLimit}
              </span>
            </div>
            <div style={sliderRowStyle}>
              <Slider
                style={{ flex: 1 }}
                min={1}
                max={50}
                value={contextLimit}
                onChange={setContextLimit}
                marks={{ 1: '1', 10: '10', 25: '25', 50: '50' }}
              />
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
