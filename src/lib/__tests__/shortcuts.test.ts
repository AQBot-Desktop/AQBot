import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@/types';
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_ACTIONS,
  SHORTCUT_SETTING_ACTIONS,
  getShortcutBinding,
  formatShortcutForDisplay,
  isShortcutEnabled,
  matchesShortcutEvent,
  normalizeShortcutFromKeyboardEvent,
  toTauriAccelerator,
} from '../shortcuts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shortcuts', () => {
  it('exposes send message as a configurable input shortcut without global handling', () => {
    expect(DEFAULT_SHORTCUT_BINDINGS.sendMessage).toBe('Enter');
    expect(SHORTCUT_SETTING_ACTIONS).toContain('sendMessage');
    expect(SHORTCUT_ACTIONS).not.toContain('sendMessage');
  });

  it('matches the configured send message shortcut', () => {
    const defaultBinding = DEFAULT_SHORTCUT_BINDINGS.sendMessage;

    expect(matchesShortcutEvent(new KeyboardEvent('keydown', { key: 'Enter' }), defaultBinding)).toBe(true);
    expect(matchesShortcutEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }), defaultBinding)).toBe(false);

    const settings = { shortcut_send_message: 'CmdOrCtrl+Enter' } as AppSettings;
    const customBinding = getShortcutBinding(settings, 'sendMessage');

    expect(matchesShortcutEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }), customBinding)).toBe(true);
    expect(matchesShortcutEvent(new KeyboardEvent('keydown', { key: 'Enter' }), customBinding)).toBe(false);
  });

  it('uses defaults when the binding field is missing', () => {
    const settings = {} as AppSettings;
    expect(getShortcutBinding(settings, 'newConversation')).toBe(DEFAULT_SHORTCUT_BINDINGS.newConversation);
    expect(isShortcutEnabled(settings, 'newConversation')).toBe(true);
  });

  it('treats an explicit empty string as disabled', () => {
    const settings = { shortcut_new_conversation: '' } as AppSettings;
    expect(getShortcutBinding(settings, 'newConversation')).toBe('');
    expect(isShortcutEnabled(settings, 'newConversation')).toBe(false);
  });

  it('preserves explicit macOS Control through display and accelerator conversion', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');

    expect(formatShortcutForDisplay('Control+D')).toBe('⌃ + D');
    expect(toTauriAccelerator('Control+D')).toBe('Control+D');
  });

  it('records macOS Control as an explicit Control modifier', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');

    expect(normalizeShortcutFromKeyboardEvent({
      altKey: false,
      ctrlKey: true,
      key: 'd',
      metaKey: false,
      shiftKey: false,
    })).toBe('Control+D');
  });

  it('continues to record macOS Command and Windows Control as CmdOrCtrl', () => {
    const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    expect(normalizeShortcutFromKeyboardEvent({
      altKey: false,
      ctrlKey: false,
      key: 'd',
      metaKey: true,
      shiftKey: false,
    })).toBe('CmdOrCtrl+D');

    platform.mockReturnValue('Win32');
    expect(normalizeShortcutFromKeyboardEvent({
      altKey: false,
      ctrlKey: true,
      key: 'd',
      metaKey: false,
      shiftKey: false,
    })).toBe('CmdOrCtrl+D');
  });
});
