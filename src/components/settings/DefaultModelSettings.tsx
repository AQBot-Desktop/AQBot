import { Card, Slider, InputNumber, Button, Input, Tooltip, Modal, Switch, Divider, theme } from 'antd';
import { Settings, Info, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, useProviderStore } from '@/stores';
import { useEffect, useCallback, useState } from 'react';
import type { AppSettings } from '@/types';
import { ModelSelect, parseModelValue } from '@/components/shared/ModelSelect';

const { TextArea } = Input;

const DEFAULT_TITLE_SUMMARY_PROMPT = '请根据以下对话内容，生成一个简短精炼的标题（不超过20个字），直接返回标题文本，不要包含引号或任何额外说明。';

// ── Switch-controlled parameter row ────────────────────────

function SwitchParam({
  label,
  tooltip,
  value,
  defaultValue,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  tooltip?: string;
  value: number | null;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number | null) => void;
}) {
  const { token } = theme.useToken();
  const isOn = value !== null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 }}>
          {label}
          {tooltip && (
            <Tooltip title={tooltip}>
              <Info size={12} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
            </Tooltip>
          )}
        </span>
        <Switch
          size="small"
          checked={isOn}
          onChange={(checked) => onChange(checked ? defaultValue : null)}
        />
      </div>
      {isOn && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
          <Slider
            style={{ flex: 1 }}
            min={min} max={max} step={step}
            value={value!}
            onChange={(v) => onChange(v)}
          />
          <InputNumber
            style={{ width: 72 }}
            min={min} max={max} step={step}
            value={value!}
            onChange={(v) => v !== null && onChange(v)}
            size="small"
          />
        </div>
      )}
      <Divider style={{ margin: 0 }} />
    </>
  );
}

// ── Context count slider ───────────────────────────────────

const CONTEXT_MARKS: Record<number, string> = { 0: '0', 5: '5', 10: '10', 15: '15', 50: '不限' };

