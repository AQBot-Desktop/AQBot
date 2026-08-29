**简体中文** | [繁體中文](./README-ZH-TW.md) | [English](./README-EN.md) | [日本語](./README-JA.md) | [한국어](./README-KO.md) | [Français](./README-FR.md) | [Deutsch](./README-DE.md) | [Español](./README-ES.md) | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

AQBot 是一款本地优先的桌面 AI 工作台，统一多服务商对话、ACP Agent、知识库、MCP 工具与 API 网关，并将应用数据和用户文件保留在本机掌控之中。

## 运行截图

| 对话图表渲染 | 服务商与模型 |
|:---:|:---:|
| ![](.github/images/s1-0412.png) | ![](.github/images/s2-0412.png) |

| 知识库 | 记忆 |
|:---:|:---:|
| ![](.github/images/s3-0412.png) | ![](.github/images/s4-0412.png) |

| Agent-询问 | API网关一键接入 |
|:---:|:---:|
| ![](.github/images/s5-0412.png) | ![](.github/images/s6-0412.png) |

| 对话模型选择 | 对话导航 |
|:---:|:---:|
| ![](.github/images/s7-0412.png) | ![](.github/images/s8-0412.png) |

| Agent-权限审批 | API网关概览 |
|:---:|:---:|
| ![](.github/images/s9-0412.png) | ![](.github/images/s10-0412.png) |

## 功能特性

### 对话与模型

- **多服务商对话** — 连接 OpenAI、Claude、Gemini、DeepSeek、Qwen 以及任意 OpenAI 兼容端点，支持自定义 Base URL、API Path、请求头和代理规则。
- **服务商快速导入** — 通过 aqbot:// 服务商链接和 CC Switch 配置导入，在用户确认后把服务商资料带入 AQBot。
- **模型管理** — 同步远程模型列表、管理分组、测试延迟，并配置能力标签、上下文长度、采样默认值、推理档位和模型级 extra_body。
- **对话工作流** — 流式回复、思考块、消息多版本、对话分支、标题生成状态、长对话压缩和多模型并行回答。

### AI Agent

- **两种 Agent 使用方式** — AQBot 同时提供对话模块内置 Agent 与独立 ACP Agent 工作台；前者使用用户配置的服务商 API，后者连接 ACP 兼容的外部 Agent 进程，可按模型来源和工作流自由选择。
- **对话 Agent（服务商 API）** — 在普通对话中切换至 Agent 模式，直接使用已配置服务商与模型的 API，让模型在所选工作目录中读取/编辑文件、执行命令并分析代码。该目录只是进程的起始 CWD，不是文件系统沙箱。
- **对话 Agent 管控** — 支持每次询问、自动接受编辑和完全访问等权限模式，实时展示工具调用与审批，并记录单次任务的 token 和成本。
- **ACP Agent 工作台** — 通过 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 在独立工作台中运行兼容的编程 Agent，流式查看回复、思考过程和工具调用。
- **ACP Registry 与自定义接入** — 可从 Registry 添加 Codex、Claude Agent、Gemini CLI、Cline、OpenCode、Grok Build 等 Agent，也可配置自定义命令、参数、环境变量和图标，并自由启停与排序。
- **ACP 项目与自由对话** — 按项目组织线程、固定常用会话并自动恢复上次现场；也可不选择项目，直接在隔离工作目录中开始对话。
- **ACP 完整会话交互** — 支持 Agent 暴露的模型、模式和配置切换，以及附件、问卷、计划审核、计划进度与刷新后恢复；工具请求可单次允许或在当前会话中“始终允许”。

### 角色

- **本地角色管理** — 将系统提示词、头像、标签、开场白、开场问题、温度和 Top P 保存为可复用会话模板。
- **一键使用角色** — 默认新建角色对话，也可从下拉菜单应用到当前对话；角色对话保留角色名称、头像和蓝色“角色”标记。
- **在线市场** — 从 prompts.chat 和 PlexPt 中文来源搜索并安装角色，安装后可离线作为本地角色使用。

### Skills 管理

- **多来源技能目录** — 管理 AQBot、Codex、Claude 和 Agents 技能目录，包括 `~/.aqbot/skills`、`~/.codex/skills`、`~/.claude/skills` 和 `~/.agents/skills`。
- **我的技能** — 支持来源筛选、启用/禁用、详情查看、复制名称、打开目录和卸载。
- **技能组与安装目标** — 按 group 折叠技能组，批量启停、打开组目录、卸载整组，并可从 `owner/repo` 或 GitHub URL 安装到指定目标。
- **在线市场** — 支持 skills.sh 与 GitHub 来源搜索、详情预览、GitHub 跳转和安装状态展示。

