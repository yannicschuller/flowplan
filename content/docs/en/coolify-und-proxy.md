# Coolify and reverse proxies

Flowplan only needs an HTTPS proxy in front of it. WebSockets are not needed: collaboration runs over normal HTTP requests and server-sent events.

## Coolify

1. Choose **New resource → Docker Image** (`ghcr.io/yannicschuller/flowplan:latest`) or **Dockerfile** from the Git repository.
2. **Ports Exposes**: `3000`.
3. Enter the domain, e.g. `https://flowplan.example.com`. Coolify gets the certificate via Traefik.
4. **Persistent Storage**: a volume with the target `/app/data`.
5. Set the environment variables from the [configuration](/docs/konfiguration).
6. Deploy. After about 20 seconds the health check reports the container as healthy.

### Health check

The image comes with its own health check. If you set it up in Coolify:

| Field | Value |
| --- | --- |
| Check type | HTTP request |
| Method / scheme / host | `GET` / `HTTP` / `localhost` |
| Port | `3000` – empty means 80, where nothing listens |
| Path | `/api/health` |
| Expected code | `200` |
| Start period | `30` seconds (with S3, Litestream restores the database on the first start) |

### Volume permissions

The container runs as UID 1000. A new Docker volume gets the permissions automatically. A mounted host folder must belong to this UID:

```bash
sudo chown -R 1000:1000 /path/to/flowplan-data
```

### Roll out automatically

A CI pipeline can trigger a deployment through the Coolify API after building the image (`POST /api/v1/deploy` with the application's UUID and an API token with deploy permission). For this, API access must be turned on in Coolify under **Settings → API** and the CI server's address must be allowed.

> [!WARNING]
> Keep the number of instances at 1 in Coolify. Several containers would write to the same SQLite file.

## Pangolin, Traefik and other proxies

- `APP_URL` must exactly match the address under which Flowplan appears in the browser.
- If TLS ends at the front proxy (such as Pangolin) and it passes on to Traefik, **turn off TLS to the target** there and set a **custom host header** with the Flowplan domain – otherwise Traefik finds no route and answers with 404.
- Large uploads: content archives can be up to 2 GB. Traefik does not limit the request size; nginx needs `client_max_body_size`, Cloudflare has its own limits.
- Timeouts: exporting and importing large archives can take minutes; raise proxy timeouts if needed.
- Server-sent events (live editing in documents, live cursors on whiteboards) must not be buffered; nginx: `proxy_buffering off` (see the example below). Flowplan also sends `X-Accel-Buffering: no` for this.

### nginx

```nginx
server {
  server_name flowplan.example.com;
  client_max_body_size 2g;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 600s;
  }
}
```

### Caddy

```
flowplan.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Never expose the internal port `3000` publicly as well.
