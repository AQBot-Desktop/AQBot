[简体中文](./README.md) | [繁體中文](./README-ZH-TW.md) | **English** | [日本語](./README-JA.md) | [한국어](./README-KO.md) | [Français](./README-FR.md) | [Deutsch](./README-DE.md) | [Español](./README-ES.md) | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

AQBot is a local-first desktop AI workspace that brings multi-provider chat, ACP agents, knowledge bases, MCP tools and an API gateway together while keeping app data and user files under your control.

## Screenshots

| Chat Chart Rendering | Providers & Models |
|:---:|:---:|
| ![](.github/images/s1-0412.png) | ![](.github/images/s2-0412.png) |

| Knowledge Base | Memory |
|:---:|:---:|
| ![](.github/images/s3-0412.png) | ![](.github/images/s4-0412.png) |

| Agent - Ask User | API Gateway One-Click Access |
|:---:|:---:|
| ![](.github/images/s5-0412.png) | ![](.github/images/s6-0412.png) |

| Chat Model Selection | Chat Navigation |
|:---:|:---:|
| ![](.github/images/s7-0412.png) | ![](.github/images/s8-0412.png) |

| Agent - Permission Approval | API Gateway Overview |
|:---:|:---:|
| ![](.github/images/s9-0412.png) | ![](.github/images/s10-0412.png) |

## Features

### Chat & Models

- **Multi-provider chat** — Connect OpenAI, Claude, Gemini, DeepSeek, Qwen and any OpenAI-compatible endpoint with custom Base URL, API Path, headers and proxy rules.
- **Provider onboarding** — Use aqbot:// provider links and CC Switch import to bring provider profiles into AQBot after user confirmation.
- **Model management** — Sync remote model lists, organize groups, test latency and configure capabilities, context length, sampling defaults, reasoning profiles and per-model extra_body fields.
- **Conversation workflows** — Stream replies with thinking blocks, compare message versions, branch conversations, show title-generation status, compress long chats and ask multiple models in parallel.

### AI Agent

- **Two ways to use agents** — AQBot provides both a built-in agent inside Chat and a separate ACP agent workbench. The first uses your configured provider APIs; the second connects to external ACP-compatible agent processes, so you can choose the right path for each model and workflow.
- **Chat agent (provider API)** — Switch a regular conversation to Agent mode and use any configured provider and model API to read or edit files, run commands and analyze code in a chosen working directory. That directory is the process starting CWD, not a filesystem sandbox.
- **Chat agent controls** — Choose permission modes such as ask every time, accept edits or full access, review tool calls and approvals in real time, and track token and cost usage for each run.
- **ACP agent workbench** — Run compatible coding agents through [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) in a dedicated workbench, with streaming responses, reasoning and tool calls.
- **ACP Registry and custom integrations** — Add agents such as Codex, Claude Agent, Gemini CLI, Cline, OpenCode and Grok Build from the Registry, or configure a custom command, arguments, environment variables and icon; agents can be enabled and reordered freely.
- **ACP projects and direct chats** — Organize threads by project, pin important sessions and restore your last workspace automatically, or start a direct chat without selecting a project in an isolated working directory.
- **Complete ACP session interaction** — Switch models, modes and options exposed by each agent, and work with attachments, questionnaires, plan reviews, plan progress and persisted state across reloads; tool requests can be allowed once or set to “Always Allow” for the current session.

### Roles

- **Local role templates** — Save system prompts, avatars, tags, opening messages, starter questions, temperature and Top P as reusable conversation templates.
- **One-click use** — Start a new role conversation by default, or apply a role to the current conversation from the dropdown; role chats keep the role name, avatar and blue Roles badge.
- **Marketplace** — Search and install roles from prompts.chat and PlexPt 中文 sources, then use them locally.

### Skills Management

- **Multi-source skill directories** — Manage AQBot, Codex, Claude and Agents skill roots, including `~/.aqbot/skills`, `~/.codex/skills`, `~/.claude/skills` and `~/.agents/skills`.
- **My Skills** — Filter by source, enable or disable skills, view details, copy names, open directories and uninstall.
- **Skill groups and install targets** — Collapse skills by group, bulk enable/disable, open group folders, uninstall whole groups, and install from `owner/repo` or GitHub URLs into a chosen target.
- **Marketplace** — Search skills.sh and GitHub sources, preview details, jump to GitHub and see installed status.

### Content Rendering

- **Markdown and math** — Render Markdown, code highlighting, tables, task lists and LaTeX formulas in streaming conversations.
- **Code, diagrams and artifacts** — Use Monaco code blocks, Mermaid, D2 diagrams and an Artifact panel for code, Markdown notes, reports and previews.
- **HTML fragment rendering** — Preview generated HTML fragments safely, including the streaming fixes added in the recent releases.

### Search & Knowledge

- **Web search** — Use Tavily, Exa, Zhipu WebSearch, Bocha and other search providers with cited sources and generated search queries.
- **Local knowledge bases** — Index private documents with sqlite-vec, tune retrieval/rerank options and inspect retrieval feedback.
- **Context management** — Attach files, search results, knowledge snippets, memories and tool output to the conversation context.

### Tools & Extensions

- **MCP protocol** — Run Model Context Protocol servers over stdio, SSE or StreamableHTTP.
- **Built-in tools** — Use built-in MCP tools such as @aqbot/fetch and file search without installing a separate server.
- **Tool loop limit** — Configure the maximum MCP tool-call loop count and recover more cleanly from interrupted or stuck tool sessions.

### API Gateway

- **Local gateway** — Expose OpenAI Chat Completions, OpenAI Responses, Claude-native and Gemini-native endpoints from the desktop app.
- **Access and observability** — Manage gateway keys, SSL/TLS certificates, request logs and usage analytics locally.
- **Client templates** — Use ready-made templates for Claude Code, Codex CLI, OpenCode, Gemini CLI and custom clients.

### Data Import & Backup

- **Third-party imports** — Import ChatGPT official exports, Cherry Studio backups and Kelivo backups with preview counts, warnings and duplicate handling.
- **Provider and file migration** — Cherry Studio and Kelivo import can optionally migrate linked providers, API keys and file attachments.
- **Backups** — Back up and restore local data through local folders, WebDAV or S3-compatible storage.

### Desktop & Security

- **Local encryption** — Store app state under ~/.aqbot/ and user files under ~/Documents/aqbot/, with API keys protected by AES-256 and a local master key.
- **Desktop integration** — Use tray mode, always-on-top, global shortcuts, auto-start, proxy settings and automatic update checks.
- **11 interface languages** — Switch between Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Spanish, Russian, Hindi and Arabic.

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
