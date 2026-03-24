import type { AppSettings } from '@/types';

export type ShortcutAction =
  | 'toggleCurrentWindow'
  | 'toggleAllWindows'
  | 'closeWindow'
  | 'newConversation'
  | 'openSettings'
  | 'toggleModelSelector'
  | 'fillLastMessage'
  | 'clearContext'
  | 'clearConversationMessages'
  | 'toggleGateway';

export interface ShortcutDescriptor {
  action: ShortcutAction;
  labelKey: string;
  supportsGlobal: boolean;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'toggleCurrentWindow',
  'toggleAllWindows',
  'closeWindow',
  'newConversation',
  'openSettings',
  'toggleModelSelector',
  'fillLastMessage',
  'clearContext',
  'clearConversationMessages',
  'toggleGateway',
];

export const SHORTCUT_DESCRIPTORS: ShortcutDescriptor[] = [
  { action: 'toggleCurrentWindow', labelKey: 'settings.shortcutAction.toggleCurrentWindow', supportsGlobal: true },
  { action: 'toggleAllWindows', labelKey: 'settings.shortcutAction.toggleAllWindows', supportsGlobal: true },
  { action: 'closeWindow', labelKey: 'settings.shortcutAction.closeWindow', supportsGlobal: true },
  { action: 'newConversation', labelKey: 'settings.shortcutAction.newConversation', supportsGlobal: false },
  { action: 'openSettings', labelKey: 'settings.shortcutAction.openSettings', supportsGlobal: false },
  { action: 'toggleModelSelector', labelKey: 'settings.shortcutAction.toggleModelSelector', supportsGlobal: false },
  { action: 'fillLastMessage', labelKey: 'settings.shortcutAction.fillLastMessage', supportsGlobal: false },
  { action: 'clearContext', labelKey: 'settings.shortcutAction.clearContext', supportsGlobal: false },
  { action: 'clearConversationMessages', labelKey: 'settings.shortcutAction.clearConversationMessages', supportsGlobal: false },
  { action: 'toggleGateway', labelKey: 'settings.shortcutAction.toggleGateway', supportsGlobal: false },
];

export const SHORTCUT_ACTION_LABEL_KEYS: Record<ShortcutAction, string> = {
  toggleCurrentWindow: 'settings.shortcutAction.toggleCurrentWindow',
  toggleAllWindows: 'settings.shortcutAction.toggleAllWindows',
  closeWindow: 'settings.shortcutAction.closeWindow',
  newConversation: 'settings.shortcutAction.newConversation',
  openSettings: 'settings.shortcutAction.openSettings',
  toggleModelSelector: 'settings.shortcutAction.toggleModelSelector',
  fillLastMessage: 'settings.shortcutAction.fillLastMessage',
  clearContext: 'settings.shortcutAction.clearContext',
  clearConversationMessages: 'settings.shortcutAction.clearConversationMessages',
  toggleGateway: 'settings.shortcutAction.toggleGateway',
};

export const GLOBAL_SHORTCUT_ACTIONS: ShortcutAction[] = [
  'toggleCurrentWindow',
  'toggleAllWindows',
  'closeWindow',
];

export function isGlobalShortcutAction(action: ShortcutAction): boolean {
  return GLOBAL_SHORTCUT_ACTIONS.includes(action);
}

export type ShortcutConflictMap = Partial<Record<ShortcutAction, ShortcutAction[]>>;

export const SHORTCUT_SETTING_KEYS = {
  toggleCurrentWindow: 'shortcut_toggle_current_window',
  toggleAllWindows: 'shortcut_toggle_all_windows',
  closeWindow: 'shortcut_close_window',
  newConversation: 'shortcut_new_conversation',
  openSettings: 'shortcut_open_settings',
  toggleModelSelector: 'shortcut_toggle_model_selector',
  fillLastMessage: 'shortcut_fill_last_message',
  clearContext: 'shortcut_clear_context',
  clearConversationMessages: 'shortcut_clear_conversation_messages',
  toggleGateway: 'shortcut_toggle_gateway',
} as const satisfies Record<ShortcutAction, keyof AppSettings>;

export type ShortcutSettingKey = (typeof SHORTCUT_SETTING_KEYS)[ShortcutAction];

export const DEFAULT_SHORTCUT_BINDINGS: Record<ShortcutAction, string> = {
  toggleCurrentWindow: 'CmdOrCtrl+Shift+A',
  toggleAllWindows: 'CmdOrCtrl+Shift+Alt+A',
  closeWindow: 'CmdOrCtrl+Shift+W',
  newConversation: 'CmdOrCtrl+N',
  openSettings: 'CmdOrCtrl+,',
  toggleModelSelector: 'CmdOrCtrl+Shift+M',
  fillLastMessage: 'CmdOrCtrl+Shift+ArrowUp',
  clearContext: 'CmdOrCtrl+Shift+K',
  clearConversationMessages: 'CmdOrCtrl+Shift+Backspace',
  toggleGateway: 'CmdOrCtrl+Shift+G',
};

