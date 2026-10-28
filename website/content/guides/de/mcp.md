# MCP-Server

## Was ist MCP?

Das [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) ist ein offener Standard, der es KI-Modellen ermöglicht, mit externen Tools und Datenquellen zu interagieren. AQBot fungiert als MCP-Client — Sie fügen MCP-Server hinzu, und die KI kann die von ihnen bereitgestellten Tools während eines Gesprächs aufrufen.

---

## Transportprotokolle

AQBot unterstützt drei Transportprotokolle für die Kommunikation mit MCP-Servern:

| Protokoll | Verbindung | Anwendungsfall | Konfiguration |
|-----------|-----------|----------------|--------------|
| **Stdio** | Lokaler Prozess | Tools auf Ihrem Rechner, gestartet via `npx`, `uvx`, `python` usw. | `command` + `args` + optionales `env` |
| **SSE** | Remote-Server | Server-Sent Events-Endpoint auf einem Remote-Server | `url` |
| **StreamableHTTP** | Remote-Server | HTTP-Streaming-Endpoint, neuere Alternative zu SSE | `url` |

---

## MCP-Server hinzufügen

### Formular-Erstellung

1. Gehen Sie zu **Einstellungen → MCP-Server**.
2. Klicken Sie auf **MCP-Server hinzufügen**.
3. Geben Sie einen Namen ein und wählen Sie das Transportprotokoll.
4. Füllen Sie die Felder für Ihr gewähltes Protokoll aus.
5. Klicken Sie auf **Speichern**.

### JSON-Import

Klicken Sie auf **JSON-Import** und fügen Sie ein Konfigurationsobjekt ein. AQBot akzeptiert das Standard-MCP-JSON-Format:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

---

## Integrierte Tools

| Tool | Beschreibung |
|------|-------------|
| **@aqbot/fetch** | Webseiten und HTTP-Ressourcen abrufen |
| **@aqbot/search-file** | Dateien im lokalen Dateisystem suchen |

---

## Tool-Loop-Limit

Unter Settings -> MCP können Sie die maximale Anzahl aufeinanderfolgender Tool-Call-Iterationen für eine MCP-Antwort konfigurieren. Reduzieren Sie das Limit beim Testen unbekannter Server oder erhöhen Sie es für Workflows, die mehrere Tools bewusst verketten.

## Nächste Schritte

- [API-Gateway](./gateway) — Ihre Anbieter als lokalen API-Server exponieren
- [Schnellstart](./getting-started) — Zum Schnellstartleitfaden zurückkehren
