import { useCallback, useSyncExternalStore } from 'react';

export type MultiModelContinuationMode = 'selected' | 'per_model';

export const DEFAULT_MULTI_MODEL_CONTINUATION_MODE: MultiModelContinuationMode = 'selected';

const STORAGE_PREFIX = 'aqbot:multi-model-continuation-mode:';
const listenersByConversationId = new Map<string, Set<() => void>>();

export function getMultiModelContinuationStorageKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${conversationId}`;
}

export function normalizeMultiModelContinuationMode(
  value: unknown,
): MultiModelContinuationMode {
  return value === 'per_model' ? 'per_model' : DEFAULT_MULTI_MODEL_CONTINUATION_MODE;
}

export function getMultiModelContinuationMode(
  conversationId: string | null | undefined,
): MultiModelContinuationMode {
  if (!conversationId || typeof window === 'undefined') {
    return DEFAULT_MULTI_MODEL_CONTINUATION_MODE;
  }
  try {
    return normalizeMultiModelContinuationMode(
      window.localStorage.getItem(getMultiModelContinuationStorageKey(conversationId)),
    );
  } catch (error) {
    console.warn('[multiModelContinuation] failed to read preference:', error);
    return DEFAULT_MULTI_MODEL_CONTINUATION_MODE;
  }
}

export function setMultiModelContinuationMode(
  conversationId: string | null | undefined,
  mode: MultiModelContinuationMode,
): void {
  if (!conversationId || typeof window === 'undefined') return;
  const normalized = normalizeMultiModelContinuationMode(mode);
  try {
    window.localStorage.setItem(getMultiModelContinuationStorageKey(conversationId), normalized);
  } catch (error) {
    console.warn('[multiModelContinuation] failed to persist preference:', error);
    notifyMultiModelContinuationMode(conversationId);
    return;
  }
  notifyMultiModelContinuationMode(conversationId);
}

function notifyMultiModelContinuationMode(conversationId: string): void {
  for (const listener of listenersByConversationId.get(conversationId) ?? []) {
    listener();
  }
}

function subscribeToMultiModelContinuationMode(
  conversationId: string | null | undefined,
  listener: () => void,
): () => void {
  if (!conversationId || typeof window === 'undefined') return () => {};
  const listeners = listenersByConversationId.get(conversationId) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByConversationId.set(conversationId, listeners);

  const storageKey = getMultiModelContinuationStorageKey(conversationId);
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) {
      listener();
    }
  };
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener('storage', onStorage);
    listeners.delete(listener);
    if (listeners.size === 0) listenersByConversationId.delete(conversationId);
  };
}

export function useMultiModelContinuationMode(
  conversationId: string | null | undefined,
): readonly [MultiModelContinuationMode, (mode: MultiModelContinuationMode) => void] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToMultiModelContinuationMode(conversationId, listener),
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => getMultiModelContinuationMode(conversationId),
    [conversationId],
  );
  const mode = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_MULTI_MODEL_CONTINUATION_MODE,
  );
  const setMode = useCallback(
    (nextMode: MultiModelContinuationMode) => {
      setMultiModelContinuationMode(conversationId, nextMode);
    },
    [conversationId],
  );

  return [mode, setMode] as const;
}
