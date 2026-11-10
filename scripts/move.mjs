#!/usr/bin/env node
// Instance move without the web interface (docs: Instanz umziehen): pulls the
// whole instance from the old server with its move token into this data
// folder – the same as Administration → Speicher & Sicherung → Von anderer
// Instanz übernehmen. The copy is applied on the next start (the previous
// state stays in pre-move-<time>).
//
//   npm run move -- --from https://old.example.org --token fpmove_…
//   docker run --rm -v flowplan-data:/app/data -e APP_URL=https://new.example.org \
//     ghcr.io/yannicschuller/flowplan node /app/move.mjs --from … --token …
//   (continues as PUID:PGID, default 1000:1000, when started as root – the
//   image's default; with user: "UID:GID" add --user UID:GID)
//
// Options:
//   --from <url>        address of the old instance (its APP_URL)
//   --token <token>     move token (or FLOWPLAN_MOVE_TOKEN)
//   --data <dir>        data folder (default FLOWPLAN_DATA_DIR or ./data)
//   --target-url <url>  address of this instance for the old one's banner
//                       (default APP_URL)
//   --copy-only         first copy only: the old instance stays writable;
//                       run again without it for the final sync
//   --yes               replace a data folder that already holds content
//
// The address may be internal (LAN, VPN) and plain http here: whoever runs
// this command chooses where it connects.
// First: started with docker exec as root, continue as PUID:PGID (#193).
import "./drop-root.mjs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
// In the image the engine lies next to this script, in the repository in lib/.
const engine = [resolve(here, "instance-move-pull.ts"), resolve(here, "../lib/instance-move-pull.ts")].find(existsSync);
if (!engine) {
  console.error("instance-move-pull.ts not found next to move.mjs or in ../lib.");
  process.exit(2);
}
const { INCOMING_DIR, MOVE_TOKEN_PREFIX, checkStagedDatabase, moveJson, pullInstance, sourceBase, stageMove } = await import(pathToFileURL(engine).href);

function args(argv) {
  const out = { copyOnly: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail(`${a} needs a value.`);
      return v;
    };
    if (a === "--from") out.from = value();
    else if (a === "--token") out.token = value();
    else if (a === "--data") out.data = value();
    else if (a === "--target-url") out.target = value();
    else if (a === "--copy-only") out.copyOnly = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else fail(`Unknown option ${a}. See --help.`);
  }
  return out;
}
function fail(message, code = 1) {
  console.error(`move: ${message}`);
  process.exit(code);
}
const opts = args(process.argv.slice(2));
if (opts.help) {
  console.log("Usage: node move.mjs --from <url> --token <fpmove_…> [--data <dir>] [--target-url <url>] [--copy-only] [--yes]");
  process.exit(0);
}
const token = opts.token || process.env.FLOWPLAN_MOVE_TOKEN || "";
if (!opts.from) fail("--from <url of the old instance> is required.");
if (!token.startsWith(MOVE_TOKEN_PREFIX)) fail("--token must be the move token (fpmove_…) from the old instance.");
const data = resolve(opts.data || process.env.FLOWPLAN_DATA_DIR || "./data");
const staging = resolve(data, INCOMING_DIR);
let base;
try {
  base = sourceBase(opts.from, true);
} catch (e) {
  fail(e.message);
}
const source = { url: base, token, allowHttp: true };

// A data folder with content is only replaced on request.
const existing = resolve(data, "flowplan.sqlite");
if (existsSync(existing) && !opts.yes) {
  let users = 0,
    pages = 0;
  try {
    const db = new DatabaseSync(existing, { readOnly: true });
    users = db.prepare("SELECT count(*) n FROM users").get().n;
    pages = db.prepare("SELECT count(*) n FROM pages").get().n;
    db.close();
  } catch {}
  if (users > 1 || pages > 12) fail(`${data} already holds an instance (${users} accounts, ${pages} pages). Pass --yes to replace it; the current state is kept as pre-move-<time>.`);
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const eta = (s) => (s === null || s === undefined ? "…" : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
const tty = process.stderr.isTTY;
let lastLine = 0;
function show(label) {
  return (p) => {
    const now = Date.now();
    if (!tty && now - lastLine < 5000 && p.phase !== "done") return;
    lastLine = now;
    const line = `${label}: ${p.phase} · ${mb(p.bytesDone)} / ${mb(p.bytesTotal)} · ${p.filesDone} / ${p.filesTotal} files · ETA ${eta(p.etaSeconds)}`;
    process.stderr.write(tty ? `\r${line.padEnd(100)}` : `${line}\n`);
  };
}
const done = () => tty && process.stderr.write("\n");

try {
  // The token works and the address answers.
  await moveJson(source, "/api/move/env", { timeoutMs: 20_000 });
  console.error(`Source ${base} answers. Copying into ${data} …`);
  const first = await pullInstance(source, staging, { onProgress: show("copy") });
  done();
  if (opts.copyOnly) {
    console.error(`First copy complete (${first.manifest.files.length} files). The old instance is still writable; run again without --copy-only for the final sync.`);
    process.exit(0);
  }
  console.error("Switching the old instance to read-only and fetching the last state …");
  await moveJson(source, "/api/move/freeze", { method: "POST", body: {}, timeoutMs: 20_000 });
  const final = await pullInstance(source, staging, { onProgress: show("final") });
  done();
  const summary = checkStagedDatabase(staging, final.manifest, base);
  stageMove(data, staging, summary);
  console.error(`Staged: ${summary.workspaces} workspaces, ${summary.pages} pages, ${summary.users} accounts, ${summary.files} files.`);
  const target = opts.target || process.env.APP_URL;
  if (target) {
    try {
      await moveJson(source, "/api/move/finish", { method: "POST", body: { target: new URL(target).origin }, timeoutMs: 20_000 });
      console.error(`The old instance now shows “moved to ${new URL(target).origin}”; its move token is used up.`);
    } catch (e) {
      console.error(`Note: the old instance could not be told the new address (${e.message}). It stays read-only.`);
    }
  } else console.error("Note: no --target-url or APP_URL – the old instance stays read-only without the “moved to” banner.");
  console.error("Done. Start (or restart) Flowplan with this data folder to apply the copy.");
} catch (e) {
  done();
  // A refusal of the token ends the move; anything else resumes where it stopped.
  fail(e.status === 401 ? `${e.message} (token wrong, expired, revoked or used up)` : `${e.message}\nRun the same command again to resume.`);
}