const DISPLAY_MAP: Record<string, string> = {
  CmdOrCtrl: '⌘',
  CommandOrControl: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Control: '⌃',
  Enter: '↩',
  Backspace: '⌫',
  Tab: '⇥',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: '␣',
};

function normalizeModifierToken(token: string): string {
  switch (token) {
    case 'CommandOrControl':
    case 'CmdOrCtrl':
      return 'CmdOrCtrl';
    case 'Control':
    case 'Shift':
    case 'Alt':
      return token;
    default:
      return token;
  }
}

function normalizeKeyToken(token: string): string {
  if (token.length === 1) {
    return token.toUpperCase();
  }
  if (token === 'Comma') return ',';
  if (token === 'Period') return '.';
  if (token === 'Slash') return '/';
  if (token === 'Semicolon') return ';';
  if (token === ' ') return 'Space';
  if (token === 'Esc') return 'Escape';
  return token;
}

function tokenize(binding: string): string[] {
  return binding
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((token) => normalizeKeyToken(normalizeModifierToken(token)));
}

export function getShortcutBinding(settings: AppSettings, action: ShortcutAction): string {
  const key = SHORTCUT_SETTING_KEYS[action];
  const raw = String(settings[key] ?? '').trim();
  if (raw) return raw;
  return DEFAULT_SHORTCUT_BINDINGS[action];
}

export function getShortcutBindingByKey(settings: AppSettings, key: ShortcutSettingKey): string {
  const action = SHORTCUT_ACTIONS.find((item) => SHORTCUT_SETTING_KEYS[item] === key);
  if (!action) {
    throw new Error(`Unknown shortcut setting key: ${key}`);
  }
  return getShortcutBinding(settings, action);
}

export function formatShortcutForDisplay(binding: string): string {
  return tokenize(binding).map((part) => DISPLAY_MAP[part] ?? part).join(' + ');
}

function normalizeEventKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  return key;
}

export function normalizeShortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key'>,
): string | null {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('CmdOrCtrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');

  const key = normalizeEventKey(event.key);
  if (['Control', 'Shift', 'Alt', 'Meta', 'Command'].includes(key)) return null;
  parts.push(key);
  return parts.join('+');
}

export function toTauriAccelerator(binding: string): string {
  return tokenize(binding)
    .map((part) => {
      if (part === 'CmdOrCtrl') return 'CommandOrControl';
      if (part === ',') return 'Comma';
      if (part === '.') return 'Period';
      if (part === '/') return 'Slash';
      if (part === ';') return 'Semicolon';
      return part;
    })
    .join('+');
}

export function matchesShortcutEvent(event: KeyboardEvent, binding: string): boolean {
  const tokens = tokenize(binding);
  if (tokens.length === 0) return false;

  const wantsCmdOrCtrl = tokens.includes('CmdOrCtrl');
  const wantsShift = tokens.includes('Shift');
  const wantsAlt = tokens.includes('Alt');
  const wantsControl = tokens.includes('Control');

  const hasCmdOrCtrl = event.metaKey || event.ctrlKey;

  if (wantsCmdOrCtrl) {
    if (!hasCmdOrCtrl) return false;
  } else if (wantsControl) {
    if (!event.ctrlKey) return false;
  } else if (hasCmdOrCtrl) {
    return false;
  }

  if (wantsShift !== event.shiftKey) return false;
  if (wantsAlt !== event.altKey) return false;

  const keyToken = tokens.find((token) => !['CmdOrCtrl', 'Shift', 'Alt', 'Control'].includes(token));
  if (!keyToken) return false;
  return normalizeEventKey(event.key) === normalizeKeyToken(keyToken);
}

export function detectShortcutConflicts(bindings: Partial<Record<ShortcutAction, string>>): ShortcutConflictMap {
  const grouped = new Map<string, ShortcutAction[]>();
  for (const action of SHORTCUT_ACTIONS) {
    const raw = String(bindings[action] ?? '').trim();
    if (!raw) continue;
    const canonical = toTauriAccelerator(raw).toLowerCase();
    if (!canonical) continue;
    const actions = grouped.get(canonical) ?? [];
    actions.push(action);
    grouped.set(canonical, actions);
  }

  const conflicts: ShortcutConflictMap = {};
  for (const actions of grouped.values()) {
    if (actions.length < 2) continue;
    for (const action of actions) {
      conflicts[action] = actions.filter((item) => item !== action);
    }
  }
  return conflicts;
}
