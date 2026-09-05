import { invoke, isTauri } from '@/lib/invoke';
import { applyRemovedConversationIds } from '@/lib/conversationTabsActions';
import { emitConversationSync, notifyConversationChanged } from '@/lib/conversationSync';
import {
  clearLegacyMultiModelPreferenceKeys,
  getCompanionModelsStorageKey,
  getMultiModelContinuationStorageKey,
  normalizeMultiModelContinuationMode,
  readLegacyCompanionModels,
} from '@/lib/multiModelContinuation';
import {
  compareConversationOrder,
  getUncategorizedConversationGroup,
  UNCATEGORIZED_GROUP_ORDER,
} from '@/lib/conversationOrder';
import {
  mergeAssistantVersionGroup,
} from '@/lib/chatMultiModel';
import { perfNow, perfTrace, perfTraceDuration } from '@/lib/perfTrace';
import { isResourceFresh } from '@/lib/resourceState';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCategoryStore } from './categoryStore';
import { isLiveConversationRun, mirrorActiveStreamFields } from './conversationRunRegistry';
import type {
  CompareResponsesResult,
  ContextUsage,
  Conversation,
  ConversationBranch,
  ConversationSummary,
  ConversationWorkspaceSnapshot,
  Message,
  MultiModelDisplayMode,
} from '@/types';
import {
  CONVERSATIONS_RESOURCE_KEY,
  cacheMessageState,
  categoryTemplateUpdateFromCategory,
  collectActiveStreamingMessageIds,
  conversationPreferenceStateFromConversation,
  conversationPreferenceUpdateFromState,
  conversationRuntime as runtime,
  emptyConversationPreferenceUpdate,
  getStreamBuffer,
  setStreamBuffer,
  findResolvedVersionForPendingSelection,
  getMessageVersionGroupResourceKey,
  invalidateConversationMessageCache,
  isTemporaryMessageId,
  mergeConversationCollections,
  mergeDbRagDisplayPrefix,
  mutateConversationsMeta,
  persistConversationPreferences,
  readCachedMessageState,
  rememberPendingLocalVersionSelection,
  resolveHydratedStreamingMessageId,
  resolvePendingLocalVersionSelection,
  restoreActiveStreamBuffer,
  validateCachedMessageState,
  type ConversationState,
  type ConversationStoreSet,
  type PendingLocalVersionSelection,
} from './conversationStoreSupport';

async function migrateLegacyMultiModelPreferences(
  set: ConversationStoreSet,
  get: () => ConversationState,
  conversationId: string,
) {
  if (typeof window === 'undefined') return;
  const hasLegacyTargets = window.localStorage.getItem(getCompanionModelsStorageKey(conversationId)) != null;
  const hasLegacyMode = window.localStorage.getItem(getMultiModelContinuationStorageKey(conversationId)) != null;
  if (!hasLegacyTargets && !hasLegacyMode) return;

  const legacyTargets = hasLegacyTargets ? readLegacyCompanionModels(conversationId) : get().multiModelTargets;
  if (hasLegacyTargets && legacyTargets == null) {
    set({ error: `Failed to migrate multi-model selection for ${conversationId}` });
    return;
  }

  const nextTargets = legacyTargets ?? [];
  const nextMode = hasLegacyMode
    ? normalizeMultiModelContinuationMode(
      window.localStorage.getItem(getMultiModelContinuationStorageKey(conversationId)),
    )
    : get().multiModelContinuationMode;
  const previous = {
    multiModelTargets: get().multiModelTargets,
    multiModelContinuationMode: get().multiModelContinuationMode,
  };

  set({
    multiModelTargets: nextTargets,
    multiModelContinuationMode: nextMode,
  });
  try {
    const updated = await invoke<Conversation>('update_conversation', {
      id: conversationId,
      input: {
        multi_model_targets: nextTargets,
        multi_model_continuation_mode: nextMode,
      },
    });
    if (get().activeConversationId !== conversationId) return;
    set((state) => ({
      ...mergeConversationCollections(state.conversations, state.archivedConversations, updated),
      conversationsMeta: mutateConversationsMeta(state.conversationsMeta),
      ...conversationPreferenceStateFromConversation(updated),
      error: null,
    }));
    clearLegacyMultiModelPreferenceKeys(conversationId);
  } catch (error) {
    if (get().activeConversationId !== conversationId) return;
    set({
      ...previous,
      error: String(error),
    });
  }
}

type ConversationManagementActions = Pick<ConversationState,
  | 'setSearchEnabled'
  | 'setSearchProviderId'
  | 'setEnabledMcpServerIds'
  | 'toggleMcpServer'
  | 'setThinkingBudget'
  | 'setThinkingLevel'
  | 'setEnabledKnowledgeBaseIds'
  | 'toggleKnowledgeBase'
  | 'setEnabledMemoryNamespaceIds'
  | 'toggleMemoryNamespace'
  | 'setMultiModelTargets'
  | 'setMultiModelContinuationMode'
  | 'insertContextClear'
  | 'removeContextClear'
  | 'clearAllMessages'
  | 'clearFirstRounds'
  | 'compressContext'
  | 'getCompressionSummary'
  | 'retryCompression'
  | 'getContextUsage'
  | 'requestOpenCompressionSummary'
  | 'deleteCompression'
  | 'ensureConversationsLoaded'
  | 'invalidateConversations'
  | 'fetchConversations'
  | 'reorderConversations'
  | 'setActiveConversation'
  | 'createConversation'
  | 'updateConversation'
  | 'setConversationMultiModelDisplayMode'
  | 'renameConversation'
  | 'regenerateTitle'
  | 'deleteConversation'
  | 'branchConversation'
  | 'togglePin'
  | 'setConversationTabPinned'
  | 'toggleArchive'
  | 'fetchArchivedConversations'
  | 'batchDelete'
  | 'batchArchive'
  | 'batchMoveToCategory'
  | 'ensureMessageVersionGroupsLoaded'
  | 'invalidateMessageVersionGroups'
  | 'applyMessageVersionSnapshot'
  | 'hydrateMessageVersions'
  | 'switchMessageVersion'
  | 'listMessageVersions'
  | 'listMessageVersionsBatch'
  | 'updateMessageContent'
  | 'deleteMessageGroup'
  | 'loadWorkspaceSnapshot'
  | 'updateWorkspaceSnapshot'
  | 'forkConversation'
  | 'compareResponses'
