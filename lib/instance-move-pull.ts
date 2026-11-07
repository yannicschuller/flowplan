// The pulling side of an instance move ("Instanz umziehen", lib/instance-move.ts):
// fetches the move manifest of the source instance, a consistent database
// snapshot, every upload and the instance's own key files into a staging
// folder, resumably (Range requests on partial files, a record of finished
// files with their SHA-256) and with a check of every file's checksum.
//
// Only Node built-ins and plain, erasable TypeScript: the server imports it,
// and the command-line fallback (scripts/move.mjs) runs it with Node's type
// stripping, also inside the container, where no other module is at hand.
// The server passes its SSRF-safe address lookup (lib/safe-fetch.ts).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MOVE_FORMAT = "flowplan-move-1";
export const MOVE_TOKEN_PREFIX = "fpmove_";
// The files of the data folder that move with the instance besides the
// database and uploads/: the Web Push keys (existing browser subscriptions
// stay valid) and the generated key for stored secrets (when neither
// FLOWPLAN_ENCRYPTION_KEY nor FLOWPLAN_SECRETS_KEY is set).
export const MOVE_EXTRAS = ["web-push-keys.json", "secrets.key"];
export const UPLOAD_NAME = /^[A-Za-z0-9_-]{1,100}$/;
export const INCOMING_DIR = "move-incoming";

export type MoveFile = { name: string; size: number; sha256: string };
export type MoveManifest = {
  format: string;
  createdAt: string;
  appUrl: string;
  readOnly: boolean;
  snapshot: { id: string; size: number; sha256: string };
  files: MoveFile[];
  extras: MoveFile[];
};
export type MoveProgress = {
  phase: "manifest" | "database" | "files" | "extras" | "done";
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  // Bytes really transferred in this run (skipped files do not count): the
  // rate behind the estimate.
  transferred: number;
  startedAt: number;
  etaSeconds: number | null;
};
export type MoveSource = {
  // The source's address (APP_URL of the old instance), without a path.
  url: string;
  token: string;
  // An address lookup that refuses internal addresses (the server's
  // pinnedLookup); without one the system's lookup is used (command line).
  lookup?: unknown;
  // Plain http (home servers in the LAN or a VPN); otherwise https only.
  allowHttp?: boolean;
  timeoutMs?: number;
};
// What has arrived in the staging folder, kept in state.json: resuming
// after an interruption skips everything already checked.
type StagingState = { source: string; done: Record<string, string>; snapshot?: { id: string; sha256: string; done: boolean } };

export class MoveError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export function sourceBase(raw: string, allowHttp = false) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new MoveError("Ungültige Adresse der Quelle.", 400);
  }
  if (!(url.protocol === "https:" || (allowHttp && url.protocol === "http:")) || url.username || url.password)
    throw new MoveError(allowHttp ? "Die Adresse der Quelle muss mit https:// oder http:// beginnen." : "Die Adresse der Quelle muss mit https:// beginnen.", 400);
  return url.origin;
}

function send(source: MoveSource, path: string, init: { method?: string; body?: string; range?: number; timeoutMs?: number } = {}) {
  const url = new URL(path, sourceBase(source.url, source.allowHttp) + "/");
  const request = url.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise<IncomingMessage>((done, fail) => {
    const req = request(
      url,
      {
        method: init.method || "GET",
        timeout: init.timeoutMs ?? source.timeoutMs ?? 60_000,
        headers: {
          authorization: `Bearer ${source.token}`,
          "user-agent": "Flowplan-Move/1",
          accept: "application/json, application/octet-stream",
          ...(init.range ? { range: `bytes=${init.range}-` } : {}),
          ...(init.body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(init.body)) } : {}),
        },
        // A connection of its own: the lookup checks new connections only.
        ...(source.lookup ? { lookup: source.lookup as never, agent: false } : {}),
      },
      (res) => done(res),
    );
    req.on("timeout", () => req.destroy(new MoveError("Zeitüberschreitung bei der Quelle.")));
    req.on("error", (e) => fail(e instanceof MoveError ? e : new MoveError(`Die Quelle ist nicht erreichbar: ${e.message}`)));
    req.end(init.body);
  });
}
async function readBody(res: IncomingMessage, max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > max) {
      res.destroy();
      throw new MoveError("Antwort der Quelle zu groß.");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
// A JSON request to the source's move endpoints; errors carry the source's
// own message (German, like every server message).
export async function moveJson<T>(source: MoveSource, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const res = await send(source, path, { method: init.method, body: init.body === undefined ? undefined : JSON.stringify(init.body), timeoutMs: init.timeoutMs });
  const status = res.statusCode || 0;
  const text = await readBody(res, 512 * 1024 * 1024);
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (status < 200 || status >= 300) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new MoveError(typeof message === "string" ? message : `Die Quelle antwortet mit ${status}.`, status);
  }
  if (data === null) throw new MoveError("Die Quelle antwortet nicht wie eine Flowplan-Instanz.");
  return data as T;
}

