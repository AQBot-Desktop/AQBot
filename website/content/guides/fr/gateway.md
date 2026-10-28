# Passerelle API

## Qu'est-ce que la passerelle API ?

AQBot inclut un serveur API local intégré qui expose vos fournisseurs configurés comme endpoints **compatibles OpenAI**, **natifs Claude** et **natifs Gemini**. Tout outil ou client utilisant l'un de ces protocoles peut utiliser AQBot comme backend — sans clés API séparées ni services de relais.

Cas d'utilisation :

- Exécutez **Claude Code CLI**, **OpenAI Codex CLI**, **Gemini CLI** ou **OpenCode** via AQBot.
- Connectez vos extensions IDE à un unique endpoint géré localement.
- Partagez un ensemble de clés de fournisseur entre de nombreux outils avec limitation de débit par clé.

---

## Démarrage

1. Ouvrez **Paramètres → Passerelle API** (ou appuyez sur <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>).
2. Cliquez sur **Démarrer** pour lancer le serveur de passerelle.
3. Par défaut, le serveur écoute sur `127.0.0.1:8080` (HTTP).

::: tip
Activez le **Démarrage automatique** dans les paramètres de la passerelle pour lancer le serveur automatiquement au démarrage d'AQBot.
:::

---

## Gestion des clés API

1. Allez dans l'onglet **Clés API**.
2. Cliquez sur **Générer une nouvelle clé**.
3. Ajoutez optionnellement une **description** pour identifier chaque clé.
4. Copiez la clé — elle n'est affichée qu'une seule fois.

---

## Modèles de configuration

### Claude Code CLI

```bash
claude config set --global apiUrl http://127.0.0.1:8080
claude config set --global apiKey aqbot-xxxx
```

### OpenAI Codex CLI

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=aqbot-xxxx
codex
```

### Gemini CLI

```bash
export GEMINI_API_BASE=http://127.0.0.1:8080
export GEMINI_API_KEY=aqbot-xxxx
gemini
```

### Client personnalisé

```
URL de base :  http://127.0.0.1:8080/v1
Clé API :      aqbot-xxxx
```

---

## Prochaines étapes

- [Démarrage rapide](./getting-started) — retourner au guide de démarrage rapide
- [Configurer les fournisseurs](./providers) — ajouter les fournisseurs en amont vers lesquels la passerelle route
- [Serveurs MCP](./mcp) — connecter des outils externes pour l'appel d'outils IA
