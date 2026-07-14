# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2025-12-01

### Fixed
- Fix screenshot crash on iOS by properly handling NSRunLoop and avoiding unsafe pointer casts

## [0.2.1] - 2025-11-30

### Fixed
- Make Tauri APIs a peerDependency instead of a direct dependency

## [0.2.0] - 2025-11-29

### Added
- Multi-window support: `list_windows` command and `windowId` parameter for targeting specific webviews

## [0.1.3] - 2025-11-26

_No changes to this package._

## [0.1.2] - 2025-11-26

### Fixed
- Add missing system dependencies to Rust release pipeline

## [0.1.1] - 2025-11-26

### Fixed
- Improve `execute_js` error handling with better JSON parse error logging
- Add `__TAURI__` availability check before emitting script results
- Catch unhandled promise rejections in executed scripts
- Double-wrap script execution to catch both parse and runtime errors

### Added
- Initial release of tauri-plugin-mcp-bridge
- IPC monitoring capabilities
- Window information retrieval
- Backend state inspection
- Custom event emission
- WebSocket server for real-time event streaming