export async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// One file, resumable: a partial file (<dest>.part) continues with a Range
// request where it stopped; the whole file must match `sha256` before it
// takes the place of `dest`. Returns the bytes transferred.
export async function downloadFile(source: MoveSource, path: string, dest: string, expected: { size: number; sha256: string }, onBytes: (n: number) => void = () => {}) {
  const part = `${dest}.part`;
  let offset = existsSync(part) ? statSync(part).size : 0;
  if (offset > expected.size) {
    rmSync(part, { force: true });
    offset = 0;
  }
  const hash = createHash("sha256");
  if (offset) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
  // Already complete (interrupted right before the check): no request.
  let transferred = 0;
  if (offset < expected.size || expected.size === 0) {
    const res = await send(source, path, { range: offset || undefined, timeoutMs: 120_000 });
    const status = res.statusCode || 0;
    if (status === 416) {
      res.resume();
      rmSync(part, { force: true });
      throw new MoveError("Die Datei hat sich an der Quelle geändert.", 416);
    }
    if (status !== 200 && status !== 206) {
      const text = await readBody(res, 100_000).catch(() => "");
      let message = `Die Quelle antwortet mit ${status}.`;
      try {
        message = JSON.parse(text).error || message;
      } catch {}
      throw new MoveError(message, status);
    }
    // A source that ignores the range sends everything again.
    if (status === 200 && offset) {
      offset = 0;
      hash.destroy();
      return downloadFresh(res, part, dest, expected, onBytes);
    }
    const out = createWriteStream(part, { flags: offset ? "a" : "w" });
    try {
      for await (const chunk of res) {
        const data = chunk as Buffer;
        hash.update(data);
        transferred += data.length;
        onBytes(data.length);
        if (offset + transferred > expected.size) throw new MoveError("Die Datei ist größer als angekündigt.");
        if (!out.write(data)) await new Promise((done) => out.once("drain", done));
      }
    } finally {
      await new Promise<void>((done) => out.end(done));
    }
  }
  const sha = hash.digest("hex");
  if (statSync(part).size !== expected.size || sha !== expected.sha256) {
    rmSync(part, { force: true });
    throw new MoveError("Prüfsumme stimmt nicht – die Datei wird neu geladen.", 0);
  }
  renameSync(part, dest);
  return transferred;
}
async function downloadFresh(res: IncomingMessage, part: string, dest: string, expected: { size: number; sha256: string }, onBytes: (n: number) => void) {
  const hash = createHash("sha256");
  const out = createWriteStream(part, { flags: "w" });
  let size = 0;
  try {
    for await (const chunk of res) {
      const data = chunk as Buffer;
      hash.update(data);
      size += data.length;
      onBytes(data.length);
      if (!out.write(data)) await new Promise((done) => out.once("drain", done));
    }
  } finally {
    await new Promise<void>((done) => out.end(done));
  }
  if (size !== expected.size || hash.digest("hex") !== expected.sha256) {
    rmSync(part, { force: true });
    throw new MoveError("Prüfsumme stimmt nicht – die Datei wird neu geladen.");
  }
  renameSync(part, dest);
  return size;
}

function readState(staging: string, source: string): StagingState {
  try {
    const state = JSON.parse(readFileSync(resolve(staging, "state.json"), "utf8")) as StagingState;
    if (state.source === source && state.done && typeof state.done === "object") return state;
  } catch {}
  return { source, done: {} };
}
function writeState(staging: string, state: StagingState) {
  writeFileSync(resolve(staging, "state.json.tmp"), JSON.stringify(state));
  renameSync(resolve(staging, "state.json.tmp"), resolve(staging, "state.json"));
}

