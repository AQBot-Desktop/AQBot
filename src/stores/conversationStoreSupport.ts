import { invoke, type UnlistenFn } from '@/lib/invoke';
import type { ConversationStreamSyncState } from '@/lib/conversationSync';
import { supportsReasoning, supportsFunctionCalling, findModelByIds } from '@/lib/modelCapabilities';
import { coerceReasoningOptionKey, resolveReasoningProfile } from '@/lib/reasoningProfile';
import { buildKnowledgeTag, buildMemoryTag, type RagContextRetrievedEvent } from '@/lib/memoryUtils';
import { plannedVersionIndexForTarget } from '@/lib/chatMultiModel';
import type { MultiModelContinuationMode } from '@/lib/multiModelContinuation';
import type { StreamActivity } from '@/lib/streamStatus';
import type {
  EnsureLoadedOptions,
  ResourceInvalidationReason,
  ResourceMeta,
} from '@/lib/resourceState';
import { useProviderStore } from '@/stores/providerStore';
import { useKnowledgeStore } from '@/stores/knowledgeStore';
import { useMemoryStore } from '@/stores/memoryStore';
import { useMcpStore } from '@/stores/mcpStore';
import type {
  AttachmentInput,
  CompareResponsesResult,
  ContextUsage,
  Conversation,
  ConversationBranch,
  ConversationCategory,
  ConversationSearchResult,
  ConversationSummary,
  ConversationWorkspaceSnapshot,
  Message,
  MultiModelDisplayMode,
  MultiModelTarget,
  UpdateConversationInput,
} from '@/types';

let _unlisten: UnlistenFn | null = null;
// Generation counter to prevent stale listeners from processing events
// (fixes React StrictMode double-effect causing duplicate stream processing)
let _listenerGen = 0;

// Buffer for streaming content — persists across conversation switches
// so chunks arriving while viewing another conversation aren't lost
export interface StreamBuffer {
  messageId: string;
  conversationId: string;
  content: string;
  /** The real message ID resolved from the backend (may differ from initial placeholder) */
  resolvedId: string | null;
  /** Accumulated thinking/reasoning content */
  thinking: string | null;
}
let _streamBuffer: StreamBuffer | null = null;
// Prefix injected before streaming content (e.g., search result tags)
let _streamPrefix = '';
// Conversations whose stream completed while the user was viewing a different
// conversation.  When the user switches back we trigger a fetchMessages so the
// final AI response is loaded from the backend.
const _pendingConversationRefresh = new Set<string>();
const STREAM_UI_FLUSH_INTERVAL_MS = 32;
const STREAM_FIRST_UI_FLUSH_DELAY_MS = 0;
const AGENT_STREAM_UI_FLUSH_INTERVAL_MS = 16;
const ACTIVE_STREAM_EXISTS_ERROR_FRAGMENT = '当前会话已有回复正在生成';
export interface PendingUiChunk {
  messageId: string;
  conversationId: string;
  content: string;
  modelId?: string;
  providerId?: string;
}
let _pendingUiChunk: PendingUiChunk | null = null;
let _streamUiFlushTimer: ReturnType<typeof setTimeout> | null = null;
const _liveStreamContentByMessageId = new Map<string, string>();
const _liveStreamListenersByMessageId = new Map<string, Set<() => void>>();
let _activeMessageLoadSeq = 0;
const _conversationPreferenceSaveSeq = new Map<string, number>();
const _conversationDisplayModeMutations = new Map<string, ConversationDisplayModeMutation>();
const _messageVersionGroupRequests = new Map<string, Promise<void>>();
let _messageVersionGroupRevision = 0;
export const MESSAGE_PAGE_SIZE = 10;
export const MAX_LOADED_MESSAGES = 40;
const CONVERSATIONS_RESOURCE_KEY = 'conversations';
const MESSAGE_CACHE_MAX_CONVERSATIONS = 8;
const MESSAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
let _agentStreamSeq = 0;
let _activeAgentCancel: (() => void) | null = null;
let _conversationsRequest: { revision: number; promise: Promise<void> } | null = null;

