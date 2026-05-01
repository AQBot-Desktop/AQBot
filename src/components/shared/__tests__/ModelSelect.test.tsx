import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@/types';
import { ModelSelect } from '../ModelSelect';

let providers: ProviderConfig[] = [];

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'OpenAI Compatible',
    provider_type: 'openai',
    api_host: 'https://api.example.com',
    api_path: '/v1/chat/completions',
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

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => <span data-testid="model-icon" />,
}));

vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('antd', () => ({
  Select: ({ options }: { options?: Array<{ title: string; options: Array<{ label: string; value: string }> }> }) => (
    <div>
      {options?.map((group) => (
        <section key={group.title} aria-label={group.title}>
          {group.options.map((option) => (
            <div key={option.value}>{option.label}</div>
          ))}
        </section>
      ))}
    </div>
  ),
  theme: {
    useToken: () => ({ token: { colorTextSecondary: '#666' } }),
  },
}));

vi.mock('@/stores', () => ({
  useProviderStore: (selector: (state: { providers: ProviderConfig[] }) => unknown) =>
    selector({ providers }),
}));

describe('ModelSelect', () => {
  beforeEach(() => {
    providers = [
      makeProvider({
        models: [
          {
            provider_id: 'provider-1',
            model_id: 'gpt-5.4',
            name: 'GPT 5.4',
            group_name: null,
            model_type: 'Chat',
            capabilities: ['TextChat'],
            max_tokens: null,
            enabled: true,
            param_overrides: null,
          },
          {
            provider_id: 'provider-1',
            model_id: 'gpt-image-2',
            name: 'GPT Image 2',
            group_name: null,
            model_type: 'Image',
            capabilities: [],
            max_tokens: null,
            enabled: true,
            param_overrides: null,
          },
        ],
      }),
    ];
  });

  it('keeps the default model list unfiltered', () => {
    render(<ModelSelect onChange={vi.fn()} />);

    expect(screen.getByText('GPT 5.4')).toBeInTheDocument();
    expect(screen.getByText('GPT Image 2')).toBeInTheDocument();
  });

  it('filters options by model type when requested', () => {
    render(<ModelSelect onChange={vi.fn()} modelType="Chat" />);

    expect(screen.getByText('GPT 5.4')).toBeInTheDocument();
    expect(screen.queryByText('GPT Image 2')).not.toBeInTheDocument();
  });
});
