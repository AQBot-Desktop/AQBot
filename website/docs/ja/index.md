---
layout: home
title: AQBot — オープンソース AI デスクトップクライアント & ゲートウェイ
titleTemplate: false

head:
  - - meta
    - name: description
      content: AQBot は無料のオープンソース AI デスクトップクライアントで、AI ゲートウェイを内蔵しています。OpenAI、Claude、Gemini、DeepSeek などのマルチモデル対話、MCP サーバー、ナレッジベース、プライバシー重視。

hero:
  name: AQBot
  text: あなたの AI デスクトップアシスタント
  tagline: マルチモデルチャット、MCP ツール、API ゲートウェイ、ナレッジベース — すべて一つのオープンソースクライアントで
  image:
    src: /logo.png
    alt: AQBot
  actions:
    - theme: brand
      text: はじめる
      link: /ja/guide/getting-started
    - theme: alt
      text: ダウンロード
      link: /ja/download
    - theme: alt
      text: GitHub
      link: https://github.com/AQBot-Desktop/AQBot

features:
  - icon: 🤖
    title: マルチモデルチャット
    details: OpenAI、Claude、Gemini、DeepSeek、Qwen などすべての互換 API に接続。マルチキーローテーション、ストリーミング出力、思考ブロック対応。
  - icon: 🔌
    title: MCP ツール呼び出し
    details: Model Context Protocol を完全実装。stdio、SSE、StreamableHTTP をサポート。ワンクリックで外部ツールに接続、@aqbot/fetch などのビルトイン MCP ツール付き。
  - icon: 🌐
    title: ビルトイン API ゲートウェイ
    details: ローカル OpenAI 互換 API サーバー。Claude Code、Codex、Gemini CLI などのバックエンドとして使用可能。キー管理、レート制限、SSL/TLS 対応。
  - icon: 📚
    title: ナレッジベース & RAG
    details: sqlite-vec によるローカルベクトル埋め込み。プライベートドキュメントに基づく AI 回答、データはローカルから外に出ません。
  - icon: 🔍
    title: ウェブ検索
    details: Tavily、Zhipu WebSearch、Bocha と統合。引用ソース付きの検索結果が会話コンテキストに自動注入されます。
  - icon: ✏️
    title: リッチコンテンツレンダリング
    details: Markdown、LaTeX、Mermaid 図、D2 アーキテクチャ図、Monaco コードエディター（diff プレビュー付き）、Artifact パネル。
  - icon: ⌨️
    title: デスクトップ体験
    details: グローバルショートカット、システムトレイ、自動起動、最前面表示、ダーク/ライトテーマ、プロキシサポート。
  - icon: 🔒
    title: プライバシー & セキュリティ
    details: すべてのデータをローカルに保存。AES-256 で API キーを暗号化。ローカルまたは WebDAV への自動バックアップ。PNG/Markdown/JSON 形式でエクスポート。
---
