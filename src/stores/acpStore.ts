import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke, listen, type UnlistenFn } from '@/lib/invoke';
import type {
  AcpAgentsFile,
  AcpMessage,
  AcpPromptAccepted,
  AcpProject,
  AcpRecentThreadReceipt,
  AcpSessionSnapshot,
  AcpThread,
  ConfiguredAgent,
  RegistryAddPreview,
  RegistryFile,
} from '@/types/acp';
import type { PermissionOptionButton } from '@/components/chat/PermissionCard';
import type { AttachmentInput } from '@/types';
import type { PastedSnippet } from '@/lib/pastedText';
import {
  extractPlanDocumentContent,
  finalizePendingPlanDocuments,
  normalizePlan,
  persistedPlanDocuments,
  planDocumentStatusFromResolution,
  resolvePlanDocument,
  upsertPlanDocument,
  type AcpPlanDocument,
  type AcpPlanState,
} from './acpPlanDocuments';

export type {
  AcpPlanDocument,
  AcpPlanEntry,
  AcpPlanState,
} from './acpPlanDocuments';

// Generation counter prevents StrictMode / remount races from stacking
// multiple acp-stream-text listeners (which doubles every streamed character).
let _acpListenerGen = 0;
let _acpUnlisten: UnlistenFn | null = null;
let _acpEventsReady: Promise<UnlistenFn> | null = null;
let _acpBootstrapInFlight: Promise<void> | null = null;
let _acpPrewarmInFlight: Promise<void> | null = null;
let _acpRecentDraftInFlight: Promise<AcpProject> | null = null;
let _acpProjectsLoadGeneration = 0;
let _acpAllThreadsLoadGeneration = 0;
let _acpConfigLoadGeneration = 0;
let _acpConfigMutationVersion = 0;
const _acpPrepareInFlight = new Map<string, Promise<AcpSessionSnapshot>>();
const _acpThreadListLoadVersion = new Map<string, number>();
const _acpMessageLoadVersion = new Map<string, number>();
const _acpSessionMutationTails = new Map<string, Promise<void>>();
const _acpSessionLifecycleVersion = new Map<string, number>();
const _acpRetiredSessionKeys = new Set<string>();
const _acpFirstOutputTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _acpStreamingMessageThreads = new Map<string, string>();
let _acpOptimisticMessageSeq = 0;
let _acpInteractionSeq = 0;

async function serializeAcpSessionMutation<T>(
  threadId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = _acpSessionMutationTails.get(threadId) ?? Promise.resolve();
  const operation = previous.then(mutation, mutation);
  // The public operation still rejects to its caller; only the private tail is
  // normalized so one failed update cannot permanently block later choices.
  const tail = operation.then(() => undefined, () => undefined);
  _acpSessionMutationTails.set(threadId, tail);
  try {
    return await operation;
  } finally {
    if (_acpSessionMutationTails.get(threadId) === tail) {
      _acpSessionMutationTails.delete(threadId);
    }
  }
}

const FIRST_OUTPUT_SILENCE_MS = 12_000;
export const ACP_HOST_STATUS = {
  firstOutputSilence: 'aqbot:first-output-silence',
  cancelling: 'aqbot:cancelling',
  cancelRestarting: 'aqbot:cancel-restarting',
  usingSharedAgent: 'aqbot:using-shared-agent',
  launchingAgent: 'aqbot:launching-agent',
  agentReady: 'aqbot:agent-ready',
  restoringSession: 'aqbot:restoring-session',
  savedSessionExpired: 'aqbot:saved-session-expired',
  creatingSession: 'aqbot:creating-session',
  sendingPrompt: 'aqbot:sending-prompt',
  sessionExpired: 'aqbot:session-expired',
  grokRetry: 'aqbot:grok-retry:',
} as const;
export const ACP_STATUS_FIRST_OUTPUT_SILENCE = ACP_HOST_STATUS.firstOutputSilence;
export const ACP_STATUS_CANCELLING = ACP_HOST_STATUS.cancelling;

const REPLACEABLE_FIRST_OUTPUT_STATUSES = new Set<string>([
  ACP_HOST_STATUS.sendingPrompt,
  ACP_HOST_STATUS.agentReady,
  ACP_HOST_STATUS.usingSharedAgent,
  ACP_HOST_STATUS.launchingAgent,
]);

function canReplaceWithFirstOutputSilence(status: string | undefined): boolean {
  return !status?.trim() || REPLACEABLE_FIRST_OUTPUT_STATUSES.has(status);
}

function clearFirstOutputTimer(threadId: string): void {
  const timer = _acpFirstOutputTimers.get(threadId);
  if (timer) clearTimeout(timer);
  _acpFirstOutputTimers.delete(threadId);
}

function invalidateAcpMessageLoad(threadId: string): void {
  _acpMessageLoadVersion.set(
    threadId,
    (_acpMessageLoadVersion.get(threadId) ?? 0) + 1,
  );
}

function retireAcpSessionKey(sessionKey: string): void {
  _acpRetiredSessionKeys.add(sessionKey);
  invalidateAcpMessageLoad(sessionKey);
  _acpSessionLifecycleVersion.set(
    sessionKey,
    (_acpSessionLifecycleVersion.get(sessionKey) ?? 0) + 1,
  );
  clearFirstOutputTimer(sessionKey);
}

function isAcpSessionKeyLive(sessionKey: string): boolean {
  return !_acpRetiredSessionKeys.has(sessionKey);
}

function takeStreamingMessageIdsForSessions(
  sessionKeys: ReadonlySet<string>,
): Set<string> {
  const messageIds = new Set<string>();
  for (const [messageId, threadId] of _acpStreamingMessageThreads) {
    if (!sessionKeys.has(threadId)) continue;
    messageIds.add(messageId);
    _acpStreamingMessageThreads.delete(messageId);
  }
  return messageIds;
}

function replaceProjectThreadsInPlace(
  allThreads: AcpThread[],
  projectId: string,
  refreshed: AcpThread[],
): AcpThread[] {
  const insertionIndex = allThreads.findIndex((thread) => thread.project_id === projectId);
  if (insertionIndex < 0) return [...allThreads, ...refreshed];
  const next = allThreads.filter((thread) => thread.project_id !== projectId);
  next.splice(insertionIndex, 0, ...refreshed);
  return next;
}

interface AcpPrewarmResult {
  agentId: string;
  ready: boolean;
  error?: string | null;
}

export interface AcpAgentReadiness {
  status: 'ready' | 'error';
  error: string | null;
}

