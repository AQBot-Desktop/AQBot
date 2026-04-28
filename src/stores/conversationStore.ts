import { create } from 'zustand';
import { invoke, listen, type UnlistenFn, isTauri } from '@/lib/invoke';
import { supportsReasoning, findModelByIds } from '@/lib/modelCapabilities';
import {
  applyMultiModelStreamError,
  hasMultipleModelVersions,
  insertModelVersionPlaceholder,
  mergeAssistantVersionGroup,
  mergeAssistantVersionsAfterSwitch,
  selectNextAssistantVersion,
} from '@/lib/chatMultiModel';
import { formatSearchContent, buildSearchTag } from '@/lib/searchUtils';
import { buildKnowledgeTag, buildMemoryTag, type RagContextRetrievedEvent } from '@/lib/memoryUtils';
import { useProviderStore } from '@/stores/providerStore';
import { useSearchStore } from '@/stores/searchStore';
import { useCategoryStore } from './categoryStore';
import type {
  Conversation,
  ConversationCategory,
  Message,
  MessagePage,
  AttachmentInput,
  ConversationSearchResult,
  ConversationSummary,
  UpdateConversationInput,
  ChatStreamEvent,
  ChatStreamErrorEvent,
  ConversationWorkspaceSnapshot,
  ConversationBranch,
  CompareResponsesResult,
  AgentDoneEvent,
  AgentErrorEvent,
  AgentStreamTextEvent,
  AgentStreamThinkingEvent,
} from '@/types';

let _unlisten: UnlistenFn | null = null;
// Generation counter to prevent stale listeners from processing events
// (fixes React StrictMode double-effect causing duplicate stream processing)
let _listenerGen = 0;

