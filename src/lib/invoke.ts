import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { handleCommand } from './browserMock';
import { beginMeasuredInvoke, recordMeasuredInvoke } from './performanceInstrumentation';

export type UnlistenFn = () => void;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const startedAt = beginMeasuredInvoke();
  try {
    const result = isTauri()
      ? await tauriInvoke<T>(cmd, args)
      : await handleCommand<T>(cmd, args);
    recordMeasuredInvoke(cmd, args, result, startedAt, true);
    return result;
  } catch (error) {
    recordMeasuredInvoke(cmd, args, error, startedAt, false);
    throw error;
  }
}

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return tauriListen<T>(event, handler);
  }
  // Browser mode: no-op listener
  return () => {};
}
