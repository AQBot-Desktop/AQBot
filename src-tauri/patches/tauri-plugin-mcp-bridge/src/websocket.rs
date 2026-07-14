//! WebSocket server for real-time event streaming.
//!
//! This module provides a WebSocket server that enables real-time communication
//! between the Tauri application and external MCP clients. It broadcasts events
//! to all connected clients and can receive commands from them.

use crate::commands::{resolve_window_with_context, WindowContext};
use crate::script_registry::{ScriptEntry, ScriptType, SharedScriptRegistry};
use futures_util::{SinkExt, StreamExt};
use serde_json;
use std::net::SocketAddr;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// WebSocket server for real-time event streaming to MCP clients.
///
/// The server listens on a specified port and accepts multiple concurrent
/// WebSocket connections. It uses a broadcast channel to send events to all
/// connected clients simultaneously.
///
/// # Architecture
///
/// - Binds to 0.0.0.0 by default (all interfaces) for remote device support
/// - Runs on port 9223 by default (or next available in range 9223-9322)
/// - Supports multiple concurrent client connections
/// - Uses broadcast channels for event distribution
/// - Handles client disconnections gracefully
///
/// # Examples
///
/// ```rust,ignore
/// use tauri_plugin_mcp_bridge::websocket::WebSocketServer;
///
/// #[tokio::main]
/// async fn main() {
///     // Requires a Tauri AppHandle
///     let (server, _rx) = WebSocketServer::new(9223, "0.0.0.0", app_handle);
///
///     tokio::spawn(async move {
///         if let Err(e) = server.start().await {
///             eprintln!("WebSocket error: {}", e);
///         }
///     });
/// }
/// ```
pub struct WebSocketServer<R: Runtime> {
    addr: SocketAddr,
    event_tx: broadcast::Sender<String>,
    app: AppHandle<R>,
}

impl<R: Runtime> WebSocketServer<R> {
    /// Creates a new WebSocket server on the specified port and bind address.
    ///
    /// # Arguments
    ///
    /// * `port` - The port number to bind the server to (typically 9223)
    /// * `bind_address` - The address to bind to (e.g., "0.0.0.0" or "127.0.0.1")
    /// * `app` - The Tauri application handle
    ///
    /// # Returns
    ///
    /// A tuple containing:
    /// - The `WebSocketServer` instance
    /// - A broadcast receiver for monitoring events
    ///
    /// # Examples
    ///
    /// ```rust,ignore
    /// use tauri_plugin_mcp_bridge::websocket::WebSocketServer;
    ///
    /// // Bind to all interfaces (for remote device access)
    /// let (server, event_rx) = WebSocketServer::new(9223, "0.0.0.0", app_handle);
    ///
    /// // Bind to localhost only
    /// let (server, event_rx) = WebSocketServer::new(9223, "127.0.0.1", app_handle);
    /// ```
    pub fn new(
        port: u16,
        bind_address: &str,
        app: AppHandle<R>,
    ) -> (Self, broadcast::Receiver<String>) {
        let addr: SocketAddr = format!("{bind_address}:{port}").parse().unwrap();
        let (event_tx, event_rx) = broadcast::channel(100);

        (
            Self {
                addr,
                event_tx,
                app,
            },
            event_rx,
        )
    }

    /// Starts the WebSocket server and begins accepting connections.
    ///
    /// This method runs indefinitely, accepting new WebSocket connections and
    /// spawning a handler task for each client. It should be run in a background
    /// task using `tokio::spawn`.
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Never returns normally (runs until error)
    /// * `Err(Box<dyn std::error::Error>)` - If the server fails to bind or accept connections
    ///
    /// # Examples
    ///
    /// ```rust,ignore
    /// use tauri_plugin_mcp_bridge::websocket::WebSocketServer;
    ///
    /// #[tokio::main]
    /// async fn main() {
    ///     // Requires a Tauri AppHandle
    ///     let (server, _rx) = WebSocketServer::new(9223, "0.0.0.0", app_handle);
    ///
    ///     tokio::spawn(async move {
    ///         if let Err(e) = server.start().await {
    ///             eprintln!("WebSocket server error: {}", e);
    ///         }
    ///     });
    /// }
    /// ```
    pub async fn start(self) -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind(&self.addr).await?;
        println!("MCP Bridge WebSocket server listening on: {}", self.addr);