// Buffer for streaming content — persists across conversation switches
// so chunks arriving while viewing another conversation aren't lost
interface StreamBuffer {
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
const STREAM_UI_FLUSH_INTERVAL_MS = 16;
interface PendingUiChunk {
  messageId: string;
  conversationId: string;
  content: string;
  modelId?: string;
  providerId?: string;
}
let _pendingUiChunk: PendingUiChunk | null = null;
let _streamUiFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _activeMessageLoadSeq = 0;
const _conversationPreferenceSaveSeq = new Map<string, number>();
const MESSAGE_PAGE_SIZE = 10;
let _agentStreamSeq = 0;
let _activeAgentCancel: (() => void) | null = null;

// Multi-model parallel tracking
let _multiModelTotalRemaining = 0; // counts ALL models (including first)
let _multiModelDoneResolve: (() => void) | null = null;
let _isMultiModelActive = false;
let _multiModelFirstModelId: string | null = null; // model_id of the first selected model (for auto-switch)
let _multiModelFirstMessageId: string | null = null; // actual DB message_id of the first model's response
let _userManuallySelectedVersion = false; // tracks if user manually switched version during multi-model streaming

type ConversationPreferenceState = Pick<
  ConversationState,
  | 'searchEnabled'
  | 'searchProviderId'
  | 'thinkingBudget'
  | 'enabledMcpServerIds'
  | 'enabledKnowledgeBaseIds'
  | 'enabledMemoryNamespaceIds'
>;

function conversationPreferenceStateFromConversation(
  conversation?: Conversation | null,
): ConversationPreferenceState {
  return {
    searchEnabled: conversation?.search_enabled ?? false,
    searchProviderId: conversation?.search_provider_id ?? null,
    thinkingBudget: conversation?.thinking_budget ?? null,
    enabledMcpServerIds: [...(conversation?.enabled_mcp_server_ids ?? [])],
    enabledKnowledgeBaseIds: [...(conversation?.enabled_knowledge_base_ids ?? [])],
    enabledMemoryNamespaceIds: [...(conversation?.enabled_memory_namespace_ids ?? [])],
  };
}

function conversationPreferenceUpdateFromState(
  state: Pick<
    ConversationState,
    | 'searchEnabled'
    | 'searchProviderId'
    | 'thinkingBudget'
    | 'enabledMcpServerIds'
    | 'enabledKnowledgeBaseIds'
    | 'enabledMemoryNamespaceIds'
  >,
): Pick<
  UpdateConversationInput,
  | 'search_enabled'
  | 'search_provider_id'
  | 'thinking_budget'
  | 'enabled_mcp_server_ids'
  | 'enabled_knowledge_base_ids'
  | 'enabled_memory_namespace_ids'
> {
  return {
    search_enabled: state.searchEnabled,
    search_provider_id: state.searchProviderId,
    thinking_budget: state.thinkingBudget,
    enabled_mcp_server_ids: [...state.enabledMcpServerIds],
    enabled_knowledge_base_ids: [...state.enabledKnowledgeBaseIds],
    enabled_memory_namespace_ids: [...state.enabledMemoryNamespaceIds],
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
  const thinkingBudget = get().thinkingBudget;
  if (thinkingBudget === null) return undefined;

  const conversation = get().conversations.find((item) => item.id === conversationId);
  if (!conversation) return thinkingBudget;

  const providers = useProviderStore.getState().providers;
  const model = findModelByIds(providers, conversation.provider_id, conversation.model_id);
  if (!model) return thinkingBudget;
  return supportsReasoning(model) ? thinkingBudget : undefined;
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
        // Keep local content + status but merge in DB metadata (token counts, etc.)
        merged.set(messageId, {
          ...dbMessage,
          content: localMessage.content,
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
          enabledMcpServerIds: state.enabledMcpServerIds,
          enabledKnowledgeBaseIds: state.enabledKnowledgeBaseIds,
          enabledMemoryNamespaceIds: state.enabledMemoryNamespaceIds,
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

interface ConversationState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlderMessages: boolean;
  totalActiveCount: number;
  oldestLoadedMessageId: string | null;
  streaming: boolean;
  compressing: boolean;
  streamingMessageId: string | null;
  streamingConversationId: string | null;
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
  /** Knowledge base IDs enabled for the active conversation */
  enabledKnowledgeBaseIds: string[];
  setEnabledKnowledgeBaseIds: (ids: string[]) => void;
  toggleKnowledgeBase: (id: string) => void;
  /** Memory namespace IDs enabled for the active conversation */
  enabledMemoryNamespaceIds: string[];
  setEnabledMemoryNamespaceIds: (ids: string[]) => void;
  toggleMemoryNamespace: (id: string) => void;
  /** Insert a context-clear marker into the conversation */
  insertContextClear: () => Promise<void>;
  /** Remove a context-clear marker */
  removeContextClear: (messageId: string) => Promise<void>;
  /** Clear all messages in the active conversation */
  clearAllMessages: () => Promise<void>;
  /** Manually compress the current conversation context */
  compressContext: () => Promise<void>;
  /** Get the compression summary for a conversation */
  getCompressionSummary: (conversationId: string) => Promise<ConversationSummary | null>;
  /** Delete the compression summary and all marker messages */
  deleteCompression: () => Promise<void>;
  fetchConversations: () => Promise<void>;
  setActiveConversation: (id: string | null) => void;
  createConversation: (
    title: string,
    modelId: string,
    providerId: string,
    options?: { categoryId?: string | null },
  ) => Promise<Conversation>;
  updateConversation: (id: string, input: UpdateConversationInput) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  branchConversation: (conversationId: string, untilMessageId: string, asChild: boolean, title?: string) => Promise<Conversation>;
  togglePin: (id: string) => Promise<void>;
  toggleArchive: (id: string) => Promise<void>;
  archivedConversations: Conversation[];
  fetchArchivedConversations: () => Promise<void>;
  batchDelete: (ids: string[]) => Promise<void>;
  batchArchive: (ids: string[]) => Promise<void>;
  sendMessage: (content: string, attachments?: AttachmentInput[], searchProviderId?: string | null) => Promise<void>;
  /** Send a message in agent mode (non-streaming MVP) */
  sendAgentMessage: (content: string, attachments?: AttachmentInput[]) => Promise<void>;
  regenerateMessage: (targetMessageId?: string) => Promise<void>;
  regenerateWithModel: (targetMessageId: string, providerId: string, modelId: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  fetchMessages: (conversationId: string, preserveMessageIds?: string[]) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  searchConversations: (query: string) => Promise<ConversationSearchResult[]>;
  startStreamListening: () => Promise<void>;
  stopStreamListening: () => void;
  cancelCurrentStream: () => void;
  switchMessageVersion: (conversationId: string, parentMessageId: string, messageId: string) => Promise<void>;
  listMessageVersions: (conversationId: string, parentMessageId: string) => Promise<Message[]>;
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
  pendingCompanionModels: Array<{ providerId: string; modelId: string }>;
  /** User message ID of the current multi-model request (for scoping UI indicators) */
  multiModelParentId: string | null;
  /** Message IDs of models that have completed their streams (for per-model loading indicators) */
  multiModelDoneMessageIds: string[];
  /** Send a message and generate responses from multiple companion models */
  sendMultiModelMessage: (
    content: string,
    companionModels: Array<{ providerId: string; modelId: string }>,
    attachments?: AttachmentInput[],
    searchProviderId?: string | null,
  ) => Promise<void>;
  /** Pending prompt text from welcome cards — InputArea picks it up and sends with companion awareness */
  pendingPromptText: string | null;
  setPendingPromptText: (text: string | null) => void;
}

function appendStreamChunk(
  set: (fn: (s: ConversationState) => Partial<ConversationState>) => void,
  get: () => ConversationState,
  messageId: string,
  content: string | null,
  conversationId: string,
  modelId?: string,
  providerId?: string,
) {

  // Accumulate into stream buffer only in single-stream mode
  // (parallel multi-model streams would corrupt the shared buffer)
  if (!_isMultiModelActive) {
    if (!_streamBuffer || _streamBuffer.conversationId !== conversationId) {
      _streamBuffer = { messageId, conversationId, content: _streamPrefix, resolvedId: null, thinking: null };
      _streamPrefix = ''; // consumed
    }
    _streamBuffer.content += content ?? '';
    // Track ID resolution (placeholder → real ID)
    if (_streamBuffer.messageId !== messageId && !_streamBuffer.resolvedId) {
      _streamBuffer.resolvedId = messageId;
    }
  }

  // Only update messages in UI if this is the active conversation
  if (get().activeConversationId !== conversationId) return;

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
    _streamUiFlushTimer = setTimeout(() => {
      flushPendingStreamChunk(set, get);
    }, STREAM_UI_FLUSH_INTERVAL_MS);
  }
}

function flushPendingStreamChunk(
  set: (fn: (s: ConversationState) => Partial<ConversationState>) => void,
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
  if (get().activeConversationId !== conversationId) return;

  set((s) => {
    // 1. Direct ID match — append to existing message
    const existing = s.messages.find((m) => m.id === messageId);
    if (existing) {
      return {
        messages: s.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: m.content + (content ?? ''),
                // Enrich model info from chunk if missing
                model_id: m.model_id ?? chunkModelId ?? null,
                provider_id: m.provider_id ?? chunkProviderId ?? null,
              }
            : m,
        ),
      };
    }

    // 2. ID mismatch but placeholder exists — replace placeholder ID with real one
    // In multi-model mode, only resolve temp-* placeholders (first model's initial
    // chunk resolving the placeholder to its real DB ID). Once resolved,
    // streamingMessageId is a real ID and companion chunks must NOT hijack it —
    // they fall through to case 3 and create their own message entries.
    if (s.streamingMessageId && s.streamingMessageId !== messageId) {
      if (!_isMultiModelActive || s.streamingMessageId.startsWith('temp-')) {
        const placeholder = s.messages.find((m) => m.id === s.streamingMessageId);
        if (placeholder) {
          return {
            messages: s.messages.map((m) =>
              m.id === s.streamingMessageId
                ? {
                    ...m,
                    id: messageId,
                    content: m.content + (content ?? ''),
                  }
                : m,
            ),
            streamingMessageId: messageId,
          };
        }
      }
    }

    // 3. No placeholder found — create new assistant message with full buffered content
    const isMultiModel = _isMultiModelActive;
    const newMessage: Message = {
      id: messageId,
      conversation_id: conversationId,
      role: 'assistant',
      content: _streamBuffer?.content ?? (content ?? ''),
      provider_id: chunkProviderId ?? null,
      model_id: chunkModelId ?? null,
      token_count: null,
      attachments: [],
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: Date.now(),
      // In multi-model mode: group under the same parent and hide from main view
      // (only ModelTags pending animation is shown; fetchMessages after completion loads proper data)
      parent_message_id: isMultiModel ? s.multiModelParentId : null,
      version_index: 0,
      is_active: !isMultiModel,
      status: 'partial',
    };
    return {
      messages: [...s.messages, newMessage],
      // Don't overwrite streamingMessageId in multi-model mode
      streamingMessageId: isMultiModel ? s.streamingMessageId : messageId,
    };
  });
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  loading: false,
  loadingOlder: false,
  hasOlderMessages: false,
  totalActiveCount: 0,
  oldestLoadedMessageId: null,
  streaming: false,
  compressing: false,
  streamingMessageId: null,
  streamingConversationId: null,
  thinkingActiveMessageIds: new Set<string>(),
  error: null,
  titleGeneratingConversationId: null,
  pendingCompanionModels: [],
  multiModelParentId: null,
  multiModelDoneMessageIds: [],
  pendingPromptText: null,
  setPendingPromptText: (text) => set({ pendingPromptText: text }),
  searchEnabled: false,
  searchProviderId: null,
  enabledMcpServerIds: [],
  thinkingBudget: null,
  enabledKnowledgeBaseIds: [],
  enabledMemoryNamespaceIds: [],
  setSearchEnabled: (enabled) => {
    const previous = get().searchEnabled;
    const conversationId = get().activeConversationId;
    set({ searchEnabled: enabled });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { search_enabled: enabled },
        { searchEnabled: enabled },
        { searchEnabled: previous },
      );
    }
  },
  setSearchProviderId: (id) => {
    const previous = get().searchProviderId;
    const conversationId = get().activeConversationId;
    set({ searchProviderId: id });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { search_provider_id: id },
        { searchProviderId: id },
        { searchProviderId: previous },
      );
    }
  },
  setEnabledMcpServerIds: (ids) => {
    const previous = get().enabledMcpServerIds;
    const conversationId = get().activeConversationId;
    const nextIds = [...ids];
    set({ enabledMcpServerIds: nextIds });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { enabled_mcp_server_ids: nextIds },
        { enabledMcpServerIds: nextIds },
        { enabledMcpServerIds: previous },
      );
    }
  },
  toggleMcpServer: (id) => {
    const previous = get().enabledMcpServerIds;
    const nextIds = previous.includes(id)
      ? previous.filter((serverId) => serverId !== id)
      : [...previous, id];
    const conversationId = get().activeConversationId;
    set({ enabledMcpServerIds: nextIds });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { enabled_mcp_server_ids: nextIds },
        { enabledMcpServerIds: nextIds },
        { enabledMcpServerIds: previous },
      );
    }
  },
  setThinkingBudget: (budget) => {
    const previous = get().thinkingBudget;
    const conversationId = get().activeConversationId;
    set({ thinkingBudget: budget });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { thinking_budget: budget },
        { thinkingBudget: budget },
        { thinkingBudget: previous },
      );
    }
  },
  setEnabledKnowledgeBaseIds: (ids) => {
    const previous = get().enabledKnowledgeBaseIds;
    const conversationId = get().activeConversationId;
    const nextIds = [...ids];
    set({ enabledKnowledgeBaseIds: nextIds });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { enabled_knowledge_base_ids: nextIds },
        { enabledKnowledgeBaseIds: nextIds },
        { enabledKnowledgeBaseIds: previous },
      );
    }
  },
  toggleKnowledgeBase: (id) => {
    const previous = get().enabledKnowledgeBaseIds;
    const nextIds = previous.includes(id)
      ? previous.filter((knowledgeBaseId) => knowledgeBaseId !== id)
      : [...previous, id];
    const conversationId = get().activeConversationId;
    set({ enabledKnowledgeBaseIds: nextIds });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { enabled_knowledge_base_ids: nextIds },
        { enabledKnowledgeBaseIds: nextIds },
        { enabledKnowledgeBaseIds: previous },
      );
    }
  },
  setEnabledMemoryNamespaceIds: (ids) => {
    const previous = get().enabledMemoryNamespaceIds;
    const conversationId = get().activeConversationId;
    const nextIds = [...ids];
    set({ enabledMemoryNamespaceIds: nextIds });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { enabled_memory_namespace_ids: nextIds },
        { enabledMemoryNamespaceIds: nextIds },
        { enabledMemoryNamespaceIds: previous },
      );
    }
  },
  toggleMemoryNamespace: (id) => {
    const previous = get().enabledMemoryNamespaceIds;
    const nextIds = previous.includes(id)
      ? previous.filter((memoryNamespaceId) => memoryNamespaceId !== id)
      : [...previous, id];
    const conversationId = get().activeConversationId;
    set({ enabledMemoryNamespaceIds: nextIds });
    if (conversationId) {
      void persistConversationPreferences(
        set,
        conversationId,
        { enabled_memory_namespace_ids: nextIds },
        { enabledMemoryNamespaceIds: nextIds },
        { enabledMemoryNamespaceIds: previous },
      );
    }
  },
  insertContextClear: async () => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    try {
      const msg = await invoke<Message>('send_system_message', {
        conversationId,
        content: '<!-- context-clear -->',
      });
      set((s) => ({ messages: [...s.messages, msg] }));
      // Backup and clear agent SDK context (no-op if no agent session exists)
      await invoke('agent_backup_and_clear_sdk_context', { conversationId }).catch(() => {});
    } catch {
      // If backend command doesn't exist yet, add optimistic local message
      const localMsg: Message = {
        id: `ctx-clear-${Date.now()}`,
        conversation_id: conversationId,
        role: 'system',
        content: '<!-- context-clear -->',
        provider_id: null,
        model_id: null,
        token_count: null,
        attachments: [],
        thinking: null,
        tool_calls_json: null,
        tool_call_id: null,
        created_at: Date.now(),
        parent_message_id: null,
        version_index: 0,
        is_active: true,
        status: 'complete',
      };
      set((s) => ({ messages: [...s.messages, localMsg] }));
    }
  },
  removeContextClear: async (messageId) => {
    const conversationId = get().activeConversationId;
    if (messageId.startsWith('ctx-clear-') || messageId.startsWith('temp-')) {
      set((s) => ({ messages: s.messages.filter((m) => m.id !== messageId) }));
      return;
    }

    try {
      await invoke('delete_message', { id: messageId });
      set((s) => ({ messages: s.messages.filter((m) => m.id !== messageId) }));
      // Restore agent SDK context from backup (no-op if no agent session or no backup)
      if (conversationId) {
        await invoke('agent_restore_sdk_context_from_backup', { conversationId }).catch(() => {});
      }
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  clearAllMessages: async () => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    try {
      await invoke('clear_conversation_messages', { conversationId });
      set({ messages: [], hasOlderMessages: false, totalActiveCount: 0, oldestLoadedMessageId: null, loadingOlder: false });
    } catch (e) {
      console.error('Failed to clear messages:', e);
    }
  },

  compressContext: async () => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    set({ compressing: true });
    try {
      await invoke<ConversationSummary>('compress_context', { conversationId });
      // Reload messages to get the new compression marker
      const page = await invoke<MessagePage>('list_messages_page', {
        conversationId,
        limit: 100,
        beforeMessageId: null,
      });
      set({
        messages: page.messages,
        hasOlderMessages: page.has_older,
        totalActiveCount: page.total_active_count,
        oldestLoadedMessageId: page.messages.length > 0 ? page.messages[0].id : null,
        compressing: false,
      });
    } catch (e) {
      set({ compressing: false });
      console.error('Failed to compress context:', e);
      throw e;
    }
  },

  getCompressionSummary: async (conversationId: string) => {
    try {
      return await invoke<ConversationSummary | null>('get_compression_summary', { conversationId });
    } catch (e) {
      console.error('Failed to get compression summary:', e);
      return null;
    }
  },

  deleteCompression: async () => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    try {
      await invoke('delete_compression', { conversationId });
      // Reload messages to remove the compression marker
      const page = await invoke<MessagePage>('list_messages_page', {
        conversationId,
        limit: 100,
        beforeMessageId: null,
      });
      set({
        messages: page.messages,
        hasOlderMessages: page.has_older,
        totalActiveCount: page.total_active_count,
        oldestLoadedMessageId: page.messages.length > 0 ? page.messages[0].id : null,
      });
    } catch (e) {
      console.error('Failed to delete compression:', e);
      throw e;
    }
  },

  fetchConversations: async () => {
    set({ loading: true });
    try {
      const conversations = await invoke<Conversation[]>('list_conversations');
      set({ conversations, loading: false, error: null });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  setActiveConversation: (id) => {
    _activeMessageLoadSeq += 1;
    if (!id) {
      set({
        activeConversationId: null,
        messages: [],
        loading: false,
        loadingOlder: false,
        hasOlderMessages: false,
        totalActiveCount: 0,
        oldestLoadedMessageId: null,
      });
      return;
    }

    const conversation = get().conversations.find((item) => item.id === id)
      ?? get().archivedConversations.find((item) => item.id === id);
    const requestSeq = _activeMessageLoadSeq;

    // Check if this conversation had a stream complete while we were away
    const needsRefreshAfterStreamDone = _pendingConversationRefresh.has(id);
    if (needsRefreshAfterStreamDone) {
      _pendingConversationRefresh.delete(id);
    }

    set({
      activeConversationId: id,
      messages: [],
      loading: true,
      loadingOlder: false,
      hasOlderMessages: false,
      totalActiveCount: 0,
      oldestLoadedMessageId: null,
      error: null,
      ...conversationPreferenceStateFromConversation(conversation),
    });
    get().fetchMessages(id).then(() => {
      if (requestSeq !== _activeMessageLoadSeq || get().activeConversationId !== id) {
        return;
      }
      // If there's an active stream for this conversation, inject buffered content
      if (_streamBuffer && _streamBuffer.conversationId === id && get().streaming) {
        const realId = _streamBuffer.resolvedId ?? _streamBuffer.messageId;
        set((s) => {
          const exists = s.messages.some((m) => m.id === realId);
          if (exists) {
            // Message already fetched from backend — replace with buffered content (more up-to-date)
            return {
              messages: s.messages.map((m) =>
                m.id === realId
                  ? { ...m, content: _streamBuffer!.content, thinking: _streamBuffer!.thinking || null }
                  : m,
              ),
              streamingMessageId: realId,
            };
          }
          // Message not yet in backend — create from buffer
          const newMessage: Message = {
            id: realId,
            conversation_id: id,
            role: 'assistant',
            content: _streamBuffer!.content,
            provider_id: null,
            model_id: null,
            token_count: null,
            attachments: [],
            thinking: _streamBuffer!.thinking || null,
            tool_calls_json: null,
            tool_call_id: null,
            created_at: Date.now(),
            parent_message_id: null,
            version_index: 0,
            is_active: true,
            status: 'partial',
          };
          return {
            messages: [...s.messages, newMessage],
            streamingMessageId: realId,
          };
        });
      } else if (_streamBuffer && _streamBuffer.conversationId === id && needsRefreshAfterStreamDone) {
        // Stream completed while user was away — buffer still has final content.
        // fetchMessages already loaded the completed message from DB, but inject
        // buffer content in case the DB response is slightly behind.
        const realId = _streamBuffer.resolvedId ?? _streamBuffer.messageId;
        set((s) => {
          const exists = s.messages.some((m) => m.id === realId);
          if (exists) {
            return {
              messages: s.messages.map((m) =>
                m.id === realId
                  ? { ...m, content: _streamBuffer!.content, thinking: _streamBuffer!.thinking || null }
                  : m,
              ),
            };
          }
          return {};
        });
        _streamBuffer = null;
      } else if (needsRefreshAfterStreamDone) {
        // Stream completed while away and buffer was already consumed — the
        // fetchMessages above should have loaded the final message from DB.
        // Clear any stale buffer reference.
        _streamBuffer = null;
      }
    });
  },

  createConversation: async (title, modelId, providerId, options) => {
    try {
      const category = options?.categoryId
        ? useCategoryStore.getState().categories.find((item) => item.id === options.categoryId) ?? null
        : null;
      const templateProviderId = category?.default_provider_id ?? providerId;
      const templateModelId = category?.default_model_id ?? modelId;
      const createdConversation = await invoke<Conversation>('create_conversation', {
        title,
        modelId: templateModelId,
        providerId: templateProviderId,
        systemPrompt: category?.system_prompt ?? undefined,
      });
      let conversation = createdConversation;
      try {
        conversation = await invoke<Conversation>('update_conversation', {
          id: createdConversation.id,
          input: {
            ...categoryTemplateUpdateFromCategory(category),
            ...conversationPreferenceUpdateFromState(get()),
          },
        });
      } catch (preferenceError) {
        set({ error: String(preferenceError) });
      }
      set((s) => ({
        conversations: [conversation, ...s.conversations],
        activeConversationId: conversation.id,
        messages: [],
        error: null,
        ...conversationPreferenceStateFromConversation(conversation),
      }));
      return conversation;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateConversation: async (id, input) => {
    try {
      const updated = await invoke<Conversation>('update_conversation', { id, input });
      set((s) => ({
        ...mergeConversationCollections(s.conversations, s.archivedConversations, updated),
        ...(s.activeConversationId === id ? conversationPreferenceStateFromConversation(updated) : {}),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  renameConversation: async (id, title) => {
    await get().updateConversation(id, { title });
  },

  regenerateTitle: async (conversationId) => {
    try {
      await invoke('regenerate_conversation_title', { conversationId });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  deleteConversation: async (id) => {
    try {
      await invoke('delete_conversation', { id });
      const state = get();
      set({
        conversations: state.conversations.filter((c) => c.id !== id),
        activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
        messages: state.activeConversationId === id ? [] : state.messages,
        error: null,
      });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  branchConversation: async (conversationId, untilMessageId, asChild, title) => {
    try {
      const newConv = await invoke<Conversation>('branch_conversation', {
        conversationId,
        untilMessageId,
        asChild,
        title: title || null,
      });
      set((s) => ({
        conversations: [newConv, ...s.conversations],
        activeConversationId: newConv.id,
        messages: [],
        error: null,
      }));
      // Load the branched messages
      const msgs = await invoke<Message[]>('list_messages', { conversationId: newConv.id });
      set({ messages: msgs });
      return newConv;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  togglePin: async (id) => {
    try {
      const updated = await invoke<Conversation>('toggle_pin_conversation', { id });
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  archivedConversations: [],

  toggleArchive: async (id) => {
    try {
      const updated = await invoke<Conversation>('toggle_archive_conversation', { id });
      if (updated.is_archived) {
        // Moved to archive — remove from active list, add to archived
        set((s) => ({
          conversations: s.conversations.filter((c) => c.id !== id),
          archivedConversations: [updated, ...s.archivedConversations],
          activeConversationId: s.activeConversationId === id ? null : s.activeConversationId,
          messages: s.activeConversationId === id ? [] : s.messages,
          error: null,
        }));
      } else {
        // Unarchived — remove from archived, add to active
        set((s) => ({
          conversations: [updated, ...s.conversations],
          archivedConversations: s.archivedConversations.filter((c) => c.id !== id),
          error: null,
        }));
      }
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  fetchArchivedConversations: async () => {
    try {
      const archived = await invoke<Conversation[]>('list_archived_conversations');
      set({ archivedConversations: archived, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  batchDelete: async (ids) => {
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await invoke('delete_conversation', { id });
      } catch (e) {
        errors.push(String(e));
      }
    }
    set((s) => ({
      conversations: s.conversations.filter((c) => !ids.includes(c.id)),
      activeConversationId: ids.includes(s.activeConversationId ?? '') ? null : s.activeConversationId,
      messages: ids.includes(s.activeConversationId ?? '') ? [] : s.messages,
      error: errors.length ? errors.join('; ') : null,
    }));
  },

  batchArchive: async (ids) => {
    const archived: Conversation[] = [];
    for (const id of ids) {
      try {
        const updated = await invoke<Conversation>('toggle_archive_conversation', { id });
        if (updated.is_archived) archived.push(updated);
      } catch (_) { /* skip */ }
    }
    set((s) => ({
      conversations: s.conversations.filter((c) => !ids.includes(c.id)),
      archivedConversations: [...archived, ...s.archivedConversations],
      activeConversationId: ids.includes(s.activeConversationId ?? '') ? null : s.activeConversationId,
      messages: ids.includes(s.activeConversationId ?? '') ? [] : s.messages,
      error: null,
    }));
  },

  sendMessage: async (content, attachments = [], searchProviderId = null) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) throw new Error('No active conversation');
    const activeConversation = get().conversations.find((conversation) => conversation.id === conversationId);

    // Optimistically add user message BEFORE backend call
    const optimisticUserMsg: Message = {
      id: `temp-user-${Date.now()}`,
      conversation_id: conversationId,
      role: 'user',
      content,
      provider_id: null,
      model_id: null,
      token_count: null,
      attachments: attachments.map((a) => ({
        id: `temp-att-${Date.now()}`,
        file_name: a.file_name,
        file_type: a.file_type,
        file_path: '',
        file_size: a.file_size,
        data: a.data,
      })),
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: Date.now(),
      parent_message_id: null,
      version_index: 0,
      is_active: true,
      status: 'complete',
    };

    // Create assistant placeholder upfront (for search status or streaming)
    const tempAssistantId = `temp-assistant-${Date.now()}`;
    const kbIds = get().enabledKnowledgeBaseIds;
    const memIds = get().enabledMemoryNamespaceIds;
    const hasKnowledgeRag = kbIds.length > 0;
    const hasMemoryRag = memIds.length > 0;
    const hasAnyRag = hasKnowledgeRag || hasMemoryRag;
    let placeholderContent = '';
    if (searchProviderId) placeholderContent += buildSearchTag('searching');
    if (hasKnowledgeRag) placeholderContent += buildKnowledgeTag('searching');
    if (hasMemoryRag) placeholderContent += buildMemoryTag('searching');
    const placeholderAssistant: Message = {
      id: tempAssistantId,
      conversation_id: conversationId,
      role: 'assistant',
      content: placeholderContent,
      provider_id: activeConversation?.provider_id ?? null,
      model_id: activeConversation?.model_id ?? null,
      token_count: null,
      attachments: [],
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: Date.now(),
      parent_message_id: optimisticUserMsg.id,
      version_index: 0,
      is_active: true,
      status: 'partial',
    };

    set((s) => ({
      messages: [...s.messages, optimisticUserMsg, placeholderAssistant],
      streaming: true,
      streamingConversationId: conversationId,
      streamingMessageId: tempAssistantId,
      thinkingActiveMessageIds: new Set<string>(),
    }));
    _pendingUiChunk = null;
    if (_streamUiFlushTimer !== null) {
      clearTimeout(_streamUiFlushTimer);
      _streamUiFlushTimer = null;
    }

    try {
      // If web search is enabled, execute search before sending to backend
      let finalContent = content;
      if (searchProviderId) {
        let searchResultTag = '';
        try {
          const searchResult = await useSearchStore.getState().executeSearch(searchProviderId, content);
          if (searchResult?.ok && searchResult.results.length > 0) {
            finalContent = formatSearchContent(searchResult.results, content);
            searchResultTag = buildSearchTag('done', searchResult.results);
          }
        } catch (e) {
          // Search failed, continue without search results
        }
        // Replace searching tag with results, keep RAG searching tags if present
        const kbPart = hasKnowledgeRag ? buildKnowledgeTag('searching') : '';
        const memPart = hasMemoryRag ? buildMemoryTag('searching') : '';
        _streamPrefix = searchResultTag + kbPart + memPart;
        set((s) => ({
          messages: s.messages.map(m =>
            m.id === tempAssistantId ? { ...m, content: searchResultTag + kbPart + memPart } : m
          ),
        }));
      } else if (hasAnyRag) {
        // RAG only — set prefix so searching tags flow into stream buffer
        const kbPart = hasKnowledgeRag ? buildKnowledgeTag('searching') : '';
        const memPart = hasMemoryRag ? buildMemoryTag('searching') : '';
        _streamPrefix = kbPart + memPart;
      }

      const mcpIds = get().enabledMcpServerIds;
      const thinkingBudget = getEffectiveThinkingBudget(get, conversationId);
      const kbIds = get().enabledKnowledgeBaseIds;
      const memIds = get().enabledMemoryNamespaceIds;
      const userMessage = await invoke<Message>('send_message', {
        conversationId,
        content: finalContent,
        attachments,
        enabledMcpServerIds: mcpIds.length > 0 ? mcpIds : undefined,
        thinkingBudget,
        enabledKnowledgeBaseIds: kbIds.length > 0 ? kbIds : undefined,
        enabledMemoryNamespaceIds: memIds.length > 0 ? memIds : undefined,
      });

      // Replace optimistic user msg with real one, update placeholder parent
      set((s) => ({
        messages: s.messages.map(m => {
          if (m.id === optimisticUserMsg.id) return userMessage;
          if (m.id === tempAssistantId) return { ...m, parent_message_id: userMessage.id };
          return m;
        }),
      }));

      // In browser mode, simulate brief loading then fetch the mock AI response
      if (!isTauri()) {
        await new Promise((r) => setTimeout(r, 600));
        set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageIds: new Set<string>() });
        get().fetchMessages(conversationId);
      }
    } catch (e) {
      console.error('[sendMessage] error:', e);
      const errMsg = String(e);
      set((s) => ({
        streaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        thinkingActiveMessageIds: new Set<string>(),
        messages: s.streamingMessageId
          ? s.messages.map(m =>
              m.id === s.streamingMessageId
                ? { ...m, content: errMsg, status: 'error' as const }
                : m
            )
          : [...s.messages, {
              id: `temp-error-${Date.now()}`,
              conversation_id: conversationId,
              role: 'assistant' as const,
              content: errMsg,
              provider_id: null,
              model_id: null,
              token_count: null,
              attachments: [],
              thinking: null,
              tool_calls_json: null,
              tool_call_id: null,
              created_at: Date.now(),
              parent_message_id: null,
              version_index: 0,
              is_active: true,
              status: 'error' as const,
            }],
      }));
    }
  },

  sendAgentMessage: async (content, attachments = []) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) throw new Error('No active conversation');

    _activeAgentCancel?.();
    _activeAgentCancel = null;
    const agentRunSeq = ++_agentStreamSeq;
    const isCurrentAgentRun = () => agentRunSeq === _agentStreamSeq;

    const conversation = get().conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new Error('Conversation not found');

    const providerId = conversation.provider_id;
    const modelId = conversation.model_id;

    // Optimistic user message
    const optimisticUserMsg: Message = {
      id: `temp-user-${Date.now()}`,
      conversation_id: conversationId,
      role: 'user',
      content,
      provider_id: null,
      model_id: null,
      token_count: null,
      attachments: attachments.map((a) => ({
        id: `temp-att-${Date.now()}`,
        file_name: a.file_name,
        file_type: a.file_type,
        file_path: '',
        file_size: a.file_size,
        data: a.data,
      })),
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: Date.now(),
      parent_message_id: null,
      version_index: 0,
      is_active: true,
      status: 'complete',
    };

    // Placeholder assistant message
    let currentMsgId = `temp-agent-${Date.now()}`;
    const placeholderAssistant: Message = {
      id: currentMsgId,
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      provider_id: providerId,
      model_id: modelId,
      token_count: null,
      attachments: [],
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: Date.now(),
      parent_message_id: optimisticUserMsg.id,
      version_index: 0,
      is_active: true,
      status: 'partial',
    };

    set((s) => ({
      messages: [...s.messages, optimisticUserMsg, placeholderAssistant],
      streaming: true,
      streamingConversationId: conversationId,
      streamingMessageId: currentMsgId,
    }));

    // Set up event listeners BEFORE invoking to avoid race conditions
    let unlistenDone: UnlistenFn | null = null;
    let unlistenError: UnlistenFn | null = null;
    let unlistenStreamText: UnlistenFn | null = null;
    let unlistenStreamThinking: UnlistenFn | null = null;
    let unlistenMessageId: UnlistenFn | null = null;
    let cancelActiveRun: (() => void) | null = null;
    let cleanedUp = false;

    // ── Agent stream buffering (same pattern as Q&A _pendingUiChunk) ──
    let _agentPendingText = '';
    let _agentPendingThinking = '';
    let _agentFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushAgentStreamChunks = () => {
      if (_agentFlushTimer !== null) {
        clearTimeout(_agentFlushTimer);
        _agentFlushTimer = null;
      }
      const textChunk = _agentPendingText;
      const thinkingChunk = _agentPendingThinking;
      _agentPendingText = '';
      _agentPendingThinking = '';
      if (!textChunk && !thinkingChunk) return;

      set((s) => {
        const wasThinking = s.thinkingActiveMessageIds.has(currentMsgId);
        let nextThinkingIds = s.thinkingActiveMessageIds;

        const updatedMessages = s.messages.map((m) => {
          if (m.id !== currentMsgId) return m;

          let content = m.content || '';
          let thinking = m.thinking || '';

          // 1. Process buffered thinking chunks first
          if (thinkingChunk) {
            if (!wasThinking) {
              content += '<think data-aqbot="1">\n';
            }
            content += thinkingChunk;
            thinking += thinkingChunk;
            nextThinkingIds = new Set([...nextThinkingIds, currentMsgId]);
          }

          // 2. Process buffered text chunks (closes thinking block if needed)
          if (textChunk) {
            const isCurrentlyThinking = thinkingChunk ? true : wasThinking;
            if (isCurrentlyThinking) {
              content += '\n</think>\n\n';
              const n = new Set(nextThinkingIds);
              n.delete(currentMsgId);
              nextThinkingIds = n;
            }
            content += textChunk;
          }

          return { ...m, content, thinking };
        });

        return {
          thinkingActiveMessageIds: nextThinkingIds,
          messages: updatedMessages,
        };
      });
    };

    const scheduleAgentFlush = () => {
      if (_agentFlushTimer === null) {
        _agentFlushTimer = setTimeout(flushAgentStreamChunks, STREAM_UI_FLUSH_INTERVAL_MS);
      }
    };

    const clearAgentStreamBuffer = () => {
      if (_agentFlushTimer !== null) {
        clearTimeout(_agentFlushTimer);
        _agentFlushTimer = null;
      }
      _agentPendingText = '';
      _agentPendingThinking = '';
    };

    const cleanup = () => {
      cleanedUp = true;
      clearAgentStreamBuffer();
      unlistenStreamText?.();
      unlistenStreamThinking?.();
      unlistenDone?.();
      unlistenError?.();
      unlistenMessageId?.();
      unlistenStreamText = null;
      unlistenStreamThinking = null;
      unlistenDone = null;
      unlistenError = null;
      unlistenMessageId = null;
      if (_activeAgentCancel === cancelActiveRun) {
        _activeAgentCancel = null;
      }
    };

    const keepAgentUnlisten = (assign: (fn: UnlistenFn) => void) => (fn: UnlistenFn) => {
      if (cleanedUp || !isCurrentAgentRun()) {
        fn();
        return;
      }
      assign(fn);
    };

    try {
      const eventPromise = new Promise<void>((resolve, reject) => {
        cancelActiveRun = () => {
          if (isCurrentAgentRun()) {
            _agentStreamSeq++;
          }
          cleanup();
          resolve();
        };
        _activeAgentCancel = cancelActiveRun;

        // Listen for the real assistant message ID from the backend
        // This replaces the temp ID so tool call events can be matched
        listen<{ conversationId: string; assistantMessageId: string }>('agent-message-id', (event) => {
          if (event.payload.conversationId !== conversationId || !isCurrentAgentRun()) return;
          // Flush pending buffer before switching IDs
          flushAgentStreamChunks();
          const realId = event.payload.assistantMessageId;
          const oldId = currentMsgId;
          currentMsgId = realId;
          set((s) => ({
            streamingMessageId: realId,
            messages: s.messages.map((m) =>
              m.id === oldId ? { ...m, id: realId } : m
            ),
          }));
        }).then(keepAgentUnlisten((fn) => { unlistenMessageId = fn; }));

        // Listen for incremental text chunks — buffer and flush periodically
        listen<AgentStreamTextEvent>('agent-stream-text', (event) => {
          if (event.payload.conversationId !== conversationId || !isCurrentAgentRun()) return;
          _agentPendingText += event.payload.text;
          scheduleAgentFlush();
        }).then(keepAgentUnlisten((fn) => { unlistenStreamText = fn; }));

        // Listen for incremental thinking chunks — buffer and flush periodically
        listen<AgentStreamThinkingEvent>('agent-stream-thinking', (event) => {
          if (event.payload.conversationId !== conversationId || !isCurrentAgentRun()) return;
          _agentPendingThinking += event.payload.thinking;
          scheduleAgentFlush();
        }).then(keepAgentUnlisten((fn) => { unlistenStreamThinking = fn; }));

        // Listen for agent-done — correction overwrite with final content
        listen<AgentDoneEvent>('agent-done', (event) => {
          if (event.payload.conversationId !== conversationId || !isCurrentAgentRun()) return;
          // Clear pending buffer (done event overwrites with final content)
          clearAgentStreamBuffer();
          const isActiveConversation = get().activeConversationId === conversationId;
          // Skip if streaming was already cancelled (avoid stale fetchMessages re-render)
          const isStillStreaming = get().streaming && get().streamingMessageId === currentMsgId;
          if (!isStillStreaming) {
            if (!isActiveConversation) {
              _pendingConversationRefresh.add(conversationId);
            }
            cleanup();
            resolve();
            return;
          }

          set((s) => ({
            streaming: false,
            streamingMessageId: null,
            streamingConversationId: null,
            thinkingActiveMessageIds: (() => {
              const next = new Set(s.thinkingActiveMessageIds);
              next.delete(currentMsgId);
              return next;
            })(),
            messages: s.messages.map((m) => {
              if (m.id === currentMsgId) {
                return {
                  ...m,
                  id: event.payload.assistantMessageId || m.id,
                  content: event.payload.text,
                  status: 'complete' as const,
                  prompt_tokens: event.payload.usage?.input_tokens ?? null,
                  completion_tokens: event.payload.usage?.output_tokens ?? null,
                };
              }
              return m;
            }),
          }));

          cleanup();
          if (isActiveConversation) {
            // Fetch messages to fully sync with backend (real user message ID, etc.)
            get().fetchMessages(conversationId);
          } else {
            _pendingConversationRefresh.add(conversationId);
          }
          resolve();
        }).then(keepAgentUnlisten((fn) => { unlistenDone = fn; }));

        // Listen for agent-error
        listen<AgentErrorEvent>('agent-error', (event) => {
          if (event.payload.conversationId !== conversationId || !isCurrentAgentRun()) return;
          // Clear pending buffer (error event overwrites content)
          clearAgentStreamBuffer();
          // Skip if streaming was already cancelled
          const isStillStreaming = get().streaming && get().streamingMessageId === currentMsgId;
          if (!isStillStreaming) {
            cleanup();
            resolve();
            return;
          }

          set((s) => ({
            streaming: false,
            streamingMessageId: null,
            streamingConversationId: null,
            thinkingActiveMessageIds: (() => {
              const next = new Set(s.thinkingActiveMessageIds);
              next.delete(currentMsgId);
              return next;
            })(),
            messages: s.messages.map((m) => {
              if (m.id === currentMsgId) {
                return {
                  ...m,
                  content: event.payload.message,
                  status: 'error' as const,
                };
              }
              return m;
            }),
          }));

          cleanup();
          reject(new Error(event.payload.message));
        }).then(keepAgentUnlisten((fn) => { unlistenError = fn; }));
      });

      // Invoke the backend command (this creates the real user message in DB)
      await invoke('agent_query', {
        conversationId,
        prompt: content,
        providerId,
        modelId,
      });

      // Wait for agent-done or agent-error event
      await eventPromise;
    } catch (e) {
      cleanup();
      const errMsg = String(e);
      console.error('[sendAgentMessage] error:', errMsg);

      // If streaming is still true, the error came from invoke itself (not an event)
      if (get().streaming && (get().streamingMessageId === currentMsgId)) {
        set((s) => ({
          streaming: false,
          streamingMessageId: null,
          streamingConversationId: null,
          messages: s.messages.map((m) =>
            m.id === currentMsgId
              ? { ...m, content: errMsg, status: 'error' as const }
              : m
          ),
        }));
      }
    }
  },

  regenerateMessage: async (targetMessageId?: string) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) throw new Error('No active conversation');

    const msgs = get().messages;
    // Find the user message (either specific or last one)
    let userMsg: Message | undefined;
    if (targetMessageId) {
      // Find the AI message, then its parent user message
      const aiMsg = msgs.find(m => m.id === targetMessageId);
      if (aiMsg?.parent_message_id) {
        userMsg = msgs.find(m => m.id === aiMsg.parent_message_id);
      }
    }
    if (!userMsg) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') { userMsg = msgs[i]; break; }
      }
    }
    if (!userMsg) throw new Error('No user message found');

    // Create placeholder for new version, preserving original created_at for position
    const tempAssistantId = `temp-assistant-${Date.now()}`;
    const parentId = userMsg.id;

    // Find the original active AI message to preserve its created_at
    const originalAiMsg = msgs.find(m => m.parent_message_id === parentId && m.is_active);
    const placeholderAssistant: Message = {
      id: tempAssistantId,
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      provider_id: originalAiMsg?.provider_id ?? null,
      model_id: originalAiMsg?.model_id ?? null,
      token_count: null,
      attachments: [],
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: originalAiMsg?.created_at ?? Date.now(),
      parent_message_id: userMsg.id,
      version_index: 0,
      is_active: false,
      status: 'partial',
    };

    // Replace the active AI message in-place with placeholder (preserve position)
    set((s) => {
      let inserted = false;
      const updated: Message[] = [];
      for (const m of s.messages) {
        if (m.parent_message_id === parentId && m.is_active) {
          updated.push({ ...m, is_active: false });
          if (!inserted) {
            updated.push(placeholderAssistant);
            inserted = true;
          }
        } else {
          updated.push(m);
        }
      }
      if (!inserted) {
        updated.push(placeholderAssistant);
      }
      return {
        messages: updated,
        streaming: true,
        streamingMessageId: tempAssistantId,
        streamingConversationId: conversationId,
        thinkingActiveMessageIds: new Set<string>(),
      };
    });
    _pendingUiChunk = null;
    if (_streamUiFlushTimer !== null) {
      clearTimeout(_streamUiFlushTimer);
      _streamUiFlushTimer = null;
    }

    try {
      const rMcpIds = get().enabledMcpServerIds;
      const rThinkingBudget = getEffectiveThinkingBudget(get, conversationId);
      const rKbIds = get().enabledKnowledgeBaseIds;
      const rMemIds = get().enabledMemoryNamespaceIds;
      await invoke('regenerate_message', {
        conversationId,
        userMessageId: userMsg.id,
        enabledMcpServerIds: rMcpIds.length > 0 ? rMcpIds : undefined,
        thinkingBudget: rThinkingBudget,
        enabledKnowledgeBaseIds: rKbIds.length > 0 ? rKbIds : undefined,
        enabledMemoryNamespaceIds: rMemIds.length > 0 ? rMemIds : undefined,
      });

      // In browser mode, simulate brief loading then fetch the mock AI response
      if (!isTauri()) {
        await new Promise((r) => setTimeout(r, 600));
        set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageIds: new Set<string>() });
        get().fetchMessages(conversationId);
      }
    } catch (e) {
      console.error('[regenerateMessage] error:', e);
      const errMsg = String(e);
      set((s) => ({
        streaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        thinkingActiveMessageIds: new Set<string>(),
        messages: s.streamingMessageId
          ? s.messages.map(m =>
              m.id === s.streamingMessageId
                ? { ...m, content: errMsg, status: 'error' as const }
                : m
            )
          : s.messages,
      }));
    }
  },

  regenerateWithModel: async (targetMessageId: string, providerId: string, modelId: string) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) throw new Error('No active conversation');

    const msgs = get().messages;
    // Find the AI message, then its parent user message
    const aiMsg = msgs.find(m => m.id === targetMessageId);
    if (!aiMsg?.parent_message_id) throw new Error('Cannot find parent user message');
    const userMsg = msgs.find(m => m.id === aiMsg.parent_message_id);
    if (!userMsg) throw new Error('User message not found');

    const parentId = userMsg.id;
    const originalAiMsg = msgs.find(m => m.parent_message_id === parentId && m.is_active);
    const parentVersions = msgs.filter((m) => m.parent_message_id === parentId && m.role === 'assistant');
    const appendAsCompanion = hasMultipleModelVersions(parentVersions);

    // Create placeholder with the target model info
    const tempAssistantId = `temp-assistant-${Date.now()}`;
    const placeholderAssistant: Message = {
      id: tempAssistantId,
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      provider_id: providerId,
      model_id: modelId,
      token_count: null,
      attachments: [],
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: originalAiMsg?.created_at ?? Date.now(),
      parent_message_id: userMsg.id,
      version_index: 0,
      is_active: !appendAsCompanion,
      status: 'partial',
    };

    // Keep the current active answer visible while the new model streams in.
    set((s) => {
      return {
        messages: insertModelVersionPlaceholder(s.messages, parentId, placeholderAssistant),
        streaming: true,
        streamingMessageId: tempAssistantId,
        streamingConversationId: conversationId,
        thinkingActiveMessageIds: new Set<string>(),
      };
    });
    _pendingUiChunk = null;
    if (_streamUiFlushTimer !== null) {
      clearTimeout(_streamUiFlushTimer);
      _streamUiFlushTimer = null;
    }

    try {
      const rMcpIds = get().enabledMcpServerIds;
      const rThinkingBudget = getEffectiveThinkingBudget(get, conversationId);
      const rKbIds = get().enabledKnowledgeBaseIds;
      const rMemIds = get().enabledMemoryNamespaceIds;
      await invoke('regenerate_with_model', {
        conversationId,
        userMessageId: userMsg.id,
        targetProviderId: providerId,
        targetModelId: modelId,
        enabledMcpServerIds: rMcpIds.length > 0 ? rMcpIds : undefined,
        thinkingBudget: rThinkingBudget,
        enabledKnowledgeBaseIds: rKbIds.length > 0 ? rKbIds : undefined,
        enabledMemoryNamespaceIds: rMemIds.length > 0 ? rMemIds : undefined,
        isCompanion: appendAsCompanion ? true : undefined,
      });

      if (!isTauri()) {
        await new Promise((r) => setTimeout(r, 600));
        set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageIds: new Set<string>() });
        get().fetchMessages(conversationId);
      }
    } catch (e) {
      console.error('[regenerateWithModel] error:', e);
      const errMsg = String(e);
      set((s) => ({
        streaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        thinkingActiveMessageIds: new Set<string>(),
        messages: s.streamingMessageId
          ? s.messages.map(m =>
              m.id === s.streamingMessageId
                ? { ...m, content: errMsg, status: 'error' as const }
                : m
            )
          : s.messages,
      }));
    }
  },

  sendMultiModelMessage: async (content, companionModels, attachments = [], searchProviderId = null) => {
    const conversationId = get().activeConversationId;
    if (!conversationId || companionModels.length === 0) return;

    // Save original conversation model to restore later
    const conv = get().conversations.find((c) => c.id === conversationId);
    const originalProviderId = conv?.provider_id;
    const originalModelId = conv?.model_id;

    // Track ALL models (first + companions) in a unified counter
    _isMultiModelActive = true;
    _multiModelTotalRemaining = companionModels.length;
    _multiModelFirstModelId = companionModels[0].modelId;
    set({ pendingCompanionModels: [...companionModels] });

    // Switch to the first selected model and send
    const firstModel = companionModels[0];
    try {
      await get().updateConversation(conversationId, {
        provider_id: firstModel.providerId,
        model_id: firstModel.modelId,
      });
    } catch (e) {
      console.error('[sendMultiModelMessage] failed to switch model:', e);
      _isMultiModelActive = false;
      _multiModelTotalRemaining = 0;
      _multiModelFirstModelId = null;
      _multiModelFirstMessageId = null;
      _userManuallySelectedVersion = false;
      set({ pendingCompanionModels: [], multiModelParentId: null, multiModelDoneMessageIds: [] });
      return;
    }

    // sendMessage returns after invoke (message created in DB), stream continues in background
    await get().sendMessage(content, attachments, searchProviderId);

    // Find the user message that was just created
    const msgs = get().messages;
    const lastUserMsg = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      _isMultiModelActive = false;
      _multiModelTotalRemaining = 0;
      _multiModelFirstModelId = null;
      _multiModelFirstMessageId = null;
      _userManuallySelectedVersion = false;
      set({ pendingCompanionModels: [], multiModelParentId: null, multiModelDoneMessageIds: [] });
      if (originalProviderId && originalModelId) {
        void get().updateConversation(conversationId, { provider_id: originalProviderId, model_id: originalModelId });
      }
      return;
    }

    // Scope loading indicators to this message and set parent_message_id
    // on the streaming placeholder so ModelTags renders immediately
    set((s) => ({
      multiModelParentId: lastUserMsg.id,
      messages: s.messages.map((m) =>
        m.id === s.streamingMessageId && m.role === 'assistant'
          ? { ...m, parent_message_id: lastUserMsg.id }
          : m,
      ),
    }));

    // Create a unified promise for ALL models (first model stream already running)
    const allDone = new Promise<void>((resolve) => {
      // If first model already finished before we set up the promise, check immediately
      if (_multiModelTotalRemaining === 0) { resolve(); return; }
      _multiModelDoneResolve = resolve;
    });

    // Fire remaining companions in PARALLEL (concurrent with first model's stream)
    const remaining = companionModels.slice(1);
    if (remaining.length > 0) {
      _streamBuffer = null;

      const mcpIds = get().enabledMcpServerIds;
      const thinkingBudget = getEffectiveThinkingBudget(get, conversationId);
      const kbIds = get().enabledKnowledgeBaseIds;
      const memIds = get().enabledMemoryNamespaceIds;

      const invocations = remaining.map((model) =>
        invoke('regenerate_with_model', {
          conversationId,
          userMessageId: lastUserMsg.id,
          targetProviderId: model.providerId,
          targetModelId: model.modelId,
          enabledMcpServerIds: mcpIds.length > 0 ? mcpIds : undefined,
          thinkingBudget,
          enabledKnowledgeBaseIds: kbIds.length > 0 ? kbIds : undefined,
          enabledMemoryNamespaceIds: memIds.length > 0 ? memIds : undefined,
          isCompanion: true,
        }).then(async () => {
          // Each invoke returns after message creation — immediately enrich the store
          // so ModelTags can render this companion as clickable right away.
          if (!_isMultiModelActive) return;
          try {
            const versions = await get().listMessageVersions(conversationId, lastUserMsg.id);
            if (versions.length > 0 && _isMultiModelActive) {
              set((s) => {
                const existingIds = new Set(s.messages.map((m) => m.id));
                const dbVersionMap = new Map(versions.map((v) => [v.id, v]));
                const updates: Partial<ConversationState> = {};

                let resolvedFirstModelId: string | null = null;
                if (s.streamingMessageId?.startsWith('temp-') && _multiModelFirstModelId) {
                  const firstDbVersion = versions.find(
                    (v) => v.model_id === _multiModelFirstModelId && !existingIds.has(v.id),
                  );
                  if (firstDbVersion) {
                    resolvedFirstModelId = firstDbVersion.id;
                    existingIds.delete(s.streamingMessageId);
                    existingIds.add(firstDbVersion.id);
                    updates.streamingMessageId = firstDbVersion.id;
                  }
                }

                const newVersions = versions
                  .filter((v) => !existingIds.has(v.id))
                  .map((v) => ({ ...v, is_active: false as const }));
                let enriched = false;
                const updatedMessages = s.messages.map((m) => {
                  if (resolvedFirstModelId && m.id === s.streamingMessageId) {
                    const dbVersion = dbVersionMap.get(resolvedFirstModelId);
                    enriched = true;
                    return {
                      ...m,
                      id: resolvedFirstModelId,
                      model_id: dbVersion?.model_id ?? m.model_id,
                      provider_id: dbVersion?.provider_id ?? m.provider_id,
                    };
                  }
                  const dbVersion = dbVersionMap.get(m.id);
                  if (dbVersion && (!m.model_id || !m.provider_id)) {
                    enriched = true;
                    return { ...m, model_id: dbVersion.model_id, provider_id: dbVersion.provider_id };
                  }
                  return m;
                });
                if (newVersions.length === 0 && !enriched && Object.keys(updates).length === 0) return {};
                return { ...updates, messages: [...updatedMessages, ...newVersions] };
              });
            }
          } catch (e) {
            console.warn('[sendMultiModelMessage] failed to enrich companion:', e);
          }
        }).catch((e) => {
          console.error(`[sendMultiModelMessage] companion ${model.modelId} invoke failed:`, e);
          // Invoke failed — no stream will start, so decrement counter here
          _multiModelTotalRemaining--;
          if (_multiModelTotalRemaining <= 0 && _multiModelDoneResolve) {
            const r = _multiModelDoneResolve;
            _multiModelDoneResolve = null;
            set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageIds: new Set<string>() });
            r();
          }
        })
      );

      // Don't await invocations — they return after message creation, streams run in background
      // Enrichment now happens per-invocation (see .then() above).
      void Promise.allSettled(invocations);
    }

    // Wait for ALL streams to complete (first + companions)
    await allDone;

    // All done — cleanup
    _isMultiModelActive = false;
    _multiModelFirstModelId = null;
    set({ pendingCompanionModels: [], multiModelDoneMessageIds: [] });

    // Restore original conversation model
    if (originalProviderId && originalModelId) {
      try {
        await get().updateConversation(conversationId, {
          provider_id: originalProviderId,
          model_id: originalModelId,
        });
      } catch (e) {
        console.error('[sendMultiModelMessage] failed to restore model:', e);
      }
    }

    // Final fetch for consistency
    if (get().activeConversationId === conversationId) {
      const parentId = get().multiModelParentId;

      // Determine which version to show: if user manually selected a version, respect that choice
      const userSelectedMessageId = _userManuallySelectedVersion
        ? get().messages.find(
            (m) => m.parent_message_id === parentId && m.role === 'assistant' && m.is_active,
          )?.id ?? null
        : null;

      if (parentId && !_userManuallySelectedVersion) {
        // No manual selection — switch to the first model's version
        const firstModelId = companionModels[0].modelId;
        let targetMessageId = _multiModelFirstMessageId;
        if (!targetMessageId) {
          const localMatch = get().messages.find(
            (m) => m.parent_message_id === parentId && m.role === 'assistant' && m.model_id === firstModelId,
          );
          targetMessageId = localMatch?.id ?? null;
        }
        if (targetMessageId) {
          await invoke('switch_message_version', {
            conversationId,
            parentMessageId: parentId,
            messageId: targetMessageId,
          }).catch(() => {});
        }
      } else if (parentId && userSelectedMessageId) {
        // User manually selected a version — sync that to backend
        await invoke('switch_message_version', {
          conversationId,
          parentMessageId: parentId,
          messageId: userSelectedMessageId,
        }).catch(() => {});
      }

      await get().fetchMessages(conversationId);

      if (parentId) {
        const versions = await get().listMessageVersions(conversationId, parentId);
        if (versions.length > 0) {
          const firstModelId = companionModels[0].modelId;
          const activeVersionId = (
            (_userManuallySelectedVersion && userSelectedMessageId
              ? versions.find((version) => version.id === userSelectedMessageId)
              : null)
            ?? (_multiModelFirstMessageId
              ? versions.find((version) => version.id === _multiModelFirstMessageId)
              : null)
            ?? versions.find((version) => version.model_id === firstModelId)
            ?? versions.find((version) => version.is_active)
            ?? versions[0]
          )?.id ?? null;

          get().hydrateMessageVersions(parentId, versions, activeVersionId);
        }
      }
    }

    _multiModelFirstMessageId = null;
    _userManuallySelectedVersion = false;
    set({ multiModelParentId: null, multiModelDoneMessageIds: [] });
  },

  deleteMessage: async (messageId) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;

    const targetMessage = get().messages.find((message) => message.id === messageId) ?? null;
    let nextActiveVersion: Message | null = null;
    if (targetMessage?.role === 'assistant' && targetMessage.parent_message_id && targetMessage.is_active) {
      try {
        const versions = await get().listMessageVersions(conversationId, targetMessage.parent_message_id);
        nextActiveVersion = selectNextAssistantVersion(versions, messageId);
      } catch {
        nextActiveVersion = selectNextAssistantVersion(
          get().messages.filter((message) =>
            message.parent_message_id === targetMessage.parent_message_id && message.role === 'assistant'
          ),
          messageId,
        );
      }
    }

    const applyLocalDelete = () => {
      set((s) => {
        const messages = s.messages
          .filter((message) => message.id !== messageId)
          .map((message) => {
            if (!targetMessage?.parent_message_id || !nextActiveVersion) {
              return message;
            }
            if (message.parent_message_id !== targetMessage.parent_message_id || message.role !== 'assistant') {
              return message;
            }
            return { ...message, is_active: message.id === nextActiveVersion.id };
          });
        return { messages };
      });
    };

    // Client-only messages (temp IDs) — just remove locally
    if (messageId.startsWith('temp-')) {
      applyLocalDelete();
      return;
    }
    try {
      await invoke('delete_message', { id: messageId });
      if (targetMessage?.parent_message_id && nextActiveVersion && !nextActiveVersion.id.startsWith('temp-')) {
        await get().switchMessageVersion(
          conversationId,
          targetMessage.parent_message_id,
          nextActiveVersion.id,
        );
        return;
      }
      if (targetMessage?.role === 'assistant') {
        await get().fetchMessages(conversationId);
        if (targetMessage.parent_message_id) {
          const versions = await get().listMessageVersions(conversationId, targetMessage.parent_message_id);
          if (versions.length > 0) {
            get().hydrateMessageVersions(targetMessage.parent_message_id, versions);
          }
        }
        return;
      }
      applyLocalDelete();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchMessages: async (conversationId, preserveMessageIds = []) => {
    const requestSeq = _activeMessageLoadSeq;
    set({ loading: true });
    try {
      const page = await invoke<MessagePage>('list_messages_page', {
        conversationId,
        limit: MESSAGE_PAGE_SIZE,
        beforeMessageId: null,
      });
      if (requestSeq !== _activeMessageLoadSeq || get().activeConversationId !== conversationId) {
        return;
      }

      set((s) => {
        const messages = mergePreservedMessages(page.messages, preserveMessageIds, s.messages);
        return {
          messages,
          loading: false,
          loadingOlder: false,
          hasOlderMessages: page.has_older,
          totalActiveCount: page.total_active_count,
          oldestLoadedMessageId: messages[0]?.id ?? page.oldest_message_id,
          error: null,
        };
      });
    } catch (e) {
      if (requestSeq !== _activeMessageLoadSeq || get().activeConversationId !== conversationId) {
        return;
      }
      set({ error: String(e), loading: false, loadingOlder: false });
    }
  },

  loadOlderMessages: async () => {
    const { activeConversationId, oldestLoadedMessageId, hasOlderMessages, loading, loadingOlder } = get();
    if (!activeConversationId || !oldestLoadedMessageId || !hasOlderMessages || loading || loadingOlder) {
      return;
    }

    const requestSeq = _activeMessageLoadSeq;
    set({ loadingOlder: true, error: null });
    try {
      const page = await invoke<MessagePage>('list_messages_page', {
        conversationId: activeConversationId,
        limit: MESSAGE_PAGE_SIZE,
        beforeMessageId: oldestLoadedMessageId,
      });
      if (requestSeq !== _activeMessageLoadSeq || get().activeConversationId !== activeConversationId) {
        return;
      }

      set((s) => ({
        messages: mergeOlderPages(page.messages, s.messages),
        loadingOlder: false,
        hasOlderMessages: page.has_older,
        totalActiveCount: page.total_active_count,
        oldestLoadedMessageId: page.oldest_message_id ?? s.oldestLoadedMessageId,
        error: null,
      }));
    } catch (e) {
      if (requestSeq !== _activeMessageLoadSeq || get().activeConversationId !== activeConversationId) {
        return;
      }
      set({ error: String(e), loadingOlder: false });
    }
  },

  searchConversations: async (query) => {
    try {
      return await invoke<ConversationSearchResult[]>('search_conversations', { query });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  startStreamListening: async () => {
    // Increment generation and clean up previous listeners
    const gen = ++_listenerGen;
    if (_unlisten) {
      _unlisten();
      _unlisten = null;
    }

    const chunkUnsub = await listen<ChatStreamEvent>('chat-stream-chunk', (event) => {
      if (_listenerGen !== gen) return; // stale listener
      if (!get().streaming) return; // cancelled
      const { conversation_id, message_id, chunk, model_id: evt_model_id, provider_id: evt_provider_id } = event.payload;

      if (chunk.done) {
        if (chunk.is_final === false) {
          // Append any remaining content in the done chunk (e.g. closing </think> tag)
          if (chunk.content) {
            appendStreamChunk(set, get, message_id, chunk.content, conversation_id, evt_model_id, evt_provider_id);
          }
          flushPendingStreamChunk(set, get);
          // Clear thinking state — this iteration is done
          if (get().thinkingActiveMessageIds.has(message_id)) {
            set((s) => {
              const next = new Set(s.thinkingActiveMessageIds);
              next.delete(message_id);
              return { thinkingActiveMessageIds: next };
            });
          }
          return;
        }

        // Unified multi-model handler: applies to ALL models (first + companions)
        if (_isMultiModelActive) {
          _multiModelTotalRemaining--;
          flushPendingStreamChunk(set, get);
          _streamBuffer = null;

          // Clear streamingMessageId and mark completed message as 'complete'
          set((s) => {
            const updated: Partial<ConversationState> = {};
            if (s.streamingMessageId === message_id) {
              // This is the first model finishing — save its message_id for later version switching
              _multiModelFirstMessageId = message_id;
              updated.streamingMessageId = null;
            }
            // Clear thinking state for this completed model
            if (s.thinkingActiveMessageIds.has(message_id)) {
              const nextThinking = new Set(s.thinkingActiveMessageIds);
              nextThinking.delete(message_id);
              updated.thinkingActiveMessageIds = nextThinking;
            }
            updated.conversations = s.conversations.map((c) =>
              c.id === conversation_id ? { ...c, message_count: c.message_count + 1 } : c,
            );
            // Update completed message status to prevent "主动停止" tag
            updated.messages = s.messages.map((m) =>
              m.id === message_id ? { ...m, status: 'complete' } : m,
            );
            // Track per-model completion for individual loading indicators
            updated.multiModelDoneMessageIds = [...s.multiModelDoneMessageIds, message_id];
            return updated;
          });

          if (_multiModelTotalRemaining <= 0) {
            // All models done
            set({
              streaming: false,
              streamingMessageId: null,
              streamingConversationId: null,
              thinkingActiveMessageIds: new Set<string>(),
            });
            if (_multiModelDoneResolve) {
              const resolve = _multiModelDoneResolve;
              _multiModelDoneResolve = null;
              resolve();
            }
          }
          return;
        }

        const placeholderMessageId = get().streamingMessageId;
        flushPendingStreamChunk(set, get);
        const flushedMessageId = get().streamingMessageId ?? message_id;
        // Only preserve real backend IDs — temp placeholders (temp-assistant-*)
        // must NOT be preserved alongside the DB message, otherwise both the
        // unresolved placeholder and the DB row survive the merge (different
        // ids, same parent_message_id → duplicate bubble + React key collision).
        const preserveMessageIds = Array.from(
          new Set(
            [placeholderMessageId, flushedMessageId, message_id].filter(
              (value): value is string => typeof value === 'string' && value.length > 0 && !value.startsWith('temp-'),
            ),
          ),
        );
        set((s) => ({
          streaming: false,
          streamingMessageId: null,
          streamingConversationId: null,
          thinkingActiveMessageIds: new Set<string>(),
          conversations: s.conversations.map((c) =>
            c.id === conversation_id
              ? { ...c, message_count: c.message_count + 1 }
              : c,
          ),
          // Update completed message status immediately to prevent "主动停止" tag flash
          messages: s.messages.map((m) =>
            preserveMessageIds.includes(m.id) ? { ...m, status: 'complete' as const } : m,
          ),
        }));
        if (get().activeConversationId === conversation_id) {
          // Active conversation — refresh messages then clear buffer
          _streamBuffer = null;
          window.setTimeout(() => {
            void get().fetchMessages(
              conversation_id,
              preserveMessageIds,
            );
          }, 120);
        } else {
          // User is viewing a different conversation — keep buffer alive and
          // schedule a refresh so the completed message loads from DB when
          // the user switches back.
          _pendingConversationRefresh.add(conversation_id);
        }
        return;
      }

      if (chunk.thinking !== undefined && chunk.thinking !== null && !get().thinkingActiveMessageIds.has(message_id)) {
        set((s) => ({ thinkingActiveMessageIds: new Set([...s.thinkingActiveMessageIds, message_id]) }));
      }
      if (chunk.content && get().thinkingActiveMessageIds.has(message_id) && (chunk.thinking === undefined || chunk.thinking === null)) {
        set((s) => {
          const next = new Set(s.thinkingActiveMessageIds);
          next.delete(message_id);
          return { thinkingActiveMessageIds: next };
        });
      }

      appendStreamChunk(set, get, message_id, chunk.content, conversation_id, evt_model_id, evt_provider_id);
    });

    const errorUnsub = await listen<ChatStreamErrorEvent>('chat-stream-error', (event) => {
      if (_listenerGen !== gen) return; // stale listener
      if (!get().streaming) return; // cancelled
      const {
        conversation_id,
        message_id,
        error: errMsg,
        model_id: evt_model_id,
        provider_id: evt_provider_id,
      } = event.payload;

      flushPendingStreamChunk(set, get);
      _streamBuffer = null; // Clear buffer on error

      // Multi-model: treat error as stream completion for this model
      if (_isMultiModelActive) {
        _multiModelTotalRemaining--;
        console.error(`[multi-model] stream error:`, errMsg);
        // Mark this model as done so ModelTags stops showing loading indicator
        set((s) => {
          const result = applyMultiModelStreamError(s.messages, {
            conversationId: conversation_id,
            parentMessageId: s.multiModelParentId,
            streamingMessageId: s.streamingMessageId,
            messageId: message_id,
            error: errMsg,
            modelId: evt_model_id,
            providerId: evt_provider_id,
          });
          return {
            multiModelDoneMessageIds: [...s.multiModelDoneMessageIds, message_id],
            streamingMessageId: result.streamingMessageId,
            messages: result.messages,
          };
        });
        if (_multiModelTotalRemaining <= 0) {
          set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageIds: new Set<string>() });
          if (_multiModelDoneResolve) { const r = _multiModelDoneResolve; _multiModelDoneResolve = null; r(); }
        }
        return;
      }

      // Only show error if still on the same conversation
      if (get().activeConversationId !== conversation_id) {
        set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageIds: new Set<string>() });
        return;
      }

      // Update the streaming message to show error inline
      set((s) => ({
        streaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        thinkingActiveMessageIds: new Set<string>(),
        messages: s.messages.map(m =>
          m.id === message_id || m.id === s.streamingMessageId
            ? { ...m, content: errMsg, status: 'error' as const }
            : m
        ),
      }));
    });

    const titleUnsub = await listen<{ conversation_id: string; title: string }>('conversation-title-updated', (event) => {
      if (_listenerGen !== gen) return;
      const { conversation_id, title } = event.payload;
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversation_id ? { ...c, title } : c,
        ),
      }));
    });

    const titleGenUnsub = await listen<{ conversation_id: string; generating: boolean; error: string | null }>('conversation-title-generating', (event) => {
      if (_listenerGen !== gen) return;
      const { conversation_id, generating, error } = event.payload;
      set({ titleGeneratingConversationId: generating ? conversation_id : null });
      if (!generating && error) {
        console.error('[title-gen] AI title generation failed:', error);
        set({ error });
      }
    });

    const ragUnsub = await listen<RagContextRetrievedEvent>('rag-context-retrieved', (event) => {
      if (_listenerGen !== gen) return;
      if (!get().streaming) return;
      const { conversation_id, sources } = event.payload;

      // Split sources by type and build separate tags
      const knowledgeSources = sources.filter(s => s.source_type === 'knowledge');
      const memorySources = sources.filter(s => s.source_type === 'memory');

      const kbSearching = buildKnowledgeTag('searching');
      const memSearching = buildMemoryTag('searching');
      const kbDone = knowledgeSources.length > 0 ? buildKnowledgeTag('done', knowledgeSources) : '';
      const memDone = memorySources.length > 0 ? buildMemoryTag('done', memorySources) : '';

      // Replace each searching tag with its done counterpart (or remove if empty)
      const replaceTag = (content: string, searching: string, done: string) => {
        if (content.includes(searching)) return content.replace(searching, done);
        if (done) return done + content;
        return content;
      };

      if (_streamBuffer && _streamBuffer.conversationId === conversation_id) {
        _streamBuffer.content = replaceTag(_streamBuffer.content, kbSearching, kbDone);
        _streamBuffer.content = replaceTag(_streamBuffer.content, memSearching, memDone);
      } else {
        _streamPrefix = replaceTag(_streamPrefix, kbSearching, kbDone);
        _streamPrefix = replaceTag(_streamPrefix, memSearching, memDone);
      }

      // Update UI immediately
      if (get().activeConversationId === conversation_id) {
        const msgId = get().streamingMessageId;
        if (msgId) {
          set((s) => ({
            messages: s.messages.map(m => {
              if (m.id !== msgId) return m;
              let updated = m.content;
              updated = replaceTag(updated, kbSearching, kbDone);
              updated = replaceTag(updated, memSearching, memDone);
              return { ...m, content: updated };
            }),
          }));
        }
      }
    });

    // If generation changed while awaiting, this listener set is stale
    if (_listenerGen !== gen) {
      chunkUnsub();
      errorUnsub();
      titleUnsub();
      titleGenUnsub();
      ragUnsub();
      return;
    }

    _unlisten = () => {
      chunkUnsub();
      errorUnsub();
      titleUnsub();
      titleGenUnsub();
      ragUnsub();
    };
  },

  stopStreamListening: () => {
    _listenerGen++;
    if (_unlisten) {
      _unlisten();
      _unlisten = null;
    }
  },

  cancelCurrentStream: () => {
    if (_activeAgentCancel) {
      _activeAgentCancel();
    } else {
      _agentStreamSeq++;
    }
    flushPendingStreamChunk(set, get);
    _pendingUiChunk = null;
    _streamBuffer = null;
    _pendingConversationRefresh.clear();
    // Clean up multi-model state on cancel
    if (_isMultiModelActive) {
      _isMultiModelActive = false;
      _multiModelTotalRemaining = 0;
      _multiModelFirstModelId = null;
      _multiModelFirstMessageId = null;
      _userManuallySelectedVersion = false;
      if (_multiModelDoneResolve) {
        const r = _multiModelDoneResolve;
        _multiModelDoneResolve = null;
        r();
      }
      set({ pendingCompanionModels: [], multiModelParentId: null, multiModelDoneMessageIds: [] });
    }
    if (_streamUiFlushTimer !== null) {
      clearTimeout(_streamUiFlushTimer);
      _streamUiFlushTimer = null;
    }
    // Tell the backend to cancel the stream — fire and forget
    const conversationId = get().streamingConversationId ?? get().activeConversationId;
    if (conversationId && isTauri()) {
      invoke('cancel_stream', { conversationId }).catch(() => {});
      // Also cancel the agent if in agent mode
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (conv?.mode === 'agent') {
        invoke('agent_cancel', { conversationId }).catch(() => {});
      }
    }
    // Mark the current streaming message as partial
    const streamMsgId = get().streamingMessageId;
    set((s) => ({
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageIds: new Set<string>(),
      messages: streamMsgId
        ? s.messages.map(m => m.id === streamMsgId ? { ...m, status: 'partial' as const } : m)
        : s.messages,
    }));
  },

  hydrateMessageVersions: (parentMessageId, versions, activeMessageId) => {
    const resolvedActiveMessageId = activeMessageId
      ?? versions.find((version) => version.is_active)?.id
      ?? null;
    set((s) => ({
      messages: mergeAssistantVersionGroup(
        s.messages,
        parentMessageId,
        versions,
        resolvedActiveMessageId,
      ),
      streamingMessageId: (() => {
        if (!s.streamingMessageId?.startsWith('temp-')) {
          return s.streamingMessageId;
        }
        const placeholder = s.messages.find((message) => message.id === s.streamingMessageId);
        if (!placeholder || placeholder.parent_message_id !== parentMessageId) {
          return s.streamingMessageId;
        }
        const resolved = versions.find((version) =>
          version.model_id === placeholder.model_id
          && version.provider_id === placeholder.provider_id
        );
        return resolved?.id ?? s.streamingMessageId;
      })(),
    }));
  },

  switchMessageVersion: async (conversationId, parentMessageId, messageId) => {
    try {
      if (_isMultiModelActive) {
        // During multi-model streaming, skip the backend call entirely to avoid:
        // 1. Race conditions with concurrent regenerate_with_model calls
        // 2. invoke delay causing stale content display
        // 3. Potential invoke failures during active streaming
        // Just swap is_active flags in-memory; backend will be synced during cleanup.
        _userManuallySelectedVersion = true;
        set((s) => {
          const targetExists = s.messages.some(
            (m) => m.id === messageId && m.parent_message_id === parentMessageId && m.role === 'assistant',
          );
          if (!targetExists) return {}; // Target not in memory yet, no-op
          return {
            messages: s.messages.map((m) => {
              if (m.parent_message_id !== parentMessageId || m.role !== 'assistant') return m;
              return m.id === messageId
                ? { ...m, is_active: true }
                : { ...m, is_active: false };
            }),
          };
        });
        return;
      }

      await invoke('switch_message_version', { conversationId, parentMessageId, messageId });

      // Normal path: fetch all versions from DB and keep them all in store
      // with correct is_active flags. This preserves multi-model detection
      // (multiModelResponseParents) which needs multiple versions visible.
      const versions = await get().listMessageVersions(conversationId, parentMessageId);
      if (versions.length > 0) {
        set((s) => ({
          messages: mergeAssistantVersionsAfterSwitch(
            s.messages,
            parentMessageId,
            versions,
            messageId,
          ),
        }));
      }
    } catch (e) {
      set({ error: String(e) });
      await get().fetchMessages(conversationId);
    }
  },

  listMessageVersions: async (conversationId, parentMessageId) => {
    try {
      return await invoke<Message[]>('list_message_versions', { conversationId, parentMessageId });
    } catch (e) {
      set({ error: String(e) });
      return [];
    }
  },

  updateMessageContent: async (messageId, content) => {
    try {
      const updated = await invoke<Message>('update_message_content', { id: messageId, content });
      set((s) => ({
        messages: s.messages.map((m) => (m.id === messageId ? { ...m, content: updated.content } : m)),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteMessageGroup: async (conversationId, userMessageId) => {
    // Client-only messages (temp IDs) — just remove locally
    if (userMessageId.startsWith('temp-')) {
      set((s) => ({
        messages: s.messages.filter(m =>
          m.id !== userMessageId && m.parent_message_id !== userMessageId
        ),
      }));
      return;
    }
    try {
      await invoke('delete_message_group', { conversationId, userMessageId });
      set((s) => ({
        messages: s.messages.filter(m =>
          m.id !== userMessageId && m.parent_message_id !== userMessageId
        ),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  workspaceSnapshot: null,

  loadWorkspaceSnapshot: async (conversationId) => {
    try {
      const snapshot = await invoke<ConversationWorkspaceSnapshot>('get_workspace_snapshot', {
        conversation_id: conversationId,
      });
      set({ workspaceSnapshot: snapshot });
      return snapshot;
    } catch {
      set({ workspaceSnapshot: null });
      return null;
    }
  },

  updateWorkspaceSnapshot: async (conversationId, snapshot) => {
    try {
      await invoke('update_workspace_snapshot', {
        conversation_id: conversationId,
        ...snapshot,
      });
      set((s) => ({
        workspaceSnapshot: s.workspaceSnapshot
          ? { ...s.workspaceSnapshot, ...snapshot }
          : null,
      }));
    } catch (e) {
      console.error('Failed to update workspace snapshot:', e);
    }
  },

  forkConversation: async (conversationId, fromMessageId?) => {
    try {
      const branch = await invoke<ConversationBranch>('fork_conversation', {
        conversation_id: conversationId,
        message_id: fromMessageId,
      });
      const { fetchConversations } = get();
      await fetchConversations();
      return branch;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  compareResponses: async (leftMessageId, rightMessageId) => {
    try {
      return await invoke<CompareResponsesResult>('compare_branches', {
        branch_a: leftMessageId,
        branch_b: rightMessageId,
      });
    } catch {
      return null;
    }
  },
}));
