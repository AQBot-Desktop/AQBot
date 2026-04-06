---
layout: home
title: AQBot — Client de bureau IA open-source & Passerelle
titleTemplate: false

head:
  - - meta
    - name: description
      content: AQBot est un client de bureau IA gratuit et open-source avec passerelle IA intégrée. Connectez OpenAI, Claude, Gemini, DeepSeek et d'autres LLMs. Support serveur MCP, base de connaissances, confidentialité d'abord.

hero:
  name: AQBot
  text: Votre assistant IA de bureau
  tagline: Chat multi-modèles, outils MCP, passerelle API, base de connaissances — tout en un seul client open-source
  image:
    src: /logo.png
    alt: AQBot
  actions:
    - theme: brand
      text: Commencer
      link: /fr/guide/getting-started
    - theme: alt
      text: Télécharger
      link: /fr/download
    - theme: alt
      text: GitHub
      link: https://github.com/AQBot-Desktop/AQBot

features:
  - icon: 🤖
    title: Chat multi-modèles
    details: Connectez-vous à OpenAI, Claude, Gemini, DeepSeek, Qwen et toute API compatible. Rotation de clés multiples, sortie en streaming, blocs de réflexion.
  - icon: 🔌
    title: Appel d'outils MCP
    details: Implémentation complète du Model Context Protocol. Support stdio, SSE, StreamableHTTP. Connectez des outils externes en un clic. Outils MCP intégrés comme @aqbot/fetch.
  - icon: 🌐
    title: Passerelle API intégrée
    details: Serveur API local compatible OpenAI. Utilisez AQBot comme backend pour Claude Code, Codex, Gemini CLI et plus. Gestion des clés, limitation de débit, SSL/TLS.
  - icon: 📚
    title: Base de connaissances & RAG
    details: Embeddings vectoriels locaux avec sqlite-vec. Réponses IA basées sur vos documents privés — les données ne quittent jamais votre machine.
  - icon: 🔍
    title: Recherche web
    details: Intégration Tavily, Zhipu WebSearch, Bocha. Résultats de recherche avec sources de citation injectés dans le contexte de conversation.
  - icon: ✏️
    title: Rendu de contenu riche
    details: Markdown, LaTeX, diagrammes Mermaid, diagrammes d'architecture D2, éditeur Monaco avec aperçu diff, panneaux Artifact.
  - icon: ⌨️
    title: Expérience bureau
    details: Raccourcis globaux, barre système, démarrage automatique, toujours visible, thèmes sombre/clair, support proxy.
  - icon: 🔒
    title: Confidentialité & Sécurité
    details: Toutes les données stockées localement. Clés API chiffrées AES-256. Sauvegarde automatique locale ou WebDAV. Export de conversation en PNG/Markdown/JSON.
---
