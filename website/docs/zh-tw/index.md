---
layout: home
title: AQBot — 開源 AI 桌面客戶端 & AI 閘道
titleTemplate: false

head:
  - - meta
    - name: description
      content: AQBot 是一款免費開源的 AI 桌面客戶端，內建 AI 閘道。支援 OpenAI、Claude、Gemini、DeepSeek 等多模型對話，MCP 伺服器、知識庫、隱私優先。

hero:
  name: AQBot
  text: 您的 AI 桌面助手
  tagline: 多模型對話、MCP 工具、API 閘道、知識庫，一個開源客戶端全部搞定
  image:
    src: /logo.png
    alt: AQBot
  actions:
    - theme: brand
      text: 快速開始
      link: /zh-tw/guide/getting-started
    - theme: alt
      text: 下載安裝
      link: /zh-tw/download
    - theme: alt
      text: GitHub
      link: https://github.com/AQBot-Desktop/AQBot

features:
  - icon: 🤖
    title: 多模型對話
    details: 接入 OpenAI、Claude、Gemini、DeepSeek、Qwen 等所有相容 API。多金鑰輪詢、串流輸出、Thinking 折疊展開。
  - icon: 🔌
    title: MCP 工具呼叫
    details: 完整實現 Model Context Protocol，支援 stdio、SSE、StreamableHTTP。一鍵連接外部工具，內建 @aqbot/fetch 等 MCP 工具。
  - icon: 🌐
    title: 內建 API 閘道
    details: 本機 OpenAI 相容 API 伺服器，可作為 Claude Code、Codex、Gemini CLI 等工具的後端。金鑰管理、速率限制、SSL/TLS。
  - icon: 📚
    title: 知識庫 & RAG
    details: 本機向量嵌入（sqlite-vec），AI 基於您的私有文件回答，資料不出本機。
  - icon: 🔍
    title: 聯網搜尋
    details: 整合 Tavily、智譜 WebSearch、Bocha，搜尋結果附帶引用來源，自動注入對話上下文。
  - icon: ✏️
    title: 豐富內容渲染
    details: Markdown、LaTeX 公式、Mermaid 流程圖、D2 架構圖、Monaco 程式碼編輯器 diff 預覽、Artifact 獨立面板。
  - icon: ⌨️
    title: 桌面體驗
    details: 全域快捷鍵、系統托盤、開機自啟、視窗置頂、深淺主題、代理支援。
  - icon: 🔒
    title: 隱私安全
    details: 所有資料本機儲存，AES-256 加密 API 金鑰。支援自動備份到本機、WebDAV。對話匯出為 PNG/Markdown/JSON。
---
