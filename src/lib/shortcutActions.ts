import { getCurrentWindow, getAllWindows } from '@tauri-apps/api/window';
import { message } from 'antd';
import { isTauri } from '@/lib/invoke';
import { useUIStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { invoke } from '@/lib/invoke';
import type { GatewayStatus } from '@/types';
import { SHORTCUT_ACTION_LABEL_KEYS, type ShortcutAction } from '@/lib/shortcuts';
import i18n from '@/i18n';

function notifyShortcutTriggered(action: ShortcutAction) {
  const settings = useSettingsStore.getState().settings;
  if (!settings.shortcut_trigger_toast_enabled) return;
  const actionLabel = i18n.t(SHORTCUT_ACTION_LABEL_KEYS[action]);
  const text = i18n.t('settings.shortcutTriggeredMessage', { action: actionLabel });
  message.info(text);
}

function dispatchWindowEvent(name: string) {
  window.dispatchEvent(new CustomEvent(name));
}

/**
 * Chat-only shortcuts: fire only while Chat is active.
 * Never force-navigate to Chat from Agent / Settings / other pages.
 */
function dispatchChatOnlyEvent(name: string) {
  if (useUIStore.getState().activePage !== 'chat') return;
  dispatchWindowEvent(name);
}

/**
 * Shared "new conversation / new thread" across Chat + Agent workspaces.
 * No-ops on other pages (does not jump modules).
 */
function dispatchNewConversationForActivePage() {
  const page = useUIStore.getState().activePage;
  if (page === 'chat') {
    dispatchWindowEvent('aqbot:new-conversation');
    return;
  }
  if (page === 'agent') {
    dispatchWindowEvent('aqbot:new-agent-thread');
  }
}

async function toggleCurrentWindow() {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  const visible = await win.isVisible() && !await win.isMinimized();
  if (visible) {
    await win.hide();
    return;
  }
  await win.unminimize();
  await win.show();
  await win.setFocus();
}

async function toggleAllWindows() {
  if (!isTauri()) return;
  const windows = await getAllWindows();
  if (windows.length === 0) return;
  const visibility = await Promise.all(windows.map(async (win) => await win.isVisible() && !await win.isMinimized()));
  const shouldHide = visibility.some(Boolean);
  if (shouldHide) {
    await Promise.all(windows.map((win) => win.hide()));
    return;
  }
  await Promise.all(windows.map(async (win) => {
    await win.unminimize();
    await win.show();
  }));
  await windows[0].setFocus();
}

async function closeCurrentWindow() {
  if (!isTauri()) return;
  await getCurrentWindow().close();
}

async function toggleGatewayPage() {
  const status = await invoke<GatewayStatus>('get_gateway_status');
  if (status.is_running) {
    await invoke('stop_gateway');
  } else {
    await invoke('start_gateway');
  }
}

export async function executeShortcutAction(action: ShortcutAction): Promise<void> {
  switch (action) {
    case 'toggleCurrentWindow':
      notifyShortcutTriggered(action);
      await toggleCurrentWindow();
      return;
    case 'toggleAllWindows':
      notifyShortcutTriggered(action);
      await toggleAllWindows();
      return;
    case 'closeWindow':
      notifyShortcutTriggered(action);
      await closeCurrentWindow();
      return;
    case 'newConversation':
      notifyShortcutTriggered(action);
      dispatchNewConversationForActivePage();
      return;
    case 'openSettings':
      notifyShortcutTriggered(action);
      if (useUIStore.getState().activePage === 'settings') {
        useUIStore.getState().exitSettings();
      } else {
        useUIStore.getState().enterSettings();
      }
      return;
    case 'toggleModelSelector':
      notifyShortcutTriggered(action);
      dispatchChatOnlyEvent('aqbot:toggle-model-selector');
      return;
    case 'toggleChatSidebar':
      notifyShortcutTriggered(action);
      // Chat sidebar collapse only applies on Chat page
      dispatchChatOnlyEvent('aqbot:toggle-chat-sidebar');
      return;
    case 'fillLastMessage':
      notifyShortcutTriggered(action);
      dispatchChatOnlyEvent('aqbot:fill-last-message');
      return;
    case 'clearContext':
      notifyShortcutTriggered(action);
      dispatchChatOnlyEvent('aqbot:clear-context');
      return;
    case 'clearConversationMessages':
      notifyShortcutTriggered(action);
      dispatchChatOnlyEvent('aqbot:clear-conversation-messages');
      return;
    case 'toggleGateway':
      notifyShortcutTriggered(action);
      await toggleGatewayPage();
      return;
    case 'toggleMode':
      notifyShortcutTriggered(action);
      dispatchChatOnlyEvent('aqbot:toggle-mode');
      return;
  }
}
