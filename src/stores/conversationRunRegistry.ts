import type { ConversationStreamSyncState } from '@/lib/conversationSync';
import type { MultiModelTarget, PermissionRequestEvent, AskUserEvent } from '@/types';

export type ConversationRunMode = 'chat' | 'agent' | 'multi-model';
export type ConversationRunPhase = 'preparing' | 'streaming' | 'stopping' | 'complete' | 'error' | 'cancelled';

export interface ConversationRunWatermark {
  runId: string;
  revision: number;
}

export interface ConversationRun {
  conversationId: string;
  runId: string;
  streamId: string | null;
  streamingMessageId: string | null;
  phase: ConversationRunPhase;
  mode: ConversationRunMode;
  revision: number;
  multiModelParentId: string | null;
  pendingCompanionModels: MultiModelTarget[];
  multiModelDoneMessageIds: string[];
}

export interface ConversationRunSnapshot {
  conversationId: string;
  runId: string;
  streamId: string | null;
  messageId: string | null;
  mode: ConversationRunMode;
  phase: ConversationRunPhase;
  revision: number;
  content: string;
  thinking: string | null;
  pendingPermission: PermissionRequestEvent | null;
  pendingAsk: AskUserEvent | null;
}

export interface ConversationRunUpdatedEvent {
  conversationId: string;
  revision: number;
  snapshot: ConversationRunSnapshot | null;
}

export interface ConversationRunStateSlice {
  activeConversationId: string | null;
  streaming: boolean;
  streamingConversationId: string | null;
  streamingMessageId: string | null;
  activeStreamId: string | null;
  observedStream: (ConversationStreamSyncState & { conversationId: string }) | null;
  observedStreamsByConversation: Record<string, ConversationStreamSyncState>;
  runsByConversation: Record<string, ConversationRun>;
  runWatermarksByConversation: Record<string, ConversationRunWatermark>;
  pendingCompanionModels: MultiModelTarget[];
  multiModelParentId: string | null;
  multiModelDoneMessageIds: string[];
}

const LIVE_PHASES: ReadonlySet<ConversationRunPhase> = new Set([
  'preparing',
  'streaming',
  'stopping',
]);

export function isLiveConversationRun(
  run: ConversationRun | ConversationRunSnapshot | null | undefined,
): boolean {
  return Boolean(run && LIVE_PHASES.has(run.phase));
}

export function emptyConversationRunSlice(): Pick<
  ConversationRunStateSlice,
  'observedStreamsByConversation' | 'runsByConversation' | 'runWatermarksByConversation'
> {
  return {
    observedStreamsByConversation: {},
    runsByConversation: {},
    runWatermarksByConversation: {},
  };
}

export function getConversationRun(
  state: Pick<ConversationRunStateSlice, 'runsByConversation'>,
  conversationId: string | null | undefined,
): ConversationRun | null {
  if (!conversationId) return null;
  return state.runsByConversation[conversationId] ?? null;
}

export function getObservedStream(
  state: Pick<ConversationRunStateSlice, 'observedStream' | 'observedStreamsByConversation'>,
  conversationId: string | null | undefined,
): (ConversationStreamSyncState & { conversationId: string }) | null {
  if (!conversationId) return null;
  const fromMap = state.observedStreamsByConversation[conversationId];
  if (fromMap) return { conversationId, ...fromMap };
  if (state.observedStream?.conversationId === conversationId) return state.observedStream;
  return null;
}

export function isObservedStreamingFor(
  state: Pick<ConversationRunStateSlice, 'observedStream' | 'observedStreamsByConversation' | 'activeConversationId'>,
  conversationId: string | null = state.activeConversationId,
): boolean {
  return Boolean(getObservedStream(state, conversationId)?.streaming);
}

function matchesOwnedStream(
  state: Pick<ConversationRunStateSlice, 'streaming' | 'streamingConversationId' | 'activeConversationId'>,
  conversationId: string,
): boolean {
  if (!state.streaming) return false;
  if (state.streamingConversationId === conversationId) return true;
  return !state.streamingConversationId && state.activeConversationId === conversationId;
}

