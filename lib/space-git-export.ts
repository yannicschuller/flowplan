// Git export of a space (#35): the owner of a space sets up a repository
// in the space settings, and Flowplan writes the space export (the Markdown
// ZIP of lib/markdown-export.ts, unpacked) into it daily or weekly – one
// commit per run, only when something changed. Export only: nothing is
// read back from the repository.
//
// It runs as the owner, with exactly what they may read (private spaces
// and pages of others stay out). It ends with their role: turning it off,
// a new owner, the space in the trash, the owner leaving the workspace,
// becoming a guest or deleting their account remove the settings with the
// sealed token (triggers in lib/db.ts) and the working copy in
// <data>/git-export/spaces/<spaceId>/.
//
// The administrator only switches it on (environment):
//   SPACE_GIT_EXPORT=true                        off by default
//   SPACE_GIT_ALLOWED_HOSTS=git.example.org,…    only these Git servers
// Without the list any public https server is fine. The transport resolves
// and pins every address (lib/safe-fetch.ts) and follows no redirects, so
// an address typed in by a person never reaches internal services.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import type { HttpClient } from "isomorphic-git";
import { z } from "zod";
import { all, audit, one, run } from "./db";
import { HttpError } from "./auth";
import { isGuest, memberRole } from "./permissions";
import { pinnedLookup, privateAddress } from "./safe-fetch";
import { openSecret, sealSecret } from "./secret-box";
import { exportMarkdown } from "./markdown-export";
import { readZip } from "./archive";
import { withContentLocale } from "./content-locale";
import { userLocale } from "./user-locale";
import { commitAndPush, prepareRepo, type GitTarget } from "./git-export";
import type { Identity, Space, User } from "./types";

const HOUR_MS = 3600_000,
  DAY_MS = 24 * HOUR_MS;
const INTERVAL = { daily: DAY_MS, weekly: 7 * DAY_MS } as const;
// What the Git server may send back in one answer (a fetch of the branch).
const MAX_RESPONSE = 1024 * 1024 * 1024;

export type SpaceGitRun = { at: number; commit: string | null; files: number; pushed: boolean; error: string | null };
type Row = {
  space_id: string;
  user_id: string;
  url: string;
  branch: string;
  username: string;
  token: string;
  frequency: keyof typeof INTERVAL;
  history: number;
  last_run: string | null;
};

export const spaceGitEnabled = () => process.env.SPACE_GIT_EXPORT === "true";
export const spaceGitHosts = () =>
  (process.env.SPACE_GIT_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
// Plain http and local servers only for tests, never in production.
const testServer = () => process.env.FLOWPLAN_GIT_ALLOW_HTTP === "1" && process.env.NODE_ENV !== "production";
const spacesDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data", "git-export", "spaces");
const copyDir = (spaceId: string) => resolve(spacesDir(), z.uuid().parse(spaceId));
// The token opens only for the space it was saved for.
const aad = (spaceId: string) => `space-git:${spaceId}`;
const runtime = globalThis as unknown as { flowplanSpaceGitRunning?: Set<string> };
const running = (runtime.flowplanSpaceGitRunning ??= new Set());

// An address people may enter: https, no credentials, on an allowed server,
// not an internal address written as a number.
export function checkedGitUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "Ungültige Adresse.");
  }
  if (!(url.protocol === "https:" || (testServer() && url.protocol === "http:")))
    throw new HttpError(400, "Nur https-Adressen sind erlaubt.");
  if (url.username || url.password)
    throw new HttpError(400, "Die Adresse darf keine Zugangsdaten enthalten – das Token gehört in sein eigenes Feld.");
  if (url.search || url.hash || url.pathname.length < 2) throw new HttpError(400, "Ungültige Adresse.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const hosts = spaceGitHosts();
  if (hosts.length && !hosts.includes(host) && !hosts.includes(url.host.toLowerCase()))
    throw new HttpError(400, "Dieser Git-Server ist auf dieser Instanz nicht freigegeben.");
  if (!testServer() && isIP(host) && privateAddress(host)) throw new HttpError(400, "Interne Adressen sind nicht erlaubt.");
  return url.href;
}

