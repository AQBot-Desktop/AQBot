import { create } from 'zustand';
import { invoke, listen, type UnlistenFn, isTauri } from '@/lib/invoke';
import { supportsReasoning, findModelByIds } from '@/lib/modelCapabilities';
import { formatSearchContent, buildSearchTag } from '@/lib/searchUtils';
import { useProviderStore } from '@/stores/providerStore';
import { useSearchStore } from '@/stores/searchStore';
import type {
  Conversation,
  Message,
  MessagePage,
  AttachmentInput,
  ConversationSearchResult,
  UpdateConversationInput,
  ChatStreamEvent,
  ChatStreamErrorEvent,
  ConversationWorkspaceSnapshot,
  ConversationBranch,
  CompareResponsesResult,
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
  thinking: string;
  /** The real message ID resolved from the backend (may differ from initial placeholder) */
  resolvedId: string | null;
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
  thinking: string;
}
let _pendingUiChunk: PendingUiChunk | null = null;
let _streamUiFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _activeMessageLoadSeq = 0;
const _conversationPreferenceSaveSeq = new Map<string, number>();
const MESSAGE_PAGE_SIZE = 10;

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
    if (localMessage && !merged.has(messageId)) {
      merged.set(messageId, localMessage);
    }
  }

  return Array.from(merged.values()).sort((left, right) => left.created_at - right.created_at);
}