export function isConversationStreaming(
  state: ConversationRunStateSlice,
  conversationId: string | null | undefined = state.activeConversationId,
): boolean {
  if (!conversationId) return false;
  if (isLiveConversationRun(getConversationRun(state, conversationId))) return true;
  if (matchesOwnedStream(state, conversationId)) return true;
  return isObservedStreamingFor(state, conversationId);
}

export function selectUiStreaming(state: ConversationRunStateSlice): boolean {
  return isConversationStreaming(state, state.activeConversationId);
}

export function selectUiRunPhase(
  state: ConversationRunStateSlice,
): ConversationRunPhase | null {
  const run = getConversationRun(state, state.activeConversationId);
  return isLiveConversationRun(run) ? run?.phase ?? null : null;
}

export function selectUiStreamingMessageId(state: ConversationRunStateSlice): string | null {
  const conversationId = state.activeConversationId;
  if (!conversationId) return null;
  const run = getConversationRun(state, conversationId);
  if (isLiveConversationRun(run)) return run?.streamingMessageId ?? null;
  if (matchesOwnedStream(state, conversationId)) return state.streamingMessageId;
  if (isObservedStreamingFor(state, conversationId)) {
    return getObservedStream(state, conversationId)?.streamingMessageId ?? null;
  }
  return null;
}

export function selectUiStreamingConversationId(state: ConversationRunStateSlice): string | null {
  const conversationId = state.activeConversationId;
  if (!conversationId) return null;
  return isConversationStreaming(state, conversationId) ? conversationId : null;
}

export function selectUiMultiModelParentId(state: ConversationRunStateSlice): string | null {
  const conversationId = state.activeConversationId;
  if (!conversationId) return state.multiModelParentId;
  const run = getConversationRun(state, conversationId);
  if (isLiveConversationRun(run)) return run?.multiModelParentId ?? null;
  if (matchesOwnedStream(state, conversationId)) return state.multiModelParentId;
  if (isObservedStreamingFor(state, conversationId)) {
    return getObservedStream(state, conversationId)?.multiModelParentId ?? state.multiModelParentId;
  }
  return state.multiModelParentId;
}

export function selectUiPendingCompanionModels(
  state: ConversationRunStateSlice,
): MultiModelTarget[] {
  const conversationId = state.activeConversationId;
  if (!conversationId) return state.pendingCompanionModels;
  const run = getConversationRun(state, conversationId);
  if (isLiveConversationRun(run)) return run?.pendingCompanionModels ?? [];
  if (matchesOwnedStream(state, conversationId)) return state.pendingCompanionModels;
  if (isObservedStreamingFor(state, conversationId)) {
    return getObservedStream(state, conversationId)?.pendingCompanionModels
      ?? state.pendingCompanionModels;
  }
  return state.pendingCompanionModels;
}

export function selectUiMultiModelDoneMessageIds(state: ConversationRunStateSlice): string[] {
  const conversationId = state.activeConversationId;
  if (!conversationId) return state.multiModelDoneMessageIds;
  const run = getConversationRun(state, conversationId);
  if (isLiveConversationRun(run)) return run?.multiModelDoneMessageIds ?? [];
  if (matchesOwnedStream(state, conversationId)) return state.multiModelDoneMessageIds;
  if (isObservedStreamingFor(state, conversationId)) {
    return getObservedStream(state, conversationId)?.multiModelDoneMessageIds
      ?? state.multiModelDoneMessageIds;
  }
  return state.multiModelDoneMessageIds;
}

