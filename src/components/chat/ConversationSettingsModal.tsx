import React, { useState, useEffect } from 'react';
import { Modal, Input, Slider, Button, Tooltip, Card, theme } from 'antd';
import { ModelIcon } from '@lobehub/icons';
import { Info, Undo2, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConversationStore, useSettingsStore } from '@/stores';
import { CONV_ICON_KEY, type ConvIconType, type ConvIcon } from '@/lib/convIcon';
import { IconEditor } from '@/components/shared/IconEditor';
import { ModelParamSliders } from '@/components/common/ModelParamSliders';
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

  const conversation = conversations.find((c) => c.id === activeConversationId);

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
      setTemperature(conversation.temperature ?? settings.default_temperature ?? 0.7);
      setTopP(conversation.top_p ?? settings.default_top_p ?? 1.0);
      setMaxTokens(conversation.max_tokens ?? settings.default_max_tokens ?? 4096);
      setFrequencyPenalty(conversation.frequency_penalty ?? settings.default_frequency_penalty ?? 0);

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
        temperature: temperature ?? undefined,
        max_tokens: maxTokens ?? undefined,
        top_p: topP ?? undefined,
        frequency_penalty: frequencyPenalty ?? undefined,
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
      label: t('settings.useModelIcon', '使用模型图标'),
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
      title={t('settings.conversationSettings', '对话设置')}
      open={open}
      mask={{ enabled: true, blur: true }}
      onCancel={onClose}
      width={520}
      destroyOnHidden
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onClose}>{t('common.cancel', '取消')}</Button>
          <Button type="primary" onClick={handleSave} loading={saving}>
            {t('common.save', '保存')}
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
            defaultIcon={<ModelIcon model={conversation.model_id} size={64} type="avatar" />}
            prependMenuItems={useModelIconMenuItem}
            showClear={iconType !== 'model'}
          />
        </div>

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>{t('common.name', '名称')}</div>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        {/* System Prompt */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>{t('settings.systemPromptLabel', '系统提示（角色设定）')}</div>
          <Input.TextArea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3}
            placeholder={t('settings.systemPromptPlaceholder', '输入系统提示词...')}
          />
        </div>

        {/* Model Settings Card */}
        <Card
          title={t('settings.modelSettings', '模型设置')}
          size="small"
          extra={
            <Button
              type="text"
              size="small"
              icon={<Undo2 size={14} />}
              onClick={handleReset}
            >
              {t('common.reset', '重置')}
            </Button>
          }
        >

          {/* Context Message Limit */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              {t('settings.contextMessageLimit', '上下文的消息数量上限')}
              <Tooltip title={t('settings.contextMessageLimitTooltip', '限制发送给模型的历史消息数量。设为 50 表示不限制。')}>
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
              <span style={{ marginLeft: 'auto', color: token.colorTextSecondary, fontSize: 12 }}>
                {contextLimit >= 50 ? t('common.unlimited', '不限制') : contextLimit}
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
              if ('maxTokens' in v) setMaxTokens(v.maxTokens!);
              if ('frequencyPenalty' in v) setFrequencyPenalty(v.frequencyPenalty!);
            }}
            defaults={{
              temperature: settings.default_temperature ?? 0.7,
              topP: settings.default_top_p ?? 1.0,
              maxTokens: settings.default_max_tokens ?? 4096,
              frequencyPenalty: settings.default_frequency_penalty ?? 0,
            }}
          />
        </Card>
      </div>
    </Modal>
  );
}
