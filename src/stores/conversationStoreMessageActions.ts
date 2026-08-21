import { invoke, isTauri, listen, type UnlistenFn } from '@/lib/invoke';
import {
  applyMultiModelStreamError,
  hasMultipleModelVersions,
  insertModelVersionPlaceholder,
  selectNextAssistantVersion,
} from '@/lib/chatMultiModel';
import {
  buildContextualSearchQuery,
  formatSearchContent,
  buildSearchQueryTag,
  buildSearchTag,
} from '@/lib/searchUtils';
import { buildKnowledgeTag, buildMemoryTag, type RagContextRetrievedEvent } from '@/lib/memoryUtils';
import { appendStreamErrorToContent } from '@/lib/streamStatus';
import {
  getMultiModelContinuationMode,
  normalizeMultiModelContinuationMode,
} from '@/lib/multiModelContinuation';
import { perfNow, perfTraceDuration } from '@/lib/perfTrace';
import { useSearchStore } from '@/stores/searchStore';
import type {
  AgentDoneEvent,
  AgentErrorEvent,
  AgentStreamTextEvent,
  AgentStreamThinkingEvent,
  ChatStreamErrorEvent,
  ChatStreamEvent,
  CompressionEvent,
  ConversationSearchResult,
  Message,
  MessagePage,
  MessageWindow,
} from '@/types';
import {
  AGENT_STREAM_UI_FLUSH_INTERVAL_MS,
  MESSAGE_PAGE_SIZE,
  appendStreamChunk,
  boundMessageWindow,
  buildRagDisplayTagFromSources,
  cacheMessageState,
  collectActiveStreamingMessageIds,
  collectRagDisplayTargetIds,
  conversationRuntime as runtime,
  createStreamActivity,
  createStreamId,
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
  mergeOlderPages,
  mergePreservedMessages,
  mutateConversationsMeta,
  rekeyMessageDisplayMap,
  removeStreamActivities,
  replaceLeadingSearchDisplayTags,
  sanitizeActiveConversationCapabilityIds,
  type ConversationState,
  type ConversationStoreSet,
} from './conversationStoreSupport';

type ConversationMessageActions = Pick<ConversationState,
  | 'sendMessage'
  | 'sendAgentMessage'
  | 'regenerateMessage'
  | 'regenerateWithModel'
  | 'sendMultiModelMessage'
  | 'deleteMessage'
  | 'fetchMessages'
  | 'loadOlderMessages'
  | 'loadNewerMessages'
  | 'loadMessagesAround'
  | 'searchConversations'
  | 'startStreamListening'
  | 'stopStreamListening'
  | 'cancelCurrentStream'
>;

