#!/bin/sh
# Flowplan container start. Applies a pending instance restore, then runs the
# app. With S3_BUCKET set, Litestream first restores the database from the
# bucket when none exists yet and then replicates every change to it.
set -eu
DATA="${FLOWPLAN_DATA_DIR:-/app/data}"
DB="$DATA/flowplan.sqlite"
mkdir -p "$DATA"

# Same swap as lib/instance-restore-apply.ts, but before Litestream opens the
# database. The previous state stays in pre-restore-<time>.
if [ -f "$DATA/restore-pending/READY" ]; then
  previous="$DATA/pre-restore-$(date -u +%Y-%m-%dT%H-%M-%S)"
  mkdir -p "$previous"
  for name in flowplan.sqlite flowplan.sqlite-wal flowplan.sqlite-shm .flowplan.sqlite-litestream uploads; do
    if [ -e "$DATA/$name" ]; then mv "$DATA/$name" "$previous/$name"; fi
  done
  mv "$DATA/restore-pending/flowplan.sqlite" "$DB"
  if [ -d "$DATA/restore-pending/uploads" ]; then
    mv "$DATA/restore-pending/uploads" "$DATA/uploads"
  else
    mkdir -p "$DATA/uploads"
  fi
  rm -rf "$DATA/restore-pending" "$DATA/tmp"
  # The file storage uploads every restored file again.
  touch "$DATA/storage-resync"
  echo "Instanz wiederhergestellt; vorheriger Stand in $previous"
fi

if [ -n "${S3_BUCKET:-}" ] && [ "${FLOWPLAN_LITESTREAM:-on}" != "off" ]; then
  S3_REGION="${S3_REGION:-us-east-1}"
  S3_ENDPOINT="${S3_ENDPOINT:-https://s3.$S3_REGION.amazonaws.com}"
  S3_PREFIX="${S3_PREFIX-flowplan}"
  FLOWPLAN_DB="$DB"
  # Optional: the provider encrypts the replica (SSE-C, needs https and a
  # provider that supports it). Litestream 0.5 cannot encrypt by itself.
  LITESTREAM_SSE_C_KEY="${LITESTREAM_SSE_C_KEY:-}"
  FLOWPLAN_LITESTREAM_ACTIVE=1
  FLOWPLAN_LITESTREAM_SSE_C=0
  if [ -n "$LITESTREAM_SSE_C_KEY" ]; then FLOWPLAN_LITESTREAM_SSE_C=1; fi
  export S3_REGION S3_ENDPOINT S3_PREFIX FLOWPLAN_DB LITESTREAM_SSE_C_KEY FLOWPLAN_LITESTREAM_ACTIVE FLOWPLAN_LITESTREAM_SSE_C
  if { [ -n "${FLOWPLAN_ENCRYPTION_KEY:-}" ] || [ -n "${FLOWPLAN_ENCRYPTION_KEY_FILE:-}" ]; } && [ "$FLOWPLAN_LITESTREAM_SSE_C" = 0 ]; then
    echo "Hinweis: Litestream legt die Datenbank unverschlüsselt in den Bucket. FLOWPLAN_LITESTREAM=off und stündliche verschlüsselte Sicherungen vermeiden das (siehe Doku)."
  fi
  litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DB"
  exec litestream replicate -config /etc/litestream.yml -exec "node server.js"
fi
exec node server.js
