#!/bin/sh
# Flowplan container start. Applies a pending instance restore, then runs the
# app. With S3_BUCKET set, Litestream first restores the database from the
# bucket when none exists yet and then replicates every change to it.
set -eu
# Render (render.yaml) gives a web service its public onrender.com address
# (RENDER_EXTERNAL_URL, RENDER_EXTERNAL_HOSTNAME); a Blueprint cannot put it
# into APP_URL, so it stands in here until APP_URL is set (custom domain).
if [ -z "${APP_URL:-}" ]; then
  if [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
    APP_URL="$RENDER_EXTERNAL_URL"
    export APP_URL
  elif [ -n "${RENDER_EXTERNAL_HOSTNAME:-}" ]; then
    APP_URL="https://$RENDER_EXTERNAL_HOSTNAME"
    export APP_URL
  fi
fi
DATA="${FLOWPLAN_DATA_DIR:-/app/data}"
DB="$DATA/flowplan.sqlite"
mkdir -p "$DATA" 2>/dev/null || true
# The image runs as the user node (UID 1000). A host folder mounted as the
# data directory must belong to it; otherwise SQLite fails over and over with
# "unable to open database file". Say so once and stop instead.
if ! { [ -d "$DATA" ] && [ -w "$DATA" ] && touch "$DATA/.write-test" 2>/dev/null && rm -f "$DATA/.write-test"; }; then
  echo "Flowplan cannot write to its data folder $DATA (running as UID $(id -u), GID $(id -g))." >&2
  echo "A mounted host folder must belong to UID 1000, e.g.: sudo chown -R 1000:1000 /path/to/flowplan-data" >&2
  echo "Or use a named Docker volume, which gets the right owner automatically." >&2
  echo "See https://docs.flowplan.org/en/coolify-and-proxy#volume-permissions" >&2
  exit 1
fi

# Same swap as lib/instance-restore-apply.ts, but before Litestream opens the
# database. The previous state stays in pre-restore-<time>, after an
# instance move (Administration → Instanz umziehen, or /app/move.mjs) in
# pre-move-<time>; a move also brings the Web Push keys and secrets.key.
# With PostgreSQL (DATABASE_URL=postgres://…) the app loads a pending restore
# into the database itself when it opens it (lib/db-restore.ts).
case "${DATABASE_URL:-}" in
  postgres://* | postgresql://*) POSTGRES=1 ;;
  *) POSTGRES= ;;
esac
if [ -z "$POSTGRES" ] && [ -f "$DATA/restore-pending/READY" ] && [ ! -f "$DATA/restore-pending/flowplan.dump" ]; then
  kind=pre-restore
  if [ -f "$DATA/restore-pending/MOVE" ]; then kind=pre-move; fi
  previous="$DATA/$kind-$(date -u +%Y-%m-%dT%H-%M-%S)"
  mkdir -p "$previous"
  for name in flowplan.sqlite flowplan.sqlite-wal flowplan.sqlite-shm .flowplan.sqlite-litestream uploads; do
    if [ -e "$DATA/$name" ]; then mv "$DATA/$name" "$previous/$name"; fi
  done
  if [ "$kind" = pre-move ]; then
    for name in web-push-keys.json secrets.key; do
      if [ -e "$DATA/restore-pending/$name" ]; then
        if [ -e "$DATA/$name" ]; then mv "$DATA/$name" "$previous/$name"; fi
        mv "$DATA/restore-pending/$name" "$DATA/$name"
      fi
    done
  fi
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
  rm -rf "$DATA/move-incoming"
fi

# Litestream replicates the SQLite file: not with PostgreSQL (single
# container or cluster mode), whose backups are the database's own.
if [ -n "$POSTGRES" ]; then FLOWPLAN_LITESTREAM=off; fi

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