// Retries a transfer a few times (dropped connections, a checksum that did
// not match); a refusal by the source (4xx) stops at once.
async function withRetries<T>(fn: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new MoveError("Abgebrochen.");
    try {
      return await fn();
    } catch (error) {
      const status = (error as MoveError).status || 0;
      if (attempt >= attempts || (status >= 400 && status < 500 && status !== 408 && status !== 416 && status !== 429)) throw error;
      await new Promise((done) => setTimeout(done, Math.min(500 * 2 ** attempt, 8000)));
    }
  }
}

// Pulls everything into `staging` (<data>/move-incoming): flowplan.sqlite,
// uploads/<id>, extras/<name>. Run again after an interruption or for the
// final sync: only what is new, changed or incomplete is fetched, and files
// the source no longer has leave the staging folder.
export async function pullInstance(source: MoveSource, staging: string, options: { onProgress?: (p: MoveProgress) => void; signal?: AbortSignal; concurrency?: number } = {}) {
  const base = sourceBase(source.url, source.allowHttp);
  mkdirSync(resolve(staging, "uploads"), { recursive: true });
  mkdirSync(resolve(staging, "extras"), { recursive: true });
  const progress: MoveProgress = { phase: "manifest", bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, transferred: 0, startedAt: Date.now(), etaSeconds: null };
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    const seconds = (now - progress.startedAt) / 1000;
    const rate = seconds > 1 ? progress.transferred / seconds : 0;
    progress.etaSeconds = progress.phase === "done" ? 0 : rate > 0 ? Math.round((progress.bytesTotal - progress.bytesDone) / rate) : null;
    options.onProgress?.({ ...progress });
  };
  report(true);
  // Hashing every upload on the source can take a while the first time.
  const manifest = await moveJson<MoveManifest>(source, "/api/move/manifest", { timeoutMs: 30 * 60_000 });
  if (manifest.format !== MOVE_FORMAT) throw new MoveError("Die Quelle spricht ein anderes Umzugsformat – bitte beide Instanzen auf dieselbe Version bringen.");
  for (const file of [...manifest.files, ...manifest.extras])
    if (!UPLOAD_NAME.test(file.name) && !MOVE_EXTRAS.includes(file.name)) throw new MoveError("Die Quelle nennt eine ungültige Datei.");
  const state = readState(staging, base);
  const uploads = resolve(staging, "uploads"),
    extras = resolve(staging, "extras");
  // Gone at the source since the first copy.
  const wanted = new Set(manifest.files.map((f) => f.name));
  for (const name of readdirSync(uploads)) {
    const plain = name.replace(/\.part$/, "");
    if (!wanted.has(plain)) {
      rmSync(resolve(uploads, name), { force: true });
      delete state.done[`uploads/${plain}`];
    }
  }
  for (const name of readdirSync(extras))
    if (!manifest.extras.some((f) => f.name === name.replace(/\.part$/, ""))) {
      rmSync(resolve(extras, name), { force: true });
      delete state.done[`extras/${name}`];
    }
  const fresh = (key: string, file: MoveFile, path: string) => state.done[key] === file.sha256 && existsSync(path) && statSync(path).size === file.size;
  progress.filesTotal = manifest.files.length + manifest.extras.length;
  progress.bytesTotal = manifest.snapshot.size + [...manifest.files, ...manifest.extras].reduce((n, f) => n + f.size, 0);
  // The database snapshot: new with every manifest; a partial one resumes
  // only while it is the same snapshot.
  progress.phase = "database";
  report(true);
  // One file with its share of the progress; a retry first takes back
  // what the failed attempt had counted (a resumed part file counts again).
  const tracked = async (path: string, dest: string, file: { size: number; sha256: string }) => {
    const part = `${dest}.part`;
    let counted = 0;
    await withRetries(async () => {
      progress.bytesDone -= counted;
      counted = existsSync(part) ? statSync(part).size : 0;
      progress.bytesDone += counted;
      await downloadFile(source, path, dest, file, (n) => {
        counted += n;
        progress.bytesDone += n;
        progress.transferred += n;
        report();
      });
    }, options.signal);
    progress.bytesDone += file.size - counted;
  };
  const database = resolve(staging, "flowplan.sqlite");
  if (state.snapshot?.id !== manifest.snapshot.id || !state.snapshot.done || !existsSync(database)) {
    if (state.snapshot?.id !== manifest.snapshot.id) rmSync(`${database}.part`, { force: true });
    rmSync(database, { force: true });
    state.snapshot = { id: manifest.snapshot.id, sha256: manifest.snapshot.sha256, done: false };
    writeState(staging, state);
    await tracked(`/api/move/database?snapshot=${encodeURIComponent(manifest.snapshot.id)}`, database, manifest.snapshot);
    state.snapshot.done = true;
    writeState(staging, state);
  } else progress.bytesDone += manifest.snapshot.size;
  progress.phase = "files";
  report(true);
  const queue = manifest.files.slice();
  let failed = false;
  let sinceSave = 0;
  const worker = async () => {
    while (queue.length && !failed) {
      if (options.signal?.aborted) throw new MoveError("Abgebrochen.");
      const file = queue.shift()!;
      const key = `uploads/${file.name}`,
        dest = resolve(uploads, file.name);
      if (fresh(key, file, dest)) progress.bytesDone += file.size;
      else {
        rmSync(dest, { force: true });
        try {
          await tracked(`/api/move/file/${file.name}`, dest, file);
        } catch (error) {
          failed = true;
          throw error;
        }
        state.done[key] = file.sha256;
        if (++sinceSave >= 25) {
          sinceSave = 0;
          writeState(staging, state);
        }
      }
      progress.filesDone++;
      report();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, 8)) }, worker));
  } finally {
    writeState(staging, state);
  }
  progress.phase = "extras";
  report(true);
  for (const file of manifest.extras) {
    const key = `extras/${file.name}`,
      dest = resolve(extras, file.name);
    if (fresh(key, file, dest)) progress.bytesDone += file.size;
    else {
      rmSync(dest, { force: true });
      await tracked(`/api/move/extra/${file.name}`, dest, file);
      state.done[key] = file.sha256;
      writeState(staging, state);
    }
    progress.filesDone++;
  }
  progress.phase = "done";
  progress.etaSeconds = 0;
  report(true);
  return { manifest, progress };
}

