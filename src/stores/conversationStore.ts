import { create } from 'zustand';
import { createConversationManagementActions } from './conversationStoreManagementActions';
import { createConversationMessageActions } from './conversationStoreMessageActions';
import {
  createConversationQueueActions,
  createEmptyChatQueueBucket,
} from './conversationStoreQueueActions';
import type {
  ChatQueueBucket,
  ConversationState,
} from './conversationStoreSupport';

export type {
  ChatQueueBucket,
  ChatQueuePauseReason,
  ChatQueuePhase,
  ChatStreamTerminalEvent,
  QueuedChatMessage,
  QueuedChatMessageStatus,
  SubmitChatMessageRejectedReason,
  SubmitChatMessageResult,
} from './conversationStoreSupport';

export {
  MAX_LOADED_MESSAGES,
  MESSAGE_PAGE_SIZE,
  clearLiveStreamContent,
  getLiveStreamContent,
  hasAuthoritativeMessageVersionSnapshot,
  invalidateConversationMessageCache,
  isConversationStreaming,
  isObservedStreamingFor,
  selectLiveStreamingConversationIds,
  selectLiveStreamingConversationKey,
  selectUiMultiModelDoneMessageIds,
  selectUiMultiModelParentId,
  selectUiPendingCompanionModels,
  selectUiRunPhase,
  selectUiStreaming,
  selectUiStreamingConversationId,
  selectUiStreamingMessageId,
  setLiveStreamContent,
  snapshotStreamSyncState,
  subscribeLiveStreamContent,
} from './conversationStoreSupport';

const EMPTY_CHAT_QUEUE_BUCKET: ChatQueueBucket = createEmptyChatQueueBucket();

export function selectActiveChatQueue(state: ConversationState): ChatQueueBucket {
  const conversationId = state.activeConversationId;
  return conversationId
    ? state.chatQueueByConversation[conversationId] ?? EMPTY_CHAT_QUEUE_BUCKET
    : EMPTY_CHAT_QUEUE_BUCKET;
}

export function selectChatQueueForConversation(conversationId: string | null) {
  return (state: ConversationState): ChatQueueBucket => conversationId
    ? state.chatQueueByConversation[conversationId] ?? EMPTY_CHAT_QUEUE_BUCKET
    : EMPTY_CHAT_QUEUE_BUCKET;
}

export function selectQueuedChatMessagesForConversation(conversationId: string | null) {
  return (state: ConversationState) => selectChatQueueForConversation(conversationId)(state).messages;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  conversationsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  messageVersionGroups: {},
  activeConversationId: null,
  messages: [],
  ragDisplayByMessageId: {},
  searchDisplayByMessageId: {},
  loading: false,
  loadingOlder: false,
  loadingNewer: false,
  hasOlderMessages: false,
  hasNewerMessages: false,
  totalActiveCount: 0,
  oldestLoadedMessageId: null,
  newestLoadedMessageId: null,
  streaming: false,
  observedStream: null,
  observedStreamsByConversation: {},
  runsByConversation: {},
  runWatermarksByConversation: {},
  compressingConversationId: null,
  openCompressionSummaryToken: 0,
  streamingMessageId: null,
  streamingConversationId: null,
  activeStreamId: null,
  streamActivityByMessageId: {},
  thinkingActiveMessageIds: new Set<string>(),
  error: null,
  chatQueueByConversation: {},
  titleGeneratingConversationId: null,
  pendingCompanionModels: [],
  multiModelParentId: null,
  multiModelDoneMessageIds: [],
  multiModelRun: null,
  multiModelRunRevision: 0,
  pendingPromptText: null,
  setPendingPromptText: (text) => set({ pendingPromptText: text }),
  searchEnabled: false,
  searchProviderId: null,
  enabledMcpServerIds: [],
  thinkingBudget: null,
  thinkingLevel: null,
  enabledKnowledgeBaseIds: [],
  enabledMemoryNamespaceIds: [],
  multiModelTargets: [],
  multiModelContinuationMode: 'selected',
  archivedConversations: [],
  workspaceSnapshot: null,
  ...createConversationManagementActions(set, get),
  ...createConversationMessageActions(set, get),
  ...createConversationQueueActions(set, get),
}));