// The HTTP transport for isomorphic-git: only the configured server, every
// address resolved, checked and pinned, no redirects (a 3xx fails the run).
export function safeGitHttp(gitUrl: string, allowPrivate = testServer()): HttpClient {
  const origin = new URL(gitUrl).origin;
  return {
    async request({ url, method = "GET", headers = {}, body }) {
      const target = new URL(url);
      if (target.origin !== origin) throw new Error("Nur der eingetragene Git-Server ist erlaubt.");
      const host = target.hostname.replace(/^\[|\]$/g, "");
      if (!allowPrivate && isIP(host) && privateAddress(host)) throw new Error("Interne Adressen sind nicht erlaubt.");
      const chunks: Uint8Array[] = [];
      if (body) for await (const chunk of body) chunks.push(chunk);
      const payload = Buffer.concat(chunks);
      const send = target.protocol === "http:" ? httpRequest : httpsRequest;
      return new Promise((done, fail) => {
        const req = send(
          target,
          {
            method,
            headers: { ...headers, ...(body ? { "content-length": String(payload.length) } : {}) },
            timeout: 60_000,
            lookup: pinnedLookup(allowPrivate) as never,
          },
          (res) =>
            done({
              url,
              method,
              statusCode: res.statusCode || 0,
              statusMessage: res.statusMessage || "",
              headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")])),
              body: limited(res),
            }),
        );
        req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung.")));
        req.on("error", fail);
        req.end(payload);
      });
    },
  };
}
async function* limited(res: IncomingMessage) {
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_RESPONSE) {
      res.destroy();
      throw new Error("Die Antwort des Git-Servers ist zu groß.");
    }
    yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
  }
}

// Only the owner of the space, as a full member, signed in themselves.
function requireGitOwner(user: Identity, spaceId: string) {
  if (!spaceGitEnabled()) throw new HttpError(404, "Der Git-Export für Bereiche ist auf dieser Instanz nicht eingeschaltet.");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  const space = one<Space>("SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL", z.uuid().parse(spaceId));
  if (!space) throw new HttpError(404, "Bereich nicht gefunden.");
  if (space.owner_id !== user.id || !memberRole(user, space.workspace_id) || isGuest(user, space.workspace_id))
    throw new HttpError(403, "Nur wer den Bereich besitzt, richtet den Git-Export ein.");
  return space;
}
const lastRun = (row: Pick<Row, "last_run"> | undefined) => (row?.last_run ? (JSON.parse(row.last_run) as SpaceGitRun) : null);
const nextRun = (row: Row) => {
  const last = lastRun(row);
  if (!last) return null;
  return last.at + (last.error ? HOUR_MS : INTERVAL[row.frequency] - 30 * 60_000);
};

// What the settings show: never the token, only whether one is stored.
// People who do not own the space see nothing of it.
export function spaceGitStatus(user: Identity, spaceId: string) {
  try {
    requireGitOwner(user, spaceId);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return { available: false as const };
    throw error;
  }
  const row = one<Row>("SELECT * FROM space_git_exports WHERE space_id=?", spaceId);
  return {
    available: true as const,
    configured: !!row,
    url: row?.url || "",
    branch: row?.branch || "main",
    username: row?.username || "",
    tokenSet: !!row?.token,
    frequency: row?.frequency || "daily",
    history: !!row?.history,
    last: lastRun(row),
    next: row ? nextRun(row) : null,
    running: running.has(spaceId),
    allowedHosts: spaceGitHosts(),
  };
}

