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

{{/* Secret values given in values.yaml (empty ones are left out). */}}
{{- define "flowplan.secretEnv" -}}
{{- $secrets := dict
  "OIDC_CLIENT_SECRET" .Values.oidc.clientSecret
  "SMTP_PASSWORD" .Values.smtp.password
  "S3_ACCESS_KEY_ID" .Values.s3.accessKeyId
  "S3_SECRET_ACCESS_KEY" .Values.s3.secretAccessKey
  "FLOWPLAN_ENCRYPTION_KEY" .Values.encryptionKey
}}
{{- range $key, $value := $secrets }}
{{- if $value }}
{{ $key }}: {{ $value | toString | b64enc | quote }}
{{- end }}
{{- end }}
{{- end }}

{{- define "flowplan.hasSecretEnv" -}}
{{- if or .Values.oidc.clientSecret .Values.smtp.password .Values.s3.accessKeyId .Values.s3.secretAccessKey .Values.encryptionKey }}true{{- end }}
{{- end }}

{{- define "flowplan.claimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "flowplan.fullname" .)) }}
{{- end }}
