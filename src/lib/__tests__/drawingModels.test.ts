import { describe, expect, it } from 'vitest';
import type { DrawingSettings, ProviderConfig } from '@/types';
import type { DrawingParamRenderContext } from '@/components/drawing/params/types';
import {
  getDrawingBackgroundOptions,
  getDrawingModelOptions,
  getDrawingParamConfig,
  getDrawingOutputFormatOptions,
  getDrawingProvidersForModel,
  getDrawingQualityOptions,
  getDrawingReferenceImageFormatOptions,
  getDrawingReferenceImageModeOptions,
  getDrawingSizeOptions,
  isDrawingOutputCompressionSupported,
  normalizeDrawingSettingsByConfig,
} from '../drawingModels';

function providerFixture(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'provider',
    name: 'Provider',
    provider_type: 'openai',
    api_host: 'https://api.openai.com',
    api_path: null,
    enabled: true,
    models: [],
    keys: [],
    proxy_config: null,
    custom_headers: null,
    icon: null,
    builtin_id: null,
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function settingsFixture(overrides: Partial<DrawingSettings> = {}): DrawingSettings {
  return {
    providerId: 'provider',
    modelId: 'gpt-image-2',
    size: 'auto',
    quality: 'auto',
    outputFormat: 'png',
    background: 'auto',
    outputCompression: undefined,
    referenceImageMode: 'base64',
    referenceImageFormat: 'object',
    referenceImageParamName: 'images',
    n: 1,
    generationApiPath: '/images/generations',
    editApiPath: '/images/edits',
    ...overrides,
  };
}

function renderContext(settings: DrawingSettings): DrawingParamRenderContext {
  return {
    settings,
    providers: [],
    modelOptions: [],
    providerOptions: [],
    t: (_key, fallback) => fallback,
    getProvidersForModel: () => [],
  };
}

describe('drawing model/provider filtering', () => {
  it('always exposes the built-in drawing model list', () => {
    expect(getDrawingModelOptions([]).map((item) => item.value)).toEqual([
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-1',
      'gpt-image-1-mini',
    ]);
  });

  it('only exposes providers that have the selected enabled Image model', () => {
    const providers: ProviderConfig[] = [
      providerFixture({
        id: 'openai-1',
        name: 'OpenAI A',
        models: [
          {
            provider_id: 'openai-1',
            model_id: 'gpt-image-2',
            name: 'gpt-image-2',
            group_name: 'gpt-image',
            model_type: 'Image',
            capabilities: [],
            max_tokens: null,
            enabled: true,
            param_overrides: null,
          },
        ],
      }),
      providerFixture({
        id: 'chat-only',
        name: 'Chat Only',
        models: [
          {
            provider_id: 'chat-only',
            model_id: 'gpt-image-2',
            name: 'gpt-image-2',
            group_name: 'gpt-image',
            model_type: 'Chat',
            capabilities: ['TextChat'],
            max_tokens: null,
            enabled: true,
            param_overrides: null,
          },
        ],
      }),
      providerFixture({
        id: 'disabled-provider',
        name: 'Disabled',
        enabled: false,
        models: [
          {
            provider_id: 'disabled-provider',
            model_id: 'gpt-image-2',
            name: 'gpt-image-2',
            group_name: 'gpt-image',
            model_type: 'Image',
            capabilities: [],
            max_tokens: null,
            enabled: true,
            param_overrides: null,
          },
        ],
      }),
    ];

    expect(getDrawingModelOptions(providers).map((item) => item.value)).toEqual([
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-1',
      'gpt-image-1-mini',
    ]);
    expect(getDrawingProvidersForModel(providers, 'gpt-image-2').map((item) => item.id)).toEqual(['openai-1']);
  });

  it('returns localized drawing parameter options', () => {
    const labels: Record<string, string> = {
      'drawing.option.auto': '自动',
      'drawing.option.quality.low': '低',
      'drawing.option.quality.medium': '中',
      'drawing.option.quality.high': '高',
      'drawing.option.background.opaque': '不透明',
      'drawing.option.background.transparent': '透明',
    };
    const t = (key: string, fallback: string) => labels[key] ?? fallback;

    expect(getDrawingSizeOptions(t)[0]).toEqual({ label: '自动', value: 'auto' });
    expect(getDrawingQualityOptions(t).map((item) => item.label)).toEqual(['自动', '低', '中', '高']);
    expect(getDrawingOutputFormatOptions(t).map((item) => item.label)).toEqual(['PNG', 'JPEG', 'WEBP']);
    expect(getDrawingBackgroundOptions(t).map((item) => item.label)).toEqual(['自动', '不透明', '透明']);
    expect(getDrawingReferenceImageModeOptions(t)).toEqual([
      { label: 'Multipart', value: 'multipart' },
      { label: 'Base64', value: 'base64' },
    ]);
    expect(getDrawingReferenceImageFormatOptions(t)).toEqual([
      { label: '对象数组', value: 'object' },
      { label: '字符串数组', value: 'string' },
    ]);
  });

  it('hides unsupported gpt-image-2 parameters instead of disabling them', () => {
    const labels: Record<string, string> = {
      'drawing.option.auto': '自动',
      'drawing.option.background.opaque': '不透明',
      'drawing.option.background.transparent': '透明',
    };
    const t = (key: string, fallback: string) => labels[key] ?? fallback;

    expect(getDrawingBackgroundOptions(t, 'gpt-image-2').map((item) => item.value)).toEqual([
      'auto',
      'opaque',
    ]);
    expect(getDrawingBackgroundOptions(t, 'gpt-image-1').map((item) => item.value)).toContain('transparent');
    expect(isDrawingOutputCompressionSupported('gpt-image-2', 'jpeg')).toBe(false);
    expect(isDrawingOutputCompressionSupported('gpt-image-1', 'jpeg')).toBe(true);
    expect(isDrawingOutputCompressionSupported('gpt-image-1', 'png')).toBe(false);
  });

  it('returns the GPT-Image parameter schema for GPT-Image models', () => {
    const config = getDrawingParamConfig('gpt-image-2');
    const basic = config.groups.find((group) => group.id === 'basic');
    const advanced = config.groups.find((group) => group.id === 'advanced');

    expect(config.id).toBe('gpt-image');
    expect(basic?.fields.map((field) => field.id)).toEqual([
      'model',
      'provider',
      'size',
      'quality',
      'outputFormat',
      'background',
      'batchCount',
      'references',
    ]);
    expect(advanced?.fields.map((field) => field.id)).toEqual([
      'generationApiPath',
      'editApiPath',
      'referenceImageMode',
      'referenceImageFormat',
      'referenceImageParamName',
      'compression',
    ]);
  });

  it('uses schema visibility for model-specific GPT-Image fields', () => {
    const config = getDrawingParamConfig('gpt-image-2');
    const advanced = config.groups.find((group) => group.id === 'advanced');
    const compression = advanced?.fields.find((field) => field.id === 'compression');

    expect(compression?.visibleWhen?.(renderContext(settingsFixture({
      modelId: 'gpt-image-2',
      outputFormat: 'jpeg',
    })))).toBe(false);
    expect(compression?.visibleWhen?.(renderContext(settingsFixture({
      modelId: 'gpt-image-1',
      outputFormat: 'jpeg',
    })))).toBe(true);
    expect(compression?.visibleWhen?.(renderContext(settingsFixture({
      modelId: 'gpt-image-1',
      outputFormat: 'png',
    })))).toBe(false);
  });

  it('normalizes settings through the selected schema rules', () => {
    expect(normalizeDrawingSettingsByConfig(settingsFixture({
      modelId: 'gpt-image-2',
      outputFormat: 'jpeg',
      background: 'transparent',
      outputCompression: 80,
    }))).toMatchObject({
      background: 'auto',
      outputCompression: undefined,
    });
    expect(normalizeDrawingSettingsByConfig(settingsFixture({
      modelId: 'gpt-image-1',
      outputFormat: 'jpeg',
      background: 'transparent',
      outputCompression: 80,
    }))).toMatchObject({
      background: 'transparent',
      outputCompression: 80,
    });
  });
});
