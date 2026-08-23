import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => {}),
  isTauri: () => true,
}));

vi.mock('@/lib/modelCapabilities', () => ({
  supportsReasoning: () => false,
  supportsFunctionCalling: () => true,
  findModelByIds: () => null,
}));

vi.mock('@/lib/searchUtils', () => ({
  buildContextualSearchQuery: (_messages: Message[], currentContent: string) => currentContent,
  formatSearchContent: (content: string) => content,
  buildSearchQueryTag: () => '',
  buildSearchTag: () => '',
}));

vi.mock('@/lib/memoryUtils', () => ({
  buildKnowledgeTag: () => '',
  buildMemoryTag: () => '',
}));

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({ providers: [] }),
  },
}));

vi.mock('@/stores/searchStore', () => ({
  useSearchStore: {
    getState: () => ({ executeSearch: vi.fn() }),
  },
}));

const { useConversationStore } = await import('../conversationStore');

function createMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    id: overrides.id,
    conversation_id: 'conv-1',
    role: overrides.role,
    content: overrides.content,
    provider_id: overrides.provider_id ?? 'provider-1',
    model_id: overrides.model_id ?? null,
    token_count: overrides.token_count ?? null,
    prompt_tokens: overrides.prompt_tokens ?? null,
    completion_tokens: overrides.completion_tokens ?? null,
    attachments: overrides.attachments ?? [],
    thinking: overrides.thinking ?? null,
    tool_calls_json: overrides.tool_calls_json ?? null,
    tool_call_id: overrides.tool_call_id ?? null,
    created_at: overrides.created_at ?? 1,
    parent_message_id: overrides.parent_message_id ?? null,
    version_index: overrides.version_index ?? 0,
    is_active: overrides.is_active ?? true,
    status: overrides.status ?? 'complete',
    tokens_per_second: overrides.tokens_per_second ?? null,
    first_token_latency_ms: overrides.first_token_latency_ms ?? null,
  };
}

