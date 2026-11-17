# Flowplan Helm chart

Runs [Flowplan](https://flowplan.org) on Kubernetes – from one pod with
SQLite on a volume to several pods with high availability against
PostgreSQL, Redis and S3 (cluster mode). Documentation for operators:
[docs.flowplan.org/kubernetes](https://docs.flowplan.org/en/kubernetes).

- **One pod** (default, [`values-small.yaml`](values-small.yaml)): SQLite,
  uploads and keys on a PersistentVolumeClaim, exactly one replica,
  strategy `Recreate` (updates have a short downtime). Optionally S3 for the
  files and a continuous Litestream replica of the database.
- **Several pods** (`cluster.enabled`, [`values-ha.yaml`](values-ha.yaml)):
  rolling updates without downtime, a PodDisruptionBudget, pods spread over
  nodes, a schema Job before every upgrade. PostgreSQL, Redis and S3 are
  required – the chart creates none of them (managed services or their own
  charts).

Secrets are **never values** of this chart: passwords, keys and connection
strings come from Secrets you create, the chart only references them. The
one exception is the setup token, which the chart can generate (below).

## Architecture

```text
                    browsers, apps (HTTPS, server-sent events)
                                   │
                    ┌──────────────▼──────────────┐
                    │ Ingress (nginx: no buffering,│
                    │ 3600 s timeouts, body size)  │
                    └──────────────┬──────────────┘
                                   │ Service flowplan:80 → pods :3000
                                   │ (round robin, no sticky sessions)
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
 ┌─────────────┐            ┌─────────────┐            ┌─────────────┐
 │ pod 1       │            │ pod 2       │            │ pod 3       │
 │ (leader)    │            │             │            │             │
 │ live hub    │◀── Redis ─▶│ live hub    │◀── Redis ─▶│ live hub    │
 │ file cache  │  pub/sub   │ file cache  │  pub/sub   │ file cache  │
 └──┬───┬───┬──┘            └──┬───┬───┬──┘            └──┬───┬───┬──┘
    │   │   └──────────────────┼───┼───┴──────────────────┼───┼───┘
    │   │      ┌───────────────┘   │                      │   │
    │   └──────┼───────────────────┼──────────┐           │   │
    ▼          ▼                   ▼          ▼           ▼   ▼
 ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
 │ PostgreSQL         │   │ Redis              │   │ S3 bucket          │
 │ all data; leader   │   │ live updates,      │   │ all files (sealed  │
 │ lock + term; queues│   │ presence, rate     │   │ with the key), the │
 │ (SKIP LOCKED);     │   │ limits, heartbeats │   │ parts of uploads   │
 │ the source of truth│   │ (no persistence)   │   │ under tmp/         │
 └────────────────────┘   └────────────────────┘   └────────────────────┘
```

- **Live editing between pods:** each pod delivers changes to the browsers
  connected to it (server-sent events) and publishes them through Redis to
  the others, which deliver them to theirs. PostgreSQL holds the documents;
  the messages are only signals. A message lost – Redis restarting, a pod
  stopping – is caught up by the browser's next check (at most 20 s; at
  once when its stream reconnects). Two people on different pods edit the
  same document as on one.
- **Jobs:** exactly one pod leads (an advisory lock in PostgreSQL; a new
  leader takes over within `FLOWPLAN_LEADER_INTERVAL`, 5 s). Only the leader
  runs the timed jobs (reminders, automations, search index, retention,
  digests, backups, syncs …). Each round is fenced: taking the lead raises
  a term in the database, a round starts only while the term is still its
  own, and each job holds its own lock while it runs – a round of an old
  leader that lost its connection is never doubled by the new one. Queues
  (mail, push, webhooks, chat apps, workflow steps, the file queue) are
  claimed job by job by every pod (`FOR UPDATE SKIP LOCKED`, leases).
- **Files:** a request that stores a file answers only once the file is in
  the bucket; every pod reads through its local cache, fetching from the
  bucket what it does not have. Uploads in several requests (long
  transcriptions, meeting and notebook recordings, an import between its
  preview and the import) keep their parts in the bucket under
  `<prefix>/tmp/`, so each request may reach another pod.
- **Stopping a pod:** readiness turns 503 at once, the `preStop` pause lets
  the load balancer catch up, live streams close (browsers reconnect to
  another pod), open requests and running jobs finish, the uploads still
  under way and the due file queue are drained, the workflow leases and the
  lead go back – all within `terminationGracePeriodSeconds`.

## Install

The chart lives in the repository (it is not published to a chart
repository yet). One pod:

```sh
git clone https://github.com/yannicschuller/flowplan.git
cd flowplan
kubectl create namespace flowplan
kubectl -n flowplan create secret generic flowplan-env \
  --from-literal=FLOWPLAN_ENCRYPTION_KEY="$(openssl rand -base64 32)"
# Copy values-small.yaml, set your address and host names, then:
helm install flowplan deploy/helm/flowplan -n flowplan -f my-values.yaml
helm test flowplan -n flowplan
# The first account (administrator) is created with the setup link:
echo "https://flowplan.example.org/register?setup=$(kubectl -n flowplan get secret flowplan-setup \
  -o jsonpath='{.data.FLOWPLAN_SETUP_TOKEN}' | base64 -d)"
```

Several pods: create the Secrets listed at the top of
[`values-ha.yaml`](values-ha.yaml) (database and Redis addresses, S3 keys,
the shared keys, the setup token), adjust the file and install it the same
way. The pods start once the schema Job has run.

`appUrl` is required: the address exactly as typed in the browser. Without
it the chart uses the first ingress host (https when TLS is configured) and
fails otherwise. With single sign-on, register `<appUrl>/api/auth/callback`
as redirect URI at the identity provider.

## Values

### General

| Value | Default | Meaning |
| --- | --- | --- |
| `image.repository` | `ghcr.io/yannicschuller/flowplan` | Image |
| `image.tag` | chart `appVersion` | Flowplan version (`0.9.9`, `0.9`, `latest`, `beta`) |
| `image.pullPolicy` | `IfNotPresent` | |
| `imagePullSecrets` | `[]` | |
| `nameOverride`, `fullnameOverride` | – | Names of the objects |
| `appUrl` | – | Public address (`APP_URL`) |
| `localLogin` | `true` | E-mail + password and passkeys (`FLOWPLAN_LOCAL_LOGIN`) |
| `setupToken.existingSecret`, `.key` | –, `FLOWPLAN_SETUP_TOKEN` | Your Secret with the setup token (recommended with Argo CD, Flux and other tools that render without access to the cluster) |
| `setupToken.generate` | `true` | Without `existingSecret`: the chart makes `<fullname>-setup` with a random token once, keeps it on upgrades (lookup) and on uninstall |
| `oidc.issuer`, `.clientId`, `.scopes`, `.groupsClaim`, `.adminGroup`, `.allowedGroup` | –, `flowplan`, `openid profile email groups`, `groups`, `flowplan-admins`, – | Single sign-on; the client secret as `OIDC_CLIENT_SECRET` in `existingSecret` |
| `smtp.host`, `.port`, `.user`, `.from` | –, `587`, –, – | E-mail; the password as `SMTP_PASSWORD` in `existingSecret` |
| `s3.bucket`, `.endpoint`, `.region`, `.prefix` | –, AWS, `us-east-1`, `flowplan` | Object storage |
| `s3.existingSecret`, `.accessKeyIdKey`, `.secretAccessKeyKey` | –, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The S3 keys (or put them into `existingSecret`) |
| `existingSecret` | – | A Secret whose keys become environment variables (`OIDC_CLIENT_SECRET`, `SMTP_PASSWORD`, `FLOWPLAN_ENCRYPTION_KEY`, `FLOWPLAN_METRICS_TOKEN`, …); wins over the plain settings |
| `env` | `{}` | Further settings from [.env.example](../../../.env.example) as `NAME: value` |
| `extraEnv`, `extraEnvFrom` | `[]` | Environment entries in Kubernetes form |

### One pod

| Value | Default | Meaning |
| --- | --- | --- |
| `persistence.enabled` | `true` | PVC for `/app/data` (kept on `helm uninstall`) |
| `persistence.existingClaim` | – | Use an existing PVC |
| `persistence.storageClass` | cluster default | `-` for none; a block or local volume (no NFS) |
| `persistence.accessModes` | `[ReadWriteOnce]` | |
| `persistence.size` | `10Gi` | |
| `persistence.annotations` | `{}` | |

### Cluster mode

| Value | Default | Meaning |
| --- | --- | --- |
| `cluster.enabled` | `false` | Several pods against PostgreSQL, Redis and S3 |
| `cluster.replicas` | `2` | Pods (one per ~25 people active at the same time, plus a spare) |
| `cluster.database.existingSecret`, `.key` | –, `DATABASE_URL` | Secret with the PostgreSQL address (required) |
| `cluster.database.schema` | – | PostgreSQL schema other than `public` (`FLOWPLAN_PG_SCHEMA`) |
| `cluster.database.sessionUrl.existingSecret`, `.key` | –, `DATABASE_SESSION_URL` | Behind PgBouncer in transaction mode: an address with sessions of their own (LISTEN, the leader lock, the schema step, pg_dump) |
| `cluster.redis.existingSecret`, `.key` | –, `REDIS_URL` | Secret with the Redis address (required) |
| `cluster.keys.existingSecret` | – | Secret with `FLOWPLAN_ENCRYPTION_KEY`, `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` (required; key names: `cluster.keys.encryptionKey`, `.webPushPublicKey`, `.webPushPrivateKey`) |
| `cluster.poolSize` | `10` | PostgreSQL connections per pod (`FLOWPLAN_PG_POOL`); keep `replicas × (poolSize + 3)` below `max_connections` |
| `cluster.readyRequire` | `database,objectStorage` | Which shared services decide readiness (`FLOWPLAN_READY_REQUIRE`); with `redis` in it, a Redis outage takes every pod out of the rotation |
| `cluster.preStopSeconds` | `5` | Pause before a pod stops (the load balancer catches up) |
| `cluster.cacheSizeLimit` | `5Gi` | The per-pod cache (`emptyDir`); imports are staged there too |
| `cluster.cacheMaxMb` | 70 % of `cacheSizeLimit` | Above this, the least used files leave the cache (`FLOWPLAN_CACHE_MAX_MB`) |
| `cluster.migration.enabled` | `true` | Schema Job (`pre-install`, `pre-upgrade`) |
| `cluster.migration.backoffLimit`, `.activeDeadlineSeconds`, `.resources` | `3`, `900`, 100m/256Mi | |
| `cluster.podDisruptionBudget.enabled`, `.minAvailable` | `true`, `1` | With 2+ replicas |
| `cluster.spreadOverNodes` | `true` | Topology spread over nodes (preferred) |

### Network, security, resources

| Value | Default | Meaning |
| --- | --- | --- |
| `service.type`, `.port`, `.annotations` | `ClusterIP`, `80`, `{}` | |
| `ingress.enabled` | `false` | Ingress (`networking.k8s.io/v1`) |
| `ingress.className` | – | e.g. `nginx` |
| `ingress.nginxDefaults` | `true` | ingress-nginx annotations: `proxy-buffering: "off"`, `proxy-request-buffering: "off"`, `proxy-read-timeout`/`proxy-send-timeout: "3600"`, `proxy-body-size` |
| `ingress.bodySize` | `110m` | Request body limit (uploads; raise for large imports, e.g. `2g`) |
| `ingress.annotations` | `{}` | Further annotations; win over the defaults |
| `ingress.hosts`, `ingress.tls` | `flowplan.example.org`, `[]` | |
| `serviceAccount.create`, `.name`, `.annotations`, `.automount` | `true`, –, `{}`, `false` | Flowplan does not use the Kubernetes API |
| `podAnnotations`, `podLabels` | `{}` | |
| `podSecurityContext` | uid/gid 1000, non-root, `RuntimeDefault` seccomp | The image's user `node` (`USER 1000:1000`) |
| `securityContext` | no privilege escalation, no capabilities, read-only root | |
| `scratch.tmpSizeLimit`, `.nextCacheSizeLimit`, `.homeSizeLimit` | `2Gi`, `512Mi`, `64Mi` | `emptyDir`s for `/tmp`, `/app/.next/cache` and `/home/node` (the read-only root's writable places) |
| `resources` | requests 1 CPU / 2Gi, limit 4Gi memory | From the sizing guide; no CPU limit (throttling slows live editing) |
| `startupProbe`, `livenessProbe`, `readinessProbe` | on | One pod: `/api/health`. Cluster: `/api/health/live` (startup, liveness) and `/api/health/ready` (readiness: opening steps and schema done, database, `readyRequire`) |
| `terminationGracePeriodSeconds` | `30` | The graceful stop; Flowplan uses this less `preStopSeconds` and 5 s (`FLOWPLAN_SHUTDOWN_SECONDS`) |
| `nodeSelector`, `tolerations`, `affinity` | – | |

### Monitoring and network policy

| Value | Default | Meaning |
| --- | --- | --- |
| `metrics.tokenSecret.name`, `.key` | `existingSecret`, `FLOWPLAN_METRICS_TOKEN` | The Secret with the metrics token (at least 16 characters) |
| `metrics.serviceMonitor.enabled` | `false` | A `ServiceMonitor` (Prometheus Operator) for every pod |
| `metrics.serviceMonitor.interval`, `.scrapeTimeout`, `.labels` | `30s`, `10s`, `{}` | e.g. `release: prometheus` for the operator's selector |
| `networkPolicy.enabled` | `false` | Incoming traffic only on the HTTP port, from `ingressFrom` |
| `networkPolicy.ingressFrom` | the namespace `ingress-nginx` | NetworkPolicyPeers (add Prometheus' namespace with the ServiceMonitor) |
| `networkPolicy.restrictEgress`, `.egress` | `false`, `[]` | Outgoing traffic only to DNS and these rules (PostgreSQL, Redis, S3, SMTP, the OIDC provider …) |

The values are checked by [`values.schema.json`](values.schema.json): a
misspelled key or a secret value (`oidc.clientSecret`, `smtp.password`,
`s3.secretAccessKey`, `encryptionKey` of chart 0.2) is refused with the
key's name.

## Metrics

Every pod is scraped on its own. Its process figures (memory, CPU,
connections of its pool, open live streams, uploads in flight, security
events counted in memory, uptime, version) carry `instance_id` (the pod
name); the installation's figures read from the database (pages, files,
queues, workspaces …) only the leader reports, so `sum()` over the pods
counts them once. `flowplan_metrics_shared` (1 on the leader) and
`flowplan_leader` tell which pod that is.

## Other ingress controllers

`ingress.nginxDefaults` only concerns ingress-nginx; others ignore the
annotations. What they need instead:

- **Traefik:** does not buffer by default. Raise the entry point's
  `respondingTimeouts.readTimeout`/`writeTimeout` (static configuration)
  above an hour or to `0`, and the body limit with a `buffering`
  middleware only if you use one.
- **HAProxy Ingress:** `timeout-server` and `timeout-tunnel` of `3600s`
  (annotations `haproxy.org/timeout-server`, `haproxy.org/timeout-tunnel`).
- **Cloud load balancers:** GKE – a `BackendConfig` with `timeoutSec: 3600`;
  AWS ALB – `alb.ingress.kubernetes.io/load-balancer-attributes:
  idle_timeout.timeout_seconds=3600`; Azure Application Gateway –
  `appgw.ingress.kubernetes.io/request-timeout: "3600"`.

Without long timeouts the live streams are cut and reconnect every few
seconds – editing still works, with more requests.

## Not provided

On purpose, the chart does **not** include: PostgreSQL, Redis or MinIO
subcharts or operators (CloudNativePG, Zalando …), a HorizontalPodAutoscaler
(scale with `cluster.replicas`; sessions are short requests and long
streams, CPU is a poor signal), or separate worker pods (every pod serves
requests and claims queue jobs; the leader runs the timed ones).

## Upgrading from chart 0.2

- Secret values are no longer accepted: move `oidc.clientSecret`,
  `smtp.password`, `s3.accessKeyId`, `s3.secretAccessKey` and
  `encryptionKey` into `existingSecret` (or `s3.existingSecret`). The
  Secret named like the release is no longer made; `setupToken` is an
  object now (`setupToken.existingSecret`), and an existing generated token
  is carried over into `<fullname>-setup`.
- The root file system is read-only (`/tmp`, `/app/.next/cache` and
  `/home/node` are `emptyDir`s); the image needs Flowplan 0.9.9 or newer.
- Resources follow the sizing guide (1 CPU, 2 GiB requested) – set
  `resources` for smaller clusters.
- The schema Job no longer switches off the pods' own schema check
  (`FLOWPLAN_PG_SCHEMA_AUTO`); it stays as a safety net under the same lock.
- `cluster.readyRequire` defaults to `database,objectStorage`.

## Develop

```sh
helm lint --strict deploy/helm/flowplan -f deploy/helm/flowplan/values-small.yaml
helm lint --strict deploy/helm/flowplan -f deploy/helm/flowplan/values-ha.yaml
helm template flowplan deploy/helm/flowplan -f deploy/helm/flowplan/values-ha.yaml | kubeconform -strict -summary
```

CI does the same with pinned versions (`.github/workflows/helm.yml`).
