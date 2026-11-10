// Moving a whole instance to another server ("Instanz umziehen",
// Administration → Speicher & Sicherung), admins only.
//
// On the OLD instance (source): "Umzug vorbereiten" creates a one-time move
// token (shown once, stored as a hash, valid 24 hours, revocable, after a
// step-up re-authentication). With it, and only for these endpoints
// (app/api/move/[...path]/route.ts), the new instance reads a consistent
// database snapshot, every upload, the instance's key files and a report of
// its configuration (names and keyed hashes, never values); it may switch
// the source to read-only for the final copy and mark it as moved.
//
// On the NEW instance (target): "Von anderer Instanz übernehmen" pulls all
// of that server to server (lib/instance-move-pull.ts) through the SSRF-safe
// lookup of lib/safe-fetch.ts, resumable, with progress; runs the pre-flight
// check against the source; fetches the last state after the source became
// read-only; and hands everything to the restore on the next start (kept as
// pre-move-<time>), exactly like a restore from a backup.
import { snapshotDatabase } from "./db-snapshot";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import nodemailer from "nodemailer";
import { audit, one, run, schemaVersion } from "./db";
import { appUrl, cookieName, hash, HttpError } from "./auth";
import type { Identity } from "./types";
import { allow } from "./action-limits";
import { clientAddress } from "./client-address";
import { securityEvent } from "./security-events";
import { pinnedLookup, privateAddress } from "./safe-fetch";
import { encryptionKeys, currentKeyId } from "./encryption";
import { openSecret, sealSecret } from "./secret-box";
import { secretKeyIds, secretsKeySource } from "./ai/secrets";
import { mailConfig } from "./mail";
import { bucketFetch, storageConfig } from "./storage";
import { confirmsWithPassword } from "./account-deletion";
import { passwordLogin } from "./local-auth";
import { verifyLdapPassword } from "./ldap-auth";
import type { Locale } from "./i18n";
import { INCOMING_KEY, MOVE_KEY, readOnlyState } from "./instance-read-only";
import {
  INCOMING_DIR,
  MOVE_EXTRAS,
  MOVE_FORMAT,
  MOVE_TOKEN_PREFIX,
  MoveError,
  UPLOAD_NAME,
  checkStagedDatabase,
  fileSha256,
  moveJson,
  pullInstance,
  sourceBase,
  stageMove,
  type MoveFile,
  type MoveManifest,
  type MoveProgress,
  type MoveSource,
  type MoveSummary,
} from "./instance-move-pull";

export const MOVE_TOKEN_HOURS = 24;
const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
export const movePrivateAllowed = () => process.env.FLOWPLAN_MOVE_ALLOW_PRIVATE === "true";

