import { useCallback, useMemo, useRef, useState } from 'react';
import type { MultiModelDisplayMode } from '@/types';

interface UseMultiModelLayoutStateOptions {
  conversationId: string | null;
  globalDisplayMode: MultiModelDisplayMode;
  conversationDisplayMode?: MultiModelDisplayMode | null;
  persistConversationDisplayMode: (mode: MultiModelDisplayMode) => Promise<void>;
}

export function useMultiModelLayoutState({
  conversationId,
  globalDisplayMode,
  conversationDisplayMode,
  persistConversationDisplayMode,
}: UseMultiModelLayoutStateOptions) {
  const activeConversationIdRef = useRef(conversationId);
  const mutationRevisionRef = useRef(0);
  if (activeConversationIdRef.current !== conversationId) {
    activeConversationIdRef.current = conversationId;
    mutationRevisionRef.current += 1;
  }
  const displayModes = useMemo(
    () => new Map<string, MultiModelDisplayMode>(),
    [conversationId],
  );
  const effectiveConversationMode = conversationDisplayMode ?? globalDisplayMode;
  const [futureModeState, setFutureModeState] = useState({
    conversationId,
    mode: effectiveConversationMode,
    baseMode: effectiveConversationMode,
  });
  const futureDisplayMode = futureModeState.conversationId === conversationId
    && futureModeState.baseMode === effectiveConversationMode
    ? futureModeState.mode
    : effectiveConversationMode;
  const getDisplayMode = useCallback((parentMessageId: string): MultiModelDisplayMode => {
    const snapshot = displayModes.get(parentMessageId);
    if (snapshot) return snapshot;

    displayModes.set(parentMessageId, futureDisplayMode);
    return futureDisplayMode;
  }, [displayModes, futureDisplayMode]);
  const setDisplayMode = useCallback(async (
    parentMessageId: string,
    mode: MultiModelDisplayMode,
  ): Promise<void> => {
    const mutationRevision = mutationRevisionRef.current + 1;
    mutationRevisionRef.current = mutationRevision;
    const previousFutureDisplayMode = futureDisplayMode;
    displayModes.set(parentMessageId, mode);
    setFutureModeState({
      conversationId,
      mode,
      baseMode: effectiveConversationMode,
    });
    try {
      await persistConversationDisplayMode(mode);
    } catch (error) {
      if (
        mutationRevisionRef.current === mutationRevision
        && activeConversationIdRef.current === conversationId
      ) {
        setFutureModeState({
          conversationId,
          mode: previousFutureDisplayMode,
          baseMode: effectiveConversationMode,
        });
      }
      throw error;
    }
  }, [
    conversationId,
    displayModes,
    effectiveConversationMode,
    futureDisplayMode,
    persistConversationDisplayMode,
  ]);
  const retainDisplayModes = useCallback((parentMessageIds: ReadonlySet<string>): void => {
    for (const parentMessageId of displayModes.keys()) {
      if (!parentMessageIds.has(parentMessageId)) {
        displayModes.delete(parentMessageId);
      }
    }
  }, [displayModes]);

  return {
    futureDisplayMode,
    getDisplayMode,
    retainDisplayModes,
    setDisplayMode,
  };
}