function mergeOlderPages(olderMessages: Message[], currentMessages: Message[]): Message[] {
  const merged = new Map<string, Message>();
  for (const message of olderMessages) {
    merged.set(message.id, message);
  }
  for (const message of currentMessages) {
    merged.set(message.id, message);
  }
  return Array.from(merged.values()).sort((left, right) => left.created_at - right.created_at);
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
  oldestLoadedMessageId: string | null;
  streaming: boolean;
  streamingMessageId: string | null;
  streamingConversationId: string | null;
  thinkingActiveMessageId: string | null;
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
  fetchConversations: () => Promise<void>;
  setActiveConversation: (id: string | null) => void;
  createConversation: (title: string, modelId: string, providerId: string) => Promise<Conversation>;
  updateConversation: (id: string, input: UpdateConversationInput) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  toggleArchive: (id: string) => Promise<void>;
  archivedConversations: Conversation[];
  fetchArchivedConversations: () => Promise<void>;
  batchDelete: (ids: string[]) => Promise<void>;
  batchArchive: (ids: string[]) => Promise<void>;
  sendMessage: (content: string, attachments?: AttachmentInput[], searchProviderId?: string | null) => Promise<void>;
  regenerateMessage: (targetMessageId?: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  fetchMessages: (conversationId: string, preserveMessageIds?: string[]) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  searchConversations: (query: string) => Promise<ConversationSearchResult[]>;
  startStreamListening: () => Promise<void>;
  stopStreamListening: () => void;
  switchMessageVersion: (conversationId: string, parentMessageId: string, messageId: string) => Promise<void>;
  listMessageVersions: (conversationId: string, parentMessageId: string) => Promise<Message[]>;
  deleteMessageGroup: (conversationId: string, userMessageId: string) => Promise<void>;
  workspaceSnapshot: ConversationWorkspaceSnapshot | null;
  loadWorkspaceSnapshot: (conversationId: string) => Promise<ConversationWorkspaceSnapshot | null>;
  updateWorkspaceSnapshot: (conversationId: string, snapshot: Partial<ConversationWorkspaceSnapshot>) => Promise<void>;
  forkConversation: (conversationId: string, fromMessageId?: string) => Promise<ConversationBranch | null>;
  compareResponses: (leftMessageId: string, rightMessageId: string) => Promise<CompareResponsesResult | null>;
}

function appendStreamChunk(
  set: (fn: (s: ConversationState) => Partial<ConversationState>) => void,
  get: () => ConversationState,
  messageId: string,
  content: string | null,
  thinking: string | null,
  conversationId: string,
) {
  // Always accumulate into the stream buffer
  if (!_streamBuffer || _streamBuffer.conversationId !== conversationId) {
    _streamBuffer = { messageId, conversationId, content: _streamPrefix, thinking: '', resolvedId: null };
    _streamPrefix = ''; // consumed
  }
  _streamBuffer.content += content ?? '';
  _streamBuffer.thinking += thinking ?? '';
  // Track ID resolution (placeholder → real ID)
  if (_streamBuffer.messageId !== messageId && !_streamBuffer.resolvedId) {
    _streamBuffer.resolvedId = messageId;
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
      thinking: '',
    };
  }

  _pendingUiChunk.content += content ?? '';
  _pendingUiChunk.thinking += thinking ?? '';

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

  const { messageId, content, thinking, conversationId } = pending;
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
                thinking: (m.thinking ?? '') + (thinking ?? '') || null,
              }
            : m,
        ),
      };
    }

    // 2. ID mismatch but placeholder exists — replace placeholder ID with real one
    if (s.streamingMessageId && s.streamingMessageId !== messageId) {
      const placeholder = s.messages.find((m) => m.id === s.streamingMessageId);
      if (placeholder) {
        return {
          messages: s.messages.map((m) =>
            m.id === s.streamingMessageId
              ? {
                  ...m,
                  id: messageId,
                  content: m.content + (content ?? ''),
                  thinking: (m.thinking ?? '') + (thinking ?? '') || null,
                }
              : m,
          ),
          streamingMessageId: messageId,
        };
      }
    }

    // 3. No placeholder found — create new assistant message with full buffered content
    const newMessage: Message = {
      id: messageId,
      conversation_id: conversationId,
      role: 'assistant',
      content: _streamBuffer?.content ?? (content ?? ''),
      provider_id: null,
      model_id: null,
      token_count: null,
      attachments: [],
      thinking: (_streamBuffer?.thinking || thinking) || null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: Date.now(),
      parent_message_id: null,
      version_index: 0,
      is_active: true,
    };
    return {
      messages: [...s.messages, newMessage],
      streamingMessageId: messageId,
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
  oldestLoadedMessageId: null,
  streaming: false,
  streamingMessageId: null,
  streamingConversationId: null,
  thinkingActiveMessageId: null,
  error: null,
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
      };
      set((s) => ({ messages: [...s.messages, localMsg] }));
    }
  },
  removeContextClear: async (messageId) => {
    if (messageId.startsWith('ctx-clear-') || messageId.startsWith('temp-')) {
      set((s) => ({ messages: s.messages.filter((m) => m.id !== messageId) }));
      return;
    }

    try {
      await invoke('delete_message', { id: messageId });
      set((s) => ({ messages: s.messages.filter((m) => m.id !== messageId) }));
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
      set({ messages: [], hasOlderMessages: false, oldestLoadedMessageId: null, loadingOlder: false });
    } catch (e) {
      console.error('Failed to clear messages:', e);
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

  createConversation: async (title, modelId, providerId) => {
    try {
      const createdConversation = await invoke<Conversation>('create_conversation', {
        title,
        modelId,
        providerId,
      });
      let conversation = createdConversation;
      try {
        conversation = await invoke<Conversation>('update_conversation', {
          id: createdConversation.id,
          input: conversationPreferenceUpdateFromState(get()),
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
    };

    // Create assistant placeholder upfront (for search status or streaming)
    const tempAssistantId = `temp-assistant-${Date.now()}`;
    const placeholderAssistant: Message = {
      id: tempAssistantId,
      conversation_id: conversationId,
      role: 'assistant',
      content: searchProviderId ? buildSearchTag('searching') : '',
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
    };

    set((s) => ({
      messages: [...s.messages, optimisticUserMsg, placeholderAssistant],
      streaming: true,
      streamingConversationId: conversationId,
      streamingMessageId: tempAssistantId,
      thinkingActiveMessageId: null,
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
          console.warn('[sendMessage] search failed, sending without search:', e);
        }
        // Replace searching tag with results (or empty if search failed)
        _streamPrefix = searchResultTag;
        set((s) => ({
          messages: s.messages.map(m =>
            m.id === tempAssistantId ? { ...m, content: searchResultTag } : m
          ),
        }));
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
        set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageId: null });
        get().fetchMessages(conversationId);
      }
    } catch (e) {
      console.error('[sendMessage] error:', e);
      const errMsg = String(e);
      set((s) => ({
        streaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        thinkingActiveMessageId: null,
        messages: s.streamingMessageId
          ? s.messages.map(m =>
              m.id === s.streamingMessageId
                ? { ...m, content: `%%ERROR%%${errMsg}` }
                : m
            )
          : [...s.messages, {
              id: `temp-error-${Date.now()}`,
              conversation_id: conversationId,
              role: 'assistant' as const,
              content: `%%ERROR%%${errMsg}`,
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
            }],
      }));
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

    // Create placeholder for new version
    const tempAssistantId = `temp-assistant-${Date.now()}`;
    const placeholderAssistant: Message = {
      id: tempAssistantId,
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      provider_id: null,
      model_id: null,
      token_count: null,
      attachments: [],
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: Date.now(),
      parent_message_id: userMsg.id,
      version_index: 0,
      is_active: true,
    };

    // Replace active AI message for this user msg with placeholder
    const parentId = userMsg.id;
    set((s) => ({
      messages: s.messages.map(m => {
        if (m.parent_message_id === parentId && m.is_active) {
          return { ...m, is_active: false };
        }
        return m;
      }).concat(placeholderAssistant),
      streaming: true,
      streamingMessageId: tempAssistantId,
      streamingConversationId: conversationId,
      thinkingActiveMessageId: null,
    }));
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
        enabledMcpServerIds: rMcpIds.length > 0 ? rMcpIds : undefined,
        thinkingBudget: rThinkingBudget,
        enabledKnowledgeBaseIds: rKbIds.length > 0 ? rKbIds : undefined,
        enabledMemoryNamespaceIds: rMemIds.length > 0 ? rMemIds : undefined,
      });

      // In browser mode, simulate brief loading then fetch the mock AI response
      if (!isTauri()) {
        await new Promise((r) => setTimeout(r, 600));
        set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageId: null });
        get().fetchMessages(conversationId);
      }
    } catch (e) {
      console.error('[regenerateMessage] error:', e);
      const errMsg = String(e);
      set((s) => ({
        streaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        thinkingActiveMessageId: null,
        messages: s.streamingMessageId
          ? s.messages.map(m =>
              m.id === s.streamingMessageId
                ? { ...m, content: `%%ERROR%%${errMsg}` }
                : m
            )
          : s.messages,
      }));
    }
  },

  deleteMessage: async (messageId) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    // Client-only messages (temp IDs) — just remove locally
    if (messageId.startsWith('temp-')) {
      set((s) => ({
        messages: s.messages.filter((m) => m.id !== messageId),
      }));
      return;
    }
    try {
      await invoke('delete_message', { id: messageId });
      set((s) => ({
        messages: s.messages.filter((m) => m.id !== messageId),
      }));
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
      const { conversation_id, message_id, chunk } = event.payload;

      if (chunk.done) {
        if (chunk.is_final === false) {
          flushPendingStreamChunk(set, get);
          return;
        }
        const placeholderMessageId = get().streamingMessageId;
        flushPendingStreamChunk(set, get);
        const flushedMessageId = get().streamingMessageId ?? message_id;
        const preserveMessageIds = Array.from(
          new Set(
            [placeholderMessageId, flushedMessageId, message_id].filter(
              (value): value is string => Boolean(value),
            ),
          ),
        );
        set((s) => ({
          streaming: false,
          streamingMessageId: null,
          streamingConversationId: null,
          thinkingActiveMessageId: null,
          conversations: s.conversations.map((c) =>
            c.id === conversation_id
              ? { ...c, message_count: c.message_count + 1 }
              : c,
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

      if (chunk.thinking && get().thinkingActiveMessageId !== message_id) {
        set({ thinkingActiveMessageId: message_id });
      }
      if (chunk.content && get().thinkingActiveMessageId === message_id) {
        set({ thinkingActiveMessageId: null });
      }

      appendStreamChunk(set, get, message_id, chunk.content, chunk.thinking, conversation_id);
    });

    const errorUnsub = await listen<ChatStreamErrorEvent>('chat-stream-error', (event) => {
      if (_listenerGen !== gen) return; // stale listener
      if (!get().streaming) return; // cancelled
      const { conversation_id, message_id, error: errMsg } = event.payload;

      flushPendingStreamChunk(set, get);
      _streamBuffer = null; // Clear buffer on error

      // Only show error if still on the same conversation
      if (get().activeConversationId !== conversation_id) {
        set({ streaming: false, streamingMessageId: null, streamingConversationId: null, thinkingActiveMessageId: null });
        return;
      }

      // Update the streaming message to show error inline
      set((s) => ({
        streaming: false,
        streamingMessageId: null,
        streamingConversationId: null,
        thinkingActiveMessageId: null,
        messages: s.messages.map(m =>
          m.id === message_id || m.id === s.streamingMessageId
            ? { ...m, content: `%%ERROR%%${errMsg}` }
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

    // If generation changed while awaiting, this listener set is stale
    if (_listenerGen !== gen) {
      chunkUnsub();
      errorUnsub();
      titleUnsub();
      return;
    }

    _unlisten = () => {
      chunkUnsub();
      errorUnsub();
      titleUnsub();
    };
  },

  stopStreamListening: () => {
    flushPendingStreamChunk(set, get);
    _listenerGen++;
    if (_unlisten) {
      _unlisten();
      _unlisten = null;
    }
    _pendingUiChunk = null;
    _streamBuffer = null;
    _pendingConversationRefresh.clear();
    if (_streamUiFlushTimer !== null) {
      clearTimeout(_streamUiFlushTimer);
      _streamUiFlushTimer = null;
    }
    set({
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      thinkingActiveMessageId: null,
    });
  },

  switchMessageVersion: async (conversationId, parentMessageId, messageId) => {
    try {
      await invoke('switch_message_version', { conversationId, parentMessageId, messageId });
      await get().fetchMessages(conversationId);
    } catch (e) {
      set({ error: String(e) });
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

  deleteMessageGroup: async (conversationId, userMessageId) => {
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
