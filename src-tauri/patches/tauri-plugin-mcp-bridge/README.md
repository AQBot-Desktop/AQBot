# Tauri MCP Bridge Plugin

[![Crates.io](https://img.shields.io/crates/v/tauri-plugin-mcp-bridge.svg)](https://crates.io/crates/tauri-plugin-mcp-bridge)
[![npm](https://img.shields.io/npm/v/@hypothesi/tauri-plugin-mcp-bridge.svg)](https://www.npmjs.com/package/@hypothesi/tauri-plugin-mcp-bridge)
[![Documentation](https://docs.rs/tauri-plugin-mcp-bridge/badge.svg)](https://docs.rs/tauri-plugin-mcp-bridge)
[![License](https://img.shields.io/crates/l/tauri-plugin-mcp-bridge.svg)](https://github.com/hypothesi/mcp-server-tauri)

A Tauri plugin that bridges the Model Context Protocol (MCP) with Tauri applications, enabling deep inspection and interaction with Tauri's IPC layer, backend state, and window management.

> **📦 This npm package is optional.** It provides TypeScript bindings for calling the plugin from your app's frontend code. If you're just using the [MCP Server for Tauri](https://github.com/hypothesi/mcp-server-tauri), you only need the **Rust crate** (`tauri-plugin-mcp-bridge`)—the MCP server communicates with it directly via WebSocket.

## Overview

The MCP Bridge plugin extends MCP servers with direct access to Tauri internals. It provides real-time IPC monitoring, window state inspection, backend state access, and event emission capabilities.

## Installation

```bash
cargo add tauri-plugin-mcp-bridge
```

Or add manually to your `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-mcp-bridge = "0.2"
```

### Optional: TypeScript Bindings

If you want to call the plugin from your app's frontend code (not required for MCP server functionality):

```bash
npm install --save-exact @hypothesi/tauri-plugin-mcp-bridge
```

## Usage

Register the plugin in your Tauri application:

```rust
fn main() {
    let mut builder = tauri::Builder::default();

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Custom Configuration

By default, the plugin binds to `0.0.0.0` (all interfaces) to support remote device development. For localhost-only access:

```rust
use tauri_plugin_mcp_bridge::Builder;

fn main() {
    tauri::Builder::default()
        .plugin(Builder::new().bind_address("127.0.0.1").build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Features

### 1. IPC Monitoring

Monitor all Tauri IPC calls in real-time with timing and argument capture:

```typescript
// Start monitoring
await invoke('plugin:mcp-bridge|start_ipc_monitor');

// Execute some commands to generate IPC traffic
await invoke('greet', { name: 'World' });

// Get captured events
const events = await invoke('plugin:mcp-bridge|get_ipc_events');
```

### 2. Window Information

Get detailed window state:

```typescript
const windowInfo = await invoke('plugin:mcp-bridge|get_window_info');
// Returns: { width, height, x, y, title, focused, visible }
```

### 3. Backend State

Inspect application backend state:

```typescript
const state = await invoke('plugin:mcp-bridge|get_backend_state');
// Returns: { app: { name, identifier, version }, tauri: { version },
//            environment: { debug, os, arch, family }, windows: [...], timestamp }
```

### 4. Event Emission

Trigger custom events for testing:

```typescript
await invoke('plugin:mcp-bridge|emit_event', {
  eventName: 'custom-event',
  payload: { data: 'test' }
});
```

## MCP Server Integration

This plugin is part of the larger MCP Server for Tauri, which provides **23 total MCP tools** for comprehensive Tauri development and testing. The plugin specifically enables the following tools:

### Project Management Tools (4)

1. **tauri_run_command** - Run any Tauri CLI command with full flexibility
2. **tauri_read_config** - Read Tauri configuration files (including platform-specific configs)
3. **tauri_write_config** - Write to Tauri configuration files with validation
4. **tauri_get_docs** - Get Tauri documentation (LLM Cheat Sheet) for the detected project version

### Mobile Development Tools (2)

1. **tauri_list_devices** - List connected Android devices and iOS simulators
2. **tauri_launch_emulator** - Launch an Android AVD or iOS Simulator

### UI Automation & WebView Tools (11)

Tools for UI automation and webview interaction via the plugin's WebSocket connection:

1. **tauri_driver_session** - Manage automation session (start or stop)
2. **tauri_webview_find_element** - Find an element in the webview
3. **tauri_driver_get_console_logs** - Get console logs from the webview
4. **tauri_read_platform_logs** - Read platform logs (Android logcat, iOS device logs, system logs)
5. **tauri_webview_interact** - Perform gestures (click, double-click, long-press, swipe, scroll)
6. **tauri_webview_screenshot** - Take screenshots of the entire webview
7. **tauri_webview_keyboard** - Type text or simulate keyboard events with optional modifiers
8. **tauri_webview_wait_for** - Wait for element selectors, text content, or IPC events
9. **tauri_webview_get_styles** - Get computed CSS styles for element(s)
10. **tauri_webview_execute_js** - Execute arbitrary JavaScript code in the webview context
11. **tauri_webview_focus_element** - Focus on a specific element in the webview

### IPC & Plugin Tools (6)

Tools that directly use the MCP Bridge plugin's Rust backend:

1. **tauri_plugin_execute_ipc** - Execute any Tauri IPC command with the MCP bridge plugin
2. **tauri_plugin_get_window_info** - Get detailed information about the current window
3. **tauri_plugin_ipc_monitor** - Manage IPC monitoring (start or stop)
4. **tauri_plugin_ipc_get_events** - Retrieve all captured IPC events with optional filtering
5. **tauri_plugin_emit_event** - Emit custom Tauri events for testing event handlers
6. **tauri_plugin_get_backend_state** - Get backend application state and metadata

## Architecture

```text
MCP Server (Node.js)
    │
    ├── Native IPC (via plugin) ────> Tauri App Webview (DOM/UI)
    │                                       │
    └── Plugin Client ──────────────────────┼──> Plugin Commands
         (WebSocket port 9223)              │
                                            │
                                      mcp-bridge Plugin
                                      (Rust Backend)
```

## WebSocket Communication

The plugin runs a WebSocket server on port 9223 (or next available in range 9223-9322) for real-time communication with the MCP server.

### Remote Device Development

By default, the WebSocket server binds to `0.0.0.0` (all network interfaces), enabling connections from:

- **iOS devices** on the same network
- **Android devices** on the same network or via `adb reverse`
- **Emulators/Simulators** via localhost

#### Connecting from MCP Server

The MCP server supports connecting to remote Tauri apps via the `tauri_driver_session` tool:

```typescript
// Connect to a Tauri app on a remote device
tauri_driver_session({ action: 'start', host: '192.168.1.100' })

// Or use environment variables:
// MCP_BRIDGE_HOST=192.168.1.100 npx mcp-server-tauri
// TAURI_DEV_HOST=192.168.1.100 npx mcp-server-tauri (same as Tauri CLI uses)
```

#### Connection Strategy

The MCP server uses a fallback strategy:
1. Try `localhost:{port}` first (most reliable for simulators/emulators/desktop)
2. If localhost fails and a remote host is configured, try `{host}:{port}`
3. Auto-discover apps on localhost if specific connection fails

## Development

### Building the Plugin

From the plugin directory:

```bash
cd packages/tauri-plugin-mcp-bridge
cargo build
```

Or from the workspace root:

```bash
npm run build:plugin
```

### Documentation

View the comprehensive Rust API documentation:

```bash
npm run docs:rust
```

Or directly:

```bash
cd packages/tauri-plugin-mcp-bridge
cargo doc --open --no-deps
```

### Testing

Run the MCP server tests which include plugin integration tests:

```bash
npm test
```

## Permissions

Add the plugin's default permission to your Tauri capabilities file (`src-tauri/capabilities/default.json`):

```json
{
  "permissions": [
    "mcp-bridge:default"
  ]
}
```

This grants all permissions required by the MCP server. The plugin is designed to work as a complete unit—partial permissions are not recommended as the MCP server expects all commands to be available.

## API Documentation

For detailed API documentation, including:

- Complete function signatures and parameters
- Rust examples for backend integration
- TypeScript examples for frontend usage
- Architecture and design details

Visit the [docs.rs documentation](https://docs.rs/tauri-plugin-mcp-bridge) or build locally with `npm run docs:rust`.

## License

MIT © [hypothesi](https://github.com/hypothesi)