const settings = z
  .object({
    spaceId: z.uuid(),
    enabled: z.boolean(),
    url: z.string().max(500).optional(),
    branch: z
      .string()
      .trim()
      .max(100)
      .regex(/^(?!-|\/)(?!.*(\.\.|\/\/|@\{|\.lock$|\/$))[A-Za-z0-9._\/-]+$/, "Ungültiger Branch-Name.")
      .optional(),
    username: z.string().trim().min(1).max(100).regex(/^[^:\s]+$/, "Ungültiger Benutzername.").optional(),
    token: z.string().trim().max(1000).regex(/^\S*$/, "Ungültiges Token.").optional(),
    frequency: z.enum(["daily", "weekly"]).optional(),
    history: z.boolean().optional(),
  })
  .passthrough();

// Saves or turns off the export (command "space.gitExport", in its
// transaction). A new address needs the token again, so a stored token
// never goes to another server than the one it was entered for.
export function saveSpaceGitExport(user: Identity, input: unknown) {
  const b = settings.parse(input);
  const space = requireGitOwner(user, b.spaceId);
  const existing = one<Row>("SELECT * FROM space_git_exports WHERE space_id=?", space.id);
  if (!b.enabled) {
    run("DELETE FROM space_git_exports WHERE space_id=?", space.id);
    if (existing) audit(user.id, "space.gitExport.off", space.id);
    return spaceGitStatus(user, space.id);
  }
  const url = checkedGitUrl(b.url || "");
  const branch = b.branch || "main";
  const moved = !existing || existing.url !== url || existing.branch !== branch;
  let token = existing?.token || "";
  if (b.token) token = sealSecret(b.token, aad(space.id));
  else if (!existing || existing.url !== url)
    throw new HttpError(400, existing ? "Für eine neue Adresse bitte das Zugangstoken neu eingeben." : "Bitte ein Zugangstoken mit Schreibrechten eingeben.");
  if (!b.username) throw new HttpError(400, "Bitte den Benutzernamen für das Token eingeben.");
  const now = Date.now();
  run(
    `INSERT INTO space_git_exports(space_id,user_id,url,branch,username,token,frequency,history,last_run,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,?)
     ON CONFLICT(space_id) DO UPDATE SET user_id=excluded.user_id,url=excluded.url,branch=excluded.branch,username=excluded.username,token=excluded.token,frequency=excluded.frequency,history=excluded.history,updated_at=excluded.updated_at${moved ? ",last_run=NULL" : ""}`,
    space.id,
    user.id,
    url,
    branch,
    b.username,
    token,
    b.frequency || existing?.frequency || "daily",
    (b.history ?? !!existing?.history) ? 1 : 0,
    now,
    now,
  );
  // Another repository or branch starts from a fresh working copy.
  if (moved && !running.has(space.id)) rmSync(copyDir(space.id), { recursive: true, force: true });
  audit(user.id, existing ? "space.gitExport.update" : "space.gitExport.on", space.id);
  return spaceGitStatus(user, space.id);
}

// Working copies whose settings are gone (turned off, owner changed, space
// or account deleted). Runs after such commands and with every scheduler
// round.
export function sweepSpaceGitCopies() {
  const root = spacesDir();
  if (!existsSync(root)) return;
  for (const name of readdirSync(root))
    if (!running.has(name) && !one("SELECT 1 FROM space_git_exports WHERE space_id=?", name)) rmSync(resolve(root, name), { recursive: true, force: true });
}

// The owner as they would be signed in, without SSO groups: reading pages
// depends on memberships and grants, not on groups.
function exporter(row: Row): { owner: Identity; space: Space } | null {
  const user = one<User>("SELECT * FROM users WHERE id=? AND disabled=0", row.user_id);
  const space = one<Space>("SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL", row.space_id);
  if (!user || !space || space.owner_id !== user.id) return null;
  const owner: Identity = { ...user, groups: [], isAdmin: false };
  if (!memberRole(owner, space.workspace_id) || isGuest(owner, space.workspace_id)) return null;
  return { owner, space };
}
// Messages from Git servers may name addresses; the token never shows.
const cleanError = (message: string, token: string) =>
  (token ? message.split(token).join("…") : message).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "…").slice(0, 300);
// Top-level entries of the working copy that belong to the export: the
// space's index.md and README.txt and the folders of top-level pages
// (<title>-<id8>). Other files in the repository stay untouched.
const EXPORTED = /^(index\.md|README\.txt|.+-[0-9a-f]{8})$/;

