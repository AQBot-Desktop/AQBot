import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversationStore, useSettingsStore, useUIStore } from '@/stores';
import {
  SHORTCUT_ACTIONS,
  getShortcutBinding,
  matchesShortcutEvent,
  type ShortcutAction,
} from '@/lib/shortcuts';
import { executeShortcutAction } from '@/lib/shortcutActions';

export function useKeyboardShortcuts() {
  const { t: _t } = useTranslation();
  const setActivePage = useUIStore((s) => s.setActivePage);
  const settings = useSettingsStore((s) => s.settings);

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      for (const action of SHORTCUT_ACTIONS) {
        const binding = getShortcutBinding(settings, action);
        if (!binding) continue;
        if (!matchesShortcutEvent(e, binding)) continue;

        console.info('[shortcut-local-hit]', {
          action,
          binding,
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        });
        e.preventDefault();
        await executeShortcutAction(action as ShortcutAction);
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      switch (e.key.toLowerCase()) {
        case 'f':
          e.preventDefault();
          setActivePage('chat');
          setTimeout(() => {
            const searchInput = document.querySelector<HTMLInputElement>('.chat-sidebar-search input');
            searchInput?.focus();
          }, 50);
          return;
        case 'w':
          e.preventDefault();
          useConversationStore.getState().setActiveConversation(null);
          return;
        default:
          return;
        }
    },
    [setActivePage, settings],
  );

  const exitSettings = useUIStore((s) => s.exitSettings);
  const activePage = useUIStore((s) => s.activePage);

  const handleKeyDownEsc = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (activePage === 'settings') {
        exitSettings();
        return;
      }
      // Close voice overlay or modals via custom event
      window.dispatchEvent(new CustomEvent('aqbot:escape'));
    }
  }, [activePage, exitSettings]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keydown', handleKeyDownEsc);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleKeyDownEsc);
    };
  }, [handleKeyDown, handleKeyDownEsc]);
}
