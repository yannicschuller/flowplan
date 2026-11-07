# Flowplan Helm chart

Runs [Flowplan](https://flowplan.org) on Kubernetes: one pod with the image
`ghcr.io/yannicschuller/flowplan`, a PersistentVolumeClaim for `/app/data`
(SQLite database, uploads, keys), a Service and an optional Ingress.

By default Flowplan keeps its data in SQLite, so the chart runs **exactly
one replica** with the update strategy **Recreate**: the old pod stops before
the new one starts. Updates have a short downtime. To scale out, use
**cluster mode** (below): several pods against PostgreSQL, Redis and S3.
For backups and moving between nodes, use the S3 settings (files mirrored,
database replicated with Litestream) and/or the scheduled backups in the
administration.

## Install

The chart lives in the repository (it is not published to a chart repository
yet):

```sh
git clone https://github.com/yannicschuller/flowplan.git
cd flowplan

# Secrets in a Secret of their own (keys are environment variables)
kubectl create namespace flowplan
kubectl -n flowplan create secret generic flowplan-env \
  --from-literal=FLOWPLAN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=OIDC_CLIENT_SECRET=change-me

helm install flowplan deploy/helm/flowplan -n flowplan \
  --set appUrl=https://flowplan.example.org \
  --set existingSecret=flowplan-env \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=flowplan.example.org' \
  --set 'ingress.hosts[0].paths[0].path=/' \
  --set 'ingress.tls[0].secretName=flowplan-tls' \
  --set 'ingress.tls[0].hosts[0]=flowplan.example.org'

helm test flowplan -n flowplan

# The first account (administrator) is created with the setup link:
echo "https://flowplan.example.org/register?setup=$(kubectl -n flowplan get secret flowplan \
  -o jsonpath='{.data.FLOWPLAN_SETUP_TOKEN}' | base64 -d)"
```

Or keep the settings in a file (`helm install flowplan deploy/helm/flowplan -f my-values.yaml`):

```yaml
appUrl: https://flowplan.example.org
existingSecret: flowplan-env
oidc:
  issuer: https://id.example.org/realms/company
  clientId: flowplan
  adminGroup: flowplan-admins
smtp:
  host: smtp.example.org
  user: flowplan
  from: "Flowplan <flowplan@example.org>"
s3:
  bucket: flowplan
  endpoint: https://s3.example.org
env:
  SESSION_HOURS: "8"
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    # Imports and archives may be up to 100 MB.
    nginx.ingress.kubernetes.io/proxy-body-size: 110m
  hosts:
    - host: flowplan.example.org
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: flowplan-tls
      hosts:
        - flowplan.example.org
persistence:
  size: 20Gi
```

`appUrl` is required: the address exactly as typed in the browser. Without it
the chart uses the first ingress host (https when TLS is configured) and
fails otherwise. With single sign-on, register
`<appUrl>/api/auth/callback` as redirect URI at the identity provider.

## Cluster mode (several pods)

With `cluster.enabled=true` the chart runs `cluster.replicas` pods (rolling
updates, a PodDisruptionBudget, pods spread over nodes) against
**PostgreSQL**, **Redis** and **S3 object storage** – all three required;
a pod refuses to start without one, and the chart refuses to render. The
chart creates none of them: use managed services or their own charts, and
pass the connection strings as references to a Secret you create (the
chart never holds them):

```sh
kubectl -n flowplan create secret generic flowplan-cluster \
  --from-literal=DATABASE_URL='postgres://flowplan:…@postgres:5432/flowplan' \
  --from-literal=REDIS_URL='redis://:…@redis-master:6379/0'
kubectl -n flowplan create secret generic flowplan-env \
  --from-literal=S3_ACCESS_KEY_ID=… --from-literal=S3_SECRET_ACCESS_KEY=… \
  --from-literal=FLOWPLAN_ENCRYPTION_KEY="$(openssl rand -base64 32)"

helm install flowplan deploy/helm/flowplan -n flowplan \
  --set appUrl=https://flowplan.example.org \
  --set existingSecret=flowplan-env \
  --set cluster.enabled=true \
  --set cluster.replicas=3 \
  --set cluster.database.existingSecret=flowplan-cluster \
  --set cluster.redis.existingSecret=flowplan-cluster \
  --set s3.bucket=flowplan --set s3.endpoint=https://s3.example.org
```

- **Schema:** a Job (`pre-install`/`pre-upgrade` hook) runs
  `node /app/db-schema.mjs` before the pods of a new version start – it
  adds what the version needs and never drops anything. Without it
  (`cluster.migration.enabled=false`) the pods apply it at their first
  start, one after the other.
- **Probes:** liveness on `/api/health/live`, readiness on
  `/api/health/ready` (database, Redis, bucket; 503 while a pod stops, after
  which it waits `cluster.preStopSeconds` before Next.js closes).
- **No volume:** `/app/data` is a per-pod cache (`emptyDir`,
  `cluster.cacheSizeLimit`); files live in the bucket, backups are
  PostgreSQL's (no Litestream).
- **Connections:** each pod opens up to `cluster.poolSize` connections plus
  two of its own (leader election, notifications); keep
  `replicas × (poolSize + 2)` below the server's `max_connections`.
- **Ingress:** live editing keeps server-sent event streams open; with
  ingress-nginx set `nginx.ingress.kubernetes.io/proxy-buffering: "off"`
  and `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"`. No sticky
  sessions are needed.
- Administration → Monitoring → System lists the pods, the leader, the
  pool of each pod and the shared queues.

## Settings

| Value | Default | Meaning |
| --- | --- | --- |
| `image.repository` | `ghcr.io/yannicschuller/flowplan` | Image |
| `image.tag` | chart `appVersion` | Flowplan version (`0.4.2`, `0.4`, `latest`, `beta`) |
| `appUrl` | – | Public address (`APP_URL`) |
| `localLogin` | `true` | E-mail + password and passkeys (`FLOWPLAN_LOCAL_LOGIN`) |
| `oidc.*` | – | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `OIDC_GROUPS_CLAIM`, `OIDC_ADMIN_GROUP`, `OIDC_ALLOWED_GROUP` |
| `smtp.*` | – | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` |
| `s3.*` | – | `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_PREFIX`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| `encryptionKey` | – | `FLOWPLAN_ENCRYPTION_KEY` |
| `setupToken` | generated | `FLOWPLAN_SETUP_TOKEN`: the first account only via `<appUrl>/register?setup=<token>`. Empty: a random token, kept across upgrades (with `localLogin`) |
| `existingSecret` | – | Secret whose keys are environment variables; wins over the values above |
| `env` | `{}` | Further settings from [.env.example](../../../.env.example) as `NAME: value` |
| `extraEnv`, `extraEnvFrom` | `[]` | Environment entries in Kubernetes form |
| `persistence.enabled` | `true` | PVC for `/app/data` (kept on `helm uninstall`) |
| `persistence.existingClaim` | – | Use an existing PVC |
| `persistence.storageClass` | cluster default | `-` for none |
| `persistence.size` | `10Gi` | Size of the volume |
| `service.type`, `service.port` | `ClusterIP`, `80` | Service |
| `ingress.*` | disabled | Ingress (`networking.k8s.io/v1`) |
| `resources` | 100m / 256Mi, limit 1Gi | Requests and limits |
| `podSecurityContext`, `securityContext` | uid/gid 1000, no privileges | As in the image (user `node`) |
| `startupProbe`, `livenessProbe`, `readinessProbe` | on | HTTP checks on `/api/health` |
| `cluster.enabled` | `false` | Cluster mode (above) instead of one pod with SQLite |
| `cluster.replicas` | `2` | Pods in cluster mode |
| `cluster.database.existingSecret`, `.key` | –, `DATABASE_URL` | Secret holding the PostgreSQL URL (required in cluster mode) |
| `cluster.redis.existingSecret`, `.key` | –, `REDIS_URL` | Secret holding the Redis URL (required in cluster mode) |
| `cluster.poolSize` | `10` | PostgreSQL connections per pod (`FLOWPLAN_PG_POOL`) |
| `cluster.migration.enabled` | `true` | Schema Job before install/upgrade |
| `cluster.podDisruptionBudget.minAvailable` | `1` | PodDisruptionBudget (with 2+ replicas) |
| `cluster.preStopSeconds` | `5` | Pause before a pod stops (load balancer catches up) |

Secret values given directly (`oidc.clientSecret`, `smtp.password`,
`s3.accessKeyId`, `s3.secretAccessKey`, `encryptionKey`) end up in a Secret
created by the chart. Prefer `existingSecret`, so they stay out of values
files and the Helm release history.

## Notes

- **Storage:** use a block or local volume (`ReadWriteOnce`). SQLite on
  network file systems such as NFS can corrupt the database.
- **Reverse proxy:** Flowplan trusts one proxy in front by default
  (`FLOWPLAN_TRUSTED_PROXIES=1`, for the client address in rate limits). Set
  it in `env` when there are more (e.g. a load balancer in front of the
  ingress controller).
- **Updates:** `helm upgrade` with a new `image.tag` (or a newer chart).
  The pod is replaced; the database is migrated on start.
- **Metrics:** set `FLOWPLAN_METRICS_TOKEN` (at least 16 characters, best in
  `existingSecret`) and scrape `/api/metrics` with that bearer token. The
  same token unlocks the details of `/api/health`; the probes only need its
  status code.

## Develop

```sh
helm lint deploy/helm/flowplan --set appUrl=https://flowplan.example.org
helm template flowplan deploy/helm/flowplan --set appUrl=https://flowplan.example.org
```
