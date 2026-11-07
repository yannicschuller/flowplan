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

{{/* FLOWPLAN_SETUP_TOKEN: from the values, else the one the chart's Secret
already holds (stable across upgrades), else a new random one. Only with
password sign-in (localLogin). */}}
{{- define "flowplan.setupToken" -}}
{{- if .Values.setupToken }}
{{- .Values.setupToken }}
{{- else if .Values.localLogin }}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "flowplan.fullname" .) }}
{{- $data := (get (default dict $existing) "data") | default dict }}
{{- if hasKey $data "FLOWPLAN_SETUP_TOKEN" }}
{{- index $data "FLOWPLAN_SETUP_TOKEN" | b64dec }}
{{- else }}
{{- randAlphaNum 40 }}
{{- end }}
{{- end }}
{{- end }}

{{/* Secret values given in values.yaml (empty ones are left out). */}}
{{- define "flowplan.secretEnv" -}}
{{- $secrets := dict
  "OIDC_CLIENT_SECRET" .Values.oidc.clientSecret
  "SMTP_PASSWORD" .Values.smtp.password
  "S3_ACCESS_KEY_ID" .Values.s3.accessKeyId
  "S3_SECRET_ACCESS_KEY" .Values.s3.secretAccessKey
  "FLOWPLAN_ENCRYPTION_KEY" .Values.encryptionKey
  "FLOWPLAN_SETUP_TOKEN" (include "flowplan.setupToken" .)
}}
{{- range $key, $value := $secrets }}
{{- if $value }}
{{ $key }}: {{ $value | toString | b64enc | quote }}
{{- end }}
{{- end }}
{{- end }}

{{- define "flowplan.hasSecretEnv" -}}
{{- if or .Values.oidc.clientSecret .Values.smtp.password .Values.s3.accessKeyId .Values.s3.secretAccessKey .Values.encryptionKey .Values.setupToken .Values.localLogin }}true{{- end }}
{{- end }}

{{/* Cluster mode needs its three services; fails the render with what is
missing. */}}
{{- define "flowplan.clusterCheck" -}}
{{- if .Values.cluster.enabled }}
{{- if not .Values.cluster.database.existingSecret }}
{{- fail "cluster.enabled: set cluster.database.existingSecret (a Secret with DATABASE_URL=postgres://…)." }}
{{- end }}
{{- if not .Values.cluster.redis.existingSecret }}
{{- fail "cluster.enabled: set cluster.redis.existingSecret (a Secret with REDIS_URL=redis://…)." }}
{{- end }}
{{- if not .Values.s3.bucket }}
{{- fail "cluster.enabled: set s3.bucket (and S3 credentials, best in existingSecret) – files must live in object storage." }}
{{- end }}
{{- if lt (int .Values.cluster.replicas) 1 }}
{{- fail "cluster.replicas must be at least 1." }}
{{- end }}
{{- end }}
{{- end }}

{{/* The environment cluster mode adds to the pods (and the migration Job). */}}
{{- define "flowplan.clusterEnv" -}}
- name: FLOWPLAN_CLUSTER
  value: "1"
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cluster.database.existingSecret }}
      key: {{ .Values.cluster.database.key }}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cluster.redis.existingSecret }}
      key: {{ .Values.cluster.redis.key }}
- name: FLOWPLAN_PG_POOL
  value: {{ .Values.cluster.poolSize | toString | quote }}
{{- if .Values.cluster.migration.enabled }}
- name: FLOWPLAN_PG_SCHEMA_AUTO
  value: "off"
{{- end }}
{{- end }}

{{- define "flowplan.claimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "flowplan.fullname" .)) }}
{{- end }}
