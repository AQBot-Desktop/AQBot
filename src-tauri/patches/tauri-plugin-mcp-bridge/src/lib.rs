//! # Tauri MCP Bridge Plugin
//!
//! A Tauri plugin that bridges the Model Context Protocol (MCP) with Tauri applications,
//! enabling deep inspection and interaction with Tauri's IPC layer, backend state, and
//! window management.
//!
//! ## Overview
//!
//! The MCP Bridge plugin extends MCP servers with direct access to Tauri internals.
//! It provides real-time IPC monitoring, window state inspection, backend state access,
//! and event emission capabilities.
//!
//! ## Features
//!
//! - **IPC Monitoring**: Capture and analyze all Tauri IPC calls with timing information
//! - **Window Information**: Query detailed window state (size, position, focus, visibility)
//! - **Backend State**: Access application backend state and metadata
//! - **Event Emission**: Trigger custom events for testing and automation
//! - **WebSocket Server**: Real-time event streaming on dynamically allocated port
//!
//! ## Usage
//!
//! Add the plugin to your Tauri application:
//!
//! ```rust,ignore
//! use tauri_plugin_mcp_bridge;
//!
//! fn main() {
//!     tauri::Builder::default()
//!         .plugin(tauri_plugin_mcp_bridge::init())
//!         .run(tauri::generate_context!())
//!         .expect("error while running tauri application");
//! }
//! ```
//!
//! ## Architecture
//!
//! The plugin consists of three main components:
//!
//! - **Commands Module**: Tauri commands for IPC interaction
//! - **Monitor Module**: IPC event capture and storage
//! - **WebSocket Module**: Real-time event streaming server
//!
//! ## Examples
//!
//! ### Start IPC Monitoring
//!
//! ```typescript
//! import { invoke } from '@tauri-apps/api/core';
//!
//! await invoke('plugin:mcp-bridge|start_ipc_monitor');
//! ```
//!
//! ### Get Window Information
//!
//! ```typescript
//! const info = await invoke('plugin:mcp-bridge|get_window_info');
//! console.log(info); // { width, height, x, y, title, focused, visible }
//! ```
//!
//! ## Permissions
//!
//! The plugin requires the following permissions to be configured in your `capabilities`:
//!
//! - `execute_command`
//! - `get_window_info`
//! - `get_backend_state`
//! - `emit_event`
//! - `start_ipc_monitor`
//! - `stop_ipc_monitor`
//! - `get_ipc_events`

pub mod commands;
pub mod config;
pub mod discovery;
pub mod monitor;
pub mod screenshot;
pub mod script_registry;
pub mod websocket;

pub use config::{Builder, Config};

use commands::ScriptExecutor;
use discovery::find_available_port;
use monitor::IPCMonitor;
use script_registry::create_shared_registry;
use std::sync::{Arc, Mutex};
use tauri::{plugin::Builder as PluginBuilder, plugin::TauriPlugin, Manager, Runtime};

/// Initializes the MCP Bridge plugin.
///
/// This function creates and configures the MCP Bridge plugin with all necessary
/// command handlers and background services. It sets up:
///
/// - IPC monitoring state management
/// - WebSocket server for real-time event streaming (automatic port selection)
/// - All plugin commands for Tauri IPC interaction
///
/// # Type Parameters
///
/// * `R` - The Tauri runtime type (typically `tauri::Wry`)
///
/// # Returns
///
/// A configured `TauriPlugin` ready to be added to your Tauri application.
///
/// # Examples
///
/// ```rust,ignore
/// use tauri_plugin_mcp_bridge;
///
/// tauri::Builder::default()
///     .plugin(tauri_plugin_mcp_bridge::init())
///     .run(tauri::generate_context!())
///     .expect("error while running tauri application");
/// ```
///
/// # Background Services
///
/// The plugin automatically starts a WebSocket server on an available port
/// (starting from 9223). This server runs in the background and does not
/// block the main application thread.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    init_with_config(Config::default())
}

/// Initializes the MCP Bridge plugin with custom configuration.
///
/// # Arguments
///
/// * `config` - The configuration options for the plugin
///
/// # Examples
///
/// ```rust,ignore
/// use tauri_plugin_mcp_bridge::{Config, init_with_config};
///
/// // Localhost only:
/// let config = Config::localhost_only();
/// tauri::Builder::default()
///     .plugin(init_with_config(config))
///     .run(tauri::generate_context!())
///     .expect("error while running tauri application");
/// ```
pub fn init_with_config<R: Runtime>(config: Config) -> TauriPlugin<R> {
    let bind_address = config.bind_address.clone();

    PluginBuilder::<R>::new("mcp-bridge")
        .invoke_handler(tauri::generate_handler![
            commands::execute_command::execute_command,
            commands::window_info::get_window_info,
            commands::backend_state::get_backend_state,
            commands::emit_event::emit_event,
            commands::ipc_monitor::start_ipc_monitor,
            commands::ipc_monitor::stop_ipc_monitor,
            commands::ipc_monitor::get_ipc_events,
            commands::execute_js::execute_js,
            commands::script_executor::script_result,
            commands::screenshot::capture_native_screenshot,
            commands::list_windows::list_windows,
            commands::script_injection::request_script_injection,
        ])
        .js_init_script(include_str!("bridge.js").to_string())
        .setup(move |app, _api| {
            // Initialize script executor state
            app.manage(ScriptExecutor::new());

            // Initialize IPC monitor state
            let monitor = Arc::new(Mutex::new(IPCMonitor::new()));
            app.manage(monitor.clone());

            // Initialize script registry for persistent script injection
            let script_registry = create_shared_registry();
            app.manage(script_registry);

            // Find an available port for WebSocket server
            let port = find_available_port(&bind_address);

            // Log app information for debugging
            let app_name = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| "Tauri App".to_string());

            let identifier = app.config().identifier.clone();

            // Start WebSocket server in background
            let app_handle = app.clone();
            let (ws_server, _event_rx) =
                websocket::WebSocketServer::new(port, &bind_address, app_handle);

            tauri::async_runtime::spawn(async move {
                if let Err(e) = ws_server.start().await {
                    eprintln!("WebSocket server error: {e}");
                }
            });

            println!(
                "MCP Bridge plugin initialized for '{app_name}' ({identifier}) on {bind_address}:{port}"
            );
            Ok(())
        })
        .build()
}