export function selectLiveStreamingConversationIds(state: ConversationRunStateSlice): string[] {
  const ids = new Set<string>();
  for (const [conversationId, run] of Object.entries(state.runsByConversation)) {
    if (isLiveConversationRun(run)) ids.add(conversationId);
  }
  if (state.streaming && state.streamingConversationId) {
    ids.add(state.streamingConversationId);
  }
  for (const [conversationId, observed] of Object.entries(state.observedStreamsByConversation)) {
    if (observed.streaming) ids.add(conversationId);
  }
  if (state.observedStream?.streaming) {
    ids.add(state.observedStream.conversationId);
  }
  return [...ids].sort();
}

export function selectLiveStreamingConversationKey(state: ConversationRunStateSlice): string {
  return selectLiveStreamingConversationIds(state).join('|');
}

export function conversationIdsFromStreamingKey(key: string): string[] {
  return key ? key.split('|') : [];
}

export function shouldApplyRunRevision(
  watermark: ConversationRunWatermark | undefined,
  incoming: ConversationRunWatermark,
): boolean {
  if (!watermark) return true;
  if (incoming.revision !== watermark.revision) {
    return incoming.revision > watermark.revision;
  }
  return incoming.runId === watermark.runId;
}

export function upsertConversationRun(
  state: ConversationRunStateSlice,
  patch: ConversationRun,
): Partial<ConversationRunStateSlice> {
  const watermark = state.runWatermarksByConversation[patch.conversationId];
  if (!shouldApplyRunRevision(watermark, patch)) return {};
  const runsByConversation = { ...state.runsByConversation };
  if (isLiveConversationRun(patch)) {
    runsByConversation[patch.conversationId] = patch;
  } else {
    delete runsByConversation[patch.conversationId];
  }
  const next: ConversationRunStateSlice = {
    ...state,
    runsByConversation,
    runWatermarksByConversation: {
      ...state.runWatermarksByConversation,
      [patch.conversationId]: { runId: patch.runId, revision: patch.revision },
    },
  };
  return {
    runsByConversation: next.runsByConversation,
    runWatermarksByConversation: next.runWatermarksByConversation,
    ...mirrorActiveStreamFields(next),
  };
}

export function clearConversationRun(
  state: ConversationRunStateSlice,
  conversationId: string,
  runId?: string | null,
): Partial<ConversationRunStateSlice> {
  const current = state.runsByConversation[conversationId];
  if (!current) return mirrorActiveStreamFields(state);
  if (runId && current.runId !== runId && current.streamId !== runId) return {};
  const runsByConversation = { ...state.runsByConversation };
  delete runsByConversation[conversationId];
  const next: ConversationRunStateSlice = {
    ...state,
    runsByConversation,
  };
  return {
    runsByConversation,
    ...mirrorActiveStreamFields(next),
  };
}

export function upsertObservedStream(
  state: ConversationRunStateSlice,
  conversationId: string,
  stream: ConversationStreamSyncState | null | undefined,
): Partial<ConversationRunStateSlice> {
  const observedStreamsByConversation = { ...state.observedStreamsByConversation };
  if (stream?.streaming) {
    observedStreamsByConversation[conversationId] = stream;
  } else {
    delete observedStreamsByConversation[conversationId];
  }
  const next: ConversationRunStateSlice = {
    ...state,
    observedStreamsByConversation,
    observedStream: state.observedStream?.conversationId === conversationId
      ? (stream?.streaming ? { conversationId, ...stream } : null)
      : state.observedStream,
  };
  return {
    observedStreamsByConversation,
    ...mirrorActiveStreamFields(next),
  };
}

