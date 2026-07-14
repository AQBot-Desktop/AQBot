//! IPC monitoring commands.

use crate::monitor::{IPCEvent, IPCMonitorState};
use tauri::{command, State};

/// Starts IPC monitoring to capture Tauri command calls.
///
/// Enables the IPC monitor which will begin capturing all subsequent Tauri
/// command invocations with their arguments, results, and timing information.
/// Previous events are cleared when monitoring starts.
///
/// # Arguments
///
/// * `monitor` - Shared state for the IPC monitor
///
/// # Returns
///
/// * `Ok(String)` - Success message
/// * `Err(String)` - Error message if the monitor lock fails
///
/// # Examples
///
/// ```typescript
/// import { invoke } from '@tauri-apps/api/core';
///
/// await invoke('plugin:mcp-bridge|start_ipc_monitor');
/// // Now all IPC calls will be captured
/// ```
///
/// # See Also
///
/// * [`stop_ipc_monitor`] - Stop monitoring
/// * [`get_ipc_events`] - Retrieve captured events
#[command]
pub async fn start_ipc_monitor(monitor: State<'_, IPCMonitorState>) -> Result<String, String> {
    let mut mon = monitor.lock().map_err(|e| format!("Lock error: {e}"))?;
    mon.start();
    Ok("IPC monitoring started".to_string())
}

/// Stops IPC monitoring.
///
/// Disables the IPC monitor, stopping the capture of new events. Previously
/// captured events remain available until monitoring is restarted.
///
/// # Arguments
///
/// * `monitor` - Shared state for the IPC monitor
///
/// # Returns
///
/// * `Ok(String)` - Success message
/// * `Err(String)` - Error message if the monitor lock fails
///
/// # Examples
///
/// ```typescript
/// import { invoke } from '@tauri-apps/api/core';
///
/// await invoke('plugin:mcp-bridge|stop_ipc_monitor');
/// const events = await invoke('plugin:mcp-bridge|get_ipc_events');
/// console.log(`Captured ${events.length} events`);
/// ```
///
/// # See Also
///
/// * [`start_ipc_monitor`] - Start monitoring
/// * [`get_ipc_events`] - Retrieve captured events
#[command]
pub async fn stop_ipc_monitor(monitor: State<'_, IPCMonitorState>) -> Result<String, String> {
    let mut mon = monitor.lock().map_err(|e| format!("Lock error: {e}"))?;
    mon.stop();
    Ok("IPC monitoring stopped".to_string())
}

/// Retrieves all captured IPC events.
///
/// Returns a list of all IPC events captured since monitoring was started.
/// Each event includes the command name, arguments, result, errors, and
/// execution timing.
///
/// # Arguments
///
/// * `monitor` - Shared state for the IPC monitor
///
/// # Returns
///
/// * `Ok(Vec<IPCEvent>)` - List of captured IPC events
/// * `Err(String)` - Error message if the monitor lock fails
///
/// # Examples
///
/// ```typescript
/// import { invoke } from '@tauri-apps/api/core';
///
/// await invoke('plugin:mcp-bridge|start_ipc_monitor');
/// // ... perform some IPC calls ...
/// const events = await invoke('plugin:mcp-bridge|get_ipc_events');
///
/// events.forEach(event => {
///   console.log(`${event.command} took ${event.duration_ms}ms`);
/// });
/// ```
///
/// # See Also
///
/// * [`IPCEvent`](crate::monitor::IPCEvent) - Event structure details
/// * [`start_ipc_monitor`] - Start monitoring
/// * [`stop_ipc_monitor`] - Stop monitoring
#[command]
pub async fn get_ipc_events(monitor: State<'_, IPCMonitorState>) -> Result<Vec<IPCEvent>, String> {
    let mon = monitor.lock().map_err(|e| format!("Lock error: {e}"))?;
    Ok(mon.get_events())
}
