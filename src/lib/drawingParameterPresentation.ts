export type DrawingParameterTranslate = (key: string, fallback: string) => string;

interface LocalizedLabel {
  key: string;
  fallback: string;
}

const PARAMETER_LABELS: Record<string, LocalizedLabel> = {
  aspect_ratio: { key: 'drawing.aspectRatio', fallback: 'Aspect ratio' },
  background: { key: 'drawing.background', fallback: 'Background' },
  n: { key: 'drawing.batchCount', fallback: 'Batch count' },
  output_format: { key: 'drawing.outputFormat', fallback: 'Output format' },
  quality: { key: 'drawing.quality', fallback: 'Quality' },
  reference_image_format: {
    key: 'drawing.referenceImageFormat',
    fallback: 'Reference image format',
  },
  reference_image_mode: {
    key: 'drawing.referenceImageMode',
    fallback: 'Reference image transport',
  },
  size: { key: 'drawing.size', fallback: 'Size' },
};

const PARAMETER_KEY_ALIASES: Record<string, string> = {
  batch_size: 'n',
  image_size: 'size',
  outputFormat: 'output_format',
  referenceImageFormat: 'reference_image_format',
  referenceImageMode: 'reference_image_mode',
};

const FORMAT_LABELS: Record<string, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WEBP',
};

const OPTION_LABELS: Record<string, Record<string, LocalizedLabel>> = {
  background: {
    opaque: { key: 'drawing.option.background.opaque', fallback: 'Opaque' },
    transparent: {
      key: 'drawing.option.background.transparent',
      fallback: 'Transparent',
    },
  },
  quality: {
    hd: { key: 'drawing.option.quality.hd', fallback: 'HD' },
    high: { key: 'drawing.option.quality.high', fallback: 'High' },
    low: { key: 'drawing.option.quality.low', fallback: 'Low' },
    medium: { key: 'drawing.option.quality.medium', fallback: 'Medium' },
    standard: { key: 'drawing.option.quality.standard', fallback: 'Standard' },
  },
  reference_image_format: {
    object: { key: 'drawing.option.referenceImageFormat.object', fallback: 'Object array' },
    string: { key: 'drawing.option.referenceImageFormat.string', fallback: 'String array' },
  },
  reference_image_mode: {
    base64: { key: 'drawing.option.referenceImageMode.base64', fallback: 'Base64' },
    multipart: {
      key: 'drawing.option.referenceImageMode.multipart',
      fallback: 'Multipart',
    },
  },
};

function canonicalParameterKey(parameterKey: string): string {
  return PARAMETER_KEY_ALIASES[parameterKey] ?? parameterKey;
}

export function getDrawingParameterLabel(
  parameterKey: string,
  t: DrawingParameterTranslate,
): string {
  const label = PARAMETER_LABELS[canonicalParameterKey(parameterKey)];
  return label ? t(label.key, label.fallback) : parameterKey;
}

export function getDrawingParameterValueLabel(
  parameterKey: string,
  value: unknown,
  t: DrawingParameterTranslate,
): string {
  const canonicalKey = canonicalParameterKey(parameterKey);
  const stringValue = String(value);
  if (stringValue === 'auto') return t('drawing.option.auto', 'Auto');
  if (canonicalKey === 'output_format' && FORMAT_LABELS[stringValue]) {
    return FORMAT_LABELS[stringValue];
  }
  const localized = OPTION_LABELS[canonicalKey]?.[stringValue];
  if (localized) return t(localized.key, localized.fallback);
  return stringValue;
}

export function getDrawingParameterOption(
  parameterKey: string,
  value: unknown,
  t: DrawingParameterTranslate,
) {
  return {
    label: getDrawingParameterValueLabel(parameterKey, value, t),
    value,
  };
}
