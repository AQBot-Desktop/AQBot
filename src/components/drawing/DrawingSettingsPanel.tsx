import { Alert, Button, Form, theme } from 'antd';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getDrawingParamConfig,
  getDrawingModelOptions,
  getDrawingProvidersForModel,
  normalizeDrawingSettingsByConfig,
} from '@/lib/drawingModels';
import { SmartProviderIcon } from '@/lib/providerIcons';
import { useUIStore } from '@/stores/uiStore';
import type { DrawingSettings, DrawingTarget, ProviderConfig } from '@/types';
import {
  DrawingDynamicParameters,
  DrawingParameterField,
} from './DrawingParameterControls';
import type {
  DrawingParamField,
  DrawingParamOption,
  DrawingParamRenderContext,
} from './params/types';

export type { DrawingSettings };

interface Props {
  settings: DrawingSettings;
  providers: ProviderConfig[];
  targets?: DrawingTarget[];
  unavailableReasons?: string[];
  onChange: (settings: DrawingSettings) => void;
}

export function DrawingSettingsPanel({
  settings,
  providers,
  targets,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const setActivePage = useUIStore((state) => state.setActivePage);
  const setSettingsSection = useUIStore((state) => state.setSettingsSection);
  const translateOption = (key: string, fallback: string) => t(key, fallback);
  const paramConfig = getDrawingParamConfig(settings.modelId);
  const basicFields = paramConfig.groups.find((group) => group.id === 'basic')?.fields ?? [];
  const advancedFields = paramConfig.groups.find((group) => group.id === 'advanced')?.fields ?? [];
  const selectedProvider = providers.find((provider) => provider.id === settings.providerId);
  const selectedTarget = targets?.find((target) =>
    target.provider_id === settings.providerId && target.model_id === settings.modelId,
  );
  const targetProviderIds = new Set(targets?.map((target) => target.provider_id));
  const availableProviders = providers.filter((provider) =>
    provider.enabled
    && provider.models.some((model) => model.enabled && model.model_type === 'Image')
    && (targets === undefined || targetProviderIds.has(provider.id)),
  );
  const modelOptions = targets === undefined
    ? getDrawingModelOptions(providers).filter((option) =>
      !selectedProvider
      || selectedProvider.models.some((model) =>
        model.enabled && model.model_type === 'Image' && model.model_id === option.value,
      ),
    )
    : targets
      .filter((target) => target.provider_id === settings.providerId)
      .map((target) => ({ label: target.model_name, value: target.model_id }));
  const paramModelOptions: DrawingParamOption[] = modelOptions.map((option) => ({
    fallbackLabel: option.label,
    value: option.value,
  }));
  const paramProviderOptions: DrawingParamOption[] = availableProviders.map((provider) => ({
    fallbackLabel: provider.name,
    value: provider.id,
  }));
  const providerSelectOptions = availableProviders.map((provider) => ({
    label: (
      <span className="inline-flex items-center gap-2">
        <SmartProviderIcon provider={provider} size={18} type="avatar" />
        <span>{provider.name}</span>
      </span>
    ),
    value: provider.id,
  }));

  const renderContext: DrawingParamRenderContext = {
    settings,
    providers,
    modelOptions: paramModelOptions,
    providerOptions: paramProviderOptions,
    t: translateOption,
    getProvidersForModel: (modelId) => getDrawingProvidersForModel(providers, modelId),
  };

  const visibleBasicFields = basicFields.filter((field) =>
    isFieldVisible(field, renderContext)
    && isDescriptorFieldVisible(field, selectedTarget),
  );
  const visibleAdvancedFields = advancedFields.filter((field) =>
    isFieldVisible(field, renderContext)
    && isDescriptorFieldVisible(field, selectedTarget),
  );
  const dynamicFields = selectedTarget?.descriptor.parameters.filter(
    (parameter) => !['size', 'quality', 'output_format', 'background', 'n'].includes(parameter.key),
  ) ?? [];
  const targetKey = `${settings.providerId}::${settings.modelId}`;
  const targetParameters = settings.parametersByTarget?.[targetKey] ?? settings.parameters ?? {};

  const patch = (next: Partial<DrawingSettings>) => {
    const providerId = next.providerId ?? settings.providerId;
    const modelId = next.modelId ?? settings.modelId;
    const selectionChanged = providerId !== settings.providerId || modelId !== settings.modelId;
    const nextParameters = selectionChanged
      ? settings.parametersByTarget?.[`${providerId}::${modelId}`] ?? {}
      : next.parameters ?? settings.parameters;
    onChange(normalizeDrawingSettingsByConfig({
      ...settings,
      ...next,
      parameters: nextParameters,
    }));
  };

  const patchTargetParameter = (key: string, value: unknown) => {
    const parameters = { ...targetParameters, [key]: value };
    patch({
      parameters,
      parametersByTarget: {
        ...settings.parametersByTarget,
        [targetKey]: parameters,
      },
    });
  };

  const patchField = (field: DrawingParamField, value: unknown) => {
    const next = field.normalizeOnChange
      ? field.normalizeOnChange(value, renderContext)
      : field.key
        ? ({ [field.key]: value } as Partial<DrawingSettings>)
        : {};
    patch(next);
  };

  const renderField = (field: DrawingParamField) => (
    <DrawingParameterField
      key={field.id}
      field={field}
      settings={settings}
      context={renderContext}
      target={selectedTarget}
      providerOptions={providerSelectOptions}
      secondaryTextColor={token.colorTextSecondary}
      translate={translateOption}
      onChange={patchField}
      onProviderChange={(providerId) => {
        const targetModelId = targets?.find(
          (target) => target.provider_id === providerId,
        )?.model_id;
        const provider = providers.find((item) => item.id === providerId);
        const imageModels = provider?.models.filter(
          (model) => model.enabled && model.model_type === 'Image',
        ) ?? [];
        const modelId = targetModelId
          ?? (imageModels.some((model) => model.model_id === settings.modelId)
            ? settings.modelId
            : imageModels[0]?.model_id ?? settings.modelId);
        patch({ providerId, modelId });
      }}
    />
  );

  return (
    <aside
      className="h-full overflow-y-auto"
      style={{
        width: 304,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        padding: 16,
      }}
    >
      <Form layout="vertical">
        {targets?.length === 0 && (
          <Alert
            type="warning"
            style={{ marginBottom: 16, padding: 12, borderRadius: 8 }}
            description={(
              <div className="flex min-w-0 flex-col items-start gap-2">
                <span
                  className="w-full break-words [overflow-wrap:anywhere]"
                  style={{ fontSize: 13, lineHeight: '20px' }}
                >
                  {t(
                    'drawing.noConfiguredImageProvider',
                    '暂无任何配置绘画模型类型的服务商，请前往服务商设置页进行配置',
                  )}
                </span>
                <Button
                  size="small"
                  color="orange"
                  variant="filled"
                  style={{ fontSize: 13 }}
                  onClick={() => {
                    setSettingsSection('providers');
                    setActivePage('settings');
                  }}
                >
                  {t('drawing.openProviderSettings', '打开服务商设置')}
                </Button>
              </div>
            )}
          />
        )}
        {visibleBasicFields.map(renderField)}
        <DrawingDynamicParameters
          parameters={dynamicFields}
          values={targetParameters}
          translate={translateOption}
          onChange={patchTargetParameter}
        />
      </Form>
      {visibleAdvancedFields.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            className="mb-3 flex w-full items-center justify-between transition-colors"
            style={{
              height: 44,
              border: 'none',
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              background: 'transparent',
              color: token.colorText,
              padding: 0,
              fontSize: 14,
              fontWeight: 600,
              textAlign: 'left',
            }}
          >
            <span>{t('drawing.advancedSettings', '高级设置')}</span>
            <span
              className="flex items-center justify-center"
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: token.colorFillAlter,
                color: token.colorTextSecondary,
              }}
            >
              {advancedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </span>
          </button>
          {advancedOpen && (
            <Form layout="vertical">
              {visibleAdvancedFields.map(renderField)}
            </Form>
          )}
        </>
      )}
    </aside>
  );
}

function isFieldVisible(field: DrawingParamField, context: DrawingParamRenderContext): boolean {
  return field.visibleWhen ? field.visibleWhen(context) : true;
}

function isDescriptorFieldVisible(
  field: DrawingParamField,
  target: DrawingTarget | undefined,
): boolean {
  if (!target) return true;
  const keys = new Set(target.descriptor.parameters.map((parameter) => parameter.key));
  if (field.type === 'referenceUploader' || field.id.startsWith('referenceImage')) {
    return target.descriptor.max_reference_images > 0;
  }
  const descriptorKeys: Partial<Record<string, string>> = {
    size: 'size',
    quality: 'quality',
    outputFormat: 'output_format',
    background: 'background',
    batchCount: 'n',
  };
  const descriptorKey = descriptorKeys[field.id];
  return descriptorKey ? keys.has(descriptorKey) : true;
}
