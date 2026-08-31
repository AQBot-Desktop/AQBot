import { listen, type UnlistenFn } from '@/lib/invoke';
import { getCurrentWindowLabel } from '@/lib/windowKind';
import type { MultiModelTarget } from '@/types';

function canUseTauriEvents(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const CONVERSATION_SYNC_EVENT = 'aqbot:conversation-sync';

export type ConversationSyncKind = 'messages-changed' | 'conversation-meta';

export interface ConversationStreamSyncState {
  streaming: boolean;
  streamId: string | null;
  streamingMessageId: string | null;
  multiModelParentId: string | null;
  pendingCompanionModels: MultiModelTarget[];
  multiModelDoneMessageIds: string[];
}

export interface ConversationSyncPayload {
  originWindow: string;
  conversationId: string;
  kind: ConversationSyncKind;
  stream?: ConversationStreamSyncState;
  multiModelTargets?: MultiModelTarget[];
}

type ConversationSyncHandler = (payload: ConversationSyncPayload) => void;

const browserHandlers = new Set<ConversationSyncHandler>();

export function notifyConversationChanged(
  conversationId: string | null | undefined,
  stream?: ConversationStreamSyncState,
): void {
  if (!conversationId) return;
  void emitConversationSync({ conversationId, kind: 'messages-changed', stream }).catch(() => {});
}

export async function emitConversationSync(
  payload: Omit<ConversationSyncPayload, 'originWindow'>,
): Promise<void> {
  const full: ConversationSyncPayload = {
    ...payload,
    originWindow: getCurrentWindowLabel(),
  };
  if (canUseTauriEvents()) {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(CONVERSATION_SYNC_EVENT, full);
    return;
  }
  for (const handler of [...browserHandlers]) {
    handler(full);
  }
}

export async function listenConversationSync(
  handler: ConversationSyncHandler,
): Promise<UnlistenFn> {
  if (canUseTauriEvents()) {
    return listen<ConversationSyncPayload>(CONVERSATION_SYNC_EVENT, (event) => {
      handler(event.payload);
    });
  }
  browserHandlers.add(handler);
  return () => {
    browserHandlers.delete(handler);
  };
}