### 内容渲染

- **Markdown 与数学公式** — 在流式对话中渲染 Markdown、代码高亮、表格、任务列表和 LaTeX 公式。
- **代码、图表与 Artifact** — 内置 Monaco 代码块、Mermaid、D2 图表和 Artifact 面板，用于代码、Markdown 笔记、报告和预览。
- **HTML 片段渲染** — 安全预览模型生成的 HTML 片段，并包含近期版本加入的流式渲染稳定性修复。

### 搜索与知识

- **联网搜索** — 接入 Tavily、Exa、智谱 WebSearch、Bocha 等搜索服务，支持引用来源和搜索查询生成。
- **本地知识库** — 用 sqlite-vec 索引私有文档，配置检索/重排选项并查看检索反馈。
- **上下文管理** — 把文件、搜索结果、知识片段、记忆和工具输出附加到对话上下文。

### 工具与扩展

- **MCP 协议** — 运行 stdio、SSE 或 StreamableHTTP 传输的 Model Context Protocol 服务器。
- **内置工具** — 直接使用 @aqbot/fetch、文件搜索等内置 MCP 工具，无需额外安装独立服务器。
- **工具循环上限** — 可配置 MCP 工具调用最大循环次数，并更好地恢复中断或卡住的工具会话。

### API 网关

- **本地网关** — 从桌面应用暴露 OpenAI Chat Completions、OpenAI Responses、Claude 原生和 Gemini 原生接口。
- **访问与观测** — 本地管理网关密钥、SSL/TLS 证书、请求日志和用量统计。
- **客户端模板** — 提供 Claude Code、Codex CLI、OpenCode、Gemini CLI 和自定义客户端的配置模板。

### 数据导入与备份

- **第三方导入** — 导入 ChatGPT 官方导出、Cherry Studio 备份和 Kelivo 备份，带预览统计、警告和重复处理。
- **服务商与文件迁移** — Cherry Studio/Kelivo 导入可选择迁移关联服务商、API Key 和文件附件。
- **备份** — 通过本地目录、WebDAV 或 S3 兼容存储进行备份与恢复。

### 桌面体验与安全

- **本地加密** — 应用状态位于 ~/.aqbot/，用户文件位于 ~/Documents/aqbot/，API Key 使用 AES-256 和本地主密钥保护。
- **桌面集成** — 支持托盘、窗口置顶、全局快捷键、开机自启、代理设置和自动更新检查。
- **11 种界面语言** — 可在简体中文、繁体中文、英语、日语、韩语、法语、德语、西班牙语、俄语、印地语和阿拉伯语之间切换。

## 平台支持

| 平台 | 架构 |
|------|------|
| macOS | Apple Silicon (arm64), Intel (x86_64) |
| Windows 10/11 | x86_64, arm64 |
| Linux | x86_64 (AppImage/deb/rpm), arm64 (AppImage/deb/rpm) |

## 快速开始

前往 [Releases](https://github.com/AQBot-Desktop/AQBot/releases) 页面下载适合你平台的安装包。

## 常见问题

### macOS 提示"已损坏"或"无法验证开发者"

AQBot 使用项目自签名的代码签名证书，不是 Apple Developer ID 证书，因此从浏览器下载后 macOS 仍可能弹出以下提示之一：

- "AQBot" 已损坏，无法打开
- 无法打开 "AQBot"，因为无法验证开发者

这不需要关闭整个系统的 Gatekeeper。请只放行当前 AQBot 应用：

1. 在 Finder 中按住 Control 点击 `AQBot.app`，选择「打开」，然后再次点击「打开」。
2. 如果仍被拦截，前往「系统设置 → 隐私与安全性」，在安全性区域找到 AQBot 并点击「仍要打开」。
3. 再次启动 AQBot。

Gatekeeper 放行与辅助功能授权是两项独立设置。使用划词工具栏时，还需根据 AQBot 内的提示，在「系统设置 → 隐私与安全性 → 辅助功能」中启用 AQBot。

## 社区支持
- [LinuxDO](https://linux.do)

## 许可证

本项目采用 [AGPL-3.0](LICENSE) 许可证。
