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
# Several Flowplan processes behind the one port (FLOWPLAN_PROCESSES, #383,
# docs/architecture/multi-process.md): processes.mjs supervises them; unset
# or 1 starts server.js itself, exactly as before.
app_main=server.js
# Uploads of several gigabytes take longer than Node.js's 5 minutes for a
# whole request: request-timeout.mjs sets FLOWPLAN_REQUEST_TIMEOUT instead.
node_flags=
if [ -f request-timeout.mjs ]; then node_flags="--import ./request-timeout.mjs"; fi
case "${FLOWPLAN_PROCESSES:-1}" in
  1 | "") ;;
  *) if [ -f processes.mjs ]; then app_main=processes.mjs; fi ;;
esac
# The app under `litestream replicate -exec` while Litestream's output is
# copied to the log file (ls_log_open below): the app writes to the
# container's own stdout/stderr again (kept on fds 3 and 4), not through
# Litestream's copy – it saves its own lines (lib/restarts/log-file.ts).
# After the user switch: Litestream already runs as that user.
if [ "${1:-}" = --exec-app ]; then
  if { true >&3 && true >&4; } 2> /dev/null; then exec node $node_flags "$app_main" >&3 2>&4 3>&- 4>&-; fi
  exec node $node_flags "$app_main"
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
LITESTREAM=

# Litestream's own output, also saved (redacted) in $DATA/logs/litestream.log
# (rotated at 1,000 lines or 1 MB to litestream.log.1) for the restart
# history (Administration → Überwachung → Neustarts, lib/restarts/). The
# container's log keeps every line as before. Litestream writes to a FIFO;
# `tee -p` copies each chunk at once to the container's stdout and to awk,
# which masks secrets (values of variables named *TOKEN*, *SECRET*,
# *PASSWORD*, *KEY*, bearer tokens, URL credentials, key=value secrets),
# e-mail and IP addresses, adds the time and rotates. Both ignore TERM,
# INT, HUP and PIPE and end when Litestream closes its output; when awk
# fails (a full disk) only the file stops, tee goes on. Litestream starts
# with SIGPIPE ignored, so a copy that is gone never ends it. PID 1, the
# signals and the exit code stay Litestream's (exec path) or the shell's
# (supervise). Nothing of this when FLOWPLAN_LOG_FILE=off, $DATA/logs is
# not writable, or awk, mkfifo, tee -p or /dev/fd are missing.
# Limit: on the exec path Litestream is PID 1; when it exits, the kernel
# ends the copying processes with it, so its very last line at a stop can
# miss the file (and, rarely, the container log).
ls_log_on=
ls_reader=
ls_awk='

