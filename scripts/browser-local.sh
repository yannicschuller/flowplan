#!/usr/bin/env bash
# Runs one or more browser specs (tests/browser) locally against a server of
# their own: a fresh data folder, a fresh build directory, a free port.
#
#   npm run test:browser -- tests/browser/journal.spec.ts
#   npm run test:browser -- --repeat 5 tests/browser/cursors.spec.ts --project=desktop
#   npm run test:browser -- --build tests/browser/board-drop-slide.spec.ts
#
# By default the development server (`next dev`, its own build directory
# .next-browser, removed before and after). With --build the production
# build of the browser specs instead (npm run build:e2e, as in CI): slower
# to start, but the specs run several times faster. --repeat N runs every
# test N times. Arguments the script does not know go to Playwright.
# At the end the script stops only the server it started (by its PID).
set -euo pipefail
cd "$(dirname "$0")/.."

mode=dev
repeat=1
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --build) mode=build ;;
    --repeat) repeat="$2"; shift ;;
    --repeat=*) repeat="${1#--repeat=}" ;;
    *) args+=("$1") ;;
  esac
  shift
done
if [ ${#args[@]} -eq 0 ]; then
  echo "Which specs? e.g. npm run test:browser -- tests/browser/journal.spec.ts" >&2
  exit 2
fi

# The data folder under the names some specs insist on before they write to
# the database themselves: e2ee.spec.ts its own, the others the inline one.
prefix=/tmp/flowplan-inline-e2e
for a in "${args[@]}"; do case "$a" in *e2ee.spec.ts) prefix=/tmp/flowplan-e2ee-e2e ;; esac; done
data=$(mktemp -d "$prefix.XXXXXX")
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
origin="http://127.0.0.1:$port"
log="$data.log"
dist=.next-browser
# `next dev` writes its build directory into these two; they stay as checked in.
kept=$(mktemp -d)
cp next-env.d.ts tsconfig.json "$kept/"

pid=""
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  cp "$kept/next-env.d.ts" "$kept/tsconfig.json" . && rm -rf "$kept"
  [ "$mode" = dev ] && rm -rf "$dist"
  rm -rf "$data"
}
trap cleanup EXIT INT TERM

if [ "$mode" = build ]; then
  rm -rf .next-e2e/standalone
  npm run build:e2e
  # The server's own data folder: the one made above.
  PORT=$port FLOWPLAN_DATA_DIR="$data" APP_URL="$origin" node scripts/e2e-server.mjs > /dev/null 2>&1 &
  pid=$!
else
  rm -rf "$dist"
  # `exec` in the subshell: $! is the server itself, not a shell around it.
  (APP_URL="$origin" FLOWPLAN_DATA_DIR="$data" FLOWPLAN_DIST_DIR="$dist" NEXT_TELEMETRY_DISABLED=1 \
    exec node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port "$port" > "$log" 2>&1) &
  pid=$!
fi
echo "Server $origin (PID $pid), data $data, log $log"
for _ in $(seq 1 120); do
  curl -sf -o /dev/null "$origin/api/health" && break
  kill -0 "$pid" 2>/dev/null || { echo "The server stopped:" >&2; tail -n 50 "$log" >&2; exit 1; }
  sleep 1
done
curl -sf -o /dev/null "$origin/api/health" || { echo "No answer from $origin/api/health" >&2; exit 1; }
# The first page compiles the app on the dev server; the specs' timeouts do
# not have to cover that.
curl -sf -o /dev/null --max-time 600 "$origin/" || true

# A Chromium installed on the machine (/opt/pw-browsers/chromium) unless
# PLAYWRIGHT_CHROMIUM_EXECUTABLE names another; else Playwright's own.
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ] && [ -x /opt/pw-browsers/chromium ]; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium
fi
status=0
# One server, started here: not Playwright's servers of TEST_SERVERS.
env -u TEST_SERVERS TEST_BASE_URL="$origin" FLOWPLAN_DATA_DIR="$data" \
  npx playwright test "${args[@]}" --repeat-each="$repeat" || status=$?
echo "Server log: $log"
exit $status
