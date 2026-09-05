import { invoke, isTauri, listen, type UnlistenFn } from '@/lib/invoke';
import { listenConversationSync, notifyConversationChanged } from '@/lib/conversationSync';
import { snapshotStreamSyncState } from './conversationStoreSupport';
import {
  clearConversationRun,
  createConversationRun,
  isLiveConversationRun,
  upsertConversationRun,
  upsertObservedStream,
} from './conversationRunRegistry';
import { getCurrentWindowLabel } from '@/lib/windowKind';
import {
  applyMultiModelStreamError,
  hasMultipleModelVersions,
  insertModelVersionPlaceholder,
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
  Attachment,
  AttachmentInput,
  ChatStreamEvent,
  CompressionEvent,
  MultiModelRunEnvelope,
  MultiModelTargetSnapshot,
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
  appendCachedConversationMessages,
  conversationRuntime as runtime,
  createStreamActivity,
  createStreamId,
  ensureRunStopCompleted,
  markRunStopCompleted,
  getLoadedMessagesForConversation,
  getOrCreateRunRuntime,
  getRunRuntime,
  getStreamBuffer,
  setStreamBuffer,
  setStreamPrefix,
  findResolvedVersionForPendingSelection,
  flushPendingStreamChunk,
  resetPendingStreamUi,
  getActiveMessageEdges,
  getEffectiveMcpServerIds,
  getEffectiveThinkingBudget,
  getEffectiveThinkingLevel,
  getMessageVersionGroupResourceKey,
  isActiveStreamExistsError,
  isCurrentStreamEvent,
  isTemporaryMessageId,
  invalidateConversationMessageCache,
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
  type ChatStreamTerminalEvent,
} from './conversationStoreSupport';
import {
  armQueueForStop,
  bindWaitingChatQueueToStream,
  markChatQueueCancelError,
} from './conversationStoreQueueActions';
import { useAgentStore } from './agentStore';

type ConversationMessageActions = Pick<ConversationState,
  | 'sendMessage'
  | 'sendAgentMessage'
  | 'regenerateMessage'
  | 'regenerateWithModel'
  | 'sendMultiModelMessage'
  | 'skipCurrentMultiModelTarget'
  | 'deleteMessage'
  | 'fetchMessages'
  | 'loadOlderMessages'
  | 'loadNewerMessages'
  | 'loadMessagesAround'
  | 'searchConversations'
  | 'startStreamListening'
  | 'stopStreamListening'
  | 'cancelCurrentStream'
  | 'cancelConversationRun'
  | 'applyRemoteConversationSync'
>;

let multiModelCancelRequestedRunId: number | null = null;
let pendingMultiModelStop: { backendRunId: string; promise: Promise<void> } | null = null;

function composerAttachmentsToMessages(attachments: AttachmentInput[] = []): Attachment[] {
  return attachments.map((attachment, index) => ({
    id: `temp-att-${index}`,
    file_name: attachment.file_name,
    file_type: attachment.file_type,
    file_path: '',
    file_size: attachment.file_size,
    data: attachment.data,
  }));
}

function liveUserMessage(
  conversationId: string,
  userMessageId: string,
  content: string,
  attachments: AttachmentInput[] = [],
): Message {
  return {
    id: userMessageId,
    conversation_id: conversationId,
    role: 'user',
    content,
    provider_id: null,
    model_id: null,
    token_count: null,
    attachments: composerAttachmentsToMessages(attachments),
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: Date.now(),
    parent_message_id: null,
    version_index: 0,
    is_active: true,
    status: 'complete',
  };
}

function insertMessageBeforeChildren(
  messages: Message[],
  parentId: string,
  message: Message,
): Message[] {
  const childIndex = messages.findIndex(
    (item) => item.parent_message_id === parentId && item.role === 'assistant',
  );
  if (childIndex < 0) return [...messages, message];
  return [...messages.slice(0, childIndex), message, ...messages.slice(childIndex)];
}

function assistantPlaceholderFromTarget(
  conversationId: string,
  parentMessageId: string,
  target: MultiModelTargetSnapshot,
  messageId: string,
): Message {
  const status = target.state === 'error'
    ? 'error' as const
    : target.state === 'complete' || target.state === 'skipped'
      ? 'complete' as const
      : 'partial' as const;
  return {
    id: messageId,
    conversation_id: conversationId,
    role: 'assistant',
    content: '',
    provider_id: target.target.providerId,
    model_id: target.target.modelId,
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: Date.now(),
    parent_message_id: parentMessageId,
    version_index: target.index,
    is_active: target.index === 0,
    status,
  };
}

function stageOptimisticMultiModelTurn(
  set: ConversationStoreSet,
  conversationId: string,
  runId: number,
  content: string,
  attachments: AttachmentInput[],
  models: MultiModelTargetSnapshot['target'][],
) {
  const parentMessageId = `temp-user-mm-${runId}`;
  const userMessage = liveUserMessage(conversationId, parentMessageId, content, attachments);
  const placeholders = models.map((target, index) => assistantPlaceholderFromTarget(
    conversationId,
    parentMessageId,
    { index, target, state: 'queued' },
    `temp-assistant-mm-${runId}-${index}`,
  ));
  set((state) => ({
    messages: [...state.messages, userMessage, ...placeholders],
    streamActivityByMessageId: {
      ...state.streamActivityByMessageId,
      ...Object.fromEntries(placeholders.map((message) => [
        message.id,
        createStreamActivity(message.provider_id, message.model_id),
      ])),
    },
    streaming: true,
    streamingConversationId: conversationId,
    streamingMessageId: placeholders[0]?.id ?? null,
    activeStreamId: null,
    multiModelParentId: parentMessageId,
    pendingCompanionModels: [...models],
    multiModelDoneMessageIds: [],
    error: null,
  }));
  return { parentMessageId, placeholderIds: placeholders.map((message) => message.id) };
}

function removeOptimisticMultiModelTurn(
  set: ConversationStoreSet,
  parentMessageId: string,
  placeholderIds: string[],
) {
  set((state) => ({
    messages: state.messages.filter((message) => (
      message.id !== parentMessageId && message.parent_message_id !== parentMessageId
    )),
    streamActivityByMessageId: removeStreamActivities(
      state.streamActivityByMessageId,
      placeholderIds,
    ),
    streaming: false,
    streamingConversationId: null,
    streamingMessageId: null,
    activeStreamId: null,
    pendingCompanionModels: [],
    multiModelParentId: null,
    multiModelDoneMessageIds: [],
  }));
}

function resolveOptimisticMultiModelParent(
  set: ConversationStoreSet,
  optimisticParentId: string,
  persistedParentId: string,
  conversationId: string,
  content: string,
  attachments: AttachmentInput[],
) {
  set((state) => {
    const hasOptimisticUser = state.messages.some((message) => message.id === optimisticParentId);
    let messages = state.messages.filter((message) => (
      message.id !== persistedParentId || message.id === optimisticParentId
    ));
    if (hasOptimisticUser) {
      messages = messages.map((message) => {
        if (message.id === optimisticParentId) {
          return {
            ...liveUserMessage(conversationId, persistedParentId, content, attachments),
            created_at: message.created_at,
          };
        }
        return message.parent_message_id === optimisticParentId
          ? { ...message, parent_message_id: persistedParentId }
          : message;
      });
    } else {
      messages = insertMessageBeforeChildren(
        messages,
        persistedParentId,
        liveUserMessage(conversationId, persistedParentId, content, attachments),
      );
    }
    return { messages, multiModelParentId: persistedParentId };
  });
}

