# Configuration

All environment variables at a glance. Many values can also be set in the interface under **Administration → Instance**; values set there take precedence.

## Required

| Variable | Example | Meaning |
| --- | --- | --- |
| `APP_URL` | `https://flowplan.example.com` | The public address exactly as it appears in the browser – scheme, host, port if any, without a trailing slash. The basis for sign-in redirects, cookies, passkeys, links in e-mails and push notifications and the origin check. |

## Sign-in

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLOWPLAN_LOCAL_LOGIN` | on | `false` turns off e-mail, password and passkeys; then only single sign-on remains. |
| `OIDC_ISSUER` | *empty* | The login provider for single sign-on. Without it there are only e-mail, password and passkeys. |
| `OIDC_CLIENT_ID` | – | Client ID. |
| `OIDC_CLIENT_SECRET` | – | Client secret. Never put it into the image or into Git. |
| `SESSION_HOURS` | `8` | How long a session lasts in hours (1–24). |

The other OIDC variables and everything about passwords and passkeys are described under [Sign-in](/docs/sign-in).

## Operations

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLOWPLAN_DATA_DIR` | `/app/data` in the image, `./data` otherwise | Data directory for SQLite, uploads, push keys and text recognition data. |
| `FLOWPLAN_WORKSPACE_QUOTA_MB` | unlimited | Default storage quota per workspace in MB (`0` = unlimited). |
| `FLOWPLAN_SNAPSHOT_RETENTION_DAYS` | `180` | How long automatic versions are kept, in days (`0` = forever). |
| `FLOWPLAN_OCR` | on | `0` turns off text recognition for scanned PDFs and images. |
| `FLOWPLAN_METRICS_TOKEN` | *empty* | At least 16 characters; enables `/api/metrics` in Prometheus format. |
| `FLOWPLAN_TRUSTED_PROXIES` | `1` | Number of proxies in front of Flowplan (Traefik alone: `1`, Pangolin in front of Traefik: `2`). Decides which entry in `X-Forwarded-For` is the real address – for limiting sign-in attempts, demo starts and anonymous form answers. Entries made up by the browser are ignored this way. |
| `FLOWPLAN_PUBLIC_SITE` | *empty* | Only for the official instance flowplan.org: `true` shows visitors the product website and allows the public demo. Self-hosted instances leave it empty and open with the sign-in page. |

## S3 and database backup

| Variable | Default | Meaning |
| --- | --- | --- |
| `S3_BUCKET` | *empty* | Turns S3 on. Without this variable everything stays local. |
| `S3_ENDPOINT` | AWS | API address of the storage, e.g. `http://minio:9000`. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | – | Access keys with read and write access to the bucket. |
| `S3_REGION` | `us-east-1` | Region. Garage requires its own value (often `garage`). |
| `S3_PREFIX` | `flowplan` | Folder in the bucket; files under `<prefix>/uploads/`, the database under `<prefix>/db/`. |
| `FLOWPLAN_LITESTREAM` | on | `off`: only mirror files, do not back up the database. |

Details: [Storage, S3 and backups](/docs/storage-and-backups).

## E-mail (SMTP)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_HOST` | *empty* | Turns on sending e-mail: invitations, address confirmations, password resets and digests of unread notifications. |
| `SMTP_PORT` | `587` | Port. With `465` Flowplan speaks TLS directly, STARTTLS otherwise. |
| `SMTP_SECURE` | by port | `true`/`false` forces TLS from the start of the connection. |
| `SMTP_USER` / `SMTP_PASSWORD` | *empty* | Sign-in at the mail server. |
| `SMTP_FROM` | `Flowplan <SMTP_USER>` | Sender, e.g. `Flowplan <flowplan@example.com>`. |

Check delivery under **Administration → Instance → Send test e-mail**.

## Integrations

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLOWPLAN_WEBHOOK_ALLOW_PRIVATE` | *empty* | `true` allows webhooks to internal addresses and `http://` – such as Home Assistant or n8n in the same network. Without this variable only public HTTPS addresses are allowed. |

## Voice notes (Whisper)

Voice notes in the editor are always stored as audio. With a Whisper service in your own network, Flowplan also turns them into text; the recording never leaves your server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WHISPER_URL` | *empty* | Address of an OpenAI-compatible Whisper server (`POST /v1/audio/transcriptions`), e.g. `http://whisper:8000`. Turns transcription on. |
| `WHISPER_MODEL` | `Systran/faster-whisper-small` | The model name as the service expects it. |
| `WHISPER_LANGUAGE` | `de` | Language of the recordings (e.g. `en`). |
| `WHISPER_API_KEY` | *empty* | Only if the service requires a key. |

Example with [speaches](https://github.com/speaches-ai/speaches) (formerly faster-whisper-server) in the same Compose project:

```yaml
  whisper:
    image: ghcr.io/speaches-ai/speaches:latest-cpu
    volumes:
      - whisper-models:/home/ubuntu/.cache/huggingface/hub
    restart: unless-stopped
```

Then set `WHISPER_URL=http://whisper:8000` for Flowplan. Newer speaches versions do not download models by themselves; download it once, for example from the Flowplan container:

```sh
node -e "fetch('http://whisper:8000/v1/models/Systran/faster-whisper-small',{method:'POST'}).then(r=>console.log(r.status))"
```

`small` needs about 1 GB of memory and transcribes roughly in real time on a normal CPU; `base` is faster and less accurate, `medium` more accurate and considerably slower. Do not make the Whisper service publicly reachable – only Flowplan talks to it.

## Push notifications

| Variable | Meaning |
| --- | --- |
| `WEB_PUSH_SUBJECT` | Contact for the push services, e.g. `mailto:admin@example.com`. |
| `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` | VAPID key pair. If not given, Flowplan creates one in `FLOWPLAN_DATA_DIR/web-push-keys.json`. |

The keys must not change, otherwise all devices lose their subscription. Outgoing HTTPS to the push services of Apple, Google and Mozilla must be possible.

## Do not set

The image sets `NODE_ENV`, `PORT`, `HOSTNAME` and `NEXT_TELEMETRY_DISABLED` itself. `FLOWPLAN_DIST_DIR` is only meant for parallel development servers, `OIDC_ALLOW_LOCAL_HTTP` only for tests with a provider on `http://localhost`.

## In the interface

Under **Administration → Instance**, administrators set:

- the instance name and a notice banner for everyone,
- the default storage quota and how long versions are kept,
- the maximum upload size,
- whether everyone may create workspaces of their own,
- whether anyone may sign up with e-mail and password,
- the daily database backup and how many copies are kept,
- after how many days without sign-in accounts are locked,
- on flowplan.org: whether the start page offers a **demo** (running and total started demos are shown under **Administration → Operations**).

Empty fields fall back to the environment variables.
