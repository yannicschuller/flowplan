# Flowplan highly available at Hetzner Cloud

Files for the example on the documentation page **High availability**
([English](https://docs.flowplan.org/en/high-availability),
[Deutsch](https://docs.flowplan.org/de/high-availability)): two (or more)
Flowplan servers in cluster mode behind the Hetzner Load Balancer, Redis and
PostgreSQL in a private network, files in Hetzner Object Storage. The page
explains every step and the options; this file is the short version.

```text
Internet ── HTTPS ──▶ Hetzner Load Balancer
                          │  private network, e.g. 10.0.0.0/16
              ┌───────────┴───────────┐
          app-1 :3000             app-2 :3000      compose.yaml
              └─────┬───────────┬─────┘
               redis :6379   postgres :5432        redis.yaml, postgres.yaml
              Object Storage (S3)
```

| File | Server | What |
| --- | --- | --- |
| `compose.yaml` | every app server | one Flowplan instance, listening on the private address only, health check on `/api/health/ready` |
| `redis.yaml` | the Redis server | Redis 7 with a password and no persistence |
| `postgres.yaml` | the PostgreSQL server | PostgreSQL 16 for the "one database server with backups" option; needs [`../cluster/postgres-init.sh`](../cluster/postgres-init.sh) next to it |
| `.env.example` | every server | the settings; secrets are empty – generate your own |

The base is [`../cluster`](../cluster), which runs the same on one host to
try it out.

## Set up

1. In the Hetzner Console: a private network, the servers (all in one
   location; `app-1` and `app-2` in a *spread* placement group), a Cloud
   Firewall that lets in only SSH from your address, a private Object
   Storage bucket with S3 credentials, and a load balancer attached to the
   network.
2. On every server: install Docker, copy this folder to `/opt/flowplan`
   and `cp .env.example .env`. Each server needs the first section of
   `.env` (`PRIVATE_IP`) and its own section.
3. Generate the shared keys **once** and put the same values into the
   `.env` of every app server: `openssl rand -base64 32` for
   `FLOWPLAN_ENCRYPTION_KEY`, `npx web-push generate-vapid-keys` for
   `WEB_PUSH_PUBLIC_KEY`/`WEB_PUSH_PRIVATE_KEY`, `openssl rand -hex 24`
   for the passwords and `FLOWPLAN_SETUP_TOKEN`. Keep a copy of the
   encryption key apart from the backups.
4. PostgreSQL server (or use Patroni or a managed service and skip this):
   put `deploy/compose/cluster/postgres-init.sh` from the repository next
   to `postgres.yaml`, then `docker compose -f postgres.yaml up -d`.
5. Redis server: `docker compose -f redis.yaml up -d`.
6. App servers, one after the other: `docker compose up -d`; wait until
   `curl http://<private IP>:3000/api/health/ready` answers `200`.
7. Load balancer: targets `app-1`, `app-2` through the private network;
   service HTTPS 443 → 3000 with a certificate, redirect HTTP to HTTPS;
   health check HTTP on port 3000, path `/api/health/ready`; sticky
   sessions off. Point your domain's A/AAAA records at the load balancer.
8. Create the first account at `https://<domain>/register?setup=<token>`
   and switch on the scheduled backup under Administration → Storage &
   backup (`pg_dump` archives into the bucket).

## Updates

Set `FLOWPLAN_VERSION` in `.env` on every app server, then one server
after the other:

```bash
docker compose pull && docker compose up -d
curl -fsS http://<private IP>:3000/api/health/ready   # wait for 200, then the next server
```

The stopping instance answers `503` on `/api/health/ready`, so the load
balancer takes it out; the new one brings the schema up to date (it only
adds). `docker compose run --rm schema` does that step on its own before
the first server. The image's deployment id keeps browsers from mixing the
two versions meanwhile.

## Active/passive instead

Set `FLOWPLAN_CLUSTER=off` and leave `REDIS_URL` empty: then Flowplan may
run on **one** app server at a time – keep the container stopped on the
other one and start it there only after the first one is stopped (the
load balancer follows the health check). A second instance against the
same database logs a warning and shows one in Administration → Monitoring.
With SQLite and Litestream instead of PostgreSQL, use the
[`compose.yaml`](../../../compose.yaml) of the repository with the same
`S3_*` variables and keys on both servers; the docs page describes the
switch-over.
