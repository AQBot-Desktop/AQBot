# Anbieter konfigurieren

AQBot verbindet sich gleichzeitig mit beliebig vielen KI-Anbietern. Jeder Anbieter hat seine eigenen API-Schlüssel, Modellliste und Parameterstandards.

## Unterstützte Anbieter

| Anbieter | Beispielmodelle |
|---------|----------------|
| **OpenAI** | GPT-4o, GPT-4, o3, o4-mini |
| **Anthropic** | Claude 4 Sonnet, Claude 4 Opus, Claude 3.5 Sonnet |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 |
| **DeepSeek** | DeepSeek V3, DeepSeek R1 |
| **Alibaba Cloud** | Qwen-Serie |
| **Zhipu AI** | GLM-Serie |
| **xAI** | Grok-Serie |
| **OpenAI-kompatible API** | Ollama, vLLM, LiteLLM, Drittanbieter-Relays usw. |

---

## Anbieter hinzufügen

1. Gehen Sie zu **Einstellungen → Anbieter**.
2. Klicken Sie auf die Schaltfläche **+** unten links.
3. Füllen Sie die Anbieterdetails aus:

| Feld | Beschreibung |
|------|-------------|
| **Name** | Anzeigename für die Seitenleiste (z.B. *OpenAI*) |
| **Typ** | Anbietertyp — bestimmt Standard-Base-URL und API-Verhalten |
| **Symbol** | Optionales Symbol zur visuellen Identifikation |
| **API-Schlüssel** | Der geheime Schlüssel aus dem Dashboard Ihres Anbieters |
| **Base URL** | API-Endpoint (für integrierte Typen vorausgefüllt) |
| **API-Pfad** | Anfragepfad — Standard ist `/v1/chat/completions` |

---

## Import über Website-Link

Anbieter-Websites, Relay-Dashboards, private Modellplattformen oder lokale Gateway-Seiten können einen Link **In AQBot öffnen** bereitstellen. Beim Klick öffnet der Browser die AQBot-Desktop-App, AQBot wechselt zu **Einstellungen → Anbieter**, zeigt einen Bestätigungsdialog und importiert die Konfiguration erst nach Bestätigung durch den Benutzer.

### Benutzerablauf

1. Installieren und öffnen Sie eine AQBot-Version, die Anbieterlinks unterstützt.
2. Klicken Sie im Browser auf den Link **In AQBot öffnen** des Anbieters.
3. Prüfen Sie in AQBot Anbietername, Base URL, Anbietertyp und API-Schlüssel-Präfix.
4. AQBot verwendet einen bestehenden Anbieter mit derselben Kombination aus **Base URL + Typ** wieder. Falls keiner existiert, wird ein neuer Anbieter erstellt; der API-Schlüssel wird nur hinzugefügt, wenn er noch nicht vorhanden ist.

AQBot validiert den Schlüssel nicht automatisch und ruft Modelle nicht automatisch ab. Klicken Sie nach dem Import auf **Modelle abrufen** oder fügen Sie Modelle manuell hinzu.

### Linkformat

```text
aqbot://providers?name=<name>&baseurl=<base-url>&apikey=<api-key>&type=<provider-type>
```

Beispiel:

```text
aqbot://providers?name=OpenAI&baseurl=https%3A%2F%2Fapi.openai.com&apikey=sk-xxx&type=openai
```

### Parameter

| Parameter | Erforderlich | Beschreibung |
|-----------|--------------|--------------|
| `name` | Ja | Anzeigename in AQBot, z. B. `OpenAI` oder `My Relay` |
| `baseurl` | Ja | URL-kodierte Base URL. Nur `http` und `https` sind erlaubt; query und hash werden abgelehnt. |
| `apikey` | Ja | API-Schlüssel, der in AQBot gespeichert wird. AQBot zeigt im Bestätigungsdialog nur ein Präfix. |
| `type` | Ja | Anbietertyp. Erlaubte Werte: `openai`, `openai_responses`, `anthropic`, `gemini`, `custom`. |