function iso(t,   s, z, era, doe, yoe, y, doy, mp, d, m) {
  s = t % 86400; z = (t - s) / 86400 + 719468
  era = int(z / 146097); doe = z - era * 146097
  yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
  y = yoe + era * 400; doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
  mp = int((5 * doy + 2) / 153); d = doy - int((153 * mp + 2) / 5) + 1
  m = mp < 10 ? mp + 3 : mp - 9; if (m <= 2) y++
  return sprintf("%04d-%02d-%02dT%02d:%02d:%02d.000Z", y, m, d, int(s / 3600), int((s % 3600) / 60), s % 60)
}
function clock() { srand(); return srand() }
function word(c) { return c ~ /[0-9A-Za-z]/ }
function lit(s, from, to,   out, i) {
  out = ""
  while ((i = index(s, from)) > 0) { out = out substr(s, 1, i - 1) to; s = substr(s, i + length(from)) }
  return out s
}
function addr(r,   port, t, n) {
  if (r ~ /^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+(:[0-9]+)?$/) { port = ""; if (match(r, /:[0-9]+$/)) port = substr(r, RSTART); return "[ip]" port }
  t = r; n = gsub(/:/, ":", t)
  if (index(r, "::") > 0 || n >= 7) return "[ip]"
  return r
}
function ips(s,   out, pre, run, tail) {
  out = ""
  while (match(s, /[0-9A-Fa-f:.]+/)) {
    pre = substr(s, 1, RSTART - 1); run = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    tail = ""; while (run ~ /[.]$/) { tail = tail "."; run = substr(run, 1, length(run) - 1) }
    if (!word(substr(out pre, length(out pre), 1)) && !word(substr(s, 1, 1))) run = addr(run)
    out = out pre run tail
  }
  return out s
}
function pairs(s,   out, m) {
  out = ""
  while (match(tolower(s), /(password|passwd|secret|token|api_?key|access_?key(_id)?|secret_?key|authorization|credentials?)["]?[ \t]*[:=][ \t]*["]?[^ \t",;&]+/)) {
    m = substr(s, RSTART, RLENGTH); out = out substr(s, 1, RSTART - 1); s = substr(s, RSTART + RLENGTH)
    match(m, /[:=][ \t]*["]?/)
    out = out substr(m, 1, RSTART + RLENGTH - 1) "[redacted]"
  }
  return out s
}
function creds(s,   out, m) {
  out = ""
  while (match(s, /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^ \/@]+@/)) {
    m = substr(s, RSTART, RLENGTH); out = out substr(s, 1, RSTART - 1) substr(m, 1, index(m, "://") + 2) "[redacted]@"; s = substr(s, RSTART + RLENGTH)
  }
  return out s
}
function redact(s,   i) {
  for (i = 1; i <= nsecret; i++) s = lit(s, secret[i], "[redacted]")
  s = creds(s)
  gsub(/[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+[A-Za-z0-9._~+\/=-]+/, "Bearer [redacted]", s)
  s = pairs(s)
  gsub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z][A-Za-z]+/, "[e-mail]", s)
  return ips(s)
}
BEGIN {
  nsecret = 0
  for (k in ENVIRON) {
    v = ENVIRON[k]; u = toupper(k)
    if (u ~ /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL/ && u !~ /_(FILE|PATH|DIR)$/ && length(v) >= 6 && v !~ /^(true|false|on|off)$/) secret[++nsecret] = v
  }
  for (i = 1; i <= nsecret; i++) for (j = i + 1; j <= nsecret; j++) if (length(secret[j]) > length(secret[i])) { t = secret[i]; secret[i] = secret[j]; secret[j] = t }
  if (mark) { out = iso(clock()) " - start Flowplan container start"; print out >> file; fflush(file); lines++; bytes += length(out) + 1 }
}
{
  line = $0; sub(/\r$/, "", line)
  if (line == "") next
  if (length(line) > 2000) line = substr(line, 1, 2000)
  out = iso(clock()) " - litestream " redact(line)
  if (lines > 0 && (lines + 1 > 1000 || bytes + length(out) + 1 > 1048576)) {
    close(file); system("mv -f \"" file "\" \"" file ".1\"")
    lines = 0; bytes = 0
  }
  print out >> file; fflush(file)
  lines++; bytes += length(out) + 1
}'
# Opens fd 6: what is written to it reaches the container's stdout and the
# file. ls_log_on=1 when it works; nothing changes when it does not.
ls_log_open() {
  if [ -n "$ls_log_on" ] || [ "${FLOWPLAN_LOG_FILE:-on}" = off ]; then return 0; fi
  ls_dir="$DATA/logs"
  # The app runs as "sh $0 --exec-app" (Litestream splits -exec at
  # spaces); awk hands the file name to mv in double quotes.
  case "$0$ls_dir" in *[[:space:]\"\$\`\\]*) return 0 ;; esac
  [ -f "$0" ] || return 0
  mkdir -p "$ls_dir" 2> /dev/null || true
  if ! { [ -d "$ls_dir" ] && [ -w "$ls_dir" ]; }; then
    echo "Flowplan: $ls_dir is not writable; Litestream's output is not saved there." >&2
    return 0
  fi
  { command -v awk && command -v mkfifo; } > /dev/null 2>&1 || return 0
  tee -i -p < /dev/null > /dev/null 2>&1 || return 0
  awk -v file=/dev/null "$ls_awk" < /dev/null > /dev/null 2>&1 || return 0
  # mawk (Debian's awk) reads a pipe in blocks unless told otherwise: the
  # lines would wait until Litestream ends.
  ls_awk_line=
  if awk -W interactive 'BEGIN { exit 0 }' < /dev/null > /dev/null 2>&1; then ls_awk_line="-W interactive"; fi
  ls_fifo="$(mktemp -d "${TMPDIR:-/tmp}/flowplan-log.XXXXXX" 2> /dev/null)" || return 0
  if ! mkfifo -m 600 "$ls_fifo/litestream" 2> /dev/null; then
    rm -rf "$ls_fifo"
    return 0
  fi
  # Read-write: opening it never blocks; the FIFO's name goes at once.
  exec 7<> "$ls_fifo/litestream"
  rm -rf "$ls_fifo"
  if [ ! -e /dev/fd/7 ]; then
    exec 7>&-
    return 0
  fi
  ls_file="$ls_dir/litestream.log"
  # A first start has no file yet: 0, without the shell's "cannot open".
  ls_lines="$({ wc -l < "$ls_file"; } 2> /dev/null || echo 0)"
  ls_bytes="$({ wc -c < "$ls_file"; } 2> /dev/null || echo 0)"
  (
    trap '' TERM INT HUP PIPE
    # Not the data folder lock (fd 9): it goes with the container's processes.
    exec 9>&- 5>&1 < /dev/fd/7 7>&-
    { tee -i -p /dev/fd/8 8>&1 >&5 2> /dev/null 5>&-; } | awk $ls_awk_line -v file="$ls_file" -v lines="$ls_lines" -v bytes="$ls_bytes" -v mark=1 "$ls_awk" > /dev/null 2>&1
  ) &
  ls_reader=$!
  # Write-only from here: when the copy is gone, a write fails instead of
  # filling the FIFO.
  exec 6> /dev/fd/7 7>&-
  trap '' PIPE
  ls_log_on=1
}
# A Litestream command with its output through fd 6 (exit code unchanged).
ls_run() {
  if [ -n "$ls_log_on" ]; then "$@" >&6 2>&6 6>&-; else "$@"; fi
}

if [ -z "$POSTGRES" ] && [ -n "${S3_BUCKET:-}" ] && [ "${FLOWPLAN_LITESTREAM:-on}" != "off" ]; then LITESTREAM=1; fi

# One container per SQLite data folder. A rollout with overlap (Coolify's
# rolling update, docker compose up while the old container still runs, two
# services on one volume) starts a second Flowplan on the same folder; two
# Litestream processes on one database then break its replication state
# (.flowplan.sqlite-litestream: lost .ltx.tmp renames, LTX files with a bad
# checksum that block compaction for good). So every container takes an
# exclusive flock on $DATA/.flowplan.lock, held on fd 9 for its whole life:
# fd 9 is inherited by Litestream and node, and the lock (one open file
# description) only goes back when the last of them has exited.
#   Lock free: as before (restore, then Litestream with the app as its child).
#   Lock held: no second Litestream, no restore, no instance restore swap.
#     The app starts anyway (a rolling update's healthcheck passes and the
#     old container gets stopped), the entrypoint stays as the supervisor,
#     writes $DATA/.flowplan-waiting (Administration → Überwachung shows it,
#     lib/cluster/data-dir-lock.ts) and starts `litestream replicate` once
#     the lock is free. A pending instance restore, or a database that does
#     not exist yet while Litestream is on (the other container may be
#     restoring it), waits for the lock before the app starts.
# PostgreSQL has its own guard (lib/cluster/single-instance.ts).
LOCK="$DATA/.flowplan.lock"
WAITING="$DATA/.flowplan-waiting"
OVERLAP=
ME="$(uname -n 2>/dev/null || echo unknown)"
waiting_since=
MARKED_AT=0
# The waiting marker: when this container started waiting, its hostname,
# whether it waits to replicate. Rewritten every 30 s (its age tells a
# container that is gone).
mark_waiting() {
  if [ -z "$waiting_since" ]; then waiting_since="$(date +%s)"; fi
  printf 'since=%s\nhost=%s\nlitestream=%s\n' "$waiting_since" "$ME" "${LITESTREAM:-0}" > "$WAITING.$$" 2>/dev/null \
    && mv -f "$WAITING.$$" "$WAITING" 2>/dev/null || rm -f "$WAITING.$$" 2>/dev/null || true
  MARKED_AT="$(date +%s)"
}
# Only this container's marker: another one may still be waiting too.
unmark_waiting() {
  if [ -f "$WAITING" ] && grep -qx "host=$ME" "$WAITING" 2>/dev/null; then rm -f "$WAITING"; fi
}
overlap_warning() {
  {
    echo "=========================================================================="
    echo "Flowplan: ANOTHER CONTAINER IS USING THE DATA FOLDER $DATA."
    echo "  It holds $LOCK. Two Flowplan containers on one SQLite database must not overlap:"
    echo "  roll out with stop-then-start (no rolling update with overlap) and never run two"
    echo "  containers on the same volume. See https://docs.flowplan.org/en/coolify-and-proxy#roll-out-sqlite-without-overlap"
    if [ -n "$LITESTREAM" ]; then
      echo "  This container serves, but Litestream replication waits until the other one has"
      echo "  stopped and the lock is free; it then starts here by itself."
    else
      echo "  This container serves anyway; the warning ends once the other one has stopped."
    fi
    echo "=========================================================================="
  } >&2
}
# The Litestream state reset (docs: storage-and-backups, "Repair the
# Litestream state"): `touch $DATA/litestream-reset` and a restart run
# `litestream reset` here, with the lock held and before Litestream
# replicates. It removes only the local LTX files
# (.flowplan.sqlite-litestream/ltx), never the database; Litestream then
# takes the bucket's last position and writes a full snapshot unless the
# WAL still continues it.
# With "remote" as the marker's first line (written by the app when the
# replica in the bucket is stuck, or by Administration → Überwachung →
# "Replik jetzt neu aufbauen"; lib/litestream-health.ts) the replica in the
# bucket goes first: scripts/litestream-replica-reset.mjs deletes every
# object under <S3_PREFIX>/db/ and nothing else. Litestream then finds an
# empty bucket and starts afresh with a full snapshot. Not without a local
# database (the replica would be its only copy). When the delete fails,
# nothing is reset, the marker stays for the next start and Litestream
# replicates as before.
litestream_reset_if_asked() {
  if [ -f "$DATA/litestream-reset" ]; then
    reset_mode="$(head -n 1 "$DATA/litestream-reset" 2>/dev/null | tr -d '[:space:]')"
    if [ "$reset_mode" = remote ]; then
      if [ ! -s "$DB" ]; then
        echo "Litestream: $DATA/litestream-reset asks to rebuild the replica, but there is no local database; the replica in the bucket is kept and the marker stays." >&2
        return 0
      fi
      echo "Litestream: deleting the replica in the bucket (${S3_PREFIX:+$S3_PREFIX/}db/) to rebuild it ($DATA/litestream-reset)."
      if ! node /app/scripts/litestream-replica-reset.mjs; then
        {
          echo "=========================================================================="
          echo "Litestream: DELETING THE REPLICA IN THE BUCKET FAILED. Nothing was reset;"
          echo "  $DATA/litestream-reset stays and the repair is tried again on the next start."
          echo "  Flowplan starts normally, Litestream replicates as before."
          echo "=========================================================================="
        } >&2
        return 0
      fi
    fi
    echo "Litestream: resetting the local replication state ($DATA/litestream-reset)."
    if ls_run litestream reset -config /etc/litestream.yml "$DB"; then
      rm -f "$DATA/litestream-reset"
    else
      echo "Litestream: the reset failed; $DATA/litestream-reset stays for the next start." >&2
    fi
  fi
}
# When Litestream starts replicating in this container (with the lock
# held): the app checks the replica in the bucket only here, and only once
# Litestream has run for a while (lib/litestream-health.ts). $1: Litestream's
# PID where it is known beforehand (the exec path: `exec litestream` keeps
# this shell's PID), for the app's reading of Litestream's memory
# (lib/litestream-memory.ts); without it the app looks for it in /proc.
mark_replicating() {
  { printf 'since=%s\nhost=%s\n' "$(date +%s)" "$ME" && if [ -n "${1:-}" ]; then printf 'pid=%s\n' "$1"; fi; } > "$DATA/.flowplan-replicating.$$" 2>/dev/null \
    && mv -f "$DATA/.flowplan-replicating.$$" "$DATA/.flowplan-replicating" 2>/dev/null || rm -f "$DATA/.flowplan-replicating.$$" 2>/dev/null || true
}
if [ -z "$POSTGRES" ]; then
  if ! command -v flock > /dev/null 2>&1; then
    echo "Warning: flock is missing, the data folder $DATA is not protected against a second container." >&2
  else
    exec 9>> "$LOCK"
    lock_status=0
    flock -n -E 75 9 || lock_status=$?
    if [ "$lock_status" = 75 ]; then
      OVERLAP=1
    elif [ "$lock_status" != 0 ]; then
      echo "Warning: could not lock $LOCK (does the volume's file system support flock?); the data folder is not protected against a second container." >&2
    fi
  fi
fi
STOP=
if [ -n "$OVERLAP" ]; then
  overlap_warning
  mark_waiting
  # A pending instance restore would move the other container's live
  # database away (here or in lib/db.ts), and a missing database may be
  # the other container's Litestream restore in progress: these wait for
  # the lock before anything starts.
  if [ -f "$DATA/restore-pending/READY" ] || { [ -n "$LITESTREAM" ] && [ ! -e "$DB" ]; }; then
    echo "Flowplan waits for $LOCK before it starts (a pending restore, or no database yet)." >&2
    trap 'STOP=143' TERM
    trap 'STOP=130' INT
    until flock -n 9; do
      if [ -n "$STOP" ]; then unmark_waiting; exit "$STOP"; fi
      if [ $(($(date +%s) - MARKED_AT)) -ge 30 ]; then mark_waiting; fi
      sleep 1 &
      wait $! || true
    done
    trap - TERM INT
    unmark_waiting
    OVERLAP=
    echo "Flowplan: the other container has stopped; starting normally."
  fi
fi

# The second container on the data folder (lock held elsewhere): the app
# runs at once, Litestream (replicate=1) once the lock is free. The shell
# stays the main process: SIGTERM/SIGINT go to the app, and to Litestream
# once the app has exited (as `litestream replicate -exec` does, so the
# app's last writes are replicated). Both as SIGTERM: what a non-interactive
# shell starts in the background begins with SIGINT ignored. The app's exit ends Litestream and
# the container with the app's exit code; a Litestream that dies is logged
# and restarted with backoff while the app keeps running.
supervise() {
  replicate="$1"
  restart_min="${FLOWPLAN_LITESTREAM_RESTART_SECONDS:-5}"
  locked=
  ls_pid=
  ls_started=0
  ls_next=0
  ls_failures=0
  signal=
  forwarded=
  trap 'signal=TERM' TERM
  trap 'signal=INT' INT
  node $node_flags "$app_main" 6>&- &
  app=$!
  while kill -0 "$app" 2> /dev/null; do
    if [ -n "$signal" ] && [ -z "$forwarded" ]; then
      forwarded=1
      kill -s TERM "$app" 2> /dev/null || true
    fi
    now="$(date +%s)"
    if [ -z "$locked" ]; then
      if flock -n 9; then
        locked=1
        unmark_waiting
        if [ -n "$replicate" ]; then
          echo "Flowplan: the other container has stopped and released $DATA; Litestream starts replicating now."
          ls_log_open
          if [ -z "$signal" ]; then litestream_reset_if_asked; fi
          mark_replicating
        else
          echo "Flowplan: the other container has stopped and released $DATA."
        fi
      elif [ $((now - MARKED_AT)) -ge 30 ]; then
        mark_waiting
      fi
    fi
    if [ -n "$locked" ] && [ -n "$replicate" ] && [ -z "$signal" ]; then
      if [ -n "$ls_pid" ] && ! kill -0 "$ls_pid" 2> /dev/null; then
        ls_code=0
        wait "$ls_pid" || ls_code=$?
        ls_pid=
        if [ $((now - ls_started)) -ge 60 ]; then ls_failures=0; fi
        ls_failures=$((ls_failures + 1))
        delay=$((restart_min << (ls_failures - 1 < 6 ? ls_failures - 1 : 6)))
        if [ "$delay" -gt 300 ]; then delay=300; fi
        echo "Litestream stopped (exit code $ls_code); the app keeps running, Litestream restarts in ${delay}s." >&2
        ls_next=$((now + delay))
      fi
      if [ -z "$ls_pid" ] && [ "$now" -ge "$ls_next" ]; then
        # Litestream died (often the kernel's OOM killer, when a stuck
        # replica made its memory climb, lib/litestream-memory.ts) and the
        # app may have scheduled the repair meanwhile: apply it before the
        # restart, while no Litestream runs – only Litestream restarts, the
        # app keeps running. (On the exec path Litestream is the container's
        # main process: its end ends the container, and the repair runs on
        # the next start.)
        if [ "$ls_started" -gt 0 ]; then litestream_reset_if_asked; fi
        # Started directly (not through ls_run): $! must be Litestream itself.
        if [ -n "$ls_log_on" ]; then
          litestream replicate -config /etc/litestream.yml >&6 2>&6 6>&- &
        else
          litestream replicate -config /etc/litestream.yml &
        fi
        ls_pid=$!
        ls_started="$now"
      fi
    fi
    sleep 1 &
    wait $! || true
  done
  app_code=0
  wait "$app" || app_code=$?
  if [ -n "$ls_pid" ]; then
    kill -s TERM "$ls_pid" 2> /dev/null || true
    wait "$ls_pid" || true
  fi
  if [ -z "$locked" ]; then unmark_waiting; fi
  # Litestream's last lines into the file before the container ends.
  if [ -n "$ls_log_on" ]; then
    exec 6>&-
    wait "$ls_reader" 2> /dev/null || true
  fi
  exit "$app_code"
}

if [ -z "$OVERLAP" ] && [ -z "$POSTGRES" ] && [ -f "$DATA/restore-pending/READY" ] && [ ! -f "$DATA/restore-pending/flowplan.dump" ]; then
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

if [ -n "$LITESTREAM" ]; then
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
  # How much Litestream logs (its own LOG_LEVEL): "warn" leaves out the
  # routine lines of every compaction and keeps warnings and errors.
  case "$(printf '%s' "${FLOWPLAN_LITESTREAM_LOG_LEVEL:-}" | tr '[:upper:]' '[:lower:]')" in
    "") ;;
    debug | info | warn | error)
      LOG_LEVEL="$(printf '%s' "$FLOWPLAN_LITESTREAM_LOG_LEVEL" | tr '[:upper:]' '[:lower:]')"
      export LOG_LEVEL
      ;;
    *) echo "FLOWPLAN_LITESTREAM_LOG_LEVEL=$FLOWPLAN_LITESTREAM_LOG_LEVEL is ignored: use debug, info, warn or error." >&2 ;;
  esac
  export S3_REGION S3_ENDPOINT S3_PREFIX FLOWPLAN_DB LITESTREAM_SSE_C_KEY FLOWPLAN_LITESTREAM_ACTIVE FLOWPLAN_LITESTREAM_SSE_C
  if { [ -n "${FLOWPLAN_ENCRYPTION_KEY:-}" ] || [ -n "${FLOWPLAN_ENCRYPTION_KEY_FILE:-}" ]; } && [ "$FLOWPLAN_LITESTREAM_SSE_C" = 0 ]; then
    echo "Hinweis: Litestream legt die Datenbank unverschlüsselt in den Bucket. FLOWPLAN_LITESTREAM=off und stündliche verschlüsselte Sicherungen vermeiden das (siehe Doku)."
  fi
  if [ -n "$OVERLAP" ]; then supervise 1; fi
  # The lock is held here: only now may the restore write the database.
  # Lock free at once keeps Litestream's own -exec: it forwards signals,
  # replicates the app's last writes after it exits and ends with the app's
  # exit code; app and replication live and die together.
  ls_log_open
  ls_run litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DB"
  litestream_reset_if_asked
  mark_replicating "$$"
  if [ -n "$ls_log_on" ]; then
    exec 3>&1 4>&2
    exec litestream replicate -config /etc/litestream.yml -exec "sh $0 --exec-app" >&6 2>&6 6>&-
  fi
  exec litestream replicate -config /etc/litestream.yml -exec "node ${node_flags:+$node_flags }$app_main"
fi
if [ -n "$OVERLAP" ]; then supervise ""; fi
exec node $node_flags "$app_main"
