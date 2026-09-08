import { invoke, listen, type UnlistenFn } from '@/lib/invoke';
import { appendStreamErrorToContent } from '@/lib/streamStatus';
import type {
  AgentDoneEvent,
  AgentErrorEvent,
  AgentStreamTextEvent,
  AgentStreamThinkingEvent,
  Message,
} from '@/types';
import { useAgentStore } from './agentStore';
import {
  clearConversationRun,
  createConversationRun,
  isLiveConversationRun,
  upsertConversationRun,
} from './conversationRunRegistry';
import {
  AGENT_STREAM_UI_FLUSH_INTERVAL_MS,
  appendCachedConversationMessages,
  conversationRuntime as runtime,
  createStreamActivity,
  deleteRunRuntime,
  getEffectiveMcpServerIds,
  getOrCreateRunRuntime,
  mapCachedConversationMessages,
  markRunStopCompleted,
  rekeyMessageDisplayMap,
  sanitizeActiveConversationCapabilityIds,
  type ChatStreamTerminalEvent,
  type ConversationState,
  type ConversationStoreSet,
} from './conversationStoreSupport';

type ConversationAgentActions = Pick<ConversationState, 'sendAgentMessage'>;

function rekeyThinkingIds(
  ids: Set<string>,
  fromId: string,
  toId: string,
): Set<string> {
  if (fromId === toId || !ids.has(fromId)) return ids;
  const next = new Set(ids);
  next.delete(fromId);
  next.add(toId);
  return next;
}

