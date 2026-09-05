import { isTauri } from '@/lib/invoke';
import type { AttachmentInput, Message } from '@/types';
import {
  conversationRuntime as runtime,
  deleteRunRuntime,
  isObservedStreamingFor,
  markRunStopCompleted,
  type ChatQueueBucket,
  type ChatStreamTerminalEvent,
  type ConversationState,
  type ConversationStoreSet,
  type QueuedChatMessage,
} from './conversationStoreSupport';
import {
  clearConversationRun,
  isLiveConversationRun,
  upsertObservedStream,
} from './conversationRunRegistry';

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
    resumeAfterCancel: false,
    deletingRound: false,
  };
}

function cloneAttachments(attachments: AttachmentInput[]): AttachmentInput[] {
  return attachments.map((attachment) => ({ ...attachment }));
}

function canUseOrdinaryChat(state: ConversationState, conversationId: string): boolean {
  const conversation = state.conversations.find((item) => item.id === conversationId)
    ?? state.archivedConversations.find((item) => item.id === conversationId);
  const targets = state.activeConversationId === conversationId
    ? state.multiModelTargets
    : conversation?.multi_model_targets ?? [];
  const run = state.runsByConversation?.[conversationId];
  return Boolean(
    conversation
    && conversation.mode !== 'agent'
    && targets.length === 0
    && run?.mode !== 'multi-model'
    && !(runtime.isMultiModelActive && state.streamingConversationId === conversationId),
  );
}

function isQueueDispatchBusy(state: ConversationState, conversationId: string): boolean {
  const bucket = state.chatQueueByConversation[conversationId];
  const run = state.runsByConversation?.[conversationId];
  return Boolean(
    isLiveConversationRun(run)
    || (state.streaming && state.streamingConversationId === conversationId)
    || isObservedStreamingFor(state, conversationId)
    || bucket?.drainingMessageId
    || bucket?.drainingStreamId
    || bucket?.phase === 'waiting'
    || bucket?.deletingRound,
  );
}

