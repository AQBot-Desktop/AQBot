import React, { useState, useEffect, useRef } from 'react';
import { Modal, Input, Slider, InputNumber, Button, Tooltip, Card, Dropdown, Avatar, theme } from 'antd';
import type { MenuProps } from 'antd';
import { ModelIcon } from '@lobehub/icons';
import { Info, Undo2, FileImage, Link, Smile, Bot } from 'lucide-react';
import { useConversationStore, useSettingsStore } from '@/stores';
import { CONV_ICON_KEY, type ConvIconType, type ConvIcon } from '@/lib/convIcon';
import { EmojiPicker } from '@/components/shared/EmojiPicker';

interface ConversationSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const CONTEXT_LIMIT_KEY = (id: string) => `aqbot_context_limit_${id}`;

export function ConversationSettingsModal({ open, onClose }: ConversationSettingsModalProps) {
  const { token } = theme.useToken();

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
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlInputValue, setUrlInputValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize form when modal opens
  useEffect(() => {
    if (open && conversation) {
      setTitle(conversation.title);
      setSystemPrompt(conversation.system_prompt ?? '');
      setTemperature(conversation.temperature);
      setTopP(conversation.top_p);
      setMaxTokens(conversation.max_tokens);
      setFrequencyPenalty(conversation.frequency_penalty);

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
      setShowEmojiPicker(false);
      setShowUrlInput(false);
    }
  }, [open, conversation]);

  if (!conversation) return null;

  const effectiveTemp = temperature ?? settings.default_temperature ?? 0.7;
  const effectiveTopP = topP ?? settings.default_top_p ?? 1.0;
  const effectiveMaxTokens = maxTokens ?? settings.default_max_tokens ?? 4096;
  const effectiveFreqPenalty = frequencyPenalty ?? settings.default_frequency_penalty ?? 0.0;

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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setIconType('file');
      setIconValue(reader.result as string);
      setShowEmojiPicker(false);
      setShowUrlInput(false);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const avatarMenuItems: MenuProps['items'] = [
    {
      key: 'model',
      icon: <Bot size={14} />,
      label: '使用模型图标',
      onClick: () => {
        setIconType('model');
        setIconValue('');
        setShowEmojiPicker(false);
        setShowUrlInput(false);
      },
    },
    {
      key: 'file',
      icon: <FileImage size={14} />,
      label: '选择图片',
      onClick: () => {
        fileInputRef.current?.click();
        setShowEmojiPicker(false);
        setShowUrlInput(false);
      },
    },
    {
      key: 'url',
      icon: <Link size={14} />,
      label: '图片链接',
      onClick: () => {
        setShowUrlInput(true);
        setShowEmojiPicker(false);
        setUrlInputValue(iconType === 'url' ? iconValue : '');
      },
    },
    {
      key: 'emoji',
      icon: <Smile size={14} />,
      label: 'Emoji',
      onClick: () => {
        setShowEmojiPicker(true);
        setShowUrlInput(false);
      },
    },
  ];

  const renderConvAvatar = () => {
    const size = 64;
    if (iconType === 'emoji' && iconValue) {
      return (
        <Avatar size={size} style={{ fontSize: 32, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}`, cursor: 'pointer' }}>
          {iconValue}
        </Avatar>
      );
    }
    if ((iconType === 'url' || iconType === 'file') && iconValue) {
      return (
        <Avatar size={size} src={iconValue} style={{ cursor: 'pointer' }} />
      );
    }
    return (
      <div style={{ cursor: 'pointer' }}>
        <ModelIcon model={conversation.model_id} size={size} type="avatar" />
      </div>
    );
  };

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
      title="对话设置"
      open={open}
      mask={{ enabled: true, blur: true }}
      onCancel={onClose}
      width={520}
      destroyOnHidden
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={handleSave} loading={saving}>
            保存
          </Button>
        </div>
      }
    >
      <div style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
        {/* Avatar with Dropdown */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 16px' }}>
          <Dropdown menu={{ items: avatarMenuItems }} trigger={['click']} placement="bottom">
            {renderConvAvatar()}
          </Dropdown>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
        </div>

        {/* Emoji Picker */}
        <EmojiPicker
          open={showEmojiPicker}
          onClose={() => setShowEmojiPicker(false)}
          onEmojiSelect={(emoji) => {
            setIconType('emoji');
            setIconValue(emoji);
            setShowEmojiPicker(false);
          }}
        />

        {/* URL Input */}
        {showUrlInput && (
          <div style={{ marginBottom: 16 }}>
            <Input
              placeholder="输入图片链接..."
              value={urlInputValue}
              onChange={(e) => setUrlInputValue(e.target.value)}
              onPressEnter={() => {
                if (urlInputValue.trim()) {
                  setIconType('url');
                  setIconValue(urlInputValue.trim());
                  setShowUrlInput(false);
                }
              }}
              suffix={
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    if (urlInputValue.trim()) {
                      setIconType('url');
                      setIconValue(urlInputValue.trim());
                      setShowUrlInput(false);
                    }
                  }}
                >
                  确认
                </Button>
              }
            />
          </div>
        )}

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>名称</div>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        {/* System Prompt */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>系统提示（角色设定）</div>
          <Input.TextArea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3}
            placeholder="输入系统提示词..."
          />
        </div>

        {/* Model Settings Card */}
        <Card
          title="模型设置"
          size="small"
          extra={
            <Button
              type="text"
              size="small"
              icon={<Undo2 size={14} />}
              onClick={handleReset}
            >
              重置
            </Button>
          }
        >

          {/* Context Message Limit */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              上下文的消息数量上限
              <Tooltip title="限制发送给模型的历史消息数量。设为 50 表示不限制。">
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
              <span style={{ marginLeft: 'auto', color: token.colorTextSecondary, fontSize: 12 }}>
                {contextLimit >= 50 ? '不限制' : contextLimit}
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

          {/* Temperature */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              温度
              <Tooltip title="较高的值会使输出更随机，较低的值会使输出更确定。">
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
            </div>
            <div style={sliderRowStyle}>
              <Slider
                style={{ flex: 1 }}
                min={0}
                max={2}
                step={0.1}
                value={effectiveTemp}
                onChange={(v) => setTemperature(v)}
              />
              <InputNumber
                style={{ width: 70 }}
                min={0}
                max={2}
                step={0.1}
                value={effectiveTemp}
                onChange={(v) => setTemperature(v)}
                size="small"
              />
            </div>
          </div>

          {/* Top P */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              Top P
              <Tooltip title="核采样参数。模型考虑概率质量前 P 的结果。">
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
            </div>
            <div style={sliderRowStyle}>
              <Slider
                style={{ flex: 1 }}
                min={0}
                max={1}
                step={0.1}
                value={effectiveTopP}
                onChange={(v) => setTopP(v)}
              />
              <InputNumber
                style={{ width: 70 }}
                min={0}
                max={1}
                step={0.1}
                value={effectiveTopP}
                onChange={(v) => setTopP(v)}
                size="small"
              />
            </div>
          </div>

          {/* Max Output Tokens */}
          <div style={{ marginBottom: 20 }}>
            <div style={labelStyle}>
              最大输出
              <Tooltip title="模型在单次回复中生成的最大 token 数量。">
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
            </div>
            <div style={sliderRowStyle}>
              <Slider
                style={{ flex: 1 }}
                min={256}
                max={16384}
                step={256}
                value={effectiveMaxTokens}
                onChange={(v) => setMaxTokens(v)}
              />
              <InputNumber
                style={{ width: 70 }}
                min={256}
                max={16384}
                step={256}
                value={effectiveMaxTokens}
                onChange={(v) => setMaxTokens(v)}
                size="small"
              />
            </div>
          </div>

          {/* Frequency Penalty */}
          <div>
            <div style={labelStyle}>
              频率惩罚
              <Tooltip title="对重复 token 施加惩罚，减少重复内容的生成。">
                <Info size={14} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
              </Tooltip>
            </div>
            <div style={sliderRowStyle}>
              <Slider
                style={{ flex: 1 }}
                min={0}
                max={2}
                step={0.1}
                value={effectiveFreqPenalty}
                onChange={(v) => setFrequencyPenalty(v)}
              />
              <InputNumber
                style={{ width: 70 }}
                min={0}
                max={2}
                step={0.1}
                value={effectiveFreqPenalty}
                onChange={(v) => setFrequencyPenalty(v)}
                size="small"
              />
            </div>
          </div>
        </Card>
      </div>
    </Modal>
  );
}
