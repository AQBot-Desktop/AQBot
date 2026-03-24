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

function dispatchChatScopedEvent(name: string) {
  const uiState = useUIStore.getState();
  const shouldDelayDispatch = uiState.activePage !== 'chat';
  uiState.setActivePage('chat');
  window.setTimeout(() => {
    dispatchWindowEvent(name);
  }, shouldDelayDispatch ? 80 : 0);
}

async function toggleCurrentWindow() {
  if (!isTauri()) return;
  const win = getCurrentWindow();
  const visible = await win.isVisible();
  if (visible) {
    await win.hide();
    return;
  }
  await win.show();
  await win.setFocus();
}

async function toggleAllWindows() {
  if (!isTauri()) return;
  const windows = await getAllWindows();
  if (windows.length === 0) return;
  const visibility = await Promise.all(windows.map((win) => win.isVisible()));
  const shouldHide = visibility.some(Boolean);
  if (shouldHide) {
    await Promise.all(windows.map((win) => win.hide()));
    return;
  }
  await Promise.all(windows.map((win) => win.show()));
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
      dispatchChatScopedEvent('aqbot:new-conversation');
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
      dispatchChatScopedEvent('aqbot:toggle-model-selector');
      return;
    case 'fillLastMessage':
      notifyShortcutTriggered(action);
      dispatchChatScopedEvent('aqbot:fill-last-message');
      return;
    case 'clearContext':
      notifyShortcutTriggered(action);
      dispatchChatScopedEvent('aqbot:clear-context');
      return;
    case 'clearConversationMessages':
      notifyShortcutTriggered(action);
      dispatchChatScopedEvent('aqbot:clear-conversation-messages');
      return;
    case 'toggleGateway':
      notifyShortcutTriggered(action);
      await toggleGatewayPage();
      return;
  }
}