function mutateConversationsMeta(meta: ResourceMeta): ResourceMeta {
  const remainsComplete = meta.status === 'ready' && meta.key === CONVERSATIONS_RESOURCE_KEY;
  return {
    status: remainsComplete ? 'ready' : 'idle',
    key: remainsComplete ? CONVERSATIONS_RESOURCE_KEY : null,
    loadedAt: remainsComplete ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

interface CachedMessageState {
  messages: Message[];
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  totalActiveCount: number;
  oldestLoadedMessageId: string | null;
  newestLoadedMessageId: string | null;
  conversationUpdatedAt: number | null;
  conversationMessageCount: number | null;
  estimatedBytes: number;
}

const _messageCache = new Map<string, CachedMessageState>();
let _messageCacheBytes = 0;

function estimateMessageCacheBytes(messages: Message[]): number {
  return messages.reduce((total, message) => {
    const attachmentBytes = message.attachments.reduce((sum, attachment) => (
      sum + (attachment.data?.length ?? 0) * 2 + attachment.file_path.length * 2
    ), 0);
    const metadataBytes = [
      message.tool_calls_json,
      message.provider_id,
      message.model_id,
      message.parent_message_id,
      message.tool_call_id,
    ].reduce((sum, value) => sum + (value?.length ?? 0) * 2, 0);
    return total
      + message.content.length * 2
      + (message.thinking?.length ?? 0) * 2
      + attachmentBytes
      + metadataBytes
      + 384;
  }, 0);
}

function findConversationForCache(state: ConversationState, conversationId: string): Conversation | undefined {
  return state.conversations.find((conversation) => conversation.id === conversationId)
    ?? state.archivedConversations.find((conversation) => conversation.id === conversationId);
}

function deleteCachedMessageState(conversationId: string) {
  const existing = _messageCache.get(conversationId);
  if (!existing) return;
  _messageCacheBytes -= existing.estimatedBytes;
  _messageCache.delete(conversationId);
}

export function invalidateConversationMessageCache(conversationId?: string) {
  if (conversationId) {
    deleteCachedMessageState(conversationId);
    return;
  }
  _messageCache.clear();
  _messageCacheBytes = 0;
}

function cacheMessageState(state: ConversationState, conversationId: string) {
  if (
    state.activeConversationId !== conversationId
    || state.loading
    || state.loadingOlder
    || state.loadingNewer
  ) return;
  const conversation = findConversationForCache(state, conversationId);
  const estimatedBytes = estimateMessageCacheBytes(state.messages);
  deleteCachedMessageState(conversationId);
  if (estimatedBytes > MESSAGE_CACHE_MAX_BYTES) return;

  _messageCache.set(conversationId, {
    messages: state.messages,
    hasOlderMessages: state.hasOlderMessages,
    hasNewerMessages: state.hasNewerMessages,
    totalActiveCount: state.totalActiveCount,
    oldestLoadedMessageId: state.oldestLoadedMessageId,
    newestLoadedMessageId: state.newestLoadedMessageId,
    conversationUpdatedAt: conversation?.updated_at ?? null,
    conversationMessageCount: conversation?.message_count ?? null,
    estimatedBytes,
  });
  _messageCacheBytes += estimatedBytes;

  while (
    _messageCache.size > MESSAGE_CACHE_MAX_CONVERSATIONS
    || _messageCacheBytes > MESSAGE_CACHE_MAX_BYTES
  ) {
    const oldestConversationId = _messageCache.keys().next().value;
    if (!oldestConversationId) break;
    deleteCachedMessageState(oldestConversationId);
  }
}

function readCachedMessageState(
  conversationId: string,
  conversation?: Conversation,
): { state: CachedMessageState; fresh: boolean } | null {
  const cached = _messageCache.get(conversationId);
  if (!cached) return null;
  _messageCache.delete(conversationId);
  _messageCache.set(conversationId, cached);
  const fresh = !conversation || (
    cached.conversationUpdatedAt === conversation.updated_at
    && cached.conversationMessageCount === conversation.message_count
  );
  return { state: cached, fresh };
}

function validateCachedMessageState(
  set: ConversationStoreSet,
  get: () => ConversationState,
  conversationId: string,
  cached: CachedMessageState,
  requestSeq: number,
) {
  void (async () => {
    try {
      const latestConversation = await invoke<Conversation>('get_conversation_snapshot', {
        id: conversationId,
      });
      if (requestSeq !== _activeMessageLoadSeq || get().activeConversationId !== conversationId) {
        return;
      }
      set((state) => ({
        ...mergeConversationCollections(
          state.conversations,
          state.archivedConversations,
          latestConversation,
        ),
      }));
      const unchanged = cached.conversationUpdatedAt === latestConversation.updated_at
        && cached.conversationMessageCount === latestConversation.message_count;
      if (unchanged) return;

      deleteCachedMessageState(conversationId);
      void get().fetchMessages(conversationId, [], { setLoading: false });
    } catch (error) {
      console.error('Failed to validate cached conversation messages:', error);
    }
  })();
}

function boundMessageWindow(
  messages: Message[],
  keepEdge: 'older' | 'newer',
): { messages: Message[]; trimmedOlder: boolean; trimmedNewer: boolean } {
  const activeMessages = messages.filter((message) => message.is_active !== false);
  if (activeMessages.length <= MAX_LOADED_MESSAGES) {
    return { messages, trimmedOlder: false, trimmedNewer: false };
  }

  const overflow = activeMessages.length - MAX_LOADED_MESSAGES;
  const trimCount = Math.ceil(overflow / MESSAGE_PAGE_SIZE) * MESSAGE_PAGE_SIZE;
  const retainedActiveMessages = keepEdge === 'older'
    ? activeMessages.slice(0, activeMessages.length - trimCount)
    : activeMessages.slice(trimCount);
  const retainedActiveIds = new Set(retainedActiveMessages.map((message) => message.id));
  const retainedVersionParentIds = new Set<string>();
  for (const message of retainedActiveMessages) {
    retainedVersionParentIds.add(message.id);
    if (message.parent_message_id) retainedVersionParentIds.add(message.parent_message_id);
  }
  const boundedMessages = messages.filter((message) => (
    message.is_active !== false
      ? retainedActiveIds.has(message.id)
      : Boolean(message.parent_message_id && retainedVersionParentIds.has(message.parent_message_id))
  ));

  return {
    messages: boundedMessages,
    trimmedOlder: keepEdge === 'newer',
    trimmedNewer: keepEdge === 'older',
  };
}

function getActiveMessageEdges(messages: Message[]): {
  oldestMessageId: string | null;
  newestMessageId: string | null;
} {
  const activeMessages = messages.filter((message) => message.is_active !== false);
  return {
    oldestMessageId: activeMessages[0]?.id ?? null,
    newestMessageId: activeMessages[activeMessages.length - 1]?.id ?? null,
  };
}

// Multi-model parallel tracking
let _multiModelTotalRemaining = 0; // counts ALL models (including first)
let _multiModelDoneResolve: (() => void) | null = null;
let _isMultiModelActive = false;
let _multiModelRunId = 0;
let _multiModelFirstTarget: MultiModelTarget | null = null; // first provider+model target (for auto-switch)
let _multiModelFirstMessageId: string | null = null; // actual DB message_id of the first model's response
let _multiModelHistoryMode: MultiModelContinuationMode = 'selected';
let _userManuallySelectedVersion = false; // tracks if user manually switched version during multi-model streaming
const _multiModelStreamIds = new Set<string>();
export interface PendingLocalVersionSelection {
  conversationId: string;
  parentMessageId: string;
  tempMessageId: string;
  providerId: string | null;
  modelId: string | null;
  versionIndex: number;
  createdAt: number;
}
const _pendingLocalVersionSelections = new Map<string, PendingLocalVersionSelection>();
export type ConversationStoreSet = (
  partial: Partial<ConversationState> | ((state: ConversationState) => Partial<ConversationState>)
) => void;

function emitLiveStreamContentChange(messageId: string | null | undefined) {
  if (!messageId) return;
  const listeners = _liveStreamListenersByMessageId.get(messageId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

export function getLiveStreamContent(messageId: string | null | undefined): string | undefined {
  if (!messageId) return undefined;
  return _liveStreamContentByMessageId.get(messageId);
}

export function subscribeLiveStreamContent(
  messageId: string | null | undefined,
  listener: () => void,
): () => void {
  if (!messageId) return () => {};
  let listeners = _liveStreamListenersByMessageId.get(messageId);
  if (!listeners) {
    listeners = new Set();
    _liveStreamListenersByMessageId.set(messageId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = _liveStreamListenersByMessageId.get(messageId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      _liveStreamListenersByMessageId.delete(messageId);
    }
  };
}

export function setLiveStreamContent(messageId: string | null | undefined, content: string): void {
  if (!messageId) return;
  if (_liveStreamContentByMessageId.get(messageId) === content) return;
  _liveStreamContentByMessageId.set(messageId, content);
  emitLiveStreamContentChange(messageId);
}

export function clearLiveStreamContent(messageId: string | null | undefined): void {
  if (!messageId) return;
  if (!_liveStreamContentByMessageId.delete(messageId)) return;
  emitLiveStreamContentChange(messageId);
}

function getLiveOrFallbackContent(messageId: string | null | undefined, fallbackContent: string): string {
  return getLiveStreamContent(messageId) ?? fallbackContent;
}

function appendLiveStreamContent(
  messageId: string,
  incomingContent: string,
  fallbackContent: string,
): string {
  const nextContent = mergeIncomingDisplayChunk(
    getLiveOrFallbackContent(messageId, fallbackContent),
    incomingContent,
  );
  setLiveStreamContent(messageId, nextContent);
  return nextContent;
}

function materializeLiveStreamContent(
  set: ConversationStoreSet,
  messageIds: Array<string | null | undefined>,
) {
  const ids = Array.from(new Set(messageIds.filter((messageId): messageId is string => (
    typeof messageId === 'string' && messageId.length > 0
  ))));
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  set((s) => {
    let changed = false;
    const messages = s.messages.map((message) => {
      if (!idSet.has(message.id)) return message;
      const liveContent = getLiveStreamContent(message.id);
      if (liveContent === undefined || liveContent === message.content) return message;
      changed = true;
      return { ...message, content: liveContent };
    });
    return changed ? { messages } : {};
  });
  for (const messageId of ids) {
    clearLiveStreamContent(messageId);
  }
}

function restoreActiveStreamBuffer(
  set: ConversationStoreSet,
  get: () => ConversationState,
  conversationId: string,
): boolean {
  const buffer = _streamBuffer;
  if (
    !buffer
    || buffer.conversationId !== conversationId
    || !get().streaming
  ) return false;

  const realMessageId = buffer.resolvedId ?? buffer.messageId;
  if (buffer.messageId !== realMessageId) clearLiveStreamContent(buffer.messageId);
  setLiveStreamContent(realMessageId, buffer.content);
  set((state) => {
    if (state.activeConversationId !== conversationId) return {};
    const candidateIds = new Set(
      [buffer.messageId, state.streamingMessageId]
        .filter((messageId): messageId is string => Boolean(messageId)),
    );
    let hasRealMessage = state.messages.some((message) => message.id === realMessageId);
    let resolvedCandidate = false;
    const messages = state.messages.flatMap((message) => {
      if (message.id === realMessageId) {
        return [{ ...message, thinking: buffer.thinking ?? message.thinking }];
      }
      if (!candidateIds.has(message.id)) return [message];
      if (hasRealMessage || resolvedCandidate) return [];
      hasRealMessage = true;
      resolvedCandidate = true;
      return [{
        ...message,
        id: realMessageId,
        thinking: buffer.thinking ?? message.thinking,
      }];
    });

    if (!hasRealMessage) {
      messages.push({
        id: realMessageId,
        conversation_id: conversationId,
        role: 'assistant',
        content: buffer.content,
        provider_id: null,
        model_id: null,
        token_count: null,
        attachments: [],
        thinking: buffer.thinking,
        tool_calls_json: null,
        tool_call_id: null,
        created_at: Date.now(),
        parent_message_id: null,
        version_index: 0,
        is_active: true,
        status: 'partial',
      });
    }

    return { messages, streamingMessageId: realMessageId };
  });
  return true;
}

function createStreamId(): string {
  return `stream-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function isActiveStreamExistsError(error: string): boolean {
  return error.includes(ACTIVE_STREAM_EXISTS_ERROR_FRAGMENT);
}

function isCurrentStreamEvent(get: () => ConversationState, streamId?: string | null): boolean {
  if (!streamId) return true;
  if (_isMultiModelActive) {
    return _multiModelStreamIds.has(streamId);
  }
  const activeStreamId = get().activeStreamId;
  return !activeStreamId || activeStreamId === streamId;
}

function createStreamActivity(providerId?: string | null, modelId?: string | null): StreamActivity {
  return {
    startedAt: Date.now(),
    firstChunkAt: null,
    lastChunkAt: null,
    providerId: providerId ?? null,
    modelId: modelId ?? null,
    phase: 'waiting_first_packet',
  };
}

function updateStreamActivityForChunk(
  set: ConversationStoreSet,
  messageId: string,
  modelId?: string | null,
  providerId?: string | null,
) {
  const now = Date.now();
  set((s) => {
    const placeholderId = s.streamingMessageId && s.streamingMessageId !== messageId
      ? s.streamingMessageId
      : null;
    const existing = s.streamActivityByMessageId[messageId]
      ?? (placeholderId ? s.streamActivityByMessageId[placeholderId] : undefined);
    const nextActivity: StreamActivity = {
      ...(existing ?? createStreamActivity(providerId, modelId)),
      firstChunkAt: existing?.firstChunkAt ?? now,
      lastChunkAt: now,
      providerId: providerId ?? existing?.providerId ?? null,
      modelId: modelId ?? existing?.modelId ?? null,
      phase: 'streaming',
    };
    const next = {
      ...s.streamActivityByMessageId,
      [messageId]: nextActivity,
    };
    if (placeholderId) {
      delete next[placeholderId];
    }
    return { streamActivityByMessageId: next };
  });
}

function removeStreamActivities(
  activityById: Record<string, StreamActivity>,
  messageIds: Array<string | null | undefined>,
): Record<string, StreamActivity> {
  const ids = messageIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return activityById;

  const next = { ...activityById };
  for (const id of ids) {
    delete next[id];
  }
  return next;
}

type ConversationPreferenceState = Pick<
  ConversationState,
  | 'searchEnabled'
  | 'searchProviderId'
  | 'thinkingBudget'
  | 'thinkingLevel'
  | 'enabledMcpServerIds'
  | 'enabledKnowledgeBaseIds'
  | 'enabledMemoryNamespaceIds'
  | 'multiModelTargets'
  | 'multiModelContinuationMode'
>;

function conversationPreferenceStateFromConversation(
  conversation?: Conversation | null,
): ConversationPreferenceState {
  return {
    searchEnabled: conversation?.search_enabled ?? false,
    searchProviderId: conversation?.search_provider_id ?? null,
    thinkingBudget: conversation?.thinking_budget ?? null,
    thinkingLevel: conversation?.thinking_level ?? null,
    enabledMcpServerIds: [...(conversation?.enabled_mcp_server_ids ?? [])],
    enabledKnowledgeBaseIds: [...(conversation?.enabled_knowledge_base_ids ?? [])],
    enabledMemoryNamespaceIds: [...(conversation?.enabled_memory_namespace_ids ?? [])],
    multiModelTargets: [...(conversation?.multi_model_targets ?? [])],
    multiModelContinuationMode: conversation?.multi_model_continuation_mode === 'per_model'
      ? 'per_model'
      : 'selected',
  };
}

function emptyConversationPreferenceState(): ConversationPreferenceState {
  return {
    searchEnabled: false,
    searchProviderId: null,
    thinkingBudget: null,
    thinkingLevel: null,
    enabledMcpServerIds: [],
    enabledKnowledgeBaseIds: [],
    enabledMemoryNamespaceIds: [],
    multiModelTargets: [],
    multiModelContinuationMode: 'selected',
  };
}

function conversationPreferenceUpdateFromState(
  state: Pick<
    ConversationState,
    | 'searchEnabled'
    | 'searchProviderId'
    | 'thinkingBudget'
    | 'thinkingLevel'
    | 'enabledMcpServerIds'
    | 'enabledKnowledgeBaseIds'
    | 'enabledMemoryNamespaceIds'
    | 'multiModelTargets'
    | 'multiModelContinuationMode'
  >,
): Pick<
  UpdateConversationInput,
  | 'search_enabled'
  | 'search_provider_id'
  | 'thinking_budget'
  | 'thinking_level'
  | 'enabled_mcp_server_ids'
  | 'enabled_knowledge_base_ids'
  | 'enabled_memory_namespace_ids'
  | 'multi_model_targets'
  | 'multi_model_continuation_mode'
> {
  return {
    search_enabled: state.searchEnabled,
    search_provider_id: state.searchProviderId,
    thinking_budget: state.thinkingBudget,
    thinking_level: state.thinkingLevel,
    enabled_mcp_server_ids: [...state.enabledMcpServerIds],
    enabled_knowledge_base_ids: [...state.enabledKnowledgeBaseIds],
    enabled_memory_namespace_ids: [...state.enabledMemoryNamespaceIds],
    multi_model_targets: [...state.multiModelTargets],
    multi_model_continuation_mode: state.multiModelContinuationMode,
  };
}

function emptyConversationPreferenceUpdate() {
  return conversationPreferenceUpdateFromState(emptyConversationPreferenceState());
}

function dedupeStringList(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveValidConversationCapabilityIds(state: Pick<
  ConversationState,
  'enabledMcpServerIds' | 'enabledKnowledgeBaseIds' | 'enabledMemoryNamespaceIds'
>) {
  const mcpState = useMcpStore.getState();
  const knowledgeState = useKnowledgeStore.getState();
  const memoryState = useMemoryStore.getState();
  const enabledMcpServers = mcpState.servers.filter((server) => server.enabled);
  const uniqueMcpIds = dedupeStringList(state.enabledMcpServerIds);
  const uniqueKnowledgeBaseIds = dedupeStringList(state.enabledKnowledgeBaseIds);
  const uniqueMemoryNamespaceIds = dedupeStringList(state.enabledMemoryNamespaceIds);

  return {
    enabledMcpServerIds: mcpState.loading
      ? uniqueMcpIds
      : mcpState.servers.length === 0
        ? uniqueMcpIds
        : uniqueMcpIds.filter((id) => enabledMcpServers.some((server) => server.id === id)),
    enabledKnowledgeBaseIds: knowledgeState.loading
      ? uniqueKnowledgeBaseIds
      : knowledgeState.bases.length === 0
        ? uniqueKnowledgeBaseIds
        : uniqueKnowledgeBaseIds.filter((id) => knowledgeState.bases.some((base) => base.id === id)),
    enabledMemoryNamespaceIds: memoryState.loading
      ? uniqueMemoryNamespaceIds
      : memoryState.namespaces.length === 0
        ? uniqueMemoryNamespaceIds
        : uniqueMemoryNamespaceIds.filter((id) => memoryState.namespaces.some((item) => item.id === id)),
  };
}

function categoryTemplateUpdateFromCategory(
  category?: ConversationCategory | null,
): Pick<
  UpdateConversationInput,
  | 'category_id'
  | 'system_prompt'
  | 'temperature'
  | 'max_tokens'
  | 'top_p'
  | 'frequency_penalty'
> {
  if (!category) {
    return {};
  }

  return {
    category_id: category.id,
    system_prompt: category.system_prompt ?? undefined,
    temperature: category.default_temperature,
    max_tokens: category.default_max_tokens,
    top_p: category.default_top_p,
    frequency_penalty: category.default_frequency_penalty,
  };
}

function nextConversationPreferenceSaveSeq(conversationId: string): number {
  const next = (_conversationPreferenceSaveSeq.get(conversationId) ?? 0) + 1;
  _conversationPreferenceSaveSeq.set(conversationId, next);
  return next;
}

function isLatestConversationPreferenceSave(conversationId: string, seq: number): boolean {
  return (_conversationPreferenceSaveSeq.get(conversationId) ?? 0) === seq;
}

function getEffectiveThinkingBudget(get: () => ConversationState, conversationId: string): number | undefined {
  if (get().thinkingLevel !== null) return undefined;
  const thinkingBudget = get().thinkingBudget;
  if (thinkingBudget === null) return undefined;

  const conversation = get().conversations.find((item) => item.id === conversationId);
  if (!conversation) return thinkingBudget;

  const providers = useProviderStore.getState().providers;
  const model = findModelByIds(providers, conversation.provider_id, conversation.model_id);
  if (!model) return thinkingBudget;
  return supportsReasoning(model) ? thinkingBudget : undefined;
}

function getEffectiveThinkingLevel(get: () => ConversationState, conversationId: string): string | undefined {
  const thinkingLevel = get().thinkingLevel;
  if (thinkingLevel === null) return undefined;

  const conversation = get().conversations.find((item) => item.id === conversationId);
  if (!conversation) return thinkingLevel;

  const providers = useProviderStore.getState().providers;
  const provider = providers.find((item) => item.id === conversation.provider_id);
  const model = findModelByIds(providers, conversation.provider_id, conversation.model_id);
  if (!model) return thinkingLevel;
  if (!supportsReasoning(model)) return undefined;
  const profile = resolveReasoningProfile(provider?.provider_type, model);
  const optionKey = coerceReasoningOptionKey(profile, thinkingLevel);
  return optionKey === 'default' ? undefined : optionKey;
}

/**
 * Runtime MCP fortify: keep persisted selections, but do not inject tools when
 * the effective model lacks FunctionCalling.
 */
function getEffectiveMcpServerIds(
  get: () => ConversationState,
  opts: {
    conversationId?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    mcpIds?: string[];
  } = {},
): string[] {
  const mcpIds = opts.mcpIds ?? get().enabledMcpServerIds;
  if (mcpIds.length === 0) return [];

  let providerId = opts.providerId ?? null;
  let modelId = opts.modelId ?? null;
  if ((!providerId || !modelId) && opts.conversationId) {
    const conversation = get().conversations.find((item) => item.id === opts.conversationId);
    providerId = providerId ?? conversation?.provider_id ?? null;
    modelId = modelId ?? conversation?.model_id ?? null;
  }

  const model = findModelByIds(useProviderStore.getState().providers, providerId, modelId);
  // Only strip when we positively know the model cannot call tools.
  if (model && !supportsFunctionCalling(model)) return [];
  return mcpIds;
}

const RAG_DISPLAY_TAGS = new Set(['knowledge-retrieval', 'memory-retrieval']);
const SEARCH_DISPLAY_TAGS = new Set(['web-search-query', 'web-search']);
const AQBOT_DISPLAY_TAGS = ['knowledge-retrieval', 'memory-retrieval', 'web-search-query', 'web-search'];

function readLeadingAqbotDisplayTag(content: string): { tag: string; raw: string } | null {
  const leadingWhitespace = content.match(/^\s*/)?.[0] ?? '';
  const offset = leadingWhitespace.length;
  const rest = content.slice(offset);

  for (const tag of AQBOT_DISPLAY_TAGS) {
    const openMatch = rest.match(new RegExp(`^<${tag}\\b[^>]*data-aqbot=["']1["'][^>]*>`, 'i'));
    if (!openMatch) continue;

    const closeTag = `</${tag}>`;
    const closeIndex = rest.toLowerCase().indexOf(closeTag, openMatch[0].length);
    if (closeIndex < 0) return null;

    const closeEnd = closeIndex + closeTag.length;
    const trailingWhitespace = rest.slice(closeEnd).match(/^\s*/)?.[0] ?? '';
    const raw = leadingWhitespace + rest.slice(0, closeEnd) + trailingWhitespace;
    return { tag, raw };
  }

  return null;
}

function readLeadingAqbotDisplayTags(content: string): { tags: { tag: string; raw: string }[]; body: string } {
  let remaining = content;
  const tags: { tag: string; raw: string }[] = [];

  for (;;) {
    const tag = readLeadingAqbotDisplayTag(remaining);
    if (!tag) break;
    tags.push(tag);
    remaining = remaining.slice(tag.raw.length);
  }

  return { tags, body: remaining };
}

function extractLeadingRagDisplayPrefix(content: string): string {
  let remaining = content;
  let prefix = '';

  for (;;) {
    const tag = readLeadingAqbotDisplayTag(remaining);
    if (!tag) break;
    if (RAG_DISPLAY_TAGS.has(tag.tag)) {
      prefix += tag.raw;
    }
    remaining = remaining.slice(tag.raw.length);
  }

  return prefix;
}

function stripLeadingRagDisplayTags(content: string): string {
  let remaining = content;
  let keptPrefix = '';

  for (;;) {
    const tag = readLeadingAqbotDisplayTag(remaining);
    if (!tag) break;
    if (!RAG_DISPLAY_TAGS.has(tag.tag)) {
      keptPrefix += tag.raw;
    }
    remaining = remaining.slice(tag.raw.length);
  }

  return keptPrefix + remaining;
}

function replaceLeadingSearchDisplayTags(content: string, searchDisplayTag: string): string {
  const { tags, body } = readLeadingAqbotDisplayTags(content);
  const keptPrefix = tags
    .filter(({ tag }) => !SEARCH_DISPLAY_TAGS.has(tag))
    .map(({ raw }) => raw)
    .join('');
  return `${searchDisplayTag}${keptPrefix}${body}`;
}

function mergeDbRagDisplayPrefix(dbContent: string, localContent: string): string {
  const dbPrefix = extractLeadingRagDisplayPrefix(dbContent);
  if (!dbPrefix) return localContent;
  return dbPrefix + stripLeadingRagDisplayTags(localContent);
}

function hasLeadingDisplayTag(content: string, tagName: string): boolean {
  return readLeadingAqbotDisplayTags(content).tags.some(({ tag }) => tag === tagName);
}

function insertAfterLeadingDisplayTags(content: string, rawTag: string): string {
  const { tags, body } = readLeadingAqbotDisplayTags(content);
  return tags.map(({ raw }) => raw).join('') + rawTag + body;
}

function mergeIncomingDisplayChunk(currentContent: string, incomingContent: string): string {
  const { tags, body } = readLeadingAqbotDisplayTags(incomingContent);
  const ragTags = tags.filter(({ tag }) => RAG_DISPLAY_TAGS.has(tag));

  if (ragTags.length === 0) {
    return currentContent + incomingContent;
  }

  let updated = currentContent;
  for (const { tag, raw } of ragTags) {
    const searching = tag === 'knowledge-retrieval'
      ? buildKnowledgeTag('searching')
      : buildMemoryTag('searching');
    if (updated.includes(searching)) {
      updated = updated.replace(searching, raw);
    } else if (!hasLeadingDisplayTag(updated, tag)) {
      updated = insertAfterLeadingDisplayTags(updated, raw);
    }
  }

  const nonRagPrefix = tags
    .filter(({ tag }) => !RAG_DISPLAY_TAGS.has(tag))
    .map(({ raw }) => raw)
    .join('');
  return updated + nonRagPrefix + body;
}

function buildRagDisplayTagFromSources(
  sources: RagContextRetrievedEvent['sources'],
  errors: RagContextRetrievedEvent['errors'] = [],
  emptyResults: RagContextRetrievedEvent['empty_results'] = [],
): string {
  const knowledgeSources = sources.filter(s => s.source_type === 'knowledge');
  const memorySources = sources.filter(s => s.source_type === 'memory');
  const knowledgeErrors = errors.filter(e => e.source_type === 'knowledge');
  const memoryErrors = errors.filter(e => e.source_type === 'memory');
  const knowledgeEmpty = emptyResults.find(e => e.source_type === 'knowledge');
  const memoryEmpty = emptyResults.find(e => e.source_type === 'memory');
  return [
    knowledgeSources.length > 0
      ? buildKnowledgeTag('done', knowledgeSources)
      : knowledgeErrors.length > 0
        ? buildKnowledgeTag('error', knowledgeErrors[0].message)
        : knowledgeEmpty
          ? buildKnowledgeTag('empty', knowledgeEmpty.reason)
          : '',
    memorySources.length > 0
      ? buildMemoryTag('done', memorySources)
      : memoryErrors.length > 0
        ? buildMemoryTag('error', memoryErrors[0].message)
        : memoryEmpty
          ? buildMemoryTag('empty', memoryEmpty.reason)
          : '',
  ].join('');
}

function collectRagDisplayTargetIds(
  messages: Message[],
  conversationId: string,
  requestedIds: Set<string>,
): string[] {
  const kbSearching = buildKnowledgeTag('searching');
  const memSearching = buildMemoryTag('searching');
  const targets = new Set<string>(requestedIds);

  for (const message of messages) {
    if (
      message.conversation_id !== conversationId
      || message.role !== 'assistant'
      || message.status !== 'partial'
    ) {
      continue;
    }
    if (
      message.content.includes(kbSearching)
      || message.content.includes(memSearching)
      || hasLeadingDisplayTag(message.content, 'knowledge-retrieval')
      || hasLeadingDisplayTag(message.content, 'memory-retrieval')
    ) {
      targets.add(message.id);
    }
  }

  return Array.from(targets);
}

function mergePreservedMessages(
  pageMessages: Message[],
  preserveMessageIds: string[],
  currentMessages: Message[],
): Message[] {
  if (preserveMessageIds.length === 0) {
    return pageMessages;
  }

  const merged = new Map(pageMessages.map((message) => [message.id, message]));
  for (const messageId of preserveMessageIds) {
    const localMessage = currentMessages.find((message) => message.id === messageId);
    if (localMessage) {
      const dbMessage = merged.get(messageId);
      if (dbMessage) {
        // For just-completed streams, local content is authoritative:
        // the DB save may not have finished within the fetchMessages delay,
        // so the DB row may still hold the empty placeholder content.
        // Keep local content + status but merge in DB metadata (token counts, etc.).
        // RAG display tags are created before streaming and persisted in the DB;
        // if the frontend missed the retrieval event, preserve local text while
        // restoring the persisted retrieval prefix.
        merged.set(messageId, {
          ...dbMessage,
          content: mergeDbRagDisplayPrefix(dbMessage.content, localMessage.content),
          status: localMessage.status,
        });
      } else {
        merged.set(messageId, localMessage);
      }
    }
  }

  return Array.from(merged.values()).sort(
    (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
  );
}

function mergeOlderPages(olderMessages: Message[], currentMessages: Message[]): Message[] {
  const merged = new Map<string, Message>();
  for (const message of olderMessages) {
    merged.set(message.id, message);
  }
  for (const message of currentMessages) {
    merged.set(message.id, message);
  }
  return Array.from(merged.values()).sort(
    (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
  );
}

function mergeConversationCollections(
  conversations: Conversation[],
  archivedConversations: Conversation[],
  updated: Conversation,
) {
  return {
    conversations: conversations.map((conversation) => (
      conversation.id === updated.id ? updated : conversation
    )),
    archivedConversations: archivedConversations.map((conversation) => (
      conversation.id === updated.id ? updated : conversation
    )),
  };
}

function isSameProviderModel(left: Message, right: Message): boolean {
  return left.provider_id === right.provider_id && left.model_id === right.model_id;
}

function isTemporaryMessageId(messageId: string | null | undefined): messageId is string {
  return typeof messageId === 'string' && messageId.startsWith('temp-');
}

function collectActiveStreamingMessageIds(
  state: ConversationState,
  conversationId: string | null | undefined = state.streamingConversationId,
): string[] {
  if (!state.streaming || state.streamingConversationId !== conversationId) {
    return [];
  }

  return [
    state.streamingMessageId,
    _streamBuffer?.messageId,
    _streamBuffer?.resolvedId,
    _pendingUiChunk?.messageId,
  ].filter((messageId): messageId is string => (
    typeof messageId === 'string' && messageId.length > 0 && !isTemporaryMessageId(messageId)
  ));
}

function rekeyMessageDisplayMap(
  displayByMessageId: Record<string, string>,
  fromMessageId: string | null | undefined,
  toMessageId: string | null | undefined,
): Record<string, string> {
  if (
    !fromMessageId
    || !toMessageId
    || fromMessageId === toMessageId
    || !displayByMessageId[fromMessageId]
  ) {
    return displayByMessageId;
  }

  const next = { ...displayByMessageId };
  if (!next[toMessageId]) {
    next[toMessageId] = next[fromMessageId];
  }
  delete next[fromMessageId];
  return next;
}

function rememberPendingLocalVersionSelection(
  conversationId: string,
  parentMessageId: string,
  message: Message,
) {
  _pendingLocalVersionSelections.set(parentMessageId, {
    conversationId,
    parentMessageId,
    tempMessageId: message.id,
    providerId: message.provider_id ?? null,
    modelId: message.model_id ?? null,
    versionIndex: message.version_index,
    createdAt: message.created_at,
  });
}

function findResolvedVersionForPendingSelection(
  pending: PendingLocalVersionSelection,
  versions: Message[],
): Message | null {
  const candidates = versions.filter((version) =>
    !isTemporaryMessageId(version.id)
    && version.parent_message_id === pending.parentMessageId
    && version.role === 'assistant'
    && (version.provider_id ?? null) === pending.providerId
    && (version.model_id ?? null) === pending.modelId
    && version.version_index >= pending.versionIndex
  );

  return [...candidates].sort((left, right) =>
    right.version_index - left.version_index
    || right.created_at - left.created_at
    || right.id.localeCompare(left.id)
  )[0] ?? null;
}

function resolvePendingLocalVersionSelection(
  set: ConversationStoreSet,
  get: () => ConversationState,
  pending: PendingLocalVersionSelection,
  resolvedMessageId: string,
) {
  if (isTemporaryMessageId(resolvedMessageId)) return;

  const current = _pendingLocalVersionSelections.get(pending.parentMessageId);
  if (!current || current.tempMessageId !== pending.tempMessageId) return;

  _pendingLocalVersionSelections.delete(pending.parentMessageId);
  set((s) => ({
    messages: s.messages.map((message) => {
      if (message.parent_message_id !== pending.parentMessageId || message.role !== 'assistant') {
        return message;
      }
      return { ...message, is_active: message.id === resolvedMessageId };
    }),
  }));

  if (_isMultiModelActive) return;

  invoke('switch_message_version', {
    conversationId: pending.conversationId,
    parentMessageId: pending.parentMessageId,
    messageId: resolvedMessageId,
  }).catch((error) => {
    if (get().activeConversationId === pending.conversationId) {
      set({ error: String(error) });
    }
  });
}

function resolveHydratedStreamingMessageId(placeholder: Message, versions: Message[]): string | null {
  const activePartial = versions.find(
    (version) => isSameProviderModel(version, placeholder) && version.is_active && version.status === 'partial',
  );
  if (activePartial) {
    return activePartial.id;
  }

  if (!placeholder.is_active) {
    const partialVersions = versions
      .filter((version) => isSameProviderModel(version, placeholder) && version.status === 'partial')
      .sort((left, right) =>
        right.version_index - left.version_index
        || right.created_at - left.created_at
        || right.id.localeCompare(left.id),
      );
    return partialVersions[0]?.id ?? null;
  }

  return null;
}

function preferenceStateMatches(
  state: ConversationPreferenceState,
  expected: Partial<ConversationPreferenceState>,
): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const currentValue = state[key as keyof ConversationPreferenceState];
    if (Array.isArray(currentValue) && Array.isArray(value)) {
      return JSON.stringify(currentValue) === JSON.stringify(value);
    }
    return currentValue === value;
  });
}

async function persistConversationPreferences(
  set: (partial: Partial<ConversationState> | ((state: ConversationState) => Partial<ConversationState>)) => void,
  conversationId: string,
  input: Partial<UpdateConversationInput>,
  optimisticState: Partial<ConversationPreferenceState>,
  rollbackState: Partial<ConversationPreferenceState>,
) {
  const requestSeq = nextConversationPreferenceSaveSeq(conversationId);
  try {
    const updated = await invoke<Conversation>('update_conversation', { id: conversationId, input });
    if (!isLatestConversationPreferenceSave(conversationId, requestSeq)) return;

    set((state) => ({
      ...mergeConversationCollections(state.conversations, state.archivedConversations, updated),
      conversationsMeta: mutateConversationsMeta(state.conversationsMeta),
      ...(state.activeConversationId === conversationId
        ? conversationPreferenceStateFromConversation(updated)
        : {}),
      error: null,
    }));
  } catch (error) {
    if (!isLatestConversationPreferenceSave(conversationId, requestSeq)) return;

    set((state) => {
      if (
        state.activeConversationId !== conversationId
        || !preferenceStateMatches({
          searchEnabled: state.searchEnabled,
          searchProviderId: state.searchProviderId,
          thinkingBudget: state.thinkingBudget,
          thinkingLevel: state.thinkingLevel,
          enabledMcpServerIds: state.enabledMcpServerIds,
          enabledKnowledgeBaseIds: state.enabledKnowledgeBaseIds,
          enabledMemoryNamespaceIds: state.enabledMemoryNamespaceIds,
          multiModelTargets: state.multiModelTargets,
          multiModelContinuationMode: state.multiModelContinuationMode,
        }, optimisticState)
      ) {
        return { error: String(error) };
      }

      return {
        ...rollbackState,
        error: String(error),
      };
    });
  }
}

function sanitizeActiveConversationCapabilityIds(
  set: ConversationStoreSet,
  get: () => ConversationState,
  conversationId: string,
) {
  const previous = {
    enabledMcpServerIds: get().enabledMcpServerIds,
    enabledKnowledgeBaseIds: get().enabledKnowledgeBaseIds,
    enabledMemoryNamespaceIds: get().enabledMemoryNamespaceIds,
  };
  const next = resolveValidConversationCapabilityIds(previous);
  const changed =
    !sameStringList(previous.enabledMcpServerIds, next.enabledMcpServerIds)
    || !sameStringList(previous.enabledKnowledgeBaseIds, next.enabledKnowledgeBaseIds)
    || !sameStringList(previous.enabledMemoryNamespaceIds, next.enabledMemoryNamespaceIds);

  if (!changed) return next;

  set((state) => ({
    enabledMcpServerIds: next.enabledMcpServerIds,
    enabledKnowledgeBaseIds: next.enabledKnowledgeBaseIds,
    enabledMemoryNamespaceIds: next.enabledMemoryNamespaceIds,
    conversationsMeta: mutateConversationsMeta(state.conversationsMeta),
    conversations: state.conversations.map((conversation) => (
      conversation.id === conversationId
        ? {
          ...conversation,
          enabled_mcp_server_ids: next.enabledMcpServerIds,
          enabled_knowledge_base_ids: next.enabledKnowledgeBaseIds,
          enabled_memory_namespace_ids: next.enabledMemoryNamespaceIds,
        }
        : conversation
    )),
    archivedConversations: state.archivedConversations.map((conversation) => (
      conversation.id === conversationId
        ? {
          ...conversation,
          enabled_mcp_server_ids: next.enabledMcpServerIds,
          enabled_knowledge_base_ids: next.enabledKnowledgeBaseIds,
          enabled_memory_namespace_ids: next.enabledMemoryNamespaceIds,
        }
        : conversation
    )),
  }));

  void persistConversationPreferences(
    set,
    conversationId,
    {
      enabled_mcp_server_ids: next.enabledMcpServerIds,
      enabled_knowledge_base_ids: next.enabledKnowledgeBaseIds,
      enabled_memory_namespace_ids: next.enabledMemoryNamespaceIds,
    },
    next,
    previous,
  );

  return next;
}

export interface ConversationState {
  conversations: Conversation[];
  conversationsMeta: ResourceMeta;
  messageVersionGroups: Record<string, MessageVersionGroupResource>;
  activeConversationId: string | null;
  messages: Message[];
  ragDisplayByMessageId: Record<string, string>;
  searchDisplayByMessageId: Record<string, string>;
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  totalActiveCount: number;
  oldestLoadedMessageId: string | null;
  newestLoadedMessageId: string | null;
  streaming: boolean;
  /** Stream owned by another window of the same conversation. */
  observedStream: (ConversationStreamSyncState & { conversationId: string }) | null;
  compressingConversationId: string | null;
  /** Incremented to request ChatView open the compression summary modal. */
  openCompressionSummaryToken: number;
  streamingMessageId: string | null;
  streamingConversationId: string | null;
  activeStreamId: string | null;
  streamActivityByMessageId: Record<string, StreamActivity>;
  thinkingActiveMessageIds: Set<string>;
  error: string | null;
  /** Whether web search is enabled for messages in the active conversation */
  searchEnabled: boolean;
  /** Which search provider to use */
  searchProviderId: string | null;
  setSearchEnabled: (enabled: boolean) => void;
  setSearchProviderId: (id: string | null) => void;
  /** MCP servers enabled for the active conversation */
  enabledMcpServerIds: string[];
  setEnabledMcpServerIds: (ids: string[]) => void;
  toggleMcpServer: (id: string) => void;
  /** Thinking setting for reasoning-capable models (null = provider default, 0 = disabled) */
  thinkingBudget: number | null;
  setThinkingBudget: (budget: number | null) => void;
  /** Reasoning level key for model-specific reasoning profiles (null = provider default) */
  thinkingLevel: string | null;
  setThinkingLevel: (level: string | null) => void;
  /** Knowledge base IDs enabled for the active conversation */
  enabledKnowledgeBaseIds: string[];
  setEnabledKnowledgeBaseIds: (ids: string[]) => void;
  toggleKnowledgeBase: (id: string) => void;
  /** Memory namespace IDs enabled for the active conversation */
  enabledMemoryNamespaceIds: string[];
  setEnabledMemoryNamespaceIds: (ids: string[]) => void;
  toggleMemoryNamespace: (id: string) => void;
  /** Ordered multi-model targets for the active conversation. */
  multiModelTargets: MultiModelTarget[];
  setMultiModelTargets: (targets: MultiModelTarget[]) => void;
  /** Follow-up history strategy for multi-model replies. */
  multiModelContinuationMode: MultiModelContinuationMode;
  setMultiModelContinuationMode: (mode: MultiModelContinuationMode) => void;
  /** Insert a context-clear marker into the conversation */
  insertContextClear: () => Promise<void>;
  /** Remove a context-clear marker */
  removeContextClear: (messageId: string) => Promise<void>;
  /** Clear all messages in the active conversation */
  clearAllMessages: () => Promise<void>;
  /** Clear the first N user-rooted rounds in the active conversation */
  clearFirstRounds: (rounds: number) => Promise<void>;
  /** Manually compress the current conversation context */
  compressContext: () => Promise<void>;
  /** Get the compression summary for a conversation */
  getCompressionSummary: (conversationId: string) => Promise<ConversationSummary | null>;
  /** Re-run compression on stored source text with current global prompt */
  retryCompression: () => Promise<ConversationSummary | null>;
  /** Get server-side context usage for a conversation */
  getContextUsage: (conversationId: string) => Promise<ContextUsage | null>;
  /** Delete the compression summary and all marker messages */
  deleteCompression: () => Promise<void>;
  /** Ask ChatView to open the compression summary modal for the active conversation */
  requestOpenCompressionSummary: () => void;
  ensureConversationsLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateConversations: (reason: ResourceInvalidationReason) => void;
  fetchConversations: () => Promise<void>;
  reorderConversations: (categoryId: string | null, conversationIds: string[]) => Promise<void>;
  setActiveConversation: (id: string | null) => void;
  createConversation: (
    title: string,
    modelId: string,
    providerId: string,
    options?: { categoryId?: string | null },
  ) => Promise<Conversation>;
  updateConversation: (id: string, input: UpdateConversationInput) => Promise<void>;
  setConversationMultiModelDisplayMode: (
    conversationId: string,
    mode: MultiModelDisplayMode | null,
  ) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  branchConversation: (conversationId: string, untilMessageId: string, asChild: boolean, title?: string) => Promise<Conversation>;
  togglePin: (id: string) => Promise<void>;
  setConversationTabPinned: (id: string, pinned: boolean) => Promise<Conversation>;
  toggleArchive: (id: string) => Promise<void>;
  archivedConversations: Conversation[];
  fetchArchivedConversations: () => Promise<void>;
  batchDelete: (ids: string[]) => Promise<void>;
  batchArchive: (ids: string[]) => Promise<void>;
  batchMoveToCategory: (ids: string[], categoryId: string | null) => Promise<number>;
  sendMessage: (content: string, attachments?: AttachmentInput[], searchProviderId?: string | null) => Promise<Message | null>;
  /** Send a message in agent mode (non-streaming MVP) */
  sendAgentMessage: (content: string, attachments?: AttachmentInput[]) => Promise<void>;
  regenerateMessage: (targetMessageId?: string) => Promise<Message>;
  regenerateWithModel: (
    targetMessageId: string,
    providerId: string,
    modelId: string,
    options?: { activate?: boolean },
  ) => Promise<Message>;
  deleteMessage: (messageId: string) => Promise<void>;
  fetchMessages: (conversationId: string, preserveMessageIds?: string[], options?: { setLoading?: boolean }) => Promise<void>;
  loadOlderMessages: (limit?: number) => Promise<void>;
  loadNewerMessages: (limit?: number) => Promise<void>;
  loadMessagesAround: (messageId: string, beforeLimit?: number, afterLimit?: number) => Promise<void>;
  searchConversations: (query: string) => Promise<ConversationSearchResult[]>;
  startStreamListening: () => Promise<void>;
  stopStreamListening: () => void;
  cancelCurrentStream: () => void;
  applyRemoteConversationSync: (payload: {
    originWindow: string;
    conversationId: string;
    kind?: string;
    stream?: ConversationStreamSyncState;
  }) => Promise<void>;
  switchMessageVersion: (conversationId: string, parentMessageId: string, messageId: string) => Promise<void>;
  listMessageVersions: (conversationId: string, parentMessageId: string) => Promise<Message[]>;
  listMessageVersionsBatch: (conversationId: string, parentMessageIds: string[]) => Promise<Record<string, Message[]>>;
  ensureMessageVersionGroupsLoaded: (
    conversationId: string,
    parentMessageIds: string[],
    options?: { force?: boolean },
  ) => Promise<void>;
  invalidateMessageVersionGroups: (conversationId: string, parentMessageIds: string[]) => void;
  applyMessageVersionSnapshot: (
    conversationId: string,
    parentMessageId: string,
    versions: Message[],
    activeMessageId?: string | null,
  ) => void;
  hydrateMessageVersions: (parentMessageId: string, versions: Message[], activeMessageId?: string | null) => void;
  updateMessageContent: (messageId: string, content: string) => Promise<void>;
  deleteMessageGroup: (conversationId: string, userMessageId: string) => Promise<void>;
  workspaceSnapshot: ConversationWorkspaceSnapshot | null;
  loadWorkspaceSnapshot: (conversationId: string) => Promise<ConversationWorkspaceSnapshot | null>;
  updateWorkspaceSnapshot: (conversationId: string, snapshot: Partial<ConversationWorkspaceSnapshot>) => Promise<void>;
  forkConversation: (conversationId: string, fromMessageId?: string) => Promise<ConversationBranch | null>;
  compareResponses: (leftMessageId: string, rightMessageId: string) => Promise<CompareResponsesResult | null>;
  /** Conversation ID currently generating an AI title (null if none) */
  titleGeneratingConversationId: string | null;
  /** Regenerate the title of a conversation using AI */
  regenerateTitle: (conversationId: string) => Promise<void>;
  /** Companion models pending or currently streaming (for multi-model simultaneous response) */
  pendingCompanionModels: MultiModelTarget[];
  /** User message ID of the current multi-model request (for scoping UI indicators) */
  multiModelParentId: string | null;
  /** Message IDs of models that have completed their streams (for per-model loading indicators) */
  multiModelDoneMessageIds: string[];
  /** Send a message and generate responses from multiple companion models */
  sendMultiModelMessage: (input: SendMultiModelMessageInput) => Promise<void>;
  /** Pending prompt text from welcome cards — InputArea picks it up and sends with companion awareness */
  pendingPromptText: string | null;
  setPendingPromptText: (text: string | null) => void;
}

export function isObservedStreamingFor(
  state: Pick<ConversationState, 'observedStream' | 'activeConversationId'>,
  conversationId: string | null = state.activeConversationId,
): boolean {
  return Boolean(
    conversationId
    && state.observedStream?.streaming
    && state.observedStream.conversationId === conversationId
  );
}

export function selectUiStreaming(
  state: Pick<ConversationState, 'streaming' | 'observedStream' | 'activeConversationId'>,
): boolean {
  return state.streaming || isObservedStreamingFor(state);
}

export function selectUiStreamingMessageId(
  state: Pick<ConversationState, 'streaming' | 'streamingMessageId' | 'observedStream' | 'activeConversationId'>,
): string | null {
  if (state.streaming) return state.streamingMessageId;
  if (isObservedStreamingFor(state)) return state.observedStream?.streamingMessageId ?? null;
  return state.streamingMessageId;
}

export function selectUiStreamingConversationId(
  state: Pick<ConversationState, 'streaming' | 'streamingConversationId' | 'observedStream' | 'activeConversationId'>,
): string | null {
  if (state.streaming) return state.streamingConversationId;
  if (isObservedStreamingFor(state)) return state.observedStream?.conversationId ?? null;
  return state.streamingConversationId;
}

export function selectUiMultiModelParentId(
  state: Pick<ConversationState, 'streaming' | 'multiModelParentId' | 'observedStream' | 'activeConversationId'>,
): string | null {
  if (state.streaming || !isObservedStreamingFor(state)) return state.multiModelParentId;
  return state.observedStream?.multiModelParentId ?? state.multiModelParentId;
}

export function selectUiPendingCompanionModels(
  state: Pick<ConversationState, 'streaming' | 'pendingCompanionModels' | 'observedStream' | 'activeConversationId'>,
): ConversationState['pendingCompanionModels'] {
  if (state.streaming || !isObservedStreamingFor(state)) return state.pendingCompanionModels;
  return state.observedStream?.pendingCompanionModels ?? state.pendingCompanionModels;
}

export function selectUiMultiModelDoneMessageIds(
  state: Pick<ConversationState, 'streaming' | 'multiModelDoneMessageIds' | 'observedStream' | 'activeConversationId'>,
): string[] {
  if (state.streaming || !isObservedStreamingFor(state)) return state.multiModelDoneMessageIds;
  return state.observedStream?.multiModelDoneMessageIds ?? state.multiModelDoneMessageIds;
}

export function snapshotStreamSyncState(
  state: Pick<
    ConversationState,
    | 'streaming'
    | 'streamingMessageId'
    | 'multiModelParentId'
    | 'pendingCompanionModels'
    | 'multiModelDoneMessageIds'
  >,
): ConversationStreamSyncState {
  return {
    streaming: state.streaming,
    streamingMessageId: state.streamingMessageId,
    multiModelParentId: state.multiModelParentId,
    pendingCompanionModels: [...state.pendingCompanionModels],
    multiModelDoneMessageIds: [...state.multiModelDoneMessageIds],
  };
}

export type { MultiModelTarget };

export interface MessageVersionGroupResource {
  conversationId: string;
  parentMessageId: string;
  /** Exact persisted membership from the most recent successful query. */
  versions: Message[];
  error: string | null;
  /** A non-null loadedAt means versions remain authoritative during reload/error states. */
  meta: ResourceMeta;
}

export function hasAuthoritativeMessageVersionSnapshot(
  resource: MessageVersionGroupResource | null | undefined,
): resource is MessageVersionGroupResource {
  return resource?.meta.loadedAt != null;
}

export function getMessageVersionGroupResourceKey(
  conversationId: string,
  parentMessageId: string,
): string {
  return JSON.stringify([conversationId, parentMessageId]);
}

export interface SendMultiModelMessageInput {
  content: string;
  targetModels: MultiModelTarget[];
  historyMode?: MultiModelContinuationMode;
  attachments?: AttachmentInput[];
  searchProviderId?: string | null;
}

function appendStreamChunk(
  set: ConversationStoreSet,
  get: () => ConversationState,
  messageId: string,
  content: string | null,
  conversationId: string,
  modelId?: string,
  providerId?: string,
) {
  // Accumulate into stream buffer only in single-stream mode
  // (parallel multi-model streams would corrupt the shared buffer)
  if (!_isMultiModelActive && get().streaming) {
    if (!_streamBuffer || _streamBuffer.conversationId !== conversationId) {
      _streamBuffer = { messageId, conversationId, content: _streamPrefix, resolvedId: null, thinking: null };
      _streamPrefix = ''; // consumed
    }
    _streamBuffer.content = mergeIncomingDisplayChunk(_streamBuffer.content, content ?? '');
    // Track ID resolution (placeholder → real ID)
    if (_streamBuffer.messageId !== messageId && !_streamBuffer.resolvedId) {
      _streamBuffer.resolvedId = messageId;
    }
  }

  // Only update messages in UI if this is the active conversation
  if (get().activeConversationId !== conversationId) {
    return;
  }

  if (_pendingUiChunk && (
    _pendingUiChunk.conversationId !== conversationId
    || _pendingUiChunk.messageId !== messageId
  )) {
    flushPendingStreamChunk(set, get);
  }

  if (!_pendingUiChunk) {
    _pendingUiChunk = {
      messageId,
      conversationId,
      content: '',
      modelId,
      providerId,
    };
  }

  _pendingUiChunk.content += content ?? '';

  if (_streamUiFlushTimer === null) {
    const hasVisibleLiveContent = Boolean(getLiveStreamContent(messageId));
    const delay = hasVisibleLiveContent ? STREAM_UI_FLUSH_INTERVAL_MS : STREAM_FIRST_UI_FLUSH_DELAY_MS;
    _streamUiFlushTimer = setTimeout(() => {
      flushPendingStreamChunk(set, get);
    }, delay);
  }
}

function flushPendingStreamChunk(
  set: ConversationStoreSet,
  get: () => ConversationState,
) {
  if (_streamUiFlushTimer !== null) {
    clearTimeout(_streamUiFlushTimer);
    _streamUiFlushTimer = null;
  }

  const pending = _pendingUiChunk;
  _pendingUiChunk = null;
  if (!pending) return;

  const { messageId, content, conversationId, modelId: chunkModelId, providerId: chunkProviderId } = pending;
  if (get().activeConversationId !== conversationId) {
    return;
  }

  updateStreamActivityForChunk(set, messageId, chunkModelId, chunkProviderId);

  const state = get();
  const resolvedPendingSelections: Array<{ pending: PendingLocalVersionSelection; messageId: string }> = [];

  // 1. Direct ID match: update the per-message live stream store only.
  // Model/provider enrichment is structural, so it may still touch messages.
  const existing = state.messages.find((m) => m.id === messageId);
  if (existing) {
    appendLiveStreamContent(messageId, content ?? '', existing.content);
    if (
      (!existing.model_id && chunkModelId)
      || (!existing.provider_id && chunkProviderId)
    ) {
      set((s) => ({
        messages: s.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                model_id: message.model_id ?? chunkModelId ?? null,
                provider_id: message.provider_id ?? chunkProviderId ?? null,
              }
            : message
        ),
      }));
    }
    return;
  }

  // 2. ID mismatch but placeholder exists — replace placeholder ID with real one.
  // Content stays in the live stream store so token-level updates do not drive
  // the entire messages array.
  if (state.streamingMessageId && state.streamingMessageId !== messageId) {
    if (!_isMultiModelActive || state.streamingMessageId.startsWith('temp-')) {
      const placeholder = state.messages.find((m) => m.id === state.streamingMessageId);
      if (placeholder) {
        const baseContent = getLiveStreamContent(messageId)
          ?? getLiveStreamContent(state.streamingMessageId)
          ?? placeholder.content;
        setLiveStreamContent(messageId, mergeIncomingDisplayChunk(baseContent, content ?? ''));
        clearLiveStreamContent(state.streamingMessageId);

        const pendingSelection = placeholder.parent_message_id
          ? _pendingLocalVersionSelections.get(placeholder.parent_message_id)
          : null;
        if (pendingSelection?.tempMessageId === placeholder.id) {
          resolvedPendingSelections.push({ pending: pendingSelection, messageId });
        }

        set((s) => ({
          messages: s.messages.map((message) =>
            message.id === state.streamingMessageId
              ? {
                  ...message,
                  id: messageId,
                  model_id: message.model_id ?? chunkModelId ?? null,
                  provider_id: message.provider_id ?? chunkProviderId ?? null,
                }
              : message
          ),
          ragDisplayByMessageId: rekeyMessageDisplayMap(
            s.ragDisplayByMessageId,
            state.streamingMessageId,
            messageId,
          ),
          searchDisplayByMessageId: rekeyMessageDisplayMap(
            s.searchDisplayByMessageId,
            state.streamingMessageId,
            messageId,
          ),
          streamingMessageId: messageId,
        }));
        for (const resolvedPendingSelection of resolvedPendingSelections) {
          resolvePendingLocalVersionSelection(
            set,
            get,
            resolvedPendingSelection.pending,
            resolvedPendingSelection.messageId,
          );
        }
        return;
      }
    }
  }

  // 3. No placeholder found — create a new assistant message once, then keep
  // subsequent token content in the live stream store.
  const isMultiModel = _isMultiModelActive;
  const parentMessageId = isMultiModel ? state.multiModelParentId : null;
  const pendingSelection = parentMessageId ? _pendingLocalVersionSelections.get(parentMessageId) : null;
  const pendingPlaceholder = pendingSelection
    ? state.messages.find((message) =>
        message.id === pendingSelection.tempMessageId
        && message.parent_message_id === parentMessageId
        && message.role === 'assistant'
        && (message.provider_id ?? null) === (chunkProviderId ?? null)
        && (message.model_id ?? null) === (chunkModelId ?? null)
      )
    : null;
  const bufferedContent = !isMultiModel
    && _streamBuffer
    && _streamBuffer.conversationId === conversationId
    && (_streamBuffer.messageId === messageId || _streamBuffer.resolvedId === messageId)
    ? _streamBuffer.content
    : undefined;
  const nextContent = bufferedContent
    ?? appendLiveStreamContent(messageId, content ?? '', pendingPlaceholder?.content ?? '');
  if (bufferedContent !== undefined) {
    setLiveStreamContent(messageId, bufferedContent);
  }
  const newMessage: Message = {
    id: messageId,
    conversation_id: conversationId,
    role: 'assistant',
    content: pendingPlaceholder?.content ?? nextContent,
    provider_id: chunkProviderId ?? null,
    model_id: chunkModelId ?? null,
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: pendingPlaceholder?.created_at ?? Date.now(),
    parent_message_id: parentMessageId,
    version_index: pendingPlaceholder?.version_index
      ?? plannedVersionIndexForTarget(state.pendingCompanionModels, chunkProviderId, chunkModelId)
      ?? 0,
    is_active: pendingPlaceholder?.is_active ?? !isMultiModel,
    status: 'partial',
  };

  if (pendingSelection && pendingPlaceholder) {
    resolvedPendingSelections.push({ pending: pendingSelection, messageId });
    set((s) => ({
      messages: s.messages.map((message) =>
        message.id === pendingPlaceholder.id ? newMessage : message
      ),
      streamingMessageId: isMultiModel ? s.streamingMessageId : messageId,
    }));
  } else {
    set((s) => ({
      messages: [...s.messages, newMessage],
      streamingMessageId: isMultiModel ? s.streamingMessageId : messageId,
    }));
  }

  for (const resolvedPendingSelection of resolvedPendingSelections) {
    resolvePendingLocalVersionSelection(
      set,
      get,
      resolvedPendingSelection.pending,
      resolvedPendingSelection.messageId,
    );
  }
}

export interface ConversationRuntime {
  unlisten: UnlistenFn | null;
  listenerGen: number;
  streamBuffer: StreamBuffer | null;
  streamPrefix: string;
  pendingConversationRefresh: Set<string>;
  pendingUiChunk: PendingUiChunk | null;
  streamUiFlushTimer: ReturnType<typeof setTimeout> | null;
  activeMessageLoadSeq: number;
  agentStreamSeq: number;
  activeAgentCancel: (() => void) | null;
  conversationsRequest: { revision: number; promise: Promise<void> } | null;
  conversationDisplayModeMutations: Map<string, ConversationDisplayModeMutation>;
  messageVersionGroupRequests: Map<string, Promise<void>>;
  messageVersionGroupRevision: number;
  multiModelTotalRemaining: number;
  multiModelDoneResolve: (() => void) | null;
  isMultiModelActive: boolean;
  multiModelRunId: number;
  multiModelFirstTarget: MultiModelTarget | null;
  multiModelFirstMessageId: string | null;
  multiModelHistoryMode: MultiModelContinuationMode;
  userManuallySelectedVersion: boolean;
  multiModelStreamIds: Set<string>;
  pendingLocalVersionSelections: Map<string, PendingLocalVersionSelection>;
}

export interface ConversationDisplayModeMutation {
  tail: Promise<void>;
  latestSequence: number;
  confirmedMode: MultiModelDisplayMode | null;
}

/** Shared mutable runtime used by both action slices and stream helpers. */
export const conversationRuntime: ConversationRuntime = {
  get unlisten() { return _unlisten; },
  set unlisten(value) { _unlisten = value; },
  get listenerGen() { return _listenerGen; },
  set listenerGen(value) { _listenerGen = value; },
  get streamBuffer() { return _streamBuffer; },
  set streamBuffer(value) { _streamBuffer = value; },
  get streamPrefix() { return _streamPrefix; },
  set streamPrefix(value) { _streamPrefix = value; },
  pendingConversationRefresh: _pendingConversationRefresh,
  get pendingUiChunk() { return _pendingUiChunk; },
  set pendingUiChunk(value) { _pendingUiChunk = value; },
  get streamUiFlushTimer() { return _streamUiFlushTimer; },
  set streamUiFlushTimer(value) { _streamUiFlushTimer = value; },
  get activeMessageLoadSeq() { return _activeMessageLoadSeq; },
  set activeMessageLoadSeq(value) { _activeMessageLoadSeq = value; },
  get agentStreamSeq() { return _agentStreamSeq; },
  set agentStreamSeq(value) { _agentStreamSeq = value; },
  get activeAgentCancel() { return _activeAgentCancel; },
  set activeAgentCancel(value) { _activeAgentCancel = value; },
  get conversationsRequest() { return _conversationsRequest; },
  set conversationsRequest(value) { _conversationsRequest = value; },
  conversationDisplayModeMutations: _conversationDisplayModeMutations,
  messageVersionGroupRequests: _messageVersionGroupRequests,
  get messageVersionGroupRevision() { return _messageVersionGroupRevision; },
  set messageVersionGroupRevision(value) { _messageVersionGroupRevision = value; },
  get multiModelTotalRemaining() { return _multiModelTotalRemaining; },
  set multiModelTotalRemaining(value) { _multiModelTotalRemaining = value; },
  get multiModelDoneResolve() { return _multiModelDoneResolve; },
  set multiModelDoneResolve(value) { _multiModelDoneResolve = value; },
  get isMultiModelActive() { return _isMultiModelActive; },
  set isMultiModelActive(value) { _isMultiModelActive = value; },
  get multiModelRunId() { return _multiModelRunId; },
  set multiModelRunId(value) { _multiModelRunId = value; },
  get multiModelFirstTarget() { return _multiModelFirstTarget; },
  set multiModelFirstTarget(value) { _multiModelFirstTarget = value; },
  get multiModelFirstMessageId() { return _multiModelFirstMessageId; },
  set multiModelFirstMessageId(value) { _multiModelFirstMessageId = value; },
  get multiModelHistoryMode() { return _multiModelHistoryMode; },
  set multiModelHistoryMode(value) { _multiModelHistoryMode = value; },
  get userManuallySelectedVersion() { return _userManuallySelectedVersion; },
  set userManuallySelectedVersion(value) { _userManuallySelectedVersion = value; },
  multiModelStreamIds: _multiModelStreamIds,
  pendingLocalVersionSelections: _pendingLocalVersionSelections,
};

export {
  AGENT_STREAM_UI_FLUSH_INTERVAL_MS,
  CONVERSATIONS_RESOURCE_KEY,
  appendStreamChunk,
  boundMessageWindow,
  buildRagDisplayTagFromSources,
  cacheMessageState,
  categoryTemplateUpdateFromCategory,
  collectActiveStreamingMessageIds,
  collectRagDisplayTargetIds,
  conversationPreferenceStateFromConversation,
  conversationPreferenceUpdateFromState,
  createStreamActivity,
  createStreamId,
  emptyConversationPreferenceUpdate,
  findResolvedVersionForPendingSelection,
  flushPendingStreamChunk,
  getActiveMessageEdges,
  getEffectiveMcpServerIds,
  getEffectiveThinkingBudget,
  getEffectiveThinkingLevel,
  isActiveStreamExistsError,
  isCurrentStreamEvent,
  isTemporaryMessageId,
  materializeLiveStreamContent,
  mergeConversationCollections,
  mergeDbRagDisplayPrefix,
  mergeOlderPages,
  mergePreservedMessages,
  mutateConversationsMeta,
  persistConversationPreferences,
  readCachedMessageState,
  rekeyMessageDisplayMap,
  rememberPendingLocalVersionSelection,
  removeStreamActivities,
  replaceLeadingSearchDisplayTags,
  resolveHydratedStreamingMessageId,
  resolvePendingLocalVersionSelection,
  restoreActiveStreamBuffer,
  sanitizeActiveConversationCapabilityIds,
  validateCachedMessageState,
};
