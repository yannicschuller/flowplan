# Flowplan Helm chart

Runs [Flowplan](https://flowplan.org) on Kubernetes: one pod with the image
`ghcr.io/yannicschuller/flowplan`, a PersistentVolumeClaim for `/app/data`
(SQLite database, uploads, keys), a Service and an optional Ingress.

Flowplan keeps its data in SQLite, so the chart always runs **exactly one
replica** with the update strategy **Recreate**: the old pod stops before the
new one starts. Updates have a short downtime; scaling out is not possible.
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
  `existingSecret`) and scrape `/api/metrics` with that bearer token.

## Develop

```sh
helm lint deploy/helm/flowplan --set appUrl=https://flowplan.example.org
helm template flowplan deploy/helm/flowplan --set appUrl=https://flowplan.example.org
```
