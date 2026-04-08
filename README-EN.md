[简体中文](./README.md) | [繁體中文](./README-ZH-TW.md) | **English** | [日本語](./README-JA.md) | [한국어](./README-KO.md) | [Français](./README-FR.md) | [Deutsch](./README-DE.md) | [Español](./README-ES.md) | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

<p align="center">
    <a href="https://www.producthunt.com/products/aqbot?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-aqbot" target="_blank" rel="noopener noreferrer"><img alt="AQBot - Lightweight, high-perf cross-platform AI desktop client | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1118403&amp;theme=light&amp;t=1775627359538"></a>
</p>

## Screenshots

![](.github/images/1.png)
![](.github/images/2.png)
![](.github/images/3.png)
![](.github/images/4.png)
![](.github/images/5.png)

## Features

### Chat & Models

- **Multi-Provider Support** — Compatible with OpenAI, Anthropic Claude, Google Gemini, and all OpenAI-compatible APIs
- **Model Management** — Fetch remote model lists, customize parameters (temperature, max tokens, top-p, etc.)
- **Multi-Key Rotation** — Configure multiple API keys per provider with automatic rotation to distribute rate limit pressure
- **Streaming Output** — Real-time token-by-token rendering with collapsible thinking blocks
- **Message Versions** — Switch between multiple response versions per message to compare model or parameter effects
- **Conversation Branching** — Fork new branches from any message node, with side-by-side branch comparison
- **Conversation Management** — Pin, archive, time-grouped display, and bulk operations
- **Conversation Compression** — Automatically compress lengthy conversations, preserving key information to save context space
- **Multi-Model Simultaneous Response** — Ask the same question to multiple models at once, with side-by-side comparison of answers

### AI Agent

- **Agent Mode** — Switch to Agent mode for autonomous multi-step task execution: read/write files, run commands, analyze code, and more
- **Three Permission Levels** — Default (writes need approval), Accept Edits (auto-approve file changes), Full Access (no prompts) — safe and controllable
- **Working Directory Sandbox** — Agent operations are strictly confined to the specified working directory, preventing unauthorized access
- **Tool Approval Panel** — Real-time display of tool call requests with per-tool review, one-click "always allow", or deny
- **Cost Tracking** — Real-time token usage and cost statistics per session

### Content Rendering

- **Markdown Rendering** — Full support for code highlighting, LaTeX math formulas, tables, and task lists
- **Monaco Code Editor** — Embedded Monaco Editor in code blocks with syntax highlighting, copy, and diff preview
- **Diagram Rendering** — Built-in Mermaid flowchart and D2 architecture diagram rendering
- **Artifact Panel** — Code snippets, HTML drafts, Markdown notes, and reports viewable in a dedicated panel
- **Real-Time Voice Chat** — (Coming Soon) WebRTC-based real-time voice with OpenAI Realtime API support

### Search & Knowledge

- **Web Search** — Integrated with Tavily, Zhipu WebSearch, Bocha, and more, with citation source annotations
- **Local Knowledge Base (RAG)** — Supports multiple knowledge bases; upload documents for automatic parsing, chunking, and indexing, with semantic retrieval of relevant passages during conversations
- **Memory System** — Supports multi-namespace conversational memory, with manual entry or AI-powered auto-extraction (auto-extraction coming soon)
- **Context Management** — Flexibly attach file attachments, search results, knowledge base passages, memory entries, and tool outputs

### Tools & Extensions

- **MCP Protocol** — Full Model Context Protocol implementation supporting both stdio and HTTP transports
- **Built-in Tools** — Ready-to-use built-in MCP tools such as `@aqbot/fetch`
- **Tool Execution Panel** — Visual display of tool call requests and return results

### API Gateway

- **Local API Gateway** — Built-in local API server with native support for OpenAI-compatible, Claude, and Gemini interfaces, usable as a backend for any compatible client
- **API Key Management** — Generate, revoke, and enable/disable access keys with description notes
- **Usage Analytics** — Request volume and token usage analysis by key, provider, and date
- **SSL/TLS Support** — Built-in self-signed certificate generation, with support for custom certificates
- **Request Logs** — Complete recording of all API requests and responses passing through the gateway
- **Configuration Templates** — Pre-built integration templates for popular CLI tools such as Claude, Codex, OpenCode, and Gemini

### Data & Security

- **AES-256 Encryption** — API keys and sensitive data encrypted locally with AES-256; master key stored with 0600 permissions
- **Isolated Data Directories** — Application state in `~/.aqbot/`; user files in `~/Documents/aqbot/`
- **Auto Backup** — Scheduled automatic backups to local directories or WebDAV storage
- **Backup Restore** — One-click restore from historical backups
- **Conversation Export** — Export conversations as PNG screenshots, Markdown, plain text, or JSON

### Desktop Experience

- **Theme Switching** — Dark/light themes that follow the system preference or can be set manually
- **Interface Language** — Full support for Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Russian, Hindi, and Arabic, switchable at any time in settings
- **System Tray** — Minimize to system tray on window close without interrupting background services
- **Always on Top** — Pin the main window to stay above all other windows
- **Global Shortcuts** — Customizable global keyboard shortcuts to summon the main window at any time
- **Auto Start** — Optional launch on system startup
- **Proxy Support** — HTTP and SOCKS5 proxy configuration
- **Auto Update** — Automatically checks for new versions on startup and prompts for update

## Platform Support

| Platform | Architecture |
|----------|-------------|
| macOS | Apple Silicon (arm64), Intel (x86_64) |
| Windows 10/11 | x86_64, arm64 |
| Linux | x86_64 (AppImage/deb/rpm), arm64 (AppImage/deb/rpm) |

## Getting Started

Head to the [Releases](https://github.com/AQBot-Desktop/AQBot/releases) page and download the installer for your platform.

## FAQ

### macOS: "App Is Damaged" or "Cannot Verify Developer"

Since the application is not signed by Apple, macOS may show one of the following prompts:

- "AQBot" is damaged and can't be opened
- "AQBot" can't be opened because Apple cannot check it for malicious software

**Steps to resolve:**

**1. Allow apps from "Anywhere"**

```bash
sudo spctl --master-disable
```

Then go to **System Settings → Privacy & Security → Security** and select **Anywhere**.

**2. Remove the quarantine attribute**

```bash
sudo xattr -dr com.apple.quarantine /Applications/AQBot.app
```

> Tip: You can drag the app icon onto the terminal after typing `sudo xattr -dr com.apple.quarantine `.

**3. Additional step for macOS Ventura and later**

After completing the above steps, the first launch may still be blocked. Go to **System Settings → Privacy & Security**, then click **Open Anyway** in the Security section. This only needs to be done once.

## Community
- [LinuxDO](https://linux.do)

## License

This project is licensed under the [AGPL-3.0](LICENSE) License.
