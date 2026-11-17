{{/* Chart name, possibly overridden. */}}
{{- define "flowplan.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name (release-chart, at most 63 characters). */}}
{{- define "flowplan.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "flowplan.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Labels of every object. Only the Deployment's pods carry the selector
labels: the Service, the PodDisruptionBudget and the spread constraint
select by them, so the migration Job's and the test's pods must not (they
use flowplan.otherPodLabels). */}}
{{- define "flowplan.labels" -}}
helm.sh/chart: {{ include "flowplan.chart" . }}
{{ include "flowplan.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "flowplan.selectorLabels" -}}
app.kubernetes.io/name: {{ include "flowplan.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Pods that are not Flowplan servers (schema Job, helm test): their own
app.kubernetes.io/name, so no selector of the chart matches them. Call with
(dict "root" $ "component" "schema"). */}}
{{- define "flowplan.otherPodLabels" -}}
helm.sh/chart: {{ include "flowplan.chart" .root }}
app.kubernetes.io/name: {{ printf "%s-%s" (include "flowplan.name" .root) .component | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: {{ include "flowplan.name" .root }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end }}

{{- define "flowplan.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "flowplan.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "flowplan.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion | toString) }}
{{- end }}

{{/* APP_URL: set explicitly, or derived from the first ingress host. */}}
{{- define "flowplan.appUrl" -}}
{{- if .Values.appUrl }}
{{- .Values.appUrl | trimSuffix "/" }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- $host := (first .Values.ingress.hosts).host }}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) $host }}
{{- else }}
{{- fail "Set appUrl to Flowplan's public address (e.g. https://flowplan.example.org) or enable the ingress with a host." }}
{{- end }}
{{- end }}

{{/* The Secret holding FLOWPLAN_SETUP_TOKEN: the one named in
setupToken.existingSecret, else the chart's own (generated once). */}}
{{- define "flowplan.setupTokenSecret" -}}
{{- .Values.setupToken.existingSecret | default (printf "%s-setup" (include "flowplan.fullname" .)) }}
{{- end }}
{{- define "flowplan.setupTokenKey" -}}
{{- ternary .Values.setupToken.key "FLOWPLAN_SETUP_TOKEN" (not (empty .Values.setupToken.existingSecret)) }}
{{- end }}
{{/* Whether the chart makes the setup token's Secret itself. */}}
{{- define "flowplan.generatesSetupToken" -}}
{{- if and .Values.localLogin (not .Values.setupToken.existingSecret) .Values.setupToken.generate }}true{{- end }}
{{- end }}

{{/* The generated token: the one the Secret already holds (stable across
upgrades), else a new random one. Without access to the cluster (helm
template, GitOps tools that render offline) lookup finds nothing and every
render makes a new one – use setupToken.existingSecret there. */}}
{{- define "flowplan.generatedSetupToken" -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "flowplan.setupTokenSecret" .) }}
{{- $data := (get (default dict $existing) "data") | default dict }}
{{- /* Chart 0.2 kept it in the Secret named like the release. */}}
{{- $old := lookup "v1" "Secret" .Release.Namespace (include "flowplan.fullname" .) }}
{{- $oldData := (get (default dict $old) "data") | default dict }}
{{- if hasKey $data "FLOWPLAN_SETUP_TOKEN" }}
{{- index $data "FLOWPLAN_SETUP_TOKEN" | b64dec }}
{{- else if hasKey $oldData "FLOWPLAN_SETUP_TOKEN" }}
{{- index $oldData "FLOWPLAN_SETUP_TOKEN" | b64dec }}
{{- else }}
{{- randAlphaNum 40 }}
{{- end }}
{{- end }}

{{/* Checks before anything renders: what cluster mode needs, and settings
that only work together. Fails with what to change. */}}
{{- define "flowplan.check" -}}
{{- if .Values.cluster.enabled }}
{{- if not .Values.cluster.database.existingSecret }}
{{- fail "cluster.enabled: set cluster.database.existingSecret (a Secret with DATABASE_URL=postgres://…)." }}
{{- end }}
{{- if not .Values.cluster.redis.existingSecret }}
{{- fail "cluster.enabled: set cluster.redis.existingSecret (a Secret with REDIS_URL=redis://…)." }}
{{- end }}
{{- if not .Values.s3.bucket }}
{{- fail "cluster.enabled: set s3.bucket (and the S3 keys: s3.existingSecret or existingSecret) – files must live in object storage." }}
{{- end }}
{{- if not .Values.cluster.keys.existingSecret }}
{{- fail "cluster.enabled: set cluster.keys.existingSecret (a Secret with FLOWPLAN_ENCRYPTION_KEY, WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY) – every pod needs the same keys." }}
{{- end }}
{{- if lt (int .Values.cluster.replicas) 1 }}
{{- fail "cluster.replicas must be at least 1." }}
{{- end }}
{{- end }}
{{- if and .Values.metrics.serviceMonitor.enabled (not (include "flowplan.metricsSecret" .)) }}
{{- fail "metrics.serviceMonitor.enabled: set metrics.tokenSecret.name (or existingSecret) – the Secret whose FLOWPLAN_METRICS_TOKEN Prometheus sends." }}
{{- end }}
{{- if lt (int .Values.terminationGracePeriodSeconds) (add (int .Values.cluster.preStopSeconds) 10 | int) }}
{{- fail "terminationGracePeriodSeconds must leave at least 10 s after cluster.preStopSeconds for the graceful shutdown." }}
{{- end }}
{{- end }}

{{/* FLOWPLAN_SHUTDOWN_SECONDS: the grace period less the preStop pause and
a margin, so Flowplan ends before Kubernetes kills it. */}}
{{- define "flowplan.shutdownSeconds" -}}
{{- $pause := ternary (int .Values.cluster.preStopSeconds) 0 .Values.cluster.enabled }}
{{- max 5 (sub (sub (int .Values.terminationGracePeriodSeconds) $pause) 5) }}
{{- end }}

{{/* FLOWPLAN_CACHE_MAX_MB: cluster.cacheMaxMb, else 70 % of
cluster.cacheSizeLimit (Gi or Mi), so the cache is pruned before the
emptyDir's limit evicts the pod. */}}
{{- define "flowplan.cacheMaxMb" -}}
{{- if .Values.cluster.cacheMaxMb }}
{{- .Values.cluster.cacheMaxMb | int }}
{{- else }}
{{- $limit := toString .Values.cluster.cacheSizeLimit }}
{{- if hasSuffix "Gi" $limit }}
{{- div (mul (trimSuffix "Gi" $limit | int) 1024 7) 10 }}
{{- else if hasSuffix "Mi" $limit }}
{{- div (mul (trimSuffix "Mi" $limit | int) 7) 10 }}
{{- else }}
{{- fail "cluster.cacheSizeLimit in Gi or Mi (e.g. 5Gi), or set cluster.cacheMaxMb." }}
{{- end }}
{{- end }}
{{- end }}

{{/* The Secret and key with FLOWPLAN_METRICS_TOKEN ("" when none). */}}
{{- define "flowplan.metricsSecret" -}}
{{- .Values.metrics.tokenSecret.name | default .Values.existingSecret }}
{{- end }}

{{/* The environment cluster mode adds to the pods. */}}
{{- define "flowplan.clusterEnv" -}}
- name: FLOWPLAN_CLUSTER
  value: "1"
{{ include "flowplan.databaseEnv" . }}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cluster.redis.existingSecret }}
      key: {{ .Values.cluster.redis.key }}
