![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)

[简体中文](./README.md) | English

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

### Content Rendering

- **Markdown Rendering** — Full support for code highlighting, LaTeX math formulas, tables, and task lists
- **Monaco Code Editor** — Embedded Monaco Editor in code blocks with syntax highlighting, copy, and diff preview
- **Diagram Rendering** — Built-in Mermaid flowchart and D2 architecture diagram rendering
- **Artifact Panel** — Code snippets, HTML drafts, Markdown notes, and reports viewable in a dedicated panel
- **Real-Time Voice Chat** — WebRTC-based real-time voice with OpenAI Realtime API support

### Search & Knowledge

- **Web Search** — Integrated with Tavily, Zhipu WebSearch, Bocha, and more, with citation source annotations
- **Local Knowledge Base (RAG)** (Coming Soon) — Upload documents to build vector indices (LanceDB), with semantic retrieval during conversations
- **Memory System** (Coming Soon) — Global and project-level memory, added manually or extracted automatically by AI
- **Context Management** — Flexibly attach file attachments, search results, knowledge base passages, memory entries, and tool outputs

### Tools & Extensions

- **MCP Protocol** — Full Model Context Protocol implementation supporting both stdio and HTTP transports
- **Built-in Tools** — Ready-to-use built-in tools including file read/write, shell execution, and screenshot capture
- **Tool Execution Panel** — Visual display of tool call requests and return results
- **Command Palette** — `Cmd/Ctrl+K` global command palette for quick navigation and actions

### API Gateway

- **Local API Gateway** — Built-in local API server with native support for OpenAI-compatible, Claude, and Gemini interfaces, usable as a backend for any compatible client
- **API Key Management** — Generate, revoke, and enable/disable access keys with description notes
- **Usage Analytics** — Request volume and token usage analysis by key, provider, and date
- **Program Policies** — Configure model whitelists and rate limits independently per connected application
- **SSL/TLS Support** — Built-in self-signed certificate generation, with support for custom certificates
- **Request Logs** — Complete recording of all API requests and responses passing through the gateway
- **Configuration Templates** — Pre-built integration templates for popular tools such as Claude, Codex, OpenCode, and Gemini CLI

### Data & Security

- **AES-256 Encryption** — API keys and sensitive data encrypted locally with AES-256; master key stored with 0600 permissions
- **Isolated Data Directories** — Application state in `~/.aqbot/`; user files in `~/Documents/aqbot/`
- **Auto Backup** — Scheduled automatic backups to local directories, WebDAV, or S3-compatible storage
- **Backup Restore** — One-click restore from historical backups
- **Conversation Export** — Export conversations as PNG screenshots, Markdown, plain text, or JSON

### Desktop Experience

- **Theme Switching** — Dark/light themes that follow the system preference or can be set manually
- **Interface Language** — Full support for Simplified Chinese and English, switchable at any time in settings
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

## Contributing

Pull Requests and Issues are welcome.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Community
- [LinuxDO](https://linux.do)

## License

This project is licensed under the [AGPL-3.0](LICENSE) License.
