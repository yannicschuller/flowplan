# Installation with Docker

Flowplan runs as a single container with SQLite and a data directory. Postgres, Redis or a separate search service are not needed.

## Requirements

- A server with Docker and a persistent volume. Text recognition for scanned PDFs briefly needs noticeable CPU when uploading.
- A domain with HTTPS behind a reverse proxy (Traefik, Caddy, nginx, Coolify, Pangolin …).
- Optionally an OpenID Connect provider for single sign-on. Without one, people sign in with e-mail and password or a passkey, see [Sign-in](/docs/anmeldung-oidc).
- Optionally an S3-compatible storage for files and the continuous database backup, see [Storage, S3 and backups](/docs/speicher-und-sicherung).

## With Docker Compose

Flowplan is open source (AGPL-3.0). The ready-made image is in the GitHub Container Registry, for `linux/amd64` and `linux/arm64`:

| Tag | Content |
| --- | --- |
| `ghcr.io/yannicschuller/flowplan:latest` | The latest state of `main` |
| `ghcr.io/yannicschuller/flowplan:1.2.3` | A fixed version (Git tag `v1.2.3`) |

Download the Compose file and the example configuration:

```bash
mkdir flowplan && cd flowplan
curl -O https://raw.githubusercontent.com/yannicschuller/flowplan/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/yannicschuller/flowplan/main/.env.example
```

In `.env`, set at least the public address:

```dotenv
APP_URL=https://flowplan.example.com
```

For single sign-on also set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_ADMIN_GROUP` (see [Sign-in](/docs/anmeldung-oidc)); for e-mails (invitations, forgotten passwords) the `SMTP_*` values from the [configuration](/docs/konfiguration#e-mail-smtp).

```bash
docker compose up -d
```

The container listens on port `3000` (bound to `127.0.0.1` only in the Compose file, so that the proxy sits in front of it). The volume `flowplan-data` on `/app/data` holds all content independently of the container. Choose a fixed version with `FLOWPLAN_VERSION=1.2.3` in `.env`.

> [!NOTE]
> A self-hosted instance opens with the sign-in page. The product website and the public demo belong to [flowplan.org](https://flowplan.org) only.

## Build the image yourself

From the source code ([github.com/yannicschuller/flowplan](https://github.com/yannicschuller/flowplan)):

```bash
git clone https://github.com/yannicschuller/flowplan.git && cd flowplan
cp .env.example .env
docker compose up -d --build
```

Or without Compose:

```bash
docker build -t flowplan:latest .
docker run -d --name flowplan \
  -p 127.0.0.1:3000:3000 \
  -v flowplan-data:/app/data \
  --env-file .env \
  flowplan:latest
```

The image contains Node, Litestream for the S3 backup and `curl` for the health check. It runs as the user `node` (UID 1000).

## First start

1. Open `https://flowplan.example.com/api/health` – the answer is `200` with `"status":"ok"`.
2. Open the address in the browser: a new instance offers **Create account**. This first account administers the instance. (With single sign-on: **Sign in with SSO**; administrators are the members of the group in `OIDC_ADMIN_GROUP`.)
3. In the sidebar under **Administration**, set the instance name, upload limit, sign-ups and the [other settings](/docs/administration).

> [!WARNING]
> Flowplan is built for **exactly one running instance**. Several replicas would write to the same SQLite file. Do not scale horizontally; when updating, stop the old container before the new one.

## Update

```bash
docker compose pull
docker compose up -d
```

With a self-built image, use `git pull` and `docker compose up -d --build` instead.

On start, Flowplan migrates the database itself. Make a backup beforehand (see [Storage, S3 and backups](/docs/speicher-und-sicherung)); going back to an older version after a migration is not supported.

## Without Docker

Node.js 22.13 or newer (the image uses Node 26):

```bash
npm ci
npm run build
FLOWPLAN_DATA_DIR=/var/lib/flowplan npm start
```

For local development, `npm run dev` is enough. Development mode also offers **Open local workspace**, a shared example account; production mode has no such access.

## Next

- [Configuration](/docs/konfiguration): all environment variables.
- [Coolify and reverse proxies](/docs/coolify-und-proxy): running behind Traefik, Coolify or Pangolin.
