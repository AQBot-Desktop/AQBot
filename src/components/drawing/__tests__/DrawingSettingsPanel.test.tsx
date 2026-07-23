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
        'drawing.aspectRatio': '宽高比',
      };
      if (labels[key]) return labels[key];
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions;
      const template = String(fallbackOrOptions?.defaultValue ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(fallbackOrOptions?.[name] ?? ''),
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
  enabled: true,
  models: [{
    provider_id: 'provider-1',
    model_id: 'gpt-image-2',
    name: 'gpt-image-2',
    model_type: 'Image',
    capabilities: [],
    max_tokens: null,
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
      parameters: { aspect_ratio: '16:9' },
      parametersByTarget: {
        'provider-1::gpt-image-2': { aspect_ratio: '16:9' },
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
});
