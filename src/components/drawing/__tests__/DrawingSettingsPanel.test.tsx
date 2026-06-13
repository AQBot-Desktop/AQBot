import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DrawingSettings, ProviderConfig } from '@/types';
import { DrawingSettingsPanel } from '../DrawingSettingsPanel';

vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span>provider-icon</span>,
}));

vi.mock('../DrawingReferenceUploader', () => ({
  DrawingReferenceUploader: () => <div data-testid="drawing-reference-uploader">上传参考图</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
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

describe('DrawingSettingsPanel', () => {
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
});
