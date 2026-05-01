import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@/types';
import { RerankModelSelect } from '../RerankModelSelect';

const mocks = vi.hoisted(() => ({
  fetchProviders: vi.fn(),
}));

let providers: ProviderConfig[] = [];

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'Jina',
    provider_type: 'jina',
    api_host: 'https://api.jina.ai',
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

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => <span data-testid="model-icon" />,
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
  useProviderStore: (selector: (state: { providers: ProviderConfig[]; fetchProviders: () => Promise<void> }) => unknown) =>
    selector({
      providers,
      fetchProviders: mocks.fetchProviders,
    }),
}));

vi.mock('../ModelSelect', () => ({
  parseModelValue: (value: string) => {
    const [providerId, modelId] = value.split('::');
    return providerId && modelId ? { providerId, modelId } : null;
  },
  useProviderNameMap: () => new Map(providers.map((provider) => [provider.id, provider.name])),
}));

describe('RerankModelSelect', () => {
  beforeEach(() => {
    providers = [];
    mocks.fetchProviders.mockReset();
    mocks.fetchProviders.mockResolvedValue(undefined);
  });

  it('shows enabled rerank models and hides chat models', () => {
    providers = [
      makeProvider({
        models: [
          {
            provider_id: 'provider-1',
            model_id: 'jina-reranker-v3',
            name: 'Jina Reranker v3',
            group_name: null,
            model_type: 'Rerank',
            capabilities: [],
            max_tokens: null,
            enabled: true,
            param_overrides: null,
          },
          {
            provider_id: 'provider-1',
            model_id: 'jina-embeddings-v4',
            name: 'Jina Embeddings v4',
            group_name: null,
            model_type: 'Embedding',
            capabilities: [],
            max_tokens: null,
            enabled: true,
            param_overrides: null,
          },
        ],
      }),
    ];

    render(<RerankModelSelect onChange={vi.fn()} />);

    expect(screen.getByText('Jina Reranker v3')).toBeInTheDocument();
    expect(screen.queryByText('Jina Embeddings v4')).not.toBeInTheDocument();
  });

  it('loads providers when mounted with an empty provider store', async () => {
    render(<RerankModelSelect onChange={vi.fn()} />);

    await waitFor(() => {
      expect(mocks.fetchProviders).toHaveBeenCalledTimes(1);
    });
  });
});