export type MoveSummary = { createdAt: string; users: number; workspaces: number; pages: number; files: number; source: string; kind: "move" };
// The pulled database must be intact and look like a Flowplan database.
export function checkStagedDatabase(staging: string, manifest: Pick<MoveManifest, "createdAt">, source: string): MoveSummary {
  const path = resolve(staging, "flowplan.sqlite");
  if (!existsSync(path)) throw new MoveError("Die Datenbank der Quelle fehlt noch.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").get() as Record<string, string>;
    if (Object.values(check)[0] !== "ok") throw new MoveError("Die übertragene Datenbank ist beschädigt.");
    const count = (table: string) => Number((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);
    return {
      createdAt: manifest.createdAt,
      users: count("users"),
      workspaces: count("workspaces"),
      pages: count("pages"),
      files: readdirSync(resolve(staging, "uploads")).filter((n) => UPLOAD_NAME.test(n)).length,
      source,
      kind: "move",
    };
  } catch (error) {
    if (error instanceof MoveError) throw error;
    throw new MoveError("Die übertragene Datenbank ist keine gültige Flowplan-Datenbank.");
  } finally {
    db.close();
  }
}

// Hands the staging folder to the restore on the next start (the same
// <data>/restore-pending as Administration → Aus Sicherung wiederherstellen,
// lib/instance-restore-apply.ts and docker/entrypoint.sh): the previous
// state is kept as pre-move-<time>.
export function stageMove(dataDir: string, staging: string, summary: MoveSummary) {
  const pending = resolve(dataDir, "restore-pending");
  for (const name of readdirSync(resolve(staging, "uploads"))) if (name.endsWith(".part")) rmSync(resolve(staging, "uploads", name), { force: true });
  for (const name of MOVE_EXTRAS) if (existsSync(resolve(staging, "extras", name))) renameSync(resolve(staging, "extras", name), resolve(staging, name));
  rmSync(resolve(staging, "extras"), { recursive: true, force: true });
  rmSync(resolve(staging, "state.json"), { force: true });
  rmSync(resolve(staging, "flowplan.sqlite.part"), { force: true });
  writeFileSync(resolve(staging, "MOVE"), summary.source);
  writeFileSync(resolve(staging, "READY"), JSON.stringify(summary));
  rmSync(pending, { recursive: true, force: true });
  renameSync(staging, pending);
}
