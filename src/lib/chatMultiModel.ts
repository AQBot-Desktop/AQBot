import type { Message } from '@/types';

function getVersionGroupKey(version: Message): string {
  if (version.model_id) {
    return `${version.provider_id ?? '__provider__'}:${version.model_id}`;
  }
  if (version.provider_id) {
    return `${version.provider_id}:${version.id}`;
  }
  return `__message__:${version.id}`;
}

export function getLatestVersionsByModel(versions: Message[]): Message[] {
  const modelMap = new Map<string, Message>();
  for (const version of versions) {
    const key = getVersionGroupKey(version);
    const existing = modelMap.get(key);
    if (!existing || version.version_index > existing.version_index) {
      modelMap.set(key, version);
    }
  }
  return Array.from(modelMap.values());
}

export function hasMultipleModelVersions(versions: Message[]): boolean {
  return getLatestVersionsByModel(versions).length > 1;
}

export function selectRenderableVersionSet(
  storeVersions: Message[],
  cachedVersions: Message[] | null | undefined,
): Message[] {
  if (storeVersions.length > 0) {
    return storeVersions;
  }
  return cachedVersions ?? storeVersions;
}

function compareVersionDesc(left: Message, right: Message): number {
  return right.version_index - left.version_index
    || right.created_at - left.created_at
    || right.id.localeCompare(left.id);
}

export function selectNextAssistantVersion(
  versions: Message[],
  deletedMessageId: string,
): Message | null {
  const deletedVersion = versions.find((version) => version.id === deletedMessageId);
  if (!deletedVersion) {
    return null;
  }

  const remainingVersions = versions.filter((version) => version.id !== deletedMessageId);
  if (remainingVersions.length === 0) {
    return null;
  }

  const sameModelVersions = deletedVersion.model_id
    ? remainingVersions.filter((version) => version.model_id === deletedVersion.model_id)
    : [];
  const candidates = sameModelVersions.length > 0 ? sameModelVersions : remainingVersions;

  return [...candidates].sort(compareVersionDesc)[0] ?? null;
}

export function shouldRenderStandaloneAssistantError(
  status: Message['status'] | null | undefined,
  isNonTabsMultiModel: boolean,
): boolean {
  return status === 'error' && !isNonTabsMultiModel;
}

export function insertModelVersionPlaceholder(
  messages: Message[],
  parentMessageId: string,
  placeholder: Message,
): Message[] {
  let inserted = false;
  const updated: Message[] = [];

  for (const message of messages) {
    updated.push(message);
    if (!inserted && message.parent_message_id === parentMessageId && message.role === 'assistant' && message.is_active) {
      updated.push(placeholder);
      inserted = true;
    }
  }

  if (!inserted) {
    updated.push(placeholder);
  }

  return updated;
}

function compareMessageAsc(left: Message, right: Message): number {
  return left.created_at - right.created_at
    || left.version_index - right.version_index
    || left.id.localeCompare(right.id);
}

export function mergeAssistantVersionGroup(
  messages: Message[],
  parentMessageId: string,
  versions: Message[],
  activeMessageId?: string | null,
): Message[] {
  if (versions.length === 0) {
    return messages;
  }

  const versionGroup = [...versions]
    .sort(compareMessageAsc)
    .map((version) => activeMessageId
      ? { ...version, is_active: version.id === activeMessageId }
      : version);
  const result: Message[] = [];
  let inserted = false;

  for (const message of messages) {
    const isTargetAssistant = message.parent_message_id === parentMessageId && message.role === 'assistant';
    if (isTargetAssistant) {
      if (!inserted) {
        result.push(...versionGroup);
        inserted = true;
      }
      continue;
    }
    result.push(message);
  }

  if (!inserted) {
    const parentIndex = result.findIndex((message) => message.id === parentMessageId);
    if (parentIndex >= 0) {
      result.splice(parentIndex + 1, 0, ...versionGroup);
    } else {
      result.push(...versionGroup);
    }
  }

  return result;
}

export interface MultiModelStreamErrorInput {
  conversationId: string;
  parentMessageId: string | null;
  streamingMessageId: string | null;
  messageId: string;
  error: string;
  modelId?: string | null;
  providerId?: string | null;
}

export function applyMultiModelStreamError(
  messages: Message[],
  input: MultiModelStreamErrorInput,
): { messages: Message[]; streamingMessageId: string | null } {
  const directMatch = messages.some((message) => message.id === input.messageId);
  if (directMatch) {
    const matchedMessage = messages.find((message) => message.id === input.messageId);
    const shouldResolveStreamingId = Boolean(
      input.streamingMessageId?.startsWith('temp-')
      && matchedMessage
      && (!input.parentMessageId || matchedMessage.parent_message_id === input.parentMessageId)
      && (!input.modelId || matchedMessage.model_id === input.modelId)
      && (!input.providerId || matchedMessage.provider_id === input.providerId)
    );
    return {
      streamingMessageId: input.streamingMessageId === input.messageId || shouldResolveStreamingId
        ? input.messageId
        : input.streamingMessageId,
      messages: messages.map((message) => message.id === input.messageId
        ? {
            ...message,
            content: input.error,
            status: 'error' as const,
            model_id: message.model_id ?? input.modelId ?? null,
            provider_id: message.provider_id ?? input.providerId ?? null,
            parent_message_id: message.parent_message_id ?? input.parentMessageId,
          }
        : message),
    };
  }

  if (input.streamingMessageId?.startsWith('temp-')) {
    const placeholder = messages.find((message) => message.id === input.streamingMessageId);
    if (placeholder && (!input.parentMessageId || placeholder.parent_message_id === input.parentMessageId)) {
      return {
        streamingMessageId: input.messageId,
        messages: messages.map((message) => message.id === input.streamingMessageId
          ? {
              ...message,
              id: input.messageId,
              content: input.error,
              status: 'error' as const,
              model_id: input.modelId ?? message.model_id ?? null,
              provider_id: input.providerId ?? message.provider_id ?? null,
              parent_message_id: input.parentMessageId ?? message.parent_message_id,
            }
          : message),
      };
    }
  }

  if (!input.parentMessageId) {
    return { messages, streamingMessageId: input.streamingMessageId };
  }

  const newMessage: Message = {
    id: input.messageId,
    conversation_id: input.conversationId,
    role: 'assistant',
    content: input.error,
    provider_id: input.providerId ?? null,
    model_id: input.modelId ?? null,
    token_count: null,
    prompt_tokens: null,
    completion_tokens: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: Date.now(),
    parent_message_id: input.parentMessageId,
    version_index: 0,
    is_active: false,
    status: 'error',
    tokens_per_second: null,
    first_token_latency_ms: null,
  };

  return {
    messages: insertModelVersionPlaceholder(messages, input.parentMessageId, newMessage),
    streamingMessageId: input.streamingMessageId,
  };
}

export function mergeAssistantVersionsAfterSwitch(
  messages: Message[],
  parentMessageId: string,
  versions: Message[],
  activeMessageId: string,
): Message[] {
  return mergeAssistantVersionGroup(messages, parentMessageId, versions, activeMessageId);
}
