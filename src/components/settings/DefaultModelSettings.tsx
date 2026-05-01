import { Slider, InputNumber, Button, Input, Tooltip, Modal, Divider, theme } from 'antd';
import { Settings, Info, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, useProviderStore } from '@/stores';
import { useEffect, useCallback, useState } from 'react';
import type { AppSettings, ModelType } from '@/types';
import { ModelSelect, parseModelValue } from '@/components/shared/ModelSelect';
import { ModelParamSliders } from '@/components/common/ModelParamSliders';
import { SettingsGroup } from './SettingsGroup';

const { TextArea } = Input;

const DEFAULT_TITLE_SUMMARY_PROMPT = '请根据以下对话内容，生成一个简短精炼的标题（不超过20个字），直接返回标题文本，不要包含引号或任何额外说明。';

const DEFAULT_COMPRESSION_PROMPT = '你是一个对话摘要助手。请将以下对话历史压缩为简洁摘要。\n\n要求：\n1. 保留所有用户明确表达的需求、偏好和决策\n2. 保留关键技术细节（代码片段、配置、错误信息等）\n3. 保留待办事项和未解决的问题\n4. 用简洁的要点形式组织\n5. 保持摘要简洁，不超过 500 字';

// ── Context count slider ───────────────────────────────────

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
  const { t } = useTranslation();
  const effectiveValue = value ?? 5;
  const contextMarks: Record<number, string> = { 0: '0', 5: '5', 10: '10', 15: '15', 50: t('common.unlimited') };

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
          marks={contextMarks}
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
  defaultPrompt,
  promptPlaceholder,
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
  defaultPrompt?: string;
  promptPlaceholder?: string;
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
            {t('settings.promptLabel')}
          </div>
          <TextArea
            rows={4}
            value={(settings[promptKey] as string | null) ?? (defaultPrompt || DEFAULT_TITLE_SUMMARY_PROMPT)}
            onChange={(e) => saveSettings({ [promptKey]: e.target.value || null } as Partial<AppSettings>)}
            placeholder={promptPlaceholder || t('settings.titleSummaryPromptPlaceholder')}
          />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          {t('settings.modelParams')}
        </span>
        <Button
          type="text"
          size="small"
          icon={<Undo2 size={14} />}
          onClick={handleReset}
        />
      </div>
      <Divider style={{ margin: '4px 0 0' }} />

      <ModelParamSliders
        values={{
          temperature: (settings[temperatureKey] as number | null) ?? defaultTemperature,
          topP: (settings[topPKey] as number | null) ?? defaultTopP,
          maxTokens: (settings[maxTokensKey] as number | null) ?? defaultMaxTokens,
          frequencyPenalty: null,
        }}
        onChange={(v) => {
          const patch: Record<string, unknown> = {};
          if ('temperature' in v) patch[temperatureKey] = v.temperature;
          if ('topP' in v) patch[topPKey] = v.topP;
          if ('maxTokens' in v) patch[maxTokensKey] = v.maxTokens;
          saveSettings(patch as Partial<AppSettings>);
        }}
        defaults={{ temperature: defaultTemperature, topP: defaultTopP, maxTokens: defaultMaxTokens }}
        visibleParams={['temperature', 'topP', 'maxTokens']}
      />

      {showContextCount && contextCountKey && (
        <ContextCountParam
          label={t('settings.contextCount')}
          tooltip={t('settings.contextCountTooltip')}
          value={settings[contextCountKey] as number | null}
          onChange={(v) => saveSettings({ [contextCountKey]: v } as Partial<AppSettings>)}
        />
      )}
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
  defaultPrompt,
  promptPlaceholder,
  modelType,
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
  defaultPrompt?: string;
  promptPlaceholder?: string;
  modelType?: ModelType;
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
      <SettingsGroup title={title}>
        <div style={{ fontSize: 12, color: token.colorTextDescription, marginBottom: 12 }}>
          {description}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ModelSelect
            style={{ flex: 1 }}
            value={currentValue}
            onChange={handleChange}
            placeholder={placeholder}
            modelType={modelType}
          />
          <Tooltip title={modalTitle}>
            <Button
              icon={<Settings size={16} />}
              onClick={() => setModalOpen(true)}
            />
          </Tooltip>
        </div>
      </SettingsGroup>

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
        defaultPrompt={defaultPrompt}
        promptPlaceholder={promptPlaceholder}
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

  const placeholderText = t('settings.useActiveModel');

  return (
    <div style={{ padding: 24 }}>
      <ModelCard
        title={t('settings.defaultConversationModel')}
        description={t('settings.defaultConversationModelDesc')}
        providerIdKey="default_provider_id"
        modelIdKey="default_model_id"
        placeholder={placeholderText}
        modalTitle={t('settings.defaultConversationModel')}
        showPrompt={false}
        showContextCount={true}
        temperatureKey="default_temperature"
        topPKey="default_top_p"
        maxTokensKey="default_max_tokens"
        contextCountKey="default_context_count"
        defaultTemperature={0.7}
        defaultTopP={1.0}
        defaultMaxTokens={4096}
        modelType="Chat"
      />

      <ModelCard
        title={t('settings.titleSummaryModel')}
        description={t('settings.titleSummaryModelDesc')}
        providerIdKey="title_summary_provider_id"
        modelIdKey="title_summary_model_id"
        placeholder={placeholderText}
        modalTitle={t('settings.titleSummaryModel')}
        showPrompt={true}
        showContextCount={false}
        promptKey="title_summary_prompt"
        temperatureKey="title_summary_temperature"
        topPKey="title_summary_top_p"
        maxTokensKey="title_summary_max_tokens"
        defaultTemperature={0.3}
        defaultTopP={1.0}
        defaultMaxTokens={1024}
        modelType="Chat"
      />

      <ModelCard
        title={t('settings.compressionModel')}
        description={t('settings.compressionModelDesc')}
        providerIdKey="compression_provider_id"
        modelIdKey="compression_model_id"
        placeholder={placeholderText}
        modalTitle={t('settings.compressionModel')}
        showPrompt={true}
        showContextCount={false}
        promptKey="compression_prompt"
        temperatureKey="compression_temperature"
        topPKey="compression_top_p"
        maxTokensKey="compression_max_tokens"
        defaultTemperature={0.3}
        defaultTopP={1.0}
        defaultMaxTokens={1024}
        defaultPrompt={DEFAULT_COMPRESSION_PROMPT}
        promptPlaceholder={t('settings.compressionPromptPlaceholder')}
        modelType="Chat"
      />
    </div>
  );
}
