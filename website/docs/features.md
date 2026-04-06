# Features

AQBot is a full-featured desktop AI assistant that brings together multi-provider chat, powerful content rendering, tool integration, and a built-in API gateway — all running locally with strong data security.

## Chat & Models

Connect to the leading AI providers from a single, unified interface. AQBot handles API differences behind the scenes so you can focus on the conversation.

- **Multi-Provider Support** — Compatible with OpenAI, Anthropic Claude, Google Gemini, and all OpenAI-compatible APIs. Each provider is configured independently with its own API key, Base URL, and model list.
- **Model Management** — Fetch remote model lists automatically and customize generation parameters such as temperature, max tokens, top-p, and more on a per-conversation basis.
- **Multi-Key Rotation** — Configure multiple API keys per provider with automatic rotation to distribute rate-limit pressure and maximize uptime.
- **Streaming Output** — Real-time token-by-token rendering keeps you informed as the model generates. Collapsible thinking blocks let you inspect the model's chain-of-thought without cluttering the conversation.
- **Message Versions** — Every response can have multiple versions. Switch between them to compare the effects of different models or parameter settings side by side.
- **Conversation Branching** — Fork a new branch from any message node to explore alternative directions. A side-by-side branch comparison view makes it easy to evaluate different paths.
- **Conversation Management** — Pin important conversations, archive old ones, browse a time-grouped history, and perform bulk operations to keep your workspace tidy.
- **Conversation Compression** — Automatically compress lengthy conversations, preserving key information to save context space.
- **Multi-Model Simultaneous Response** — Ask the same question to multiple models at once, with side-by-side comparison of answers.

## Content Rendering

AQBot goes far beyond plain-text chat with a rich, interactive rendering pipeline.

- **Markdown Rendering** — Full support for syntax-highlighted code blocks, LaTeX math formulas, tables, and task lists.
- **Monaco Code Editor** — Code blocks embed the Monaco Editor (the engine behind VS Code) with syntax highlighting, one-click copy, and inline diff preview.
- **Diagram Rendering** — Built-in rendering for Mermaid flowcharts and D2 architecture diagrams, displayed directly in the conversation.
- **Artifact Panel** — Code snippets, HTML drafts, Markdown notes, and reports can be opened in a dedicated side panel for focused viewing and editing.
- **Real-Time Voice Chat** — (Coming Soon) WebRTC-based voice conversations powered by the OpenAI Realtime API for low-latency, natural interaction.

## Search & Knowledge

Augment your conversations with live web data, local documents, and persistent memory.

- **Web Search** — Integrated with Tavily, Zhipu WebSearch, Bocha, and more. Search results include citation source annotations so you can verify claims at a glance.
- **Local Knowledge Base (RAG)** — Supports multiple knowledge bases. Upload documents for automatic parsing, chunking, and vector indexing (sqlite-vec). During conversations, relevant passages are retrieved semantically and injected into context automatically.
- **Memory System** — Supports multi-namespace conversational memory. Entries can be added manually or extracted automatically by the AI (auto-extraction coming soon). Memories persist across conversations to give the model long-term awareness.
- **Context Management** — Flexibly attach file attachments, search results, knowledge-base passages, memory entries, and tool outputs to any message for precise context control.

::: tip Coming Soon
AI-powered automatic memory extraction is under active development and will be available in an upcoming release.
:::

## Tools & Extensions

Extend the model's capabilities with external tools and a powerful command interface.

- **MCP Protocol** — Full [Model Context Protocol](https://modelcontextprotocol.io/) implementation supporting both **stdio** and **HTTP** transports. Connect to local tool servers or remote endpoints seamlessly.
- **Built-in Tools** — Ready-to-use built-in MCP tools such as `@aqbot/fetch` — no extra setup required.
- **Tool Execution Panel** — A visual panel displays each tool-call request and its return result, making it easy to audit and debug tool interactions.

## API Gateway

AQBot includes a built-in local API server that turns your desktop app into a powerful AI gateway for any compatible client.

- **Local API Gateway** — Expose a local server with native support for OpenAI-compatible, Claude, and Gemini interfaces. Use it as a backend for CLI tools, scripts, or other applications.
- **API Key Management** — Generate, revoke, and enable or disable access keys. Each key supports a description note for easy identification.
- **Usage Analytics** — Analyze request volume and token usage broken down by key, provider, and date to understand consumption patterns.
- **SSL/TLS Support** — Built-in self-signed certificate generation with support for importing custom certificates.
- **Request Logs** — Complete recording of every API request and response passing through the gateway for auditing and debugging.
- **Configuration Templates** — Pre-built integration templates for popular tools such as Claude Code, Codex CLI, OpenCode, and Gemini CLI so you can get started in seconds.

::: tip Why a Local Gateway?
The gateway lets you use AQBot as a unified AI backend for all your tools. Configure your CLI clients, IDE extensions, or custom scripts to point at the local gateway and benefit from key rotation, usage tracking, and access control — all without exposing your API keys to each tool individually.
:::

## Data & Security

Your data never leaves your machine. AQBot is designed with local-first security at every layer.

- **AES-256 Encryption** — API keys and other sensitive data are encrypted locally with AES-256. The master encryption key is stored with `0600` file permissions (owner-only access on Unix systems).
- **Isolated Data Directories** — Application state (database, encryption keys, vector indices) lives in `~/.aqbot/`. User-visible files (images, documents, backups) are stored in `~/Documents/aqbot/` for easy access and backup with standard OS tools.
- **Auto Backup** — Schedule automatic backups to local directories or WebDAV storage.
- **Backup Restore** — One-click restore from any historical backup to recover your full workspace.
- **Conversation Export** — Export conversations as PNG screenshots, Markdown documents, plain text, or structured JSON.

::: warning Protect Your Master Key
The file `~/.aqbot/master.key` is the root of all encryption in AQBot. Keep it safe and included in your backups. If this key is lost, encrypted data cannot be recovered.
:::

## Desktop Experience

AQBot is built as a native desktop application with the polish and integration you expect from a daily-use tool.

- **Theme Switching** — Dark and light themes that follow the system preference or can be set manually.
- **Interface Language** — Full support for Simplified Chinese and English, switchable at any time in settings.
- **System Tray** — Minimize to the system tray on window close. Background services such as the API gateway continue running uninterrupted.
- **Always on Top** — Pin the main window to stay above all other windows for quick-reference workflows.
- **Global Shortcuts** — Customizable global keyboard shortcuts to summon the main window from anywhere, at any time.
- **Auto Start** — Optionally launch AQBot on system startup so it is always ready when you are.
- **Proxy Support** — Configure HTTP and SOCKS5 proxies for environments with restricted network access.
- **Auto Update** — AQBot automatically checks for new versions on startup and prompts you to update with a single click.