async function exportSpace(row: Row, now: number): Promise<SpaceGitRun | null> {
  const found = exporter(row);
  if (!found) {
    // The owner no longer owns the space: the export ends.
    run("DELETE FROM space_git_exports WHERE space_id=? AND user_id=?", row.space_id, row.user_id);
    sweepSpaceGitCopies();
    return null;
  }
  if (running.has(row.space_id)) throw new HttpError(409, "Der Git-Export dieses Bereichs läuft gerade.");
  running.add(row.space_id);
  let token = "";
  let result: SpaceGitRun;
  try {
    token = openSecret(row.token, aad(row.space_id));
    // Checked again: the administrator may have changed the list.
    const url = checkedGitUrl(row.url);
    const target: GitTarget = { dir: copyDir(row.space_id), url, branch: row.branch, username: row.username, token, http: safeGitHttp(url) };
    const { bytes } = await withContentLocale(userLocale(found.owner.id), () =>
      exportMarkdown(found.owner, { spaceId: row.space_id, format: "zip", includeSubpages: true, history: !!row.history }),
    );
    const entries = await readZip(bytes as Buffer, { foreign: true, maxEntries: 20000 });
    const { options, remote } = await prepareRepo(target);
    // Removed first (symbolic links themselves, never what they point to),
    // then written anew: pages that left the space disappear from Git.
    const tops = new Set([...entries.keys()].map((name) => name.split("/")[0]));
    for (const name of readdirSync(/* turbopackIgnore: true */ target.dir))
      if (name !== ".git" && (tops.has(name) || EXPORTED.test(name))) rmSync(resolve(target.dir, name), { recursive: true, force: true });
    for (const [name, data] of entries) {
      const path = resolve(target.dir, name);
      if (!path.startsWith(target.dir + "/") || path.startsWith(resolve(target.dir, ".git") + "/")) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    }
    const pushed = await commitAndPush(target, options, now);
    result = { at: now, commit: pushed.commit ?? remote, files: pushed.changes, pushed: !!pushed.commit, error: null };
  } catch (error) {
    result = { at: now, commit: lastRun(row)?.commit ?? null, files: 0, pushed: false, error: cleanError(String((error as Error).message || error), token) };
  } finally {
    running.delete(row.space_id);
  }
  run("UPDATE space_git_exports SET last_run=? WHERE space_id=? AND user_id=?", JSON.stringify(result), row.space_id, row.user_id);
  // Turned off while it ran: the copy goes now.
  sweepSpaceGitCopies();
  return result;
}

// "Run now" in the space settings.
export async function runSpaceGitExport(user: Identity, spaceId: string) {
  const space = requireGitOwner(user, spaceId);
  const row = one<Row>("SELECT * FROM space_git_exports WHERE space_id=? AND user_id=?", space.id, user.id);
  if (!row) throw new HttpError(404, "Der Git-Export ist für diesen Bereich nicht eingerichtet.");
  await exportSpace(row, Date.now());
  return spaceGitStatus(user, space.id);
}

// With the backup worker (lib/scheduled-backup.ts): every space whose
// interval has passed, one after another; failed runs again after an hour.
export async function runDueSpaceGitExports(now = Date.now()) {
  sweepSpaceGitCopies();
  if (!spaceGitEnabled()) return [];
  const results: SpaceGitRun[] = [];
  for (const row of all<Row>("SELECT * FROM space_git_exports ORDER BY updated_at")) {
    const next = nextRun(row);
    if ((next !== null && now < next) || running.has(row.space_id)) continue;
    const result = await exportSpace(row, now).catch((error) => {
      console.error("Space Git export failed", error);
      return null;
    });
    if (result) results.push(result);
  }
  return results;
}

// Admin → Instance: how many spaces use it and their last errors – without
// addresses or content.
export function spaceGitOverview() {
  const rows = all<{ last_run: string | null; workspace: string; owner: string }>(
    "SELECT g.last_run,w.name workspace,u.name owner FROM space_git_exports g JOIN spaces s ON s.id=g.space_id JOIN workspaces w ON w.id=s.workspace_id JOIN users u ON u.id=g.user_id ORDER BY g.updated_at DESC",
  );
  const failing = rows
    .map((row) => ({ last: lastRun(row), workspace: row.workspace, owner: row.owner }))
    .filter((row) => row.last?.error)
    .map((row) => ({ at: row.last!.at, error: row.last!.error!, workspace: row.workspace, owner: row.owner }))
    .slice(0, 20);
  return { enabled: spaceGitEnabled(), allowedHosts: spaceGitHosts(), spaces: rows.length, failing };
}
