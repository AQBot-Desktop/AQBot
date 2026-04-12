[简体中文](./README.md) | [繁體中文](./README-ZH-TW.md) | [English](./README-EN.md) | [日本語](./README-JA.md) | [한국어](./README-KO.md) | [Français](./README-FR.md) | **Deutsch** | [Español](./README-ES.md) | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

<p align="center">
    <a href="https://www.producthunt.com/products/aqbot?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-aqbot" target="_blank" rel="noopener noreferrer"><img alt="AQBot - Lightweight, high-perf cross-platform AI desktop client | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1118403&amp;theme=light&amp;t=1775627359538"></a>
</p>

## Screenshots

| Chat-Diagramm-Rendering | Anbieter und Modelle |
|:---:|:---:|
| ![](.github/images/s1.png) | ![](.github/images/s2.png) |

| Wissensdatenbank | Gedächtnis |
|:---:|:---:|
| ![](.github/images/s3.png) | ![](.github/images/s4.png) |

| Agent - Anfrage | API-Gateway Ein-Klick-Zugang |
|:---:|:---:|
| ![](.github/images/s5.png) | ![](.github/images/s6.png) |

| Chat-Modell-Auswahl | Chat-Navigation |
|:---:|:---:|
| ![](.github/images/s7.png) | ![](.github/images/s8.png) |

| Agent - Berechtigungsgenehmigung | API-Gateway-Übersicht |
|:---:|:---:|
| ![](.github/images/s9.png) | ![](.github/images/s10.png) |

## Funktionen

### Chat & Modelle

- **Multi-Anbieter-Unterstützung** — Kompatibel mit OpenAI, Anthropic Claude, Google Gemini und allen OpenAI-kompatiblen APIs
- **Modellverwaltung** — Remote-Modelllisten abrufen, Parameter anpassen (Temperatur, maximale Tokens, Top-P usw.)
- **Multi-Key-Rotation** — Mehrere API-Schlüssel pro Anbieter konfigurieren mit automatischer Rotation zur Verteilung des Rate-Limit-Drucks
- **Streaming-Ausgabe** — Echtzeit-Token-für-Token-Rendering mit einklappbaren Denkblöcken
- **Nachrichtenversionen** — Zwischen mehreren Antwortversionen pro Nachricht wechseln, um Modell- oder Parametereffekte zu vergleichen
- **Gesprächsverzweigung** — Neue Zweige von einem beliebigen Nachrichtenknoten erstellen, mit seitenweisem Zweigvergleich
- **Gesprächsverwaltung** — Anheften, Archivieren, zeitgruppierte Anzeige und Massenoperationen
- **Gesprächskomprimierung** — Lange Gespräche automatisch komprimieren und dabei wichtige Informationen beibehalten, um Kontextraum zu sparen
- **Simultane Multi-Modell-Antwort** — Dieselbe Frage gleichzeitig an mehrere Modelle stellen, mit seitenweisem Antwortvergleich

### AI Agent

- **Agent-Modus** — Wechseln Sie in den Agent-Modus für die autonome Ausführung mehrstufiger Aufgaben: Dateien lesen/schreiben, Befehle ausführen, Code analysieren und mehr
- **Drei Berechtigungsstufen** — Standard (Schreibvorgänge erfordern Genehmigung), Bearbeitungen akzeptieren (Dateiänderungen automatisch genehmigen), Vollzugriff (keine Abfragen) — sicher und kontrollierbar
- **Arbeitsverzeichnis-Sandbox** — Agent-Operationen sind strikt auf das angegebene Arbeitsverzeichnis beschränkt, um unbefugten Zugriff zu verhindern
- **Werkzeug-Genehmigungspanel** — Echtzeit-Anzeige von Werkzeugaufruf-Anfragen mit einzelner Überprüfung, Ein-Klick „Immer erlauben" oder Ablehnen
- **Kostenverfolgung** — Echtzeit-Token-Nutzung und Kostenstatistiken pro Sitzung

### Inhaltsrendering

- **Markdown-Rendering** — Vollständige Unterstützung für Code-Hervorhebung, LaTeX-Mathematikformeln, Tabellen und Aufgabenlisten
- **Monaco Code-Editor** — Monaco Editor in Codeblöcken eingebettet mit Syntaxhervorhebung, Kopieren und Diff-Vorschau
- **Diagramm-Rendering** — Integriertes Rendering von Mermaid-Flussdiagrammen und D2-Architekturdiagrammen
- **Artifact-Panel** — Codeausschnitte, HTML-Entwürfe, Markdown-Notizen und Berichte in einem dedizierten Panel anzeigen
- **Echtzeit-Sprachchat** — (Demnächst) WebRTC-basierte Echtzeit-Sprache mit Unterstützung der OpenAI Realtime API

### Suche & Wissen

- **Websuche** — Integriert mit Tavily, Zhipu WebSearch, Bocha und mehr, mit Quellenangaben
- **Lokale Wissensbasis (RAG)** — Unterstützt mehrere Wissensbasen; Dokumente hochladen für automatisches Parsen, Chunking und Indexierung, mit semantischer Abrufung relevanter Abschnitte während Gesprächen
- **Gedächtnissystem** — Unterstützt Multi-Namespace-Gesprächsgedächtnis, mit manueller Eingabe oder KI-gestützter automatischer Extraktion (automatische Extraktion demnächst)
- **Kontextverwaltung** — Flexibles Anhängen von Dateianhängen, Suchergebnissen, Wissensbasisabschnitten, Gedächtniseinträgen und Werkzeugausgaben

