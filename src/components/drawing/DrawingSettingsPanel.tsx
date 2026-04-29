import { Form, InputNumber, Select, Slider, Switch, Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import type { DrawingBackground, DrawingModelId, DrawingOutputFormat, DrawingQuality, ProviderConfig } from '@/types';
import {
  getDrawingBackgroundOptions,
  getDrawingModelOptions,
  getDrawingOutputFormatOptions,
  getDrawingProvidersForModel,
  getDrawingQualityOptions,
  getDrawingSizeOptions,
  isDrawingOutputCompressionSupported,
  isDrawingTransparentBackgroundSupported,
} from '@/lib/drawingModels';
import { SmartProviderIcon } from '@/lib/providerIcons';
import { DrawingReferenceUploader } from './DrawingReferenceUploader';

export interface DrawingSettings {
  providerId: string;
  modelId: DrawingModelId;
  size: string;
  quality: DrawingQuality;
  outputFormat: DrawingOutputFormat;
  background: DrawingBackground;
  outputCompression?: number;
  n: number;
}

interface Props {
  settings: DrawingSettings;
  providers: ProviderConfig[];
  onChange: (settings: DrawingSettings) => void;
}

export function DrawingSettingsPanel({ settings, providers, onChange }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const translateOption = (key: string, fallback: string) => t(key, fallback);
  const modelOptions = getDrawingModelOptions();
  const compatibleProviders = getDrawingProvidersForModel(providers, settings.modelId);
  const providerOptions = compatibleProviders.map((provider) => ({
    label: (
      <span className="inline-flex items-center gap-2">
        <SmartProviderIcon provider={provider} size={18} type="avatar" />
        <span>{provider.name}</span>
      </span>
    ),
    value: provider.id,
  }));
  const compressionVisible = isDrawingOutputCompressionSupported(settings.modelId, settings.outputFormat);
  const backgroundOptions = getDrawingBackgroundOptions(translateOption, settings.modelId);

  const normalizeSettings = (next: DrawingSettings): DrawingSettings => ({
    ...next,
    background: isDrawingTransparentBackgroundSupported(next.modelId) || next.background !== 'transparent'
      ? next.background
      : 'auto',
    outputCompression: isDrawingOutputCompressionSupported(next.modelId, next.outputFormat)
      ? next.outputCompression
      : undefined,
  });

  const patch = (next: Partial<DrawingSettings>) => onChange(normalizeSettings({ ...settings, ...next }));

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
        <Form.Item label={t('drawing.model', '模型')}>
          <Select
            value={settings.modelId}
            options={modelOptions}
            placeholder={t('drawing.selectModel', '选择绘图模型')}
            onChange={(modelId) => {
              const nextProviders = getDrawingProvidersForModel(providers, modelId);
              const providerId = nextProviders.some((provider) => provider.id === settings.providerId)
                ? settings.providerId
                : nextProviders[0]?.id ?? '';
              patch({
                modelId,
                providerId,
              });
            }}
          />
        </Form.Item>
        <Form.Item label={t('drawing.provider', 'Provider')}>
          <Select
            value={settings.providerId || undefined}
            placeholder={t('drawing.selectProvider', '选择服务商')}
            options={providerOptions}
            optionLabelProp="label"
            onChange={(providerId) => patch({ providerId })}
          />
        </Form.Item>
        <Form.Item label={t('drawing.size', '尺寸')}>
          <Select
            value={settings.size}
            options={getDrawingSizeOptions(translateOption)}
            onChange={(size) => patch({ size })}
          />
        </Form.Item>
        <Form.Item label={t('drawing.quality', '质量')}>
          <Select
            value={settings.quality}
            options={getDrawingQualityOptions(translateOption)}
            onChange={(quality) => patch({ quality })}
          />
        </Form.Item>
        <Form.Item label={t('drawing.outputFormat', '输出格式')}>
          <Select
            value={settings.outputFormat}
            options={getDrawingOutputFormatOptions(translateOption)}
            onChange={(outputFormat) => patch({ outputFormat })}
          />
        </Form.Item>
        <Form.Item label={t('drawing.background', '背景')}>
          <Select
            value={settings.background}
            options={backgroundOptions}
            onChange={(background) => patch({ background })}
          />
        </Form.Item>
        <Form.Item label={t('drawing.batchCount', '批量张数')}>
          <InputNumber
            min={1}
            max={10}
            value={settings.n}
            style={{ width: '100%' }}
            onChange={(n) => patch({ n: n || 1 })}
          />
        </Form.Item>
        {compressionVisible && (
          <Form.Item label={t('drawing.compression', '压缩')}>
            <div className="flex items-center gap-3">
              <Switch
                checked={settings.outputCompression !== undefined}
                onChange={(checked) => patch({ outputCompression: checked ? 90 : undefined })}
              />
              <Slider
                min={0}
                max={100}
                disabled={settings.outputCompression === undefined}
                value={settings.outputCompression ?? 90}
                onChange={(outputCompression) => patch({ outputCompression })}
                style={{ flex: 1 }}
              />
            </div>
          </Form.Item>
        )}
      </Form>
      <Typography.Text style={{ fontSize: 12, color: token.colorTextSecondary }}>
        {t('drawing.references', '参考图')}
      </Typography.Text>
      <div className="mt-2">
        <DrawingReferenceUploader />
      </div>
    </aside>
  );
}