function applyMultiModelEnvelope(
  set: ConversationStoreSet,
  get: () => ConversationState,
  envelope: MultiModelRunEnvelope,
) {
  if (envelope.revision < get().multiModelRunRevision) return;
  const run = envelope.activeRun;
  for (const target of run?.targets ?? []) {
    if (target.streamId) runtime.multiModelStreamIds.add(target.streamId);
  }
  const pending = (run?.targets ?? []).map((target) => target.target);
  const done = (run?.targets ?? [])
    .map((target) => target.messageId)
    .filter((id): id is string => Boolean(id) && (
      run?.targets.find((item) => item.messageId === id)?.state === 'complete'
      || run?.targets.find((item) => item.messageId === id)?.state === 'error'
      || run?.targets.find((item) => item.messageId === id)?.state === 'skipped'
    ));
  const streamingTarget = run?.targets.find((target) =>
    target.state === 'streaming' || target.state === 'starting',
  );
  set((state) => {
    if (!run && state.streaming && state.multiModelRun == null) {
      return {
        multiModelRunRevision: Math.max(state.multiModelRunRevision, envelope.revision),
      };
    }
    let messages = state.messages;
    let activities = { ...state.streamActivityByMessageId };
    let ragDisplayByMessageId = state.ragDisplayByMessageId;
    let searchDisplayByMessageId = state.searchDisplayByMessageId;
    const parentId = run?.parentMessageId;
    const rekeyedIds = new Map<string, string>();
    if (parentId && run) {
      if (!messages.some((message) => message.id === parentId)) {
        messages = insertMessageBeforeChildren(
          messages,
          parentId,
          liveUserMessage(envelope.conversationId, parentId, ''),
        );
      }
      for (const target of run.targets) {
        if (!target.messageId) continue;
        if (messages.some((message) => message.id === target.messageId)) continue;
        const temp = messages.find((message) =>
          isTemporaryMessageId(message.id)
          && message.parent_message_id === parentId
          && message.role === 'assistant'
          && message.provider_id === target.target.providerId
          && message.model_id === target.target.modelId
        );
        if (temp) {
          rekeyedIds.set(temp.id, target.messageId);
          messages = messages.map((message) =>
            message.id === temp.id
              ? { ...message, id: target.messageId!, status: 'partial' }
              : message
          );
          if (activities[temp.id]) {
            activities = {
              ...activities,
              [target.messageId]: activities[temp.id],
            };
            delete activities[temp.id];
          } else {
            activities[target.messageId] = createStreamActivity(
              target.target.providerId,
              target.target.modelId,
            );
          }
          ragDisplayByMessageId = rekeyMessageDisplayMap(
            ragDisplayByMessageId,
            temp.id,
            target.messageId,
          );
          searchDisplayByMessageId = rekeyMessageDisplayMap(
            searchDisplayByMessageId,
            temp.id,
            target.messageId,
          );
          continue;
        }
        messages = insertModelVersionPlaceholder(
          messages,
          parentId,
          assistantPlaceholderFromTarget(
            envelope.conversationId,
            parentId,
            target,
            target.messageId,
          ),
        );
        activities[target.messageId] = createStreamActivity(
          target.target.providerId,
          target.target.modelId,
        );
      }
      const hasAssistant = messages.some(
        (message) => message.parent_message_id === parentId && message.role === 'assistant',
      );
      if (!hasAssistant && run.targets[0]) {
        const first = run.targets[0];
        const placeholderId = first.messageId ?? `temp-assistant-mm-${run.runId}`;
        messages = insertModelVersionPlaceholder(
          messages,
          parentId,
          assistantPlaceholderFromTarget(
            envelope.conversationId,
            parentId,
            first,
            placeholderId,
          ),
        );
        activities[placeholderId] = createStreamActivity(
          first.target.providerId,
          first.target.modelId,
        );
      }
    }
    const fallbackStreamingId = parentId
      ? messages.find((message) =>
        message.parent_message_id === parentId
        && message.role === 'assistant'
        && message.status === 'partial'
      )?.id ?? null
      : null;
    const streamingMessageId = streamingTarget?.messageId
      ?? (streamingTarget
        ? rekeyedIds.get(state.streamingMessageId ?? '') ?? state.streamingMessageId
        : null)
      ?? fallbackStreamingId;
    return {
      messages,
      streamActivityByMessageId: activities,
      ragDisplayByMessageId,
      searchDisplayByMessageId,
      multiModelRun: run,
      multiModelRunRevision: envelope.revision,
      pendingCompanionModels: pending,
      multiModelParentId: parentId ?? state.multiModelParentId,
      multiModelDoneMessageIds: done,
      streaming: Boolean(run),
      streamingConversationId: run ? envelope.conversationId : null,
      streamingMessageId: run ? streamingMessageId : null,
      activeStreamId: run
        ? streamingTarget?.streamId ?? state.activeStreamId ?? null
        : null,
    };
  });
  if (!run && runtime.multiModelDoneResolve) {
    const resolve = runtime.multiModelDoneResolve;
    runtime.multiModelDoneResolve = null;
    resolve();
  }
}

