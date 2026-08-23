import { useEffect, useMemo } from 'react';
import { hasMultipleModelVersions, selectRenderableVersionSet } from '@/lib/chatMultiModel';
import { useConversationStore } from '@/stores';
import {
  getMessageVersionGroupResourceKey,
  hasAuthoritativeMessageVersionSnapshot,
} from '@/stores/conversationStoreSupport';
import type { Message } from '@/types';

interface UseMessageVersionGroupsOptions {
  conversationId: string | null;
  messages: Message[];
  visibleMessages: Message[];
  retainedParentMessageIds: ReadonlySet<string>;
  multiModelParentId: string | null;
  pendingCompanionModelCount: number;
  multiModelDoneMessageIds: string[];
}

function retainConversationResources(
  conversationId: string,
  retainedParentMessageIds: ReadonlySet<string>,
): void {
  const parentMessageIdsToRemove = Object.values(
    useConversationStore.getState().messageVersionGroups,
  )
    .filter((resource) => (
      resource.conversationId === conversationId
      && !retainedParentMessageIds.has(resource.parentMessageId)
    ))
    .map((resource) => resource.parentMessageId);
  if (parentMessageIdsToRemove.length === 0) return;

  useConversationStore.getState().invalidateMessageVersionGroups(
    conversationId,
    parentMessageIdsToRemove,
  );
  useConversationStore.setState((state) => {
    const messageVersionGroups = { ...state.messageVersionGroups };
    let changed = false;
    for (const [key, resource] of Object.entries(messageVersionGroups)) {
      if (
        resource.conversationId === conversationId
        && !retainedParentMessageIds.has(resource.parentMessageId)
      ) {
        delete messageVersionGroups[key];
        changed = true;
      }
    }
    return changed ? { messageVersionGroups } : {};
  });
}

export function useMessageVersionGroups({
  conversationId,
  messages,
  visibleMessages,
  retainedParentMessageIds,
  multiModelParentId,
  pendingCompanionModelCount,
  multiModelDoneMessageIds,
}: UseMessageVersionGroupsOptions) {
  const messageVersionGroups = useConversationStore((state) => state.messageVersionGroups);
  const ensureMessageVersionGroupsLoaded = useConversationStore(
    (state) => state.ensureMessageVersionGroupsLoaded,
  );
  const visibleParentMessageIds = useMemo(() => Array.from(new Set(
    visibleMessages
      .filter((message) => message.role === 'assistant' && message.parent_message_id)
      .map((message) => message.parent_message_id as string),
  )), [visibleMessages]);
  const parentMessageIdsToLoadKey = visibleParentMessageIds
    .filter((parentMessageId) => {
      if (!conversationId) return false;
      const resource = messageVersionGroups[
        getMessageVersionGroupResourceKey(conversationId, parentMessageId)
      ];
      return !resource || resource.meta.status === 'idle';
    })
    .join('\0');

  useEffect(() => {
    if (!conversationId || !parentMessageIdsToLoadKey) return;
    let frameId = 0;
    let idleId: number | null = null;
    const browserWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const parentMessageIds = parentMessageIdsToLoadKey.split('\0');
    const load = () => {
      void ensureMessageVersionGroupsLoaded(
        conversationId,
        parentMessageIds,
      ).catch((error) => {
        console.error('[useMessageVersionGroups] Failed to load version groups:', error);
      });
    };

    frameId = window.requestAnimationFrame(() => {
      if (typeof browserWindow.requestIdleCallback === 'function') {
        idleId = browserWindow.requestIdleCallback(load, { timeout: 500 });
      } else {
        load();
      }
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      if (idleId !== null && typeof browserWindow.cancelIdleCallback === 'function') {
        browserWindow.cancelIdleCallback(idleId);
      }
    };
  }, [conversationId, ensureMessageVersionGroupsLoaded, parentMessageIdsToLoadKey]);

  useEffect(() => {
    if (conversationId) {
      retainConversationResources(conversationId, retainedParentMessageIds);
    }
  }, [conversationId, retainedParentMessageIds]);

  useEffect(() => () => {
    if (conversationId) retainConversationResources(conversationId, new Set());
  }, [conversationId]);

  const renderableVersionsByParentId = useMemo(() => {
    const liveVersionsByParentId = new Map<string, Message[]>();
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.parent_message_id) continue;
      const versions = liveVersionsByParentId.get(message.parent_message_id) ?? [];
      versions.push(message);
      liveVersionsByParentId.set(message.parent_message_id, versions);
    }

    const doneMessageIds = new Set(multiModelDoneMessageIds);
    const result: Record<string, Message[]> = {};
    for (const parentMessageId of visibleParentMessageIds) {
      const liveVersions = liveVersionsByParentId.get(parentMessageId) ?? [];
      const pendingMessageIds = new Set(liveVersions
        .filter((version) => (
          version.id.startsWith('temp-')
          || (
            parentMessageId === multiModelParentId
            && (pendingCompanionModelCount > 0 || doneMessageIds.has(version.id))
          )
        ))
        .map((version) => version.id));
      const resource = conversationId
        ? messageVersionGroups[getMessageVersionGroupResourceKey(conversationId, parentMessageId)]
        : undefined;
      const snapshotVersions = hasAuthoritativeMessageVersionSnapshot(resource)
        ? resource.versions
        : liveVersions.filter((version) => version.is_active !== false);
      result[parentMessageId] = selectRenderableVersionSet(
        snapshotVersions,
        liveVersions,
        pendingMessageIds,
      );
    }
    return result;
  }, [
    conversationId,
    messageVersionGroups,
    messages,
    multiModelDoneMessageIds,
    multiModelParentId,
    pendingCompanionModelCount,
    visibleParentMessageIds,
  ]);

  const multiModelResponseParents = useMemo(() => {
    const result = new Set<string>();
    for (const [parentMessageId, versions] of Object.entries(renderableVersionsByParentId)) {
      if (hasMultipleModelVersions(versions)) result.add(parentMessageId);
    }
    return result;
  }, [renderableVersionsByParentId]);

  return { multiModelResponseParents, renderableVersionsByParentId };
}