>;

function buildTargetContainerOrder(
  conversations: readonly Conversation[],
  categoryId: string | null,
  priorityIds: readonly string[],
): string[] {
  const roots = conversations.filter((conversation) => (
    !conversation.is_archived
    && conversation.parent_conversation_id === null
    && (conversation.category_id ?? null) === categoryId
  ));
  const rootById = new Map(roots.map((conversation) => [conversation.id, conversation]));
  const priority = priorityIds.filter((id, index) => (
    rootById.has(id) && priorityIds.indexOf(id) === index
  ));
  const priorityIndex = new Map(priority.map((id, index) => [id, index]));
  const nowSeconds = Date.now() / 1000;
  const groupIndex = new Map(
    UNCATEGORIZED_GROUP_ORDER.map((group, index) => [group, index]),
  );
  return roots.sort((a, b) => {
    if (categoryId === null) {
      const aGroup = getUncategorizedConversationGroup(a, nowSeconds);
      const bGroup = getUncategorizedConversationGroup(b, nowSeconds);
      const groupDiff = (groupIndex.get(aGroup) ?? Number.MAX_SAFE_INTEGER)
        - (groupIndex.get(bGroup) ?? Number.MAX_SAFE_INTEGER);
      if (groupDiff !== 0) return groupDiff;
    }
    const aPriority = priorityIndex.get(a.id);
    const bPriority = priorityIndex.get(b.id);
    if (aPriority !== undefined && bPriority !== undefined) return aPriority - bPriority;
    if (aPriority !== undefined) return -1;
    if (bPriority !== undefined) return 1;
    return compareConversationOrder(a, b);
  }).map((conversation) => conversation.id);
}

function updateConversationDisplayModeState(
  state: ConversationState,
  input: { conversationId: string; mode: MultiModelDisplayMode | null },
): Pick<ConversationState, 'conversations' | 'archivedConversations' | 'conversationsMeta'> {
  const update = (conversation: Conversation) => conversation.id === input.conversationId
    ? { ...conversation, multi_model_display_mode_override: input.mode }
    : conversation;
  return {
    conversations: state.conversations.map(update),
    archivedConversations: state.archivedConversations.map(update),
    conversationsMeta: mutateConversationsMeta(state.conversationsMeta),
  };
}

