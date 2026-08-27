import { invoke, isTauri } from '@/lib/invoke';
import type { AttachmentInput, Message } from '@/types';
import {
  conversationRuntime as runtime,
  isObservedStreamingFor,
  type ChatQueueBucket,
  type ChatStreamTerminalEvent,
  type ConversationState,
  type ConversationStoreSet,
  type QueuedChatMessage,
} from './conversationStoreSupport';

type ConversationQueueActions = Pick<ConversationState,
  | 'submitChatMessage'
  | 'updateQueuedChatMessage'
  | 'removeQueuedChatMessage'
  | 'sendQueuedChatMessageNow'
  | 'resumeChatQueue'
  | 'drainChatQueue'
  | 'handleChatStreamTerminal'
>;

let queueMessageSequence = 0;

function createQueueMessageId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `chat-queue-${randomId}`;
  queueMessageSequence += 1;
  return `chat-queue-${Date.now()}-${queueMessageSequence}`;
}

export function createEmptyChatQueueBucket(): ChatQueueBucket {
  return {
    messages: [],
    phase: 'ready',
    paused: false,
    pauseReason: null,
    error: null,
    drainingMessageId: null,
    drainingStreamId: null,
    sendNowMessageId: null,
  };
}

function cloneAttachments(attachments: AttachmentInput[]): AttachmentInput[] {
  return attachments.map((attachment) => ({ ...attachment }));
}

function canUseOrdinaryChat(state: ConversationState, conversationId: string): boolean {
  const conversation = state.conversations.find((item) => item.id === conversationId)
    ?? state.archivedConversations.find((item) => item.id === conversationId);
  return Boolean(
    conversation
    && conversation.mode !== 'agent'
    && state.multiModelTargets.length === 0
    && !runtime.isMultiModelActive,
  );
}

function isQueueDispatchBusy(state: ConversationState, conversationId: string): boolean {
  const bucket = state.chatQueueByConversation[conversationId];
  return Boolean(
    (state.streaming && state.streamingConversationId === conversationId)
    || isObservedStreamingFor(state, conversationId)
    || bucket?.drainingMessageId
    || bucket?.drainingStreamId
    || bucket?.phase === 'waiting',
  );
}

function isOtherConversationStreaming(state: ConversationState, conversationId: string): boolean {
  return Boolean(
    (
      state.streaming
      && state.streamingConversationId
      && state.streamingConversationId !== conversationId
    )
    || (
      state.observedStream?.streaming
      && state.observedStream.conversationId !== conversationId
    ),
  );
}

function setQueueBucket(
  set: ConversationStoreSet,
  conversationId: string,
  update: (bucket: ChatQueueBucket) => ChatQueueBucket | null,
): void {
  set((state) => {
    const current = state.chatQueueByConversation[conversationId] ?? createEmptyChatQueueBucket();
    const next = update(current);
    const chatQueueByConversation = { ...state.chatQueueByConversation };
    if (next) {
      chatQueueByConversation[conversationId] = next;
    } else {
      delete chatQueueByConversation[conversationId];
    }
    return { chatQueueByConversation };
  });
}

export function bindWaitingChatQueueToStream(
  set: ConversationStoreSet,
  conversationId: string,
  streamId: string,
): void {
  set((state) => {
    const bucket = state.chatQueueByConversation[conversationId];
    if (!bucket || bucket.messages.length === 0) return {};
    return {
      chatQueueByConversation: {
        ...state.chatQueueByConversation,
        [conversationId]: {
          ...bucket,
          phase: bucket.drainingMessageId
            ? 'dispatching'
            : bucket.paused ? 'paused' : 'waiting',
          drainingStreamId: streamId,
        },
      },
    };
  });
}