        loop {
            let (stream, _) = listener.accept().await?;
            let event_tx = self.event_tx.clone();
            let app = self.app.clone();

            tokio::spawn(async move {
                if let Err(e) = handle_connection(stream, event_tx, app).await {
                    eprintln!("WebSocket connection error: {e}");
                }
            });
        }
    }

    /// Broadcasts a message to all connected WebSocket clients.
    ///
    /// Sends the message through the broadcast channel to all active client
    /// connections. If no clients are connected, the message is dropped.
    ///
    /// # Arguments
    ///
    /// * `message` - The message string to broadcast
    ///
    /// # Examples
    ///
    /// ```rust,ignore
    /// use tauri_plugin_mcp_bridge::websocket::WebSocketServer;
    ///
    /// // Requires a Tauri AppHandle
    /// let (server, _rx) = WebSocketServer::new(9223, "0.0.0.0", app_handle);
    /// server.broadcast("Hello, clients!");
    /// ```
    pub fn broadcast(&self, message: &str) {
        let _ = self.event_tx.send(message.to_string());
    }
}

/// Handles a single WebSocket client connection.
///
/// This function manages the lifecycle of a WebSocket connection, including:
/// - Upgrading the TCP stream to WebSocket
/// - Forwarding broadcast events to the client
/// - Receiving and processing messages from the client (request/response)
/// - Handling disconnections and errors
///
/// # Arguments
///
/// * `stream` - The TCP stream for the client connection
/// * `event_tx` - Broadcast sender for distributing events
///
/// # Returns
///
/// * `Ok(())` - When the connection closes normally
/// * `Err(Box<dyn std::error::Error>)` - If an error occurs during communication
async fn handle_connection<R: Runtime>(
    stream: TcpStream,
    event_tx: broadcast::Sender<String>,
    app: AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    let ws_stream = accept_async(stream).await?;
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let mut event_rx = event_tx.subscribe();

    // Create channel for sending responses from receive task to send task
    let (response_tx, mut response_rx) = mpsc::unbounded_channel::<String>();

    // Spawn task to handle outgoing messages (both broadcasts and responses)
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Handle broadcast events
                Ok(msg) = event_rx.recv() => {
                    if let Err(e) = ws_sender.send(Message::Text(msg.into())).await {
                        eprintln!("Failed to send broadcast: {e}");
                        break;
                    }
                }
                // Handle responses to client requests
                Some(response) = response_rx.recv() => {
                    if let Err(e) = ws_sender.send(Message::Text(response.into())).await {
                        eprintln!("Failed to send response: {e}");
                        break;
                    }
                }
                else => break,
            }
        }
    });

    // Handle incoming messages from client (request/response)
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Parse incoming command and send response
                if let Ok(command) = serde_json::from_str::<serde_json::Value>(&text) {
                    let id = command.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let cmd_name = command
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");

                    // Handle commands
                    let response = if cmd_name == "invoke_tauri" {
                        // Handle Tauri IPC command invocation
                        if let Some(args) = command.get("args") {
                            if let Some(tauri_cmd) = args.get("command").and_then(|v| v.as_str()) {
                                // Call the actual Tauri commands
                                use crate::commands;

                                // Get optional window_label from args for window targeting
                                let window_label = args
                                    .get("args")
                                    .and_then(|a| a.get("windowLabel"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                match tauri_cmd {
                                    "plugin:mcp-bridge|get_window_info" => {
                                        match commands::resolve_window(&app, window_label.clone()) {
                                            Ok(window) => {
                                                match commands::get_window_info(window).await {
                                                    Ok(data) => serde_json::json!({
                                                        "id": id,
                                                        "success": true,
                                                        "data": data
                                                    }),
                                                    Err(e) => serde_json::json!({
                                                        "id": id,
                                                        "success": false,
                                                        "error": e
                                                    }),
                                                }
                                            }
                                            Err(e) => serde_json::json!({
                                                "id": id,
                                                "success": false,
                                                "error": e
                                            }),
                                        }
                                    }
                                    "plugin:mcp-bridge|get_backend_state" => {
                                        match commands::get_backend_state(app.clone()).await {
                                            Ok(data) => serde_json::json!({
                                                "id": id,
                                                "success": true,
                                                "data": data
                                            }),
                                            Err(e) => serde_json::json!({
                                                "id": id,
                                                "success": false,
                                                "error": e
                                            }),
                                        }
                                    }
                                    "plugin:mcp-bridge|start_ipc_monitor" => {
                                        match commands::start_ipc_monitor(app.state()).await {
                                            Ok(data) => serde_json::json!({
                                                "id": id,
                                                "success": true,
                                                "data": data
                                            }),
                                            Err(e) => serde_json::json!({
                                                "id": id,
                                                "success": false,
                                                "error": e
                                            }),
                                        }
                                    }
                                    "plugin:mcp-bridge|stop_ipc_monitor" => {
                                        match commands::stop_ipc_monitor(app.state()).await {
                                            Ok(data) => serde_json::json!({
                                                "id": id,
                                                "success": true,
                                                "data": data
                                            }),
                                            Err(e) => serde_json::json!({
                                                "id": id,
                                                "success": false,
                                                "error": e
                                            }),
                                        }
                                    }
                                    "plugin:mcp-bridge|get_ipc_events" => {
                                        match commands::get_ipc_events(app.state()).await {
                                            Ok(data) => serde_json::json!({
                                                "id": id,
                                                "success": true,
                                                "data": data
                                            }),
                                            Err(e) => serde_json::json!({
                                                "id": id,
                                                "success": false,
                                                "error": e
                                            }),
                                        }
                                    }
                                    "plugin:mcp-bridge|emit_event" => {
                                        if let Some(event_name) = args
                                            .get("args")
                                            .and_then(|a| a.get("eventName"))
                                            .and_then(|v| v.as_str())
                                        {
                                            let payload = args
                                                .get("args")
                                                .and_then(|a| a.get("payload"))
                                                .cloned()
                                                .unwrap_or(serde_json::json!(null));
                                            match commands::emit_event(
                                                app.clone(),
                                                event_name.to_string(),
                                                payload,
                                            )
                                            .await
                                            {
                                                Ok(data) => serde_json::json!({
                                                    "id": id,
                                                    "success": true,
                                                    "data": data
                                                }),
                                                Err(e) => serde_json::json!({
                                                    "id": id,
                                                    "success": false,
                                                    "error": e
                                                }),
                                            }
                                        } else {
                                            serde_json::json!({
                                                "id": id,
                                                "success": false,
                                                "error": "Missing eventName in args"
                                            })
                                        }
                                    }
                                    _ => {
                                        serde_json::json!({
                                            "id": id,
                                            "success": false,
                                            "error": format!("Unsupported Tauri command: {}", tauri_cmd)
                                        })
                                    }
                                }
                            } else {
                                serde_json::json!({
                                    "id": id,
                                    "success": false,
                                    "error": "Missing command in args"
                                })
                            }
                        } else {
                            serde_json::json!({
                                "id": id,
                                "success": false,
                                "error": "Missing args for invoke_tauri"
                            })
                        }
                    } else if cmd_name == "list_windows" {
                        // Handle window listing
                        match crate::commands::list_windows(app.clone()).await {
                            Ok(data) => serde_json::json!({
                                "id": id,
                                "success": true,
                                "data": data
                            }),
                            Err(e) => serde_json::json!({
                                "id": id,
                                "success": false,
                                "error": e
                            }),
                        }
                    } else if cmd_name == "execute_js" {
                        if let Some(args) = command.get("args") {
                            if let Some(script) = args.get("script").and_then(|v| v.as_str()) {
                                // Get optional window_label, defaulting to "main"
                                let window_label = args
                                    .get("windowLabel")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                // Resolve the target window with context
                                match crate::commands::resolve_window_with_context(
                                    &app,
                                    window_label,
                                ) {
                                    Ok(resolved) => {
                                        // Get the script executor state and create State wrapper
                                        let executor_state =
                                            app.state::<crate::commands::ScriptExecutor>();
                                        // Call the execute_js command with state
                                        match crate::commands::execute_js(
                                            resolved.window.clone(),
                                            script.to_string(),
                                            executor_state,
                                        )
                                        .await
                                        {
                                            Ok(result) => {
                                                serde_json::json!({
                                                    "id": id,
                                                    "success": result.get("success").and_then(|v| v.as_bool()).unwrap_or(true),
                                                    "data": result.get("data").cloned(),
                                                    "error": result.get("error").and_then(|v| v.as_str()),
                                                    "windowContext": resolved.context
                                                })
                                            }
                                            Err(e) => {
                                                serde_json::json!({
                                                    "id": id,
                                                    "success": false,
                                                    "error": e,
                                                    "windowContext": resolved.context
                                                })
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        serde_json::json!({
                                            "id": id,
                                            "success": false,
                                            "error": e
                                        })
                                    }
                                }
                            } else {
                                serde_json::json!({
                                    "id": id,
                                    "success": false,
                                    "error": "Missing script argument"
                                })
                            }
                        } else {
                            serde_json::json!({
                                "id": id,
                                "success": false,
                                "error": "Missing args"
                            })
                        }
                    } else if cmd_name == "capture_native_screenshot" {
                        // Handle native screenshot capture
                        let args = command.get("args");
                        let format = args
                            .and_then(|a| a.get("format"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let quality = args
                            .and_then(|a| a.get("quality"))
                            .and_then(|v| v.as_u64())
                            .map(|q| q as u8);
                        let window_label = args
                            .and_then(|a| a.get("windowLabel"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        // Resolve the target window with context
                        match crate::commands::resolve_window_with_context(&app, window_label) {
                            Ok(resolved) => {
                                match crate::commands::capture_native_screenshot(
                                    resolved.window,
                                    format,
                                    quality,
                                )
                                .await
                                {
                                    Ok(data_url) => {
                                        serde_json::json!({
                                            "id": id,
                                            "success": true,
                                            "data": data_url,
                                            "windowContext": resolved.context
                                        })
                                    }
                                    Err(e) => {
                                        serde_json::json!({
                                            "id": id,
                                            "success": false,
                                            "error": e,
                                            "windowContext": resolved.context
                                        })
                                    }
                                }
                            }
                            Err(e) => {
                                serde_json::json!({
                                    "id": id,
                                    "success": false,
                                    "error": e
                                })
                            }
                        }
                    } else if cmd_name == "register_script" {
                        // Handle script registration
                        if let Some(args) = command.get("args") {
                            let script_id = args.get("id").and_then(|v| v.as_str());
                            let script_type_str = args.get("type").and_then(|v| v.as_str());
                            let content = args.get("content").and_then(|v| v.as_str());

                            match (script_id, script_type_str, content) {
                                (Some(id_str), Some(type_str), Some(content_str)) => {
                                    let script_type = match type_str {
                                        "url" => ScriptType::Url,
                                        _ => ScriptType::Inline,
                                    };

                                    let entry = ScriptEntry {
                                        id: id_str.to_string(),
                                        script_type,
                                        content: content_str.to_string(),
                                    };

                                    // Add to registry
                                    let registry: tauri::State<'_, SharedScriptRegistry> =
                                        app.state();
                                    {
                                        let mut reg = registry.lock().unwrap();
                                        reg.add(entry.clone());
                                    }

                                    // Inject the script into the webview
                                    let window_label = args
                                        .get("windowLabel")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());

                                    match inject_script_to_webview(&app, &entry, window_label) {
                                        Ok(result) => serde_json::json!({
                                            "id": id,
                                            "success": true,
                                            "data": { "registered": true, "scriptId": id_str },
                                            "windowContext": {
                                                "windowLabel": result.window_context.window_label,
                                                "totalWindows": result.window_context.total_windows,
                                                "warning": result.window_context.warning
                                            }
                                        }),
                                        Err(e) => serde_json::json!({
                                            "id": id,
                                            "success": false,
                                            "error": e
                                        }),
                                    }
                                }
                                _ => serde_json::json!({
                                    "id": id,
                                    "success": false,
                                    "error": "Missing required args: id, type, content"
                                }),
                            }
                        } else {
                            serde_json::json!({
                                "id": id,
                                "success": false,
                                "error": "Missing args for register_script"
                            })
                        }
                    } else if cmd_name == "remove_script" {
                        // Handle script removal
                        if let Some(args) = command.get("args") {
                            if let Some(script_id) = args.get("id").and_then(|v| v.as_str()) {
                                let registry: tauri::State<'_, SharedScriptRegistry> = app.state();
                                let removed = {
                                    let mut reg = registry.lock().unwrap();
                                    reg.remove(script_id).is_some()
                                };

                                // Remove from DOM
                                let window_label = args
                                    .get("windowLabel")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                match remove_script_from_webview(&app, script_id, window_label) {
                                    Ok(result) => serde_json::json!({
                                        "id": id,
                                        "success": true,
                                        "data": { "removed": removed, "scriptId": script_id },
                                        "windowContext": {
                                            "windowLabel": result.window_context.window_label,
                                            "totalWindows": result.window_context.total_windows,
                                            "warning": result.window_context.warning
                                        }
                                    }),
                                    Err(e) => {
                                        eprintln!("Failed to remove script from DOM: {e}");
                                        serde_json::json!({
                                            "id": id,
                                            "success": true,
                                            "data": { "removed": removed, "scriptId": script_id },
                                            "error": format!("Script removed from registry but DOM removal failed: {e}")
                                        })
                                    }
                                }
                            } else {
                                serde_json::json!({
                                    "id": id,
                                    "success": false,
                                    "error": "Missing script id"
                                })
                            }
                        } else {
                            serde_json::json!({
                                "id": id,
                                "success": false,
                                "error": "Missing args for remove_script"
                            })
                        }
                    } else if cmd_name == "clear_scripts" {
                        // Handle clearing all scripts
                        let registry: tauri::State<'_, SharedScriptRegistry> = app.state();
                        let count = {
                            let mut reg = registry.lock().unwrap();
                            let count = reg.len();
                            reg.clear();
                            count
                        };

                        // Clear from DOM
                        let window_label = command
                            .get("args")
                            .and_then(|a| a.get("windowLabel"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        match clear_scripts_from_webview(&app, window_label) {
                            Ok(result) => serde_json::json!({
                                "id": id,
                                "success": true,
                                "data": { "cleared": count },
                                "windowContext": {
                                    "windowLabel": result.window_context.window_label,
                                    "totalWindows": result.window_context.total_windows,
                                    "warning": result.window_context.warning
                                }
                            }),
                            Err(e) => {
                                eprintln!("Failed to clear scripts from DOM: {e}");
                                serde_json::json!({
                                    "id": id,
                                    "success": true,
                                    "data": { "cleared": count },
                                    "error": format!("Scripts cleared from registry but DOM clear failed: {e}")
                                })
                            }
                        }
                    } else if cmd_name == "get_scripts" {
                        // Handle getting all registered scripts
                        let registry: tauri::State<'_, SharedScriptRegistry> = app.state();
                        let scripts: Vec<serde_json::Value> = {
                            let reg = registry.lock().unwrap();
                            reg.get_all()
                                .iter()
                                .map(|entry| {
                                    serde_json::json!({
                                        "id": entry.id,
                                        "type": match entry.script_type {
                                            ScriptType::Inline => "inline",
                                            ScriptType::Url => "url",
                                        },
                                        "content": entry.content
                                    })
                                })
                                .collect()
                        };

                        serde_json::json!({
                            "id": id,
                            "success": true,
                            "data": { "scripts": scripts }
                        })
                    } else {
                        // Unknown command
                        serde_json::json!({
                            "id": id,
                            "success": false,
                            "error": format!("Unknown command: {}", cmd_name)
                        })
                    };

                    let _ = response_tx.send(response.to_string());
                } else {
                    eprintln!("Failed to parse command: {text}");
                }
            }
            Ok(Message::Close(_)) => {
                println!("Client disconnected");
                break;
            }
            Err(e) => {
                eprintln!("WebSocket error: {e}");
                break;
            }
            _ => {}
        }
    }

    send_task.abort();
    Ok(())
}

/// Result of a script operation with window context.
struct ScriptOperationResult {
    window_context: WindowContext,
}

/// Injects a script into a specific webview window.
fn inject_script_to_window<R: Runtime>(
    window: &WebviewWindow<R>,
    entry: &ScriptEntry,
) -> Result<(), String> {
    let script = match entry.script_type {
        ScriptType::Inline => format!(
            r#"
            (function() {{
                var existing = document.querySelector('script[data-mcp-script-id="{}"]');
                if (existing) {{
                    existing.remove();
                }}
                var script = document.createElement('script');
                script.setAttribute('data-mcp-script-id', '{}');
                script.textContent = {};
                document.head.appendChild(script);
            }})();
            "#,
            entry.id,
            entry.id,
            serde_json::to_string(&entry.content).unwrap_or_else(|_| "''".to_string())
        ),
        ScriptType::Url => format!(
            r#"
            (function() {{
                var existing = document.querySelector('script[data-mcp-script-id="{}"]');
                if (existing) {{
                    existing.remove();
                }}
                var script = document.createElement('script');
                script.setAttribute('data-mcp-script-id', '{}');
                script.src = {};
                script.async = true;
                document.head.appendChild(script);
            }})();
            "#,
            entry.id,
            entry.id,
            serde_json::to_string(&entry.content).unwrap_or_else(|_| "''".to_string())
        ),
    };

    window
        .eval(&script)
        .map_err(|e| format!("Failed to inject script: {e}"))
}

/// Injects a script into the webview DOM.
/// If a script with the same ID already exists, it is removed first.
/// Returns window context for the response.
fn inject_script_to_webview<R: Runtime>(
    app: &AppHandle<R>,
    entry: &ScriptEntry,
    window_label: Option<String>,
) -> Result<ScriptOperationResult, String> {
    let resolved = resolve_window_with_context(app, window_label)?;

    inject_script_to_window(&resolved.window, entry)?;

    Ok(ScriptOperationResult {
        window_context: resolved.context,
    })
}

/// Removes a script from a specific window's DOM.
fn remove_script_from_window<R: Runtime>(
    window: &WebviewWindow<R>,
    script_id: &str,
) -> Result<(), String> {
    let script = format!(
        r#"
        (function() {{
            var script = document.querySelector('script[data-mcp-script-id="{script_id}"]');
            if (script) {{
                script.remove();
            }}
        }})();
        "#
    );

    window
        .eval(&script)
        .map_err(|e| format!("Failed to remove script: {e}"))
}

/// Removes a script from the webview DOM by ID.
/// Returns window context for the response.
fn remove_script_from_webview<R: Runtime>(
    app: &AppHandle<R>,
    script_id: &str,
    window_label: Option<String>,
) -> Result<ScriptOperationResult, String> {
    let resolved = resolve_window_with_context(app, window_label)?;

    remove_script_from_window(&resolved.window, script_id)?;

    Ok(ScriptOperationResult {
        window_context: resolved.context,
    })
}

/// Clears all MCP-managed scripts from a specific window's DOM.
fn clear_scripts_from_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let script = r#"
        (function() {
            var scripts = document.querySelectorAll('script[data-mcp-script-id]');
            scripts.forEach(function(s) { s.remove(); });
        })();
    "#;

    window
        .eval(script)
        .map_err(|e| format!("Failed to clear scripts: {e}"))
}

/// Clears all MCP-managed scripts from the webview DOM.
/// Returns window context for the response.
fn clear_scripts_from_webview<R: Runtime>(
    app: &AppHandle<R>,
    window_label: Option<String>,
) -> Result<ScriptOperationResult, String> {
    let resolved = resolve_window_with_context(app, window_label)?;

    clear_scripts_from_window(&resolved.window)?;

    Ok(ScriptOperationResult {
        window_context: resolved.context,
    })
}

/// Injects all registered scripts into the webview.
/// Called when a page loads to re-inject persistent scripts.
pub fn inject_all_scripts<R: Runtime>(
    app: &AppHandle<R>,
    window_label: Option<String>,
) -> Result<usize, String> {
    let registry: tauri::State<'_, SharedScriptRegistry> = app.state();
    let scripts: Vec<ScriptEntry> = {
        let reg = registry.lock().unwrap();
        reg.get_all().iter().map(|e| (*e).clone()).collect()
    };

    let resolved = resolve_window_with_context(app, window_label)?;

    for entry in &scripts {
        inject_script_to_window(&resolved.window, entry)?;
    }

    Ok(scripts.len())
}