function snapshotCurrentMode(snapshot: AcpSessionSnapshot): string | null {
  if (snapshot.modes?.currentModeId) return snapshot.modes.currentModeId;
  const configMode = snapshot.configOptions.find((option) => {
    if (option.type !== 'select' || !Array.isArray(option.options)) return false;
    return option.options.some((entry) => (
      'value' in entry
        ? String(entry.value).split(/[#/:]/).pop()?.toLowerCase() === 'plan'
        : entry.options.some(
            (choice) => String(choice.value).split(/[#/:]/).pop()?.toLowerCase() === 'plan',
          )
    ));
  });
  return typeof configMode?.currentValue === 'string' ? configMode.currentValue : null;
}

function launchFingerprint(agent: ConfiguredAgent | undefined): string | null {
  if (!agent) return null;
  return JSON.stringify([agent.command, agent.args, agent.env ?? {}]);
}

function ensureAcpEventsBound(bind: () => Promise<UnlistenFn>): Promise<UnlistenFn> {
  if (_acpEventsReady) return _acpEventsReady;
  const pending = bind();
  _acpEventsReady = pending.catch((error) => {
    _acpEventsReady = null;
    throw error;
  });
  return _acpEventsReady;
}

/** Merge a stream chunk: support both delta and cumulative snapshots; drop exact dupes. */
function mergeStreamChunk(prev: string, chunk: string): string {
  if (!chunk) return prev;
  if (!prev) return chunk;
  // Exact replay of the same payload (double listener / reconnect)
  if (chunk === prev) return prev;
  // Cumulative snapshot (agent sends full text so far each time)
  if (chunk.startsWith(prev) && chunk.length > prev.length) return chunk;
  // Cumulative snapshot that shrank then grew with same prefix path — keep longer
  if (prev.startsWith(chunk)) return prev;
  return prev + chunk;
}

export interface AcpPermissionRequest {
  threadId: string;
  requestId: string;
  kind?: 'permission' | 'question' | 'plan_review';
  title?: string;
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
  options: Array<PermissionOptionButton & { kind?: string; description?: string }>;
  status: 'pending' | 'approved' | 'denied';
  messageId?: string;
  sequence?: number;
}

export type AcpQuestionnaireOutcome =
  | 'accepted'
  | 'declined'
  | 'chat_about_this'
  | 'skip_interview'
  | 'cancelled';

export interface AcpQuestionnaireAnswer {
  questionIndex: number;
  selectedOptionIndexes: number[];
  otherText?: string;
}

export interface AcpQuestionnaireSubmission {
  outcome: AcpQuestionnaireOutcome;
  answers: AcpQuestionnaireAnswer[];
}

function questionnaireHasSecret(input: Record<string, unknown> | undefined): boolean {
  if (!Array.isArray(input?.questions)) return false;
  return input.questions.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const question = entry as Record<string, unknown>;
    return question.secret === true
      || String(question.inputType ?? '').toLowerCase() === 'secret';
  });
}

export interface AcpToolCallState {
  threadId: string;
  messageId?: string;
  toolCallId: string;
  toolName: string;
  status: 'queued' | 'running' | 'success' | 'error' | 'cancelled';
  input?: string;
  output?: string;
  approvalStatus?: 'approved' | 'denied' | 'cancelled' | 'expired';
  approvalOptionId?: string;
  approvalLabel?: string;
}

interface AcpInteractionResolution {
  requestId: string;
  threadId?: string;
  messageId?: string;
  kind?: AcpPermissionRequest['kind'];
  toolCallId?: string;
  optionId?: string;
  optionKind?: string;
  optionLabel?: string;
  reason?: 'selected' | 'cancelled' | 'expired';
}

function resolvedInteractionState(
  pendingPermissions: Record<string, AcpPermissionRequest>,
  toolCalls: Record<string, AcpToolCallState>,
  resolution: AcpInteractionResolution,
): {
  pendingPermissions: Record<string, AcpPermissionRequest>;
  toolCalls: Record<string, AcpToolCallState>;
} {
  const existing = pendingPermissions[resolution.requestId];
  const { [resolution.requestId]: _resolved, ...remaining } = pendingPermissions;
  const selectedOption = existing?.options.find((option) => option.id === resolution.optionId);
  const kind = resolution.kind ?? existing?.kind ?? 'permission';
  const threadId = resolution.threadId ?? existing?.threadId;
  const toolCallId = resolution.toolCallId ?? existing?.toolCallId;
  if (!threadId || !toolCallId) {
    return { pendingPermissions: remaining, toolCalls };
  }

  const messageId = resolution.messageId ?? existing?.messageId;
  const toolKey = acpToolStateKey(threadId, toolCallId, messageId);
  const previousTool = toolCalls[toolKey];
  const selectedLabel = resolution.optionLabel?.trim()
    || selectedOption?.label.trim()
    || undefined;
  const previousOutput = previousTool?.output?.trim()
    ? previousTool.output
    : undefined;
  const questionnaireOutcome = resolution.optionId
    ? `aqbot:questionnaire:${resolution.optionId}`
    : undefined;
  const baseTool: AcpToolCallState = {
    threadId,
    messageId: messageId ?? previousTool?.messageId,
    toolCallId,
    toolName: previousTool?.toolName ?? existing?.toolName ?? 'tool',
    status: previousTool?.status ?? 'queued',
    input: previousTool?.input
      ?? (existing ? JSON.stringify(existing.input, null, 2) : undefined),
    output: previousTool?.output,
  };
  if (kind !== 'permission') {
    return {
      pendingPermissions: remaining,
      toolCalls: {
        ...toolCalls,
        [toolKey]: {
          ...baseTool,
          output: resolution.reason === 'selected'
            ? previousOutput ?? selectedLabel ?? questionnaireOutcome
            : previousTool?.output,
        },
      },
    };
  }

  const decisionIdentity = `${resolution.optionKind ?? selectedOption?.kind ?? ''} ${
    resolution.optionId ?? ''
  }`.toLowerCase();
  const denied = selectedOption?.variant === 'danger'
    || /reject|deny|cancel|abandon/.test(decisionIdentity);
  const approvalStatus: AcpToolCallState['approvalStatus'] = resolution.reason === 'cancelled'
    ? 'cancelled'
    : resolution.reason === 'expired'
      ? 'expired'
      : denied
        ? 'denied'
        : 'approved';
  const approvalLabel = resolution.optionLabel ?? selectedOption?.label;
  return {
    pendingPermissions: remaining,
    toolCalls: {
      ...toolCalls,
      [toolKey]: {
        ...baseTool,
        status: approvalStatus === 'approved' ? baseTool.status : 'cancelled',
        approvalStatus,
        ...(resolution.optionId ? { approvalOptionId: resolution.optionId } : {}),
        ...(approvalLabel ? { approvalLabel } : {}),
      },
    },
  };
}

export interface AcpComposerRecovery {
  id: string;
  text: string;
  error: string;
}

export interface AcpComposerDraft {
  value: string;
  snippets: PastedSnippet[];
  files: File[];
  recovery?: AcpComposerRecovery;
}

interface AcpPlanFollowUp {
  requestId: string;
  prompt: string;
}

interface AcpStore {
  config: AcpAgentsFile | null;
  registry: RegistryFile | null;
  projects: AcpProject[];
  threads: AcpThread[];
  messages: AcpMessage[];
  messagesLoadingByThread: Record<string, boolean>;
  messagesErrorByThread: Record<string, string>;
  activeProjectId: string | null;
  activeThreadId: string | null;
  streamingText: Record<string, string>;
  statusByThread: Record<string, string>;
  /** threadId → running */
  runningByThread: Record<string, boolean>;
  turnActivityByThread: Record<string, boolean>;
  pendingPermissions: Record<string, AcpPermissionRequest>; // requestId
  toolCalls: Record<string, AcpToolCallState>; // threadId:messageId:toolCallId
  agentReadinessById: Record<string, AcpAgentReadiness>;
  sessionByThread: Record<string, AcpSessionSnapshot>;
  preparingByThread: Record<string, boolean>;
  cancellingByThread: Record<string, boolean>;
  planByThread: Record<string, AcpPlanState>;
  /** Full plan-review documents kept for timeline re-reading after exit. */
  planDocumentsByThread: Record<string, AcpPlanDocument[]>;
  /** Revision feedback waiting for the current plan turn to reach its drain boundary. */
  planFollowUpByThread: Record<string, AcpPlanFollowUp>;
  spawnModelByThread: Record<string, string>;
  spawnReasoningByThread: Record<string, string>;
  permissionMode: string;
  /** In-memory only: unsent composer content survives Agent page unmounts. */
  composerDraftsByScope: Record<string, AcpComposerDraft>;
  composerSubmitting: boolean;
  creatingThread: boolean;
  loading: boolean;
  error: string | null;
  /** Error from the ACP agent configuration fetch, distinct from a valid empty config. */
  configError: string | null;
  /**
   * True after the first successful (or failed) config fetch this session.
   * Until then, `agents.length === 0` must NOT be treated as "not configured" —
   * show loading instead (cold start / Tauri not ready yet).
   */
  configReady: boolean;
  /** True after first projects list fetch completes. */
  projectsReady: boolean;
  /** True after first all-threads list fetch completes. */
  threadsReady: boolean;

  loadConfig: () => Promise<void>;
  loadRegistry: (refresh?: boolean) => Promise<void>;
  setAgentEnabled: (agentId: string, enabled: boolean) => Promise<void>;
  previewFromRegistry: (agentId: string) => Promise<RegistryAddPreview>;
  addFromRegistry: (
    agentId: string,
    options?: { allowInstaller?: boolean; approvalToken?: string | null },
  ) => Promise<void>;
  saveGeneral: (general: AcpAgentsFile['general']) => Promise<void>;
  upsertCustom: (agent: ConfiguredAgent) => Promise<void>;
  removeAgent: (agentId: string) => Promise<void>;
  reorderAgents: (agentIds: string[]) => Promise<void>;
  setPermissionMode: (mode: string) => Promise<void>;
  saveComposerDraft: (scopeKey: string, draft: AcpComposerDraft) => void;
  takeComposerDraft: (scopeKey: string) => AcpComposerDraft | undefined;
  takeComposerRecovery: (scopeKey: string) => AcpComposerRecovery | undefined;
  clearComposerDraft: (scopeKey: string) => void;

  loadProjects: () => Promise<void>;
  /** Optimistic local reorder (like category store onDragOver). */
  setProjectsOrder: (projects: AcpProject[]) => void;
  /** Persist order after drag end. */
  reorderProjects: (projectIds: string[]) => Promise<void>;
  createProject: (name: string, rootPath: string) => Promise<AcpProject>;
  ensureRecentDraft: () => Promise<AcpProject>;
  updateProject: (
    projectId: string,
    patch: { name?: string; rootPath?: string },
  ) => Promise<AcpProject>;
  deleteProject: (projectId: string) => Promise<void>;
  selectProject: (projectId: string | null) => Promise<void>;
  loadThreads: (projectId: string) => Promise<void>;
  loadAllThreads: () => Promise<void>;
  createThread: (projectId: string, agentId: string, title?: string) => Promise<AcpThread>;
  createRecentThread: (agentId: string, title?: string) => Promise<AcpThread>;
  deleteThread: (threadId: string) => Promise<void>;
  batchDeleteThreads: (threadIds: string[]) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<AcpThread>;
  toggleThreadPin: (threadId: string) => Promise<AcpThread>;
  /** Optimistic local reorder within a project (sidebar drag). */
  setThreadsOrder: (projectId: string, threads: AcpThread[]) => void;
  reorderThreads: (projectId: string, threadIds: string[]) => Promise<void>;
  duplicateThread: (threadId: string, titleSuffix?: string) => Promise<AcpThread>;
  selectThread: (threadId: string | null) => Promise<void>;
  loadMessages: (threadId: string) => Promise<void>;
  prepareDraft: (projectId: string, agentId: string) => Promise<AcpSessionSnapshot>;
  prepareSession: (threadId: string) => Promise<AcpSessionSnapshot>;
  setConfigOption: (
    threadId: string,
    configId: string,
    value: string | boolean,
  ) => Promise<void>;
  setSessionMode: (threadId: string, modeId: string) => Promise<void>;
  cancelPrompt: (threadId: string) => Promise<void>;
  sendPrompt: (
    threadId: string,
    prompt: string,
    attachments?: AttachmentInput[],
  ) => Promise<void>;
  respondPermission: (
    requestId: string,
    optionId: string,
    feedback?: string,
  ) => Promise<void>;
  cancelInteraction: (requestId: string) => Promise<void>;
  respondQuestionnaire: (
    requestId: string,
    submission: AcpQuestionnaireSubmission,
  ) => Promise<void>;
  /**
   * Re-open the last project + thread after entering the Agent page.
   * Validates ids against the freshly loaded lists, then loads messages.
   */
  restoreLastSession: () => Promise<void>;

  enabledAgents: () => ConfiguredAgent[];
  permissionsForThread: (threadId: string) => AcpPermissionRequest[];
  toolsForThread: (threadId: string) => AcpToolCallState[];
  /** All threads (for sidebar groups under projects). */
  allThreads: AcpThread[];
  bindEvents: () => Promise<UnlistenFn>;
  /** Fire-and-forget warm load used at app bootstrap. */
  warmBootstrap: () => void;
}

function mapPermissionDefaultToMode(value: string | undefined): string {
  if (value === 'full_access') return 'full_access';
  if (value === 'auto_approve') return 'auto_approve';
  if (value === 'accept_edits') return 'accept_edits';
  // legacy "prompt" maps to default
  return 'default';
}

function mapModeToPermissionDefault(mode: string): string {
  if (mode === 'full_access') return 'full_access';
  if (mode === 'auto_approve') return 'auto_approve';
  if (mode === 'accept_edits') return 'accept_edits';
  return 'default';
}

function mapAcpOptions(
  options: Array<{
    optionId?: string;
    option_id?: string;
    name: string;
    kind?: string | null;
    description?: string | null;
  }>,
  descriptions: Array<string | undefined> = [],
): Array<PermissionOptionButton & { kind?: string; description?: string }> {
  if (!options?.length) return [];
  return options.map((o, index) => {
    const id = o.optionId ?? o.option_id ?? o.name;
    const kind = (o.kind ?? '').toLowerCase();
    let variant: PermissionOptionButton['variant'] = 'default';
    if (kind.includes('reject') || kind.includes('deny') || kind.includes('cancel')) {
      variant = 'danger';
    } else if (kind.includes('allow_once') || kind.includes('allowonce')) {
      variant = 'primary';
    } else if (kind.includes('allow_always') || kind.includes('allowalways')) {
      variant = 'default';
    } else if (kind.includes('allow')) {
      variant = 'primary';
    }
    return {
      id,
      label: o.name || id,
      variant,
      ...(o.kind ? { kind: o.kind } : {}),
      ...(o.description || descriptions[index]
        ? { description: o.description ?? descriptions[index] ?? undefined }
        : {}),
    };
  });
}

function interactionKind(
  raw: Record<string, unknown>,
  explicit?: AcpPermissionRequest['kind'],
): AcpPermissionRequest['kind'] {
  if (explicit && explicit !== 'permission') return explicit;
  const meta = raw._meta && typeof raw._meta === 'object'
    ? raw._meta as Record<string, unknown>
    : null;
  const codex = meta?.codex && typeof meta.codex === 'object'
    ? meta.codex as Record<string, unknown>
    : null;
  const kind = String(codex?.kind ?? raw.kind ?? '').toLowerCase();
  if (kind === 'ask_user_question' || kind === 'elicitation_form') return 'question';
  if (kind === 'plan_review') return 'plan_review';
  const toolCallValue = raw.toolCall ?? raw.tool_call;
  const toolCall = toolCallValue && typeof toolCallValue === 'object'
    ? toolCallValue as Record<string, unknown>
    : raw;
  const rawInputValue = toolCall.rawInput ?? toolCall.raw_input;
  const rawInput = rawInputValue && typeof rawInputValue === 'object'
    ? rawInputValue as Record<string, unknown>
    : null;
  const toolKind = String(toolCall.kind ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const plan = raw.plan ?? rawInput?.plan;
  if (toolKind === 'switchmode' && typeof plan === 'string' && plan.trim()) {
    return 'plan_review';
  }
  return explicit ?? 'permission';
}

function removeThreadEntries<T extends { threadId: string }>(
  entries: Record<string, T>,
  threadId: string,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => entry.threadId !== threadId),
  );
}

function omitSessionKeys<T>(
  record: Record<string, T>,
  sessionKeys: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !sessionKeys.has(key)),
  );
}

function omitComposerDrafts(
  drafts: Record<string, AcpComposerDraft>,
  shouldRemove: (scopeKey: string) => boolean,
): Record<string, AcpComposerDraft> {
  return Object.fromEntries(
    Object.entries(drafts).filter(([scopeKey]) => !shouldRemove(scopeKey)),
  );
}

function isLiveComposerDraftScope(
  state: Pick<
    AcpStore,
    'projects' | 'threads' | 'allThreads' | 'activeProjectId' | 'activeThreadId'
  >,
  scopeKey: string,
): boolean {
  if (scopeKey === 'recent:draft') return true;
  if (state.projects.some(
    (project) => project.kind === 'project' && scopeKey === `${project.id}:draft`,
  )) return true;
  if (
    state.activeProjectId
    && !state.projects.some((project) => project.id === state.activeProjectId)
    && scopeKey === `${state.activeProjectId}:draft`
  ) return true;
  if ([...state.threads, ...state.allThreads].some(
    (thread) => scopeKey === `${thread.project_id}:${thread.id}`,
  )) return true;
  return !!(
    state.activeProjectId
    && state.activeThreadId
    && scopeKey === `${state.activeProjectId}:${state.activeThreadId}`
  );
}

function composerScopeForThread(state: Pick<
  AcpStore,
  'threads' | 'allThreads' | 'activeProjectId' | 'activeThreadId'
>, threadId: string): string | undefined {
  const thread = [...state.threads, ...state.allThreads]
    .find((candidate) => candidate.id === threadId);
  const projectId = thread?.project_id
    ?? (state.activeThreadId === threadId ? state.activeProjectId : null);
  return projectId ? `${projectId}:${threadId}` : undefined;
}

function removeSessionEntries<T extends { threadId: string }>(
  entries: Record<string, T>,
  sessionKeys: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => !sessionKeys.has(entry.threadId)),
  );
}

