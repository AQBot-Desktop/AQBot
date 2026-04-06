---
layout: home
title: AQBot — Open-source AI Desktop Client & Gateway
titleTemplate: false

head:
  - - meta
    - name: description
      content: AQBot is a free, open-source AI desktop client with built-in AI gateway. Connect OpenAI, Claude, Gemini, DeepSeek and more LLMs. MCP server support, knowledge base, privacy-first.

hero:
  name: AQBot
  text: Your AI Desktop Assistant
  tagline: Multi-model chat, MCP tools, API gateway, knowledge base — all in one open-source client
  image:
    src: /logo.png
    alt: AQBot
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Download
      link: /download
    - theme: alt
      text: GitHub
      link: https://github.com/AQBot-Desktop/AQBot

features:
  - icon: 🤖
    title: Multi-Model Chat
    details: Connect to OpenAI, Claude, Gemini, DeepSeek, Qwen, and any OpenAI-compatible API. Multi-key rotation, streaming output, and thinking blocks.
  - icon: 🔌
    title: MCP Tool Calling
    details: Full Model Context Protocol support — stdio, SSE, StreamableHTTP. Connect external tools with one click. Built-in MCP tools like @aqbot/fetch.
  - icon: 🌐
    title: Built-in API Gateway
    details: Local OpenAI-compatible API server. Use AQBot as the backend for Claude Code, Codex, Gemini CLI, and more. Key management, rate limiting, SSL/TLS.
  - icon: 📚
    title: Knowledge Base & RAG
    details: Local vector embeddings with sqlite-vec. AI answers based on your private documents — data never leaves your machine.
  - icon: 🔍
    title: Web Search
    details: Integrated Tavily, Zhipu WebSearch, Bocha. Search results with citation sources injected into the conversation context.
  - icon: ✏️
    title: Rich Content Rendering
    details: Markdown, LaTeX, Mermaid diagrams, D2 architecture diagrams, Monaco Code Editor with diff preview, and Artifact panels.
  - icon: ⌨️
    title: Desktop Experience
    details: Global shortcuts, system tray, auto-start, always-on-top, dark/light themes, and proxy support.
  - icon: 🔒
    title: Privacy & Security
    details: All data stored locally. AES-256 encrypted API keys. Auto backup to local or WebDAV. Conversation export as PNG/Markdown/JSON.
---
