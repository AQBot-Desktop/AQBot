import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@/types';
import { hasKnownModelIcon, SmartModelIcon, SmartProviderIcon } from '../providerIcons';

vi.mock('@lobehub/icons', () => ({
  ModelIcon: ({ model }: { model: string }) => (
    <span data-testid="model-icon" data-model={model} />
  ),
  ProviderIcon: ({ provider }: { provider: string }) => (
    <span data-testid="provider-icon" data-provider={provider} />
  ),
  // Only command-* maps to a known model brand (mirrors Cohere mapping shape)
  modelMappings: [{ keywords: ['command'] }],
  providerMappings: [],
}));

vi.mock('@/components/shared/DynamicLobeIcon', () => ({
  DynamicLobeIcon: ({ iconId }: { iconId: string }) => (
    <span data-testid="dynamic-lobe-icon" data-icon-id={iconId} />
  ),
}));

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-id',
    name: 'Provider',
    provider_type: 'openai',
    api_host: 'https://example.com',
    api_path: null,
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

describe('SmartProviderIcon', () => {
  it('loads the SHUAI API logo from the exact external URL', () => {
    const { container } = render(
      <SmartProviderIcon
        provider={makeProvider({ builtin_id: 'shuaiapi' })}
        size={32}
        type="avatar"
      />,
    );

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'https://api.shuaiapi.com/images/logo.svg');
    expect(image).toHaveAttribute('width', '32');
    expect(image).toHaveAttribute('height', '32');
    expect(image).toHaveStyle({ borderRadius: '50%' });
  });

  it('loads the GPTNB logo from the exact external URL', () => {
    const { container } = render(
      <SmartProviderIcon
        provider={makeProvider({ builtin_id: 'gptnb' })}
        size={32}
        type="avatar"
      />,
    );

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'https://pic.scdn.app/images/2023/06/26/favicon.png');
    expect(image).toHaveAttribute('width', '32');
    expect(image).toHaveAttribute('height', '32');
    expect(image).toHaveStyle({ borderRadius: '50%' });
  });

  it('loads the New API logo from the exact external URL', () => {
    const { container } = render(
      <SmartProviderIcon
        provider={makeProvider({ builtin_id: 'newapi' })}
        size={32}
        type="avatar"
      />,
    );

    const image = container.querySelector('img');
    expect(image).toHaveAttribute(
      'src',
      'https://cdn.jsdelivr.net/gh/QuantumNous/new-api@main/web/public/logo.png',
    );
    expect(image).toHaveAttribute('width', '32');
    expect(image).toHaveAttribute('height', '32');
    expect(image).toHaveStyle({ borderRadius: '50%' });
  });

  it('uses the avatar square radius when requested', () => {
    const { container } = render(
      <SmartProviderIcon
        provider={makeProvider({ builtin_id: 'shuaiapi' })}
        size={40}
        shape="square"
        type="avatar"
      />,
    );

    expect(container.querySelector('img')).toHaveStyle({ borderRadius: '4px' });
  });

  it('keeps an explicitly configured icon ahead of the built-in logo', () => {
    const { container } = render(
      <SmartProviderIcon
        provider={makeProvider({
          builtin_id: 'shuaiapi',
          icon: 'provider:OpenAI',
        })}
      />,
    );

    expect(screen.getByTestId('dynamic-lobe-icon')).toHaveAttribute('data-icon-id', 'OpenAI');
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('does not use the SHUAI API logo for other providers', () => {
    const { container } = render(
      <SmartProviderIcon provider={makeProvider({ builtin_id: 'openai' })} />,
    );

    expect(screen.getByTestId('provider-icon')).toHaveAttribute('data-provider', 'openai');
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('updates when builtin_id changes', () => {
    const initialProvider = makeProvider({ builtin_id: 'openai' });
    const { container, rerender } = render(
      <SmartProviderIcon provider={initialProvider} />,
    );
    expect(screen.getByTestId('provider-icon')).toBeInTheDocument();

    rerender(
      <SmartProviderIcon provider={{ ...initialProvider, builtin_id: 'shuaiapi' }} />,
    );

    expect(screen.queryByTestId('provider-icon')).not.toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://api.shuaiapi.com/images/logo.svg',
    );

    rerender(
      <SmartProviderIcon provider={{ ...initialProvider, builtin_id: 'gptnb' }} />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://pic.scdn.app/images/2023/06/26/favicon.png',
    );

    rerender(
      <SmartProviderIcon provider={{ ...initialProvider, builtin_id: 'newapi' }} />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.jsdelivr.net/gh/QuantumNous/new-api@main/web/public/logo.png',
    );
  });
});

describe('hasKnownModelIcon', () => {
  it('returns true for model ids that match brand keywords', () => {
    expect(hasKnownModelIcon('command-r')).toBe(true);
    expect(hasKnownModelIcon('command-a-03-2025')).toBe(true);
  });

  it('returns false for Cohere/Voyage rerank ids without brand keywords', () => {
    expect(hasKnownModelIcon('rerank-v4.0')).toBe(false);
    expect(hasKnownModelIcon('rerank-2.5')).toBe(false);
    expect(hasKnownModelIcon('')).toBe(false);
  });
});

describe('SmartModelIcon', () => {
  it('uses ModelIcon when the model id has a brand mapping', () => {
    render(<SmartModelIcon modelId="command-r" provider={makeProvider({ provider_type: 'cohere' })} />);
    expect(screen.getByTestId('model-icon')).toHaveAttribute('data-model', 'command-r');
    expect(screen.queryByTestId('provider-icon')).not.toBeInTheDocument();
  });

  it('falls back to the provider icon for unmapped model ids (Cohere/Voyage rerank)', () => {
    render(
      <SmartModelIcon
        modelId="rerank-v4.0"
        provider={makeProvider({ name: 'Cohere', provider_type: 'cohere' })}
      />,
    );
    expect(screen.queryByTestId('model-icon')).not.toBeInTheDocument();
    expect(screen.getByTestId('provider-icon')).toHaveAttribute('data-provider', 'cohere');
  });

  it('falls back to ModelIcon default when no provider is provided', () => {
    render(<SmartModelIcon modelId="rerank-2.5" />);
    expect(screen.getByTestId('model-icon')).toHaveAttribute('data-model', 'rerank-2.5');
  });
});
