import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@/types';
import { EmbeddingModelSelect } from '../EmbeddingModelSelect';

const mocks = vi.hoisted(() => ({
  ensureProvidersLoaded: vi.fn(),
}));

let providers: ProviderConfig[] = [];

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'OpenAI Compatible',
    provider_type: 'openai',
    api_host: 'https://api.example.com',
    api_path: '/v1/chat/completions',
    aws_region: null,
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores', () => ({
  useProviderStore: (selector: (state: { providers: ProviderConfig[]; ensureProvidersLoaded: () => Promise<void> }) => unknown) =>
    selector({
      providers,
      ensureProvidersLoaded: mocks.ensureProvidersLoaded,
    }),
}));

vi.mock('@/lib/invoke', () => ({
  invoke: async () => ({
    status: 'missing',
    artifactId: 'multilingual-e5-small',
    revision: '761b726',
    path: '/tmp/model.onnx',
    sizeBytes: 1,
    downloadedBytes: 0,
    license: 'MIT',
  }),
  listen: async () => () => {},
}));

vi.mock('../ModelSelect', () => ({
  MODEL_SELECT_CLASS: 'aqbot-model-select',
  parseModelValue: (value: string) => {
    const [providerId, modelId] = value.split('::');
    return providerId && modelId ? { providerId, modelId } : null;
  },
  useProviderNameMap: () => new Map(providers.map((provider) => [provider.id, provider.name])),
  useModelSelectOptionRender: () => (option: { label: string }) => option.label,
  useModelSelectLabelRender: () => (props: { label?: string }) => props.label,
}));

describe('EmbeddingModelSelect', () => {
  beforeEach(() => {
    providers = [];
    mocks.ensureProvidersLoaded.mockReset();
    mocks.ensureProvidersLoaded.mockResolvedValue(undefined);
  });

  it('shows enabled models explicitly marked as embedding even when the model id does not contain embed', () => {
    providers = [
      makeProvider({
        models: [
          {
            provider_id: 'provider-1',
            model_id: 'BAAI/bge-m3',
            name: 'BGE M3',
            group_name: null,
            model_type: 'Embedding',
            capabilities: [],
            context_window: null,
            enabled: true,
            param_overrides: null,
          },
          {
            provider_id: 'provider-1',
            model_id: 'gpt-5.4',
            name: 'GPT 5.4',
            group_name: null,
            model_type: 'Chat',
            capabilities: ['TextChat'],
            context_window: null,
            enabled: true,
            param_overrides: null,
          },
        ],
      }),
    ];

    render(<EmbeddingModelSelect onChange={vi.fn()} />);

    expect(screen.getByText('BGE M3')).toBeInTheDocument();
    expect(screen.queryByText('GPT 5.4')).not.toBeInTheDocument();
  });

  it('loads providers when mounted with an empty provider store', async () => {
    render(<EmbeddingModelSelect onChange={vi.fn()} />);

    await waitFor(() => {
      expect(mocks.ensureProvidersLoaded).toHaveBeenCalledTimes(1);
    });
  });

  it('lists the builtin offline engine even when no remote embedding models exist', () => {
    render(<EmbeddingModelSelect onChange={vi.fn()} />);

    expect(screen.getByLabelText('settings.localRetrieval.builtinGroup')).toBeInTheDocument();
    expect(screen.getByText('settings.localRetrieval.builtinModelId')).toBeInTheDocument();
  });

  it('keeps the builtin hint inside the select column width', () => {
    const { container } = render(
      <EmbeddingModelSelect
        value="builtin::multilingual-e5-small"
        onChange={vi.fn()}
        style={{ width: 280 }}
      />,
    );
    const wrap = container.querySelector('.aqbot-embedding-select');
    expect(wrap).toHaveStyle({ width: '280px' });
    expect(screen.getByText('settings.localRetrieval.notInstalledShort')).toBeInTheDocument();
  });
});