function clearAcpSessionState(
  state: AcpStore,
  sessionKeys: ReadonlySet<string>,
  streamingMessageIds: ReadonlySet<string> = new Set(),
): Partial<AcpStore> {
  const removedMessageIds = new Set(
    state.messages
      .filter((message) => sessionKeys.has(message.thread_id))
      .map((message) => message.id),
  );
  for (const messageId of streamingMessageIds) removedMessageIds.add(messageId);
  return {
    messages: state.messages.filter((message) => !sessionKeys.has(message.thread_id)),
    streamingText: Object.fromEntries(
      Object.entries(state.streamingText).filter(([messageId]) => !removedMessageIds.has(messageId)),
    ),
    messagesLoadingByThread: omitSessionKeys(state.messagesLoadingByThread, sessionKeys),
    messagesErrorByThread: omitSessionKeys(state.messagesErrorByThread, sessionKeys),
    statusByThread: omitSessionKeys(state.statusByThread, sessionKeys),
    runningByThread: omitSessionKeys(state.runningByThread, sessionKeys),
    turnActivityByThread: omitSessionKeys(state.turnActivityByThread, sessionKeys),
    pendingPermissions: removeSessionEntries(state.pendingPermissions, sessionKeys),
    toolCalls: removeSessionEntries(state.toolCalls, sessionKeys),
    sessionByThread: omitSessionKeys(state.sessionByThread, sessionKeys),
    preparingByThread: omitSessionKeys(state.preparingByThread, sessionKeys),
    cancellingByThread: omitSessionKeys(state.cancellingByThread, sessionKeys),
    planByThread: omitSessionKeys(state.planByThread, sessionKeys),
    planDocumentsByThread: omitSessionKeys(state.planDocumentsByThread, sessionKeys),
    planFollowUpByThread: omitSessionKeys(state.planFollowUpByThread, sessionKeys),
    spawnModelByThread: omitSessionKeys(state.spawnModelByThread, sessionKeys),
    spawnReasoningByThread: omitSessionKeys(state.spawnReasoningByThread, sessionKeys),
    ...(state.activeThreadId && sessionKeys.has(state.activeThreadId)
      ? { activeThreadId: null }
      : {}),
  };
}

function projectSessionKeys(state: AcpStore, projectId: string): Set<string> {
  const keys = new Set(
    [...state.threads, ...state.allThreads]
      .filter((thread) => thread.project_id === projectId)
      .map((thread) => thread.id),
  );
  const draftPrefix = `draft:${projectId}:`;
  const keyedRecords = [
    state.sessionByThread,
    state.preparingByThread,
    state.spawnModelByThread,
    state.spawnReasoningByThread,
  ];
  for (const record of keyedRecords) {
    for (const key of Object.keys(record)) {
      if (key.startsWith(draftPrefix)) keys.add(key);
    }
  }
  for (const key of _acpPrepareInFlight.keys()) {
    if (key.startsWith(draftPrefix)) keys.add(key);
  }
  for (const key of _acpSessionMutationTails.keys()) {
    if (key.startsWith(draftPrefix)) keys.add(key);
  }
  return keys;
}

function finalizeUnfinishedToolCalls(
  toolCalls: Record<string, AcpToolCallState>,
  threadId: string,
  status: 'cancelled' | 'error',
): Record<string, AcpToolCallState> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(toolCalls).map(([key, tool]) => {
    if (
      tool.threadId !== threadId
      || (tool.status !== 'queued' && tool.status !== 'running')
    ) return [key, tool];
    changed = true;
    return [key, { ...tool, status }];
  }));
  return changed ? next : toolCalls;
}

export function acpToolStateKey(
  threadId: string,
  toolCallId: string,
  messageId?: string,
): string {
  return messageId
    ? `${threadId}:${messageId}:${toolCallId}`
    : `${threadId}:${toolCallId}`;
}

function prewarmConfiguredAgents(): Promise<void> {
  // ACP processes only exist in the desktop runtime. Browser preview/tests use
  // BrowserMock, which intentionally does not emulate long-lived child processes.
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return Promise.resolve();
  }
  if (_acpPrewarmInFlight) return _acpPrewarmInFlight;

  const task = invoke<AcpPrewarmResult[]>(
    'acp_prewarm_enabled_agents',
  )
    .then((results) => {
      const updates = Object.fromEntries(results.map((result) => [
        result.agentId,
        {
          status: result.ready ? 'ready' as const : 'error' as const,
          error: result.error ?? null,
        },
      ]));
      useAcpStore.setState((state) => ({
        agentReadinessById: { ...state.agentReadinessById, ...updates },
      }));
      const failed = results.filter((result) => !result.ready);
      if (failed.length > 0) console.warn('ACP startup prewarm failed', failed);
    })
    .catch((error) => {
      const message = String(error);
      useAcpStore.setState((state) => ({
        agentReadinessById: {
          ...state.agentReadinessById,
          ...Object.fromEntries(
            (state.config?.agents ?? [])
              .filter((agent) => agent.enabled)
              .map((agent) => [agent.id, { status: 'error' as const, error: message }]),
          ),
        },
      }));
      console.warn('ACP startup prewarm command failed', error);
    })
    .finally(() => {
      if (_acpPrewarmInFlight === task) _acpPrewarmInFlight = null;
    });
  _acpPrewarmInFlight = task;
  return task;
}

function extractToolName(raw: Record<string, unknown>, title?: string | null): string {
  // Prefer short kind (terminal/read/edit) for the chip label — title is often the full command.
  const kind = raw.kind ?? raw.toolKind;
  if (typeof kind === 'string' && kind) return kind;
  if (title && title.length <= 32) return title;
  if (title) return title.split(/\s+/)[0] || 'tool';
  return 'tool';
}

function extractToolInput(raw: Record<string, unknown>): string | undefined {
  const locations = raw.locations ?? raw.content ?? raw.rawInput ?? raw.input;
  if (locations == null) return undefined;
  try {
    return JSON.stringify(locations, null, 2);
  } catch {
    return String(locations);
  }
}

function extractToolOutput(raw: Record<string, unknown>): string | undefined {
  const value = raw.rawOutput ?? raw.raw_output ?? raw.output ?? raw.content;
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeToolStatus(value: unknown): AcpToolCallState['status'] {
  const status = String(value ?? 'success').toLowerCase();
  if (status === 'completed' || status === 'success') return 'success';
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'in_progress' || status === 'running') return 'running';
  return 'queued';
}

function normalizeApprovalStatus(value: unknown): AcpToolCallState['approvalStatus'] {
  if (value === 'approved' || value === 'denied' || value === 'cancelled' || value === 'expired') {
    return value;
  }
  return undefined;
}

function persistedToolCalls(messages: AcpMessage[]): Record<string, AcpToolCallState> {
  const toolCalls: Record<string, AcpToolCallState> = {};
  for (const message of messages) {
    if (!message.meta_json) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.meta_json);
    } catch (error) {
      console.warn('[acpStore] invalid ACP message metadata', { messageId: message.id, error });
      continue;
    }
    const rawTools = (parsed as { toolCalls?: unknown })?.toolCalls;
    if (!Array.isArray(rawTools)) continue;
    for (const raw of rawTools) {
      if (!raw || typeof raw !== 'object') continue;
      const tool = raw as Record<string, unknown>;
      const toolCallId = typeof tool.toolCallId === 'string' ? tool.toolCallId : '';
      if (!toolCallId) continue;
      const approvalStatus = normalizeApprovalStatus(tool.approvalStatus);
      toolCalls[acpToolStateKey(message.thread_id, toolCallId, message.id)] = {
        threadId: message.thread_id,
        messageId: message.id,
        toolCallId,
        toolName: typeof tool.toolName === 'string' && tool.toolName ? tool.toolName : 'tool',
        status: normalizeToolStatus(tool.status),
        ...(typeof tool.input === 'string' ? { input: tool.input } : {}),
        ...(typeof tool.output === 'string' ? { output: tool.output } : {}),
        ...(approvalStatus ? { approvalStatus } : {}),
        ...(typeof tool.approvalOptionId === 'string'
          ? { approvalOptionId: tool.approvalOptionId }
          : {}),
        ...(typeof tool.approvalLabel === 'string' ? { approvalLabel: tool.approvalLabel } : {}),
      };
    }
  }
  return toolCalls;
}

