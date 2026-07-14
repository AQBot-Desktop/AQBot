import { invoke } from '@tauri-apps/api/core';

export interface WindowInfo {
   width: number;
   height: number;
   x: number;
   y: number;
   title: string;
   focused: boolean;
   visible: boolean;
}

export interface BackendState {
   status: string;
   windows: number;
}

export interface IPCEvent {
   timestamp: number;
   command: string;
   args: unknown;
   result?: unknown;
   error?: string;
   duration_ms?: number;
}

/**
 * Execute an arbitrary Tauri command
 */
export async function executeCommand(command: string, args?: unknown): Promise<unknown> {
   return await invoke('plugin:mcp-bridge|execute_command', { command, args });
}

/**
 * Get information about the current window
 */
export async function getWindowInfo(): Promise<WindowInfo> {
   return await invoke('plugin:mcp-bridge|get_window_info');
}

/**
 * Get backend application state
 */
export async function getBackendState(): Promise<BackendState> {
   return await invoke('plugin:mcp-bridge|get_backend_state');
}

/**
 * Emit a custom event for testing
 */
export async function emitEvent(eventName: string, payload?: unknown): Promise<string> {
   return await invoke('plugin:mcp-bridge|emit_event', { eventName, payload });
}

/**
 * Start IPC monitoring - captures all invoke() calls
 */
export async function startIPCMonitor(): Promise<string> {
   return await invoke('plugin:mcp-bridge|start_ipc_monitor');
}

/**
 * Stop IPC monitoring
 */
export async function stopIPCMonitor(): Promise<string> {
   return await invoke('plugin:mcp-bridge|stop_ipc_monitor');
}

/**
 * Get all captured IPC events
 */
export async function getIPCEvents(): Promise<IPCEvent[]> {
   return await invoke('plugin:mcp-bridge|get_ipc_events');
}
