import type {
  DrawingBackground,
  DrawingModelId,
  DrawingOutputFormat,
  DrawingQuality,
  DrawingReferenceImageFormat,
  DrawingReferenceImageMode,
  DrawingSettings,
} from '@/types';
import type {
  DrawingParamConfig,
  DrawingParamField,
  DrawingParamOption,
  DrawingTranslate,
} from './types';

export const GPT_IMAGE_MODELS: Array<{ id: DrawingModelId; name: string }> = [
  { id: 'gpt-image-2', name: 'gpt-image-2' },
  { id: 'gpt-image-1.5', name: 'gpt-image-1.5' },
  { id: 'gpt-image-1', name: 'gpt-image-1' },
  { id: 'gpt-image-1-mini', name: 'gpt-image-1-mini' },
];

export const GPT_IMAGE_SIZE_OPTIONS = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
];

export const GPT_IMAGE_REFERENCE_IMAGE_MODES: DrawingReferenceImageMode[] = ['multipart', 'base64'];

const QUALITY_OPTIONS: Array<DrawingParamOption & { value: DrawingQuality }> = [
  { labelKey: 'drawing.option.auto', fallbackLabel: 'Auto', value: 'auto' },
  { labelKey: 'drawing.option.quality.low', fallbackLabel: 'Low', value: 'low' },
  { labelKey: 'drawing.option.quality.medium', fallbackLabel: 'Medium', value: 'medium' },
  { labelKey: 'drawing.option.quality.high', fallbackLabel: 'High', value: 'high' },
];

const OUTPUT_FORMAT_OPTIONS: Array<DrawingParamOption & { value: DrawingOutputFormat }> = [
  { labelKey: 'drawing.option.outputFormat.png', fallbackLabel: 'PNG', value: 'png' },
  { labelKey: 'drawing.option.outputFormat.jpeg', fallbackLabel: 'JPEG', value: 'jpeg' },
  { labelKey: 'drawing.option.outputFormat.webp', fallbackLabel: 'WEBP', value: 'webp' },
];

const BACKGROUND_OPTIONS: Array<DrawingParamOption & { value: DrawingBackground }> = [
  { labelKey: 'drawing.option.auto', fallbackLabel: 'Auto', value: 'auto' },
  { labelKey: 'drawing.option.background.opaque', fallbackLabel: 'Opaque', value: 'opaque' },
  { labelKey: 'drawing.option.background.transparent', fallbackLabel: 'Transparent', value: 'transparent' },
];

const REFERENCE_IMAGE_MODE_OPTIONS: Array<DrawingParamOption & { value: DrawingReferenceImageMode }> = [
  { labelKey: 'drawing.option.referenceImageMode.multipart', fallbackLabel: 'Multipart', value: 'multipart' },
  { labelKey: 'drawing.option.referenceImageMode.base64', fallbackLabel: 'Base64', value: 'base64' },
];

const REFERENCE_IMAGE_FORMAT_OPTIONS: Array<DrawingParamOption & { value: DrawingReferenceImageFormat }> = [
  { labelKey: 'drawing.referenceImageFormat.object', fallbackLabel: '对象数组', value: 'object' },
  { labelKey: 'drawing.referenceImageFormat.string', fallbackLabel: '字符串数组', value: 'string' },
];

export function isGptImageTransparentBackgroundSupported(modelId?: DrawingModelId): boolean {
  return modelId !== 'gpt-image-2';
}

export function isGptImageOutputCompressionSupported(
  modelId: DrawingModelId,
  outputFormat: DrawingOutputFormat,
): boolean {
  return modelId !== 'gpt-image-2' && (outputFormat === 'jpeg' || outputFormat === 'webp');
}

export function getGptImageSizeOptions(t: DrawingTranslate): DrawingParamOption[] {
  return GPT_IMAGE_SIZE_OPTIONS.map((size) => ({
    fallbackLabel: size === 'auto' ? t('drawing.option.auto', 'Auto') : size,
    value: size,
  }));
}

export function getGptImageQualityOptions(t: DrawingTranslate): DrawingParamOption[] {
  return localizeOptions(QUALITY_OPTIONS, t);
}

export function getGptImageOutputFormatOptions(t: DrawingTranslate): DrawingParamOption[] {
  return localizeOptions(OUTPUT_FORMAT_OPTIONS, t);
}

export function getGptImageBackgroundOptions(
  t: DrawingTranslate,
  modelId?: DrawingModelId,
): DrawingParamOption[] {
  const options = isGptImageTransparentBackgroundSupported(modelId)
    ? BACKGROUND_OPTIONS
    : BACKGROUND_OPTIONS.filter((option) => option.value !== 'transparent');
  return localizeOptions(options, t);
}

export function getGptImageReferenceImageModeOptions(t: DrawingTranslate): DrawingParamOption[] {
  return localizeOptions(REFERENCE_IMAGE_MODE_OPTIONS, t);
}

export function getGptImageReferenceImageFormatOptions(t: DrawingTranslate): DrawingParamOption[] {
  return localizeOptions(REFERENCE_IMAGE_FORMAT_OPTIONS, t);
}

