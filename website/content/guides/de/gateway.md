# API-Gateway

## Was ist das API-Gateway?

AQBot enthält einen integrierten lokalen API-Server, der Ihre konfigurierten Anbieter als **OpenAI-kompatible**, **Claude-native** und **Gemini-native** Endpoints exponiert. Jedes Tool oder jeder Client, der eines dieser Protokolle verwendet, kann AQBot als Backend verwenden — keine separaten API-Schlüssel oder Relay-Dienste erforderlich.

Anwendungsfälle:

- Führen Sie **Claude Code CLI**, **OpenAI Codex CLI**, **Gemini CLI** oder **OpenCode** über AQBot aus.
- Verbinden Sie Ihre IDE-Erweiterungen mit einem einzigen, lokal verwalteten Endpoint.
- Teilen Sie einen Satz von Anbieter-Schlüsseln über viele Tools mit schlüsselbasiertem Rate-Limiting.

---

## Erste Schritte

1. Öffnen Sie **Einstellungen → API-Gateway** (oder drücken Sie <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>).
2. Klicken Sie auf **Starten**, um den Gateway-Server zu starten.
3. Standardmäßig lauscht der Server auf `127.0.0.1:8080` (HTTP).

::: tip
Aktivieren Sie **Auto-Start** in den Gateway-Einstellungen, um den Server automatisch beim Start von AQBot zu starten.
:::

---

## API-Schlüsselverwaltung

1. Gehen Sie zum Tab **API-Schlüssel**.
2. Klicken Sie auf **Neuen Schlüssel generieren**.
3. Fügen Sie optional eine **Beschreibung** hinzu (z.B. *Claude Code*, *VS Code*).
4. Kopieren Sie den Schlüssel — er wird nur einmal angezeigt.

---

## Konfigurationsvorlagen

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

### Benutzerdefinierter Client

```
Base URL:  http://127.0.0.1:8080/v1
API-Schlüssel: aqbot-xxxx
```

---

## Nächste Schritte

- [Schnellstart](./getting-started) — Zum Schnellstartleitfaden zurückkehren
- [Anbieter konfigurieren](./providers) — Die Upstream-Anbieter hinzufügen, zu denen das Gateway routet
- [MCP-Server](./mcp) — Externe Tools für KI-Tool-Aufruf verbinden