`baseurl` kann die bestehende Force-Suffix-Semantik von AQBot verwenden, z. B. `https://example.com!`. Beim Import per Link wird `api_path` nicht gesetzt; AQBot nutzt weiterhin den Standardpfad des gewählten Anbietertyps.

### Website-Konfiguration

Kodieren Sie alle dynamischen Werte mit `encodeURIComponent` oder `URLSearchParams`:

```html
<a id="open-aqbot" href="#">In AQBot öffnen</a>

<script>
  const provider = {
    name: 'My Relay',
    baseurl: 'https://api.example.com',
    apikey: 'sk-user-key',
    type: 'openai',
  };

  const params = new URLSearchParams({
    name: provider.name,
    baseurl: provider.baseurl,
    apikey: provider.apikey,
    type: provider.type,
  });

  document.getElementById('open-aqbot').href = `aqbot://providers?${params.toString()}`;
</script>
```

Wenn Ihr Dienst API-Schlüssel online erzeugt, erstellen Sie den Link erst, nachdem der Benutzer angemeldet ist und ausdrücklich einen Schlüssel ausgewählt oder erstellt hat.

::: warning Sicherheit
Ein API-Schlüssel in einer URL kann im Browserverlauf, in Logs, Erweiterungen oder Analysewerkzeugen sichtbar werden. Platzieren Sie echte Schlüssel nicht auf öffentlichen Seiten, in statischem HTML oder in Drittanbieter-Weiterleitungen. Erzeugen Sie den Link vorzugsweise auf einer privaten Kontoseite nach Benutzerbestätigung.
:::

::: tip Test
`aqbot://` ist ein benutzerdefiniertes Protokoll, das von der installierten Desktop-App im System registriert wird. Nur die Website oder den Vite-Entwicklungsserver auszuführen registriert das Protokoll nicht. Wenn der Link AQBot nicht öffnet, installieren oder bauen Sie zuerst die aktuelle AQBot-Desktop-App neu.
:::

---

## Aus CC Switch importieren

AQBot kann CC Switch-Providerkonfigurationen unter Settings -> Providers scannen. Prüfen Sie Kandidaten, wählen Sie importierbare Zeilen aus und importieren Sie Provider, Base URLs, API Keys und Modelllisten. OAuth-only Einträge oder Einträge ohne wiederverwendbare Schlüssel werden mit sichtbarem Grund übersprungen.

## Erweiterter Modell-Request-Body

Jedes Modell kann extra_body definieren, ein JSON-Objekt, das flach zu OpenAI-kompatiblen Chat Completions Requests hinzugefügt wird. Das ist nützlich für Anbieteroptionen wie enable_thinking. AQBot validiert JSON und verhindert das Überschreiben von model, messages, stream, tools und Basis-Sampling-Feldern.

## Multi-Key-Rotation

AQBot unterstützt mehrere API-Schlüssel pro Anbieter. Klicken Sie auf **Schlüssel hinzufügen** im Anbieter-Detailpanel.

---

## Modellverwaltung

Klicken Sie auf **Modelle abrufen** im Anbieter-Detailpanel, um die vollständige Liste der verfügbaren Modelle zu laden. Sie können Modell-IDs auch manuell eingeben.

Jedes Modell kann eigene Standardparameterüberschreibungen haben: Temperatur, Max. Tokens, Top P, Häufigkeitsstrafe, Präsenzstrafe.

---

## Ollama (lokale Modelle)

1. Installieren und starten Sie [Ollama](https://ollama.com/).
2. Erstellen Sie in AQBot einen neuen Anbieter mit Typ **OpenAI**.
3. Setzen Sie die **Base URL** auf `http://localhost:11434`.
4. Klicken Sie auf **Modelle abrufen**, um lokal heruntergeladene Modelle zu entdecken.

---

## Nächste Schritte

- [MCP-Server](./mcp) — Externe Tools zur Erweiterung der KI-Fähigkeiten verbinden
- [API-Gateway](./gateway) — Ihre Anbieter als lokalen API-Server exponieren
