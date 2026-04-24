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
  findModelByIds: () => null,
}));

vi.mock('@/lib/searchUtils', () => ({
  formatSearchContent: (content: string) => content,
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
    });
  });

  it('promotes a remaining assistant version when deleting the active error version', async () => {
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

    let listVersionsCallCount = 0;
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'delete_message':
        case 'switch_message_version':
          return undefined;
        case 'list_message_versions': {
          listVersionsCallCount += 1;
          return listVersionsCallCount === 1
            ? [remainingVersion, activeErrorVersion]
            : [remainingVersion];
        }
        case 'list_messages_page':
          return {
            messages: [userMessage, remainingVersion],
            has_older: false,
            oldest_message_id: userMessage.id,
            total_active_count: 2,
          };
        default:
          throw new Error(`Unexpected invoke: ${command}`);
      }
    });

    await useConversationStore.getState().deleteMessage(activeErrorVersion.id);

    expect(invokeMock).toHaveBeenCalledWith('delete_message', { id: activeErrorVersion.id });
    expect(invokeMock).toHaveBeenCalledWith('switch_message_version', {
      conversationId: 'conv-1',
      parentMessageId: userMessage.id,
      messageId: remainingVersion.id,
    });

    const messages = useConversationStore.getState().messages;
    expect(messages.find((message) => message.id === activeErrorVersion.id)).toBeUndefined();
    expect(messages.find((message) => message.id === remainingVersion.id)?.is_active).toBe(true);
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
        case 'list_message_versions':
          return [activeVersion, inactiveRemaining];
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
});