export function ensureChatQueueStreamBlocker(
  set: ConversationStoreSet,
  conversationId: string,
  streamId: string,
): void {
  set((state) => {
    const bucket = state.chatQueueByConversation[conversationId]
      ?? createEmptyChatQueueBucket();
    return {
      chatQueueByConversation: {
        ...state.chatQueueByConversation,
        [conversationId]: {
          ...bucket,
          phase: bucket.drainingMessageId
            ? 'dispatching'
            : bucket.paused ? 'paused' : 'waiting',
          drainingStreamId: streamId,
        },
      },
    };
  });
}

export function createConversationQueueActions(
  set: ConversationStoreSet,
  get: () => ConversationState,
): ConversationQueueActions {
  return {
    submitChatMessage: async (content, attachments = [], searchProviderId = null) => {
      const state = get();
      const conversationId = state.activeConversationId;
      if (!conversationId) {
        return { kind: 'rejected', reason: 'no-active-conversation' };
      }
      if (!content.trim() && attachments.length === 0) {
        return { kind: 'rejected', reason: 'invalid-message' };
      }
      if (state.loading) {
        return { kind: 'rejected', reason: 'conversation-loading' };
      }
      if (isOtherConversationStreaming(state, conversationId)) {
        return { kind: 'rejected', reason: 'other-conversation-busy' };
      }
      if (!canUseOrdinaryChat(state, conversationId)) {
        return { kind: 'rejected', reason: 'unsupported-mode' };
      }

      const bucket = state.chatQueueByConversation[conversationId];
      const wasQueueEmpty = !bucket || bucket.messages.length === 0;
      const wasBusy = isQueueDispatchBusy(state, conversationId);
      const now = Date.now();
      const queuedMessage: QueuedChatMessage = {
        id: createQueueMessageId(),
        conversationId,
        content,
        attachments: cloneAttachments(attachments),
        searchProviderId,
        status: 'queued',
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      setQueueBucket(set, conversationId, (current) => ({
        ...current,
        phase: current.paused
          ? 'paused'
          : current.drainingMessageId
            ? 'dispatching'
            : wasBusy ? 'waiting' : 'ready',
        drainingStreamId: current.drainingStreamId
          ?? (wasBusy && !current.drainingMessageId
            ? state.activeStreamId ?? state.observedStream?.streamId ?? null
            : null),
        messages: [...current.messages, queuedMessage],
      }));

      if (wasBusy || bucket?.paused) {
        return { kind: 'queued', queueId: queuedMessage.id };
      }

      const sentMessage = await get().drainChatQueue(conversationId);
      if (wasQueueEmpty && sentMessage) {
        return { kind: 'started', message: sentMessage };
      }
      return { kind: 'queued', queueId: queuedMessage.id };
    },

    updateQueuedChatMessage: (conversationId, messageId, patch) => {
      if (!get().chatQueueByConversation[conversationId]) return false;
      let updated = false;
      setQueueBucket(set, conversationId, (bucket) => {
        if (bucket.drainingMessageId === messageId) return bucket;
        const target = bucket.messages.find((message) => message.id === messageId);
        if (!target) return bucket;
        const content = patch.content ?? target.content;
        const attachments = patch.attachments ?? target.attachments;
        if (!content.trim() && attachments.length === 0) return bucket;
        updated = true;
        return {
          ...bucket,
          messages: bucket.messages.map((message) => message.id === messageId
            ? {
                ...message,
                content,
                attachments: cloneAttachments(attachments),
                status: 'queued',
                error: null,
                updatedAt: Date.now(),
              }
            : message),
        };
      });
      return updated;
    },

    removeQueuedChatMessage: (conversationId, messageId) => {
      if (!get().chatQueueByConversation[conversationId]) return false;
      let removed = false;
      setQueueBucket(set, conversationId, (bucket) => {
        if (bucket.drainingMessageId === messageId) return bucket;
        const messages = bucket.messages.filter((message) => message.id !== messageId);
        if (messages.length === bucket.messages.length) return bucket;
        removed = true;
        if (messages.length === 0) {
          if (bucket.drainingStreamId || bucket.phase === 'waiting') {
            return {
              ...bucket,
              messages: [],
              sendNowMessageId: null,
            };
          }
          return null;
        }
        return {
          ...bucket,
          messages,
          sendNowMessageId: bucket.sendNowMessageId === messageId
            ? null
            : bucket.sendNowMessageId,
        };
      });
      return removed;
    },

    sendQueuedChatMessageNow: async (conversationId, messageId) => {
      const state = get();
      if (state.activeConversationId !== conversationId) return false;
      if (isOtherConversationStreaming(state, conversationId)) return false;
      const bucket = state.chatQueueByConversation[conversationId];
      const selected = bucket?.messages.find((message) => message.id === messageId);
      if (!bucket || !selected || bucket.drainingMessageId === messageId) return false;

      const sending = bucket.drainingMessageId
        ? bucket.messages.find((message) => message.id === bucket.drainingMessageId) ?? null
        : null;
      const expectedDrainingMessageId = bucket.drainingMessageId;
      const expectedStreamId = bucket.drainingStreamId ?? state.activeStreamId;
      const remaining = bucket.messages.filter((message) => (
        message.id !== messageId && message.id !== sending?.id
      ));
      const busy = isQueueDispatchBusy(state, conversationId);
      setQueueBucket(set, conversationId, (current) => ({
        ...current,
        phase: sending ? 'dispatching' : busy ? 'waiting' : 'ready',
        paused: false,
        pauseReason: null,
        error: null,
        sendNowMessageId: busy ? messageId : null,
        messages: [
          ...(sending ? [sending] : []),
          { ...selected, status: 'queued', error: null, updatedAt: Date.now() },
          ...remaining,
        ],
      }));

      if (!busy) {
        await get().drainChatQueue(conversationId);
        return true;
      }

      if (
        state.streaming
        || isObservedStreamingFor(state, conversationId)
        || Boolean(expectedStreamId && bucket.pauseReason === 'cancel-error')
      ) {
        const terminalPayload: ChatStreamTerminalEvent = {
          conversation_id: state.streamingConversationId ?? conversationId,
          message_id: state.streamingMessageId ?? '',
          stream_id: bucket.drainingStreamId ?? state.activeStreamId ?? '',
          outcome: 'cancelled',
          error: null,
        };
        if (isTauri()) {
          try {
            await invoke('cancel_stream', {
              conversationId: terminalPayload.conversation_id,
              streamId: terminalPayload.stream_id || null,
            });
          } catch (error) {
            const latestBucket = get().chatQueueByConversation[conversationId];
            const cancellationStillPending = Boolean(
              latestBucket?.sendNowMessageId === messageId
              && latestBucket.drainingMessageId === expectedDrainingMessageId,
            );
            if (!cancellationStillPending) return true;
            const cancellationError = String(error);
            setQueueBucket(set, conversationId, (current) => ({
              ...current,
              phase: 'paused',
              paused: true,
              pauseReason: 'cancel-error',
              error: cancellationError,
            }));
            return false;
          }
          const latest = get();
          const latestBucket = latest.chatQueueByConversation[conversationId];
          const cancellationStillPending = Boolean(
            latestBucket?.sendNowMessageId === messageId
            && latestBucket.drainingMessageId === expectedDrainingMessageId,
          );
          const stillOwnsOriginalStream = expectedStreamId
            ? latest.activeStreamId === expectedStreamId
            : latest.observedStream?.conversationId === conversationId
              || (
                latest.streaming
                && latest.streamingConversationId === conversationId
              );
          if (cancellationStillPending && stillOwnsOriginalStream) {
            latest.cancelCurrentStream({ skipBackend: true });
          }
        } else {
          get().cancelCurrentStream();
        }
        if (!isTauri() && bucket.drainingMessageId) {
          await get().handleChatStreamTerminal(terminalPayload);
        }
      }
      return true;
    },

    resumeChatQueue: async (conversationId) => {
      if (!get().chatQueueByConversation[conversationId]) return;
      setQueueBucket(set, conversationId, (bucket) => ({
        ...bucket,
        phase: 'ready',
        paused: false,
        pauseReason: null,
        error: null,
        messages: bucket.messages.map((message) => message.status === 'dispatching'
          ? message
          : { ...message, status: 'queued', error: null, updatedAt: Date.now() }),
      }));
      await get().drainChatQueue(conversationId);
    },

    drainChatQueue: async (conversationId) => {
      const state = get();
      const bucket = state.chatQueueByConversation[conversationId];
      if (
        !bucket
        || bucket.messages.length === 0
        || bucket.paused
        || bucket.drainingMessageId
        || state.activeConversationId !== conversationId
        || state.loading
        || state.streaming
        || runtime.pendingConversationRefresh.has(conversationId)
        || isQueueDispatchBusy(state, conversationId)
        || isOtherConversationStreaming(state, conversationId)
        || !canUseOrdinaryChat(state, conversationId)
      ) {
        return null;
      }

      const message = bucket.messages[0];
      setQueueBucket(set, conversationId, (current) => ({
        ...current,
        phase: 'dispatching',
        drainingMessageId: message.id,
        drainingStreamId: null,
        sendNowMessageId: current.sendNowMessageId === message.id
          ? null
          : current.sendNowMessageId,
        messages: current.messages.map((item) => item.id === message.id
          ? { ...item, status: 'dispatching', error: null, updatedAt: Date.now() }
          : item),
      }));

      let dispatch: Promise<Message | null>;
      try {
        dispatch = get().sendMessage(
          message.content,
          cloneAttachments(message.attachments),
          message.searchProviderId,
        );
      } catch (error) {
        dispatch = Promise.reject(error);
      }
      const streamId = get().activeStreamId;
      setQueueBucket(set, conversationId, (current) => current.drainingMessageId === message.id
        ? { ...current, drainingStreamId: streamId }
        : current);

      let sentMessage: Message | null = null;
      let dispatchError: string | null = null;
      try {
        sentMessage = await dispatch;
        if (!sentMessage) {
          dispatchError = get().error;
        }
      } catch (error) {
        dispatchError = String(error);
      }
      if (sentMessage) return sentMessage;

      setQueueBucket(set, conversationId, (current) => {
        if (current.drainingMessageId !== message.id) return current;
        return {
          ...current,
          phase: 'paused',
          paused: true,
          pauseReason: 'dispatch-error',
          error: dispatchError,
          drainingMessageId: null,
          drainingStreamId: null,
          messages: current.messages.map((item) => item.id === message.id
            ? { ...item, status: 'failed', error: dispatchError, updatedAt: Date.now() }
            : { ...item, status: 'queued', updatedAt: Date.now() }),
        };
      });
      return null;
    },

    handleChatStreamTerminal: async (payload) => {
      const stateAtTerminal = get();
      const before = stateAtTerminal.chatQueueByConversation[payload.conversation_id];
      const expectedStreamId = before?.drainingStreamId ?? null;
      const differentActiveStream = Boolean(
        stateAtTerminal.streamingConversationId === payload.conversation_id
        && stateAtTerminal.activeStreamId
        && stateAtTerminal.activeStreamId !== payload.stream_id,
      );
      const differentObservedStream = Boolean(
        stateAtTerminal.observedStream?.conversationId === payload.conversation_id
        && stateAtTerminal.observedStream.streamId !== payload.stream_id,
      );
      if (!before && (differentActiveStream || differentObservedStream)) return;

      if (get().activeStreamId === payload.stream_id) {
        set({
          streaming: false,
          streamingMessageId: null,
          streamingConversationId: null,
          activeStreamId: null,
          thinkingActiveMessageIds: new Set<string>(),
        });
      }
      if (
        get().observedStream?.conversationId === payload.conversation_id
        && get().observedStream?.streamId === payload.stream_id
      ) {
        set({ observedStream: null });
      }
      if (expectedStreamId && expectedStreamId !== payload.stream_id) return;
      const queueRelevant = Boolean(before && (
        before.drainingMessageId
        || before.drainingStreamId
        || before.phase === 'waiting'
        || before.sendNowMessageId
        || before.pauseReason === 'cancel-error'
      ));

      const isActiveConversation = get().activeConversationId === payload.conversation_id;
      let terminalSyncReady = !isActiveConversation;
      if (isActiveConversation) {
        await get().fetchMessages(payload.conversation_id, [], { setLoading: false });
        terminalSyncReady = get().activeConversationId === payload.conversation_id
          && get().error === null;
        if (terminalSyncReady) {
          runtime.pendingConversationRefresh.delete(payload.conversation_id);
        } else {
          runtime.pendingConversationRefresh.add(payload.conversation_id);
        }
      } else {
        runtime.pendingConversationRefresh.add(payload.conversation_id);
      }

      if (!before || !queueRelevant) {
        const activeConversationId = get().activeConversationId;
        if (activeConversationId && activeConversationId !== payload.conversation_id) {
          void get().drainChatQueue(activeConversationId);
        }
        return;
      }

      let shouldContinueTerminalQueue = payload.outcome === 'complete';
      let terminalClaimed = false;
      setQueueBucket(set, payload.conversation_id, (bucket) => {
        const mismatchedAfterSync = Boolean(
          bucket.drainingStreamId
          && payload.stream_id
          && bucket.drainingStreamId !== payload.stream_id,
        );
        if (mismatchedAfterSync) return bucket;
        terminalClaimed = true;

        const messages = bucket.drainingMessageId
          ? bucket.messages.filter((message) => message.id !== bucket.drainingMessageId)
          : bucket.messages;
        if (messages.length === 0) return null;

        const sendNowRequested = Boolean(bucket.sendNowMessageId);
        const cancellationFailed = bucket.pauseReason === 'cancel-error';
        const mayContinue = !bucket.paused || (cancellationFailed && sendNowRequested);
        shouldContinueTerminalQueue = mayContinue && (
          (
            payload.outcome === 'complete'
            && (!cancellationFailed || sendNowRequested)
          ) || (payload.outcome === 'cancelled' && sendNowRequested)
        );
        const paused = !shouldContinueTerminalQueue;
        const pauseReason = paused
          ? bucket.paused
            ? bucket.pauseReason
            : cancellationFailed
              ? 'cancel-error'
              : payload.outcome === 'cancelled' ? 'cancelled' : 'error'
          : null;
        const terminalError = paused && (bucket.paused || cancellationFailed)
          ? bucket.error
          : payload.error ?? null;
        return {
          ...bucket,
          phase: paused ? 'paused' : 'ready',
          messages: messages.map((message) => ({
            ...message,
            status: 'queued',
            error: paused ? terminalError : null,
            updatedAt: Date.now(),
          })),
          paused,
          pauseReason,
          error: paused ? terminalError : null,
          drainingMessageId: null,
          drainingStreamId: null,
          sendNowMessageId: null,
        };
      });

      if (
        isActiveConversation
        && terminalSyncReady
        && terminalClaimed
        && get().activeConversationId === payload.conversation_id
        && shouldContinueTerminalQueue
      ) {
        if (isTauri()) {
          await get().drainChatQueue(payload.conversation_id);
        } else {
          void get().drainChatQueue(payload.conversation_id);
        }
      }
      const activeConversationId = get().activeConversationId;
      if (activeConversationId && activeConversationId !== payload.conversation_id) {
        void get().drainChatQueue(activeConversationId);
      }
    },
  } satisfies ConversationQueueActions;
}

export type { ConversationQueueActions };