function ContextCountParam({
  label,
  tooltip,
  value,
  onChange,
}: {
  label: string;
  tooltip?: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const { token } = theme.useToken();
  const effectiveValue = value ?? 5;

  return (
    <>
      <div style={{ padding: '12px 0 4px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 }}>
          {label}
          {tooltip && (
            <Tooltip title={tooltip}>
              <Info size={12} style={{ color: token.colorTextSecondary, cursor: 'help' }} />
            </Tooltip>
          )}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
        <Slider
          style={{ flex: 1 }}
          min={0} max={50} step={1}
          marks={CONTEXT_MARKS}
          value={effectiveValue}
          onChange={(v) => onChange(v)}
        />
        <InputNumber
          style={{ width: 72 }}
          min={0} max={50}
          value={effectiveValue}
          onChange={(v) => onChange(v ?? 5)}
          size="small"
        />
      </div>
      <Divider style={{ margin: 0 }} />
    </>
  );
}

// ── Settings Modal ─────────────────────────────────────────

function ModelParamsModal({
  open,
  onClose,
  title,
  showPrompt,
  showContextCount,
  promptKey,
  temperatureKey,
  topPKey,
  maxTokensKey,
  contextCountKey,
  defaultTemperature,
  defaultTopP,
  defaultMaxTokens,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  showPrompt: boolean;
  showContextCount: boolean;
  promptKey?: keyof AppSettings;
  temperatureKey: keyof AppSettings;
  topPKey: keyof AppSettings;
  maxTokensKey: keyof AppSettings;
  contextCountKey?: keyof AppSettings;
  defaultTemperature: number;
  defaultTopP: number;
  defaultMaxTokens: number;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const handleReset = useCallback(() => {
    const resetValues: Record<string, unknown> = {
      [temperatureKey]: null,
      [topPKey]: null,
      [maxTokensKey]: null,
    };
    if (contextCountKey) resetValues[contextCountKey] = null;
    if (promptKey) resetValues[promptKey] = null;
    saveSettings(resetValues as Partial<AppSettings>);
  }, [saveSettings, temperatureKey, topPKey, maxTokensKey, contextCountKey, promptKey]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      footer={null}
      width={520}
      mask={{ enabled: true, blur: true }}
    >
      {showPrompt && promptKey && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            {t('settings.promptLabel', '提示词')}
          </div>
          <TextArea
            rows={4}
            value={(settings[promptKey] as string | null) ?? DEFAULT_TITLE_SUMMARY_PROMPT}
            onChange={(e) => saveSettings({ [promptKey]: e.target.value || null } as Partial<AppSettings>)}
            placeholder={t('settings.titleSummaryPromptPlaceholder', '请根据对话内容生成一个简短的标题...')}
          />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          {t('settings.modelParams', '模型参数')}
        </span>
        <Button
          type="text"
          size="small"
          icon={<Undo2 size={14} />}
          onClick={handleReset}
        />
      </div>
      <Divider style={{ margin: '4px 0 0' }} />

      <SwitchParam
        label={t('settings.modelTemperature', '模型温度')}
        tooltip={t('settings.temperatureTooltip', '较高的值会使输出更随机，较低的值会使输出更确定')}
        value={settings[temperatureKey] as number | null}
        defaultValue={defaultTemperature}
        min={0} max={2} step={0.1}
        onChange={(v) => saveSettings({ [temperatureKey]: v } as Partial<AppSettings>)}
      />

      <SwitchParam
        label="Top-P"
        tooltip={t('settings.topPTooltip', '控制采样范围，较低的值会限制模型只从最可能的词中选择')}
        value={settings[topPKey] as number | null}
        defaultValue={defaultTopP}
        min={0} max={1} step={0.05}
        onChange={(v) => saveSettings({ [topPKey]: v } as Partial<AppSettings>)}
      />

      {showContextCount && contextCountKey && (
        <ContextCountParam
          label={t('settings.contextCount', '上下文数')}
          tooltip={t('settings.contextCountTooltip', '发送给模型的历史消息数量')}
          value={settings[contextCountKey] as number | null}
          onChange={(v) => saveSettings({ [contextCountKey]: v } as Partial<AppSettings>)}
        />
      )}

      <SwitchParam
        label={t('settings.maxTokenCount', '最大 Token 数')}
        tooltip={t('settings.maxTokensTooltip', '模型生成的最大 Token 数量')}
        value={settings[maxTokensKey] as number | null}
        defaultValue={defaultMaxTokens}
        min={256} max={32768} step={256}
        onChange={(v) => saveSettings({ [maxTokensKey]: v } as Partial<AppSettings>)}
      />
    </Modal>
  );
}

// ── Model Card ─────────────────────────────────────────────

function ModelCard({
  title,
  description,
  providerIdKey,
  modelIdKey,
  placeholder,
  modalTitle,
  showPrompt,
  showContextCount,
  promptKey,
  temperatureKey,
  topPKey,
  maxTokensKey,
  contextCountKey,
  defaultTemperature,
  defaultTopP,
  defaultMaxTokens,
}: {
  title: string;
  description: string;
  providerIdKey: keyof AppSettings;
  modelIdKey: keyof AppSettings;
  placeholder: string;
  modalTitle: string;
  showPrompt: boolean;
  showContextCount: boolean;
  promptKey?: keyof AppSettings;
  temperatureKey: keyof AppSettings;
  topPKey: keyof AppSettings;
  maxTokensKey: keyof AppSettings;
  contextCountKey?: keyof AppSettings;
  defaultTemperature: number;
  defaultTopP: number;
  defaultMaxTokens: number;
}) {
  const { token } = theme.useToken();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const [modalOpen, setModalOpen] = useState(false);

  const currentProviderId = settings[providerIdKey] as string | null;
  const currentModelId = settings[modelIdKey] as string | null;
  const currentValue = currentProviderId && currentModelId
    ? `${currentProviderId}::${currentModelId}`
    : undefined;

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!value) {
        saveSettings({ [providerIdKey]: null, [modelIdKey]: null } as Partial<AppSettings>);
        return;
      }
      const parsed = parseModelValue(value);
      if (parsed) {
        saveSettings({ [providerIdKey]: parsed.providerId, [modelIdKey]: parsed.modelId } as Partial<AppSettings>);
      }
    },
    [saveSettings, providerIdKey, modelIdKey],
  );

  return (
    <>
      <Card
        size="small"
        title={title}
        style={{ marginBottom: 16, width: '100%' }}
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <ModelSelect
            style={{ flex: 1 }}
            value={currentValue}
            onChange={handleChange}
            placeholder={placeholder}
          />
          <Tooltip title={modalTitle}>
            <Button
              icon={<Settings size={16} />}
              onClick={() => setModalOpen(true)}
            />
          </Tooltip>
        </div>
        <div style={{ color: token.colorTextSecondary, fontSize: 13 }}>
          {description}
        </div>
      </Card>

      <ModelParamsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={modalTitle}
        showPrompt={showPrompt}
        showContextCount={showContextCount}
        promptKey={promptKey}
        temperatureKey={temperatureKey}
        topPKey={topPKey}
        maxTokensKey={maxTokensKey}
        contextCountKey={contextCountKey}
        defaultTemperature={defaultTemperature}
        defaultTopP={defaultTopP}
        defaultMaxTokens={defaultMaxTokens}
      />
    </>
  );
}

// ── Main Component ─────────────────────────────────────────

export function DefaultModelSettings() {
  const { t } = useTranslation();
  const fetchProviders = useProviderStore((s) => s.fetchProviders);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const placeholderText = t('settings.useActiveModel', '使用当前活跃对话的模型');

  return (
    <div style={{ padding: 24 }}>
      <ModelCard
        title={t('settings.defaultConversationModel', '默认对话模型')}
        description={t('settings.defaultConversationModelDesc', '新建对话时默认选择的模型，未设置时将沿用上个活跃对话的模型')}
        providerIdKey="default_provider_id"
        modelIdKey="default_model_id"
        placeholder={placeholderText}
        modalTitle={t('settings.defaultConversationModel', '默认对话模型')}
        showPrompt={false}
        showContextCount={true}
        temperatureKey="default_temperature"
        topPKey="default_top_p"
        maxTokensKey="default_max_tokens"
        contextCountKey="default_context_count"
        defaultTemperature={0.7}
        defaultTopP={1.0}
        defaultMaxTokens={4096}
      />

      <ModelCard
        title={t('settings.titleSummaryModel', '标题总结模型')}
        description={t('settings.titleSummaryModelDesc', '自动生成对话标题时所使用的模型，若未设置则使用对话采用的模型生成')}
        providerIdKey="title_summary_provider_id"
        modelIdKey="title_summary_model_id"
        placeholder={placeholderText}
        modalTitle={t('settings.titleSummaryModel', '标题总结模型')}
        showPrompt={true}
        showContextCount={false}
        promptKey="title_summary_prompt"
        temperatureKey="title_summary_temperature"
        topPKey="title_summary_top_p"
        maxTokensKey="title_summary_max_tokens"
        defaultTemperature={0.3}
        defaultTopP={1.0}
        defaultMaxTokens={256}
      />
    </div>
  );
}
