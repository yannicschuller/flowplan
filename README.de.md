<div align="center">

<img src="public/icon.svg" width="84" height="84" alt="Flowplan-Logo">

# Flowplan

**Dokumente, Datenbanken, Whiteboards und ein Journal für Teams.**<br>
Open Source, selbst betrieben in einem Container – oder gehostet in Deutschland.

[English](README.md) · **Deutsch**

[Website](https://flowplan.org) · [Dokumentation](https://docs.flowplan.org) · [Selbst betreiben](https://docs.flowplan.org/installation) · [Gehostete Version](https://app.flowplan.org) · [Änderungen](CHANGELOG.md)

[![CI](https://github.com/yannicschuller/flowplan/actions/workflows/ci.yml/badge.svg)](https://github.com/yannicschuller/flowplan/actions/workflows/ci.yml)
[![Docker-Image](https://github.com/yannicschuller/flowplan/actions/workflows/docker.yml/badge.svg)](https://github.com/yannicschuller/flowplan/pkgs/container/flowplan)
[![Lizenz: AGPL-3.0](https://img.shields.io/badge/Lizenz-AGPL--3.0-3b3fd8.svg)](LICENSE)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/readme/hero-dark.webp">
  <img src=".github/assets/readme/hero-light.webp" alt="Ein Flowplan-Dokument mit dem Seitenbaum links und dem Block-Editor" width="100%">
</picture>

</div>

Flowplan ist ein Arbeitsbereich für Wissen und Projekte im Geist von Notion und AppFlowy: Seiten in einem Baum, ein Block-Editor, Datenbanken mit vielen Ansichten, Whiteboards und ein Journal – mit gemeinsamer Bearbeitung in Echtzeit, feinen Rechten und Single Sign-on. Es läuft als **ein Container mit SQLite**: kein Postgres, kein Redis, kein externer Suchdienst. **Kein Tracking. KI ist optional:** standardmäßig aus, vom Admin pro Funktion und pro Person einschaltbar – komplett lokal mit Ollama oder mit eigenem Schlüssel für OpenAI, Anthropic, Gemini oder jeden OpenAI-kompatiblen Dienst. Die Oberfläche gibt es auf Deutsch, Englisch und Französisch – weitere Sprachen lassen sich als JSON-Kataloge hinzufügen ([Sprachen und Übersetzungen](https://docs.flowplan.org/languages)); die Dokumentation auf Deutsch und Englisch.

## Schreiben und denken

Ein Block-Editor, der nicht im Weg steht: Überschriften, Listen, Aufgaben mit Fälligkeit und Person, Tabellen, Code, Hinweisboxen, Aufklapper, Spalten, Einbettungen, synchronisierte Blöcke und Sprachnotizen. `/` öffnet das Blockmenü, Markdown-Kürzel funktionieren auch, und das Inhaltsverzeichnis neben dem Text hält lange Seiten übersichtlich.

**Rechnen direkt in den Notizen** – Rechnung und `=` tippen, mit <kbd>Tab</kbd> übernehmen. Einen Term markieren, um ihn auszumultiplizieren, zu faktorisieren oder zu lösen, Funktionsgraphen zeichnen und mit Vektoren in der Ebene und im Raum rechnen – in 3D gezeichnet und mit der Maus gedreht. Antworten aus ChatGPT behalten beim Einfügen Formeln, Listen und Tabellen.

<p align="center"><img src=".github/assets/readme/calculate.webp" alt="Eine Rechnung tippen, das Ergebnis mit Tab übernehmen, einen Term faktorisieren und zwei Vektoren samt Summe in einem drehbaren 3D-Graphen zeichnen" width="100%"></p>

## Ordnen mit Datenbanken

Tabelle, Board, Kalender, Zeitleiste, Galerie, Liste, Feed, Diagramm, Formular und Sprints für dieselben Einträge – mit Relationen, Rollups, Formeln, wiederkehrenden Terminen, Erinnerungen, Datensatzvorlagen und Rechten pro Eintrag. Einträge wandern per Ziehen zwischen Gruppen und sogar zwischen Datenbanken.

<p align="center"><img src=".github/assets/readme/board-drag.webp" alt="Eine Karte im Board von „Idea“ nach „In progress“ ziehen" width="100%"></p>

<table>
  <tr>
    <td width="50%"><img src=".github/assets/readme/timeline.webp" alt="Zeitleiste der Projekte-Datenbank mit Balken je Eintrag"></td>
    <td width="50%"><img src=".github/assets/readme/calendar.webp" alt="Kalenderansicht der Projekte-Datenbank"></td>
  </tr>
  <tr>
    <td><b>Zeitleiste</b> – planen mit Balken, Abhängigkeiten und Wochenenden.</td>
    <td><b>Kalender</b> – in Apple, Google oder Outlook abonnieren oder per CalDAV in beide Richtungen abgleichen.</td>
  </tr>
</table>

**Projekte und Tickets** (optional, pro Datenbank): Ticketnummern wie `WEB-123`, im Text verlinkt, Unteraufgaben und Epics mit Fortschritt, Sprints mit Backlog, Burndown und Velocity, Automationen, Status-Workflows, WIP-Limits, Zeiterfassung, eine Git-Anbindung für GitHub, GitLab und Gitea, Dashboards und ein Import aus Jira und Trello. **Umfragen** mit 19 Fragetypen, Bedingungen und Auswertung – jede Antwort ist ein Eintrag.

## Whiteboards und Journal

<table>
  <tr>
    <td width="50%"><img src=".github/assets/readme/whiteboard.webp" alt="Ein Whiteboard mit Haftnotizen, Ablaufdiagramm, Mindmap und verknüpfter Projektkarte"></td>
    <td width="50%"><img src=".github/assets/readme/journal.webp" alt="Das Journal mit dem heutigen Eintrag, Serie, Erinnerungen und Stimmungsstatistik"></td>
  </tr>
  <tr>
    <td><b>Whiteboards</b> – Haftnotizen, Formen, Verbinder, Rahmen, Mindmaps, Abstimmungen, Timer und Präsentationsmodus.</td>
    <td><b>Journal</b> – eine Seite pro Tag mit Vorlagen, Trackern, Rückblick, Erinnerungen und optionaler PIN-Sperre.</td>
  </tr>
</table>

## Gemeinsam, überall

Live-Bearbeitung mit Cursorn (Yjs/CRDT), Kommentare und Textkommentare, Erwähnungen, Reaktionen, Änderungsvorschläge, Posteingang, E-Mail-Zusammenfassungen und Web Push. Seiten lassen sich veröffentlichen, mit Gästen zum Lesen, Kommentieren oder Bearbeiten teilen oder als Formular für anonyme Antworten nutzen. Flowplan lässt sich als App installieren und funktioniert offline; Desktop-Apps für macOS, Windows und Linux gibt es unter [flowplan.org/download](https://flowplan.org/download) ([flowplan-desktop](https://github.com/yannicschuller/flowplan-desktop), mit automatischen Updates).

<p align="center">
  <img src=".github/assets/readme/mobile-board.webp" alt="Das Board auf dem Handy" width="32%">
  &nbsp;
  <img src=".github/assets/readme/mobile-journal.webp" alt="Das Journal auf dem Handy" width="32%">
</p>

## Für Admins

E-Mail und Passwort, Passkeys (WebAuthn) und Single Sign-on mit OpenID Connect und Gruppen. Grenzen pro Arbeitsbereich und pro Person (Speicher, eigene Arbeitsbereiche, Uploadgröße), Aktivitätsprotokoll, Sitzungsverwaltung, Sicherung nach S3 mit Litestream, Prometheus-Metriken, API-Tokens und Webhooks, ein [MCP-Server](https://docs.flowplan.org/mcp) für Claude, ChatGPT und andere KI-Assistenten (nur mit den eigenen Rechten der Person) – und laufende Version und Commit auf einen Blick. Volltextsuche samt Texterkennung in gescannten PDFs, Import aus Markdown, HTML, CSV und Notion, Export als Markdown und ZIP sowie ein Versionsverlauf mit Vergleich und Wiederherstellen einzelner Absätze.

## Schnellstart (Docker)

Du brauchst Docker und eine Domain mit HTTPS davor (Caddy, Traefik, nginx, Coolify …). Single Sign-on über einen OpenID-Connect-Anbieter (Keycloak, Authentik, Zitadel, Microsoft Entra ID, Google …) ist optional.

```sh
curl -O https://raw.githubusercontent.com/yannicschuller/flowplan/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/yannicschuller/flowplan/main/.env.example
# .env anpassen: mindestens APP_URL (optional OIDC_* und SMTP_*)
docker compose up -d
```

Auf Kubernetes nimmst du das Helm-Chart in [`deploy/helm/flowplan`](deploy/helm/flowplan/README.md) (ein Pod mit Volume, wie SQLite es braucht).

Öffne deine Domain: Eine neue Instanz bietet **Konto erstellen** an – das erste Konto verwaltet die Instanz. Weitere Personen registrieren sich, wenn du es erlaubst oder sie einlädst. Passkeys richtest du in den Profileinstellungen ein.

Für Single Sign-on legst du beim OIDC-Anbieter einen vertraulichen Web-Client mit der Weiterleitungsadresse `https://<deine-domain>/api/auth/callback` an; Mitglieder der Gruppe aus `OIDC_ADMIN_GROUP` verwalten die Instanz.

Das Image liegt in der GitHub Container Registry für `linux/amd64` und `linux/arm64`:

```
ghcr.io/yannicschuller/flowplan:latest     # die neueste Version
ghcr.io/yannicschuller/flowplan:1.2.3      # eine feste Version (auch :1.2 und :1)
ghcr.io/yannicschuller/flowplan:beta       # der letzte manuelle Build, nicht für den Betrieb
```

Images entstehen nur beim Release oder von Hand: **Actions → Docker image → Run workflow** baut `:beta` aus dem gewählten Branch (mit Version baut es stattdessen dieses Release neu). Jedes `:beta`-Image lässt sich automatisch auf Coolify ausrollen: die Repository-Secrets `COOLIFY_WEBHOOK` (Deploy-Webhook der Ressource) und `COOLIFY_TOKEN` (API-Token mit Deploy-Recht) setzen und in Coolify das `:beta`-Image verwenden. Siehe [Coolify und Reverse Proxy](https://docs.flowplan.org/coolify-and-proxy).

Alle Daten liegen im Volume unter `/app/data`. Betreibe **genau einen** Container pro Datenverzeichnis (SQLite). Optionaler S3-Speicher spiegelt Uploads und sichert die Datenbank laufend.

Mehr in der Dokumentation:

- [Installation mit Docker](https://docs.flowplan.org/installation)
- [Anmeldung: Passwort, Passkeys und OIDC](https://docs.flowplan.org/sign-in)
- [Konfiguration (alle Umgebungsvariablen)](https://docs.flowplan.org/configuration)
- [Speicher, S3 und Sicherungen](https://docs.flowplan.org/storage-and-backups)
- [Coolify und Reverse Proxys](https://docs.flowplan.org/coolify-and-proxy)
- [Betrieb und Fehlersuche](https://docs.flowplan.org/operations)

## Entwicklung

Node.js 22.13 oder neuer (Docker-Image und CI nutzen Node 26).

```sh
npm ci
cp .env.example .env.local
npm run dev        # http://127.0.0.1:3000
```

Im Entwicklungsmodus gibt es zusätzlich **Lokalen Arbeitsbereich öffnen**, ein gemeinsames lokales Beispielkonto. Im Produktivbetrieb fehlt dieser Zugang.

| Befehl | Was er tut |
| --- | --- |
| `npm run dev` | Entwicklungsserver |
| `npm run build` / `npm start` | Produktions-Build und -Server |
| `npm run typecheck` | TypeScript |
| `npm test` | Kerntests (Node-Testrunner, temporäre Datenverzeichnisse) |
| `npm run test:e2e` | Browsertests (Playwright, Desktop und Handy); einen Server mit eigenem `FLOWPLAN_DATA_DIR` starten und `TEST_BASE_URL` setzen |
| `npm run check:standalone` | Startet den Standalone-Build wie im Container und prüft Health, Persistenz und Wiederherstellung |

Technik: Next.js 16 (App Router), React 19, TypeScript, SQLite (`node:sqlite`), TipTap/ProseMirror mit Yjs, Zod und Playwright. Die Dokumentation liegt in [flowplan-docs](https://github.com/yannicschuller/flowplan-docs) (docs.flowplan.org), die Website in [flowplan-website](https://github.com/yannicschuller/flowplan-website) (flowplan.org), die Desktop-Apps in [flowplan-desktop](https://github.com/yannicschuller/flowplan-desktop); dieses Repository enthält nur die App.

## Gehostete Version

[app.flowplan.org](https://app.flowplan.org) betreibt Flowplan in einem Rechenzentrum in Deutschland. Jede Instanz, gehostet oder selbst betrieben, beginnt mit ihrer Anmeldeseite.

## Mitmachen und Sicherheit

Beiträge sind willkommen – siehe [CONTRIBUTING.md](CONTRIBUTING.md). Sicherheitslücken bitte vertraulich melden, wie in [SECURITY.md](SECURITY.md) beschrieben.

## Lizenz

Flowplan ist freie Software unter der [GNU Affero General Public License v3.0](LICENSE). Wer eine veränderte Version als Netzwerkdienst betreibt, muss deren Quellcode den Nutzerinnen und Nutzern zugänglich machen.
