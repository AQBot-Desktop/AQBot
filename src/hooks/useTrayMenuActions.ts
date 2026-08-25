import { useCallback, useEffect, useRef } from 'react';
import { invoke, isTauri, listen } from '@/lib/invoke';
import { frontendKindForWindow, getCurrentWindowLabel } from '@/lib/windowKind';
import { useConversationStore, useSettingsStore, useUIStore } from '@/stores';
import { useUpdateChecker } from '@/hooks/useUpdateChecker';

type PendingTrayAction =
  | { type: 'open_conversation'; conversation_id: string }
  | { type: 'check_update' };

/**
 * Bridge system-tray menu actions into the React app.
 * Handles open-conversation, check-update, and selection-toolbar sync,
 * including actions queued while the main webview was released to tray.
 */
export function useTrayMenuActions() {
  const { checkForUpdate } = useUpdateChecker();
  const openConversationInFlight = useRef(false);
  const checkUpdateInFlight = useRef(false);

  const openConversation = useCallback(async (conversationId: string) => {
    if (frontendKindForWindow(getCurrentWindowLabel()) !== 'main') return;
    if (!conversationId || openConversationInFlight.current) return;
    openConversationInFlight.current = true;
    try {
      useUIStore.getState().setActivePage('chat');

      const store = useConversationStore.getState();
      await store.ensureConversationsLoaded();
      let latest = useConversationStore.getState();
      const exists = latest.conversations.some((c) => c.id === conversationId);
      if (!exists) {
        await latest.fetchConversations();
        latest = useConversationStore.getState();
      }
      latest.setActiveConversation(conversationId);
    } catch (error) {
      console.warn('Failed to open conversation from tray:', error);
    } finally {
      openConversationInFlight.current = false;
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    if (checkUpdateInFlight.current) return;
    checkUpdateInFlight.current = true;
    try {
      await checkForUpdate();
    } catch (error) {
      console.warn('Failed to check update from tray:', error);
    } finally {
      checkUpdateInFlight.current = false;
    }
  }, [checkForUpdate]);

  const applySelectionToolbarEnabled = useCallback((enabled: boolean) => {
    const state = useSettingsStore.getState();
    const current = state.settings.selection_toolbar;
    if (current.enabled === enabled) return;
    useSettingsStore.setState({
      settings: {
        ...state.settings,
        selection_toolbar: { ...current, enabled },
      },
    });
  }, []);

  const drainPending = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const pending = await invoke<PendingTrayAction | null>('take_pending_tray_action');
      if (!pending) return;
      if (pending.type === 'open_conversation') {
        await openConversation(pending.conversation_id);
      } else if (pending.type === 'check_update') {
        await handleCheckUpdate();
      }
    } catch (error) {
      console.warn('Failed to drain pending tray action:', error);
    }
  }, [handleCheckUpdate, openConversation]);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const openUnlisten = await listen<string>('tray-open-conversation', (event) => {
        void openConversation(event.payload);
      });
      if (cancelled) {
        openUnlisten();
        return;
      }
      unlisteners.push(openUnlisten);

      const updateUnlisten = await listen('tray-check-update', () => {
        void handleCheckUpdate();
      });
      if (cancelled) {
        updateUnlisten();
        return;
      }
      unlisteners.push(updateUnlisten);

      const toolbarUnlisten = await listen<boolean>('tray-selection-toolbar-changed', (event) => {
        applySelectionToolbarEnabled(Boolean(event.payload));
      });
      if (cancelled) {
        toolbarUnlisten();
        return;
      }
      unlisteners.push(toolbarUnlisten);

      await drainPending();
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [applySelectionToolbarEnabled, drainPending, handleCheckUpdate, openConversation]);

  // Keep tray recent list fresh when conversations change.
  useEffect(() => {
    if (!isTauri()) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void invoke('refresh_tray_menu').catch((error) => {
          console.warn('Failed to refresh tray menu:', error);
        });
      }, 400);
    };

    const unsubscribe = useConversationStore.subscribe((state, prev) => {
      if (state.conversations !== prev.conversations) {
        scheduleRefresh();
      }
    });

    // Initial refresh once the UI is ready.
    scheduleRefresh();

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
