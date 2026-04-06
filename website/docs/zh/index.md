---
layout: home
title: AQBot — 开源 AI 桌面客户端 & AI 网关
titleTemplate: false

head:
  - - meta
    - name: description
      content: AQBot 是一款免费开源的 AI 桌面客户端，内置 AI 网关。支持 OpenAI、Claude、Gemini、DeepSeek 等多模型对话，MCP 服务器、知识库、隐私优先。
  - - meta
    - name: keywords
      content: AQBot, AI桌面客户端, AI网关, AI聊天客户端, LLM客户端, 多模型AI, MCP服务器, ChatGPT替代, 开源AI, 大语言模型, AI桌面应用, DeepSeek客户端

hero:
  name: AQBot
  text: 你的 AI 桌面助手
  tagline: 多模型对话、MCP 工具、API 网关、知识库，一个开源客户端全部搞定
  image:
    src: /logo.png
    alt: AQBot
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 下载安装
      link: /zh/download
    - theme: alt
      text: GitHub
      link: https://github.com/AQBot-Desktop/AQBot

features:
  - icon: 🤖
    title: 多模型对话
    details: 接入 OpenAI、Claude、Gemini、DeepSeek、Qwen 等所有兼容 API。多密钥轮询、流式输出、Thinking 折叠展开。
  - icon: 🔌
    title: MCP 工具调用
    details: 完整实现 Model Context Protocol，支持 stdio、SSE、StreamableHTTP。一键连接外部工具，内置 @aqbot/fetch 等 MCP 工具。
  - icon: 🌐
    title: 内置 API 网关
    details: 本地 OpenAI 兼容 API 服务器，可作为 Claude Code、Codex、Gemini CLI 等工具的后端。密钥管理、速率限制、SSL/TLS。
  - icon: 📚
    title: 知识库 & RAG
    details: 本地向量嵌入（sqlite-vec），AI 基于你的私有文档回答，数据不出本地。
  - icon: 🔍
    title: 联网搜索
    details: 集成 Tavily、智谱 WebSearch、Bocha，搜索结果附带引用来源，自动注入对话上下文。
  - icon: ✏️
    title: 丰富内容渲染
    details: Markdown、LaTeX 公式、Mermaid 流程图、D2 架构图、Monaco 代码编辑器 diff 预览、Artifact 独立面板。
  - icon: ⌨️
    title: 桌面体验
    details: 全局快捷键、系统托盘、开机自启、窗口置顶、深浅主题、代理支持。
  - icon: 🔒
    title: 隐私安全
    details: 所有数据本地存储，AES-256 加密 API 密钥。支持自动备份到本地、WebDAV。对话导出为 PNG/Markdown/JSON。
---