export const useAcpStore = create<AcpStore>()(
  persist(
    (set, get) => ({
  config: null,
  registry: null,
  projects: [],
  threads: [],
  allThreads: [],
  messages: [],
  messagesLoadingByThread: {},
  messagesErrorByThread: {},
  activeProjectId: null,
  activeThreadId: null,
  streamingText: {},
  statusByThread: {},
  runningByThread: {},
  turnActivityByThread: {},
  pendingPermissions: {},
  toolCalls: {},
  agentReadinessById: {},
  sessionByThread: {},
  preparingByThread: {},
  cancellingByThread: {},
  planByThread: {},
  planDocumentsByThread: {},
  planFollowUpByThread: {},
  spawnModelByThread: {},
  spawnReasoningByThread: {},
  permissionMode: 'default',
  composerDraftsByScope: {},
  composerSubmitting: false,
  creatingThread: false,
  loading: false,
  error: null,
  configError: null,
  configReady: false,
  projectsReady: false,
  threadsReady: false,

  enabledAgents: () =>
    (get().config?.agents ?? [])
      .filter((a) => a.enabled)
      .slice()
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)),

  saveComposerDraft: (scopeKey, draft) => {
    const hasContent = !!draft.value || draft.snippets.length > 0 || draft.files.length > 0;
    set((state) => {
      const next = { ...state.composerDraftsByScope };
      const recovery = draft.recovery ?? next[scopeKey]?.recovery;
      if ((hasContent || recovery) && isLiveComposerDraftScope(state, scopeKey)) {
        next[scopeKey] = { ...draft, ...(recovery ? { recovery } : {}) };
      } else {
        delete next[scopeKey];
      }
      return { composerDraftsByScope: next };
    });
  },

  takeComposerDraft: (scopeKey) => {
    const draft = get().composerDraftsByScope[scopeKey];
    if (!draft) return undefined;
    set((state) => {
      const next = { ...state.composerDraftsByScope };
      delete next[scopeKey];
      return { composerDraftsByScope: next };
    });
    return draft;
  },

  takeComposerRecovery: (scopeKey) => {
    const recovery = get().composerDraftsByScope[scopeKey]?.recovery;
    if (!recovery) return undefined;
    set((state) => {
      const current = state.composerDraftsByScope[scopeKey];
      if (current?.recovery?.id !== recovery.id) return state;
      const next = { ...state.composerDraftsByScope };
      const { recovery: _consumed, ...draft } = current;
      if (draft.value || draft.snippets.length > 0 || draft.files.length > 0) {
        next[scopeKey] = draft;
      } else {
        delete next[scopeKey];
      }
      return { composerDraftsByScope: next };
    });
    return recovery;
  },

  clearComposerDraft: (scopeKey) => {
    set((state) => {
      if (!(scopeKey in state.composerDraftsByScope)) return state;
      const next = { ...state.composerDraftsByScope };
      delete next[scopeKey];
      return { composerDraftsByScope: next };
    });
  },

  permissionsForThread: (threadId) =>
    Object.values(get().pendingPermissions)
      .filter((permission) => permission.threadId === threadId)
      .sort((left, right) => (
        (left.sequence ?? Number.MAX_SAFE_INTEGER)
        - (right.sequence ?? Number.MAX_SAFE_INTEGER)
      )),

  toolsForThread: (threadId) =>
    Object.values(get().toolCalls).filter((t) => t.threadId === threadId),

  loadConfig: async () => {
    const generation = ++_acpConfigLoadGeneration;
    const mutationVersion = _acpConfigMutationVersion;
    try {
      const config = await invoke<AcpAgentsFile>('acp_get_config');
      if (
        generation !== _acpConfigLoadGeneration
        || mutationVersion !== _acpConfigMutationVersion
      ) return;
      set({
        config,
        permissionMode: mapPermissionDefaultToMode(config.general?.permissionDefault),
        configReady: true,
        configError: null,
        error: null,
      });
    } catch (e) {
      if (
        generation !== _acpConfigLoadGeneration
        || mutationVersion !== _acpConfigMutationVersion
      ) return;
      // Keep any cached config so the UI does not flash "not configured".
      set({ configReady: true, configError: String(e), error: String(e) });
    }
  },

  loadRegistry: async (refresh = false) => {
    const configMutationVersion = _acpConfigMutationVersion;
    set({ loading: true, error: null });
    try {
      const registry = await invoke<RegistryFile>(
        refresh ? 'acp_refresh_registry' : 'acp_get_registry',
      );
      if (refresh) {
        const previousConfig = get().config;
        const config = await invoke<AcpAgentsFile>('acp_get_config');
        if (configMutationVersion !== _acpConfigMutationVersion) {
          set({ registry, loading: false });
          return;
        }
        const previousById = new Map(
          (previousConfig?.agents ?? []).map((agent) => [agent.id, launchFingerprint(agent)]),
        );
        const changedAgents = new Set(
          config.agents
            .filter((agent) => previousById.get(agent.id) !== launchFingerprint(agent))
            .map((agent) => agent.id),
        );
        _acpConfigMutationVersion += 1;
        set((state) => {
          const threadAgent = new Map(
            [...state.allThreads, ...state.threads].map((thread) => [thread.id, thread.agent_id]),
          );
          const keepSession = ([key]: [string, unknown]) => {
            const agentId = key.startsWith('draft:')
              ? key.split(':').slice(-1)[0]
              : threadAgent.get(key);
            return !agentId || !changedAgents.has(agentId) || state.runningByThread[key] === true;
          };
          return {
            registry,
            config,
            configError: null,
            permissionMode: mapPermissionDefaultToMode(config.general?.permissionDefault),
            loading: false,
            sessionByThread: Object.fromEntries(
              Object.entries(state.sessionByThread).filter(keepSession),
            ),
            spawnModelByThread: Object.fromEntries(
              Object.entries(state.spawnModelByThread).filter(keepSession),
            ),
            spawnReasoningByThread: Object.fromEntries(
              Object.entries(state.spawnReasoningByThread).filter(keepSession),
            ),
          };
        });
        if (changedAgents.size > 0) {
          void prewarmConfiguredAgents();
        }
      } else {
        set({ registry, loading: false });
      }
    } catch (e) {
      const refreshError = String(e);
      set({ loading: false, error: refreshError });
      try {
        const registry = await invoke<RegistryFile>('acp_get_registry');
        set({ registry });
      } catch (fallbackError) {
        set({
          error: `${refreshError}; failed to load cached ACP Registry: ${String(fallbackError)}`,
        });
      }
    }
  },

  setAgentEnabled: async (agentId, enabled) => {
    const config = await invoke<AcpAgentsFile>('acp_set_agent_enabled', { agentId, enabled });
    _acpConfigMutationVersion += 1;
    set({ config, configError: null });
    prewarmConfiguredAgents();
  },

  previewFromRegistry: async (agentId) => {
    return invoke<RegistryAddPreview>('acp_preview_registry_agent', { agentId });
  },

  addFromRegistry: async (agentId, options) => {
    const config = await invoke<AcpAgentsFile>('acp_add_agent_from_registry', {
      agentId,
      enabled: true,
      allowInstaller: options?.allowInstaller ?? false,
      approvalToken: options?.approvalToken ?? null,
    });
    _acpConfigMutationVersion += 1;
    set({ config, configError: null });
    prewarmConfiguredAgents();
  },

  saveGeneral: async (general) => {
    const config = await invoke<AcpAgentsFile>('acp_save_general', { general });
    _acpConfigMutationVersion += 1;
    set({
      config,
      configError: null,
      permissionMode: mapPermissionDefaultToMode(config.general?.permissionDefault),
    });
    prewarmConfiguredAgents();
  },

  setPermissionMode: async (mode) => {
    const current = get().config;
    if (!current) return;
    const general = {
      ...current.general,
      permissionDefault: mapModeToPermissionDefault(mode),
    };
    await get().saveGeneral(general);
    set({ permissionMode: mode });
  },

  upsertCustom: async (agent) => {
    const config = await invoke<AcpAgentsFile>('acp_upsert_custom_agent', { agent });
    _acpConfigMutationVersion += 1;
    set({ config, configError: null });
    prewarmConfiguredAgents();
  },

  removeAgent: async (agentId) => {
    const config = await invoke<AcpAgentsFile>('acp_remove_agent', { agentId });
    _acpConfigMutationVersion += 1;
    set({ config, configError: null });
    prewarmConfiguredAgents();
  },

  reorderAgents: async (agentIds) => {
    const config = await invoke<AcpAgentsFile>('acp_reorder_agents', { agentIds });
    _acpConfigMutationVersion += 1;
    set({ config, configError: null });
  },

  loadProjects: async () => {
    const generation = ++_acpProjectsLoadGeneration;
    try {
      const projects = await invoke<AcpProject[]>('acp_list_projects');
      if (generation !== _acpProjectsLoadGeneration) return;
      set({ projects, projectsReady: true });
    } catch (e) {
      if (generation !== _acpProjectsLoadGeneration) return;
      set({ projectsReady: true, error: String(e) });
    }
  },

  setProjectsOrder: (projects) => {
    set({ projects });
  },

  reorderProjects: async (projectIds) => {
    await invoke('acp_reorder_projects', { projectIds });
    // Keep local sort_order in sync
    set((s) => {
      const orderedUserProjects = projectIds
        .map((id, i) => {
          const p = s.projects.find((x) => x.id === id);
          return p ? { ...p, sort_order: i } : null;
        })
        .filter(Boolean) as AcpProject[];
      return {
        projects: [
          ...orderedUserProjects,
          ...s.projects.filter((project) => project.kind !== 'project'),
        ],
      };
    });
  },

  createProject: async (name, rootPath) => {
    const project = await invoke<AcpProject>('acp_create_project', { name, rootPath });
    await get().loadProjects();
    await get().loadAllThreads();
    return project;
  },

  ensureRecentDraft: async () => {
    if (_acpRecentDraftInFlight) return _acpRecentDraftInFlight;
    const task = invoke<AcpProject>('acp_ensure_recent_draft')
      .then((project) => {
        // A list request started before this mutation must not erase the
        // authoritative project returned by the command when it resolves late.
        _acpProjectsLoadGeneration += 1;
        set((state) => ({
          projects: [
            ...state.projects.filter((item) => item.id !== project.id),
            project,
          ],
          projectsReady: true,
          ...(!state.activeProjectId && !state.activeThreadId
            ? {
                activeProjectId: project.id,
                activeThreadId: null,
                threads: [],
                messages: [],
              }
            : {}),
        }));
        return project;
      })
      .catch((error) => {
        set({ error: String(error) });
        throw error;
      })
      .finally(() => {
        if (_acpRecentDraftInFlight === task) _acpRecentDraftInFlight = null;
      });
    _acpRecentDraftInFlight = task;
    return task;
  },

  updateProject: async (projectId, patch) => {
    const project = await invoke<AcpProject>('acp_update_project', {
      projectId,
      name: patch.name,
      rootPath: patch.rootPath,
    });
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? project : p)),
    }));
    return project;
  },

  deleteProject: async (projectId) => {
    const stateBeforeDelete = get();
    const sessionKeys = projectSessionKeys(stateBeforeDelete, projectId);
    const clearsRecentDraft = stateBeforeDelete.projects.some(
      (project) => project.id === projectId && project.kind !== 'project',
    );
    await invoke('acp_delete_project', { projectId });
    _acpThreadListLoadVersion.set(
      projectId,
      (_acpThreadListLoadVersion.get(projectId) ?? 0) + 1,
    );
    for (const sessionKey of sessionKeys) retireAcpSessionKey(sessionKey);
    const streamingMessageIds = takeStreamingMessageIdsForSessions(sessionKeys);
    set((state) => ({
      ...clearAcpSessionState(state, sessionKeys, streamingMessageIds),
      projects: state.projects.filter((project) => project.id !== projectId),
      threads: state.threads.filter((thread) => thread.project_id !== projectId),
      allThreads: state.allThreads.filter((thread) => thread.project_id !== projectId),
      composerDraftsByScope: omitComposerDrafts(
        state.composerDraftsByScope,
        (scopeKey) => scopeKey.startsWith(`${projectId}:`)
          || (clearsRecentDraft && scopeKey === 'recent:draft'),
      ),
      ...(state.activeProjectId === projectId ? { activeProjectId: null } : {}),
    }));
    await Promise.all([get().loadProjects(), get().loadAllThreads()]);
  },

  selectProject: async (projectId) => {
    set((state) => ({
      activeProjectId: projectId,
      activeThreadId: null,
      messages: [],
      threads: projectId
        ? state.allThreads.filter((thread) => thread.project_id === projectId)
        : [],
    }));
    if (projectId) {
      await get().loadThreads(projectId);
    }
  },

  loadThreads: async (projectId) => {
    const version = (_acpThreadListLoadVersion.get(projectId) ?? 0) + 1;
    _acpThreadListLoadVersion.set(projectId, version);
    const threads = await invoke<AcpThread[]>('acp_list_threads', { projectId });
    if (_acpThreadListLoadVersion.get(projectId) !== version) return;
    set((s) => ({
      ...(s.activeProjectId === projectId ? { threads } : {}),
      allThreads: replaceProjectThreadsInPlace(s.allThreads, projectId, threads),
    }));
  },

  loadAllThreads: async () => {
    const generation = ++_acpAllThreadsLoadGeneration;
    try {
      const allThreads = await invoke<AcpThread[]>('acp_list_all_threads');
      if (generation !== _acpAllThreadsLoadGeneration) return;
      const { activeProjectId } = get();
      set({
        allThreads,
        threadsReady: true,
        ...(activeProjectId
          ? { threads: allThreads.filter((th) => th.project_id === activeProjectId) }
          : {}),
      });
    } catch (e) {
      if (generation !== _acpAllThreadsLoadGeneration) return;
      set({ threadsReady: true, error: String(e) });
    }
  },

  warmBootstrap: () => {
    if (_acpBootstrapInFlight) return;
    // Revalidate cached state once per renderer lifetime. Process prewarm is
    // global; conversation sessions remain lazy and are prepared on selection.
    const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    const loading = Promise.all([
      get().loadConfig(),
      get().loadProjects(),
      get().loadAllThreads(),
    ]).then(async () => {
      if (!desktop) return;
      // Start from the validated local configuration immediately. Registry
      // refresh is optional network I/O (up to its request timeout) and must
      // never delay Agent readiness at application startup.
      await prewarmConfiguredAgents();
      if (get().config?.general.registryRefresh === 'on_start') {
        await get().loadRegistry(true);
      }
    });
    _acpBootstrapInFlight = loading;
    if (desktop) {
      void ensureAcpEventsBound(get().bindEvents).catch((error) => {
        console.warn('Failed to bind ACP event listeners', error);
      });
    }
  },

  createThread: async (projectId, agentId, title) => {
    const draftKey = `draft:${projectId}:${agentId}`;
    const selectionBeforeCreate = {
      projectId: get().activeProjectId,
      threadId: get().activeThreadId,
    };
    const claimingRecentDraft = get().projects.some(
      (project) => project.id === projectId && project.kind === 'recent_draft',
    );
    set({ creatingThread: true });
    let thread: AcpThread;
    try {
      thread = await invoke<AcpThread>('acp_create_thread', {
        projectId,
        agentId,
        title: title ?? null,
      });
    } catch (error) {
      set({ creatingThread: false });
      throw error;
    }
    _acpThreadListLoadVersion.set(
      projectId,
      (_acpThreadListLoadVersion.get(projectId) ?? 0) + 1,
    );
    if (claimingRecentDraft) _acpProjectsLoadGeneration += 1;
    set((state) => {
      const activateCreatedThread = selectionBeforeCreate.projectId === projectId
        && selectionBeforeCreate.threadId === null
        && state.activeProjectId === selectionBeforeCreate.projectId
        && state.activeThreadId === selectionBeforeCreate.threadId;
      const draftSnapshot = state.sessionByThread[draftKey];
      const { [draftKey]: _adoptedDraft, ...remainingSessions } = state.sessionByThread;
      const { [draftKey]: draftReasoning, ...remainingReasoning } =
        state.spawnReasoningByThread;
      const { [draftKey]: draftModel, ...remainingModels } = state.spawnModelByThread;
      return {
        ...(claimingRecentDraft
          ? {
              projects: state.projects.map((project) => (
                project.id === projectId
                  ? { ...project, kind: 'recent' as const, name: thread.title }
                  : project
              )),
            }
          : {}),
        ...(activateCreatedThread
          ? {
              activeProjectId: projectId,
              activeThreadId: thread.id,
              threads: [
                thread,
                ...state.threads.filter((item) => (
                  item.id !== thread.id && item.project_id === projectId
                )),
              ],
              messages: [],
            }
          : {}),
        allThreads: [thread, ...state.allThreads.filter((item) => item.id !== thread.id)],
        sessionByThread: {
          ...remainingSessions,
          ...(draftSnapshot ? { [thread.id]: draftSnapshot } : {}),
        },
        spawnReasoningByThread: {
          ...remainingReasoning,
          ...(draftReasoning ? { [thread.id]: draftReasoning } : {}),
        },
        spawnModelByThread: {
          ...remainingModels,
          ...(draftModel ? { [thread.id]: draftModel } : {}),
        },
      };
    });
    if (!get().sessionByThread[thread.id]) {
      void get().prepareSession(thread.id).catch(() => undefined);
    }
    // The create receipt is authoritative for the first turn. Sidebar caches
    // reconcile in the background and must not delay prompt scheduling.
    const refreshes = [get().loadThreads(projectId), get().loadAllThreads()];
    if (claimingRecentDraft) refreshes.push(get().loadProjects());
    void Promise.all(refreshes).catch((error) => {
      set({ error: String(error) });
    });
    set({ creatingThread: false });
    return thread;
  },

  createRecentThread: async (agentId, title) => {
    const { project, thread } = await invoke<AcpRecentThreadReceipt>('acp_create_recent_thread', {
      agentId,
      title: title ?? null,
    });
    set((state) => ({
      projects: [
        ...state.projects.filter((item) => item.id !== project.id),
        project,
      ],
      activeProjectId: thread.project_id,
      activeThreadId: thread.id,
      threads: [thread],
      allThreads: [thread, ...state.allThreads.filter((item) => item.id !== thread.id)],
      messages: [],
    }));
    void get().prepareSession(thread.id).catch(() => undefined);
    return thread;
  },

  deleteThread: async (threadId) => {
    const stateBeforeDelete = get();
    const threadBeforeDelete = [...stateBeforeDelete.threads, ...stateBeforeDelete.allThreads]
      .find((thread) => thread.id === threadId);
    const deletedComposerScope = threadBeforeDelete
      ? `${threadBeforeDelete.project_id}:${threadId}`
      : null;
    const recentProjectId = stateBeforeDelete.projects.find(
      (project) => project.id === threadBeforeDelete?.project_id && project.kind === 'recent',
    )?.id;
    await invoke('acp_delete_thread', { threadId });
    retireAcpSessionKey(threadId);
    const { activeProjectId } = get();
    const deletedKeys = new Set([threadId]);
    const streamingMessageIds = takeStreamingMessageIdsForSessions(deletedKeys);
    set((state) => ({
      ...clearAcpSessionState(state, deletedKeys, streamingMessageIds),
      threads: state.threads.filter((thread) => thread.id !== threadId),
      allThreads: state.allThreads.filter((thread) => thread.id !== threadId),
      composerDraftsByScope: omitComposerDrafts(
        state.composerDraftsByScope,
        (scopeKey) => scopeKey === deletedComposerScope,
      ),
      ...(recentProjectId
        ? { projects: state.projects.filter((project) => project.id !== recentProjectId) }
        : {}),
      ...(recentProjectId && state.activeProjectId === recentProjectId
        ? { activeProjectId: null }
        : {}),
    }));
    if (activeProjectId && activeProjectId !== recentProjectId) {
      await get().loadThreads(activeProjectId);
    }
    await get().loadAllThreads();
  },

  batchDeleteThreads: async (threadIds) => {
    const uniqueIds = [...new Set(threadIds)].filter(Boolean);
    if (uniqueIds.length === 0) return;

    const stateBeforeDelete = get();
    const knownThreads = [...stateBeforeDelete.threads, ...stateBeforeDelete.allThreads];
    const threadById = new Map(knownThreads.map((item) => [item.id, item]));
    const deletedIds: string[] = [];
    const errors: string[] = [];

    for (const threadId of uniqueIds) {
      try {
        await invoke('acp_delete_thread', { threadId });
        deletedIds.push(threadId);
        retireAcpSessionKey(threadId);
      } catch (error) {
        errors.push(String(error));
      }
    }

    if (deletedIds.length === 0) {
      if (errors.length) set({ error: errors.join('; ') });
      return;
    }

    const deletedKeys = new Set(deletedIds);
    const deletedComposerScopes = new Set(
      deletedIds.flatMap((threadId) => {
        const thread = threadById.get(threadId);
        return thread ? [`${thread.project_id}:${threadId}`] : [];
      }),
    );
    const recentProjectIds = new Set(
      deletedIds.flatMap((threadId) => {
        const thread = threadById.get(threadId);
        if (!thread) return [];
        const recentProject = stateBeforeDelete.projects.find(
          (item) => item.id === thread.project_id && item.kind === 'recent',
        );
        return recentProject ? [recentProject.id] : [];
      }),
    );
    const streamingMessageIds = takeStreamingMessageIdsForSessions(deletedKeys);
    const { activeProjectId } = get();

    set((state) => ({
      ...clearAcpSessionState(state, deletedKeys, streamingMessageIds),
      threads: state.threads.filter((item) => !deletedKeys.has(item.id)),
      allThreads: state.allThreads.filter((item) => !deletedKeys.has(item.id)),
      composerDraftsByScope: omitComposerDrafts(
        state.composerDraftsByScope,
        (scopeKey) => deletedComposerScopes.has(scopeKey),
      ),
      ...(recentProjectIds.size > 0
        ? { projects: state.projects.filter((item) => !recentProjectIds.has(item.id)) }
        : {}),
      ...(activeProjectId && recentProjectIds.has(activeProjectId)
        ? { activeProjectId: null }
        : {}),
      error: errors.length ? errors.join('; ') : null,
    }));

    const remainingActiveProjectId = get().activeProjectId;
    if (remainingActiveProjectId) {
      await get().loadThreads(remainingActiveProjectId);
    }
    await get().loadAllThreads();
  },

  renameThread: async (threadId, title) => {
    const thread = await invoke<AcpThread>('acp_rename_thread', { threadId, title });
    const patch = (list: AcpThread[]) =>
      list.map((th) => (th.id === threadId ? { ...th, ...thread } : th));
    set((s) => ({
      threads: patch(s.threads),
      allThreads: patch(s.allThreads),
    }));
    return thread;
  },

  toggleThreadPin: async (threadId) => {
    const thread = await invoke<AcpThread>('acp_toggle_thread_pin', { threadId });
    // Reload to re-apply pin/sort ordering from backend
    await get().loadAllThreads();
    const { activeProjectId } = get();
    if (activeProjectId) await get().loadThreads(activeProjectId);
    return thread;
  },

  setThreadsOrder: (projectId, ordered) => {
    set((s) => {
      const others = s.allThreads.filter((th) => th.project_id !== projectId);
      const allThreads = [...others, ...ordered];
      return {
        allThreads,
        ...(s.activeProjectId === projectId ? { threads: ordered } : {}),
      };
    });
  },

  reorderThreads: async (projectId, threadIds) => {
    await invoke('acp_reorder_threads', { projectId, threadIds });
    set((s) => {
      const byId = new Map(
        [...s.threads, ...s.allThreads]
          .filter((th) => th.project_id === projectId)
          .map((th) => [th.id, th]),
      );
      const ordered = threadIds
        .map((id, i) => {
          const th = byId.get(id);
          return th ? { ...th, sort_order: i } : null;
        })
        .filter(Boolean) as AcpThread[];
      const others = s.allThreads.filter((th) => th.project_id !== projectId);
      return {
        allThreads: [...others, ...ordered],
        ...(s.activeProjectId === projectId ? { threads: ordered } : {}),
      };
    });
  },

  duplicateThread: async (threadId, titleSuffix) => {
    const thread = await invoke<AcpThread>('acp_duplicate_thread', {
      threadId,
      titleSuffix: titleSuffix ?? null,
    });
    await get().loadAllThreads();
    const { activeProjectId } = get();
    if (activeProjectId === thread.project_id) {
      await get().loadThreads(thread.project_id);
    }
    return thread;
  },

  selectThread: async (threadId) => {
    if (!threadId) {
      set({ activeThreadId: null, messages: [] });
      return;
    }
    const thread =
      get().allThreads.find((th) => th.id === threadId)
      ?? get().threads.find((th) => th.id === threadId)
      ?? null;

    if (thread) {
      const needsProjectSwitch = get().activeProjectId !== thread.project_id;
      set({
        activeProjectId: thread.project_id,
        activeThreadId: threadId,
        messages: [],
        ...(needsProjectSwitch
          ? {
              threads: get().allThreads.filter((th) => th.project_id === thread.project_id),
            }
          : {}),
      });
      if (needsProjectSwitch) {
        await get().loadThreads(thread.project_id);
      }
    } else {
      set({ activeThreadId: threadId, messages: [] });
    }
    await get().loadMessages(threadId);
    if (!get().sessionByThread[threadId]) {
      void get().prepareSession(threadId).catch(() => undefined);
    }
  },

  restoreLastSession: async () => {
    const { activeProjectId, activeThreadId, projects, allThreads } = get();
    if (!activeProjectId && !activeThreadId) return;

    let projectId = activeProjectId;
    let threadId = activeThreadId;

    // Prefer the last thread; derive project from it when still present.
    if (threadId) {
      const thread = allThreads.find((th) => th.id === threadId);
      if (!thread) {
        threadId = null;
        set({ activeThreadId: null, messages: [] });
      } else {
        projectId = thread.project_id;
      }
    }

    if (projectId && !projects.some((p) => p.id === projectId)) {
      set({
        activeProjectId: null,
        activeThreadId: null,
        messages: [],
        threads: [],
      });
      return;
    }

    if (projectId) {
      set({
        activeProjectId: projectId,
        ...(threadId ? { activeThreadId: threadId } : {}),
        threads: allThreads.filter((th) => th.project_id === projectId),
      });
      try {
        await get().loadThreads(projectId);
      } catch {
        /* keep cached threads for project */
      }
    }

    // User navigation that happened while the cached selection was being
    // revalidated is authoritative; never resurrect the startup selection.
    if (
      get().activeProjectId !== projectId
      || get().activeThreadId !== threadId
    ) return;

    if (threadId) {
      // Re-validate after loadThreads (thread may have been deleted server-side)
      const stillThere =
        get().allThreads.some((th) => th.id === threadId)
        || get().threads.some((th) => th.id === threadId);
      if (!stillThere) {
        set({ activeThreadId: null, messages: [] });
        return;
      }
      set({ activeThreadId: threadId });
      await get().loadMessages(threadId);
    }
  },

  loadMessages: async (threadId) => {
    const version = (_acpMessageLoadVersion.get(threadId) ?? 0) + 1;
    _acpMessageLoadVersion.set(threadId, version);
    set((state) => {
      const messagesErrorByThread = { ...state.messagesErrorByThread };
      delete messagesErrorByThread[threadId];
      return {
        messagesLoadingByThread: {
          ...state.messagesLoadingByThread,
          [threadId]: true,
        },
        messagesErrorByThread,
      };
    });
    let messages: AcpMessage[];
    try {
      messages = await invoke<AcpMessage[]>('acp_list_messages', { threadId });
    } catch (error) {
      if (_acpMessageLoadVersion.get(threadId) !== version) return;
      set((state) => ({
        messagesLoadingByThread: {
          ...state.messagesLoadingByThread,
          [threadId]: false,
        },
        messagesErrorByThread: {
          ...state.messagesErrorByThread,
          [threadId]: String(error),
        },
      }));
      return;
    }
    if (_acpMessageLoadVersion.get(threadId) !== version) return;
    // If a turn is still running, preserve local streaming content so a mid-turn
    // reload does not wipe the live buffer or revive a stuck spinner.
    set((s) => {
      const messagesLoadingByThread = {
        ...s.messagesLoadingByThread,
        [threadId]: false,
      };
      const messagesErrorByThread = { ...s.messagesErrorByThread };
      delete messagesErrorByThread[threadId];
      if (s.activeThreadId !== threadId) {
        return { messagesLoadingByThread, messagesErrorByThread };
      }
      const hydratedTools = persistedToolCalls(messages);
      const toolCallsForOtherThreads = removeThreadEntries(s.toolCalls, threadId);
      const hydratedPlans = persistedPlanDocuments(messages);
      const hydratedThreadPlans = hydratedPlans[threadId] ?? [];
      // Keep live in-memory plan docs (pending reviews / richer content) while
      // still filling gaps from durable markers after a refresh.
      const livePlans = s.planDocumentsByThread[threadId] ?? [];
      const planById = new Map<string, AcpPlanDocument>();
      for (const doc of hydratedThreadPlans) planById.set(doc.id, doc);
      for (const doc of livePlans) {
        const existing = planById.get(doc.id);
        if (!existing) {
          planById.set(doc.id, doc);
          continue;
        }
        // Live session state wins on conflict (status / feedback); prefer the
        // longer plan body so neither side loses content on reload.
        planById.set(doc.id, {
          ...existing,
          ...doc,
          content: (doc.content?.length ?? 0) >= (existing.content?.length ?? 0)
            ? doc.content
            : existing.content,
          title: doc.title ?? existing.title,
          messageId: doc.messageId ?? existing.messageId,
          feedback: doc.feedback ?? existing.feedback,
          sequence: Math.min(existing.sequence, doc.sequence),
          createdAt: existing.createdAt || doc.createdAt,
        });
      }
      const mergedPlans = [...planById.values()].sort((a, b) => a.sequence - b.sequence);
      const planDocumentsByThread = {
        ...s.planDocumentsByThread,
        [threadId]: mergedPlans,
      };

      if (!s.runningByThread[threadId]) {
        return {
          messages,
          messagesLoadingByThread,
          messagesErrorByThread,
          toolCalls: { ...toolCallsForOtherThreads, ...hydratedTools },
          planDocumentsByThread,
        };
      }
      const localById = new Map(s.messages.map((m) => [m.id, m]));
      const merged = messages.map((m) => {
        const local = localById.get(m.id);
        if (!local) return m;
        const streamed = s.streamingText[m.id];
        if (streamed && streamed.length >= (m.content?.length ?? 0)) {
          return { ...m, content: streamed, status: 'streaming' as const };
        }
        if ((local.content?.length ?? 0) > (m.content?.length ?? 0)) {
          return { ...m, content: local.content, status: local.status ?? m.status };
        }
        return m;
      });
      return {
        messages: merged,
        messagesLoadingByThread,
        messagesErrorByThread,
        toolCalls: { ...toolCallsForOtherThreads, ...hydratedTools, ...s.toolCalls },
        planDocumentsByThread,
      };
    });
  },

  prepareDraft: async (projectId, agentId) => {
    const key = `draft:${projectId}:${agentId}`;
    const existing = _acpPrepareInFlight.get(key);
    if (existing) return existing;
    const lifecycleVersion = _acpSessionLifecycleVersion.get(key) ?? 0;
    set((s) => ({
      preparingByThread: { ...s.preparingByThread, [key]: true },
    }));
    const task = invoke<AcpSessionSnapshot>('acp_prepare_draft', {
      projectId,
      agentId,
      modelId: get().spawnModelByThread[key] ?? null,
      reasoningEffort: get().spawnReasoningByThread[key] ?? null,
    })
      .then((snapshot) => {
        if ((_acpSessionLifecycleVersion.get(key) ?? 0) !== lifecycleVersion) {
          throw new Error('ACP draft preparation was superseded');
        }
        set((s) => ({
          sessionByThread: { ...s.sessionByThread, [key]: snapshot },
        }));
        return snapshot;
      })
      .catch((error) => {
        if ((_acpSessionLifecycleVersion.get(key) ?? 0) === lifecycleVersion) {
          set((s) => ({
            statusByThread: { ...s.statusByThread, [key]: String(error) },
            error: String(error),
          }));
        }
        throw error;
      })
      .finally(() => {
        if (_acpPrepareInFlight.get(key) === task) {
          _acpPrepareInFlight.delete(key);
        }
        if ((_acpSessionLifecycleVersion.get(key) ?? 0) === lifecycleVersion) {
          set((s) => ({
            preparingByThread: { ...s.preparingByThread, [key]: false },
          }));
        }
      });
    _acpPrepareInFlight.set(key, task);
    return task;
  },

  prepareSession: async (threadId) => {
    const existing = _acpPrepareInFlight.get(threadId);
    if (existing) return existing;
    const lifecycleVersion = _acpSessionLifecycleVersion.get(threadId) ?? 0;
    set((s) => ({
      preparingByThread: { ...s.preparingByThread, [threadId]: true },
    }));
    const task = invoke<AcpSessionSnapshot>('acp_prepare_session', {
      threadId,
      modelId: get().spawnModelByThread[threadId] ?? null,
      reasoningEffort: get().spawnReasoningByThread[threadId] ?? null,
    })
      .then((snapshot) => {
        if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) !== lifecycleVersion) {
          throw new Error('ACP session preparation was superseded');
        }
        set((s) => ({
          sessionByThread: { ...s.sessionByThread, [threadId]: snapshot },
          statusByThread: { ...s.statusByThread, [threadId]: '' },
          threads: s.threads.map((thread) => (
            thread.id === threadId
              ? { ...thread, mode_id: snapshotCurrentMode(snapshot) }
              : thread
          )),
          allThreads: s.allThreads.map((thread) => (
            thread.id === threadId
              ? { ...thread, mode_id: snapshotCurrentMode(snapshot) }
              : thread
          )),
        }));
        return snapshot;
      })
      .catch((error) => {
        if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) === lifecycleVersion) {
          set((s) => ({
            statusByThread: { ...s.statusByThread, [threadId]: String(error) },
            error: String(error),
          }));
        }
        throw error;
      })
      .finally(() => {
        if (_acpPrepareInFlight.get(threadId) === task) {
          _acpPrepareInFlight.delete(threadId);
        }
        if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) === lifecycleVersion) {
          set((s) => ({
            preparingByThread: { ...s.preparingByThread, [threadId]: false },
          }));
        }
      });
    _acpPrepareInFlight.set(threadId, task);
    return task;
  },

  setConfigOption: (threadId, configId, value) => {
    const lifecycleVersion = _acpSessionLifecycleVersion.get(threadId) ?? 0;
    return serializeAcpSessionMutation(threadId, async () => {
      if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) !== lifecycleVersion) return;
      const before = get().sessionByThread[threadId]?.configOptions.find(
        (option) => option.id === configId,
      );
      let snapshot: AcpSessionSnapshot;
      try {
        snapshot = await invoke<AcpSessionSnapshot>('acp_set_config_option', {
          threadId,
          configId,
          value,
        });
      } catch (error) {
        if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) !== lifecycleVersion) return;
        throw error;
      }
      if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) !== lifecycleVersion) return;
      const after = snapshot.configOptions.find((option) => option.id === configId);
      const spawnArg = after?._meta?.aqbotSpawnArg;
      const category = after?.category ?? before?.category;
      const isModelControl = category === 'model'
        || before?._meta?.aqbotSpawnArg === '--model'
        || spawnArg === '--model';
      const isReasoningControl = category === 'thought_level'
        || /reasoning|effort/i.test(configId)
        || before?._meta?.aqbotSpawnArg === '--reasoning-effort'
        || spawnArg === '--reasoning-effort';
      set((s) => ({
        sessionByThread: { ...s.sessionByThread, [threadId]: snapshot },
        threads: s.threads.map((thread) => (
          thread.id === threadId
            ? { ...thread, mode_id: snapshotCurrentMode(snapshot) }
            : thread
        )),
        allThreads: s.allThreads.map((thread) => (
          thread.id === threadId
            ? { ...thread, mode_id: snapshotCurrentMode(snapshot) }
            : thread
        )),
        ...(isModelControl && typeof value === 'string'
          ? {
              spawnModelByThread: spawnArg !== '--model' || value === '__agent_default'
                ? Object.fromEntries(
                    Object.entries(s.spawnModelByThread).filter(([key]) => key !== threadId),
                  )
                : { ...s.spawnModelByThread, [threadId]: value },
            }
          : {}),
        ...(isReasoningControl && typeof value === 'string'
          ? {
              spawnReasoningByThread: spawnArg !== '--reasoning-effort'
                || value === '__agent_default'
                ? Object.fromEntries(
                    Object.entries(s.spawnReasoningByThread).filter(([key]) => key !== threadId),
                  )
                : { ...s.spawnReasoningByThread, [threadId]: value },
            }
          : {}),
      }));
    });
  },

  setSessionMode: (threadId, modeId) => {
    const lifecycleVersion = _acpSessionLifecycleVersion.get(threadId) ?? 0;
    return serializeAcpSessionMutation(threadId, async () => {
      if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) !== lifecycleVersion) return;
      let snapshot: AcpSessionSnapshot;
      try {
        snapshot = await invoke<AcpSessionSnapshot>('acp_set_mode', { threadId, modeId });
      } catch (error) {
        if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) !== lifecycleVersion) return;
        throw error;
      }
      if ((_acpSessionLifecycleVersion.get(threadId) ?? 0) !== lifecycleVersion) return;
      set((s) => {
        const syncMode = (thread: AcpThread) =>
          thread.id === threadId ? { ...thread, mode_id: modeId } : thread;
        return {
          sessionByThread: { ...s.sessionByThread, [threadId]: snapshot },
          threads: s.threads.map(syncMode),
          allThreads: s.allThreads.map(syncMode),
        };
      });
    });
  },

  cancelPrompt: async (threadId) => {
    clearFirstOutputTimer(threadId);
    const previousStatus = get().statusByThread[threadId] ?? '';
    const previousTurnActivity = get().turnActivityByThread[threadId] ?? false;
    set((s) => {
      const nextFollowUps = { ...s.planFollowUpByThread };
      delete nextFollowUps[threadId];
      return {
        cancellingByThread: { ...s.cancellingByThread, [threadId]: true },
        turnActivityByThread: { ...s.turnActivityByThread, [threadId]: true },
        statusByThread: { ...s.statusByThread, [threadId]: ACP_STATUS_CANCELLING },
        planFollowUpByThread: nextFollowUps,
      };
    });
    try {
      const cancelled = await invoke<boolean>('acp_cancel', { threadId });
      if (!cancelled) throw new Error('No active ACP turn to cancel');
      await get().loadMessages(threadId);
      if (get().messagesErrorByThread[threadId]) {
        set((s) => {
          const messageIds = new Set(
            s.messages
              .filter((message) => message.thread_id === threadId)
              .map((message) => message.id),
          );
          return {
            messages: s.messages.map((message) => (
              message.thread_id === threadId && message.status === 'streaming'
                ? { ...message, status: 'done' as const }
                : message
            )),
            streamingText: Object.fromEntries(
              Object.entries(s.streamingText).filter(([messageId]) => !messageIds.has(messageId)),
            ),
            runningByThread: { ...s.runningByThread, [threadId]: false },
            cancellingByThread: { ...s.cancellingByThread, [threadId]: false },
            turnActivityByThread: { ...s.turnActivityByThread, [threadId]: true },
            statusByThread: { ...s.statusByThread, [threadId]: '' },
            planByThread: {
              ...s.planByThread,
              [threadId]: { entries: [], completed: 0, total: 0 },
            },
            planDocumentsByThread: finalizePendingPlanDocuments(
              s.planDocumentsByThread,
              threadId,
            ),
            pendingPermissions: removeThreadEntries(s.pendingPermissions, threadId),
            toolCalls: finalizeUnfinishedToolCalls(s.toolCalls, threadId, 'cancelled'),
          };
        });
        return;
      }
      const stillStreaming = get().messages.some(
        (message) => message.thread_id === threadId && message.status === 'streaming',
      );
      if (!stillStreaming) {
        set((s) => ({
          runningByThread: { ...s.runningByThread, [threadId]: false },
          cancellingByThread: { ...s.cancellingByThread, [threadId]: false },
          statusByThread: { ...s.statusByThread, [threadId]: '' },
          planDocumentsByThread: finalizePendingPlanDocuments(
            s.planDocumentsByThread,
            threadId,
          ),
          pendingPermissions: removeThreadEntries(s.pendingPermissions, threadId),
        }));
      }
    } catch (error) {
      set((s) => {
        const cancellationIsStillCurrent =
          s.statusByThread[threadId] === ACP_STATUS_CANCELLING;
        return {
          cancellingByThread: { ...s.cancellingByThread, [threadId]: false },
          ...(cancellationIsStillCurrent
            ? {
                statusByThread: {
                  ...s.statusByThread,
                  [threadId]: previousStatus,
                },
                turnActivityByThread: {
                  ...s.turnActivityByThread,
                  [threadId]: previousTurnActivity,
                },
              }
            : {}),
        };
      });
      throw error;
    }
  },

  sendPrompt: async (threadId, prompt, attachments) => {
    // Invalidate any list request started before this turn. Its snapshot cannot
    // contain the rows created below and must never erase them when it resolves.
    _acpMessageLoadVersion.set(threadId, (_acpMessageLoadVersion.get(threadId) ?? 0) + 1);
    const optimisticSequence = ++_acpOptimisticMessageSeq;
    const optimisticUserId = `optimistic-user:${threadId}:${optimisticSequence}`;
    const optimisticAssistantId = `optimistic-assistant:${threadId}:${optimisticSequence}`;
    const optimisticCreatedAt = new Date().toISOString();
    clearFirstOutputTimer(threadId);
    set((s) => ({
      runningByThread: { ...s.runningByThread, [threadId]: true },
      turnActivityByThread: { ...s.turnActivityByThread, [threadId]: false },
      statusByThread: { ...s.statusByThread, [threadId]: '' },
      planDocumentsByThread: finalizePendingPlanDocuments(
        s.planDocumentsByThread,
        threadId,
      ),
      pendingPermissions: removeThreadEntries(s.pendingPermissions, threadId),
      error: null,
      messages: s.activeThreadId === threadId
        ? [
            ...s.messages,
            {
              id: optimisticUserId,
              thread_id: threadId,
              role: 'user',
              content: prompt,
              status: 'done',
              attachments: [],
              created_at: optimisticCreatedAt,
            },
            {
              id: optimisticAssistantId,
              thread_id: threadId,
              role: 'assistant',
              content: '',
              status: 'streaming',
              attachments: [],
              created_at: optimisticCreatedAt,
            },
          ]
        : s.messages,
    }));
    const firstOutputTimer = setTimeout(() => {
      _acpFirstOutputTimers.delete(threadId);
      const state = get();
      const lastAssistant = [...state.messages]
        .reverse()
        .find((message) => message.thread_id === threadId && message.role === 'assistant');
      const hasBody = !!lastAssistant?.content?.trim();
      const hasPermission = Object.values(state.pendingPermissions).some(
        (permission) => permission.threadId === threadId && permission.status === 'pending',
      );
      if (
        !state.runningByThread[threadId]
        || state.turnActivityByThread[threadId]
        || hasBody
        || hasPermission
        || !canReplaceWithFirstOutputSilence(state.statusByThread[threadId])
      ) return;
      set((current) => ({
        statusByThread: {
          ...current.statusByThread,
          [threadId]: ACP_STATUS_FIRST_OUTPUT_SILENCE,
        },
      }));
    }, FIRST_OUTPUT_SILENCE_MS);
    _acpFirstOutputTimers.set(threadId, firstOutputTimer);
    try {
      // A terminal event must never be missed, even on a very fast first turn.
      await ensureAcpEventsBound(get().bindEvents);
      const accepted = await invoke<AcpPromptAccepted>('acp_prompt', {
        threadId,
        prompt,
        attachments: attachments ?? null,
        modelId: get().spawnModelByThread[threadId] ?? null,
        reasoningEffort: get().spawnReasoningByThread[threadId] ?? null,
      });
      _acpMessageLoadVersion.set(threadId, (_acpMessageLoadVersion.get(threadId) ?? 0) + 1);
      // The command returns the exact persisted rows. Installing this receipt is
      // atomic and avoids a second DB read racing an older empty list request.
      set((s) => {
        if (s.activeThreadId !== threadId) return s;
        const existingAssistant = s.messages.find(
          (message) => message.id === accepted.assistantMessage.id,
        );
        const assistantMessage = existingAssistant
          ? {
              ...accepted.assistantMessage,
              content: existingAssistant.content || accepted.assistantMessage.content,
              status: existingAssistant.status ?? accepted.assistantMessage.status,
              meta_json: existingAssistant.meta_json ?? accepted.assistantMessage.meta_json,
            }
          : accepted.assistantMessage;
        const acceptedIds = new Set([
          accepted.userMessage.id,
          accepted.assistantMessage.id,
          optimisticUserId,
          optimisticAssistantId,
        ]);
        return {
          messages: [
            ...s.messages.filter((message) => !acceptedIds.has(message.id)),
            accepted.userMessage,
            assistantMessage,
          ],
        };
      });
    } catch (e) {
      clearFirstOutputTimer(threadId);
      set((s) => {
        const optimisticIds = new Set([optimisticUserId, optimisticAssistantId]);
        return {
          runningByThread: { ...s.runningByThread, [threadId]: false },
          turnActivityByThread: { ...s.turnActivityByThread, [threadId]: true },
          messages: s.messages.filter((message) => !optimisticIds.has(message.id)),
          error: String(e),
        };
      });
      throw e;
    }
  },

  respondPermission: async (requestId, optionId, feedback) => {
    const trimmedFeedback = feedback?.trim();
    const existing = get().pendingPermissions[requestId];
    const followUp = existing?.kind === 'plan_review'
      && existing.input.feedbackDelivery === 'follow_up_prompt'
      && trimmedFeedback
      ? { requestId, prompt: trimmedFeedback }
      : undefined;

    if (followUp && existing) {
      set((s) => ({
        planFollowUpByThread: {
          ...s.planFollowUpByThread,
          [existing.threadId]: followUp,
        },
      }));
    }

    try {
      await invoke('acp_respond_permission', {
        requestId,
        optionId,
        feedback: trimmedFeedback || null,
      });
    } catch (error) {
      if (followUp && existing) {
        set((s) => {
          if (s.planFollowUpByThread[existing.threadId]?.requestId !== requestId) return s;
          const nextFollowUps = { ...s.planFollowUpByThread };
          delete nextFollowUps[existing.threadId];
          return { planFollowUpByThread: nextFollowUps };
        });
      }
      throw error;
    }
    set((s) => {
      const current = s.pendingPermissions[requestId] ?? existing;
      if (!current) return s;
      const selectedOption = current.options.find((option) => option.id === optionId);
      const next = resolvedInteractionState(s.pendingPermissions, s.toolCalls, {
        requestId,
        reason: 'selected',
        optionId,
        optionKind: selectedOption?.kind,
        optionLabel: selectedOption?.label,
      });
      if (current.kind !== 'plan_review') return next;
      return {
        ...next,
        planDocumentsByThread: resolvePlanDocument(s.planDocumentsByThread, requestId, {
          status: planDocumentStatusFromResolution(
            optionId,
            'selected',
            selectedOption?.kind,
          ),
          messageId: current.messageId,
          feedback: trimmedFeedback || undefined,
        }),
      };
    });
  },

  cancelInteraction: async (requestId) => {
    const existing = get().pendingPermissions[requestId];
    await invoke('acp_cancel_interaction', { requestId });
    set((s) => {
      const current = s.pendingPermissions[requestId] ?? existing;
      if (!current) return s;
      const next = resolvedInteractionState(s.pendingPermissions, s.toolCalls, {
        requestId,
        reason: 'cancelled',
      });
      if (current.kind !== 'plan_review') return next;
      return {
        ...next,
        planDocumentsByThread: resolvePlanDocument(s.planDocumentsByThread, requestId, {
          status: 'abandoned',
          messageId: current.messageId,
        }),
      };
    });
  },

  respondQuestionnaire: async (requestId, submission) => {
    const redactSummary = questionnaireHasSecret(get().pendingPermissions[requestId]?.input);
    const summary = await invoke<string>('acp_respond_questionnaire', {
      requestId,
      outcome: submission.outcome,
      answers: submission.answers,
    });
    set((s) => resolvedInteractionState(s.pendingPermissions, s.toolCalls, {
      requestId,
      reason: submission.outcome === 'cancelled' ? 'cancelled' : 'selected',
      optionId: submission.outcome,
      optionLabel: redactSummary ? undefined : summary || undefined,
    }));
  },

  bindEvents: async () => {
    // Tear down any previous generation first (StrictMode remount / leave+reenter Agent).
    const gen = ++_acpListenerGen;
    if (_acpUnlisten) {
      _acpUnlisten();
      _acpUnlisten = null;
    }

    const unlisteners: UnlistenFn[] = [];
    const isLive = () => _acpListenerGen === gen;
    const isThreadEventLive = (threadId: string) => (
      isLive() && isAcpSessionKeyLive(threadId)
    );
    const markTurnActivity = (threadId: string) => {
      clearFirstOutputTimer(threadId);
      set((state) => ({
        turnActivityByThread: { ...state.turnActivityByThread, [threadId]: true },
        ...(state.statusByThread[threadId] === ACP_STATUS_FIRST_OUTPUT_SILENCE
          ? { statusByThread: { ...state.statusByThread, [threadId]: '' } }
          : {}),
      }));
    };
    const streamBatch = new Map<string, { threadId: string; text: string }>();
    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStreams = () => {
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = null;
      if (!streamBatch.size || !isLive()) return;
      const batch = [...streamBatch.entries()];
      streamBatch.clear();
      set((s) => {
        const streamingText = { ...s.streamingText };
        const runningByThread = { ...s.runningByThread };
        let messages = s.messages;
        for (const [messageId, pending] of batch) {
          if (!isAcpSessionKeyLive(pending.threadId)) continue;
          const existing = messages.find((message) => message.id === messageId);
          if (
            runningByThread[pending.threadId] === false
            && existing
            && (existing.status === 'done' || existing.status === 'error')
          ) {
            continue;
          }
          const nextStream = mergeStreamChunk(streamingText[messageId] ?? '', pending.text);
          streamingText[messageId] = nextStream;
          runningByThread[pending.threadId] = true;
          if (existing) {
            messages = messages.map((message) =>
              message.id === messageId
                ? { ...message, content: nextStream, status: 'streaming' }
                : message,
            );
          } else if (s.activeThreadId === pending.threadId) {
            messages = [
              ...messages,
              {
                id: messageId,
                thread_id: pending.threadId,
                role: 'assistant',
                content: nextStream,
                status: 'streaming',
                attachments: [],
                created_at: new Date().toISOString(),
              },
            ];
          }
        }
        return { streamingText, runningByThread, messages };
      });
    };
    const queueStream = (threadId: string, messageId: string, text: string) => {
      const pending = streamBatch.get(messageId);
      _acpStreamingMessageThreads.set(messageId, threadId);
      streamBatch.set(messageId, {
        threadId,
        text: mergeStreamChunk(pending?.text ?? '', text),
      });
      if (!streamTimer) streamTimer = setTimeout(flushStreams, 16);
    };

    unlisteners.push(
      await listen<{ threadId: string; messageId: string; text: string }>(
        'acp-stream-text',
        (event) => {
          if (!isThreadEventLive(event.payload.threadId)) return;
          const { threadId, messageId, text } = event.payload;
          markTurnActivity(threadId);
          queueStream(threadId, messageId, text ?? '');
        },
      ),
    );

    unlisteners.push(
      await listen<{ threadId: string; snapshot: AcpSessionSnapshot }>(
        'acp-session-state',
        (event) => {
          if (!isThreadEventLive(event.payload.threadId)) return;
          const { threadId, snapshot } = event.payload;
          const modeId = snapshotCurrentMode(snapshot);
          set((s) => ({
            sessionByThread: { ...s.sessionByThread, [threadId]: snapshot },
            threads: s.threads.map((thread) => (
              thread.id === threadId ? { ...thread, mode_id: modeId } : thread
            )),
            allThreads: s.allThreads.map((thread) => (
              thread.id === threadId ? { ...thread, mode_id: modeId } : thread
            )),
          }));
        },
      ),
    );

    unlisteners.push(
      await listen<{ threadId: string; messageId?: string; raw: Record<string, unknown> }>(
        'acp-plan',
        (event) => {
          if (!isThreadEventLive(event.payload.threadId)) return;
          const { threadId, raw } = event.payload;
          const plan = normalizePlan(raw ?? {});
          // Ignore plan-review documents / non-structured payloads so they
          // never overwrite the real session todo checklist.
          if (!plan) return;
          markTurnActivity(threadId);
          set((s) => ({
            planByThread: { ...s.planByThread, [threadId]: plan },
          }));
        },
      ),
    );

    unlisteners.push(
      await listen<{ threadId: string; message: string; preparing?: boolean }>('acp-status', (event) => {
        if (!isThreadEventLive(event.payload.threadId)) return;
        const { threadId, message, preparing } = event.payload;
        set((s) => ({
          statusByThread: {
            ...s.statusByThread,
            [threadId]: message,
          },
          ...(!preparing
            ? { runningByThread: { ...s.runningByThread, [threadId]: true } }
            : {}),
        }));
      }),
    );

    unlisteners.push(
      await listen<{
        threadId: string;
        messageId?: string;
        requestId: string;
        interactionKind?: AcpPermissionRequest['kind'];
        toolCallId?: string | null;
        title?: string | null;
        raw: Record<string, unknown>;
        options: Array<{
          optionId?: string;
          option_id?: string;
          name: string;
          kind?: string;
          description?: string | null;
        }>;
      }>('acp-permission-request', (event) => {
        if (!isThreadEventLive(event.payload.threadId)) return;
        const {
          threadId,
          messageId,
          requestId,
          interactionKind: eventInteractionKind,
          toolCallId: eventToolCallId,
          title: eventTitle,
          raw,
          options,
        } = event.payload;
        markTurnActivity(threadId);
        const toolCall = (raw.toolCall ?? raw.tool_call ?? raw) as Record<string, unknown>;
        const kind = interactionKind(raw, eventInteractionKind);
        const toolCallId = eventToolCallId
          ?? (typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null)
          ?? (typeof toolCall.tool_call_id === 'string' ? toolCall.tool_call_id : undefined);
        const toolName =
          (typeof toolCall.toolName === 'string' && toolCall.toolName)
          || (typeof toolCall.kind === 'string' && toolCall.kind)
          || (typeof toolCall.tool === 'string' && toolCall.tool)
          || (typeof toolCall.title === 'string' && String(toolCall.title).slice(0, 40))
          || (toolCallId ? 'tool' : '');
        const inputObj =
          (toolCall.rawInput as Record<string, unknown>)
          || (toolCall.input as Record<string, unknown>)
          || toolCall;
        const title = eventTitle
          ?? (typeof raw.title === 'string' ? raw.title : undefined)
          ?? (typeof toolCall.title === 'string' ? toolCall.title : undefined);
        const baseInput = typeof inputObj === 'object' && inputObj ? inputObj : { value: inputObj };
        const plan = [raw.plan, baseInput.plan]
          .find((value) => typeof value === 'string' && value.trim());
        const supportsFeedback = typeof raw.supportsFeedback === 'boolean'
          ? raw.supportsFeedback
          : typeof baseInput.supportsFeedback === 'boolean'
            ? baseInput.supportsFeedback
            : kind === 'plan_review'
              ? false
              : undefined;
        const feedbackDelivery = typeof raw.feedbackDelivery === 'string'
          ? raw.feedbackDelivery
          : typeof baseInput.feedbackDelivery === 'string'
            ? baseInput.feedbackDelivery
            : undefined;
        const input = kind === 'plan_review'
          ? {
              ...baseInput,
              ...(typeof plan === 'string' ? { plan } : {}),
              ...(typeof supportsFeedback === 'boolean' ? { supportsFeedback } : {}),
              ...(feedbackDelivery ? { feedbackDelivery } : {}),
            }
          : baseInput;
        const mappedOptions = mapAcpOptions(options ?? []);
        const sequence = ++_acpInteractionSeq;
        const pendingRequest: AcpPermissionRequest = {
          threadId,
          messageId,
          requestId,
          kind,
          title,
          toolName: String(toolName),
          toolCallId,
          input,
          options: mappedOptions,
          status: 'pending',
          sequence,
        };

        set((s) => {
          const nextPermissions = {
            ...s.pendingPermissions,
            [requestId]: pendingRequest,
          };
          if (kind !== 'plan_review') {
            return { pendingPermissions: nextPermissions };
          }
          const content = extractPlanDocumentContent(input, {
            description: typeof raw.description === 'string' ? raw.description : undefined,
            title,
          });
          return {
            pendingPermissions: nextPermissions,
            planDocumentsByThread: upsertPlanDocument(s.planDocumentsByThread, {
              id: requestId,
              threadId,
              messageId,
              content,
              title: typeof title === 'string' ? title : undefined,
              status: 'pending',
              sequence,
              createdAt: new Date().toISOString(),
            }),
          };
        });
      }),
    );

    unlisteners.push(
      await listen<{
        threadId: string;
        messageId?: string;
        requestId: string;
        interactionKind?: AcpPermissionRequest['kind'];
        toolCallId?: string | null;
        reason: 'selected' | 'cancelled' | 'expired';
        selectedOptionId?: string | null;
        selectedOptionKind?: string | null;
        selectedOptionName?: string | null;
      }>('acp-interaction-closed', (event) => {
        if (!isThreadEventLive(event.payload.threadId)) return;
        const payload = event.payload;
        markTurnActivity(payload.threadId);
        set((state) => {
          const resolution = {
            requestId: payload.requestId,
            reason: payload.reason,
            threadId: payload.threadId,
            messageId: payload.messageId,
            kind: payload.interactionKind,
            toolCallId: payload.toolCallId ?? undefined,
            optionId: payload.selectedOptionId ?? undefined,
            optionKind: payload.selectedOptionKind ?? undefined,
            optionLabel: payload.selectedOptionName ?? undefined,
          };
          const next = resolvedInteractionState(
            state.pendingPermissions,
            state.toolCalls,
            resolution,
          );
          const existing = state.pendingPermissions[payload.requestId];
          const kind = payload.interactionKind ?? existing?.kind;
          if (kind !== 'plan_review') return next;
          return {
            ...next,
            planDocumentsByThread: resolvePlanDocument(
              state.planDocumentsByThread,
              payload.requestId,
              {
                status: planDocumentStatusFromResolution(
                  resolution.optionId,
                  payload.reason,
                  resolution.optionKind,
                ),
                messageId: payload.messageId ?? existing?.messageId,
              },
            ),
          };
        });
      }),
    );

    unlisteners.push(
      await listen<{
        threadId: string;
        messageId?: string;
        toolCallId: string;
        title?: string | null;
        kind?: string | null;
        status?: string | null;
        raw: Record<string, unknown>;
      }>('acp-tool-call', (event) => {
        if (!isThreadEventLive(event.payload.threadId)) return;
        const p = event.payload;
        markTurnActivity(p.threadId);
        const status = normalizeToolStatus(p.status ?? 'pending');
        set((s) => {
          const toolKey = acpToolStateKey(p.threadId, p.toolCallId, p.messageId);
          const existing = s.toolCalls[toolKey];
          return {
            toolCalls: {
              ...s.toolCalls,
              [toolKey]: {
                ...existing,
                threadId: p.threadId,
                messageId: p.messageId,
                toolCallId: p.toolCallId,
                toolName: extractToolName(p.raw ?? {}, p.title),
                status,
                input: extractToolInput(p.raw ?? {}),
                output: extractToolOutput(p.raw ?? {}) ?? existing?.output,
              },
            },
          };
        });
      }),
    );

    unlisteners.push(
      await listen<{
        threadId: string;
        messageId?: string;
        toolCallId: string;
        status?: string | null;
        raw: Record<string, unknown>;
      }>('acp-tool-call-update', (event) => {
        if (!isThreadEventLive(event.payload.threadId)) return;
        const p = event.payload;
        markTurnActivity(p.threadId);
        set((s) => {
          const toolKey = acpToolStateKey(p.threadId, p.toolCallId, p.messageId);
          const existing = s.toolCalls[toolKey];
          const status = normalizeToolStatus(p.status ?? existing?.status ?? 'running');
          const output = extractToolOutput(p.raw ?? {});
          return {
            toolCalls: {
              ...s.toolCalls,
              [toolKey]: {
                ...existing,
                threadId: p.threadId,
                messageId: p.messageId ?? existing?.messageId,
                toolCallId: p.toolCallId,
                toolName: existing?.toolName ?? extractToolName(p.raw ?? {}),
                status,
                input: existing?.input ?? extractToolInput(p.raw ?? {}),
                output: output ?? existing?.output,
              },
            },
          };
        });
      }),
    );

    unlisteners.push(
      await listen<{
        threadId: string;
        messageId: string;
        text: string;
        stopReason?: string;
        sessionId?: string;
        durationMs?: number;
      }>(
        'acp-done',
        (event) => {
          if (!isThreadEventLive(event.payload.threadId)) return;
          const { threadId, messageId, text, stopReason, durationMs } = event.payload;
          const followUp = get().planFollowUpByThread[threadId];
          markTurnActivity(threadId);
          streamBatch.delete(messageId);
          _acpStreamingMessageThreads.delete(messageId);
          const metaJson =
            typeof durationMs === 'number'
              ? JSON.stringify({ duration_ms: Math.round(durationMs) })
              : undefined;
          set((s) => {
            const nextStreaming = { ...s.streamingText };
            const streamed = nextStreaming[messageId] ?? '';
            delete nextStreaming[messageId];
            const finalContent = (text && text.length > 0 ? text : streamed)
              || s.messages.find((m) => m.id === messageId)?.content
              || '';
            const hasMsg = s.messages.some((m) => m.id === messageId);
            const patch = {
              content: finalContent,
              status: 'done' as const,
              ...(metaJson ? { meta_json: metaJson } : {}),
            };
            const messages = hasMsg
              ? s.messages.map((m) =>
                  m.id === messageId ? { ...m, ...patch } : m,
                )
              : s.activeThreadId === threadId
                ? [
                    ...s.messages,
                    {
                      id: messageId,
                      thread_id: threadId,
                      role: 'assistant',
                      content: finalContent,
                      status: 'done',
                      attachments: [],
                      meta_json: metaJson ?? null,
                      created_at: new Date().toISOString(),
                    },
                  ]
                : s.messages;
            const nextFollowUps = { ...s.planFollowUpByThread };
            if (nextFollowUps[threadId]?.requestId === followUp?.requestId) {
              delete nextFollowUps[threadId];
            }
            return {
              streamingText: nextStreaming,
              statusByThread: { ...s.statusByThread, [threadId]: '' },
              runningByThread: { ...s.runningByThread, [threadId]: false },
              cancellingByThread: { ...s.cancellingByThread, [threadId]: false },
              planByThread: { ...s.planByThread, [threadId]: { entries: [], completed: 0, total: 0 } },
              // Keep plan documents for re-reading; only expire still-pending reviews.
              planDocumentsByThread: finalizePendingPlanDocuments(
                s.planDocumentsByThread,
                threadId,
              ),
              planFollowUpByThread: nextFollowUps,
              pendingPermissions: removeThreadEntries(s.pendingPermissions, threadId),
              toolCalls: finalizeUnfinishedToolCalls(
                s.toolCalls,
                threadId,
                /cancel/i.test(stopReason ?? '') ? 'cancelled' : 'error',
              ),
              messages,
            };
          });
          // DB is already status=done and runtime prompt state is idle at this
          // drain boundary, so Codex revision feedback can safely start a turn.
          if (followUp) {
            void get().sendPrompt(threadId, followUp.prompt).catch((error) => {
              const errorMessage = String(error);
              set((state) => {
                const scopeKey = composerScopeForThread(state, threadId);
                if (!scopeKey || !isLiveComposerDraftScope(state, scopeKey)) return state;
                const draft = state.composerDraftsByScope[scopeKey] ?? {
                  value: '',
                  snippets: [],
                  files: [],
                };
                return {
                  composerDraftsByScope: {
                    ...state.composerDraftsByScope,
                    [scopeKey]: {
                      ...draft,
                      recovery: {
                        id: followUp.requestId,
                        text: followUp.prompt,
                        error: errorMessage,
                      },
                    },
                  },
                };
              });
              console.error('[acpStore] failed to continue plan revision feedback', error);
            });
          } else if (get().activeThreadId === threadId) {
            void get().loadMessages(threadId);
          }
        },
      ),
    );

    unlisteners.push(
      await listen<{ threadId: string; messageId?: string; message: string; text?: string }>(
        'acp-error',
        (event) => {
          if (!isThreadEventLive(event.payload.threadId)) return;
          const { threadId, messageId, message, text } = event.payload;
          invalidateAcpMessageLoad(threadId);
          markTurnActivity(threadId);
          if (messageId) {
            streamBatch.delete(messageId);
            _acpStreamingMessageThreads.delete(messageId);
          }
          set((s) => {
            const nextStreaming = { ...s.streamingText };
            if (messageId) delete nextStreaming[messageId];
            const existing = messageId
              ? s.messages.find((item) => item.id === messageId)
              : undefined;
            const errorContent = text || existing?.content || `Error: ${message}`;
            const messages = messageId
              ? existing
                ? s.messages.map((item) => (
                    item.id === messageId
                      ? { ...item, content: errorContent, status: 'error' }
                      : item
                  ))
                : s.activeThreadId === threadId
                  ? [
                      ...s.messages,
                      {
                        id: messageId,
                        thread_id: threadId,
                        role: 'assistant',
                        content: errorContent,
                        status: 'error',
                        attachments: [],
                        created_at: new Date().toISOString(),
                      },
                    ]
                  : s.messages
              : s.messages;
            return {
              streamingText: nextStreaming,
              statusByThread: { ...s.statusByThread, [threadId]: message },
              runningByThread: { ...s.runningByThread, [threadId]: false },
              cancellingByThread: { ...s.cancellingByThread, [threadId]: false },
              messagesLoadingByThread: {
                ...s.messagesLoadingByThread,
                [threadId]: false,
              },
              planByThread: { ...s.planByThread, [threadId]: { entries: [], completed: 0, total: 0 } },
              planDocumentsByThread: finalizePendingPlanDocuments(
                s.planDocumentsByThread,
                threadId,
              ),
              planFollowUpByThread: Object.fromEntries(
                Object.entries(s.planFollowUpByThread).filter(([key]) => key !== threadId),
              ),
              pendingPermissions: removeThreadEntries(s.pendingPermissions, threadId),
              toolCalls: finalizeUnfinishedToolCalls(s.toolCalls, threadId, 'error'),
              error: message,
              messages,
            };
          });
        },
      ),
    );

    // If a newer bindEvents started while we were awaiting listen(), drop these.
    if (!isLive()) {
      unlisteners.forEach((u) => u());
      return () => {};
    }

    const cleanup = () => {
      flushStreams();
      unlisteners.forEach((u) => u());
      if (_acpUnlisten === cleanup) {
        _acpUnlisten = null;
      }
    };
    _acpUnlisten = cleanup;
    return cleanup;
  },
    }),
    {
      name: 'aqbot-acp-cache',
      // Instant paint after cold start: show last-known agents/projects while revalidating.
      // Ready flags are NOT persisted — each session still revalidates from backend.
      // activeProjectId / activeThreadId are persisted so re-entering Agent restores
      // the last open project conversation.
      partialize: (s) => ({
        config: s.config,
        permissionMode: s.permissionMode,
        projects: s.projects,
        allThreads: s.allThreads,
        activeProjectId: s.activeProjectId,
        activeThreadId: s.activeThreadId,
        spawnModelByThread: s.spawnModelByThread,
        spawnReasoningByThread: s.spawnReasoningByThread,
      }),
    },
  ),
);