async function readSetting<T>(key: string): Promise<T | null> {
  const row = await one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", key);
  try {
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}
async function writeSetting(key: string, value: unknown) {
  if (value === null) await run("DELETE FROM instance_settings WHERE key=?", key);
  else await run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
}

/* ---------- Source: the move token ---------- */

type SourceState = {
  id: string;
  // SHA-256 of the token; the token itself is shown once and never stored.
  hash: string;
  createdAt: number;
  createdBy: string;
  expiresAt: number;
  revokedAt?: number | null;
  // The move is done (the target applied it): the token is used up.
  usedAt?: number | null;
  lastUsedAt?: number | null;
  readOnlyAt?: number | null;
  movedTo?: string | null;
  redirect?: boolean;
};
const sourceState = async () => await readSetting<SourceState>(MOVE_KEY);
export const tokenUsable = (s: SourceState | null, now = Date.now()) => !!s && !!s.hash && !s.revokedAt && !s.usedAt && s.expiresAt > now;

// For the administration: never the token or its hash.
export async function moveSourceStatus(now = Date.now()) {
  const s = await sourceState();
  if (s?.hash && !tokenUsable(s, now)) removeSnapshots();
  const ro = await readOnlyState();
  if (!s) return { token: null, readOnly: ro.readOnly, readOnlyAt: null, movedTo: null, redirect: false };
  return {
    token: s.hash
      ? {
          id: s.id,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          lastUsedAt: s.lastUsedAt ?? null,
          usedAt: s.usedAt ?? null,
          revokedAt: s.revokedAt ?? null,
          active: tokenUsable(s, now),
        }
      : null,
    readOnly: ro.readOnly,
    readOnlyAt: s.readOnlyAt ?? null,
    movedTo: s.movedTo ?? null,
    redirect: !!s.redirect,
  };
}

// A new token replaces any earlier one. The caller has done the step-up.
export async function prepareMove(user: Identity, now = Date.now()) {
  const token = MOVE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const previous = await sourceState();
  const state: SourceState = {
    id: randomUUID(),
    hash: hash(token),
    createdAt: now,
    createdBy: user.id,
    expiresAt: now + MOVE_TOKEN_HOURS * 3_600_000,
    readOnlyAt: previous?.readOnlyAt ?? null,
    movedTo: previous?.movedTo ?? null,
    redirect: previous?.redirect ?? false,
  };
  await writeSetting(MOVE_KEY, state);
  removeSnapshots();
  await audit(user.id, "instance.move.prepare", state.id, `bis ${new Date(state.expiresAt).toISOString()}`);
  return { token, url: appUrl().replace(/\/+$/, ""), expiresAt: state.expiresAt, id: state.id };
}
export async function revokeMove(user: Identity, now = Date.now()) {
  const s = await sourceState();
  if (!s?.hash) throw new HttpError(404, "Es gibt kein Umzugstoken.");
  await writeSetting(MOVE_KEY, { ...s, revokedAt: s.revokedAt ?? now });
  removeSnapshots();
  await audit(user.id, "instance.move.revoke", s.id);
  return await moveSourceStatus(now);
}
// Lifts the read-only state (a move that was called off). After a finished
// move it also forgets the new address.
export async function unfreezeSource(user: Identity) {
  const s = await sourceState();
  if (!s) return await moveSourceStatus();
  await writeSetting(MOVE_KEY, { ...s, readOnlyAt: null, movedTo: null, redirect: false });
  await audit(user.id, "instance.move.unfreeze", s.id);
  return await moveSourceStatus();
}
export async function setMoveRedirect(user: Identity, on: boolean) {
  const s = await sourceState();
  if (!s?.movedTo) throw new HttpError(409, "Diese Instanz ist noch nicht umgezogen.");
  await writeSetting(MOVE_KEY, { ...s, redirect: on });
  await audit(user.id, "instance.move.redirect", s.id, on ? "on" : "off");
  return await moveSourceStatus();
}

/* ---------- Source: the token's endpoints ---------- */

const limits = globalThis as unknown as { flowplanMoveFailures?: Map<string, number[]> };
const FAIL_WINDOW = 15 * 60_000,
  FAIL_MAX = 10;
function recentFailures(address: string, now: number) {
  const map = (limits.flowplanMoveFailures ??= new Map<string, number[]>());
  const list = (map.get(address) || []).filter((at: number) => at > now - FAIL_WINDOW);
  map.set(address, list);
  return list;
}
// The move token of a request: Authorization: Bearer fpmove_…. Wrong or
// stale tokens count per address; ten within 15 minutes lock the address
// out of these endpoints. `kind` limits each kind of request on its own.
export async function authorizeMove(req: Request, kind: "manifest" | "file" | "env" | "freeze" | "finish", now = Date.now()) {
  const address = clientAddress(req.headers) || "unknown";
  if (recentFailures(address, now).length >= FAIL_MAX) {
    securityEvent("instance.move_refused", { headers: req.headers, detail: "limit" });
    throw new HttpError(429, "Zu viele ungültige Umzugsanfragen. Bitte in 15 Minuten erneut versuchen.");
  }
  if (!allow(`move-ip:${address}`, 1200, 60_000, now)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith(`Bearer ${MOVE_TOKEN_PREFIX}`) ? header.slice(7).trim() : "";
  const s = await sourceState();
  const given = Buffer.from(hash(token || "-"), "hex"),
    stored = Buffer.from(s?.hash || "0".repeat(64), "hex");
  const matches = !!token && given.length === stored.length && timingSafeEqual(given, stored);
  if (!matches || !tokenUsable(s, now)) {
    // A token that expired before the move was done leaves no database copy behind.
    if (!tokenUsable(s, now)) removeSnapshots();
    recentFailures(address, now).push(now);
    securityEvent("instance.move_refused", { headers: req.headers, detail: !matches ? "wrong token" : s?.usedAt ? "used" : s?.revokedAt ? "revoked" : "expired" });
    throw new HttpError(401, "Ungültiges oder abgelaufenes Umzugstoken.");
  }
  const perHour = { manifest: 30, env: 60, freeze: 10, finish: 10, file: 1_000_000 }[kind];
  if (!allow(`move-${kind}:${s!.id}`, perHour, 3_600_000, now) || !allow(`move-token:${s!.id}`, 3000, 60_000, now))
    throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  if (!s!.lastUsedAt || now - s!.lastUsedAt > 60_000) await writeSetting(MOVE_KEY, { ...s, lastUsedAt: now });
  return { state: s!, token };
}

// The database snapshot of the move: a consistent copy (VACUUM INTO, the
// same as the instance backup) without the move's own state, so the new
// instance starts neither read-only nor with the token.
const snapshotDir = () => resolve(dataDir(), "tmp");
const SNAPSHOT = /^move-snapshot-([0-9a-f-]{36})\.sqlite$/;
function removeSnapshots(keep = "") {
  try {
    for (const name of readdirSync(snapshotDir())) if (SNAPSHOT.test(name) && name !== keep) rmSync(resolve(snapshotDir(), name), { force: true });
  } catch {}
}
export function snapshotPath(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const path = resolve(snapshotDir(), `move-snapshot-${id}.sqlite`);
  return existsSync(path) ? path : null;
}
export async function createSnapshot() {
  mkdirSync(snapshotDir(), { recursive: true });
  const id = randomUUID(),
    name = `move-snapshot-${id}.sqlite`,
    path = resolve(snapshotDir(), name);
  await snapshotDatabase(path);
  const copy = new DatabaseSync(path);
  try {
    copy.prepare("DELETE FROM instance_settings WHERE key IN (?,?)").run(MOVE_KEY, INCOMING_KEY);
  } finally {
    copy.close();
  }
  removeSnapshots(name);
  return { id, size: statSync(path).size, sha256: await fileSha256(path) };
}
// SHA-256 of the uploads, kept while name, size and time stay the same: the
// final sync after the first copy hashes only what changed.
const hashes = globalThis as unknown as { flowplanMoveHashes?: Map<string, { size: number; mtime: number; sha256: string }> };
async function hashedFiles(dir: string, names: string[]) {
  const cache = (hashes.flowplanMoveHashes ??= new Map());
  const out: MoveFile[] = [];
  const queue = names.slice();
  const worker = async () => {
    while (queue.length) {
      const name = queue.shift()!;
      const path = resolve(dir, name);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      const cached = cache.get(path);
      const sha256 = cached && cached.size === info.size && cached.mtime === info.mtimeMs ? cached.sha256 : await fileSha256(path);
      cache.set(path, { size: info.size, mtime: info.mtimeMs, sha256 });
      out.push({ name, size: info.size, sha256 });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export async function moveManifest(): Promise<MoveManifest> {
  const dir = dataDir(),
    uploads = resolve(dir, "uploads");
  const snapshot = await createSnapshot();
  const names = existsSync(uploads) ? readdirSync(uploads).filter((n) => UPLOAD_NAME.test(n)) : [];
  return {
    format: MOVE_FORMAT,
    createdAt: new Date().toISOString(),
    appUrl: appUrl().replace(/\/+$/, ""),
    readOnly: (await readOnlyState()).readOnly,
    snapshot,
    files: await hashedFiles(uploads, names),
    extras: await hashedFiles(dir, MOVE_EXTRAS.filter((n) => existsSync(resolve(dir, n)))),
  };
}
export function movePath(kind: "file" | "extra", name: string) {
  if (kind === "file" ? !UPLOAD_NAME.test(name) : !MOVE_EXTRAS.includes(name)) return null;
  const path = kind === "file" ? resolve(dataDir(), "uploads", name) : resolve(dataDir(), name);
  return existsSync(path) ? path : null;
}
export async function freezeSource(state: SourceState, now = Date.now()) {
  if (!state.readOnlyAt) {
    await writeSetting(MOVE_KEY, { ...(await sourceState()), readOnlyAt: now });
    await audit("", "instance.move.freeze", state.id);
  }
  return { readOnly: true };
}
export async function finishSource(state: SourceState, input: unknown, now = Date.now()) {
  const { target } = z.object({ target: z.string().max(500) }).parse(input);
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new HttpError(400, "Ungültige Adresse der neuen Instanz.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new HttpError(400, "Ungültige Adresse der neuen Instanz.");
  await writeSetting(MOVE_KEY, { ...(await sourceState()), readOnlyAt: state.readOnlyAt ?? now, movedTo: url.origin, usedAt: now });
  removeSnapshots();
  await audit("", "instance.move.finish", state.id, url.origin);
  return { ok: true };
}

export const MOVE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
// A file, whole or from the byte the Range header names (the target resumes
// an interrupted transfer there).
export function serveMoveFile(path: string, range: string | null) {
  const size = statSync(path).size;
  const match = range ? /^bytes=(\d+)-$/.exec(range.trim()) : null;
  if (range && !match) throw new HttpError(416, "Nur Bereiche der Form bytes=<start>- sind möglich.");
  const start = match ? Number(match[1]) : 0;
  if (start > size || (match && start === size && size > 0))
    return new Response(null, { status: 416, headers: { ...MOVE_HEADERS, "Content-Range": `bytes */${size}` } });
  const body = size === 0 ? null : (Readable.toWeb(createReadStream(path, { start })) as ReadableStream);
  return new Response(body, {
    status: match ? 206 : 200,
    headers: {
      ...MOVE_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size - start),
      "Accept-Ranges": "bytes",
      ...(match ? { "Content-Range": `bytes ${start}-${size - 1}/${size}` } : {}),
    },
  });
}


/* ---------- Configuration report: names and keyed hashes ---------- */

// Exact names and prefixes the move compares. Values are never sent: each
// one is an HMAC keyed with the move token, so the report says only
// "same", "different" or "missing" and cannot be looked up without it.
// Prefixes only where every such name is Flowplan's (a container also
// carries other variables).
const NAMES = [
  "APP_URL",
  "FLOWPLAN_ENCRYPTION_KEY",
  "FLOWPLAN_ENCRYPTION_KEY_FILE",
  "FLOWPLAN_ENCRYPTION_KEY_PREVIOUS",
  "FLOWPLAN_SECRETS_KEY",
  "FLOWPLAN_SECRETS_KEY_FILE",
  "FLOWPLAN_LITESTREAM",
  "LITESTREAM_SSE_C_KEY",
  "FLOWPLAN_LOCAL_LOGIN",
  "FLOWPLAN_TRUSTED_PROXIES",
  "PLUGIN_ALLOWED_ORIGINS",
  "DRAWIO_URL",
  "PUSH_RELAY",
  "PUSH_RELAY_URL",
  "MOBILE_PUSH",
  "MOBILE_PUSH_CONTENT",
  "SESSION_HOURS",
  "SESSION_REMEMBER",
  "SESSION_IDLE_HOURS",
  "SESSION_MAX_DAYS",
  "SESSION_GROUPS_HOURS",
  "SESSION_APP_REMEMBER",
  "SESSION_APP_DAYS",
  "OLLAMA_URL",
  "INBOUND_MAIL_DOMAIN",
  "INBOUND_MAIL_AUTHSERV_ID",
];
const PREFIXES = ["OIDC_", "S3_", "SMTP_", "APNS_", "WEB_PUSH_", "FLOWPLAN_AI", "WHISPER_", "LDAP_", "GOOGLE_CALENDAR_", "MS_CALENDAR_", "INBOUND_IMAP_"];
export const MOVE_ENV_GROUPS: { id: string; match: (name: string) => boolean }[] = [
  { id: "oidc", match: (n) => n.startsWith("OIDC_") },
  { id: "s3", match: (n) => n.startsWith("S3_") || n === "FLOWPLAN_LITESTREAM" || n === "LITESTREAM_SSE_C_KEY" },
  { id: "smtp", match: (n) => n.startsWith("SMTP_") },
  { id: "push", match: (n) => /^(APNS_|PUSH_RELAY|WEB_PUSH_|MOBILE_PUSH)/.test(n) },
  { id: "ai", match: (n) => /^(FLOWPLAN_AI|OLLAMA_|WHISPER_)/.test(n) },
  { id: "other", match: () => true },
];
const comparedName = (name: string) => NAMES.includes(name) || PREFIXES.some((p) => name.startsWith(p));
export const envSalt = (token: string) => createHash("sha256").update("flowplan-move-env\0").update(token).digest();
export type EnvReport = {
  appUrl: string;
  schema: number;
  encryption: { current: string | null; all: string[] };
  secrets: { current: string | null; env: string[]; file: string | null; source: string };
  vars: Record<string, string | null>;
};
export async function envReport(token: string, env: Record<string, string | undefined> = process.env): Promise<EnvReport> {
  const salt = envSalt(token);
  const vars: Record<string, string | null> = {};
  for (const name of [...new Set([...NAMES, ...Object.keys(env).filter(comparedName)])].sort()) {
    const value = env[name]?.trim();
    vars[name] = value ? createHmac("sha256", salt).update(name).update("\0").update(value).digest("base64url") : null;
  }
  let encryption = { current: null as string | null, all: [] as string[] };
  try {
    encryption = { current: currentKeyId() || null, all: encryptionKeys().all.map((k) => k.id.toString("hex")) };
  } catch {}
  let secrets = { current: null as string | null, env: [] as string[], file: null as string | null, source: "file" };
  try {
    secrets = { ...secretKeyIds(), source: secretsKeySource() };
  } catch {}
  let origin = "";
  try {
    origin = new URL(env.APP_URL || appUrl()).origin;
  } catch {}
  return { appUrl: origin, schema: await schemaVersion(), encryption, secrets, vars };
}

export type PreflightLevel = "ok" | "warn" | "error";
export type PreflightItem = { id: string; level: PreflightLevel; code: string; names?: string[]; missing?: string[]; differs?: string[]; added?: string[]; source?: string; target?: string; message?: string };
// Source report against the target's own, both made with the same token.
// Codes, not texts: the administration words them in the reader's language.
export function comparePreflight(source: EnvReport, target: EnvReport): PreflightItem[] {
  const items: PreflightItem[] = [];
  // Version: a database from newer code than the target's cannot be opened safely.
  if (source.schema && target.schema && source.schema > target.schema) items.push({ id: "schema", level: "error", code: "schema.older", source: String(source.schema), target: String(target.schema) });
  else items.push({ id: "schema", level: "ok", code: source.schema < target.schema ? "schema.newer" : "schema.same", source: String(source.schema), target: String(target.schema) });
  // FLOWPLAN_ENCRYPTION_KEY: backups, the objects in S3 and the stored secrets.
  const enc = source.encryption.current;
  if (!enc && !target.encryption.current) items.push({ id: "encryption", level: "ok", code: "encryption.none" });
  else if (enc && target.encryption.current === enc) items.push({ id: "encryption", level: "ok", code: "encryption.same" });
  else if (enc && target.encryption.all.includes(enc)) items.push({ id: "encryption", level: "ok", code: "encryption.previous" });
  else if (enc) items.push({ id: "encryption", level: "error", code: target.encryption.current ? "encryption.differs" : "encryption.missing" });
  else items.push({ id: "encryption", level: "warn", code: "encryption.added" });
  // Stored secrets (lib/ai/secrets.ts: AI keys, calendar and issue-sync
  // connections, two-factor secrets, webhook signing secrets, addresses and
  // credentials, the Git connections of databases, inbound mail keys, chat
  // apps): sealed with the first key; the generated secrets.key moves along.
  const needed = source.secrets.current;
  const available = [...target.secrets.env, ...(source.secrets.file ? [source.secrets.file] : [])];
  if (!needed || available.includes(needed)) items.push({ id: "secrets", level: "ok", code: source.secrets.source === "file" && needed === source.secrets.file ? "secrets.file" : "secrets.same" });
  else items.push({ id: "secrets", level: "error", code: "secrets.missing" });
  // APP_URL: passkeys, OIDC redirect, CalDAV, the apps, webhooks, links.
  items.push(
    source.appUrl && source.appUrl === target.appUrl
      ? { id: "url", level: "ok", code: "url.same", source: source.appUrl }
      : { id: "url", level: "warn", code: "url.differs", source: source.appUrl, target: target.appUrl },
  );
  const names = [...new Set([...Object.keys(source.vars), ...Object.keys(target.vars)])].filter(
    (n) => !/^(APP_URL|FLOWPLAN_ENCRYPTION_KEY.*|FLOWPLAN_SECRETS_KEY.*)$/.test(n),
  );
  const done = new Set<string>();
  for (const group of MOVE_ENV_GROUPS) {
    const own = names.filter((n) => !done.has(n) && group.match(n));
    own.forEach((n) => done.add(n));
    const used = own.filter((n) => source.vars[n] || target.vars[n]);
    if (!used.length) continue;
    const missing = used.filter((n) => source.vars[n] && !target.vars[n]);
    const differs = used.filter((n) => source.vars[n] && target.vars[n] && source.vars[n] !== target.vars[n]);
    const added = used.filter((n) => !source.vars[n] && target.vars[n]);
    // A missing sign-in or bucket stops more than a missing AI model.
    const level: PreflightLevel = missing.length ? (group.id === "oidc" && missing.some((n) => /ISSUER|CLIENT_ID/.test(n)) ? "error" : "warn") : differs.length ? "warn" : "ok";
    items.push({ id: `env.${group.id}`, level, code: `env.${group.id}`, names: used, missing, differs, added });
  }
  // The same bucket on both sides: Litestream of both instances would
  // write into it.
  const sameBucket = ["S3_BUCKET", "S3_ENDPOINT"].every((n) => source.vars[n] && source.vars[n] === target.vars[n]) && (source.vars.S3_PREFIX ?? null) === (target.vars.S3_PREFIX ?? null);
  if (sameBucket) items.push({ id: "s3.bucket", level: "warn", code: "s3.same-bucket" });
  return items;
}

// What the target itself can reach: S3, SMTP, OIDC.
export async function reachability(): Promise<PreflightItem[]> {
  const items: PreflightItem[] = [];
  const failure = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
  if (!storageConfig()) items.push({ id: "reach.s3", level: "ok", code: "reach.s3.off" });
  else
    try {
      const response = await bucketFetch("?list-type=2&max-keys=1", { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // A Litestream replica in the bucket: the target could start from it.
      const prefix = storageConfig()!.prefix;
      const replica = await bucketFetch(`?list-type=2&max-keys=1&prefix=${encodeURIComponent(`${prefix ? `${prefix}/` : ""}db/`)}`, { signal: AbortSignal.timeout(8000) });
      const text = replica.ok ? await replica.text() : "";
      items.push({ id: "reach.s3", level: "ok", code: /<Key>/.test(text) ? "reach.s3.replica" : "reach.s3.ok" });
    } catch (e) {
      items.push({ id: "reach.s3", level: "error", code: "reach.s3.error", message: failure(e) });
    }
  const mail = mailConfig();
  if (!mail) items.push({ id: "reach.smtp", level: "warn", code: "reach.smtp.off" });
  else {
    const transport = nodemailer.createTransport({ host: mail.host, port: mail.port, secure: mail.secure, auth: mail.user ? { user: mail.user, pass: mail.password } : undefined, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000 });
    try {
      await transport.verify();
      items.push({ id: "reach.smtp", level: "ok", code: "reach.smtp.ok", target: `${mail.host}:${mail.port}` });
    } catch (e) {
      items.push({ id: "reach.smtp", level: "error", code: mail.port === 25 || mail.port === 465 ? "reach.smtp.port" : "reach.smtp.error", target: `${mail.host}:${mail.port}`, message: failure(e) });
    } finally {
      transport.close();
    }
  }
  if (!process.env.OIDC_ISSUER) items.push({ id: "reach.oidc", level: "ok", code: "reach.oidc.off" });
  else
    try {
      const { oidcConfig } = await import("./oidc");
      await Promise.race([oidcConfig(), new Promise((_, reject) => setTimeout(() => reject(new Error("Zeitüberschreitung.")), 10_000))]);
      items.push({ id: "reach.oidc", level: "ok", code: "reach.oidc.ok", target: new URL(process.env.OIDC_ISSUER).host });
    } catch (e) {
      items.push({ id: "reach.oidc", level: "error", code: "reach.oidc.error", message: failure(e) });
    }
  return items;
}

/* ---------- Target: pulling from the source ---------- */

type Incoming = {
  source: string;
  token: string; // sealed (lib/secret-box.ts)
  startedAt: number;
  startedBy: string;
  firstCopyAt?: number | null;
  finalAt?: number | null;
  stagedAt?: number | null;
  error?: string | null;
  manifestCreatedAt?: string;
};
type Job = { kind: "copy" | "final"; progress: MoveProgress | null; controller: AbortController; promise: Promise<void> };
const jobs = globalThis as unknown as { flowplanMoveJob?: Job | null };
const incoming = async () => await readSetting<Incoming>(INCOMING_KEY);
const stagingDir = () => resolve(dataDir(), INCOMING_DIR);

// "Fresh": nothing besides the first admin and the example workspace.
export async function instanceContent() {
  const count = async (sql: string) => Number((await one<{ n: number }>(sql))?.n || 0);
  const users = await count("SELECT count(*) n FROM users"),
    workspaces = await count("SELECT count(*) n FROM workspaces"),
    pages = await count("SELECT count(*) n FROM pages"),
    files = await count("SELECT count(*) n FROM files");
  return { users, workspaces, pages, files, fresh: users <= 1 && workspaces <= 1 && files === 0 && pages <= 12 };
}

// The source's address, refused when it is internal (unless
// FLOWPLAN_MOVE_ALLOW_PRIVATE=true: home servers in the LAN or a VPN).
function moveSource(url: string, token: string): MoveSource {
  const allowPrivate = movePrivateAllowed();
  let base: string;
  try {
    base = sourceBase(url, allowPrivate);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const host = new URL(base).hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && isIP(host) && privateAddress(host)) {
    securityEvent("blocked.ssrf", { detail: host });
    throw new HttpError(400, "Interne Adressen sind nur mit FLOWPLAN_MOVE_ALLOW_PRIVATE=true erlaubt.");
  }
  return { url: base, token, lookup: pinnedLookup(allowPrivate), allowHttp: allowPrivate };
}
const fromIncoming = (state: Incoming) => moveSource(state.source, openSecret(state.token, "instance-move"));
// Errors of the pull as the administration shows them.
function asHttp(e: unknown) {
  if (e instanceof HttpError) return e;
  if (e instanceof MoveError) return new HttpError(e.status >= 400 && e.status < 500 ? (e.status === 401 ? 400 : e.status) : 502, e.message);
  const message = (e as Error)?.message || "";
  return new HttpError(502, /Interne Adressen/.test(message) ? "Interne Adressen sind nur mit FLOWPLAN_MOVE_ALLOW_PRIVATE=true erlaubt." : `Die Quelle ist nicht erreichbar: ${message}`);
}

export async function moveTargetStatus() {
  const state = await incoming();
  const job = jobs.flowplanMoveJob;
  return {
    allowPrivate: movePrivateAllowed(),
    content: await instanceContent(),
    incoming: state
      ? {
          source: state.source,
          startedAt: state.startedAt,
          firstCopyAt: state.firstCopyAt ?? null,
          finalAt: state.finalAt ?? null,
          stagedAt: state.stagedAt ?? null,
          error: state.error ?? null,
        }
      : null,
    job: job ? { kind: job.kind, progress: job.progress } : null,
  };
}

function runJob(kind: Job["kind"], state: Incoming) {
  const controller = new AbortController();
  const job: Job = { kind, progress: null, controller, promise: Promise.resolve() };
  jobs.flowplanMoveJob = job;
  job.promise = (async () => {
    try {
      const { manifest } = await pullInstance(fromIncoming(state), stagingDir(), { signal: controller.signal, onProgress: (p) => (job.progress = p) });
      const now = Date.now();
      await writeSetting(INCOMING_KEY, { ...(await incoming()), error: null, manifestCreatedAt: manifest.createdAt, ...(kind === "copy" ? { firstCopyAt: now } : { finalAt: now }) });
    } catch (e) {
      if (!controller.signal.aborted) {
        const message = asHttp(e).message;
        if (await incoming()) await writeSetting(INCOMING_KEY, { ...(await incoming()), error: message });
      }
    } finally {
      if (jobs.flowplanMoveJob === job) jobs.flowplanMoveJob = null;
    }
  })();
  return job;
}
const busy = () => {
  if (jobs.flowplanMoveJob) throw new HttpError(409, "Die Übertragung läuft bereits.");
};

export async function startIncoming(user: Identity, input: unknown) {
  busy();
  const { url, token, confirm } = z.object({ url: z.string().trim().min(1).max(500), token: z.string().trim().max(200), confirm: z.boolean().optional() }).parse(input);
  if (!token.startsWith(MOVE_TOKEN_PREFIX) || token.length < 40) throw new HttpError(400, "Das ist kein Umzugstoken (es beginnt mit fpmove_).");
  if (!(await instanceContent()).fresh && !confirm) throw new HttpError(409, "Diese Instanz hat schon Inhalte. Bitte bestätige, dass alles ersetzt wird.");
  if ((await readOnlyState()).readOnly) throw new HttpError(409, "Diese Instanz ist selbst Quelle eines Umzugs.");
  const source = moveSource(url, token);
  // The token of this very instance: it would pull from itself. (The
  // address alone says nothing: a move that keeps the domain pulls from
  // the same APP_URL before the DNS switch.)
  if ((await sourceState())?.hash === hash(token)) throw new HttpError(400, "Das ist das Umzugstoken dieser Instanz – es gehört auf die neue Instanz.");
  // The token and the address work: the configuration report answers.
  try {
    await moveJson(source, "/api/move/env", { timeoutMs: 20_000 });
  } catch (e) {
    throw asHttp(e);
  }
  rmSync(stagingDir(), { recursive: true, force: true });
  const state: Incoming = { source: source.url, token: sealSecret(token, "instance-move"), startedAt: Date.now(), startedBy: user.id };
  await writeSetting(INCOMING_KEY, state);
  await audit(user.id, "instance.move.start", "", source.url);
  runJob("copy", state);
  return await moveTargetStatus();
}
// Continues an interrupted transfer (or the final sync) where it stopped.
export async function resumeIncoming() {
  busy();
  const state = await incoming();
  if (!state) throw new HttpError(404, "Es läuft kein Umzug.");
  runJob(state.firstCopyAt ? "final" : "copy", state);
  return await moveTargetStatus();
}
export async function preflight() {
  const state = await incoming();
  if (!state) throw new HttpError(404, "Es läuft kein Umzug.");
  const source = fromIncoming(state);
  let remote: EnvReport;
  try {
    remote = await moveJson<EnvReport>(source, "/api/move/env", { timeoutMs: 20_000 });
  } catch (e) {
    throw asHttp(e);
  }
  const items = [...comparePreflight(remote, await envReport(source.token)), ...await reachability()];
  return { checkedAt: Date.now(), items };
}
// "Quelle schreibschützen und letzten Stand holen".
export async function finalSync(user: Identity) {
  busy();
  const state = await incoming();
  if (!state?.firstCopyAt) throw new HttpError(409, "Zuerst muss die erste Kopie fertig sein.");
  const source = fromIncoming(state);
  try {
    await moveJson(source, "/api/move/freeze", { method: "POST", body: {}, timeoutMs: 20_000 });
  } catch (e) {
    throw asHttp(e);
  }
  await audit(user.id, "instance.move.final", "", state.source);
  await writeSetting(INCOMING_KEY, { ...state, finalAt: null, error: null });
  runJob("final", { ...state, finalAt: null });
  return await moveTargetStatus();
}
// Hands the copy to the restore on the next start and tells the source
// where the instance lives now (which also uses up the token).
export async function applyIncoming(user: Identity) {
  busy();
  const state = await incoming();
  if (!state?.finalAt) throw new HttpError(409, "Zuerst den letzten Stand holen (Quelle schreibschützen).");
  let summary: MoveSummary;
  try {
    summary = checkStagedDatabase(stagingDir(), { createdAt: state.manifestCreatedAt || new Date(state.finalAt).toISOString() }, state.source);
  } catch (e) {
    throw asHttp(e);
  }
  const source = fromIncoming(state);
  stageMove(dataDir(), stagingDir(), summary);
  await writeSetting(INCOMING_KEY, { ...state, stagedAt: Date.now() });
  let notified = true;
  try {
    await moveJson(source, "/api/move/finish", { method: "POST", body: { target: new URL(appUrl()).origin }, timeoutMs: 20_000 });
  } catch {
    notified = false;
  }
  await audit(user.id, "instance.move.applied", "", JSON.stringify({ ...summary, notified }));
  return { summary, notified };
}
export async function cancelIncoming(user: Identity) {
  const job = jobs.flowplanMoveJob;
  job?.controller.abort();
  jobs.flowplanMoveJob = null;
  rmSync(stagingDir(), { recursive: true, force: true });
  const state = await incoming();
  await writeSetting(INCOMING_KEY, null);
  if (state) await audit(user.id, "instance.move.cancel", "", state.source);
  return await moveTargetStatus();
}
// Waits for a running transfer (tests, the command line).
export const moveJobDone = () => jobs.flowplanMoveJob?.promise ?? Promise.resolve();

/* ---------- Step-up before the token is shown ---------- */

// Accounts with a password (local or LDAP) confirm with it; SSO accounts
// must have signed in within the last 15 minutes. API tokens never may.
export const STEP_UP_MINUTES = 15;
export async function stepUpKind(user: Identity): Promise<"password" | "recent-sign-in"> {
  return await confirmsWithPassword(user.id) || await one("SELECT 1 FROM ldap_accounts WHERE user_id=?", user.id) ? "password" : "recent-sign-in";
}
export async function requireStepUp(user: Identity, req: Request, password: unknown, locale: Locale) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (user.demo) throw new HttpError(403, "Im Demo-Modus nicht verfügbar.");
  const pass = typeof password === "string" ? password : "";
  if (await confirmsWithPassword(user.id)) {
    if (!pass) throw new HttpError(403, "Bitte bestätige mit deinem Passwort.");
    const email = (await one<{ email: string }>("SELECT email FROM local_accounts WHERE user_id=?", user.id))!.email;
    const { userId } = await passwordLogin({ email, password: pass }, clientAddress(req.headers), locale);
    if (userId !== user.id) throw new HttpError(403, "E-Mail-Adresse oder Passwort stimmt nicht.");
    return "password";
  }
  if (await one("SELECT 1 FROM ldap_accounts WHERE user_id=?", user.id)) {
    if (!pass) throw new HttpError(403, "Bitte bestätige mit deinem Passwort.");
    if (!(await verifyLdapPassword(user.id, pass))) throw new HttpError(403, "Das Passwort stimmt nicht.");
    return "ldap";
  }
  let token = "";
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) token = decodeURIComponent(value.join("="));
  }
  const created = token ? (await one<{ created_at: number | null }>("SELECT created_at FROM sessions WHERE token=?", hash(token)))?.created_at : null;
  if (!created || Date.now() - created > STEP_UP_MINUTES * 60_000)
    throw new HttpError(403, "Bitte melde dich ab und erneut an, um den Umzug vorzubereiten (Anmeldung höchstens 15 Minuten alt).");
  return "recent-sign-in";
}
