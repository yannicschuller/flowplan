# Coolify und Reverse Proxy

Flowplan braucht vor sich nur einen HTTPS-Proxy. WebSockets sind nicht nötig: Zusammenarbeit läuft über normale HTTP-Anfragen und Server-Sent Events.

## Coolify

1. **Neue Ressource → Docker Image** (oder **Dockerfile** aus dem Git-Repository) wählen.
2. **Ports Exposes**: `3000`.
3. Domain eintragen, z. B. `https://flowplan.example.com`. Coolify holt das Zertifikat über Traefik.
4. **Persistent Storage**: Volume, Ziel `/app/data`.
5. Umgebungsvariablen aus der [Konfiguration](/docs/configuration) setzen.
6. Bereitstellen. Nach etwa 20 Sekunden meldet der Healthcheck den Container als gesund.

### Healthcheck

Das Image bringt einen eigenen Healthcheck mit. Wird er in Coolify eingestellt:

| Feld | Wert |
| --- | --- |
| Check type | HTTP request |
| Method / Scheme / Host | `GET` / `HTTP` / `localhost` |
| Port | `3000` – leer bedeutet 80, dort lauscht nichts |
| Path | `/api/health` |
| Expected code | `200` |
| Start period | `30` Sekunden (mit S3 stellt Litestream beim ersten Start die Datenbank her) |

### Volume-Rechte

Der Container läuft als UID 1000. Ein neues Docker-Volume bekommt die Rechte automatisch. Ein eingebundener Host-Ordner muss dieser UID gehören:

```bash
sudo chown -R 1000:1000 /pfad/zu/flowplan-data
```

### Automatisch ausrollen

Eine CI-Pipeline kann nach dem Image-Build ein Deployment über die Coolify-API auslösen (`POST /api/v1/deploy` mit der UUID der Anwendung und einem API-Token mit Deploy-Recht). In Coolify muss dafür unter **Settings → API** der Zugriff eingeschaltet und die Adresse des CI-Servers erlaubt sein.

> [!WARNING]
> In Coolify die Anzahl der Instanzen bei 1 lassen. Mehrere Container würden dieselbe SQLite-Datei beschreiben.

## Pangolin, Traefik und andere Proxys

- `APP_URL` muss exakt der Adresse entsprechen, unter der Flowplan im Browser erscheint.
- Endet TLS am vorderen Proxy (etwa Pangolin) und reicht er an Traefik weiter, dort **TLS zum Ziel ausschalten** und einen **eigenen Host-Header** mit der Flowplan-Domain setzen – sonst findet Traefik keine Route und antwortet mit 404.
- Großes Hochladen: Inhaltsarchive können bis zu 2 GB groß sein. Traefik begrenzt die Anfragegröße nicht; nginx braucht `client_max_body_size`, Cloudflare hat eigene Grenzen.
- Zeitlimits: Export und Import großer Archive können Minuten dauern; Proxy-Timeouts ggf. erhöhen.
- Server-Sent Events (Live-Bearbeitung in Dokumenten, Live-Cursor auf Whiteboards) dürfen nicht gepuffert werden; nginx: `proxy_buffering off` (siehe Beispiel unten). Flowplan sendet dafür zusätzlich `X-Accel-Buffering: no`.

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

Den internen Port `3000` nie zusätzlich öffentlich freigeben.