export function createConversationManagementActions(
  set: ConversationStoreSet,
  get: () => ConversationState,
): ConversationManagementActions {
  const nextMessageVersionGroupRevision = (currentRevision = 0): number => {
    const revision = Math.max(runtime.messageVersionGroupRevision, currentRevision) + 1;
    runtime.messageVersionGroupRevision = revision;
    return revision;
  };
  const commitMessageVersionSnapshot = (
    conversationId: string,
    parentMessageId: string,
    versions: Message[],
  ) => {
    const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
    set((state) => {
      const current = state.messageVersionGroups[key];
      if (
        current?.versions === versions
        && current.meta.status === 'ready'
        && current.error === null
      ) {
        return {};
      }
      return {
        messageVersionGroups: {
          ...state.messageVersionGroups,
          [key]: {
            conversationId,
            parentMessageId,
            versions,
            error: null,
            meta: {
              status: 'ready' as const,
              key,
              loadedAt: Date.now(),
              revision: nextMessageVersionGroupRevision(current?.meta.revision),
            },
          },
        },
      };
    });
  };

  return {
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
    setThinkingLevel: (level) => {
      const previous = get().thinkingLevel;
      const conversationId = get().activeConversationId;
      set({ thinkingLevel: level });
      if (conversationId) {
        void persistConversationPreferences(
          set,
          conversationId,
          { thinking_level: level },
          { thinkingLevel: level },
          { thinkingLevel: previous },
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
    setMultiModelTargets: (targets) => {
      const previous = get().multiModelTargets;
      const nextTargets = [...targets];
      const conversationId = get().activeConversationId;
      set({ multiModelTargets: nextTargets });
      if (conversationId) {
        void emitConversationSync({
          conversationId,
          kind: 'conversation-meta',
          multiModelTargets: nextTargets,
        }).catch((error) => {
          console.error('[conversation-sync] Failed to synchronize multi-model order', error);
        });
        void persistConversationPreferences(
          set,
          conversationId,
          { multi_model_targets: nextTargets },
          { multiModelTargets: nextTargets },
          { multiModelTargets: previous },
        );
      }
    },
    setMultiModelContinuationMode: (mode) => {
      const previous = get().multiModelContinuationMode;
      const conversationId = get().activeConversationId;
      set({ multiModelContinuationMode: mode });
      if (conversationId) {
        void persistConversationPreferences(
          set,
          conversationId,
          { multi_model_continuation_mode: mode },
          { multiModelContinuationMode: mode },
          { multiModelContinuationMode: previous },
        );
      }
    },
    insertContextClear: async () => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      if (get().loading) throw new Error('Conversation messages are still loading');
      try {
        const msg = await invoke<Message>('send_system_message', {
          conversationId,
          content: '<!-- context-clear -->',
        });
        if (get().activeConversationId === conversationId) {
          set((s) => ({ messages: [...s.messages, msg] }));
        } else {
          invalidateConversationMessageCache(conversationId);
        }
        // Backup and clear agent SDK context (no-op if no agent session exists)
        await invoke('agent_backup_and_clear_sdk_context', { conversationId }).catch(() => {});
      } catch (error) {
        set({ error: String(error) });
        throw error;
      }
    },
    removeContextClear: async (messageId) => {
      const conversationId = get().activeConversationId;
      if (get().loading) throw new Error('Conversation messages are still loading');
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
      if (get().loading) throw new Error('Conversation messages are still loading');
      try {
        await invoke('clear_conversation_messages', { conversationId });
        invalidateConversationMessageCache(conversationId);
        if (get().activeConversationId !== conversationId) return;
        runtime.activeMessageLoadSeq += 1;
        set({
          messages: [],
          hasOlderMessages: false,
          hasNewerMessages: false,
          totalActiveCount: 0,
          oldestLoadedMessageId: null,
          newestLoadedMessageId: null,
          loadingOlder: false,
          loadingNewer: false,
        });
        notifyConversationChanged(conversationId);
      } catch (e) {
        console.error('Failed to clear messages:', e);
      }
    },
    clearFirstRounds: async (rounds) => {
      const conversationId = get().activeConversationId;
      const safeRounds = Math.trunc(rounds);
      if (!conversationId || !Number.isFinite(safeRounds) || safeRounds <= 0) return;
      if (get().loading) throw new Error('Conversation messages are still loading');
      try {
        await invoke('clear_conversation_first_rounds', { conversationId, rounds: safeRounds });
        invalidateConversationMessageCache(conversationId);
        if (get().activeConversationId === conversationId) {
          await get().fetchMessages(conversationId);
        }
      } catch (e) {
        set({ error: String(e) });
      }
    },
    compressContext: async () => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      if (get().loading) throw new Error('Conversation messages are still loading');
      set({ compressingConversationId: conversationId });
      try {
        await invoke<ConversationSummary>('compress_context', { conversationId });
        invalidateConversationMessageCache(conversationId);
        if (get().activeConversationId === conversationId) {
          await get().fetchMessages(conversationId);
        }
        set((state) => ({
          compressingConversationId: state.compressingConversationId === conversationId
            ? null
            : state.compressingConversationId,
        }));
      } catch (e) {
        set({ compressingConversationId: null });
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
    retryCompression: async () => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return null;
      if (get().loading) throw new Error('Conversation messages are still loading');
      set({ compressingConversationId: conversationId });
      try {
        const summary = await invoke<ConversationSummary>('retry_compression', { conversationId });
        set((state) => ({
          compressingConversationId: state.compressingConversationId === conversationId
            ? null
            : state.compressingConversationId,
        }));
        return summary;
      } catch (e) {
        set({ compressingConversationId: null });
        console.error('Failed to retry compression:', e);
        throw e;
      }
    },
    getContextUsage: async (conversationId: string) => {
      try {
        return await invoke<ContextUsage>('get_context_usage', { conversationId });
      } catch (e) {
        console.error('Failed to get context usage:', e);
        return null;
      }
    },
    requestOpenCompressionSummary: () => {
      set((state) => ({
        openCompressionSummaryToken: state.openCompressionSummaryToken + 1,
      }));
    },
    deleteCompression: async () => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      try {
        await invoke('delete_compression', { conversationId });
        invalidateConversationMessageCache(conversationId);
        if (get().activeConversationId === conversationId) {
          await get().fetchMessages(conversationId);
        }
      } catch (e) {
        console.error('Failed to delete compression:', e);
        throw e;
      }
    },
    ensureConversationsLoaded: async (options = {}) => {
      const state = get();
      if (!options.force && isResourceFresh(state.conversationsMeta, {
        ...options,
        key: CONVERSATIONS_RESOURCE_KEY,
      })) return;

      if (runtime.conversationsRequest?.revision === state.conversationsMeta.revision && !options.force) {
        return runtime.conversationsRequest.promise;
      }
      if (runtime.conversationsRequest) {
        await runtime.conversationsRequest.promise;
        return get().ensureConversationsLoaded(options);
      }

      const revision = state.conversationsMeta.revision;
      set((current) => ({
        loading: true,
        conversationsMeta: {
          ...current.conversationsMeta,
          status: 'loading',
          key: CONVERSATIONS_RESOURCE_KEY,
        },
      }));

      let promise!: Promise<void>;
      promise = (async () => {
        let reloadAfterCompletion = false;
        try {
          const conversations = await invoke<Conversation[]>('list_conversations');
          if (get().conversationsMeta.revision !== revision) {
            reloadAfterCompletion = true;
            set({ loading: false });
          } else {
            set({
              conversations,
              loading: false,
              error: null,
              conversationsMeta: {
                status: 'ready',
                key: CONVERSATIONS_RESOURCE_KEY,
                loadedAt: Date.now(),
                revision,
              },
            });
          }
        } catch (e) {
          if (get().conversationsMeta.revision !== revision) {
            reloadAfterCompletion = true;
            set({ loading: false });
          } else {
            set((current) => ({
              error: String(e),
              loading: false,
              conversationsMeta: { ...current.conversationsMeta, status: 'error' },
            }));
          }
        } finally {
          runtime.conversationsRequest = null;
        }
        if (reloadAfterCompletion) {
          await get().ensureConversationsLoaded();
        }
      })();
      runtime.conversationsRequest = { revision, promise };
      return promise;
    },
    invalidateConversations: (_reason) => set((state) => ({
      conversationsMeta: {
        status: 'idle',
        key: null,
        loadedAt: null,
        revision: state.conversationsMeta.revision + 1,
      },
    })),
    fetchConversations: () => get().ensureConversationsLoaded({ force: true }),
    reorderConversations: async (categoryId, conversationIds) => {
      try {
        await invoke('reorder_conversations', { categoryId, conversationIds });
        const sortOrderById = new Map(
          conversationIds.map((conversationId, index) => [conversationId, index]),
        );
        set((state) => ({
          conversations: state.conversations.map((conversation) => {
            const sortOrder = sortOrderById.get(conversation.id);
            return sortOrder === undefined
              ? conversation
              : { ...conversation, sort_order: sortOrder };
          }),
          conversationsMeta: mutateConversationsMeta(state.conversationsMeta),
          error: null,
        }));
      } catch (error) {
        set({ error: String(error) });
        throw error;
      }
    },
    setActiveConversation: (id) => {
      const previousState = get();
      const previousConversationId = previousState.activeConversationId;
      if (previousConversationId && previousConversationId !== id) {
        cacheMessageState(get(), previousConversationId);
      }
      if (!id) {
        runtime.activeMessageLoadSeq += 1;
        set({
          activeConversationId: null,
          messages: [],
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          hasOlderMessages: false,
          hasNewerMessages: false,
          totalActiveCount: 0,
          oldestLoadedMessageId: null,
          newestLoadedMessageId: null,
        });
        return;
      }

      const conversation = get().conversations.find((item) => item.id === id)
        ?? get().archivedConversations.find((item) => item.id === id);
      // Check if this conversation had a stream complete while we were away
      const needsRefreshAfterStreamDone = runtime.pendingConversationRefresh.has(id);
      if (get().activeConversationId === id && !needsRefreshAfterStreamDone) {
        void get().drainChatQueue(id);
        return;
      }
      if (needsRefreshAfterStreamDone) {
        runtime.pendingConversationRefresh.delete(id);
      }

      runtime.activeMessageLoadSeq += 1;
      const requestSeq = runtime.activeMessageLoadSeq;
      const startedAt = perfNow();
      const canSkipMessageFetch = conversation?.message_count === 0
        && !needsRefreshAfterStreamDone
        && !isLiveConversationRun(get().runsByConversation[id])
        && get().streamingConversationId !== id
        && !getStreamBuffer(id);
      const cachedCandidate = readCachedMessageState(id, conversation);
      const cached = conversation?.message_count === 0 && cachedCandidate?.fresh !== true
        ? null
        : cachedCandidate;
      const canUseFreshCache = cached?.fresh === true && !needsRefreshAfterStreamDone;
      const retainPreviousWindow = !cached
        && !canSkipMessageFetch
        && previousConversationId !== null
        && previousState.messages.length > 0;

      perfTrace('chat.switch.start', {
        conversationId: id,
        skipMessageFetch: canSkipMessageFetch || canUseFreshCache,
        cacheHit: Boolean(cached),
      });
      set((state) => ({
        activeConversationId: id,
        messages: cached?.state.messages ?? (retainPreviousWindow ? previousState.messages : []),
        loading: !canSkipMessageFetch && !cached,
        loadingOlder: false,
        loadingNewer: false,
        hasOlderMessages: cached?.state.hasOlderMessages
          ?? (retainPreviousWindow ? previousState.hasOlderMessages : false),
        hasNewerMessages: cached?.state.hasNewerMessages
          ?? (retainPreviousWindow ? previousState.hasNewerMessages : false),
        totalActiveCount: cached?.state.totalActiveCount
          ?? (retainPreviousWindow ? previousState.totalActiveCount : 0),
        oldestLoadedMessageId: cached?.state.oldestLoadedMessageId
          ?? (retainPreviousWindow ? previousState.oldestLoadedMessageId : null),
        newestLoadedMessageId: cached?.state.newestLoadedMessageId
          ?? (retainPreviousWindow ? previousState.newestLoadedMessageId : null),
        error: null,
        ...conversationPreferenceStateFromConversation(conversation),
        ...mirrorActiveStreamFields({ ...state, activeConversationId: id }),
      }));
      void migrateLegacyMultiModelPreferences(set, get, id);
      if (canUseFreshCache) {
        restoreActiveStreamBuffer(set, get, id);
        validateCachedMessageState(set, get, id, cached.state, requestSeq);
      }
      if (canSkipMessageFetch || canUseFreshCache) {
        perfTraceDuration(canUseFreshCache ? 'chat.switch.cached' : 'chat.switch.empty', startedAt, {
          conversationId: id,
        });
        void get().drainChatQueue(id);
        return;
      }
      get().fetchMessages(id, [], { setLoading: false }).then(() => {
        perfTraceDuration('chat.switch.loaded', startedAt, { conversationId: id });
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== id) {
          return;
        }
        // If there's an active stream for this conversation, inject buffered content
        const switchedBuffer = getStreamBuffer(id);
        if (switchedBuffer && (
          isLiveConversationRun(get().runsByConversation[id])
          || get().streamingConversationId === id
          || Boolean(switchedBuffer.content)
        )) {
          restoreActiveStreamBuffer(set, get, id);
        } else if (switchedBuffer && needsRefreshAfterStreamDone) {
          const realId = switchedBuffer.resolvedId ?? switchedBuffer.messageId;
          set((s) => {
            const exists = s.messages.some((m) => m.id === realId);
            if (exists) {
              return {
                messages: s.messages.map((m) =>
                  m.id === realId
                    ? { ...m, content: switchedBuffer.content, thinking: switchedBuffer.thinking || null }
                    : m,
                ),
              };
            }
            return {};
          });
          setStreamBuffer(id, null);
        } else if (needsRefreshAfterStreamDone) {
          setStreamBuffer(id, null);
        }
        if (get().error) {
          runtime.pendingConversationRefresh.add(id);
          return;
        }
        void get().drainChatQueue(id);
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
          const inheritConversationPreferences =
            useSettingsStore.getState().settings.inherit_conversation_preferences_on_create ?? true;
          conversation = await invoke<Conversation>('update_conversation', {
            id: createdConversation.id,
            input: {
              ...categoryTemplateUpdateFromCategory(category),
              ...(inheritConversationPreferences
                ? conversationPreferenceUpdateFromState(get())
                : emptyConversationPreferenceUpdate()),
            },
          });
        } catch (preferenceError) {
          set({ error: String(preferenceError) });
        }
        set((s) => ({
          conversations: [conversation, ...s.conversations],
          conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
          activeConversationId: conversation.id,
          messages: [],
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          hasOlderMessages: false,
          hasNewerMessages: false,
          totalActiveCount: 0,
          oldestLoadedMessageId: null,
          newestLoadedMessageId: null,
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
          conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
          ...(s.activeConversationId === id ? conversationPreferenceStateFromConversation(updated) : {}),
          error: null,
        }));
      } catch (e) {
        set({ error: String(e) });
        throw e;
      }
    },
    setConversationMultiModelDisplayMode: async (conversationId, mode) => {
      const current = get().conversations.find((conversation) => conversation.id === conversationId)
        ?? get().archivedConversations.find((conversation) => conversation.id === conversationId);
      if (!current) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }
      let mutation = runtime.conversationDisplayModeMutations.get(conversationId);
      if (!mutation) {
        mutation = {
          tail: Promise.resolve(),
          latestSequence: 0,
          confirmedMode: current.multi_model_display_mode_override,
        };
        runtime.conversationDisplayModeMutations.set(conversationId, mutation);
      }
      const sequence = mutation.latestSequence + 1;
      mutation.latestSequence = sequence;
      set((state) => updateConversationDisplayModeState(state, { conversationId, mode }));

      const save = mutation.tail.then(async () => {
        let updated: Conversation;
        try {
          updated = await invoke<Conversation>('update_conversation', {
            id: conversationId,
            input: { multi_model_display_mode_override: mode },
          });
        } catch (error) {
          if (mutation.latestSequence === sequence) {
            const rollbackMode = mutation.confirmedMode;
            set((state) => updateConversationDisplayModeState(state, {
              conversationId,
              mode: rollbackMode,
            }));
          }
          throw error;
        }
        mutation.confirmedMode = updated.multi_model_display_mode_override;
        if (mutation.latestSequence !== sequence) return;
        const confirmedMode = mutation.confirmedMode;
        set((state) => updateConversationDisplayModeState(state, {
          conversationId,
          mode: confirmedMode,
        }));
      });
      mutation.tail = save.then(() => undefined, () => undefined);
      void mutation.tail.then(() => {
        if (
          runtime.conversationDisplayModeMutations.get(conversationId) === mutation
          && mutation.latestSequence === sequence
        ) {
          runtime.conversationDisplayModeMutations.delete(conversationId);
        }
      });
      return save;
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
        const previous = get();
        if (previous.chatQueueByConversation[id]) {
          set((state) => {
            const chatQueueByConversation = { ...state.chatQueueByConversation };
            delete chatQueueByConversation[id];
            return { chatQueueByConversation };
          });
        }
        if (isLiveConversationRun(previous.runsByConversation[id])) {
          get().cancelConversationRun({ conversationId: id });
          if (isTauri() && isLiveConversationRun(get().runsByConversation[id])) {
            try {
              await invoke('cancel_stream', { conversationId: id, streamId: null });
            } catch (error) {
              const message = String(error);
              set({ error: message });
              throw new Error(message);
            }
          }
        }
        await invoke('delete_conversation', { id });
        invalidateConversationMessageCache(id);
        runtime.pendingConversationRefresh.delete(id);
        const nextActiveId = applyRemovedConversationIds([id]);
        set((state) => {
          const chatQueueByConversation = { ...state.chatQueueByConversation };
          delete chatQueueByConversation[id];
          return {
            conversations: state.conversations.filter((c) => c.id !== id),
            conversationsMeta: mutateConversationsMeta(state.conversationsMeta),
            chatQueueByConversation,
            error: null,
          };
        });
        if (previous.activeConversationId !== nextActiveId) {
          get().setActiveConversation(nextActiveId);
        }
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
        const shouldActivateBranch = get().activeConversationId === conversationId;
        set((s) => ({
          conversations: [newConv, ...s.conversations],
          conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
          error: null,
        }));
        if (shouldActivateBranch && get().activeConversationId === conversationId) {
          get().setActiveConversation(newConv.id);
        }
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
          conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
          error: null,
        }));
      } catch (e) {
        set({ error: String(e) });
        throw e;
      }
    },
    setConversationTabPinned: async (id, pinned) => {
      try {
        const updated = await invoke<Conversation>('set_conversation_tab_pinned', { id, pinned });
        set((s) => ({
          ...mergeConversationCollections(s.conversations, s.archivedConversations, updated),
          conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
          error: null,
        }));
        return updated;
      } catch (e) {
        set({ error: String(e) });
        throw e;
      }
    },
    toggleArchive: async (id) => {
      try {
        const previous = get();
        const updated = await invoke<Conversation>('toggle_archive_conversation', { id });
        const nextActiveId = updated.is_archived
          ? applyRemovedConversationIds([id])
          : previous.activeConversationId;
        if (updated.is_archived) {
          set((s) => ({
            conversations: s.conversations.filter((c) => c.id !== id),
            conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
            archivedConversations: [updated, ...s.archivedConversations],
            error: null,
          }));
          if (previous.activeConversationId !== nextActiveId) {
            get().setActiveConversation(nextActiveId);
          }
        } else {
          set((s) => ({
            conversations: [updated, ...s.conversations],
            conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
            archivedConversations: s.archivedConversations.filter((c) => c.id !== id),
            error: null,
          }));
        }
        return;
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
      const deletedIds: string[] = [];
      for (const id of ids) {
        try {
          await invoke('delete_conversation', { id });
          invalidateConversationMessageCache(id);
          runtime.pendingConversationRefresh.delete(id);
          deletedIds.push(id);
        } catch (e) {
          errors.push(String(e));
        }
      }
      const previous = get();
      const nextActiveId = applyRemovedConversationIds(deletedIds);
      set((s) => ({
        conversations: s.conversations.filter((c) => !deletedIds.includes(c.id)),
        conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
        chatQueueByConversation: Object.fromEntries(
          Object.entries(s.chatQueueByConversation)
            .filter(([conversationId]) => !deletedIds.includes(conversationId)),
        ),
        error: errors.length ? errors.join('; ') : null,
      }));
      if (previous.activeConversationId !== nextActiveId) {
        get().setActiveConversation(nextActiveId);
      }
    },
    batchArchive: async (ids) => {
      const archived: Conversation[] = [];
      for (const id of ids) {
        try {
          const updated = await invoke<Conversation>('toggle_archive_conversation', { id });
          if (updated.is_archived) archived.push(updated);
        } catch (_) { /* skip */ }
      }
      const archivedIds = archived.map((item) => item.id);
      const previous = get();
      const nextActiveId = applyRemovedConversationIds(archivedIds);
      set((s) => ({
        conversations: s.conversations.filter((c) => !archivedIds.includes(c.id)),
        conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
        archivedConversations: [...archived, ...s.archivedConversations],
        error: null,
      }));
      if (previous.activeConversationId !== nextActiveId) {
        get().setActiveConversation(nextActiveId);
      }
    },
    batchMoveToCategory: async (ids, categoryId) => {
      const updatedList: Conversation[] = [];
      const successfulIds = new Set<string>();
      const errors: string[] = [];
      const currentById = new Map(get().conversations.map((conversation) => (
        [conversation.id, conversation]
      )));
      // Each successful move enters the target container at the top. Applying
      // the visible selection in reverse preserves its original relative order.
      for (const id of [...ids].reverse()) {
        const current = currentById.get(id);
        if (current && (current.category_id ?? null) === categoryId) {
          successfulIds.add(id);
          continue;
        }
        try {
          const updated = await invoke<Conversation>('update_conversation', {
            id,
            input: { category_id: categoryId },
          });
          updatedList.push(updated);
          successfulIds.add(id);
        } catch (error) {
          errors.push(`${id}: ${String(error)}`);
        }
      }
      if (successfulIds.size > 0) {
        const byId = new Map(updatedList.map((c) => [c.id, c]));
        if (updatedList.length > 0) {
          set((s) => ({
            conversations: s.conversations.map((c) => byId.get(c.id) ?? c),
            archivedConversations: s.archivedConversations.map((c) => byId.get(c.id) ?? c),
            conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
            ...(s.activeConversationId && byId.has(s.activeConversationId)
              ? conversationPreferenceStateFromConversation(byId.get(s.activeConversationId)!)
              : {}),
          }));
        }
        const targetOrder = buildTargetContainerOrder(
          get().conversations,
          categoryId,
          ids.filter((id) => successfulIds.has(id)),
        );
        try {
          await get().reorderConversations(categoryId, targetOrder);
        } catch (error) {
          errors.push(`reorder: ${String(error)}`);
        }
      } else if (errors.length > 0) {
        set({ error: errors.join('; ') });
      }
      if (errors.length > 0) {
        const message = errors.join('; ');
        set({ error: message });
        throw new Error(message);
      }
      return successfulIds.size;
    },
    ensureMessageVersionGroupsLoaded: async (conversationId, parentMessageIds, options) => {
      const uniqueParentIds = Array.from(new Set(parentMessageIds));
      const existingRequests: Promise<void>[] = [];
      const parentIdsToLoad: string[] = [];

      for (const parentMessageId of uniqueParentIds) {
        const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
        const resource = get().messageVersionGroups[key];
        if (!options?.force && resource?.meta.status === 'ready') {
          continue;
        }
        const existingRequest = runtime.messageVersionGroupRequests.get(key);
        if (!options?.force && existingRequest) {
          existingRequests.push(existingRequest);
          continue;
        }
        parentIdsToLoad.push(parentMessageId);
      }

      if (parentIdsToLoad.length > 0) {
        const revisions = new Map<string, number>();
        set((state) => {
          const messageVersionGroups = { ...state.messageVersionGroups };
          for (const parentMessageId of parentIdsToLoad) {
            const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
            const current = messageVersionGroups[key];
            const revision = nextMessageVersionGroupRevision(current?.meta.revision);
            revisions.set(key, revision);
            messageVersionGroups[key] = {
              conversationId,
              parentMessageId,
              versions: current?.versions ?? [],
              error: null,
              meta: {
                status: 'loading',
                key,
                loadedAt: current?.meta.loadedAt ?? null,
                revision,
              },
            };
          }
          return { messageVersionGroups };
        });

        const request = (async () => {
          try {
            const snapshots = await get().listMessageVersionsBatch(conversationId, parentIdsToLoad);
            for (const parentMessageId of parentIdsToLoad) {
              if (!Object.prototype.hasOwnProperty.call(snapshots, parentMessageId)) {
                throw new Error(`Missing message version snapshot for parent ${parentMessageId}`);
              }
            }
            for (const parentMessageId of parentIdsToLoad) {
              const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
              if (get().messageVersionGroups[key]?.meta.revision !== revisions.get(key)) {
                continue;
              }
              get().applyMessageVersionSnapshot(
                conversationId,
                parentMessageId,
                snapshots[parentMessageId],
              );
            }
          } catch (error) {
            const errorMessage = String(error);
            let hasCurrentFailure = false;
            set((state) => {
              const messageVersionGroups = { ...state.messageVersionGroups };
              let changed = false;
              for (const parentMessageId of parentIdsToLoad) {
                const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
                const current = messageVersionGroups[key];
                if (!current || current.meta.revision !== revisions.get(key)) {
                  continue;
                }
                changed = true;
                hasCurrentFailure = true;
                messageVersionGroups[key] = {
                  ...current,
                  error: errorMessage,
                  meta: {
                    ...current.meta,
                    status: 'error',
                  },
                };
              }
              return changed ? { messageVersionGroups } : {};
            });
            if (hasCurrentFailure) throw error;
          }
        })();

        for (const parentMessageId of parentIdsToLoad) {
          const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
          runtime.messageVersionGroupRequests.set(key, request);
        }
        existingRequests.push(request.finally(() => {
          for (const parentMessageId of parentIdsToLoad) {
            const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
            if (runtime.messageVersionGroupRequests.get(key) === request) {
              runtime.messageVersionGroupRequests.delete(key);
            }
          }
        }));
      }

      await Promise.all(existingRequests);
    },
    invalidateMessageVersionGroups: (conversationId, parentMessageIds) => {
      const uniqueParentMessageIds = Array.from(new Set(parentMessageIds));
      for (const parentMessageId of uniqueParentMessageIds) {
        const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
        runtime.messageVersionGroupRequests.delete(key);
      }
      set((state) => {
        const messageVersionGroups = { ...state.messageVersionGroups };
        for (const parentMessageId of uniqueParentMessageIds) {
          const key = getMessageVersionGroupResourceKey(conversationId, parentMessageId);
          const current = messageVersionGroups[key];
          messageVersionGroups[key] = {
            conversationId,
            parentMessageId,
            versions: current?.versions ?? [],
            error: null,
            meta: {
              status: 'idle',
              key,
              loadedAt: current?.meta.loadedAt ?? null,
              revision: nextMessageVersionGroupRevision(current?.meta.revision),
            },
          };
        }
        return { messageVersionGroups };
      });
    },
    applyMessageVersionSnapshot: (conversationId, parentMessageId, versions, activeMessageId) => {
      commitMessageVersionSnapshot(conversationId, parentMessageId, versions);
      if (get().activeConversationId === conversationId) {
        get().hydrateMessageVersions(parentMessageId, versions, activeMessageId);
      }
    },
    hydrateMessageVersions: (parentMessageId, versions, activeMessageId) => {
      const conversationId = versions[0]?.conversation_id ?? get().activeConversationId;
      if (conversationId) {
        commitMessageVersionSnapshot(conversationId, parentMessageId, versions);
      }
      const resolvedPendingSelections: Array<{ pending: PendingLocalVersionSelection; messageId: string }> = [];
      set((s) => {
        let versionsForMerge = versions;
        const streamingMessageIds = new Set(collectActiveStreamingMessageIds(s));
        if (streamingMessageIds.size > 0) {
          versionsForMerge = versionsForMerge.map((version) => {
            if (!streamingMessageIds.has(version.id)) {
              return version;
            }
            const localMessage = s.messages.find((message) =>
              message.id === version.id
              && message.parent_message_id === parentMessageId
              && message.role === 'assistant'
            );
            if (!localMessage?.content) {
              return version;
            }
            return {
              ...version,
              content: mergeDbRagDisplayPrefix(version.content, localMessage.content),
              status: localMessage.status,
              thinking: localMessage.thinking ?? version.thinking,
              is_active: localMessage.is_active,
            };
          });
        }

        const resolvedStreamingMessageId = (() => {
          if (!isTemporaryMessageId(s.streamingMessageId)) {
            return null;
          }
          const placeholder = s.messages.find((message) => message.id === s.streamingMessageId);
          if (!placeholder || placeholder.parent_message_id !== parentMessageId) {
            return null;
          }
          const resolved = resolveHydratedStreamingMessageId(placeholder, versions);
          if (!resolved) {
            versionsForMerge = [...versions, placeholder];
          }
          return resolved ?? s.streamingMessageId;
        })();

        const pendingSelection = runtime.pendingLocalVersionSelections.get(parentMessageId) ?? null;
        const resolvedPendingMessage = pendingSelection
          ? findResolvedVersionForPendingSelection(pendingSelection, versions)
          : null;
        if (pendingSelection && resolvedPendingMessage) {
          resolvedPendingSelections.push({ pending: pendingSelection, messageId: resolvedPendingMessage.id });
        } else if (pendingSelection) {
          const pendingPlaceholder = s.messages.find((message) =>
            message.id === pendingSelection.tempMessageId
            && message.parent_message_id === parentMessageId
            && message.role === 'assistant'
          );
          if (
            pendingPlaceholder
            && !versionsForMerge.some((version) => version.id === pendingPlaceholder.id)
          ) {
            versionsForMerge = [...versionsForMerge, pendingPlaceholder];
          }
        }

        const pendingActiveMessageId = resolvedPendingMessage?.id
          ?? (
            pendingSelection
            && versionsForMerge.some((version) => version.id === pendingSelection.tempMessageId)
              ? pendingSelection.tempMessageId
              : null
          );
        const localActiveMessageId = s.messages.find((message) =>
          message.parent_message_id === parentMessageId
          && message.role === 'assistant'
          && message.is_active
          && versionsForMerge.some((version) => version.id === message.id)
        )?.id ?? null;
        const resolvedActiveMessageId = pendingActiveMessageId
          ?? activeMessageId
          ?? localActiveMessageId
          ?? versionsForMerge.find((version) => version.is_active)?.id
          ?? null;

        return {
          messages: mergeAssistantVersionGroup(
            s.messages,
            parentMessageId,
            versionsForMerge,
            resolvedActiveMessageId,
          ),
          streamingMessageId: resolvedStreamingMessageId ?? s.streamingMessageId,
        };
      });
      for (const resolvedPendingSelection of resolvedPendingSelections) {
        resolvePendingLocalVersionSelection(
          set,
          get,
          resolvedPendingSelection.pending,
          resolvedPendingSelection.messageId,
        );
      }
    },
    switchMessageVersion: async (conversationId, parentMessageId, messageId) => {
      const targetMessage = get().messages.find(
        (message) => message.id === messageId
          && message.parent_message_id === parentMessageId
          && message.role === 'assistant',
      );
      if (isTemporaryMessageId(messageId)) {
        if (!targetMessage) return;
        runtime.userManuallySelectedVersion = true;
        rememberPendingLocalVersionSelection(conversationId, parentMessageId, targetMessage);
        set((s) => ({
          messages: s.messages.map((message) => {
            if (message.parent_message_id !== parentMessageId || message.role !== 'assistant') {
              return message;
            }
            return { ...message, is_active: message.id === messageId };
          }),
        }));
        return;
      }

      runtime.pendingLocalVersionSelections.delete(parentMessageId);
      if (runtime.isMultiModelActive) {
        // During multi-model streaming, skip the backend call entirely to avoid:
        // 1. Race conditions with concurrent regenerate_with_model calls
        // 2. invoke delay causing stale content display
        // 3. Potential invoke failures during active streaming
        // Just swap is_active flags in-memory; backend will be synced during cleanup.
        runtime.userManuallySelectedVersion = true;
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

      try {
        await invoke('switch_message_version', { conversationId, parentMessageId, messageId });
      } catch (e) {
        set({ error: String(e) });
        await get().fetchMessages(conversationId);
        return;
      }

      invalidateConversationMessageCache(conversationId);
      set((state) => ({
        messages: state.messages.map((message) => (
          message.parent_message_id === parentMessageId && message.role === 'assistant'
            ? { ...message, is_active: message.id === messageId }
            : message
        )),
      }));
      notifyConversationChanged(conversationId);
      get().invalidateMessageVersionGroups(conversationId, [parentMessageId]);
      try {
        await get().ensureMessageVersionGroupsLoaded(
          conversationId,
          [parentMessageId],
          { force: true },
        );
      } catch (e) {
        set({ error: String(e) });
      }
    },
    listMessageVersions: async (conversationId, parentMessageId) => {
      return invoke<Message[]>('list_message_versions', { conversationId, parentMessageId });
    },
    listMessageVersionsBatch: async (conversationId, parentMessageIds) => {
      if (parentMessageIds.length === 0) return {};
      const startedAt = perfNow();
      const result = await invoke<Record<string, Message[]>>('list_message_versions_batch', {
        conversationId,
        parentMessageIds,
      });
      perfTraceDuration('chat.messageVersions.batch', startedAt, {
        conversationId,
        parentCount: parentMessageIds.length,
      });
      return result;
    },
    updateMessageContent: async (messageId, content) => {
      if (get().loading) throw new Error('Conversation messages are still loading');
      try {
        const updated = await invoke<Message>('update_message_content', { id: messageId, content });
        set((s) => ({
          messages: s.messages.map((m) => (m.id === messageId ? { ...m, content: updated.content } : m)),
        }));
        notifyConversationChanged(updated.conversation_id ?? get().activeConversationId);
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
        get().applyMessageVersionSnapshot(conversationId, userMessageId, []);
        invalidateConversationMessageCache(conversationId);
        set((s) => ({
          messages: s.messages.filter(m =>
            m.id !== userMessageId && m.parent_message_id !== userMessageId
          ),
        }));
        notifyConversationChanged(conversationId);
      } catch (e) {
        set({ error: String(e) });
      }
    },
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
  };
}
