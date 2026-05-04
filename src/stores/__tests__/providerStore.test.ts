import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

describe('providerStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refetches providers after adding a key to a virtual builtin provider', async () => {
    const { useProviderStore } = await import('../providerStore');
    const materializedProviders = [
      {
        id: 'real-deepseek',
        builtin_id: 'deepseek',
        name: 'DeepSeek',
        keys: [{ id: 'key-1', provider_id: 'real-deepseek' }],
      },
    ];

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'add_provider_key') {
        return { id: 'key-1', provider_id: 'real-deepseek' };
      }
      if (command === 'list_providers') {
        return materializedProviders;
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    useProviderStore.setState({
      providers: [
        {
          id: 'builtin_deepseek',
          builtin_id: 'deepseek',
          name: 'DeepSeek',
          keys: [],
        },
      ] as never,
      loading: false,
      error: null,
    });

    await useProviderStore.getState().addProviderKey('builtin_deepseek', 'sk-test');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'add_provider_key', {
      providerId: 'builtin_deepseek',
      rawKey: 'sk-test',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'list_providers');
    expect(useProviderStore.getState().providers).toEqual(materializedProviders);
  });
});
