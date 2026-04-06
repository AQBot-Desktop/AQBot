---
layout: home
title: AQBot — Open-Source KI-Desktop-Client & Gateway
titleTemplate: false

head:
  - - meta
    - name: description
      content: AQBot ist ein kostenloser Open-Source KI-Desktop-Client mit integriertem KI-Gateway. Verbinden Sie OpenAI, Claude, Gemini, DeepSeek und weitere LLMs. MCP-Server-Unterstützung, Wissensbasis, Datenschutz-first.

hero:
  name: AQBot
  text: Ihr KI-Desktop-Assistent
  tagline: Multi-Modell-Chat, MCP-Tools, API-Gateway, Wissensbasis — alles in einem Open-Source-Client
  image:
    src: /logo.png
    alt: AQBot
  actions:
    - theme: brand
      text: Erste Schritte
      link: /de/guide/getting-started
    - theme: alt
      text: Herunterladen
      link: /de/download
    - theme: alt
      text: GitHub
      link: https://github.com/AQBot-Desktop/AQBot

features:
  - icon: 🤖
    title: Multi-Modell-Chat
    details: Verbinden Sie sich mit OpenAI, Claude, Gemini, DeepSeek, Qwen und jeder kompatiblen API. Multi-Key-Rotation, Streaming-Ausgabe, Denkblöcke.
  - icon: 🔌
    title: MCP-Tool-Aufruf
    details: Vollständige Model Context Protocol-Implementierung. Unterstützung für stdio, SSE, StreamableHTTP. Mit einem Klick externe Tools verbinden. Integrierte MCP-Tools wie @aqbot/fetch.
  - icon: 🌐
    title: Integriertes API-Gateway
    details: Lokaler OpenAI-kompatibler API-Server. Verwenden Sie AQBot als Backend für Claude Code, Codex, Gemini CLI und mehr. Schlüsselverwaltung, Rate-Limiting, SSL/TLS.
  - icon: 📚
    title: Wissensbasis & RAG
    details: Lokale Vektoreinbettungen mit sqlite-vec. KI-Antworten basierend auf Ihren privaten Dokumenten — Daten verlassen nie Ihren Computer.
  - icon: 🔍
    title: Websuche
    details: Integration von Tavily, Zhipu WebSearch, Bocha. Suchergebnisse mit Zitationsquellen werden in den Gesprächskontext injiziert.
  - icon: ✏️
    title: Rich-Content-Rendering
    details: Markdown, LaTeX, Mermaid-Diagramme, D2-Architekturdiagramme, Monaco-Code-Editor mit Diff-Vorschau, Artifact-Panels.
  - icon: ⌨️
    title: Desktop-Erlebnis
    details: Globale Tastenkürzel, System-Tray, Auto-Start, immer im Vordergrund, Hell-/Dunkel-Themes, Proxy-Unterstützung.
  - icon: 🔒
    title: Datenschutz & Sicherheit
    details: Alle Daten lokal gespeichert. API-Schlüssel mit AES-256 verschlüsselt. Automatisches Backup lokal oder WebDAV. Gesprächsexport als PNG/Markdown/JSON.
---
