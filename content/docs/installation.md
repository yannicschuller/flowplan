# Installation mit Docker

Flowplan läuft als ein einziger Container mit SQLite und einem Datenverzeichnis. Postgres, Redis oder ein separater Suchdienst werden nicht gebraucht.

## Voraussetzungen

- Ein Server mit Docker und einem dauerhaften Volume. Die Texterkennung gescannter PDFs braucht beim Hochladen kurzzeitig spürbar CPU.
- Eine Domain mit HTTPS über einen Reverse Proxy (Traefik, Caddy, nginx, Coolify, Pangolin …).
- Ein OpenID-Connect-Anbieter für die Anmeldung, siehe [Anmeldung mit OIDC](/docs/anmeldung-oidc).
- Optional: ein S3-kompatibler Speicher für Dateien und die laufende Datenbanksicherung, siehe [Speicher, S3 und Sicherung](/docs/speicher-und-sicherung).

## Mit Docker Compose

Im Quellcode liegt eine `compose.yaml`. Mit einer `.env.local` daneben:

```dotenv
APP_URL=https://flowplan.example.com
OIDC_ISSUER=https://id.example.com/realms/company
OIDC_CLIENT_ID=flowplan
OIDC_CLIENT_SECRET=geheim
OIDC_ADMIN_GROUP=flowplan-admins
```

```bash
docker compose --env-file .env.local up --build -d
```

Der Container lauscht auf Port `3000` (in der Compose-Datei nur an `127.0.0.1` gebunden, damit der Proxy davor sitzt). Das Volume `flowplan-data` auf `/app/data` hält alle Inhalte unabhängig vom Container.

## Image selbst bauen

```bash
docker build -t flowplan:latest .
docker run -d --name flowplan \
  -p 127.0.0.1:3000:3000 \
  -v flowplan-data:/app/data \
  --env-file .env.local \
  flowplan:latest
```

Das Image enthält Node, Litestream für die S3-Sicherung und `curl` für den Healthcheck. Es läuft als Benutzer `node` (UID 1000).

## Erster Start

1. `https://flowplan.example.com/api/health` aufrufen – die Antwort ist `200` mit `"status":"ok"`.
2. Auf der Startseite **Anmelden** wählen und beim Login-Anbieter anmelden.
3. Ist dein Konto Mitglied der Gruppe aus `OIDC_ADMIN_GROUP`, erscheint **Administration** in der Seitenleiste. Dort Instanzname, Upload-Grenze und die [weiteren Einstellungen](/docs/administration) setzen.

> [!WARNING]
> Flowplan ist für **genau eine laufende Instanz** gebaut. Mehrere Replikate würden dieselbe SQLite-Datei beschreiben. Nicht horizontal skalieren; bei Updates den alten Container vor dem neuen stoppen.

## Aktualisieren

```bash
git pull
docker compose --env-file .env.local up --build -d
```

Beim Start migriert Flowplan die Datenbank selbst. Vorher eine Sicherung anlegen (siehe [Speicher, S3 und Sicherung](/docs/speicher-und-sicherung)); ein Zurückgehen auf eine ältere Version nach einer Migration ist nicht vorgesehen.

## Ohne Docker

Node.js 22.13 oder neuer (Node 24 LTS empfohlen):

```bash
npm ci
npm run build
FLOWPLAN_DATA_DIR=/var/lib/flowplan npm start
```

Für die lokale Entwicklung reicht `npm run dev`. Ohne OIDC-Konfiguration bietet nur der Entwicklungsmodus **Lokalen Arbeitsbereich öffnen** an; im Produktionsmodus gibt es diesen Zugang nicht.

## Weiter

- [Konfiguration](/docs/konfiguration): alle Umgebungsvariablen.
- [Coolify und Reverse Proxy](/docs/coolify-und-proxy): Betrieb hinter Traefik, Coolify oder Pangolin.