async function cancelConversationRunNow(
  set: ConversationStoreSet,
  get: () => ConversationState,
  input: {
    conversationId: string;
    runId?: string | null;
    skipBackend?: boolean;
  },
): Promise<void> {
  const { conversationId, skipBackend } = input;
  const initialState = get();
  const run = initialState.runsByConversation[conversationId];
  const runRuntime = getOrCreateRunRuntime(conversationId);
  runRuntime.sendGeneration += 1;
  ensureRunStopCompleted(conversationId);
  const ownsMultiModelRun = Boolean(
    runRuntime.isMultiModelActive
    || (runtime.isMultiModelActive && initialState.streamingConversationId === conversationId)
  );
  const observedStream = (
    initialState.observedStreamsByConversation[conversationId]?.streaming
      ? { conversationId, ...initialState.observedStreamsByConversation[conversationId] }
      : initialState.observedStream?.streaming && initialState.observedStream.conversationId === conversationId
        ? initialState.observedStream
        : null
  );
  const streamId = input.runId
    ?? run?.streamId
    ?? (initialState.streamingConversationId === conversationId ? initialState.activeStreamId : null)
    ?? observedStream?.streamId
    ?? null;
  const conversation = conversationId
    ? initialState.conversations.find((item) => item.id === conversationId)
      ?? initialState.archivedConversations.find((item) => item.id === conversationId)
    : null;
  const activeMultiModelRun = initialState.multiModelRun?.conversationId === conversationId
    ? initialState.multiModelRun
    : null;
  const cancellingMultiModel = ownsMultiModelRun || Boolean(activeMultiModelRun);
  if (
    conversationId
    && !cancellingMultiModel
    && conversation?.mode !== 'agent'
    && (run || initialState.streamingConversationId === conversationId || observedStream)
  ) {
    armQueueForStop(set, conversationId, streamId);
  }
  const cancellationBucket = get().chatQueueByConversation[conversationId];
  const expectedDrainingMessageId = cancellationBucket?.drainingMessageId ?? null;
  const expectedDrainingStreamId = cancellationBucket?.drainingStreamId ?? streamId;
  const agentCancel = runRuntime.agentCancel ?? (
    initialState.streamingConversationId === conversationId ? runtime.activeAgentCancel : null
  );
  if (agentCancel) {
    agentCancel();
  } else {
    runRuntime.agentStreamSeq++;
  }
  flushPendingStreamChunk(set, get);
  const buffer = getStreamBuffer(conversationId);
  materializeLiveStreamContent(set, [
    ...collectActiveStreamingMessageIds(get(), conversationId),
    run?.streamingMessageId ?? null,
    buffer?.messageId,
    buffer?.resolvedId,
  ]);
  const streamMsgId = run?.streamingMessageId
    ?? (initialState.streamingConversationId === conversationId ? initialState.streamingMessageId : null);

  if (cancellingMultiModel) {
    if (ownsMultiModelRun) multiModelCancelRequestedRunId = runtime.multiModelRunId;
    if (isTauri() && !skipBackend) {
      set((state) => ({
        multiModelRun: state.multiModelRun
          ? { ...state.multiModelRun, phase: 'stopping' }
          : state.multiModelRun,
      }));
      if (activeMultiModelRun) {
        await requestMultiModelStop(set, get, activeMultiModelRun.runId);
      }
      return;
    }
    if (ownsMultiModelRun) {
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
    }
    set({
      multiModelRun: null,
      pendingCompanionModels: [],
      multiModelParentId: null,
      multiModelDoneMessageIds: [],
    });
  }

  if (run && isLiveConversationRun(run) && run.phase !== 'stopping') {
    set((state) => ({
      ...upsertConversationRun(state, {
        ...run,
        phase: 'stopping',
        revision: run.revision + 1,
      }),
      messages: streamMsgId && state.activeConversationId === conversationId
        ? state.messages.map((message) => (
          message.id === streamMsgId ? { ...message, status: 'partial' as const } : message
        ))
        : state.messages,
    }));
  } else if (!run) {
    set((state) => ({
      messages: streamMsgId && state.activeConversationId === conversationId
        ? state.messages.map((message) => (
          message.id === streamMsgId ? { ...message, status: 'partial' as const } : message
        ))
        : state.messages,
    }));
  }

  if (conversationId && isTauri() && !skipBackend && !cancellingMultiModel) {
    try {
      await invokeCancelStream(conversationId, streamId, runRuntime);
    } catch (error) {
      const cancellationError = String(error);
      const latest = get();
      const stillSameRun = Boolean(
        latest.runsByConversation[conversationId]?.runId === (run?.runId ?? streamId)
        || latest.chatQueueByConversation[conversationId]?.drainingStreamId === expectedDrainingStreamId
      );
      if (stillSameRun && runRuntime.sendIpcPending) {
        try {
          await invokeCancelStream(conversationId, streamId, runRuntime);
        } catch (retryError) {
          markChatQueueCancelError(
            set,
            conversationId,
            String(retryError),
            expectedDrainingMessageId,
            expectedDrainingStreamId,
          );
        }
      } else if (
        stillSameRun
        && !runRuntime.sendIpcStarted
        && isNoMatchingStreamError(cancellationError)
      ) {
        // Local preparation was aborted before send IPC.
      } else if (stillSameRun) {
        markChatQueueCancelError(
          set,
          conversationId,
          cancellationError,
          expectedDrainingMessageId,
          expectedDrainingStreamId,
        );
      }
    }
    if (conversation?.mode === 'agent') {
      invoke('agent_cancel', {
        conversationId,
        streamId: streamId ?? initialState.activeStreamId,
      }).catch(() => {});
    }
  } else if (conversationId && !isTauri() && !skipBackend && !cancellingMultiModel) {
    await get().handleChatStreamTerminal({
      conversation_id: conversationId,
      message_id: streamMsgId ?? '',
      stream_id: streamId ?? '',
      outcome: 'cancelled',
      error: null,
    });
  }
}

function isNoMatchingStreamError(error: string): boolean {
  return error.includes('No active stream matched the cancellation request');
}

async function invokeCancelStream(
  conversationId: string,
  streamId: string | null,
  runRuntime: ReturnType<typeof getOrCreateRunRuntime>,
): Promise<void> {
  try {
    await invoke('cancel_stream', { conversationId, streamId });
  } catch (error) {
    const message = String(error);
    if (!isNoMatchingStreamError(message) || !runRuntime.sendIpcPending) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    await invoke('cancel_stream', { conversationId, streamId });
  }
}

function requestMultiModelStop(
  set: ConversationStoreSet,
  get: () => ConversationState,
  backendRunId: string,
): Promise<void> {
  if (pendingMultiModelStop?.backendRunId === backendRunId) {
    return pendingMultiModelStop.promise;
  }
  const promise = invoke<MultiModelRunEnvelope>('stop_multi_model_run', { runId: backendRunId })
    .then((envelope) => {
      applyMultiModelEnvelope(set, get, envelope);
      notifyConversationChanged(envelope.conversationId, snapshotStreamSyncState(get()));
    })
    .catch((error) => {
      set({ error: String(error) });
      throw error;
    })
    .finally(() => {
      if (pendingMultiModelStop?.promise === promise) pendingMultiModelStop = null;
    });
  pendingMultiModelStop = { backendRunId, promise };
  void promise.catch(() => undefined);
  return promise;
}

function findMessageIncludingVersionResources(
  state: ConversationState,
  conversationId: string,
  messageId: string,
): Message | null {
  const liveMessage = state.messages.find((message) => message.id === messageId);
  if (liveMessage) return liveMessage;
  for (const resource of Object.values(state.messageVersionGroups)) {
    if (resource.conversationId !== conversationId) continue;
    const version = resource.versions.find((message) => message.id === messageId);
    if (version) return version;
  }
  return null;
}

function removeLocalMessage(set: ConversationStoreSet, messageId: string): void {
  set((state) => ({
    messages: state.messages.filter((message) => message.id !== messageId),
  }));
}

