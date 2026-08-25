import type { Message, MessagePage, MessageWindow } from '@/types';

export function makeMessage(index: number, conversationId = 'conv-1'): Message {
  return {
    id: `msg-${index}`,
    conversation_id: conversationId,
    role: index % 2 === 0 ? 'assistant' : 'user',
    content: `message-${index}`,
    provider_id: null,
    model_id: null,
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: index,
    parent_message_id: null,
    version_index: 0,
    is_active: true,
    status: 'complete',
  };
}

export function makePage(messages: Message[], hasOlder: boolean): MessagePage {
  return {
    messages,
    has_older: hasOlder,
    oldest_message_id: messages[0]?.id ?? null,
    total_active_count: messages.length,
  };
}

export function makeWindow(
  messages: Message[],
  hasOlder: boolean,
  hasNewer: boolean,
): MessageWindow {
  return {
    messages,
    has_older: hasOlder,
    has_newer: hasNewer,
    oldest_message_id: messages[0]?.id ?? null,
    newest_message_id: messages[messages.length - 1]?.id ?? null,
    total_active_count: messages.length,
  };
}

export function makeConversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `conversation-${id}`,
    model_id: 'model-1',
    provider_id: 'provider-1',
    system_prompt: null,
    temperature: null,
    max_tokens: null,
    top_p: null,
    frequency_penalty: null,
    search_enabled: false,
    search_provider_id: null,
    thinking_budget: null,
    thinking_level: null,
    enabled_mcp_server_ids: [],
    enabled_knowledge_base_ids: [],
    enabled_memory_namespace_ids: [],
    category_id: null,
    parent_conversation_id: null,
    is_pinned: false,
    is_archived: false,
    context_compression: false,
    context_strategy_override: null,
    context_message_limit: null,
    compression_keep_last_n: null,
    multi_model_targets: [],
    multi_model_continuation_mode: 'selected' as const,
    message_count: 0,
    sort_order: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function flushPromises() {
  for (let index = 0; index < 16; index += 1) {
    await Promise.resolve();
  }
}