# The keys every pod shares: without them each pod generates its own
# (secrets.key, web-push-keys.json) and two-factor sign-in, stored secrets
# and push break between pods.
- name: FLOWPLAN_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cluster.keys.existingSecret }}
      key: {{ .Values.cluster.keys.encryptionKey }}
- name: WEB_PUSH_PUBLIC_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cluster.keys.existingSecret }}
      key: {{ .Values.cluster.keys.webPushPublicKey }}
- name: WEB_PUSH_PRIVATE_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cluster.keys.existingSecret }}
      key: {{ .Values.cluster.keys.webPushPrivateKey }}
- name: FLOWPLAN_PG_POOL
  value: {{ .Values.cluster.poolSize | toString | quote }}
# A Redis outage keeps the pods in the rotation (editing goes on; live
# updates between pods resume once Redis is back).
- name: FLOWPLAN_READY_REQUIRE
  value: {{ .Values.cluster.readyRequire | quote }}
- name: FLOWPLAN_CACHE_MAX_MB
  value: {{ include "flowplan.cacheMaxMb" . | quote }}
{{- end }}

{{/* PostgreSQL for the pods and the schema Job alike. */}}
{{- define "flowplan.databaseEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cluster.database.existingSecret }}
      key: {{ .Values.cluster.database.key }}
{{- with .Values.cluster.database.sessionUrl }}
{{- if .existingSecret }}
# LISTEN, the leader's lock and pg_dump need a session of their own (behind
# PgBouncer in transaction mode: the server itself).
- name: DATABASE_SESSION_URL
  valueFrom:
    secretKeyRef:
      name: {{ .existingSecret }}
      key: {{ .key }}
{{- end }}
{{- end }}
{{- with .Values.cluster.database.schema }}
- name: FLOWPLAN_PG_SCHEMA
  value: {{ . | quote }}
{{- end }}
{{- end }}

{{/* S3 keys as references (s3.existingSecret). */}}
{{- define "flowplan.s3Env" -}}
{{- with .Values.s3.existingSecret }}
- name: S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: {{ $.Values.s3.accessKeyIdKey }}
- name: S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: {{ $.Values.s3.secretAccessKeyKey }}
{{- end }}
{{- end }}

{{- define "flowplan.claimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "flowplan.fullname" .)) }}
{{- end }}
