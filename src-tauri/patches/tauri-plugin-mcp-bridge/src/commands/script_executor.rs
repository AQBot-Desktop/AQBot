//! Script executor state and result handling.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{command, AppHandle, Manager, Runtime};
use tokio::sync::{oneshot, Mutex};

/// Store for pending script execution results
pub type PendingResults = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// Script executor state for managing JavaScript execution
pub struct ScriptExecutor {
    pub pending_results: PendingResults,
}

impl ScriptExecutor {
    pub fn new() -> Self {
        Self {
            pending_results: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for ScriptExecutor {
    fn default() -> Self {
        Self::new()
    }
}

/// Command to receive script execution results from JavaScript.
///
/// This is called by JavaScript after script execution completes.
#[command]
pub async fn script_result<R: Runtime>(
    app: AppHandle<R>,
    exec_id: String,
    success: bool,
    data: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    // Get the script executor from app state
    if let Some(executor) = app.try_state::<ScriptExecutor>() {
        let mut pending = executor.pending_results.lock().await;

        // Find and complete the pending result
        if let Some(sender) = pending.remove(&exec_id) {
            let result = if success {
                serde_json::json!({
                    "success": true,
                    "data": data.unwrap_or(Value::Null)
                })
            } else {
                serde_json::json!({
                    "success": false,
                    "error": error.unwrap_or_else(|| "Unknown error".to_string())
                })
            };

            // Send result through the channel (ignore if receiver dropped)
            let _ = sender.send(result);
        }
    }

    Ok(())
}