export function mirrorActiveStreamFields(
  state: ConversationRunStateSlice,
): Partial<ConversationRunStateSlice> {
  const conversationId = state.activeConversationId;
  const run = getConversationRun(state, conversationId);
  if (isLiveConversationRun(run) && run) {
    return {
      streaming: true,
      streamingConversationId: run.conversationId,
      streamingMessageId: run.streamingMessageId,
      activeStreamId: run.streamId,
      observedStream: null,
      pendingCompanionModels: [...run.pendingCompanionModels],
      multiModelParentId: run.multiModelParentId,
      multiModelDoneMessageIds: [...run.multiModelDoneMessageIds],
    };
  }
  const observed = getObservedStream(state, conversationId);
  if (observed?.streaming) {
    return {
      streaming: false,
      streamingConversationId: null,
      streamingMessageId: null,
      activeStreamId: null,
      observedStream: observed,
      pendingCompanionModels: [...observed.pendingCompanionModels],
      multiModelParentId: observed.multiModelParentId,
      multiModelDoneMessageIds: [...observed.multiModelDoneMessageIds],
    };
  }
  return {
    streaming: false,
    streamingConversationId: null,
    streamingMessageId: null,
    activeStreamId: null,
    observedStream: null,
    pendingCompanionModels: [],
    multiModelParentId: null,
    multiModelDoneMessageIds: [],
  };
}

export function snapshotStreamSyncState(
  state: ConversationRunStateSlice,
  conversationId: string | null = state.activeConversationId,
): ConversationStreamSyncState {
  const run = getConversationRun(state, conversationId);
  if (isLiveConversationRun(run) && run) {
    return {
      streaming: true,
      streamId: run.streamId,
      streamingMessageId: run.streamingMessageId,
      multiModelParentId: run.multiModelParentId,
      pendingCompanionModels: [...run.pendingCompanionModels],
      multiModelDoneMessageIds: [...run.multiModelDoneMessageIds],
    };
  }
  const observed = getObservedStream(state, conversationId);
  if (observed?.streaming) {
    return {
      streaming: true,
      streamId: observed.streamId,
      streamingMessageId: observed.streamingMessageId,
      multiModelParentId: observed.multiModelParentId,
      pendingCompanionModels: [...observed.pendingCompanionModels],
      multiModelDoneMessageIds: [...observed.multiModelDoneMessageIds],
    };
  }
  const isActiveOwned = Boolean(
    conversationId
    && state.streaming
    && (
      state.streamingConversationId === conversationId
      || (!state.streamingConversationId && state.activeConversationId === conversationId)
    ),
  );
  return {
    streaming: isActiveOwned,
    streamId: isActiveOwned ? (state.activeStreamId ?? null) : null,
    streamingMessageId: isActiveOwned ? state.streamingMessageId : null,
    multiModelParentId: isActiveOwned ? state.multiModelParentId : null,
    pendingCompanionModels: isActiveOwned ? [...state.pendingCompanionModels] : [],
    multiModelDoneMessageIds: isActiveOwned ? [...state.multiModelDoneMessageIds] : [],
  };
}

export function runFromSnapshot(snapshot: ConversationRunSnapshot): ConversationRun {
  return {
    conversationId: snapshot.conversationId,
    runId: snapshot.runId,
    streamId: snapshot.streamId,
    streamingMessageId: snapshot.messageId,
    phase: snapshot.phase,
    mode: snapshot.mode,
    revision: snapshot.revision,
    multiModelParentId: null,
    pendingCompanionModels: [],
    multiModelDoneMessageIds: [],
  };
}

export function createConversationRun(input: {
  conversationId: string;
  runId: string;
  streamId?: string | null;
  streamingMessageId?: string | null;
  mode?: ConversationRunMode;
  phase?: ConversationRunPhase;
  revision?: number;
  multiModelParentId?: string | null;
  pendingCompanionModels?: MultiModelTarget[];
  multiModelDoneMessageIds?: string[];
}): ConversationRun {
  return {
    conversationId: input.conversationId,
    runId: input.runId,
    streamId: input.streamId ?? null,
    streamingMessageId: input.streamingMessageId ?? null,
    phase: input.phase ?? 'preparing',
    mode: input.mode ?? 'chat',
    revision: input.revision ?? 1,
    multiModelParentId: input.multiModelParentId ?? null,
    pendingCompanionModels: input.pendingCompanionModels ?? [],
    multiModelDoneMessageIds: input.multiModelDoneMessageIds ?? [],
  };
}
