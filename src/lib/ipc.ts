import { invoke } from '@tauri-apps/api/core';

export async function ipc<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

export async function togglePinConversation(id: string) {
  return invoke('toggle_pin_conversation', { id });
}
