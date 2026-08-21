import type { Message } from '@/types';

export function getModelVersionGroupKey(
  providerId: string | null | undefined,
  modelId: string,
): string {
  return `${providerId ?? '__provider__'}:${modelId}`;
}

export function getMessageVersionGroupKey(version: Message): string {
  if (version.model_id) {
    return getModelVersionGroupKey(version.provider_id, version.model_id);
  }
  if (version.provider_id) {
    return `${version.provider_id}:${version.id}`;
  }
  return `__message__:${version.id}`;
}

export function getLatestVersionsByModel(versions: Message[]): Message[] {
  const modelMap = new Map<string, Message>();
  for (const version of versions) {
    const key = getMessageVersionGroupKey(version);
    const existing = modelMap.get(key);
    if (!existing || version.version_index > existing.version_index) {
      modelMap.set(key, version);
    }
  }
  return Array.from(modelMap.values());
}

export function selectDisplayVersionsByModel(
  versions: Message[],
  activeMessageId?: string | null,
  displayMessageIdsByModelKey?: ReadonlyMap<string, string> | Record<string, string | undefined> | null,
): Message[] {
  const modelMap = new Map<string, { latest: Message; active: Message | null; selected: Message | null }>();
  for (const version of versions) {
    const key = getMessageVersionGroupKey(version);
    const existing = modelMap.get(key);
    const selectedMessageId = getDisplayMessageId(displayMessageIdsByModelKey, key);
    const isActiveVersion = activeMessageId
      ? version.id === activeMessageId
      : version.is_active;

    if (!existing) {
      modelMap.set(key, {
        latest: version,
        active: isActiveVersion ? version : null,
        selected: selectedMessageId === version.id ? version : null,
      });
      continue;
    }

    if (compareVersionDesc(version, existing.latest) < 0) {
      existing.latest = version;
    }
    if (isActiveVersion) {
      existing.active = version;
    }
    if (selectedMessageId === version.id) {
      existing.selected = version;
    }
  }

  return Array.from(modelMap.values()).map((group) => group.selected ?? group.active ?? group.latest);
}

export interface PendingDisplayVersionSelection {
  messageId: string;
  versionIndex: number;
  createdAt: number;
}

export function resolvePendingDisplayVersionSelection(
  versions: Message[],
  modelKey: string,
  selectedMessageId: string | null | undefined,
  pending: PendingDisplayVersionSelection | null | undefined,
): string | null {
  if (!selectedMessageId) return null;
  if (versions.some((version) => version.id === selectedMessageId)) {
    return selectedMessageId;
  }
  if (!pending || pending.messageId !== selectedMessageId) {
    return selectedMessageId;
  }

  const resolved = versions
    .filter((version) =>
      getMessageVersionGroupKey(version) === modelKey
      && version.version_index >= pending.versionIndex
    )
    .sort(compareVersionDesc)[0];

  return resolved?.id ?? selectedMessageId;
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

function getDisplayMessageId(
  selections: ReadonlyMap<string, string> | Record<string, string | undefined> | null | undefined,
  key: string,
): string | null {
  if (!selections) return null;
  if (typeof (selections as ReadonlyMap<string, string>).get === 'function') {
    return (selections as ReadonlyMap<string, string>).get(key) ?? null;
  }
  return (selections as Record<string, string | undefined>)[key] ?? null;
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

  const deletedModelKey = deletedVersion.model_id
    ? getMessageVersionGroupKey(deletedVersion)
    : null;
  const sameModelVersions = deletedModelKey
    ? remainingVersions.filter((version) => getMessageVersionGroupKey(version) === deletedModelKey)
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