export function createConversationAgentActions(
  set: ConversationStoreSet,
  get: () => ConversationState,
): ConversationAgentActions {
  return {
    sendAgentMessage: async (content, attachments = [], options) => {
      const conversationId = options?.conversationId ?? get().activeConversationId;
      if (!conversationId) throw new Error('No active conversation');
      if (get().loading && get().activeConversationId === conversationId) {
        throw new Error('Conversation messages are still loading');
      }

      if (isLiveConversationRun(get().runsByConversation[conversationId])) {
        await get().cancelConversationRun({ conversationId });
      }
      const pendingStop = getOrCreateRunRuntime(conversationId).stopCompleted;
      if (pendingStop) await pendingStop;

      const runRuntime = getOrCreateRunRuntime(conversationId);
      runRuntime.agentCancel = null;
      let cleanedUp = false;
      const agentRunSeq = ++runRuntime.agentStreamSeq;
      const isCurrentAgentRun = () => !cleanedUp && agentRunSeq === runRuntime.agentStreamSeq;
      runtime.agentStreamSeq = agentRunSeq;
      runtime.activeAgentCancel = () => runRuntime.agentCancel?.();

      const conversation = get().conversations.find((item) => item.id === conversationId);
      if (!conversation) throw new Error('Conversation not found');

      const providerId = conversation.provider_id;
      const modelId = conversation.model_id;
      const capabilityIds = sanitizeActiveConversationCapabilityIds(set, get, conversationId);
      const mcpIds = getEffectiveMcpServerIds(get, {
        providerId,
        modelId,
        mcpIds: capabilityIds.enabledMcpServerIds,
      });

      const runId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `agent-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const streamId = runId;
      const optimisticUserMsg: Message = {
        id: `temp-user-${runId}`,
        conversation_id: conversationId,
        role: 'user',
        content,
        provider_id: null,
        model_id: null,
        token_count: null,
        attachments: attachments.map((attachment) => ({
          id: `temp-att-${Date.now()}`,
          file_name: attachment.file_name,
          file_type: attachment.file_type,
          file_path: '',
          file_size: attachment.file_size,
          data: attachment.data,
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

      let currentMsgId = `temp-agent-${runId}`;
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

      const agentRun = createConversationRun({
        conversationId,
        runId,
        streamId,
        streamingMessageId: currentMsgId,
        mode: 'agent',
        phase: 'streaming',
        revision: (get().runWatermarksByConversation[conversationId]?.revision ?? 0) + 1,
      });
      if (get().activeConversationId === conversationId) {
        set((state) => ({
          messages: [...state.messages, optimisticUserMsg, placeholderAssistant],
          streamActivityByMessageId: {
            ...state.streamActivityByMessageId,
            [currentMsgId]: createStreamActivity(
              conversation?.provider_id,
              conversation?.model_id,
            ),
          },
          ...upsertConversationRun(state, agentRun),
        }));
      } else {
        appendCachedConversationMessages(conversationId, [optimisticUserMsg, placeholderAssistant]);
        set((state) => upsertConversationRun(state, agentRun));
      }

      let unlistenDone: UnlistenFn | null = null;
      let unlistenError: UnlistenFn | null = null;
      let unlistenStreamText: UnlistenFn | null = null;
      let unlistenStreamThinking: UnlistenFn | null = null;
      let unlistenMessageId: UnlistenFn | null = null;
      let unlistenTerminal: UnlistenFn | null = null;
      let finishing = false;

      let pendingText = '';
      let pendingThinking = '';
      let thinkingOpen = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushAgentStreamChunks = () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        const textChunk = pendingText;
        const thinkingChunk = pendingThinking;
        pendingText = '';
        pendingThinking = '';
        if (!textChunk && !thinkingChunk) return;

        set((state) => {
          const wasThinking = thinkingOpen;
          let nextThinkingIds = state.thinkingActiveMessageIds;
          const update = (messages: Message[]) => messages.map((message) => {
            if (message.id !== currentMsgId) return message;
            let nextContent = message.content || '';
            let thinking = message.thinking || '';
            if (thinkingChunk) {
              if (!wasThinking) nextContent += '<think data-aqbot="1">\n';
              nextContent += thinkingChunk;
              thinking += thinkingChunk;
              nextThinkingIds = new Set([...nextThinkingIds, currentMsgId]);
            }
            if (textChunk) {
              const isCurrentlyThinking = thinkingChunk ? true : wasThinking;
              if (isCurrentlyThinking) {
                nextContent += '\n</think>\n\n';
                const next = new Set(nextThinkingIds);
                next.delete(currentMsgId);
                nextThinkingIds = next;
              }
              nextContent += textChunk;
            }
            return { ...message, content: nextContent, thinking };
          });
          const active = state.activeConversationId === conversationId;
          const updatedMessages = active ? update(state.messages) : state.messages;
          if (!active) mapCachedConversationMessages(conversationId, update);
          thinkingOpen = textChunk ? false : Boolean(thinkingChunk) || wasThinking;
          return {
            thinkingActiveMessageIds: nextThinkingIds,
            messages: updatedMessages,
          };
        });
      };

      const scheduleAgentFlush = () => {
        if (flushTimer === null) {
          flushTimer = setTimeout(flushAgentStreamChunks, AGENT_STREAM_UI_FLUSH_INTERVAL_MS);
        }
      };

      const clearAgentStreamBuffer = () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        pendingText = '';
        pendingThinking = '';
      };

      const cleanup = () => {
        if (!cleanedUp && runRuntime.agentStreamSeq === agentRunSeq) {
          runRuntime.agentStreamSeq += 1;
        }
        cleanedUp = true;
        clearAgentStreamBuffer();
        unlistenStreamText?.();
        unlistenStreamThinking?.();
        unlistenDone?.();
        unlistenError?.();
        unlistenMessageId?.();
        unlistenTerminal?.();
        unlistenStreamText = null;
        unlistenStreamThinking = null;
        unlistenDone = null;
        unlistenError = null;
        unlistenMessageId = null;
        unlistenTerminal = null;
        if (runtime.activeAgentCancel === cancelLocalRun) {
          runtime.activeAgentCancel = null;
        }
        runRuntime.agentCancel = null;
      };

      const keepAgentUnlisten = (assign: (fn: UnlistenFn) => void) => (fn: UnlistenFn) => {
        if (cleanedUp || !isCurrentAgentRun()) {
          fn();
          return;
        }
        assign(fn);
      };

      const matchesRun = (eventRunId?: string) => !eventRunId || eventRunId === runId;
      const ownsLiveRun = () => {
        const run = get().runsByConversation[conversationId];
        return Boolean(run && run.runId === runId && isLiveConversationRun(run));
      };

      const finishAgentRun = async (input: {
        outcome: ChatStreamTerminalEvent['outcome'];
        text?: string;
        error?: string | null;
        assistantMessageId?: string;
        usage?: { input_tokens: number; output_tokens: number };
        refresh?: boolean;
      }) => {
        if (finishing || !isCurrentAgentRun()) return;
        finishing = true;
        flushAgentStreamChunks();
        const nextId = input.assistantMessageId || currentMsgId;
        const isActiveConversation = get().activeConversationId === conversationId;
        if (ownsLiveRun() || get().messages.some((message) => message.id === currentMsgId)) {
          const messagePatch: Partial<Message> & { id: string } = {
            id: nextId,
            status: input.outcome === 'complete'
              ? 'complete'
              : input.outcome === 'error'
                ? 'error'
                : 'partial',
          };
          if (input.outcome === 'error') {
            messagePatch.content = input.error || input.text || '';
          } else if (input.outcome === 'complete' && input.text !== undefined) {
            messagePatch.content = input.text;
          }
          if (input.usage) {
            messagePatch.prompt_tokens = input.usage.input_tokens;
            messagePatch.completion_tokens = input.usage.output_tokens;
          }
          const apply = (messages: Message[]) => messages.map((message) => message.id === currentMsgId
            ? { ...message, ...messagePatch, ...(input.outcome === 'error'
              ? { content: appendStreamErrorToContent(message.content, input.error ?? input.text ?? '') }
              : {}) }
            : message);
          if (isActiveConversation) {
            set((state) => ({
              thinkingActiveMessageIds: (() => {
                const next = new Set(state.thinkingActiveMessageIds);
                next.delete(currentMsgId);
                next.delete(nextId);
                return next;
              })(),
              messages: apply(state.messages),
            }));
          } else {
            mapCachedConversationMessages(conversationId, apply);
            runtime.pendingConversationRefresh.add(conversationId);
          }
        }
        useAgentStore.getState().clearStatus(conversationId, runId);
        cleanup();
        if (input.refresh === false) {
          set((state) => ({
            ...clearConversationRun(state, conversationId, streamId),
          }));
          markRunStopCompleted(conversationId);
          if (!isLiveConversationRun(get().runsByConversation[conversationId])) {
            deleteRunRuntime(conversationId);
          }
        } else {
          await get().handleChatStreamTerminal({
            conversation_id: conversationId,
            message_id: nextId,
            stream_id: streamId,
            outcome: input.outcome,
            error: input.error ?? null,
          });
        }
      };

      const cancelLocalRun = () => {
        void finishAgentRun({ outcome: 'cancelled', refresh: false });
      };
      runRuntime.agentCancel = cancelLocalRun;
      runtime.activeAgentCancel = cancelLocalRun;

      useAgentStore.getState().setActiveRun(conversationId, runId);

      try {
        let resolveEvent: () => void = () => {};
        const eventPromise = new Promise<void>((resolve) => {
          resolveEvent = resolve;
        });

        const [
          messageIdUnlisten,
          streamTextUnlisten,
          streamThinkingUnlisten,
          doneUnlisten,
          errorUnlisten,
          terminalUnlisten,
        ] = await Promise.all([
          listen<{ conversationId: string; assistantMessageId: string; runId?: string }>('agent-message-id', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            flushAgentStreamChunks();
            const realId = event.payload.assistantMessageId;
            const oldId = currentMsgId;
            if (!realId || realId === oldId) return;
            currentMsgId = realId;
            set((state) => {
              const run = state.runsByConversation[conversationId];
              const nextRun = run && run.runId === runId
                ? {
                    ...run,
                    streamingMessageId: realId,
                    revision: run.revision + 1,
                  }
                : null;
              const activity = state.streamActivityByMessageId[oldId];
              const streamActivityByMessageId = { ...state.streamActivityByMessageId };
              if (activity) {
                streamActivityByMessageId[realId] = activity;
                delete streamActivityByMessageId[oldId];
              }
              return {
                ragDisplayByMessageId: rekeyMessageDisplayMap(
                  state.ragDisplayByMessageId,
                  oldId,
                  realId,
                ),
                searchDisplayByMessageId: rekeyMessageDisplayMap(
                  state.searchDisplayByMessageId,
                  oldId,
                  realId,
                ),
                streamActivityByMessageId,
                thinkingActiveMessageIds: rekeyThinkingIds(
                  state.thinkingActiveMessageIds,
                  oldId,
                  realId,
                ),
                messages: state.messages.map((message) => (
                  message.id === oldId ? { ...message, id: realId } : message
                )),
                ...(nextRun ? upsertConversationRun(state, nextRun) : {}),
              };
            });
            if (get().activeConversationId !== conversationId) {
              mapCachedConversationMessages(conversationId, (messages) => (
                messages.map((message) => (
                  message.id === oldId ? { ...message, id: realId } : message
                ))
              ));
            }
          }),
          listen<AgentStreamTextEvent>('agent-stream-text', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            pendingText += event.payload.text;
            scheduleAgentFlush();
          }),
          listen<AgentStreamThinkingEvent>('agent-stream-thinking', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            pendingThinking += event.payload.thinking;
            scheduleAgentFlush();
          }),
          listen<AgentDoneEvent>('agent-done', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            void finishAgentRun({
              outcome: 'complete',
              text: event.payload.text,
              assistantMessageId: event.payload.assistantMessageId || currentMsgId,
              usage: event.payload.usage,
            }).then(resolveEvent);
          }),
          listen<AgentErrorEvent>('agent-error', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            void finishAgentRun({
              outcome: 'error',
              error: event.payload.message,
              assistantMessageId: event.payload.assistantMessageId || currentMsgId,
            }).then(resolveEvent);
          }),
          listen<ChatStreamTerminalEvent>('chat-stream-terminal', (event) => {
            if (event.payload.conversation_id !== conversationId) return;
            if (event.payload.stream_id !== streamId && event.payload.stream_id !== runId) return;
            if (!isCurrentAgentRun()) return;
            void finishAgentRun({
              outcome: event.payload.outcome,
              error: event.payload.error,
              assistantMessageId: event.payload.message_id || currentMsgId,
            }).then(resolveEvent);
          }),
        ]);

        keepAgentUnlisten((fn) => { unlistenMessageId = fn; })(messageIdUnlisten);
        keepAgentUnlisten((fn) => { unlistenStreamText = fn; })(streamTextUnlisten);
        keepAgentUnlisten((fn) => { unlistenStreamThinking = fn; })(streamThinkingUnlisten);
        keepAgentUnlisten((fn) => { unlistenDone = fn; })(doneUnlisten);
        keepAgentUnlisten((fn) => { unlistenError = fn; })(errorUnlisten);
        keepAgentUnlisten((fn) => { unlistenTerminal = fn; })(terminalUnlisten);

        if (cleanedUp || !isCurrentAgentRun()) return;

        await get().startStreamListening();
        if (!isCurrentAgentRun() || !ownsLiveRun()) return;
        runRuntime.sendIpcStarted = true;
        runRuntime.sendIpcPending = true;
        try {
          const query = invoke<void>('agent_query', {
            conversationId,
            prompt: content,
            providerId,
            modelId,
            attachments: attachments ?? [],
            enabledMcpServerIds: mcpIds,
            enabledKnowledgeBaseIds: capabilityIds.enabledKnowledgeBaseIds,
            enabledMemoryNamespaceIds: capabilityIds.enabledMemoryNamespaceIds,
            streamId,
            runId,
          });
          // A completion barrier only; awaiting query below handles its actual error.
          runRuntime.agentStartCompleted = Promise.allSettled([query]).then(() => undefined);
          await query;
        } finally {
          runRuntime.sendIpcPending = false;
          runRuntime.agentStartCompleted = null;
        }

        void eventPromise.catch((error) => {
          console.error('[sendAgentMessage] stream error:', error);
        });
      } catch (error) {
        const errMsg = String(error);
        console.error('[sendAgentMessage] error:', errMsg);
        const cancelled = errMsg === 'Agent cancelled';
        await finishAgentRun({
          outcome: cancelled ? 'cancelled' : 'error',
          error: cancelled ? null : errMsg,
          text: cancelled ? undefined : errMsg,
          refresh: false,
        });
      }
    },
  };
}