function localizeOptions(
  options: readonly DrawingParamOption[],
  t: DrawingTranslate,
): DrawingParamOption[] {
  return options.map((option) => ({
    ...option,
    fallbackLabel: option.labelKey
      ? t(option.labelKey, option.fallbackLabel)
      : option.fallbackLabel,
  }));
}

function normalizeGptImageSettings(settings: DrawingSettings): DrawingSettings {
  return {
    ...settings,
    background: isGptImageTransparentBackgroundSupported(settings.modelId) || settings.background !== 'transparent'
      ? settings.background
      : 'auto',
    outputCompression: isGptImageOutputCompressionSupported(settings.modelId, settings.outputFormat)
      ? settings.outputCompression
      : undefined,
  };
}

const basicFields: DrawingParamField[] = [
  {
    id: 'model',
    key: 'modelId',
    type: 'modelSelect',
    labelKey: 'drawing.model',
    fallbackLabel: '模型',
    normalizeOnChange: (value, context) => {
      const modelId = value as DrawingModelId;
      const nextProviders = context.getProvidersForModel(modelId);
      const providerId = nextProviders.some((provider) => provider.id === context.settings.providerId)
        ? context.settings.providerId
        : nextProviders[0]?.id ?? '';
      return { modelId, providerId };
    },
  },
  {
    id: 'provider',
    key: 'providerId',
    type: 'providerSelect',
    labelKey: 'drawing.provider',
    fallbackLabel: 'Provider',
  },
  {
    id: 'size',
    key: 'size',
    type: 'select',
    labelKey: 'drawing.size',
    fallbackLabel: '尺寸',
    options: (context) => getGptImageSizeOptions(context.t),
  },
  {
    id: 'quality',
    key: 'quality',
    type: 'select',
    labelKey: 'drawing.quality',
    fallbackLabel: '质量',
    options: (context) => getGptImageQualityOptions(context.t),
  },
  {
    id: 'outputFormat',
    key: 'outputFormat',
    type: 'select',
    labelKey: 'drawing.outputFormat',
    fallbackLabel: '输出格式',
    options: (context) => getGptImageOutputFormatOptions(context.t),
  },
  {
    id: 'background',
    key: 'background',
    type: 'select',
    labelKey: 'drawing.background',
    fallbackLabel: '背景',
    options: (context) => getGptImageBackgroundOptions(context.t, context.settings.modelId),
  },
  {
    id: 'batchCount',
    key: 'n',
    type: 'number',
    labelKey: 'drawing.batchCount',
    fallbackLabel: '批量张数',
    min: 1,
    max: 10,
    defaultValue: 1,
  },
  {
    id: 'references',
    type: 'referenceUploader',
    labelKey: 'drawing.references',
    fallbackLabel: '参考图',
  },
];

const advancedFields: DrawingParamField[] = [
  {
    id: 'generationApiPath',
    key: 'generationApiPath',
    type: 'text',
    labelKey: 'drawing.generationApiPath',
    fallbackLabel: '生图接口',
    placeholder: '/images/generations',
  },
  {
    id: 'editApiPath',
    key: 'editApiPath',
    type: 'text',
    labelKey: 'drawing.editApiPath',
    fallbackLabel: '编辑接口',
    placeholder: '/images/edits',
  },
  {
    id: 'referenceImageMode',
    key: 'referenceImageMode',
    type: 'select',
    labelKey: 'drawing.referenceImageMode',
    fallbackLabel: '参考图发送方式',
    options: (context) => getGptImageReferenceImageModeOptions(context.t),
  },
  {
    id: 'referenceImageFormat',
    key: 'referenceImageFormat',
    type: 'select',
    labelKey: 'drawing.referenceImageFormat',
    fallbackLabel: '参考图数据格式',
    options: (context) => getGptImageReferenceImageFormatOptions(context.t),
  },
  {
    id: 'referenceImageParamName',
    key: 'referenceImageParamName',
    type: 'text',
    labelKey: 'drawing.referenceImageParamName',
    fallbackLabel: '第三方图片参数名',
    placeholder: 'images',
    hintKey: 'drawing.referenceImageParamName.hint',
    fallbackHint: '仅用于第三方兼容接口；官方 OpenAI 会自动使用 images/image[]',
  },
  {
    id: 'compression',
    key: 'outputCompression',
    type: 'compression',
    labelKey: 'drawing.compression',
    fallbackLabel: '压缩',
    min: 0,
    max: 100,
    defaultValue: 90,
    visibleWhen: (context) => isGptImageOutputCompressionSupported(
      context.settings.modelId,
      context.settings.outputFormat,
    ),
  },
];

export const GPT_IMAGE_PARAM_CONFIG: DrawingParamConfig = {
  id: 'gpt-image',
  modelIds: GPT_IMAGE_MODELS.map((model) => model.id),
  groups: [
    { id: 'basic', fields: basicFields },
    { id: 'advanced', fields: advancedFields },
  ],
  normalizeSettings: normalizeGptImageSettings,
};
