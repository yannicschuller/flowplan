# Flowplan

**Documents, databases, whiteboards and a daily journal for teams – open source, self-hosted or hosted in Germany.**

[Website](https://flowplan.org) · [Documentation](https://flowplan.org/docs) · [Self-hosting guide](https://flowplan.org/docs/installation) · [Configuration](https://flowplan.org/docs/konfiguration) · [Changelog](https://github.com/yannicschuller/flowplan/commits/main)

[![CI](https://github.com/yannicschuller/flowplan/actions/workflows/ci.yml/badge.svg)](https://github.com/yannicschuller/flowplan/actions/workflows/ci.yml)
[![Docker image](https://github.com/yannicschuller/flowplan/actions/workflows/docker.yml/badge.svg)](https://github.com/yannicschuller/flowplan/pkgs/container/flowplan)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

Flowplan is a workspace for knowledge and projects in the spirit of Notion and AppFlowy: pages in a tree, a block editor, databases with many views, whiteboards and a journal – with real-time collaboration, fine-grained permissions and single sign-on. It runs as **one container with SQLite**: no Postgres, no Redis, no external search service. There is no AI and no tracking.

> The documentation is currently written in German; an English translation is in progress.

## Features

- **Block editor** – headings, lists, tasks with due dates and assignees, tables, code with syntax highlighting, callouts, toggles, columns, math (KaTeX), Mermaid diagrams, embeds, synced blocks, voice notes, slash menu and Markdown shortcuts.
- **Databases** – table, board, calendar, timeline, gallery, list, feed, chart and form views; relations, rollups, formulas, recurring dates, reminders, record templates and per-record permissions.
- **Whiteboards** – sticky notes, shapes, connectors, frames, pen, images, templates, voting, timer and presentation mode.
- **Journal** – one page per day with templates, trackers, review, memories and an optional PIN lock.
- **Collaboration** – live editing with cursors (Yjs/CRDT), comments and inline threads, mentions, reactions, suggested changes, inbox, e-mail digests and Web Push.
- **Sharing** – public pages, guest links for reading, commenting or editing, forms for anonymous answers.
- **Search, import and export** – full-text search including OCR for scanned PDFs, Markdown/HTML/CSV/Notion import, Markdown and ZIP export, version history and restorable content archives.
- **Sign-in** – e-mail and password, passkeys (WebAuthn) and optional single sign-on with OpenID Connect and groups.
- **Administration** – workspaces and spaces, quotas, audit log, session management, backups to S3 with Litestream, Prometheus metrics, API tokens and webhooks.
- **Apps** – installable web app with offline support; a desktop app (Electron) can be built from `desktop/`.

## Quick start (Docker)

You need Docker and a domain with HTTPS in front (Caddy, Traefik, nginx, Coolify …). Single sign-on with an OpenID Connect provider (Keycloak, Authentik, Zitadel, Microsoft Entra ID, Google …) is optional.

```sh
curl -O https://raw.githubusercontent.com/yannicschuller/flowplan/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/yannicschuller/flowplan/main/.env.example
# edit .env: at least APP_URL (optionally OIDC_* and SMTP_*)
docker compose up -d
```

Open your domain: a new instance offers **Create account** – the first account administers the instance. Others sign up when you allow it, or when you invite them. Passkeys are added in the profile settings.

For single sign-on, register a confidential web client at your OIDC provider with the redirect URI `https://<your-domain>/api/auth/callback`; members of the group in `OIDC_ADMIN_GROUP` administer the instance.

The image is published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

```
ghcr.io/yannicschuller/flowplan:latest     # latest commit on main
ghcr.io/yannicschuller/flowplan:1.2.3      # releases (git tags v1.2.3)
```

All data lives in the volume on `/app/data`. Run **exactly one** container per data directory (SQLite). Optional S3 storage mirrors uploads and backs up the database continuously.

More in the documentation:

- [Installation with Docker](https://flowplan.org/docs/installation)
- [Sign-in: password, passkeys and OIDC](https://flowplan.org/docs/anmeldung-oidc)
- [Configuration (all environment variables)](https://flowplan.org/docs/konfiguration)
- [Storage, S3 and backups](https://flowplan.org/docs/speicher-und-sicherung)
- [Coolify and reverse proxies](https://flowplan.org/docs/coolify-und-proxy)
- [Operations and troubleshooting](https://flowplan.org/docs/betrieb)

Every instance also serves the documentation itself under `/docs`.

## Development

Node.js 22.13 or newer (the Docker image and CI use Node 26).

```sh
npm ci
cp .env.example .env.local
npm run dev        # http://127.0.0.1:3000
```

Development mode also offers **Open local workspace**, a shared local example account. Production mode has no such access.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | TypeScript |
| `npm test` | Core tests (Node test runner, temporary data directories) |
| `npm run test:e2e` | Browser tests (Playwright, desktop and mobile); start a server with its own `FLOWPLAN_DATA_DIR` and set `TEST_BASE_URL` |
| `npm run check:standalone` | Runs the standalone build like the container and checks health, persistence and restore |

Stack: Next.js 16 (App Router), React 19, TypeScript, SQLite (`node:sqlite`), TipTap/ProseMirror with Yjs, Zod and Playwright. The source of the documentation is in [`content/docs`](content/docs).

## Hosted version

[flowplan.org](https://flowplan.org) runs Flowplan in a data centre in Germany. The website and the public demo there are not part of the self-hosted version: a self-hosted instance opens with its sign-in page.

## Contributing and security

Contributions are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Flowplan is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must make its source code available to its users.