export function createConversationMessageActions(
  set: ConversationStoreSet,
  get: () => ConversationState,
): ConversationMessageActions {
  return {
    sendMessage: async (content, attachments = [], searchProviderId = null) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) throw new Error('No active conversation');
      if (get().loading) throw new Error('Conversation messages are still loading');
      const activeConversation = get().conversations.find((conversation) => conversation.id === conversationId);
      const searchHistoryMessages = get().messages;

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
      const streamId = createStreamId();
      if (runtime.isMultiModelActive) {
        runtime.multiModelStreamIds.add(streamId);
      }
      const previousStreamState = {
        streaming: get().streaming,
        streamingMessageId: get().streamingMessageId,
        streamingConversationId: get().streamingConversationId,
        activeStreamId: get().activeStreamId,
        thinkingActiveMessageIds: new Set(get().thinkingActiveMessageIds),
      };
      const capabilityIds = sanitizeActiveConversationCapabilityIds(set, get, conversationId);
      const kbIds = capabilityIds.enabledKnowledgeBaseIds;
      const memIds = capabilityIds.enabledMemoryNamespaceIds;
      const hasKnowledgeRag = kbIds.length > 0;
      const hasMemoryRag = memIds.length > 0;
      const hasAnyRag = hasKnowledgeRag || hasMemoryRag;
      let placeholderContent = '';
      let searchDisplayTag = searchProviderId ? buildSearchQueryTag('summarizing') : '';
      let placeholderRagDisplay = '';
      if (searchDisplayTag) placeholderContent = searchDisplayTag;
      if (hasKnowledgeRag) placeholderRagDisplay += buildKnowledgeTag('searching');
      if (hasMemoryRag) placeholderRagDisplay += buildMemoryTag('searching');
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
        multiModelParentId: runtime.isMultiModelActive ? optimisticUserMsg.id : s.multiModelParentId,
        ragDisplayByMessageId: placeholderRagDisplay
          ? { ...s.ragDisplayByMessageId, [tempAssistantId]: placeholderRagDisplay }
          : s.ragDisplayByMessageId,
        searchDisplayByMessageId: searchDisplayTag
          ? { ...s.searchDisplayByMessageId, [tempAssistantId]: searchDisplayTag }
          : s.searchDisplayByMessageId,
        streaming: true,
        streamingConversationId: conversationId,
        streamingMessageId: tempAssistantId,
        activeStreamId: streamId,
        streamActivityByMessageId: {
          ...s.streamActivityByMessageId,
          [tempAssistantId]: createStreamActivity(
            activeConversation?.provider_id,
            activeConversation?.model_id,
          ),
        },
        thinkingActiveMessageIds: new Set<string>(),
      }));
      runtime.pendingUiChunk = null;
      if (runtime.streamUiFlushTimer !== null) {
        clearTimeout(runtime.streamUiFlushTimer);
        runtime.streamUiFlushTimer = null;
      }

      try {
        await get().startStreamListening();

        // If web search is enabled, execute search before sending to backend
        let finalContent = content;
        if (searchProviderId) {
          let searchResultTag = '';
          let summarizedSearchQuery: string | undefined;
          let querySummaryStatus: 'done' | 'error' | undefined;
          let querySummaryError: string | undefined;
          const buildSearchQueryDisplayTag = () => {
            if (querySummaryStatus === 'error') {
              return buildSearchQueryTag('error', summarizedSearchQuery, querySummaryError);
            }
            if (querySummaryStatus === 'done') {
              return buildSearchQueryTag('done', summarizedSearchQuery);
            }
            return buildSearchQueryTag('summarizing');
          };
          const updateSearchDisplay = (tag: string) => {
            searchDisplayTag = tag;
            set((s) => ({
              messages: s.messages.map((message) => (
                [tempAssistantId, s.streamingMessageId].includes(message.id)
                  ? {
                      ...message,
                      content: replaceLeadingSearchDisplayTags(message.content, tag),
                    }
                  : message
              )),
              searchDisplayByMessageId: [tempAssistantId, s.streamingMessageId]
                .filter((id): id is string => Boolean(id))
                .reduce<Record<string, string>>(
                  (acc, messageId) => ({
                    ...acc,
                    [messageId]: tag,
                  }),
                  { ...s.searchDisplayByMessageId },
                ),
            }));
          };
          try {
            let searchQuery = buildContextualSearchQuery(searchHistoryMessages, content);
            try {
              const generatedQuery = await invoke<string>('generate_search_query', {
                conversationId,
                content,
              });
              if (generatedQuery.trim()) {
                searchQuery = generatedQuery.trim();
                summarizedSearchQuery = searchQuery;
                querySummaryStatus = 'done';
              } else {
                summarizedSearchQuery = searchQuery;
                querySummaryStatus = 'error';
                querySummaryError = 'AI 返回空搜索语句，已使用备用搜索语句';
              }
            } catch (e) {
              summarizedSearchQuery = searchQuery;
              querySummaryStatus = 'error';
              const reason = String(e).replace(/^Error:\s*/, '');
              querySummaryError = `${reason}，已使用备用搜索语句`;
              console.warn('[sendMessage] generate_search_query fallback:', e);
            }
            updateSearchDisplay(
              `${buildSearchQueryDisplayTag()}${buildSearchTag('searching')}`,
            );
            const searchResult = await useSearchStore.getState().executeSearch(searchProviderId, searchQuery);
            if (searchResult?.ok) {
              searchResultTag = `${buildSearchQueryDisplayTag()}${buildSearchTag('done', searchResult.results)}`;
              finalContent = formatSearchContent(searchResult.results, content, {
                query: summarizedSearchQuery,
                queryStatus: querySummaryStatus,
                queryError: querySummaryError,
                status: 'done',
              });
            } else {
              const searchError = searchResult?.error || '搜索失败';
              searchResultTag = `${buildSearchQueryDisplayTag()}${buildSearchTag('error', undefined, searchError)}`;
              finalContent = formatSearchContent([], content, {
                query: summarizedSearchQuery,
                queryStatus: querySummaryStatus,
                queryError: querySummaryError,
                status: 'error',
                error: searchError,
              });
            }
          } catch (e) {
            const searchError = String(e);
            searchResultTag = `${buildSearchQueryDisplayTag()}${buildSearchTag('error', undefined, searchError)}`;
            finalContent = formatSearchContent([], content, {
              query: summarizedSearchQuery,
              queryStatus: querySummaryStatus,
              queryError: querySummaryError,
              status: 'error',
              error: searchError,
            });
          }
          // Replace searching tag with results, keep RAG searching tags if present
          runtime.streamPrefix = searchResultTag;
          updateSearchDisplay(searchResultTag);
        } else if (hasAnyRag) {
          // RAG display is tracked separately from assistant text to avoid stream
          // content/id updates temporarily removing the retrieval card.
          runtime.streamPrefix = '';
        }

        const mcpIds = getEffectiveMcpServerIds(get, {
          conversationId,
          mcpIds: capabilityIds.enabledMcpServerIds,
        });
        const thinkingBudget = getEffectiveThinkingBudget(get, conversationId);
        const thinkingLevel = getEffectiveThinkingLevel(get, conversationId);
        const userMessage = await invoke<Message>('send_message', {
          conversationId,
          streamId,
          content: finalContent,
          contentPrefix: searchDisplayTag,
          attachments,
          enabledMcpServerIds: mcpIds.length > 0 ? mcpIds : undefined,
          thinkingBudget,
          thinkingLevel,
          enabledKnowledgeBaseIds: kbIds.length > 0 ? kbIds : undefined,
          enabledMemoryNamespaceIds: memIds.length > 0 ? memIds : undefined,
          historyMode: runtime.isMultiModelActive
            ? runtime.multiModelHistoryMode
            : getMultiModelContinuationMode(conversationId),
        });

        // Replace optimistic user msg with real one, update placeholder parent
        set((s) => ({
          multiModelParentId: s.multiModelParentId === optimisticUserMsg.id
            ? userMessage.id
            : s.multiModelParentId,
          messages: s.messages.map(m => {
            if (m.id === optimisticUserMsg.id) return userMessage;
            if (
              m.id === tempAssistantId
              || (m.role === 'assistant' && m.parent_message_id === optimisticUserMsg.id)
            ) {
              return { ...m, parent_message_id: userMessage.id };
            }
            return m;
          }),
        }));

        // In browser mode, simulate brief loading then fetch the mock AI response
        if (!isTauri()) {
          await new Promise((r) => setTimeout(r, 600));
          set({ streaming: false, streamingMessageId: null, streamingConversationId: null, activeStreamId: null, thinkingActiveMessageIds: new Set<string>() });
          get().fetchMessages(conversationId);
        }
        return userMessage;
      } catch (e) {
        console.error('[sendMessage] error:', e);
        const errMsg = String(e);
        const staleBackendStream = isActiveStreamExistsError(errMsg) && !previousStreamState.streaming;
        set((s) => ({
          streaming: staleBackendStream ? false : previousStreamState.streaming,
          streamingMessageId: staleBackendStream ? null : previousStreamState.streamingMessageId,
          streamingConversationId: staleBackendStream ? null : previousStreamState.streamingConversationId,
          activeStreamId: staleBackendStream ? null : previousStreamState.activeStreamId,
          thinkingActiveMessageIds: staleBackendStream
            ? new Set<string>()
            : previousStreamState.thinkingActiveMessageIds,
          streamActivityByMessageId: removeStreamActivities(
            s.streamActivityByMessageId,
            [tempAssistantId],
          ),
          ragDisplayByMessageId: Object.fromEntries(
            Object.entries(s.ragDisplayByMessageId).filter(([messageId]) => messageId !== tempAssistantId),
          ),
          searchDisplayByMessageId: Object.fromEntries(
            Object.entries(s.searchDisplayByMessageId).filter(([messageId]) => messageId !== tempAssistantId),
          ),
          multiModelParentId: s.multiModelParentId === optimisticUserMsg.id
            ? null
            : s.multiModelParentId,
          messages: s.messages.filter((m) => (
            m.id !== optimisticUserMsg.id && m.id !== tempAssistantId
          )),
          error: errMsg,
        }));
        if (staleBackendStream) {
          runtime.pendingUiChunk = null;
          runtime.streamBuffer = null;
          runtime.streamPrefix = '';
          if (isTauri()) {
            invoke('cancel_stream', {
              conversationId,
              streamId: null,
            }).catch(() => {});
          }
          void get().fetchMessages(conversationId);
        }
        runtime.multiModelStreamIds.delete(streamId);
        return null;
      }
    },
    sendAgentMessage: async (content, attachments = []) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) throw new Error('No active conversation');
      if (get().loading) throw new Error('Conversation messages are still loading');

      runtime.activeAgentCancel?.();
      runtime.activeAgentCancel = null;
      const agentRunSeq = ++runtime.agentStreamSeq;
      const isCurrentAgentRun = () => agentRunSeq === runtime.agentStreamSeq;

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
        streamActivityByMessageId: {
          ...s.streamActivityByMessageId,
          [currentMsgId]: createStreamActivity(
            conversation?.provider_id,
            conversation?.model_id,
          ),
        },
      }));

      // Set up event listeners BEFORE invoking to avoid race conditions
      let unlistenDone: UnlistenFn | null = null;
      let unlistenError: UnlistenFn | null = null;
      let unlistenStreamText: UnlistenFn | null = null;
      let unlistenStreamThinking: UnlistenFn | null = null;
      let unlistenMessageId: UnlistenFn | null = null;
      let cancelActiveRun: (() => void) | null = null;
      let cleanedUp = false;

      // ── Agent stream buffering (same pattern as Q&A runtime.pendingUiChunk) ──
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
          _agentFlushTimer = setTimeout(flushAgentStreamChunks, AGENT_STREAM_UI_FLUSH_INTERVAL_MS);
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
        if (runtime.activeAgentCancel === cancelActiveRun) {
          runtime.activeAgentCancel = null;
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
              runtime.agentStreamSeq++;
            }
            cleanup();
            resolve();
          };
          runtime.activeAgentCancel = cancelActiveRun;

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
                runtime.pendingConversationRefresh.add(conversationId);
              }
              cleanup();
              resolve();
              return;
            }

            set((s) => ({
              streaming: false,
              streamingMessageId: null,
              streamingConversationId: null,
              activeStreamId: null,
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
              runtime.pendingConversationRefresh.add(conversationId);
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
              activeStreamId: null,
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
          attachments: attachments ?? [],
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
            activeStreamId: null,
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
      if (get().loading) throw new Error('Conversation messages are still loading');

      const msgs = get().messages;
      // Find the user message (either specific or last one)
      let userMsg: Message | undefined;
      if (targetMessageId) {
        const targetMsg = msgs.find(m => m.id === targetMessageId);
        if (targetMsg?.role === 'user') {
          userMsg = targetMsg;
        } else if (targetMsg?.parent_message_id) {
          userMsg = msgs.find(m => m.id === targetMsg.parent_message_id);
        }
      }
      if (!userMsg) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'user') { userMsg = msgs[i]; break; }
        }
      }
      if (!userMsg) throw new Error('No user message found');
      if (isTemporaryMessageId(userMsg.id)) {
        throw new Error('消息仍在保存，请稍后再试');
      }

      // Create placeholder for new version, preserving original created_at for position
      const tempAssistantId = `temp-assistant-${Date.now()}`;
      const streamId = createStreamId();
      const parentId = userMsg.id;
      const capabilityIds = sanitizeActiveConversationCapabilityIds(set, get, conversationId);
      const rKbIdsForPlaceholder = capabilityIds.enabledKnowledgeBaseIds;
      const rMemIdsForPlaceholder = capabilityIds.enabledMemoryNamespaceIds;
      const placeholderRagDisplay = [
        rKbIdsForPlaceholder.length > 0 ? buildKnowledgeTag('searching') : '',
        rMemIdsForPlaceholder.length > 0 ? buildMemoryTag('searching') : '',
      ].join('');

      // Find the original active AI message to preserve its created_at
      const originalAiMsg = msgs.find(m => m.parent_message_id === parentId && m.is_active);
      const parentVersions = msgs.filter((m) => m.parent_message_id === parentId && m.role === 'assistant');
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
        version_index: parentVersions.length,
        is_active: true,
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
          ragDisplayByMessageId: placeholderRagDisplay
            ? { ...s.ragDisplayByMessageId, [tempAssistantId]: placeholderRagDisplay }
            : s.ragDisplayByMessageId,
          streaming: true,
          streamingMessageId: tempAssistantId,
          streamingConversationId: conversationId,
          activeStreamId: streamId,
          streamActivityByMessageId: {
            ...s.streamActivityByMessageId,
            [tempAssistantId]: createStreamActivity(
              placeholderAssistant.provider_id,
              placeholderAssistant.model_id,
            ),
          },
          thinkingActiveMessageIds: new Set<string>(),
        };
      });
      runtime.pendingUiChunk = null;
      if (runtime.streamUiFlushTimer !== null) {
        clearTimeout(runtime.streamUiFlushTimer);
        runtime.streamUiFlushTimer = null;
      }

      try {
        await get().startStreamListening();

        const rMcpIds = getEffectiveMcpServerIds(get, {
          conversationId,
          mcpIds: capabilityIds.enabledMcpServerIds,
        });
        const rThinkingBudget = getEffectiveThinkingBudget(get, conversationId);
        const rThinkingLevel = getEffectiveThinkingLevel(get, conversationId);
        const rKbIds = capabilityIds.enabledKnowledgeBaseIds;
        const rMemIds = capabilityIds.enabledMemoryNamespaceIds;
        await invoke('regenerate_message', {
          conversationId,
          streamId,
          userMessageId: userMsg.id,
          enabledMcpServerIds: rMcpIds.length > 0 ? rMcpIds : undefined,
          thinkingBudget: rThinkingBudget,
          thinkingLevel: rThinkingLevel,
          enabledKnowledgeBaseIds: rKbIds.length > 0 ? rKbIds : undefined,
          enabledMemoryNamespaceIds: rMemIds.length > 0 ? rMemIds : undefined,
          historyMode: runtime.isMultiModelActive
            ? runtime.multiModelHistoryMode
            : getMultiModelContinuationMode(conversationId),
        });

        // In browser mode, simulate brief loading then fetch the mock AI response
        if (!isTauri()) {
          await new Promise((r) => setTimeout(r, 600));
          set({ streaming: false, streamingMessageId: null, streamingConversationId: null, activeStreamId: null, thinkingActiveMessageIds: new Set<string>() });
          get().fetchMessages(conversationId);
        }
      } catch (e) {
        console.error('[regenerateMessage] error:', e);
        const errMsg = String(e);
        set((s) => ({
          streaming: false,
          streamingMessageId: null,
          streamingConversationId: null,
          activeStreamId: null,
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
      return placeholderAssistant;
    },
    regenerateWithModel: async (targetMessageId: string, providerId: string, modelId: string, options?: { activate?: boolean }) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) throw new Error('No active conversation');

      const msgs = get().messages;
      // Find the AI message, then its parent user message
      const aiMsg = msgs.find(m => m.id === targetMessageId);
      if (!aiMsg?.parent_message_id) throw new Error('Cannot find parent user message');
      const userMsg = msgs.find(m => m.id === aiMsg.parent_message_id);
      if (!userMsg) throw new Error('User message not found');
      if (isTemporaryMessageId(userMsg.id)) {
        throw new Error('消息仍在保存，请稍后再试');
      }

      const parentId = userMsg.id;
      const originalAiMsg = msgs.find(m => m.parent_message_id === parentId && m.is_active);
      const parentVersions = msgs.filter((m) => m.parent_message_id === parentId && m.role === 'assistant');
      const appendAsCompanion = options?.activate == null
        ? hasMultipleModelVersions(parentVersions)
        : !options.activate;

      // Create placeholder with the target model info
      const tempAssistantId = `temp-assistant-${Date.now()}`;
      const streamId = createStreamId();
      if (appendAsCompanion || runtime.isMultiModelActive) {
        runtime.multiModelStreamIds.add(streamId);
      }
      const capabilityIds = sanitizeActiveConversationCapabilityIds(set, get, conversationId);
      const rKbIdsForPlaceholder = capabilityIds.enabledKnowledgeBaseIds;
      const rMemIdsForPlaceholder = capabilityIds.enabledMemoryNamespaceIds;
      const placeholderRagDisplay = [
        rKbIdsForPlaceholder.length > 0 ? buildKnowledgeTag('searching') : '',
        rMemIdsForPlaceholder.length > 0 ? buildMemoryTag('searching') : '',
      ].join('');
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
        version_index: parentVersions.length,
        is_active: !appendAsCompanion,
        status: 'partial',
      };

      // Keep the current active answer visible while the new model streams in.
      set((s) => {
        return {
          messages: insertModelVersionPlaceholder(s.messages, parentId, placeholderAssistant),
          ragDisplayByMessageId: placeholderRagDisplay
            ? { ...s.ragDisplayByMessageId, [tempAssistantId]: placeholderRagDisplay }
            : s.ragDisplayByMessageId,
          streaming: true,
          streamingMessageId: tempAssistantId,
          streamingConversationId: conversationId,
          activeStreamId: streamId,
          streamActivityByMessageId: {
            ...s.streamActivityByMessageId,
            [tempAssistantId]: createStreamActivity(providerId, modelId),
          },
          thinkingActiveMessageIds: new Set<string>(),
        };
      });
      runtime.pendingUiChunk = null;
      if (runtime.streamUiFlushTimer !== null) {
        clearTimeout(runtime.streamUiFlushTimer);
        runtime.streamUiFlushTimer = null;
      }

      try {
        await get().startStreamListening();

        const rMcpIds = getEffectiveMcpServerIds(get, {
          conversationId,
          providerId,
          modelId,
          mcpIds: capabilityIds.enabledMcpServerIds,
        });
        const rThinkingBudget = getEffectiveThinkingBudget(get, conversationId);
        const rThinkingLevel = getEffectiveThinkingLevel(get, conversationId);
        const rKbIds = capabilityIds.enabledKnowledgeBaseIds;
        const rMemIds = capabilityIds.enabledMemoryNamespaceIds;
        await invoke('regenerate_with_model', {
          conversationId,
          streamId,
          userMessageId: userMsg.id,
          targetProviderId: providerId,
          targetModelId: modelId,
          enabledMcpServerIds: rMcpIds.length > 0 ? rMcpIds : undefined,
          thinkingBudget: rThinkingBudget,
          thinkingLevel: rThinkingLevel,
          enabledKnowledgeBaseIds: rKbIds.length > 0 ? rKbIds : undefined,
          enabledMemoryNamespaceIds: rMemIds.length > 0 ? rMemIds : undefined,
          isCompanion: appendAsCompanion ? true : undefined,
          historyMode: runtime.isMultiModelActive
            ? runtime.multiModelHistoryMode
            : getMultiModelContinuationMode(conversationId),
        });

        if (!isTauri()) {
          await new Promise((r) => setTimeout(r, 600));
          set({ streaming: false, streamingMessageId: null, streamingConversationId: null, activeStreamId: null, thinkingActiveMessageIds: new Set<string>() });
          get().fetchMessages(conversationId);
        }
      } catch (e) {
        console.error('[regenerateWithModel] error:', e);
        const errMsg = String(e);
        set((s) => ({
          streaming: false,
          streamingMessageId: null,
          streamingConversationId: null,
          activeStreamId: null,
          thinkingActiveMessageIds: new Set<string>(),
          messages: s.streamingMessageId
            ? s.messages.map(m =>
                m.id === s.streamingMessageId
                  ? { ...m, content: errMsg, status: 'error' as const }
                  : m
              )
            : s.messages,
        }));
        runtime.multiModelStreamIds.delete(streamId);
      }
      return placeholderAssistant;
    },
    sendMultiModelMessage: async ({
      content,
      targetModels,
      historyMode,
      attachments = [],
      searchProviderId = null,
    }) => {
      const conversationId = get().activeConversationId;
      if (!conversationId || targetModels.length === 0) return;
      if (get().loading) throw new Error('Conversation messages are still loading');
      const resolvedHistoryMode = normalizeMultiModelContinuationMode(
        historyMode ?? getMultiModelContinuationMode(conversationId),
      );

      // Save original conversation model to restore later
      const conv = get().conversations.find((c) => c.id === conversationId);
      const originalProviderId = conv?.provider_id;
      const originalModelId = conv?.model_id;
      const runId = ++runtime.multiModelRunId;

      // Track ALL models (first + companions) in a unified counter
      runtime.isMultiModelActive = true;
      runtime.multiModelTotalRemaining = targetModels.length;
      runtime.multiModelFirstTarget = { ...targetModels[0] };
      runtime.multiModelHistoryMode = resolvedHistoryMode;
      set({ pendingCompanionModels: [...targetModels] });

      // Switch to the first selected model and send
      const firstModel = targetModels[0];
      try {
        await get().updateConversation(conversationId, {
          provider_id: firstModel.providerId,
          model_id: firstModel.modelId,
        });
      } catch (e) {
        console.error('[sendMultiModelMessage] failed to switch model:', e);
        runtime.isMultiModelActive = false;
        runtime.multiModelTotalRemaining = 0;
        runtime.multiModelFirstTarget = null;
        runtime.multiModelFirstMessageId = null;
        runtime.multiModelHistoryMode = 'selected';
        runtime.userManuallySelectedVersion = false;
        runtime.multiModelStreamIds.clear();
        set({ pendingCompanionModels: [], multiModelParentId: null, multiModelDoneMessageIds: [] });
        return;
      }

      // sendMessage returns after invoke (message created in DB), stream continues in background
      const sentUserMessage = await get().sendMessage(content, attachments, searchProviderId);

      const isCurrentRun = runtime.multiModelRunId === runId;
      if (!runtime.isMultiModelActive || !isCurrentRun || !sentUserMessage) {
        if (isCurrentRun) {
          runtime.isMultiModelActive = false;
          runtime.multiModelTotalRemaining = 0;
          runtime.multiModelFirstTarget = null;
          runtime.multiModelFirstMessageId = null;
          runtime.multiModelHistoryMode = 'selected';
          runtime.userManuallySelectedVersion = false;
          runtime.multiModelStreamIds.clear();
          set({ pendingCompanionModels: [], multiModelParentId: null, multiModelDoneMessageIds: [] });
        }
        const cancelledWithoutReplacement = runtime.multiModelRunId === runId + 1 && !runtime.isMultiModelActive;
        if ((isCurrentRun || cancelledWithoutReplacement) && originalProviderId && originalModelId) {
          void get().updateConversation(conversationId, { provider_id: originalProviderId, model_id: originalModelId });
        }
        return;
      }
      const lastUserMsg = sentUserMessage;

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
        if (runtime.multiModelTotalRemaining === 0) { resolve(); return; }
        runtime.multiModelDoneResolve = resolve;
      });

      // Fire remaining companions in PARALLEL (concurrent with first model's stream)
      const remaining = targetModels.slice(1);
      if (remaining.length > 0) {
        runtime.streamBuffer = null;

        const thinkingBudget = getEffectiveThinkingBudget(get, conversationId);
        const thinkingLevel = getEffectiveThinkingLevel(get, conversationId);
        const kbIds = get().enabledKnowledgeBaseIds;
        const memIds = get().enabledMemoryNamespaceIds;

        const invocations = remaining.map((model) => {
          const streamId = createStreamId();
          runtime.multiModelStreamIds.add(streamId);
          const mcpIds = getEffectiveMcpServerIds(get, {
            conversationId,
            providerId: model.providerId,
            modelId: model.modelId,
          });
          return invoke('regenerate_with_model', {
            conversationId,
            streamId,
            userMessageId: lastUserMsg.id,
            targetProviderId: model.providerId,
            targetModelId: model.modelId,
            enabledMcpServerIds: mcpIds.length > 0 ? mcpIds : undefined,
            thinkingBudget,
            thinkingLevel,
            enabledKnowledgeBaseIds: kbIds.length > 0 ? kbIds : undefined,
            enabledMemoryNamespaceIds: memIds.length > 0 ? memIds : undefined,
            isCompanion: true,
            historyMode: resolvedHistoryMode,
          }).then(async () => {
            // Each invoke returns after message creation — immediately enrich the store
            // so ModelTags can render this companion as clickable right away.
            if (!runtime.isMultiModelActive) return;
            try {
              const versions = await get().listMessageVersions(conversationId, lastUserMsg.id);
              if (versions.length > 0 && runtime.isMultiModelActive) {
                set((s) => {
                  const existingIds = new Set(s.messages.map((m) => m.id));
                  const dbVersionMap = new Map(versions.map((v) => [v.id, v]));
                  const updates: Partial<ConversationState> = {};

                  let resolvedFirstModelId: string | null = null;
                  if (s.streamingMessageId?.startsWith('temp-') && runtime.multiModelFirstTarget) {
                    const firstDbVersion = versions.find(
                      (v) => v.model_id === runtime.multiModelFirstTarget?.modelId
                        && v.provider_id === runtime.multiModelFirstTarget.providerId
                        && !existingIds.has(v.id),
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
            runtime.multiModelStreamIds.delete(streamId);
            console.error(`[sendMultiModelMessage] companion ${model.modelId} invoke failed:`, e);
            // Invoke failed — no stream will start, so decrement counter here
            runtime.multiModelTotalRemaining--;
            if (runtime.multiModelTotalRemaining <= 0 && runtime.multiModelDoneResolve) {
              const r = runtime.multiModelDoneResolve;
              runtime.multiModelDoneResolve = null;
              set({ streaming: false, streamingMessageId: null, streamingConversationId: null, activeStreamId: null, thinkingActiveMessageIds: new Set<string>() });
              r();
            }
          });
        });

        // Don't await invocations — they return after message creation, streams run in background
        // Enrichment now happens per-invocation (see .then() above).
        void Promise.allSettled(invocations);
      }

      // Wait for ALL streams to complete (first + companions)
      await allDone;

      const clearFinalizedRunState = () => set((s) => s.multiModelParentId === lastUserMsg.id
        ? { multiModelParentId: null, multiModelDoneMessageIds: [] }
        : {});
      if (runtime.multiModelRunId !== runId) {
        clearFinalizedRunState();
        const cancelledWithoutReplacement = runtime.multiModelRunId === runId + 1 && !runtime.isMultiModelActive;
        if (cancelledWithoutReplacement && originalProviderId && originalModelId) {
          void get().updateConversation(conversationId, { provider_id: originalProviderId, model_id: originalModelId });
        }
        return;
      }

      // All done — cleanup
      const firstMessageId = runtime.multiModelFirstMessageId;
      const userManuallySelectedVersion = runtime.userManuallySelectedVersion;
      runtime.isMultiModelActive = false;
      runtime.multiModelFirstTarget = null;
      runtime.multiModelFirstMessageId = null;
      runtime.multiModelHistoryMode = 'selected';
      runtime.userManuallySelectedVersion = false;
      runtime.multiModelStreamIds.clear();
      set({ pendingCompanionModels: [], multiModelDoneMessageIds: [] });
      const abortSupersededFinalization = () => {
        if (runtime.multiModelRunId === runId && !get().streaming) return false;
        clearFinalizedRunState();
        return true;
      };

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
      if (abortSupersededFinalization()) return;

      // Final fetch for consistency
      if (get().activeConversationId === conversationId) {
        const parentId = lastUserMsg.id;

        // Determine which version to show: if user manually selected a version, respect that choice
        const userSelectedMessageId = userManuallySelectedVersion
          ? get().messages.find(
              (m) => m.parent_message_id === parentId && m.role === 'assistant' && m.is_active,
            )?.id ?? null
          : null;

        if (!userManuallySelectedVersion) {
          // No manual selection — switch to the first model's version
          const firstTarget = targetModels[0];
          let targetMessageId = firstMessageId;
          if (!targetMessageId) {
            const localMatch = get().messages.find(
              (m) => m.parent_message_id === parentId
                && m.role === 'assistant'
                && m.model_id === firstTarget.modelId
                && m.provider_id === firstTarget.providerId,
            );
            targetMessageId = localMatch?.id ?? null;
          }
          if (targetMessageId && !isTemporaryMessageId(targetMessageId)) {
            await invoke('switch_message_version', {
              conversationId,
              parentMessageId: parentId,
              messageId: targetMessageId,
            }).catch(() => {});
          }
        } else if (userSelectedMessageId && !isTemporaryMessageId(userSelectedMessageId)) {
          // User manually selected a version — sync that to backend
          await invoke('switch_message_version', {
            conversationId,
            parentMessageId: parentId,
            messageId: userSelectedMessageId,
          }).catch(() => {});
        }
        if (abortSupersededFinalization()) return;

        await get().fetchMessages(conversationId);
        if (abortSupersededFinalization()) return;

        const versions = await get().listMessageVersions(conversationId, parentId);
        if (abortSupersededFinalization()) return;
        if (versions.length > 0) {
          const firstTarget = targetModels[0];
          const pendingSelection = runtime.pendingLocalVersionSelections.get(parentId) ?? null;
          const resolvedManualSelection = pendingSelection
            ? findResolvedVersionForPendingSelection(pendingSelection, versions)
            : null;
          const activeVersionId = (
            (userManuallySelectedVersion && userSelectedMessageId && !isTemporaryMessageId(userSelectedMessageId)
              ? versions.find((version) => version.id === userSelectedMessageId)
              : null)
            ?? (userManuallySelectedVersion ? resolvedManualSelection : null)
            ?? (firstMessageId
              ? versions.find((version) => version.id === firstMessageId)
              : null)
            ?? versions.find((version) => version.model_id === firstTarget.modelId
              && version.provider_id === firstTarget.providerId)
            ?? versions.find((version) => version.is_active)
            ?? versions[0]
          )?.id ?? null;

          get().hydrateMessageVersions(parentId, versions, activeVersionId);
        }
      }

      clearFinalizedRunState();
    },
    deleteMessage: async (messageId) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      if (get().loading) throw new Error('Conversation messages are still loading');

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
    fetchMessages: async (conversationId, preserveMessageIds = [], options) => {
      const requestSeq = runtime.activeMessageLoadSeq;
      const startedAt = perfNow();
      const effectivePreserveMessageIds = new Set(preserveMessageIds);
      const collectActiveStreamingPreserveIds = () => {
        for (const messageId of collectActiveStreamingMessageIds(get(), conversationId)) {
          effectivePreserveMessageIds.add(messageId);
        }
      };

      collectActiveStreamingPreserveIds();
      if (get().streaming && get().streamingConversationId === conversationId) {
        flushPendingStreamChunk(set, get);
        collectActiveStreamingPreserveIds();
      }

      if (options?.setLoading !== false) {
        set({ loading: true });
      }
      try {
        const page = await invoke<MessagePage>('list_messages_page', {
          conversationId,
          limit: MESSAGE_PAGE_SIZE,
          beforeMessageId: null,
        });
        perfTraceDuration('chat.messages.page', startedAt, {
          conversationId,
          count: page.messages.length,
          total: page.total_active_count,
        });
        collectActiveStreamingPreserveIds();
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== conversationId) {
          return;
        }

        set((s) => {
          const messages = mergePreservedMessages(
            page.messages,
            Array.from(effectivePreserveMessageIds),
            s.messages,
          );
          const edges = getActiveMessageEdges(messages);
          return {
            messages,
            loading: false,
            loadingOlder: false,
            loadingNewer: false,
            hasOlderMessages: page.has_older,
            hasNewerMessages: false,
            totalActiveCount: page.total_active_count,
            oldestLoadedMessageId: edges.oldestMessageId ?? page.oldest_message_id,
            newestLoadedMessageId: edges.newestMessageId,
            error: null,
          };
        });
        cacheMessageState(get(), conversationId);
      } catch (e) {
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== conversationId) {
          return;
        }
        set((state) => ({
          error: String(e),
          loading: false,
          loadingOlder: false,
          loadingNewer: false,
          ...(state.messages.some((message) => message.conversation_id !== conversationId) ? {
            messages: [],
            hasOlderMessages: false,
            hasNewerMessages: false,
            totalActiveCount: 0,
            oldestLoadedMessageId: null,
            newestLoadedMessageId: null,
          } : {}),
        }));
      }
    },
    loadOlderMessages: async (limit = MESSAGE_PAGE_SIZE) => {
      const { activeConversationId, oldestLoadedMessageId, hasOlderMessages, loading, loadingOlder, loadingNewer } = get();
      if (!activeConversationId || !oldestLoadedMessageId || !hasOlderMessages || loading || loadingOlder || loadingNewer) {
        return;
      }

      const requestSeq = runtime.activeMessageLoadSeq;
      set({ loadingOlder: true, error: null });
      try {
        const page = await invoke<MessagePage>('list_messages_page', {
          conversationId: activeConversationId,
          limit,
          beforeMessageId: oldestLoadedMessageId,
        });
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== activeConversationId) {
          return;
        }

        set((s) => {
          const bounded = boundMessageWindow(mergeOlderPages(page.messages, s.messages), 'older');
          const edges = getActiveMessageEdges(bounded.messages);
          return {
            messages: bounded.messages,
            loadingOlder: false,
            hasOlderMessages: page.has_older,
            hasNewerMessages: s.hasNewerMessages || bounded.trimmedNewer,
            totalActiveCount: page.total_active_count,
            oldestLoadedMessageId: edges.oldestMessageId,
            newestLoadedMessageId: edges.newestMessageId,
            error: null,
          };
        });
        cacheMessageState(get(), activeConversationId);
      } catch (e) {
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== activeConversationId) {
          return;
        }
        set({ error: String(e), loadingOlder: false });
      }
    },
    loadNewerMessages: async (limit = MESSAGE_PAGE_SIZE) => {
      const { activeConversationId, newestLoadedMessageId, hasNewerMessages, loading, loadingOlder, loadingNewer } = get();
      if (!activeConversationId || !newestLoadedMessageId || !hasNewerMessages || loading || loadingOlder || loadingNewer) {
        return;
      }

      const requestSeq = runtime.activeMessageLoadSeq;
      set({ loadingNewer: true, error: null });
      try {
        const page = await invoke<MessageWindow>('list_messages_after', {
          conversationId: activeConversationId,
          afterMessageId: newestLoadedMessageId,
          limit,
        });
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== activeConversationId) {
          return;
        }

        set((s) => {
          const bounded = boundMessageWindow(mergeOlderPages(page.messages, s.messages), 'newer');
          const edges = getActiveMessageEdges(bounded.messages);
          return {
            messages: bounded.messages,
            loadingNewer: false,
            hasOlderMessages: s.hasOlderMessages || page.has_older || bounded.trimmedOlder,
            hasNewerMessages: page.has_newer,
            totalActiveCount: page.total_active_count,
            oldestLoadedMessageId: edges.oldestMessageId,
            newestLoadedMessageId: edges.newestMessageId,
            error: null,
          };
        });
        cacheMessageState(get(), activeConversationId);
      } catch (e) {
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== activeConversationId) {
          return;
        }
        set({ error: String(e), loadingNewer: false });
      }
    },
    loadMessagesAround: async (messageId, beforeLimit = 4, afterLimit = 8) => {
      const { activeConversationId, loading, loadingOlder, loadingNewer } = get();
      if (!activeConversationId || loading || loadingOlder || loadingNewer) return;

      const requestSeq = runtime.activeMessageLoadSeq;
      set({ loadingOlder: true, error: null });
      try {
        const page = await invoke<MessageWindow>('list_messages_window', {
          conversationId: activeConversationId,
          anchorMessageId: messageId,
          beforeLimit,
          afterLimit,
        });
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== activeConversationId) {
          return;
        }

        set({
          messages: page.messages,
          loadingOlder: false,
          loadingNewer: false,
          hasOlderMessages: page.has_older,
          hasNewerMessages: page.has_newer,
          totalActiveCount: page.total_active_count,
          oldestLoadedMessageId: page.oldest_message_id,
          newestLoadedMessageId: page.newest_message_id,
          error: null,
        });
        cacheMessageState(get(), activeConversationId);
      } catch (e) {
        if (requestSeq !== runtime.activeMessageLoadSeq || get().activeConversationId !== activeConversationId) {
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
      const gen = ++runtime.listenerGen;
      if (runtime.unlisten) {
        runtime.unlisten();
        runtime.unlisten = null;
      }

      const chunkUnsub = await listen<ChatStreamEvent>('chat-stream-chunk', (event) => {
        if (runtime.listenerGen !== gen) return; // stale listener
        if (!get().streaming) return; // cancelled
        const { conversation_id, message_id, stream_id, chunk, model_id: evt_model_id, provider_id: evt_provider_id } = event.payload;
        if (!isCurrentStreamEvent(get, stream_id)) return;

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
          if (runtime.isMultiModelActive) {
            runtime.multiModelTotalRemaining--;
            flushPendingStreamChunk(set, get);
            materializeLiveStreamContent(set, [message_id, get().streamingMessageId]);
            runtime.streamBuffer = null;

            // Clear streamingMessageId and mark completed message as 'complete'
            set((s) => {
              const updated: Partial<ConversationState> = {};
              if (s.streamingMessageId === message_id) {
                // This is the first model finishing — save its message_id for later version switching
                runtime.multiModelFirstMessageId = message_id;
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
              updated.streamActivityByMessageId = removeStreamActivities(
                s.streamActivityByMessageId,
                [message_id],
              );
              return updated;
            });

            if (runtime.multiModelTotalRemaining <= 0) {
              // All models done
              set({
                streaming: false,
                streamingMessageId: null,
                streamingConversationId: null,
                activeStreamId: null,
                thinkingActiveMessageIds: new Set<string>(),
              });
              if (runtime.multiModelDoneResolve) {
                const resolve = runtime.multiModelDoneResolve;
                runtime.multiModelDoneResolve = null;
                resolve();
              }
            }
            return;
          }

          const placeholderMessageId = get().streamingMessageId;
          flushPendingStreamChunk(set, get);
          materializeLiveStreamContent(set, [placeholderMessageId, get().streamingMessageId, message_id]);
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
          set((s) => {
            const shouldResolveTempPlaceholder = isTemporaryMessageId(placeholderMessageId)
              && Boolean(message_id)
              && placeholderMessageId !== message_id;
            const realMessageAlreadyExists = shouldResolveTempPlaceholder
              ? s.messages.some((message) => message.id === message_id)
              : false;

            return {
              streaming: false,
              streamingMessageId: null,
              streamingConversationId: null,
              activeStreamId: null,
              streamActivityByMessageId: removeStreamActivities(
                s.streamActivityByMessageId,
                [placeholderMessageId, flushedMessageId, message_id],
              ),
              thinkingActiveMessageIds: new Set<string>(),
              conversations: s.conversations.map((c) =>
                c.id === conversation_id
                  ? { ...c, message_count: c.message_count + 1 }
                  : c,
              ),
              conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
              // Update completed message status immediately to prevent "主动停止" tag flash.
              // If the provider sends final done before any content chunk, the temporary
              // placeholder has not been resolved yet; resolve it here so the later
              // fetchMessages preserve pass can keep the local complete status even if
              // the DB row is still briefly partial.
              messages: s.messages.flatMap((m) => {
                if (shouldResolveTempPlaceholder && m.id === placeholderMessageId) {
                  return realMessageAlreadyExists
                    ? []
                    : [{ ...m, id: message_id, status: 'complete' as const }];
                }
                return preserveMessageIds.includes(m.id)
                  ? [{ ...m, status: 'complete' as const }]
                  : [m];
              }),
              ragDisplayByMessageId: rekeyMessageDisplayMap(
                s.ragDisplayByMessageId,
                shouldResolveTempPlaceholder ? placeholderMessageId : null,
                message_id,
              ),
              searchDisplayByMessageId: rekeyMessageDisplayMap(
                s.searchDisplayByMessageId,
                shouldResolveTempPlaceholder ? placeholderMessageId : null,
                message_id,
              ),
            };
          });
          if (get().activeConversationId === conversation_id) {
            // Active conversation — refresh messages then clear buffer
            runtime.streamBuffer = null;
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
            runtime.pendingConversationRefresh.add(conversation_id);
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
        if (runtime.listenerGen !== gen) return; // stale listener
        if (!get().streaming) return; // cancelled
        const {
          conversation_id,
          message_id,
          stream_id,
          error: errMsg,
          model_id: evt_model_id,
          provider_id: evt_provider_id,
        } = event.payload;
        if (!isCurrentStreamEvent(get, stream_id)) return;

        flushPendingStreamChunk(set, get);
        materializeLiveStreamContent(set, [message_id, get().streamingMessageId]);
        runtime.streamBuffer = null; // Clear buffer on error

        // Multi-model: treat error as stream completion for this model
        if (runtime.isMultiModelActive) {
          runtime.multiModelTotalRemaining--;
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
              streamActivityByMessageId: removeStreamActivities(
                s.streamActivityByMessageId,
                [message_id],
              ),
              messages: result.messages,
            };
          });
          if (runtime.multiModelTotalRemaining <= 0) {
            set({ streaming: false, streamingMessageId: null, streamingConversationId: null, activeStreamId: null, thinkingActiveMessageIds: new Set<string>() });
            if (runtime.multiModelDoneResolve) { const r = runtime.multiModelDoneResolve; runtime.multiModelDoneResolve = null; r(); }
          }
          return;
        }

        // Only show error if still on the same conversation
        if (get().activeConversationId !== conversation_id) {
          set((s) => ({
            streaming: false,
            streamingMessageId: null,
            streamingConversationId: null,
            activeStreamId: null,
            streamActivityByMessageId: removeStreamActivities(
              s.streamActivityByMessageId,
              [message_id, s.streamingMessageId],
            ),
            thinkingActiveMessageIds: new Set<string>(),
          }));
          return;
        }

        // Update the streaming message to show error inline
        set((s) => ({
          streaming: false,
          streamingMessageId: null,
          streamingConversationId: null,
          activeStreamId: null,
          streamActivityByMessageId: removeStreamActivities(
            s.streamActivityByMessageId,
            [message_id, s.streamingMessageId],
          ),
          thinkingActiveMessageIds: new Set<string>(),
          messages: s.messages.map(m =>
            m.id === message_id || m.id === s.streamingMessageId
              ? { ...m, content: appendStreamErrorToContent(m.content, errMsg), status: 'error' as const }
              : m
          ),
        }));
      });

      const titleUnsub = await listen<{ conversation_id: string; title: string }>('conversation-title-updated', (event) => {
        if (runtime.listenerGen !== gen) return;
        const { conversation_id, title } = event.payload;
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversation_id ? { ...c, title } : c,
          ),
          conversationsMeta: mutateConversationsMeta(s.conversationsMeta),
        }));
      });

      const titleGenUnsub = await listen<{ conversation_id: string; generating: boolean; error: string | null }>('conversation-title-generating', (event) => {
        if (runtime.listenerGen !== gen) return;
        const { conversation_id, generating, error } = event.payload;
        set({ titleGeneratingConversationId: generating ? conversation_id : null });
        if (!generating && error) {
          console.error('[title-gen] AI title generation failed:', error);
          set({ error });
        }
      });

      const ragUnsub = await listen<RagContextRetrievedEvent>('rag-context-retrieved', (event) => {
        if (runtime.listenerGen !== gen) return;
        if (!get().streaming) return;
        const { conversation_id, message_id, stream_id, sources, errors, empty_results, emptyResults } = event.payload;
        if (!isCurrentStreamEvent(get, stream_id)) return;
        const displayTag = buildRagDisplayTagFromSources(
          sources,
          errors,
          empty_results ?? emptyResults ?? [],
        );

        // Update UI immediately
        if (get().activeConversationId === conversation_id) {
          const targetIds = new Set<string>();
          if (message_id) targetIds.add(message_id);
          const streamingId = get().streamingMessageId;
          if (streamingId) targetIds.add(streamingId);

          if (targetIds.size > 0) {
            set((s) => ({
              ragDisplayByMessageId: collectRagDisplayTargetIds(s.messages, conversation_id, targetIds)
                .reduce<Record<string, string>>(
                  (acc, targetId) => {
                    if (displayTag) {
                      acc[targetId] = displayTag;
                    } else {
                      delete acc[targetId];
                    }
                    return acc;
                  },
                  { ...s.ragDisplayByMessageId },
                ),
            }));
          }
        }
      });

      const compressionUnsub = await listen<CompressionEvent>('conversation:compressed', (event) => {
        if (runtime.listenerGen !== gen) return;
        const { conversation_id, marker_message } = event.payload;
        if (get().activeConversationId !== conversation_id) {
          runtime.pendingConversationRefresh.add(conversation_id);
          return;
        }
        set((s) => {
          if (s.messages.some((message) => message.id === marker_message.id)) return {};
          const messages = [...s.messages, marker_message].sort((left, right) => (
            left.created_at - right.created_at || left.id.localeCompare(right.id)
          ));
          return { messages };
        });
      });

      // If generation changed while awaiting, this listener set is stale
      if (runtime.listenerGen !== gen) {
        chunkUnsub();
        errorUnsub();
        titleUnsub();
        titleGenUnsub();
        ragUnsub();
        compressionUnsub();
        return;
      }

      runtime.unlisten = () => {
        chunkUnsub();
        errorUnsub();
        titleUnsub();
        titleGenUnsub();
        ragUnsub();
        compressionUnsub();
      };
    },
    stopStreamListening: () => {
      runtime.listenerGen++;
      if (runtime.unlisten) {
        runtime.unlisten();
        runtime.unlisten = null;
      }
    },
    cancelCurrentStream: () => {
      const cancellingMultiModel = runtime.isMultiModelActive;
      if (runtime.activeAgentCancel) {
        runtime.activeAgentCancel();
      } else {
        runtime.agentStreamSeq++;
      }
      flushPendingStreamChunk(set, get);
      materializeLiveStreamContent(set, [
        get().streamingMessageId,
        runtime.streamBuffer?.messageId,
        runtime.streamBuffer?.resolvedId,
      ]);
      runtime.pendingUiChunk = null;
      runtime.streamBuffer = null;
      runtime.pendingConversationRefresh.clear();
      // Clean up multi-model state on cancel
      if (runtime.isMultiModelActive) {
        runtime.multiModelRunId++;
        runtime.isMultiModelActive = false;
        runtime.multiModelTotalRemaining = 0;
        runtime.multiModelFirstTarget = null;
        runtime.multiModelFirstMessageId = null;
        runtime.multiModelHistoryMode = 'selected';
        runtime.userManuallySelectedVersion = false;
        runtime.multiModelStreamIds.clear();
        if (runtime.multiModelDoneResolve) {
          const r = runtime.multiModelDoneResolve;
          runtime.multiModelDoneResolve = null;
          r();
        }
        set({ pendingCompanionModels: [], multiModelParentId: null, multiModelDoneMessageIds: [] });
      }
      if (runtime.streamUiFlushTimer !== null) {
        clearTimeout(runtime.streamUiFlushTimer);
        runtime.streamUiFlushTimer = null;
      }
      // Tell the backend to cancel the stream — fire and forget
      const conversationId = get().streamingConversationId ?? get().activeConversationId;
      const streamId = get().activeStreamId;
      if (conversationId && isTauri()) {
        invoke('cancel_stream', {
          conversationId,
          streamId: cancellingMultiModel ? null : streamId,
        }).catch(() => {});
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
        activeStreamId: null,
        streamActivityByMessageId: removeStreamActivities(
          s.streamActivityByMessageId,
          [streamMsgId],
        ),
        thinkingActiveMessageIds: new Set<string>(),
        messages: streamMsgId
          ? s.messages.map(m => m.id === streamMsgId ? { ...m, status: 'partial' as const } : m)
          : s.messages,
      }));
    },
  };
}
