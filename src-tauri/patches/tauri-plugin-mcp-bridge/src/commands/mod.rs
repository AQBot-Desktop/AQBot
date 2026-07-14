//! Command handlers for the MCP Bridge plugin.
//!
//! This module provides Tauri command handlers that expose plugin functionality
//! to the frontend via IPC. All commands are prefixed with `plugin:mcp-bridge|`
//! when invoked from the frontend.

// Individual command modules
pub mod backend_state;
pub mod emit_event;
pub mod execute_command;
pub mod execute_js;
pub mod ipc_monitor;
pub mod list_windows;
pub mod screenshot;
pub mod script_executor;
pub mod script_injection;
pub mod window_info;

// Re-export types and commands for convenience
pub use script_executor::ScriptExecutor;

// Re-export command functions (needed for generate_handler! macro)
pub use backend_state::get_backend_state;
pub use emit_event::emit_event;
pub use execute_command::execute_command;
pub use execute_js::execute_js;
pub use ipc_monitor::{get_ipc_events, start_ipc_monitor, stop_ipc_monitor};
pub use list_windows::{
    list_windows, resolve_window, resolve_window_with_context, ResolvedWindow, WindowContext,
    WindowInfo,
};
pub use screenshot::capture_native_screenshot;
pub use script_executor::script_result;
pub use script_injection::request_script_injection;
pub use window_info::get_window_info;