export function createConversationMessageActions(
  set: ConversationStoreSet,
  get: () => ConversationState,
): ConversationMessageActions {
  return {
    sendMessage: async (content, attachments = [], searchProviderId = null, options) => {
      const conversationId = options?.conversationId ?? get().activeConversationId;
      if (!conversationId) throw new Error('No active conversation');
      if (get().loading && get().activeConversationId === conversationId) {
        throw new Error('Conversation messages are still loading');
      }
      const isActiveConversation = get().activeConversationId === conversationId;
      const activeConversation = get().conversations.find((conversation) => conversation.id === conversationId)
        ?? get().archivedConversations.find((conversation) => conversation.id === conversationId);
      const searchHistoryMessages = getLoadedMessagesForConversation(get(), conversationId);

      // Optimistically add user message BEFORE backend call
      const streamId = createStreamId();
      const runId = streamId;
      const optimisticUserMsg: Message = {
        id: `temp-user-${streamId}`,
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
      const tempAssistantId = `temp-assistant-${streamId}`;
      const previousStreamState = {
        streaming: get().streaming,
        streamingMessageId: get().streamingMessageId,
        streamingConversationId: get().streamingConversationId,
        activeStreamId: get().activeStreamId,
        thinkingActiveMessageIds: new Set(get().thinkingActiveMessageIds),
        run: get().runsByConversation[conversationId] ?? null,
      };
      const runRuntime = getOrCreateRunRuntime(conversationId);
      const sendGeneration = runRuntime.sendGeneration;
      const isSendAborted = () => runRuntime.sendGeneration !== sendGeneration;
      runRuntime.sendIpcStarted = false;
      if (runRuntime.isMultiModelActive || runtime.isMultiModelActive) {
        runRuntime.multiModelStreamIds.add(streamId);
        runtime.multiModelStreamIds.add(streamId);
      }
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

      const run = createConversationRun({
        conversationId,
        runId,
        streamId,
        streamingMessageId: tempAssistantId,
        mode: runRuntime.isMultiModelActive ? 'multi-model' : 'chat',
        phase: 'streaming',
        revision: (get().runWatermarksByConversation[conversationId]?.revision ?? 0) + 1,
        multiModelParentId: runRuntime.isMultiModelActive ? optimisticUserMsg.id : null,
      });
      if (isActiveConversation) {
        set((s) => ({
          messages: [...s.messages, optimisticUserMsg, placeholderAssistant],
          ragDisplayByMessageId: placeholderRagDisplay
            ? { ...s.ragDisplayByMessageId, [tempAssistantId]: placeholderRagDisplay }
            : s.ragDisplayByMessageId,
          searchDisplayByMessageId: searchDisplayTag
            ? { ...s.searchDisplayByMessageId, [tempAssistantId]: searchDisplayTag }
            : s.searchDisplayByMessageId,
          streamActivityByMessageId: {
            ...s.streamActivityByMessageId,
            [tempAssistantId]: createStreamActivity(
              activeConversation?.provider_id,
              activeConversation?.model_id,
            ),
          },
          thinkingActiveMessageIds: new Set<string>(),
          ...upsertConversationRun(s, run),
        }));
      } else {
        appendCachedConversationMessages(conversationId, [optimisticUserMsg, placeholderAssistant]);
        set((s) => upsertConversationRun(s, run));
      }
      if (!runRuntime.isMultiModelActive) {
        bindWaitingChatQueueToStream(set, conversationId, streamId);
      }
      resetPendingStreamUi();

      try {
        await get().startStreamListening();
        if (isSendAborted()) {
          throw new Error('send-aborted-before-ipc');
        }

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
            if (get().activeConversationId !== conversationId) return;
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
          setStreamPrefix(conversationId, searchResultTag);
          runtime.streamPrefix = searchResultTag;
          updateSearchDisplay(searchResultTag);
        } else if (hasAnyRag) {
          // RAG display is tracked separately from assistant text to avoid stream
          // content/id updates temporarily removing the retrieval card.
          setStreamPrefix(conversationId, '');
          runtime.streamPrefix = '';
        }

        const mcpIds = getEffectiveMcpServerIds(get, {
          conversationId,
          mcpIds: capabilityIds.enabledMcpServerIds,
        });
        const thinkingBudget = getEffectiveThinkingBudget(get, conversationId);
        const thinkingLevel = getEffectiveThinkingLevel(get, conversationId);
        if (isSendAborted()) {
          throw new Error('send-aborted-before-ipc');
        }
        runRuntime.sendIpcPending = true;
        runRuntime.sendIpcStarted = true;
        let userMessage: Message;
        try {
          userMessage = await invoke<Message>('send_message', {
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
            historyMode: runRuntime.isMultiModelActive
              ? runRuntime.multiModelHistoryMode
              : get().multiModelContinuationMode,
          });
        } finally {
          runRuntime.sendIpcPending = false;
        }

        // Replace optimistic user msg with real one, update placeholder parent
        if (get().activeConversationId === conversationId) {
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
        }

        // In browser mode, simulate brief loading then fetch the mock AI response
        notifyConversationChanged(conversationId, snapshotStreamSyncState(get(), conversationId));
        if (!isTauri()) {
          await new Promise((r) => setTimeout(r, 600));
          set((s) => clearConversationRun(s, conversationId, runId));
          const queueBucket = get().chatQueueByConversation[conversationId];
          if (
            queueBucket
            && (
              queueBucket.phase === 'waiting'
              || queueBucket.drainingStreamId === streamId
            )
            && !runtime.isMultiModelActive
          ) {
            await get().handleChatStreamTerminal({
              conversation_id: conversationId,
              message_id: tempAssistantId,
              stream_id: streamId,
              outcome: 'complete',
              error: null,
            });
          } else {
            void get().fetchMessages(conversationId);
          }
        }
        return userMessage;
      } catch (e) {
        const errMsg = String(e);
        const aborted = isSendAborted() || errMsg.includes('send-aborted-before-ipc');
        const currentRun = get().runsByConversation[conversationId];
        const stoppingThisRun = aborted
          && currentRun?.phase === 'stopping'
          && currentRun.runId === runId;
        if (stoppingThisRun && !errMsg.includes('send-aborted-before-ipc')) {
          return null;
        }
        if (!aborted) {
          console.error('[sendMessage] error:', e);
        }
        const staleBackendStream = isActiveStreamExistsError(errMsg);
        const restorePrevious = Boolean(
          previousStreamState.streaming
          && previousStreamState.streamingConversationId === conversationId
          && previousStreamState.run?.runId !== runId
        );
        set((s) => {
          const cleared = { ...s, ...clearConversationRun(s, conversationId, runId) };
          return {
            ...cleared,
            ...(restorePrevious ? {
              streaming: true,
              streamingMessageId: previousStreamState.streamingMessageId,
              streamingConversationId: conversationId,
              activeStreamId: previousStreamState.activeStreamId,
              thinkingActiveMessageIds: previousStreamState.thinkingActiveMessageIds,
              runsByConversation: previousStreamState.run
                ? { ...cleared.runsByConversation, [conversationId]: previousStreamState.run }
                : cleared.runsByConversation,
            } : {}),
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
            messages: s.activeConversationId === conversationId
              ? s.messages.filter((m) => (
                m.id !== optimisticUserMsg.id && m.id !== tempAssistantId
              ))
              : s.messages,
            error: aborted ? null : errMsg,
          };
        });
        if (aborted) {
          markRunStopCompleted(conversationId);
        }
        if (staleBackendStream) {
          resetPendingStreamUi(conversationId);
          setStreamBuffer(conversationId, null);
          setStreamPrefix(conversationId, '');
          if (isTauri()) {
            invoke('cancel_stream', {
              conversationId,
              streamId: null,
            }).catch(() => {});
          }
          if (get().activeConversationId === conversationId) {
            void get().fetchMessages(conversationId);
          } else {
            runtime.pendingConversationRefresh.add(conversationId);
          }
        }
        runtime.multiModelStreamIds.delete(streamId);
        runRuntime.multiModelStreamIds.delete(streamId);
        return null;
      }
    },
    sendAgentMessage: async (content, attachments = [], options) => {
      const conversationId = options?.conversationId ?? get().activeConversationId;
      if (!conversationId) throw new Error('No active conversation');
      if (get().loading && get().activeConversationId === conversationId) {
        throw new Error('Conversation messages are still loading');
      }

      const runRuntime = getOrCreateRunRuntime(conversationId);
      runRuntime.agentCancel?.();
      runRuntime.agentCancel = null;
      const agentRunSeq = ++runRuntime.agentStreamSeq;
      const isCurrentAgentRun = () => agentRunSeq === runRuntime.agentStreamSeq;
      runtime.agentStreamSeq = agentRunSeq;
      runtime.activeAgentCancel = () => runRuntime.agentCancel?.();

      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (!conversation) throw new Error('Conversation not found');

      const providerId = conversation.provider_id;
      const modelId = conversation.model_id;
      const capabilityIds = sanitizeActiveConversationCapabilityIds(set, get, conversationId);
      const mcpIds = getEffectiveMcpServerIds(get, {
        providerId,
        modelId,
        mcpIds: capabilityIds.enabledMcpServerIds,
      });

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

      const runId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `agent-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const streamId = runId;
      optimisticUserMsg.id = `temp-user-${runId}`;
      currentMsgId = `temp-agent-${runId}`;
      placeholderAssistant.id = currentMsgId;
      placeholderAssistant.parent_message_id = optimisticUserMsg.id;
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
        set((s) => ({
          messages: [...s.messages, optimisticUserMsg, placeholderAssistant],
          streamActivityByMessageId: {
            ...s.streamActivityByMessageId,
            [currentMsgId]: createStreamActivity(
              conversation?.provider_id,
              conversation?.model_id,
            ),
          },
          ...upsertConversationRun(s, agentRun),
        }));
      } else {
        appendCachedConversationMessages(conversationId, [optimisticUserMsg, placeholderAssistant]);
        set((s) => upsertConversationRun(s, agentRun));
      }

      // Set up event listeners BEFORE invoking to avoid race conditions
      let unlistenDone: UnlistenFn | null = null;
      let unlistenError: UnlistenFn | null = null;
      let unlistenStreamText: UnlistenFn | null = null;
      let unlistenStreamThinking: UnlistenFn | null = null;
      let unlistenMessageId: UnlistenFn | null = null;
      let cancelActiveRun: (() => void) | null = null;
      let cleanedUp = false;

      // ── Agent stream buffering (same pattern as Q&A pending stream UI) ──
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

      useAgentStore.getState().setActiveRun(conversationId, runId);
      const matchesRun = (eventRunId?: string) => !eventRunId || eventRunId === runId;

      try {
        let resolveEvent: () => void = () => {};
        let rejectEvent: (error: Error) => void = () => {};
        const eventPromise = new Promise<void>((resolve, reject) => {
          resolveEvent = resolve;
          rejectEvent = reject;
        });
        cancelActiveRun = () => {
          if (isCurrentAgentRun()) {
            runtime.agentStreamSeq++;
          }
          cleanup();
          resolveEvent();
        };
        runtime.activeAgentCancel = cancelActiveRun;

        const [
          messageIdUnlisten,
          streamTextUnlisten,
          streamThinkingUnlisten,
          doneUnlisten,
          errorUnlisten,
        ] = await Promise.all([
          listen<{ conversationId: string; assistantMessageId: string; runId?: string }>('agent-message-id', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            flushAgentStreamChunks();
            const realId = event.payload.assistantMessageId;
            const oldId = currentMsgId;
            currentMsgId = realId;
            set((s) => {
              const ragDisplayByMessageId = { ...s.ragDisplayByMessageId };
              if (Object.prototype.hasOwnProperty.call(ragDisplayByMessageId, oldId)) {
                ragDisplayByMessageId[realId] = ragDisplayByMessageId[oldId];
                delete ragDisplayByMessageId[oldId];
              }
              return {
                streamingMessageId: realId,
                ragDisplayByMessageId,
                messages: s.messages.map((m) =>
                  m.id === oldId ? { ...m, id: realId } : m
                ),
              };
            });
          }),
          listen<AgentStreamTextEvent>('agent-stream-text', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            _agentPendingText += event.payload.text;
            scheduleAgentFlush();
          }),
          listen<AgentStreamThinkingEvent>('agent-stream-thinking', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            _agentPendingThinking += event.payload.thinking;
            scheduleAgentFlush();
          }),
          listen<AgentDoneEvent>('agent-done', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            clearAgentStreamBuffer();
            const isActiveConversation = get().activeConversationId === conversationId;
            const isStillStreaming = get().streaming && get().streamingMessageId === currentMsgId;
            if (!isStillStreaming) {
              if (!isActiveConversation) {
                runtime.pendingConversationRefresh.add(conversationId);
              }
              cleanup();
              resolveEvent();
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
              get().fetchMessages(conversationId);
            } else {
              runtime.pendingConversationRefresh.add(conversationId);
            }
            resolveEvent();
          }),
          listen<AgentErrorEvent>('agent-error', (event) => {
            if (event.payload.conversationId !== conversationId || !isCurrentAgentRun() || !matchesRun(event.payload.runId)) return;
            clearAgentStreamBuffer();
            const isStillStreaming = get().streaming && get().streamingMessageId === currentMsgId;
            if (!isStillStreaming) {
              cleanup();
              resolveEvent();
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
            rejectEvent(new Error(event.payload.message));
          }),
        ]);

        keepAgentUnlisten((fn) => { unlistenMessageId = fn; })(messageIdUnlisten);
        keepAgentUnlisten((fn) => { unlistenStreamText = fn; })(streamTextUnlisten);
        keepAgentUnlisten((fn) => { unlistenStreamThinking = fn; })(streamThinkingUnlisten);
        keepAgentUnlisten((fn) => { unlistenDone = fn; })(doneUnlisten);
        keepAgentUnlisten((fn) => { unlistenError = fn; })(errorUnlisten);

        if (cleanedUp || !isCurrentAgentRun()) {
          return;
        }

        await get().startStreamListening();
        await invoke('agent_query', {
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

        void eventPromise.catch((error) => {
          console.error('[sendAgentMessage] stream error:', error);
        });
      } catch (e) {
        cleanup();
        const errMsg = String(e);
        console.error('[sendAgentMessage] error:', errMsg);
        useAgentStore.getState().clearStatus(conversationId, runId);

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
      if (!runtime.isMultiModelActive) {
        bindWaitingChatQueueToStream(set, conversationId, streamId);
      }
      resetPendingStreamUi();

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
            : get().multiModelContinuationMode,
        });
        notifyConversationChanged(conversationId, snapshotStreamSyncState(get()));

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
        if (!runtime.isMultiModelActive) {
          await get().handleChatStreamTerminal({
            conversation_id: conversationId,
            message_id: tempAssistantId,
            stream_id: streamId,
            outcome: 'error',
            error: errMsg,
          });
        }
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
      if (!appendAsCompanion && !runtime.isMultiModelActive) {
        bindWaitingChatQueueToStream(set, conversationId, streamId);
      }
      resetPendingStreamUi();

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
            : get().multiModelContinuationMode,
        });
        notifyConversationChanged(conversationId, snapshotStreamSyncState(get()));

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
        if (!appendAsCompanion && !runtime.isMultiModelActive) {
          await get().handleChatStreamTerminal({
            conversation_id: conversationId,
            message_id: tempAssistantId,
            stream_id: streamId,
            outcome: 'error',
            error: errMsg,
          });
        }
      }
      return placeholderAssistant;
    },
    sendMultiModelMessage: async ({
      content,
      targetModels,
      historyMode,
      attachments = [],
      searchProviderId = null,
      onAccepted,
    }) => {
      if (pendingMultiModelStop) await pendingMultiModelStop.promise;
      const conversationId = get().activeConversationId;
      const models = (targetModels && targetModels.length > 0) ? targetModels : get().multiModelTargets;
      if (!conversationId || models.length === 0) return;
      if (get().loading) throw new Error('Conversation messages are still loading');
      const resolvedHistoryMode = normalizeMultiModelContinuationMode(
        historyMode ?? get().multiModelContinuationMode,
      );
      const runId = ++runtime.multiModelRunId;
      multiModelCancelRequestedRunId = null;

      runtime.isMultiModelActive = true;
      runtime.multiModelTotalRemaining = models.length;
      runtime.multiModelFirstTarget = { ...models[0] };
      runtime.multiModelHistoryMode = resolvedHistoryMode;
      resetPendingStreamUi();
      const optimisticTurn = stageOptimisticMultiModelTurn(
        set,
        conversationId,
        runId,
        content,
        attachments,
        models,
      );

      const capabilityIds = sanitizeActiveConversationCapabilityIds(set, get, conversationId);
      const kbIds = capabilityIds.enabledKnowledgeBaseIds;
      const memIds = capabilityIds.enabledMemoryNamespaceIds;
      const mcpIds = getEffectiveMcpServerIds(get, { conversationId, mcpIds: capabilityIds.enabledMcpServerIds });
      await get().startStreamListening();

      let finalContent = content;
      if (searchProviderId) {
        const searchHistoryMessages = get().messages;
        let searchQuery = buildContextualSearchQuery(searchHistoryMessages, content);
        try {
          const generatedQuery = await invoke<string>('generate_search_query', {
            conversationId,
            content,
          });
          if (generatedQuery.trim()) searchQuery = generatedQuery.trim();
        } catch {
          // keep fallback query
        }
        const searchResult = await useSearchStore.getState().executeSearch(searchProviderId, searchQuery);
        finalContent = formatSearchContent(
          searchResult?.ok ? searchResult.results : [],
          content,
          searchResult?.ok
            ? { query: searchQuery, queryStatus: 'done', status: 'done' }
            : { query: searchQuery, queryStatus: 'error', status: 'error', error: searchResult?.error || '搜索失败' },
        );
      }

      let envelope: MultiModelRunEnvelope;
      try {
        envelope = await invoke<MultiModelRunEnvelope>('start_multi_model_run', {
          conversationId,
          content: finalContent,
          attachments,
          searchProviderId,
          enabledMcpServerIds: mcpIds.length > 0 ? mcpIds : undefined,
          thinkingBudget: get().thinkingLevel !== null
            ? undefined
            : (get().thinkingBudget ?? undefined),
          thinkingLevel: get().thinkingLevel ?? undefined,
          enabledKnowledgeBaseIds: kbIds.length > 0 ? kbIds : undefined,
          enabledMemoryNamespaceIds: memIds.length > 0 ? memIds : undefined,
          targets: models,
          historyMode: resolvedHistoryMode,
        });
      } catch (error) {
        if (runtime.multiModelRunId === runId) {
          runtime.isMultiModelActive = false;
          runtime.multiModelTotalRemaining = 0;
          runtime.multiModelFirstTarget = null;
          runtime.multiModelFirstMessageId = null;
          runtime.multiModelHistoryMode = 'selected';
          runtime.userManuallySelectedVersion = false;
          runtime.multiModelStreamIds.clear();
          removeOptimisticMultiModelTurn(
            set,
            optimisticTurn.parentMessageId,
            optimisticTurn.placeholderIds,
          );
          if (multiModelCancelRequestedRunId === runId) multiModelCancelRequestedRunId = null;
        }
        throw error;
      }
      const parentMessageId = envelope.activeRun?.parentMessageId;
      if (parentMessageId) {
        resolveOptimisticMultiModelParent(
          set,
          optimisticTurn.parentMessageId,
          parentMessageId,
          conversationId,
          finalContent,
          attachments,
        );
      }
      applyMultiModelEnvelope(set, get, envelope);
      const sentUserMessage = parentMessageId
        ? { id: parentMessageId }
        : [...get().messages].reverse().find((message) => message.role === 'user');

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
      notifyConversationChanged(conversationId, snapshotStreamSyncState(get()));
      onAccepted?.();

      const allDone = new Promise<void>((resolve) => {
        if (!envelope.activeRun) {
          resolve();
          return;
        }
        runtime.multiModelDoneResolve = resolve;
      });
      if (multiModelCancelRequestedRunId === runId && envelope.activeRun) {
        await requestMultiModelStop(set, get, envelope.activeRun.runId);
      }
      await allDone;

      const clearFinalizedRunState = () => set((s) => s.multiModelParentId === lastUserMsg.id
        ? { multiModelParentId: null, multiModelDoneMessageIds: [] }
        : {});
      if (runtime.multiModelRunId !== runId) {
        clearFinalizedRunState();
        return;
      }

      // All done — cleanup
      const firstMessageId = runtime.multiModelFirstMessageId;
      const userManuallySelectedVersion = runtime.userManuallySelectedVersion;
      const wasCancelled = multiModelCancelRequestedRunId === runId;
      runtime.isMultiModelActive = false;
      runtime.multiModelFirstTarget = null;
      runtime.multiModelFirstMessageId = null;
      runtime.multiModelHistoryMode = 'selected';
      runtime.userManuallySelectedVersion = false;
      runtime.multiModelStreamIds.clear();
      if (multiModelCancelRequestedRunId === runId) multiModelCancelRequestedRunId = null;
      set({ pendingCompanionModels: [], multiModelDoneMessageIds: [] });
      if (wasCancelled) {
        set((state) => ({
          messages: state.messages.filter((message) => !(
            message.parent_message_id === lastUserMsg.id
            && message.role === 'assistant'
            && isTemporaryMessageId(message.id)
            && message.content.length === 0
          )),
        }));
        clearFinalizedRunState();
        return;
      }
      const abortSupersededFinalization = () => {
        if (runtime.multiModelRunId === runId && !get().streaming) return false;
        clearFinalizedRunState();
        return true;
      };

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

        try {
          await get().ensureMessageVersionGroupsLoaded(
            conversationId,
            [parentId],
            { force: true },
          );
        } catch (error) {
          clearFinalizedRunState();
          throw error;
        }
        if (abortSupersededFinalization()) return;
        const versions = get().messageVersionGroups[
          getMessageVersionGroupResourceKey(conversationId, parentId)
        ]?.versions ?? [];
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

        get().applyMessageVersionSnapshot(conversationId, parentId, versions, activeVersionId);
      }

      clearFinalizedRunState();
    },
    skipCurrentMultiModelTarget: async () => {
      const run = get().multiModelRun;
      if (!run || run.mode !== 'sequential') return;
      const envelope = await invoke<MultiModelRunEnvelope>('skip_multi_model_target', {
        runId: run.runId,
      });
      applyMultiModelEnvelope(set, get, envelope);
    },
    deleteMessage: async (messageId) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      if (get().loading) throw new Error('Conversation messages are still loading');

      const targetMessage = findMessageIncludingVersionResources(get(), conversationId, messageId);
      const parentMessageId = targetMessage?.role === 'assistant'
        ? targetMessage.parent_message_id
        : null;
      const resource = parentMessageId
        ? get().messageVersionGroups[
          getMessageVersionGroupResourceKey(conversationId, parentMessageId)
        ]
        : undefined;
      const authoritativeVersions = resource?.meta.loadedAt != null
        ? resource.versions
        : null;

      // Client-only messages (temp IDs) — just remove locally
      if (messageId.startsWith('temp-')) {
        removeLocalMessage(set, messageId);
        if (parentMessageId && authoritativeVersions) {
          get().applyMessageVersionSnapshot(
            conversationId,
            parentMessageId,
            authoritativeVersions.filter((version) => version.id !== messageId),
          );
        }
        return;
      }

      if (parentMessageId) {
        get().invalidateMessageVersionGroups(conversationId, [parentMessageId]);
      }
      try {
        await invoke('delete_message', { id: messageId });
      } catch (e) {
        set({ error: String(e) });
        throw e;
      }

      invalidateConversationMessageCache(conversationId);
      removeLocalMessage(set, messageId);
      notifyConversationChanged(conversationId, snapshotStreamSyncState(get()));
      if (!parentMessageId) return;

      if (authoritativeVersions) {
        get().applyMessageVersionSnapshot(
          conversationId,
          parentMessageId,
          authoritativeVersions.filter((version) => version.id !== messageId),
        );
      }
      await get().ensureMessageVersionGroupsLoaded(
        conversationId,
        [parentMessageId],
        { force: true },
      );
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
        const versionParentIds = new Set(
          page.messages
            .filter((message) => message.role === 'assistant' && message.parent_message_id)
            .map((message) => message.parent_message_id as string),
        );
        for (const resource of Object.values(get().messageVersionGroups ?? {})) {
          if (resource.conversationId === conversationId) {
            versionParentIds.add(resource.parentMessageId);
          }
        }
        get().invalidateMessageVersionGroups(conversationId, Array.from(versionParentIds));
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
      if (runtime.unlisten) {
        if (isTauri()) {
          try {
          void invoke<import('./conversationRunRegistry').ConversationRunSnapshot[]>(
            'list_active_conversation_runs',
          ).then((snapshots) => {
            for (const snapshot of snapshots) {
              set((state) => upsertConversationRun(state, {
                conversationId: snapshot.conversationId,
                runId: snapshot.runId,
                streamId: snapshot.streamId,
                streamingMessageId: snapshot.messageId,
                phase: snapshot.phase,
                mode: snapshot.mode,
                revision: snapshot.revision,
                multiModelParentId: state.runsByConversation[snapshot.conversationId]?.multiModelParentId ?? null,
                pendingCompanionModels: state.runsByConversation[snapshot.conversationId]?.pendingCompanionModels ?? [],
                multiModelDoneMessageIds: state.runsByConversation[snapshot.conversationId]?.multiModelDoneMessageIds ?? [],
              }));
              if (snapshot.content) {
                setStreamBuffer(snapshot.conversationId, {
                  messageId: snapshot.messageId ?? `run-${snapshot.runId}`,
                  conversationId: snapshot.conversationId,
                  content: snapshot.content,
                  resolvedId: snapshot.messageId,
                  thinking: snapshot.thinking,
                });
              }
            }
          }).catch(() => {});
          } catch {
            // Snapshot probe must never block sending or stream listeners.
          }
        }
        return;
      }
      if (runtime.listenPromise) return runtime.listenPromise;

      const gen = runtime.listenerGen;
      runtime.listenPromise = (async () => {
      const runUnsub = await listen<MultiModelRunEnvelope>('multi-model-run-updated', (event) => {
        if (runtime.listenerGen !== gen) return;
        applyMultiModelEnvelope(set, get, event.payload);
      });
      if (isTauri()) {
        const conversationId = get().activeConversationId;
        if (conversationId) {
          try {
            void invoke<MultiModelRunEnvelope>('get_multi_model_run_snapshot', { conversationId })
              .then((envelope) => {
                if (runtime.listenerGen !== gen) return;
                applyMultiModelEnvelope(set, get, envelope);
              })
              .catch(() => {});
          } catch {
            // Snapshot probe must never block sending or stream listeners.
          }
        }
      }
      const chunkUnsub = await listen<ChatStreamEvent>('chat-stream-chunk', (event) => {
        if (runtime.listenerGen !== gen) return; // stale listener
        const { conversation_id, message_id, stream_id, chunk, model_id: evt_model_id, provider_id: evt_provider_id } = event.payload;
        const isActiveConversation = get().activeConversationId === conversation_id;
        const queueOwnsStream = get()
          .chatQueueByConversation[conversation_id]?.drainingStreamId === stream_id;
        const ownsStream = isCurrentStreamEvent(get, stream_id, conversation_id);
        if (!ownsStream && !isActiveConversation) return;
        if (!ownsStream) {
          if (get().streaming) return;
          if (chunk.content) {
            appendStreamChunk(set, get, message_id, chunk.content, conversation_id, evt_model_id, evt_provider_id);
          }
          if (chunk.done && chunk.is_final !== false && !queueOwnsStream) {
            const preserveMessageIds = [...collectActiveStreamingMessageIds(get(), conversation_id)];
            window.setTimeout(() => {
              void get().fetchMessages(conversation_id, preserveMessageIds, { setLoading: false });
            }, 80);
          }
          return;
        }

        if (chunk.done) {
          if (chunk.is_final === false) {
            // Append any remaining content in the done chunk (e.g. closing </think> tag)
            if (chunk.content) {
              appendStreamChunk(set, get, message_id, chunk.content, conversation_id, evt_model_id, evt_provider_id);
            }
            flushPendingStreamChunk(set, get, message_id);
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
            flushPendingStreamChunk(set, get, message_id);
            materializeLiveStreamContent(set, [message_id, get().streamingMessageId]);
            setStreamBuffer(conversation_id, null);

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

            if ((getRunRuntime(conversation_id)?.multiModelTotalRemaining ?? runtime.multiModelTotalRemaining) <= 0) {
              // All models done
              set((s) => ({
                ...clearConversationRun(s, conversation_id, stream_id ?? undefined),
                thinkingActiveMessageIds: s.activeConversationId === conversation_id
                  ? new Set<string>()
                  : s.thinkingActiveMessageIds,
              }));
              notifyConversationChanged(conversation_id, snapshotStreamSyncState(get(), conversation_id));
              if (runtime.multiModelDoneResolve) {
                const resolve = runtime.multiModelDoneResolve;
                runtime.multiModelDoneResolve = null;
                resolve();
              }
            }
            return;
          }

          const placeholderMessageId = get().runsByConversation[conversation_id]?.streamingMessageId
            ?? (get().streamingConversationId === conversation_id ? get().streamingMessageId : null);
          flushPendingStreamChunk(set, get, message_id);
          materializeLiveStreamContent(set, [placeholderMessageId, get().streamingMessageId, message_id]);
          const flushedMessageId = placeholderMessageId ?? message_id;
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
              ...clearConversationRun(s, conversation_id, stream_id ?? undefined),
              streamActivityByMessageId: removeStreamActivities(
                s.streamActivityByMessageId,
                [placeholderMessageId, flushedMessageId, message_id],
              ),
              thinkingActiveMessageIds: s.activeConversationId === conversation_id
                ? new Set<string>()
                : s.thinkingActiveMessageIds,
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
              messages: s.activeConversationId !== conversation_id ? s.messages : s.messages.flatMap((m) => {
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
            setStreamBuffer(conversation_id, null);
            // Queue streams refresh from the authoritative terminal event before
            // draining. A second delayed refresh can overwrite the next optimistic round.
            if (!queueOwnsStream) {
              window.setTimeout(() => {
                void get().fetchMessages(
                  conversation_id,
                  preserveMessageIds,
                );
              }, 120);
            }
            notifyConversationChanged(conversation_id, {
              ...snapshotStreamSyncState(get(), conversation_id),
              streamId: stream_id ?? null,
            });
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
        const {
          conversation_id,
          message_id,
          stream_id,
          error: errMsg,
          model_id: evt_model_id,
          provider_id: evt_provider_id,
        } = event.payload;
        const isActiveConversation = get().activeConversationId === conversation_id;
        const ownsStream = isCurrentStreamEvent(get, stream_id, conversation_id);
        if (!ownsStream && !isActiveConversation) return;
        if (!ownsStream) {
          if (get().streaming) return;
          set((s) => ({
            messages: s.messages.map((message) =>
              message.id === message_id
                ? { ...message, content: appendStreamErrorToContent(message.content, errMsg), status: 'error' as const }
                : message
            ),
          }));
          return;
        }

        flushPendingStreamChunk(set, get, message_id);
        materializeLiveStreamContent(set, [message_id, get().streamingMessageId]);
        setStreamBuffer(conversation_id, null); // Clear buffer on error

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

      const terminalUnsub = await listen<ChatStreamTerminalEvent>('chat-stream-terminal', (event) => {
        if (runtime.listenerGen !== gen) return;
        if (
          runtime.isMultiModelActive
          || runtime.multiModelStreamIds.has(event.payload.stream_id)
        ) {
          return;
        }
        void get().handleChatStreamTerminal(event.payload);
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
        const { conversation_id, message_id, stream_id, sources, errors, empty_results, emptyResults, diagnostics } = event.payload;
        if (!isCurrentStreamEvent(get, stream_id, conversation_id)) return;
        const displayTag = buildRagDisplayTagFromSources(
          sources,
          errors,
          empty_results ?? emptyResults ?? [],
          diagnostics ?? [],
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

      const syncUnsub = await listenConversationSync((payload) => {
        if (runtime.listenerGen !== gen) return;
        void get().applyRemoteConversationSync(payload);
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
        runUnsub();
        chunkUnsub();
        errorUnsub();
        terminalUnsub();
        titleUnsub();
        titleGenUnsub();
        ragUnsub();
        compressionUnsub();
        syncUnsub();
        return;
      }

      runtime.unlisten = () => {
        runUnsub();
        chunkUnsub();
        errorUnsub();
        terminalUnsub();
        titleUnsub();
        titleGenUnsub();
        ragUnsub();
        compressionUnsub();
        syncUnsub();
      };
      })();
      try {
        await runtime.listenPromise;
      } finally {
        runtime.listenPromise = null;
      }
    },
    stopStreamListening: () => {
      runtime.listenerGen++;
      runtime.listenPromise = null;
      if (runtime.unlisten) {
        runtime.unlisten();
        runtime.unlisten = null;
      }
    },
    applyRemoteConversationSync: async (payload) => {
      if (payload.originWindow === getCurrentWindowLabel()) return;
      if (!payload.conversationId) return;
      if (payload.multiModelTargets) {
        const nextTargets = [...payload.multiModelTargets];
        set((state) => ({
          multiModelTargets: state.activeConversationId === payload.conversationId
            ? nextTargets
            : state.multiModelTargets,
          conversations: state.conversations.map((conversation) => (
            conversation.id === payload.conversationId
              ? { ...conversation, multi_model_targets: nextTargets }
              : conversation
          )),
          archivedConversations: state.archivedConversations.map((conversation) => (
            conversation.id === payload.conversationId
              ? { ...conversation, multi_model_targets: nextTargets }
              : conversation
          )),
        }));
      }
      const remoteStream = payload.stream;
      if (remoteStream) {
        set((state) => upsertObservedStream(state, payload.conversationId, remoteStream.streaming ? remoteStream : null));
        if (remoteStream.streaming && remoteStream.streamId) {
          bindWaitingChatQueueToStream(
            set,
            payload.conversationId,
            remoteStream.streamId,
          );
        }
      }
      if (payload.kind === 'conversation-meta' && !remoteStream) return;
      invalidateConversationMessageCache(payload.conversationId);
      if (get().activeConversationId !== payload.conversationId) {
        runtime.pendingConversationRefresh.add(payload.conversationId);
        return;
      }
      if (get().streaming && get().streamingConversationId === payload.conversationId) {
        runtime.pendingConversationRefresh.add(payload.conversationId);
        return;
      }
      const preserveMessageIds = [...collectActiveStreamingMessageIds(get(), payload.conversationId)];
      await get().fetchMessages(payload.conversationId, preserveMessageIds, { setLoading: false });
    },
    cancelCurrentStream: async (options) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      await get().cancelConversationRun({
        conversationId,
        skipBackend: options?.skipBackend,
      });
    },
    cancelConversationRun: async ({ conversationId, runId, skipBackend }) => {
      const runRuntime = getOrCreateRunRuntime(conversationId);
      if (runRuntime.inFlightStop) {
        await runRuntime.inFlightStop;
        return;
      }
      const stopPromise = cancelConversationRunNow(set, get, {
        conversationId,
        runId,
        skipBackend,
      });
      runRuntime.inFlightStop = stopPromise;
      try {
        await stopPromise;
      } finally {
        if (runRuntime.inFlightStop === stopPromise) {
          runRuntime.inFlightStop = null;
        }
      }
    },
  };
}
