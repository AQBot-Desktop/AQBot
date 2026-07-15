import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => false,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('core resource loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('conversations', () => {
    it('treats an empty response as loaded across Activity re-entry', async () => {
      invokeMock.mockResolvedValue([]);
      const { useConversationStore } = await import('../conversationStore');

      await useConversationStore.getState().ensureConversationsLoaded();
      await useConversationStore.getState().ensureConversationsLoaded();

      expect(invokeMock.mock.calls.filter(([command]) => command === 'list_conversations')).toHaveLength(1);
      expect(useConversationStore.getState().conversationsMeta.status).toBe('ready');
    });

    it('coalesces concurrent conversation loads', async () => {
      const request = deferred<never[]>();
      invokeMock.mockImplementation((command: string) => {
        if (command === 'list_conversations') return request.promise;
        throw new Error(`Unexpected command: ${command}`);
      });
      const { useConversationStore } = await import('../conversationStore');

      const first = useConversationStore.getState().ensureConversationsLoaded();
      const second = useConversationStore.getState().ensureConversationsLoaded();
      request.resolve([]);
      await Promise.all([first, second]);

      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    it('reloads conversations after explicit invalidation', async () => {
      invokeMock.mockResolvedValue([]);
      const { useConversationStore } = await import('../conversationStore');

      await useConversationStore.getState().ensureConversationsLoaded();
      useConversationStore.getState().invalidateConversations('import');
      await useConversationStore.getState().ensureConversationsLoaded();

      expect(invokeMock.mock.calls.filter(([command]) => command === 'list_conversations')).toHaveLength(2);
      expect(useConversationStore.getState().conversationsMeta.revision).toBe(1);
    });

    it('keeps fetchConversations as an explicit forced refresh', async () => {
      invokeMock.mockResolvedValue([]);
      const { useConversationStore } = await import('../conversationStore');

      await useConversationStore.getState().ensureConversationsLoaded();
      await useConversationStore.getState().fetchConversations();

      expect(invokeMock.mock.calls.filter(([command]) => command === 'list_conversations')).toHaveLength(2);
    });

    it('reloads a stale initial list after a concurrent conversation mutation', async () => {
      const firstList = deferred<any[]>();
      const existing = {
        id: 'existing',
        title: 'Existing',
        model_id: 'model-1',
        provider_id: 'provider-1',
        enabled_mcp_server_ids: [],
        enabled_knowledge_base_ids: [],
        enabled_memory_namespace_ids: [],
      };
      const created = { ...existing, id: 'created', title: 'Created' };
      let listCount = 0;
      invokeMock.mockImplementation((command: string) => {
        if (command === 'list_conversations') {
          listCount += 1;
          return listCount === 1 ? firstList.promise : Promise.resolve([existing, created]);
        }
        if (command === 'create_conversation' || command === 'update_conversation') {
          return Promise.resolve(created);
        }
        throw new Error(`Unexpected command: ${command}`);
      });
      const { useConversationStore } = await import('../conversationStore');

      const initialLoad = useConversationStore.getState().ensureConversationsLoaded();
      await useConversationStore.getState().createConversation(
        'Created',
        'model-1',
        'provider-1',
      );
      firstList.resolve([existing]);
      await initialLoad;

      expect(listCount).toBe(2);
      expect(useConversationStore.getState().conversations.map((item) => item.id)).toEqual([
        'existing',
        'created',
      ]);
      expect(useConversationStore.getState().conversationsMeta.status).toBe('ready');
    });
  });

  describe('providers', () => {
    it('treats an empty response as loaded across Activity re-entry', async () => {
      invokeMock.mockResolvedValue([]);
      const { useProviderStore } = await import('../providerStore');

      await useProviderStore.getState().ensureProvidersLoaded();
      await useProviderStore.getState().ensureProvidersLoaded();

      expect(invokeMock.mock.calls.filter(([command]) => command === 'list_providers')).toHaveLength(1);
      expect(useProviderStore.getState().providersMeta.status).toBe('ready');
    });

    it('coalesces concurrent provider loads', async () => {
      const request = deferred<never[]>();
      invokeMock.mockImplementation((command: string) => {
        if (command === 'list_providers') return request.promise;
        throw new Error(`Unexpected command: ${command}`);
      });
      const { useProviderStore } = await import('../providerStore');

      const first = useProviderStore.getState().ensureProvidersLoaded();
      const second = useProviderStore.getState().ensureProvidersLoaded();
      request.resolve([]);
      await Promise.all([first, second]);

      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    it('reloads providers after explicit invalidation', async () => {
      invokeMock.mockResolvedValue([]);
      const { useProviderStore } = await import('../providerStore');

      await useProviderStore.getState().ensureProvidersLoaded();
      useProviderStore.getState().invalidateProviders('import');
      await useProviderStore.getState().ensureProvidersLoaded();

      expect(invokeMock.mock.calls.filter(([command]) => command === 'list_providers')).toHaveLength(2);
      expect(useProviderStore.getState().providersMeta.revision).toBe(1);
    });

    it('keeps fetchProviders as an explicit forced refresh', async () => {
      invokeMock.mockResolvedValue([]);
      const { useProviderStore } = await import('../providerStore');

      await useProviderStore.getState().ensureProvidersLoaded();
      await useProviderStore.getState().fetchProviders();

      expect(invokeMock.mock.calls.filter(([command]) => command === 'list_providers')).toHaveLength(2);
    });

    it('reloads a stale initial list after a concurrent provider mutation', async () => {
      const firstList = deferred<any[]>();
      const existing = { id: 'existing', name: 'Existing', models: [], keys: [] };
      const created = { id: 'created', name: 'Created', models: [], keys: [] };
      let listCount = 0;
      invokeMock.mockImplementation((command: string) => {
        if (command === 'list_providers') {
          listCount += 1;
          return listCount === 1 ? firstList.promise : Promise.resolve([existing, created]);
        }
        if (command === 'create_provider') return Promise.resolve(created);
        throw new Error(`Unexpected command: ${command}`);
      });
      const { useProviderStore } = await import('../providerStore');

      const initialLoad = useProviderStore.getState().ensureProvidersLoaded();
      await useProviderStore.getState().createProvider({} as any);
      firstList.resolve([existing]);
      await initialLoad;

      expect(listCount).toBe(2);
      expect(useProviderStore.getState().providers.map((item) => item.id)).toEqual([
        'existing',
        'created',
      ]);
      expect(useProviderStore.getState().providersMeta.status).toBe('ready');
    });
  });
});
