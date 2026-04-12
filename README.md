**简体中文** | [繁體中文](./README-ZH-TW.md) | [English](./README-EN.md) | [日本語](./README-JA.md) | [한국어](./README-KO.md) | [Français](./README-FR.md) | [Deutsch](./README-DE.md) | [Español](./README-ES.md) | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

<p align="center">
    <a href="https://www.producthunt.com/products/aqbot?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-aqbot" target="_blank" rel="noopener noreferrer"><img alt="AQBot - Lightweight, high-perf cross-platform AI desktop client | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1118403&amp;theme=light&amp;t=1775627359538"></a>
</p>

## 运行截图

| 对话图表渲染 | 服务商与模型 |
|:---:|:---:|
| ![](.github/images/s1.png) | ![](.github/images/s2.png) |

| 知识库 | 记忆 |
|:---:|:---:|
| ![](.github/images/s3.png) | ![](.github/images/s4.png) |

| Agent-询问 | API网关一键接入 |
|:---:|:---:|
| ![](.github/images/s5.png) | ![](.github/images/s6.png) |

| 对话模型选择 | 对话导航 |
|:---:|:---:|
| ![](.github/images/s7.png) | ![](.github/images/s8.png) |

| Agent-权限审批 | API网关概览 |
|:---:|:---:|
| ![](.github/images/s9.png) | ![](.github/images/s10.png) |

## 功能特性

### 对话与模型

- **多供应商支持** — 兼容 OpenAI、Anthropic Claude、Google Gemini 等所有 OpenAI 兼容 API
- **模型管理** — 支持远程拉取模型列表、自定义参数（温度、最大 Token、Top-P 等）
- **多密钥轮询** — 每个供应商可配置多个 API Key，自动轮换以分散限流压力
- **流式输出** — 实时逐 Token 渲染，thinking 块可折叠展开
- **消息版本** — 每条回复支持多版本切换，方便对比不同模型或参数的效果
- **对话分支** — 从任意消息节点派生新分支，支持分支间对比
- **对话管理** — 支持置顶、归档、按时间分组、批量操作
- **对话压缩** — 自动压缩冗长对话，保留关键信息以节省上下文空间
- **多模型同答案** — 同一问题同时向多个模型提问，支持答案间对比分析

### AI Agent

- **Agent 模式** — 切换至 Agent 模式，AI 可自主执行多步骤任务：读写文件、运行命令、分析代码等
- **三级权限** — 默认模式（写入需审批）、接受编辑（自动批准修改）、完全访问（无提示），安全可控
- **工作目录沙箱** — Agent 操作严格限制在指定工作目录内，防止越权访问
- **工具审批面板** — 实时展示工具调用请求，支持逐条审核、一键始终允许或拒绝
- **成本追踪** — 每次会话实时统计 Token 用量与费用

### 内容渲染

- **Markdown 渲染** — 完整支持代码高亮、LaTeX 数学公式、表格、任务列表
- **Monaco 代码编辑器** — 代码块内嵌 Monaco Editor，支持语法高亮、复制、diff 预览
- **图表渲染** — 内置 Mermaid 流程图与 D2 架构图渲染
- **Artifact 面板** — 代码片段、HTML 草稿、Markdown 笔记、报告可在独立面板中预览
- **实时语音对话** — (即将推出)基于 WebRTC 的实时语音，兼容 OpenAI Realtime API

### 搜索与知识

- **联网搜索** — 集成 Tavily、智谱 WebSearch、Bocha 等，搜索结果附带引用来源标注
- **本地知识库（RAG）** 支持多知识库，上传文档后自动解析分段并且构建索引，对话时语义检索相关段落
- **记忆系统** 支持对话多命名空间记忆，可手动添加或由 AI 自动提取（AI自动提取部分即将支持）
- **上下文管理** — 灵活挂载文件附件、搜索结果、知识库片段、记忆条目、工具输出

### 工具与扩展

- **MCP 协议** — 完整实现 Model Context Protocol，支持 stdio 和 HTTP 两种传输方式
- **内置工具** — 提供`@aqbot/fetch`等开箱即用的内置MCP工具
- **工具执行面板** — 可视化展示工具调用请求与返回结果

### API 网关

- **本地 API 网关** — 内置 OpenAI 兼容、Claude、Gemini等原生接口的本地 API 服务器，可作为任意兼容客户端的后端
- **API 密钥管理** — 生成、撤销、启停访问密钥，支持描述备注
- **用量统计** — 按密钥、供应商、日期维度的请求量与 Token 用量分析
- **SSL/TLS 支持** — 内置自签名证书生成，也支持挂载自定义证书
- **请求日志** — 完整记录所有经过网关的 API 请求与响应
- **配置模板** — 预置 Claude、Codex、OpenCode、Gemini 等常见 CLI 工具的接入配置模板

### 数据与安全

- **AES-256 加密** — API Key 等敏感数据使用 AES-256 加密存储于本地，主密钥权限 0600
- **数据目录隔离** — 应用状态存储于 `~/.aqbot/`，用户文件存储于 `~/Documents/aqbot/`
- **自动备份** — 支持定时自动备份到本地目录、WebDAV的存储
- **备份恢复** — 一键从历史备份恢复完整数据
- **对话导出** — 支持将对话导出为 PNG 截图、Markdown、纯文本或 JSON 格式

### 桌面体验

- **主题切换** — 深色/浅色主题，可跟随系统或手动指定
- **界面语言** — 完整支持简体中文、繁体中文、英文、日文、韩文、法文、德文、西班牙文、俄文、印地文与阿拉伯文，可在设置中随时切换
- **系统托盘** — 关闭窗口时最小化到系统托盘，不中断后台服务
- **窗口置顶** — 可将主窗口常驻最顶层
- **全局快捷键** — 自定义全局快捷键，随时唤起主窗口
- **开机自启** — 可选择随系统自动启动
- **代理支持** — 支持 HTTP 和 SOCKS5 代理配置
- **自动更新** — 启动时自动检测新版本并提示更新

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

由于应用未经 Apple 签名，macOS 可能会弹出以下提示之一：

- "AQBot" 已损坏，无法打开
- 无法打开 "AQBot"，因为无法验证开发者

**解决步骤：**

**1. 允许"任何来源"的应用运行**

```bash
sudo spctl --master-disable
```

执行后前往「系统设置 → 隐私与安全性 → 安全性」，确认已勾选「任何来源」。

**2. 移除应用的安全隔离属性**

```bash
sudo xattr -dr com.apple.quarantine /Applications/AQBot.app
```

> 如果不确定路径，可将应用图标拖拽到 `sudo xattr -dr com.apple.quarantine ` 后面。

**3. macOS Ventura 及以上版本的额外步骤**

完成上述步骤后，首次打开时仍可能被拦截。前往 **「系统设置 → 隐私与安全性」** ，在安全性区域点击 **「仍要打开」** 即可，后续无需重复操作。

## 社区支持
- [LinuxDO](https://linux.do)

## 许可证

本项目采用 [AGPL-3.0](LICENSE) 许可证。
