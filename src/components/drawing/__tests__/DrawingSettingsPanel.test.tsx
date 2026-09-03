import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DrawingSettings, DrawingTarget, ProviderConfig } from '@/types';
import { DrawingSettingsPanel } from '../DrawingSettingsPanel';

vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span>provider-icon</span>,
}));

vi.mock('../DrawingReferenceUploader', () => ({
  DrawingReferenceUploader: () => <div data-testid="drawing-reference-uploader">上传参考图</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallbackOrOptions?: string | Record<string, unknown>,
    ) => {
      const labels: Record<string, string> = {
        'drawing.provider': 'Provider',
        'drawing.model': '模型',
        'drawing.aspectRatio': '宽高比',
        'drawing.resolution': '分辨率',
        'drawing.batchCount': '批量张数',
        'drawing.size': '尺寸',
        'drawing.option.auto': '自动',
        'drawing.warning.retired_model':
          '{{modelId}} 是已退役的预览模型。兼容代理仍可继续请求。',
        'drawing.warning.unknown_image_profile':
          '{{modelId}} 尚未验证图片参数配置，当前仅允许保守的文生图请求。',
        'drawing.warning.using_fallback_profile':
          '{{modelId}} 尚未验证图片参数配置，已使用适配器默认参数预设。',
        'drawing.warning.compatibilityTitle': '兼容提示',
        'drawing.warning.deadline': '截止日期：{{deadline}}',
        'drawing.warning.replacement': '建议模型：{{modelId}}',
        'drawing.warning.separator': '；',
      };
      const template = labels[key]
        ?? (typeof fallbackOrOptions === 'string'
          ? fallbackOrOptions
          : String(fallbackOrOptions?.defaultValue ?? key));
      if (typeof fallbackOrOptions === 'string' || fallbackOrOptions == null) {
        return template;
      }
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(fallbackOrOptions[name] ?? ''),
      );
    },
  }),
}));

const settingsFixture: DrawingSettings = {
  providerId: 'provider-1',
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
};

const providersFixture: ProviderConfig[] = [{
  id: 'provider-1',
  name: 'OpenAI',
  provider_type: 'openai',
  api_host: 'https://api.openai.com',
  api_path: null,
  aws_region: null,
  enabled: true,
  models: [{
    provider_id: 'provider-1',
    model_id: 'gpt-image-2',
    name: 'gpt-image-2',
    model_type: 'Image',
    capabilities: [],
    context_window: null,
    enabled: true,
    param_overrides: null,
  }],
  keys: [],
  proxy_config: null,
  custom_headers: null,
  icon: null,
  builtin_id: null,
  sort_order: 0,
  created_at: 0,
  updated_at: 0,
}];

function imageModel(
  providerId: string,
  modelId: string,
  name = modelId,
): ProviderConfig['models'][number] {
  return {
    ...providersFixture[0].models[0],
    provider_id: providerId,
    model_id: modelId,
    name,
  };
}

function targetFixture(
  providerId: string,
  modelId: string,
  name = modelId,
  providerName = 'OpenAI Responses',
): DrawingTarget {
  return {
    ...xaiTarget,
    provider_id: providerId,
    provider_name: providerName,
    model_id: modelId,
    model_name: name,
  };
}

const xaiTarget: DrawingTarget = {
  provider_id: 'provider-1',
  provider_name: 'OpenAI',
  model_id: 'gpt-image-2',
  model_name: 'gpt-image-2',
  adapter_id: 'xai_images',
  descriptor: {
    adapter_id: 'xai_images',
    operations: ['generate'],
    parameters: [{
      key: 'aspect_ratio',
      kind: 'select',
      default: '1:1',
      options: ['1:1', '16:9'],
      min: null,
      max: null,
    }, {
      key: 'n',
      kind: 'number',
      default: 1,
      options: [],
      min: 1,
      max: 1,
    }],
    max_batch_size: 1,
    max_reference_images: 0,
    warnings: [],
  },
};