### Werkzeuge & Erweiterungen

- **MCP-Protokoll** — Vollständige Model Context Protocol-Implementierung mit Unterstützung für stdio- und HTTP-Transporte
- **Integrierte Werkzeuge** — Sofort einsatzbereite integrierte MCP-Werkzeuge wie `@aqbot/fetch`
- **Werkzeugausführungs-Panel** — Visuelle Anzeige von Werkzeugaufruf-Anfragen und zurückgegebenen Ergebnissen

### API-Gateway

- **Lokales API-Gateway** — Integrierter lokaler API-Server mit nativer Unterstützung für OpenAI-kompatible, Claude- und Gemini-Schnittstellen, verwendbar als Backend für jeden kompatiblen Client
- **API-Schlüsselverwaltung** — Zugriffsschlüssel generieren, widerrufen und aktivieren/deaktivieren mit Beschreibungsnotizen
- **Nutzungsanalyse** — Anfragevolumen und Token-Nutzungsanalyse nach Schlüssel, Anbieter und Datum
- **SSL/TLS-Unterstützung** — Integrierte Generierung selbstsignierter Zertifikate, mit Unterstützung für benutzerdefinierte Zertifikate
- **Anfrage-Logs** — Vollständige Aufzeichnung aller API-Anfragen und -Antworten, die das Gateway passieren
- **Konfigurationsvorlagen** — Vorgefertigte Integrationsvorlagen für beliebte CLI-Tools wie Claude, Codex, OpenCode und Gemini

### Daten & Sicherheit

- **AES-256-Verschlüsselung** — API-Schlüssel und sensible Daten werden lokal mit AES-256 verschlüsselt; Master-Schlüssel mit 0600-Berechtigungen gespeichert
- **Isolierte Datenverzeichnisse** — Anwendungsstatus in `~/.aqbot/`; Benutzerdateien in `~/Documents/aqbot/`
- **Automatisches Backup** — Geplante automatische Backups in lokale Verzeichnisse oder WebDAV-Speicher
- **Backup-Wiederherstellung** — Ein-Klick-Wiederherstellung aus historischen Backups
- **Gesprächsexport** — Gespräche als PNG-Screenshots, Markdown, Klartext oder JSON exportieren

### Desktop-Erfahrung

- **Themenwechsel** — Dunkle/helle Themes, die den Systemeinstellungen folgen oder manuell festgelegt werden können
- **Oberflächensprache** — Vollständige Unterstützung für vereinfachtes Chinesisch, traditionelles Chinesisch, Englisch, Japanisch, Koreanisch, Französisch, Deutsch, Spanisch, Russisch, Hindi und Arabisch, jederzeit in den Einstellungen umschaltbar
- **Systemtray** — Beim Schließen des Fensters in den Systemtray minimieren, ohne Hintergrunddienste zu unterbrechen
- **Immer im Vordergrund** — Das Hauptfenster über allen anderen Fenstern anheften
- **Globale Tastenkürzel** — Anpassbare globale Tastaturkürzel, um das Hauptfenster jederzeit aufzurufen
- **Autostart** — Optionaler Start beim Systemstart
- **Proxy-Unterstützung** — HTTP- und SOCKS5-Proxy-Konfiguration
- **Automatische Updates** — Prüft beim Start automatisch auf neue Versionen und fordert zur Aktualisierung auf

## Plattformunterstützung

| Plattform | Architektur |
|-----------|------------|
| macOS | Apple Silicon (arm64), Intel (x86_64) |
| Windows 10/11 | x86_64, arm64 |
| Linux | x86_64 (AppImage/deb/rpm), arm64 (AppImage/deb/rpm) |

## Erste Schritte

Gehen Sie zur [Releases](https://github.com/AQBot-Desktop/AQBot/releases)-Seite und laden Sie das Installationsprogramm für Ihre Plattform herunter.

## FAQ

### macOS: „App ist beschädigt" oder „Entwickler kann nicht überprüft werden"

Da die Anwendung nicht von Apple signiert ist, kann macOS eine der folgenden Meldungen anzeigen:

- „AQBot" ist beschädigt und kann nicht geöffnet werden
- „AQBot" kann nicht geöffnet werden, da Apple es nicht auf Schadsoftware überprüfen kann

**Lösungsschritte:**

**1. Apps aus „Beliebiger Herkunft" zulassen**

```bash
sudo spctl --master-disable
```

Gehen Sie dann zu **Systemeinstellungen → Datenschutz & Sicherheit → Sicherheit** und wählen Sie **Beliebige Herkunft**.

**2. Das Quarantäne-Attribut entfernen**

```bash
sudo xattr -dr com.apple.quarantine /Applications/AQBot.app
```

> Tipp: Sie können das App-Symbol in das Terminal ziehen, nachdem Sie `sudo xattr -dr com.apple.quarantine ` eingegeben haben.

**3. Zusätzlicher Schritt für macOS Ventura und höher**

Nach Abschluss der obigen Schritte kann der erste Start immer noch blockiert werden. Gehen Sie zu **Systemeinstellungen → Datenschutz & Sicherheit** und klicken Sie im Sicherheitsbereich auf **Trotzdem öffnen**. Dies muss nur einmal durchgeführt werden.

## Community
- [LinuxDO](https://linux.do)

## Lizenz

Dieses Projekt ist unter der [AGPL-3.0](LICENSE)-Lizenz lizenziert.
