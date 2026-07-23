import type {
  DrawingBackground,
  DrawingModelId,
  DrawingOutputFormat,
  DrawingQuality,
  DrawingSettings,
  DrawingReferenceImageFormat,
  DrawingReferenceImageMode,
  ProviderConfig,
} from '@/types';
import {
  GPT_IMAGE_MODELS,
  GPT_IMAGE_PARAM_CONFIG,
  GPT_IMAGE_REFERENCE_IMAGE_MODES,
  GPT_IMAGE_SIZE_OPTIONS,
  getGptImageBackgroundOptions,
  getGptImageOutputFormatOptions,
  getGptImageQualityOptions,
  getGptImageReferenceImageFormatOptions,
  getGptImageReferenceImageModeOptions,
  getGptImageSizeOptions,
  isGptImageOutputCompressionSupported,
  isGptImageTransparentBackgroundSupported,
} from '@/components/drawing/params/gpt-image';
import type { DrawingParamConfig } from '@/components/drawing/params/types';

export const DRAWING_MODELS: Array<{ id: DrawingModelId; name: string }> = [...GPT_IMAGE_MODELS];

export interface DrawingModelOption {
  label: string;
  value: DrawingModelId;
}

type DrawingTranslate = (key: string, fallback: string) => string;
const DRAWING_PARAM_CONFIGS: DrawingParamConfig[] = [GPT_IMAGE_PARAM_CONFIG];

const IMAGE_PROVIDER_TYPES = new Set<ProviderConfig['provider_type']>([
  'openai',
  'custom',
  'xai',
  'glm',
  'siliconflow',
  'gemini',
]);

function isImageProviderCompatible(provider: ProviderConfig): boolean {
  return IMAGE_PROVIDER_TYPES.has(provider.provider_type);
}

function hasEnabledImageModel(provider: ProviderConfig, modelId: DrawingModelId): boolean {
  return provider.models.some((model) =>
    model.enabled
    && model.model_type === 'Image'
    && model.model_id === modelId,
  );
}

export function getDrawingModelOptions(providers: ProviderConfig[] = []): DrawingModelOption[] {
  const options = new Map<DrawingModelId, DrawingModelOption>(
    DRAWING_MODELS.map((model) => [model.id, { label: model.name, value: model.id }]),
  );

  for (const provider of providers) {
    if (!provider.enabled || !isImageProviderCompatible(provider)) continue;
    for (const model of provider.models) {
      if (!model.enabled || model.model_type !== 'Image') continue;
      options.set(model.model_id, {
        label: model.name || model.model_id,
        value: model.model_id,
      });
    }
  }

  return Array.from(options.values());
}

export function getDrawingParamConfig(modelId: DrawingModelId): DrawingParamConfig {
  return DRAWING_PARAM_CONFIGS.find((config) => config.modelIds.includes(modelId))
    ?? GPT_IMAGE_PARAM_CONFIG;
}

export function getDrawingProvidersForModel(
  providers: ProviderConfig[],
  modelId: DrawingModelId,
): ProviderConfig[] {
  return providers.filter((provider) =>
    provider.enabled
    && isImageProviderCompatible(provider)
    && hasEnabledImageModel(provider, modelId),
  );
}

export const DRAWING_SIZE_OPTIONS = [...GPT_IMAGE_SIZE_OPTIONS];

export const DRAWING_REFERENCE_IMAGE_MODES: DrawingReferenceImageMode[] = [...GPT_IMAGE_REFERENCE_IMAGE_MODES];

export function getDrawingSizeOptions(t: DrawingTranslate): Array<{ label: string; value: string }> {
  return getGptImageSizeOptions(t).map(({ fallbackLabel, value }) => ({
    label: fallbackLabel,
    value: String(value),
  }));
}

export function getDrawingQualityOptions(
  t: DrawingTranslate,
): Array<{ label: string; value: DrawingQuality }> {
  return getGptImageQualityOptions(t).map(({ fallbackLabel, value }) => ({
    label: fallbackLabel,
    value: value as DrawingQuality,
  }));
}

export function getDrawingOutputFormatOptions(
  t: DrawingTranslate,
): Array<{ label: string; value: DrawingOutputFormat }> {
  return getGptImageOutputFormatOptions(t).map(({ fallbackLabel, value }) => ({
    label: fallbackLabel,
    value: value as DrawingOutputFormat,
  }));
}

export function isDrawingTransparentBackgroundSupported(modelId?: DrawingModelId): boolean {
  return isGptImageTransparentBackgroundSupported(modelId);
}

export function isDrawingOutputCompressionSupported(
  modelId: DrawingModelId,
  outputFormat: DrawingOutputFormat,
): boolean {
  return isGptImageOutputCompressionSupported(modelId, outputFormat);
}

export function getDrawingBackgroundOptions(
  t: DrawingTranslate,
  modelId?: DrawingModelId,
): Array<{ label: string; value: DrawingBackground }> {
  return getGptImageBackgroundOptions(t, modelId).map(({ fallbackLabel, value }) => ({
    label: fallbackLabel,
    value: value as DrawingBackground,
  }));
}

export function getDrawingReferenceImageModeOptions(
  t: DrawingTranslate,
): Array<{ label: string; value: DrawingReferenceImageMode }> {
  return getGptImageReferenceImageModeOptions(t).map(({ fallbackLabel, value }) => ({
    label: fallbackLabel,
    value: value as DrawingReferenceImageMode,
  }));
}

export function getDrawingReferenceImageFormatOptions(
  t: DrawingTranslate,
): Array<{ label: string; value: DrawingReferenceImageFormat }> {
  return getGptImageReferenceImageFormatOptions(t).map(({ fallbackLabel, value }) => ({
    label: fallbackLabel,
    value: value as DrawingReferenceImageFormat,
  }));
}

export function normalizeDrawingSettingsByConfig(settings: DrawingSettings): DrawingSettings {
  const config = getDrawingParamConfig(settings.modelId);
  return config.normalizeSettings ? config.normalizeSettings(settings) : settings;
}

export function describeDrawingSize(size: string) {
  if (size === 'auto') return 'auto';
  const [w, h] = size.split('x').map(Number);
  if (!w || !h) return size;
  const ratio = w === h ? '1:1' : w > h ? '16:9' : '9:16';
  const label = Math.max(w, h) >= 2048 ? '2K' : '1K';
  return `${ratio} | ${label}`;
}
