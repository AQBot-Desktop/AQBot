import type {
  DrawingBackground,
  DrawingModelId,
  DrawingOutputFormat,
  DrawingQuality,
  ProviderConfig,
} from '@/types';

export const DRAWING_MODELS: Array<{ id: DrawingModelId; name: string }> = [
  { id: 'gpt-image-2', name: 'gpt-image-2' },
  { id: 'gpt-image-1.5', name: 'gpt-image-1.5' },
  { id: 'gpt-image-1', name: 'gpt-image-1' },
  { id: 'gpt-image-1-mini', name: 'gpt-image-1-mini' },
];

export interface DrawingModelOption {
  label: string;
  value: DrawingModelId;
}

type DrawingTranslate = (key: string, fallback: string) => string;

function isOpenAIImagesCompatible(provider: ProviderConfig): boolean {
  return provider.provider_type === 'openai' || provider.provider_type === 'custom';
}

function hasEnabledImageModel(provider: ProviderConfig, modelId: DrawingModelId): boolean {
  return provider.models.some((model) =>
    model.enabled
    && model.model_type === 'Image'
    && model.model_id === modelId,
  );
}

export function getDrawingModelOptions(_providers?: ProviderConfig[]): DrawingModelOption[] {
  return DRAWING_MODELS.map((model) => ({ label: model.name, value: model.id }));
}

export function getDrawingProvidersForModel(
  providers: ProviderConfig[],
  modelId: DrawingModelId,
): ProviderConfig[] {
  return providers.filter((provider) =>
    provider.enabled
    && isOpenAIImagesCompatible(provider)
    && hasEnabledImageModel(provider, modelId),
  );
}

export const DRAWING_SIZE_OPTIONS = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
];

export function getDrawingSizeOptions(t: DrawingTranslate): Array<{ label: string; value: string }> {
  return DRAWING_SIZE_OPTIONS.map((size) => ({
    label: size === 'auto' ? t('drawing.option.auto', 'Auto') : size,
    value: size,
  }));
}

export function getDrawingQualityOptions(
  t: DrawingTranslate,
): Array<{ label: string; value: DrawingQuality }> {
  return [
    { label: t('drawing.option.auto', 'Auto'), value: 'auto' },
    { label: t('drawing.option.quality.low', 'Low'), value: 'low' },
    { label: t('drawing.option.quality.medium', 'Medium'), value: 'medium' },
    { label: t('drawing.option.quality.high', 'High'), value: 'high' },
  ];
}

export function getDrawingOutputFormatOptions(
  t: DrawingTranslate,
): Array<{ label: string; value: DrawingOutputFormat }> {
  return [
    { label: t('drawing.option.outputFormat.png', 'PNG'), value: 'png' },
    { label: t('drawing.option.outputFormat.jpeg', 'JPEG'), value: 'jpeg' },
    { label: t('drawing.option.outputFormat.webp', 'WEBP'), value: 'webp' },
  ];
}

export function isDrawingTransparentBackgroundSupported(modelId?: DrawingModelId): boolean {
  return modelId !== 'gpt-image-2';
}

export function isDrawingOutputCompressionSupported(
  modelId: DrawingModelId,
  outputFormat: DrawingOutputFormat,
): boolean {
  return modelId !== 'gpt-image-2' && (outputFormat === 'jpeg' || outputFormat === 'webp');
}

export function getDrawingBackgroundOptions(
  t: DrawingTranslate,
  modelId?: DrawingModelId,
): Array<{ label: string; value: DrawingBackground }> {
  const options: Array<{ label: string; value: DrawingBackground }> = [
    { label: t('drawing.option.auto', 'Auto'), value: 'auto' },
    { label: t('drawing.option.background.opaque', 'Opaque'), value: 'opaque' },
    { label: t('drawing.option.background.transparent', 'Transparent'), value: 'transparent' },
  ];
  if (!isDrawingTransparentBackgroundSupported(modelId)) {
    return options.filter((option) => option.value !== 'transparent');
  }
  return options;
}

export function describeDrawingSize(size: string) {
  if (size === 'auto') return 'auto';
  const [w, h] = size.split('x').map(Number);
  if (!w || !h) return size;
  const ratio = w === h ? '1:1' : w > h ? '16:9' : '9:16';
  const label = Math.max(w, h) >= 2048 ? '2K' : '1K';
  return `${ratio} | ${label}`;
}