describe('DrawingSettingsPanel', () => {
  it('renders provider selection before model selection', () => {
    render(
      <DrawingSettingsPanel
        settings={settingsFixture}
        providers={providersFixture}
        onChange={() => {}}
      />,
    );

    const providerLabel = screen.getByText('Provider');
    const modelLabel = screen.getByText('模型');
    expect(
      providerLabel.compareDocumentPosition(modelLabel)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps basic controls and references outside the advanced section', () => {
    render(
      <DrawingSettingsPanel
        settings={settingsFixture}
        providers={providersFixture}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByText('基础设置')).toBeNull();
    expect(screen.getByText('模型')).toBeDefined();
    expect(screen.getByText('Provider')).toBeDefined();
    expect(screen.getByText('批量张数')).toBeDefined();
    expect(screen.getByTestId('drawing-reference-uploader')).toBeDefined();
    expect(screen.queryByText('生图接口')).toBeNull();

    const referenceLabel = screen.getByText('参考图');
    const advancedHeader = screen.getByText('高级设置');
    expect(
      referenceLabel.compareDocumentPosition(advancedHeader)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const advancedButton = screen.getByRole('button', { name: '高级设置' });
    expect(advancedButton).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(advancedButton);

    expect(advancedButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('生图接口')).toBeDefined();
    expect(screen.queryByText('压缩')).toBeNull();
  });

  it('renders descriptor labels and preserves protocol values on change', async () => {
    const onChange = vi.fn();
    render(
      <DrawingSettingsPanel
        settings={settingsFixture}
        providers={providersFixture}
        targets={[xaiTarget]}
        onChange={onChange}
      />,
    );

    const label = screen.getByText('宽高比');
    const formItem = label.closest('.ant-form-item');
    expect(formItem).not.toBeNull();
    fireEvent.mouseDown(within(formItem as HTMLElement).getByRole('combobox'));
    await userEvent.click(await screen.findByText('16:9', {
      selector: '.ant-select-item-option-content',
    }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      parameters: expect.objectContaining({
        aspect_ratio: '16:9',
        size: 'auto',
        quality: 'auto',
        output_format: 'png',
        background: 'auto',
        n: 1,
      }),
      parametersByTarget: {
        'provider-1::gpt-image-2': expect.objectContaining({
          aspect_ratio: '16:9',
          size: 'auto',
          quality: 'auto',
          output_format: 'png',
          background: 'auto',
          n: 1,
        }),
      },
    }));
    expect(screen.queryByTestId('drawing-reference-uploader')).toBeNull();
    expect(screen.queryByText('质量')).toBeNull();
  });

  it('shows a compact warning action when the backend has no usable targets', () => {
    render(
      <DrawingSettingsPanel
        settings={settingsFixture}
        providers={providersFixture}
        targets={[]}
        unavailableReasons={['OpenAI: provider is disabled']}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByText('没有可用的图片模型')).toBeNull();
    expect(screen.getByText(
      '暂无任何配置绘画模型类型的服务商，请前往服务商设置页进行配置',
    )).toBeDefined();
    expect(screen.queryByText('OpenAI: provider is disabled')).toBeNull();
    const settingsButton = screen.getByRole('button', { name: '打开服务商设置' });
    expect(settingsButton).toHaveClass('ant-btn-color-orange', 'ant-btn-variant-filled');
    const alert = settingsButton.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveStyle({ marginBottom: '16px' });
    expect(settingsButton.closest('.ant-alert-description')).not.toBeNull();
    expect(document.querySelector('.ant-alert-icon')).toBeNull();
  });

  it('isolates common parameters when switching to a target with different capabilities', async () => {
    const onChange = vi.fn();
    const providers = [{
      ...providersFixture[0],
      models: [
        providersFixture[0].models[0],
        {
          ...providersFixture[0].models[0],
          model_id: 'gemini-3.1-flash-image',
          name: 'Gemini 3.1 Flash Image',
        },
      ],
    }];
    const openAiTarget: DrawingTarget = {
      ...xaiTarget,
      adapter_id: 'openai_images',
      descriptor: {
        adapter_id: 'openai_images',
        operations: ['generate'],
        parameters: [{
          key: 'output_format',
          kind: 'select',
          default: 'png',
          options: ['png', 'jpeg', 'webp'],
          min: null,
          max: null,
        }],
        max_batch_size: 1,
        max_reference_images: 0,
        warnings: [],
      },
    };
    const geminiTarget: DrawingTarget = {
      provider_id: 'provider-1',
      provider_name: 'OpenAI',
      model_id: 'gemini-3.1-flash-image',
      model_name: 'Gemini 3.1 Flash Image',
      adapter_id: 'gemini_images',
      descriptor: {
        adapter_id: 'gemini_images',
        operations: ['generate'],
        parameters: [{
          key: 'aspect_ratio',
          kind: 'select',
          default: '1:1',
          options: ['1:1', '16:9'],
          min: null,
          max: null,
        }],
        max_batch_size: 1,
        max_reference_images: 0,
        warnings: [],
      },
    };

    render(
      <DrawingSettingsPanel
        settings={{ ...settingsFixture, outputFormat: 'webp' }}
        providers={providers}
        targets={[openAiTarget, geminiTarget]}
        onChange={onChange}
      />,
    );

    const modelItem = screen.getByText('模型').closest('.ant-form-item');
    fireEvent.mouseDown(within(modelItem as HTMLElement).getByRole('combobox'));
    await userEvent.click(await screen.findByText('Gemini 3.1 Flash Image', {
      selector: '.ant-select-item-option-content',
    }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      modelId: 'gemini-3.1-flash-image',
      outputFormat: 'png',
      parametersByTarget: expect.objectContaining({
        'provider-1::gpt-image-2': expect.objectContaining({
          output_format: 'webp',
        }),
        'provider-1::gemini-3.1-flash-image': expect.objectContaining({
          output_format: 'png',
          n: 1,
        }),
      }),
    }));
  });

  it('shows localized model lifecycle warnings without removing the controls', () => {
    render(
      <DrawingSettingsPanel
        settings={settingsFixture}
        providers={providersFixture}
        targets={[{
          ...xaiTarget,
          descriptor: {
            ...xaiTarget.descriptor,
            warnings: [{
              code: 'retired_model',
              message: 'This preview model is retired.',
              deadline: '2026-01-15',
              replacement_model_id: 'gemini-3.1-flash-image',
            }],
          },
        }]}
        onChange={() => {}}
      />,
    );

    expect(
      screen.getByText('gpt-image-2 是已退役的预览模型。兼容代理仍可继续请求。'),
    ).toBeDefined();
    expect(screen.getByText(/截止日期：2026-01-15/)).toBeDefined();
    expect(screen.getByText(/建议模型：gemini-3.1-flash-image/)).toBeDefined();
    expect(screen.getByText('模型')).toBeDefined();
  });

  it('shows fallback profile notices as a compact model-label warning with popover detail', async () => {
    render(
      <DrawingSettingsPanel
        settings={{ ...settingsFixture, modelId: 'vendor-image-model' }}
        providers={providersFixture}
        targets={[{
          ...xaiTarget,
          adapter_id: 'openai_images',
          model_id: 'vendor-image-model',
          model_name: 'vendor-image-model',
          descriptor: {
            ...xaiTarget.descriptor,
            adapter_id: 'openai_images',
            warnings: [{
              code: 'using_fallback_profile',
              message:
                'vendor-image-model has no verified image parameter profile; using fallback parameter preset `openai_gpt_image_2`.',
              deadline: null,
              replacement_model_id: null,
            }],
          },
        }]}
        onChange={() => {}}
      />,
    );

    // No full-width alert body by default.
    expect(
      screen.queryByText(
        'vendor-image-model 尚未验证图片参数配置，已使用适配器默认参数预设。',
      ),
    ).toBeNull();

    const modelItem = screen.getByText('模型').closest('.ant-form-item');
    const notice = within(modelItem as HTMLElement).getByRole('button', {
      name: '兼容提示',
    });
    // Title is visible on the chip button itself (not only in popover).
    expect(within(notice).getByText('兼容提示')).toBeDefined();

    await userEvent.hover(notice);
    expect(
      await screen.findByText(
        'vendor-image-model 尚未验证图片参数配置，已使用适配器默认参数预设。',
      ),
    ).toBeDefined();
  });

  it('shows verified xAI imagine parameters without unknown-profile warning', () => {
    render(
      <DrawingSettingsPanel
        settings={{ ...settingsFixture, modelId: 'grok-image' }}
        providers={providersFixture}
        targets={[{
          ...xaiTarget,
          model_id: 'grok-image',
          model_name: 'grok-image',
          descriptor: {
            adapter_id: 'xai_images',
            operations: ['generate', 'edit'],
            parameters: [
              {
                key: 'aspect_ratio',
                kind: 'select',
                default: 'auto',
                options: ['auto', '1:1', '16:9'],
                min: null,
                max: null,
              },
              {
                key: 'resolution',
                kind: 'select',
                default: '1k',
                options: ['1k', '2k'],
                min: null,
                max: null,
              },
              {
                key: 'n',
                kind: 'number',
                default: 1,
                options: [],
                min: 1,
                max: 10,
              },
            ],
            max_batch_size: 10,
            max_reference_images: 3,
            warnings: [],
          },
        }]}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByText(/尚未验证图片参数配置/)).toBeNull();
    expect(screen.getByText('宽高比')).toBeDefined();
    expect(screen.getByText('分辨率')).toBeDefined();
    expect(screen.getByText('批量张数')).toBeDefined();
    expect(screen.getByTestId('drawing-reference-uploader')).toBeDefined();
  });

  it('allows a descriptor string size while keeping official suggestions', () => {
    const onChange = vi.fn();
    const sizeTarget: DrawingTarget = {
      ...xaiTarget,
      descriptor: {
        ...xaiTarget.descriptor,
        parameters: [{
          key: 'size',
          kind: 'string',
          default: 'auto',
          options: ['auto', '1024x1024', '2048x2048'],
          min: null,
          max: null,
        }],
      },
    };
    render(
      <DrawingSettingsPanel
        settings={settingsFixture}
        providers={providersFixture}
        targets={[sizeTarget]}
        onChange={onChange}
      />,
    );

    const sizeItem = screen.getByText('尺寸').closest('.ant-form-item');
    const input = within(sizeItem as HTMLElement).getByRole('combobox');
    // Protocol value `auto` is shown with localized label.
    expect((input as HTMLInputElement).value).toBe('自动');

    fireEvent.change(input, { target: { value: '2048x1024' } });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      size: '2048x1024',
      parametersByTarget: {
        'provider-1::gpt-image-2': expect.objectContaining({
          size: '2048x1024',
        }),
      },
    }));
  });

  it('maps localized size option labels back to protocol values', () => {
    const onChange = vi.fn();
    const sizeTarget: DrawingTarget = {
      ...xaiTarget,
      descriptor: {
        ...xaiTarget.descriptor,
        parameters: [{
          key: 'size',
          kind: 'string',
          default: 'auto',
          options: ['auto', '1024x1024'],
          min: null,
          max: null,
        }],
      },
    };
    render(
      <DrawingSettingsPanel
        settings={{ ...settingsFixture, size: '1024x1024' }}
        providers={providersFixture}
        targets={[sizeTarget]}
        onChange={onChange}
      />,
    );

    const sizeItem = screen.getByText('尺寸').closest('.ant-form-item');
    const input = within(sizeItem as HTMLElement).getByRole('combobox');
    fireEvent.change(input, { target: { value: '自动' } });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      size: 'auto',
    }));
  });

  it('keeps an openai_responses provider when switching to another model on the same provider', async () => {
    const onChange = vi.fn();
    const provider: ProviderConfig = {
      ...providersFixture[0],
      id: 'responses-1',
      name: 'OpenAI Responses',
      provider_type: 'openai_responses',
      models: [
        imageModel('responses-1', 'gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'),
        imageModel('responses-1', 'gpt-image-2'),
      ],
    };

    render(
      <DrawingSettingsPanel
        settings={{
          ...settingsFixture,
          providerId: 'responses-1',
          modelId: 'gemini-3.1-flash-image',
        }}
        providers={[provider]}
        targets={[
          targetFixture('responses-1', 'gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'),
          targetFixture('responses-1', 'gpt-image-2'),
        ]}
        onChange={onChange}
      />,
    );

    const modelItem = screen.getByText('模型').closest('.ant-form-item');
    fireEvent.mouseDown(within(modelItem as HTMLElement).getByRole('combobox'));
    await userEvent.click(await screen.findByText('gpt-image-2', {
      selector: '.ant-select-item-option-content',
    }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      providerId: 'responses-1',
      modelId: 'gpt-image-2',
    }));
  });

  it('does not switch to another provider that also offers the selected model', async () => {
    const onChange = vi.fn();
    const responsesProvider: ProviderConfig = {
      ...providersFixture[0],
      id: 'responses-1',
      name: 'OpenAI Responses',
      provider_type: 'openai_responses',
      models: [
        imageModel('responses-1', 'gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'),
        imageModel('responses-1', 'gpt-image-2'),
      ],
    };
    const openaiProvider: ProviderConfig = {
      ...providersFixture[0],
      id: 'openai-1',
      name: 'OpenAI',
      models: [imageModel('openai-1', 'gpt-image-2')],
    };

    render(
      <DrawingSettingsPanel
        settings={{
          ...settingsFixture,
          providerId: 'responses-1',
          modelId: 'gemini-3.1-flash-image',
        }}
        providers={[responsesProvider, openaiProvider]}
        targets={[
          targetFixture('responses-1', 'gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'),
          targetFixture('responses-1', 'gpt-image-2'),
          targetFixture('openai-1', 'gpt-image-2', 'gpt-image-2', 'OpenAI'),
        ]}
        onChange={onChange}
      />,
    );

    const modelItem = screen.getByText('模型').closest('.ant-form-item');
    fireEvent.mouseDown(within(modelItem as HTMLElement).getByRole('combobox'));
    await userEvent.click(await screen.findByText('gpt-image-2', {
      selector: '.ant-select-item-option-content',
    }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      providerId: 'responses-1',
      modelId: 'gpt-image-2',
    }));
  });
});
