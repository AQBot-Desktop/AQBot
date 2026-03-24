<div align="center">
  <img src="src/assets/image/logo.png" alt="AQBot" width="120" />
  <h1>AQBot</h1>

  <p><strong>高性能跨平台 AI 聊天桌面客户端</strong></p>
  <p>集多模型对话、本地知识库、MCP 工具扩展、API 网关于一体的桌面 AI 助手</p>

  <a href="./README-EN.md">English</a> | 简体中文

  <br />
  <br />

  ![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri&logoColor=white)
  ![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white)
  ![Rust](https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust&logoColor=white)
  ![License](https://img.shields.io/badge/License-AGPL--3.0-8b5cf6?style=flat-square)

</div>

---

## 功能特性

### 对话与模型

- **多供应商支持** — 兼容 OpenAI、Anthropic Claude、Google Gemini 等所有 OpenAI 兼容 API
- **模型管理** — 支持远程拉取模型列表、自定义参数（温度、最大 Token、Top-P 等）
- **多密钥轮询** — 每个供应商可配置多个 API Key，自动轮换以分散限流压力
- **流式输出** — 实时逐 Token 渲染，thinking 块可折叠展开
- **消息版本** — 每条回复支持多版本切换，方便对比不同模型或参数的效果
- **对话分支** — 从任意消息节点派生新分支，支持分支间对比
- **对话管理** — 支持置顶、归档、按时间分组、批量操作

### 内容渲染

- **Markdown 渲染** — 完整支持代码高亮、LaTeX 数学公式、表格、任务列表
- **Monaco 代码编辑器** — 代码块内嵌 Monaco Editor，支持语法高亮、复制、diff 预览
- **图表渲染** — 内置 Mermaid 流程图与 D2 架构图渲染
- **Artifact 面板** — 代码片段、HTML 草稿、Markdown 笔记、报告可在独立面板中预览
- **实时语音对话** — 基于 WebRTC 的实时语音，兼容 OpenAI Realtime API

### 搜索与知识

- **联网搜索** — 集成 Tavily、智谱 WebSearch、Bocha 等，搜索结果附带引用来源标注
- **本地知识库（RAG）**（即将推出） — 上传文档后自动构建向量索引（LanceDB），对话时语义检索相关段落
- **记忆系统**（即将推出） — 支持全局记忆与项目级记忆，可手动添加或由 AI 自动提取
- **上下文管理** — 灵活挂载文件附件、搜索结果、知识库片段、记忆条目、工具输出

### 工具与扩展

- **MCP 协议** — 完整实现 Model Context Protocol，支持 stdio 和 HTTP 两种传输方式
- **内置工具** — 提供文件读写、Shell 执行、截图等开箱即用的内置工具
- **工具执行面板** — 可视化展示工具调用请求与返回结果
- **命令面板** — `Cmd/Ctrl+K` 全局命令面板，快速跳转和操作

### API 网关

- **本地 API 网关** — 内置 OpenAI 兼容、Claude、Gemini等原生接口的本地 API 服务器，可作为任意兼容客户端的后端
- **API 密钥管理** — 生成、撤销、启停访问密钥，支持描述备注
- **用量统计** — 按密钥、供应商、日期维度的请求量与 Token 用量分析
- **程序策略** — 为每个接入程序独立配置模型白名单与速率限制
- **SSL/TLS 支持** — 内置自签名证书生成，也支持挂载自定义证书
- **请求日志** — 完整记录所有经过网关的 API 请求与响应
- **配置模板** — 预置 Claude、Codex、OpenCode、Gemini 等常见 CLI 工具的接入配置模板

### 数据与安全

- **AES-256 加密** — API Key 等敏感数据使用 AES-256 加密存储于本地，主密钥权限 0600
- **数据目录隔离** — 应用状态存储于 `~/.aqbot/`，用户文件存储于 `~/Documents/aqbot/`
- **自动备份** — 支持定时自动备份到本地目录、WebDAV 或 S3 兼容存储
- **备份恢复** — 一键从历史备份恢复完整数据
- **对话导出** — 支持将对话导出为 PNG 截图、Markdown、纯文本或 JSON 格式

### 桌面体验

- **主题切换** — 深色/浅色主题，可跟随系统或手动指定
- **界面语言** — 完整支持简体中文与英文，可在设置中随时切换
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

## 参与贡献

欢迎提交 Pull Request 和 Issue。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 许可证

本项目采用 [AGPL-3.0](LICENSE) 许可证。
