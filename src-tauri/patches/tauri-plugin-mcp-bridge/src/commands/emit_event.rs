//! Event emission.

use serde_json::Value;
use tauri::{command, AppHandle, Emitter, Runtime};

/// Emits a custom event to the application.
///
/// Triggers a named event with a JSON payload that can be listened to by
/// event handlers in the frontend or backend. Useful for testing event
/// handling and triggering custom application behavior.
///
/// # Arguments
///
/// * `app` - The Tauri application handle
/// * `event_name` - Name of the event to emit
/// * `payload` - JSON payload to send with the event
///
/// # Returns
///
/// * `Ok(String)` - Success message
/// * `Err(String)` - Error message if emission fails
///
/// # Examples
///
/// ```typescript
/// import { invoke, listen } from '@tauri-apps/api/core';
///
/// // Set up listener
/// await listen('custom-event', (event) => {
///   console.log('Received:', event.payload);
/// });
///
/// // Emit event
/// await invoke('plugin:mcp-bridge|emit_event', {
///   eventName: 'custom-event',
///   payload: { data: 'test' }
/// });
/// ```
#[command]
pub async fn emit_event<R: Runtime>(
    app: AppHandle<R>,
    event_name: String,
    payload: Value,
) -> Result<String, String> {
    app.emit(&event_name, payload)
        .map_err(|e| format!("Failed to emit event: {e}"))?;
    Ok(format!("Event '{event_name}' emitted successfully"))
}
