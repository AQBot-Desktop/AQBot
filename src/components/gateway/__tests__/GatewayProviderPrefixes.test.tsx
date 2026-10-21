import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProviderConfig } from '@/types';
import { GatewayProviderPrefixes, validateGatewayPrefix } from '../GatewayProviderPrefixes';

const invokeMock = vi.fn();
const updateProvider = vi.fn();
const ensureProvidersLoaded = vi.fn();
let providers: ProviderConfig[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => (options?.name ? `${key}:${options.name}` : key),
  }),
}));

vi.mock('@/lib/invoke', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: (selector: (state: unknown) => unknown) => selector({
    providers,
    ensureProvidersLoaded,
    updateProvider,
  }),
}));

function makeProvider(id: string, name: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    name,
    provider_type: 'openai',
    api_host: '',
    api_path: null,
    aws_region: null,
    enabled: true,
    models: [],
    keys: [],
    proxy_config: null,
    custom_headers: null,
    icon: null,
    builtin_id: null,
    gateway_prefix: null,
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('validateGatewayPrefix', () => {
  const list = [makeProvider('p1', 'A', { gateway_prefix: 'ds' }), makeProvider('p2', 'B')];

  it('accepts blank and well-formed prefixes', () => {
    expect(validateGatewayPrefix('', 'p2', list)).toBeNull();
    expect(validateGatewayPrefix('my-ds2', 'p2', list)).toBeNull();
    expect(validateGatewayPrefix('ds', 'p1', list)).toBeNull();
  });

  it('rejects malformed and duplicate prefixes', () => {
    for (const bad of ['a/b', '-ds', 'ds--x', 'DS', 'x'.repeat(33)]) {
      expect(validateGatewayPrefix(bad, 'p2', list)).toBe('invalid');
    }
    expect(validateGatewayPrefix('ds', 'p2', list)).toBe('duplicate');
  });
});

describe('GatewayProviderPrefixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers = [
      makeProvider('p1', 'DeepSeek'),
      makeProvider('p2', 'Disabled', { enabled: false }),
    ];
    invokeMock.mockResolvedValue({ p1: 'deepseek' });
    updateProvider.mockResolvedValue(undefined);
  });

  it('lists enabled providers with their effective prefix as placeholder', async () => {
    render(<GatewayProviderPrefixes />);

    const input = screen.getByLabelText('gateway.providerPrefixInputLabel:DeepSeek');
    await waitFor(() => expect(input).toHaveAttribute('placeholder', 'deepseek'));
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('get_gateway_provider_prefixes');
  });

  it('saves a normalized custom prefix on enter', async () => {
    render(<GatewayProviderPrefixes />);

    const input = screen.getByLabelText('gateway.providerPrefixInputLabel:DeepSeek');
    await userEvent.type(input, ' DS {enter}');

    expect(updateProvider).toHaveBeenCalledWith('p1', { gateway_prefix: 'ds' });
  });

  it('does not save an invalid prefix', async () => {
    render(<GatewayProviderPrefixes />);

    const input = screen.getByLabelText('gateway.providerPrefixInputLabel:DeepSeek');
    await userEvent.type(input, 'a/b{enter}');

    expect(updateProvider).not.toHaveBeenCalled();
  });
});
