#!/bin/sh
# Flowplan container start. Applies a pending instance restore, then runs the
# app. With S3_BUCKET set, Litestream first restores the database from the
# bucket when none exists yet and then replicates every change to it.
set -eu
DATA="${FLOWPLAN_DATA_DIR:-/app/data}"

# Who runs Flowplan (#193), like the linuxserver.io images: the image starts
# as root, and before anything else (restore, move, Litestream, node) the
# entrypoint gives the data folder to PUID:PGID (default 1000:1000, the user
# node) if it belongs to someone else, and runs itself again as that user
# with setpriv: the app never runs as root, PUID/PGID 0 are refused. PGID
# defaults to PUID. Started as another user instead (Compose's user:
# "UID:GID", docker run --user, Kubernetes' runAsUser), also one without an
# entry in /etc/passwd, it runs as that user and changes no owner.
valid_id() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 10 ] && [ "$1" -gt 0 ] && [ "$1" -lt 4294967295 ]
}
if [ -n "${PUID:-}${PGID:-}" ]; then
  if ! { valid_id "${PUID:-1000}" && valid_id "${PGID:-${PUID:-1000}}"; }; then
    echo "PUID and PGID must be numeric user and group IDs other than 0 (PUID=${PUID:-}, PGID=${PGID:-})." >&2
    exit 1
  fi
fi
if [ "$(id -u)" = 0 ]; then
  uid="${PUID:-1000}"
  gid="${PGID:-${PUID:-1000}}"
  mkdir -p "$DATA"
  # Only when an owner differs – the folder itself or anything directly in
  # it: no recursive chown on every start. Whatever a command run as root
  # left there (docker exec, docker compose run: a staged move or restore,
  # a database restored by hand, a folder set aside) is handed over too.
  owned=yes
  for path in "$DATA" "$DATA"/* "$DATA"/.[!.]*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    if [ "$(stat -c %u:%g "$path")" != "$uid:$gid" ]; then owned=; break; fi
  done
  if [ -z "$owned" ]; then
    echo "Giving the data folder $DATA to UID $uid, GID $gid."
    chown -R "$uid:$gid" "$DATA" || echo "Could not change the owner of $DATA." >&2
  fi
  if [ "$uid" = 1000 ]; then HOME=/home/node; else HOME=/tmp; fi
  export HOME
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$0" "$@"
fi
if [ -n "${PUID:-}${PGID:-}" ] && [ "${PUID:-1000}:${PGID:-${PUID:-1000}}" != "$(id -u):$(id -g)" ]; then
  echo "PUID/PGID are ignored: the container was started as UID $(id -u), GID $(id -g) (user:, --user or runAsUser). PUID/PGID need the image's default start: remove user:, or set only user: \"${PUID:-1000}:${PGID:-${PUID:-1000}}\"." >&2
fi
# A user without a home of its own (user: "UID:GID" with no passwd entry
# gets HOME=/): anything that writes below HOME writes to /tmp.
if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then
  HOME=/tmp
  export HOME
fi

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
DB="$DATA/flowplan.sqlite"
mkdir -p "$DATA" 2>/dev/null || true
# A host folder mounted as the data directory must belong to the user
# Flowplan runs as; otherwise SQLite fails over and over with "unable to
# open database file". Say so once and stop instead.
if ! { [ -d "$DATA" ] && [ -w "$DATA" ] && touch "$DATA/.write-test" 2>/dev/null && rm -f "$DATA/.write-test"; }; then
  owner="$(stat -c %u:%g "$DATA" 2>/dev/null || echo "UID:GID")"
  echo "Flowplan cannot write to its data folder $DATA (running as UID $(id -u), GID $(id -g); the folder belongs to $owner)." >&2
  echo "Either run Flowplan as the folder's owner: user: \"$owner\" in Compose (docker run --user $owner)," >&2
  echo "or let Flowplan take the folder: PUID and PGID without user: (it then runs as that user, never as root)," >&2
  echo "or give the folder to UID 1000: sudo chown -R 1000:1000 /path/to/flowplan-data, or use a named Docker volume." >&2
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