describe('conversationStore.deleteMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      error: null,
      messages: [],
      messageVersionGroups: {},
    });
  });

  it('trusts the backend promotion when deleting the active error version', async () => {
    const userMessage = createMessage({
      id: 'user-1',
      role: 'user',
      content: 'hello',
      provider_id: null,
      model_id: null,
      created_at: 1,
    });
    const remainingVersion = createMessage({
      id: 'assistant-ok',
      role: 'assistant',
      content: 'ok',
      model_id: 'model-a',
      parent_message_id: userMessage.id,
      version_index: 0,
      is_active: false,
      created_at: 2,
    });
    const activeErrorVersion = createMessage({
      id: 'assistant-error',
      role: 'assistant',
      content: 'boom',
      model_id: 'model-b',
      parent_message_id: userMessage.id,
      version_index: 1,
      is_active: true,
      status: 'error',
      created_at: 3,
    });

    useConversationStore.setState({
      messages: [userMessage, activeErrorVersion],
    });

    const promotedVersion = { ...remainingVersion, is_active: true };
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'delete_message':
          return undefined;
        case 'list_message_versions_batch':
          return { [userMessage.id]: [promotedVersion] };
        default:
          throw new Error(`Unexpected invoke: ${command}`);
      }
    });

    await useConversationStore.getState().deleteMessage(activeErrorVersion.id);

    expect(invokeMock).toHaveBeenCalledWith('delete_message', { id: activeErrorVersion.id });
    expect(invokeMock).not.toHaveBeenCalledWith('switch_message_version', expect.anything());
    const deleteCallIndex = invokeMock.mock.calls.findIndex(([command]) => command === 'delete_message');
    const listCallIndex = invokeMock.mock.calls.findIndex(([command]) => command === 'list_message_versions_batch');
    expect(invokeMock.mock.invocationCallOrder[deleteCallIndex])
      .toBeLessThan(invokeMock.mock.invocationCallOrder[listCallIndex]);

    const messages = useConversationStore.getState().messages;
    expect(messages.find((message) => message.id === activeErrorVersion.id)).toBeUndefined();
    expect(messages.find((message) => message.id === remainingVersion.id)?.is_active).toBe(true);
  });

  it('deletes a persistent version that exists only in the authoritative resource', async () => {
    const userMessage = createMessage({ id: 'user-1', role: 'user', content: 'hello' });
    const activeVersion = createMessage({
      id: 'assistant-active',
      role: 'assistant',
      content: 'active',
      parent_message_id: userMessage.id,
      is_active: true,
    });
    const inactiveVersion = createMessage({
      id: 'assistant-inactive',
      role: 'assistant',
      content: 'inactive',
      parent_message_id: userMessage.id,
      is_active: false,
    });
    useConversationStore.setState({ messages: [userMessage, activeVersion] });
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      userMessage.id,
      [activeVersion, inactiveVersion],
    );
    useConversationStore.setState({ messages: [userMessage, activeVersion] });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'delete_message') return undefined;
      if (command === 'list_message_versions_batch') return { [userMessage.id]: [activeVersion] };
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await useConversationStore.getState().deleteMessage(inactiveVersion.id);

    expect(invokeMock).toHaveBeenCalledWith('delete_message', { id: inactiveVersion.id });
    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.versions.map((message) => message.id)).toEqual([activeVersion.id]);
  });

  it('keeps the confirmed local deletion and marks the resource errored when refresh fails', async () => {
    const userMessage = createMessage({ id: 'user-1', role: 'user', content: 'hello' });
    const activeVersion = createMessage({
      id: 'assistant-active',
      role: 'assistant',
      content: 'active',
      parent_message_id: userMessage.id,
      is_active: true,
    });
    const deletedVersion = createMessage({
      id: 'assistant-deleted',
      role: 'assistant',
      content: 'deleted',
      parent_message_id: userMessage.id,
      is_active: false,
    });
    useConversationStore.setState({ messages: [userMessage, activeVersion, deletedVersion] });
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      userMessage.id,
      [activeVersion, deletedVersion],
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'delete_message') return undefined;
      if (command === 'list_message_versions_batch') throw new Error('refresh failed');
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await expect(useConversationStore.getState().deleteMessage(deletedVersion.id))
      .rejects.toThrow('refresh failed');

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.versions.map((message) => message.id)).toEqual([activeVersion.id]);
    expect(resource.meta.status).toBe('error');
    expect(resource.error).toContain('refresh failed');
  });

  it('commits a ready empty snapshot after deleting the final version', async () => {
    const userMessage = createMessage({ id: 'user-1', role: 'user', content: 'hello' });
    const finalVersion = createMessage({
      id: 'assistant-final',
      role: 'assistant',
      content: 'final',
      parent_message_id: userMessage.id,
      is_active: true,
    });
    useConversationStore.setState({ messages: [userMessage, finalVersion] });
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      userMessage.id,
      [finalVersion],
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'delete_message') return undefined;
      if (command === 'list_message_versions_batch') return { [userMessage.id]: [] };
      throw new Error(`Unexpected invoke: ${command}`);
    });

    await useConversationStore.getState().deleteMessage(finalVersion.id);

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.meta.status).toBe('ready');
    expect(resource.versions).toEqual([]);
    expect(useConversationStore.getState().messages.map((message) => message.id))
      .toEqual([userMessage.id]);
  });

  it('keeps remaining multi-model versions hydrated after deleting an inactive version', async () => {
    const userMessage = createMessage({
      id: 'user-1',
      role: 'user',
      content: 'hello',
      provider_id: null,
      model_id: null,
      created_at: 1,
    });
    const activeVersion = createMessage({
      id: 'assistant-active',
      role: 'assistant',
      content: 'active',
      model_id: 'model-a',
      parent_message_id: userMessage.id,
      version_index: 0,
      is_active: true,
      created_at: 2,
    });
    const inactiveDeleted = createMessage({
      id: 'assistant-inactive',
      role: 'assistant',
      content: 'inactive',
      model_id: 'model-b',
      parent_message_id: userMessage.id,
      version_index: 1,
      is_active: false,
      created_at: 3,
    });
    const inactiveRemaining = createMessage({
      id: 'assistant-other',
      role: 'assistant',
      content: 'other',
      model_id: 'model-c',
      parent_message_id: userMessage.id,
      version_index: 2,
      is_active: false,
      created_at: 4,
    });

    useConversationStore.setState({
      messages: [userMessage, activeVersion, inactiveDeleted, inactiveRemaining],
    });

    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'delete_message':
          return undefined;
        case 'list_messages_page':
          return {
            messages: [userMessage, activeVersion],
            has_older: false,
            oldest_message_id: userMessage.id,
            total_active_count: 2,
          };
        case 'list_message_versions_batch':
          return { [userMessage.id]: [activeVersion, inactiveRemaining] };
        default:
          throw new Error(`Unexpected invoke: ${command}`);
      }
    });

    await useConversationStore.getState().deleteMessage(inactiveDeleted.id);

    expect(invokeMock).toHaveBeenCalledWith('delete_message', { id: inactiveDeleted.id });
    expect(useConversationStore.getState().messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-active',
      'assistant-other',
    ]);
    expect(useConversationStore.getState().messages.find((message) => message.id === activeVersion.id)?.is_active).toBe(true);
  });

  it('removes a deleted version from the authoritative snapshot before refresh completes', async () => {
    const userMessage = createMessage({
      id: 'user-1',
      role: 'user',
      content: 'hello',
      provider_id: null,
      model_id: null,
    });
    const activeVersion = createMessage({
      id: 'assistant-active',
      role: 'assistant',
      content: 'active',
      parent_message_id: userMessage.id,
      is_active: true,
    });
    const deletedVersion = createMessage({
      id: 'assistant-deleted',
      role: 'assistant',
      content: 'deleted',
      parent_message_id: userMessage.id,
      is_active: false,
    });
    let resolvePage!: (value: {
      messages: Message[];
      has_older: boolean;
      oldest_message_id: string;
      total_active_count: number;
    }) => void;
    const page = new Promise<{
      messages: Message[];
      has_older: boolean;
      oldest_message_id: string;
      total_active_count: number;
    }>((resolve) => {
      resolvePage = resolve;
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === 'delete_message') return Promise.resolve();
      if (command === 'list_messages_page') return page;
      if (command === 'list_message_versions_batch') {
        return Promise.resolve({ [userMessage.id]: [activeVersion] });
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
    useConversationStore.setState({ messages: [userMessage, activeVersion, deletedVersion] });
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      userMessage.id,
      [activeVersion, deletedVersion],
    );

    const deletion = useConversationStore.getState().deleteMessage(deletedVersion.id);
    await Promise.resolve();
    await Promise.resolve();

    const loadingResource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(loadingResource.meta.loadedAt).not.toBeNull();
    expect(loadingResource.versions.map((message) => message.id)).toEqual([activeVersion.id]);

    resolvePage({
      messages: [userMessage, activeVersion],
      has_older: false,
      oldest_message_id: userMessage.id,
      total_active_count: 2,
    });
    await deletion;
  });

  it('does not let an older delete refresh resurrect a version removed by a newer delete', async () => {
    const userMessage = createMessage({ id: 'user-1', role: 'user', content: 'hello' });
    const activeVersion = createMessage({
      id: 'assistant-active',
      role: 'assistant',
      content: 'active',
      parent_message_id: userMessage.id,
      is_active: true,
    });
    const firstDeletedVersion = createMessage({
      id: 'assistant-first-deleted',
      role: 'assistant',
      content: 'first',
      parent_message_id: userMessage.id,
      is_active: false,
    });
    const secondDeletedVersion = createMessage({
      id: 'assistant-second-deleted',
      role: 'assistant',
      content: 'second',
      parent_message_id: userMessage.id,
      is_active: false,
    });
    let resolveStaleRefresh!: (versions: Record<string, Message[]>) => void;
    let resolveFreshRefresh!: (versions: Record<string, Message[]>) => void;
    const staleRefresh = new Promise<Record<string, Message[]>>((resolve) => {
      resolveStaleRefresh = resolve;
    });
    const freshRefresh = new Promise<Record<string, Message[]>>((resolve) => {
      resolveFreshRefresh = resolve;
    });
    let refreshCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'delete_message') return Promise.resolve();
      if (command === 'list_message_versions_batch') {
        refreshCount += 1;
        return refreshCount === 1 ? staleRefresh : freshRefresh;
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
    useConversationStore.setState({
      messages: [userMessage, activeVersion, firstDeletedVersion, secondDeletedVersion],
    });
    useConversationStore.getState().applyMessageVersionSnapshot(
      'conv-1',
      userMessage.id,
      [activeVersion, firstDeletedVersion, secondDeletedVersion],
    );

    const firstDeletion = useConversationStore.getState().deleteMessage(firstDeletedVersion.id);
    await vi.waitFor(() => expect(refreshCount).toBe(1));
    const secondDeletion = useConversationStore.getState().deleteMessage(secondDeletedVersion.id);
    await vi.waitFor(() => expect(refreshCount).toBe(2));

    resolveFreshRefresh({ [userMessage.id]: [activeVersion] });
    await secondDeletion;
    resolveStaleRefresh({ [userMessage.id]: [activeVersion, secondDeletedVersion] });
    await firstDeletion;

    const resource = Object.values(useConversationStore.getState().messageVersionGroups)[0];
    expect(resource.versions.map((message) => message.id)).toEqual([activeVersion.id]);
  });
});