function setQueueBucket(
  set: ConversationStoreSet,
  conversationId: string,
  update: (bucket: ChatQueueBucket) => ChatQueueBucket | null,
): void {
  let nextBucket: ChatQueueBucket | null = null;
  set((state) => {
    const current = state.chatQueueByConversation[conversationId] ?? createEmptyChatQueueBucket();
    const next = update(current);
    nextBucket = next;
    const chatQueueByConversation = { ...state.chatQueueByConversation };
    if (next) {
      chatQueueByConversation[conversationId] = next;
    } else {
      delete chatQueueByConversation[conversationId];
    }
    return { chatQueueByConversation };
  });
  resolveSendNowWaiter(conversationId, nextBucket);
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

export function armQueueForStop(
  set: ConversationStoreSet,
  conversationId: string,
  streamId: string | null,
): void {
  setQueueBucket(set, conversationId, (bucket) => {
    const pendingCount = bucket.messages.filter(
      (message) => message.id !== bucket.drainingMessageId,
    ).length;
    if (pendingCount > 0 && !bucket.sendNowMessageId) {
      return {
        ...bucket,
        phase: 'paused',
        paused: true,
        pauseReason: bucket.pauseReason === 'cancel-error' ? 'cancel-error' : 'cancelled',
        resumeAfterCancel: false,
        drainingStreamId: streamId ?? bucket.drainingStreamId,
      };
    }
    return {
      ...bucket,
      resumeAfterCancel: true,
      paused: false,
      pauseReason: bucket.pauseReason === 'cancel-error' ? bucket.pauseReason : null,
      drainingStreamId: streamId ?? bucket.drainingStreamId,
      phase: bucket.drainingMessageId ? 'dispatching' : 'waiting',
    };
  });
}

export function setChatQueueDeletingRound(
  set: ConversationStoreSet,
  conversationId: string,
  deletingRound: boolean,
): void {
  setQueueBucket(set, conversationId, (bucket) => ({
    ...bucket,
    deletingRound,
  }));
}

export function markChatQueueCancelError(
  set: ConversationStoreSet,
  conversationId: string,
  error: string,
  expectedDrainingMessageId: string | null,
  expectedDrainingStreamId: string | null,
): void {
  setQueueBucket(set, conversationId, (bucket) => {
    if (
      bucket.drainingMessageId !== expectedDrainingMessageId
      || bucket.drainingStreamId !== expectedDrainingStreamId
    ) return bucket;
    return {
      ...bucket,
      phase: 'paused',
      paused: true,
      pauseReason: 'cancel-error',
      error,
      resumeAfterCancel: false,
    };
  });
}

const sendNowWaiters = new Map<string, {
  messageId: string;
  resolve: (ok: boolean) => void;
}>();

function resolveSendNowWaiter(conversationId: string, bucket: ChatQueueBucket | null | undefined): void {
  const waiter = sendNowWaiters.get(conversationId);
  if (!waiter) return;
  if (bucket?.drainingMessageId === waiter.messageId) {
    sendNowWaiters.delete(conversationId);
    waiter.resolve(true);
    return;
  }
  const stillQueued = Boolean(bucket?.messages.some((message) => message.id === waiter.messageId));
  if (bucket?.paused || !stillQueued) {
    sendNowWaiters.delete(conversationId);
    waiter.resolve(false);
  }
}

function waitForSendNowDispatch(
  get: () => ConversationState,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const bucket = get().chatQueueByConversation[conversationId];
  if (bucket?.drainingMessageId === messageId) return Promise.resolve(true);
  if (
    bucket?.paused
    && bucket.pauseReason === 'cancel-error'
    && bucket.sendNowMessageId === messageId
  ) {
    return Promise.resolve(false);
  }
  const previous = sendNowWaiters.get(conversationId);
  previous?.resolve(false);
  return new Promise((resolve) => {
    sendNowWaiters.set(conversationId, { messageId, resolve });
  });
}

export function createConversationQueueActions(
  set: ConversationStoreSet,
  get: () => ConversationState,
): ConversationQueueActions {
  return {
    submitChatMessage: async (content, attachments = [], searchProviderId = null, options) => {
      const state = get();
      const conversationId = options?.conversationId ?? state.activeConversationId;
      if (!conversationId) {
        return { kind: 'rejected', reason: 'no-active-conversation' };
      }
      if (!content.trim() && attachments.length === 0) {
        return { kind: 'rejected', reason: 'invalid-message' };
      }
      if (state.loading && state.activeConversationId === conversationId) {
        return { kind: 'rejected', reason: 'conversation-loading' };
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
        return get().chatQueueByConversation[conversationId]?.drainingMessageId === messageId;
      }

      const liveRun = Boolean(
        state.streaming
        || isObservedStreamingFor(state, conversationId)
        || isLiveConversationRun(state.runsByConversation?.[conversationId])
        || Boolean(expectedStreamId && bucket.pauseReason === 'cancel-error')
      );
      if (liveRun) {
        const terminalPayload: ChatStreamTerminalEvent = {
          conversation_id: state.streamingConversationId ?? conversationId,
          message_id: state.streamingMessageId ?? '',
          stream_id: bucket.drainingStreamId ?? state.activeStreamId ?? '',
          outcome: 'cancelled',
          error: null,
        };
        await get().cancelConversationRun({ conversationId });
        if (!isTauri() && expectedDrainingMessageId) {
          await get().handleChatStreamTerminal(terminalPayload);
        }
      }
      return waitForSendNowDispatch(get, conversationId, messageId);
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
        || (state.loading && state.activeConversationId === conversationId)
        || (
          runtime.pendingConversationRefresh.has(conversationId)
          && state.activeConversationId === conversationId
        )
        || isQueueDispatchBusy(state, conversationId)
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
          { conversationId },
        );
      } catch (error) {
        dispatch = Promise.reject(error);
      }
      const streamId = get().runsByConversation[conversationId]?.streamId
        ?? (get().streamingConversationId === conversationId ? get().activeStreamId : null);
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

      set((state) => {
        const matchingObserved = (
          state.observedStreamsByConversation?.[payload.conversation_id]?.streamId === payload.stream_id
          || state.observedStream?.conversationId === payload.conversation_id
            && state.observedStream.streamId === payload.stream_id
        );
        const withoutRun = {
          ...state,
          ...clearConversationRun(state, payload.conversation_id, payload.stream_id || undefined),
        };
        const withoutObserved = matchingObserved
          ? {
            ...withoutRun,
            ...upsertObservedStream(withoutRun, payload.conversation_id, null),
          }
          : withoutRun;
        return {
          ...withoutObserved,
          thinkingActiveMessageIds: state.activeConversationId === payload.conversation_id
            ? new Set<string>()
            : state.thinkingActiveMessageIds,
        };
      });
      markRunStopCompleted(payload.conversation_id);
      if (!isLiveConversationRun(get().runsByConversation[payload.conversation_id])) {
        deleteRunRuntime(payload.conversation_id);
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
          ) || (
            payload.outcome === 'cancelled'
            && (sendNowRequested || bucket.resumeAfterCancel)
          )
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
          resumeAfterCancel: false,
        };
      });

      if (terminalClaimed && shouldContinueTerminalQueue && terminalSyncReady) {
        if (isTauri()) {
          await get().drainChatQueue(payload.conversation_id);
        } else {
          void get().drainChatQueue(payload.conversation_id);
        }
      }
    },
  } satisfies ConversationQueueActions;
}

export type { ConversationQueueActions };
