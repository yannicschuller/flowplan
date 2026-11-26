// API fuzzing, locally only (tests/fuzz-api.test.ts runs a short, seeded
// round in CI; `npm run fuzz` – scripts/fuzz-api.ts – a long one on demand).
//
// A world of two workspaces is seeded: A (owner, an editor, a viewer and a
// guest with one shared page) and B (an outsider's own). Then every
// /api/command action – names and the input fields each one reads taken
// from lib/api.ts itself – gets random and malformed payloads as the
// editor, the viewer, the guest and the outsider, through the real route
// handler (app/api/[...path]/handler.ts, in a Next request scope from
// tests/helpers/next-request.ts), as JSON text: wrong types, missing
// fields, huge strings, lone surrogates, __proto__/constructor keys,
// 1e400 (JSON's Infinity), deep nesting, duplicate keys, broken JSON and
// ids of the other workspace; a sweep puts a value nested thousands of
// levels deep into each field in turn (depthSweep). The uploads (POST
// /api/upload, also purpose=page, #569), the phone's capture save (POST
// /api/mobile/capture/save) and a public form (POST /api/forms/[token])
// get malformed multipart and JSON bodies.
//
// The oracle: every answer is a deliberate one – 2xx or 4xx. A 5xx, an
// exception out of the handler, a hang, a polluted Object.prototype, a
// write the actor's role forbids (workspace A's content changed by the
// viewer, the guest or the outsider; members, the owner's private space
// or the workspace itself changed by the editor), a refused upload that
// left a page, a file or a temporary file behind, or pages that point
// across workspaces – each is a finding, with seed, actor and payload.
//
// Nothing here reaches the network: fetch and DNS lookups of other hosts
// than this one are refused (a 5xx after such a refusal is not counted,
// only listed).
import { createHash } from "node:crypto";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Identity } from "../../lib/types";
import { inRequestScope } from "./next-request";

// ---- Randomness ----

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  // mulberry32
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number) {
    return Math.floor(this.next() * n);
  }
  chance(p: number) {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

// ---- No network ----

export const network = { blocked: 0, last: "" };
let networkBlocked = false;
export function blockNetwork() {
  if (networkBlocked) return;
  networkBlocked = true;
  const local = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1";
  const refuse = (what: string) => {
    network.blocked++;
    network.last = what;
    return new Error(`fuzz: network blocked (${what})`);
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw refuse(`fetch ${url.slice(0, 80)}`);
  }) as typeof fetch;
  const lookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as (error: Error | null) => void;
    if (local(host)) return (lookup as (...args: unknown[]) => unknown)(host, ...rest);
    process.nextTick(() => callback(refuse(`dns ${host}`)));
  };
  const promises = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (host: string, ...rest: unknown[]) => {
    if (local(host)) return await (promises as (...args: unknown[]) => Promise<unknown>)(host, ...rest);
    throw refuse(`dns ${host}`);
  };
  // Also for `import { lookup } from "node:dns"`.
  syncBuiltinESMExports();
}

// ---- JSON text generation ----
// Values are generated as JSON text, so a payload can carry what JSON.parse
// makes of a request body but a JS object literal cannot: 1e400 (Infinity),
// lone surrogates, own "__proto__" keys, duplicate keys, broken syntax.

export type Entry = [key: string, json: string];
const q = (s: string) => JSON.stringify(s);
export const objectText = (entries: Entry[]) => `{${entries.map(([k, v]) => `${q(k)}:${v}`).join(",")}}`;

const UUID = () => "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx";
export function randomUuid(rng: Rng) {
  return UUID().replace(/x/g, () => rng.int(16).toString(16));
}

const NASTY_STRINGS = [
  "",
  " ",
  "\u0000",
  "a\u0000b",
  "../../../../etc/passwd",
  "..\\..\\windows\\win.ini",
  "/etc/passwd",
  "%2e%2e%2f%2e%2e%2f",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "javascript:alert(1)",
  "' OR 1=1 --",
  "\"; DROP TABLE pages; --",
  "{{constructor.constructor('return 1')()}}",
  "${7*7}",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "-1",
  "1e400",
  "true",
  "[]",
  "{}",
  "‮evil‬",
  "​‌‍﻿",
  "😀👍🏽👨‍👩‍👧‍👦",
  "𝕳𝖊𝖑𝖑𝖔",
  "Ä Ö Ü ß é ñ 中文 русский العربية",
  "\r\n\r\n",
  "a\rb\nc\td",
  "x".repeat(501),
  "x".repeat(4097),
  "#",
  "?",
  "/",
  ".",
  "..",
  "CON",
  "*",
  "%",
  "_",
  "\\",
  "today",
  "inbox",
  "2026-02-30",
  "9999-12-31T23:59:59Z",
  "0000-00-00",
  "1970-01-01",
  "-271821-04-20",
  "http://127.0.0.1:1/",
  "file:///etc/passwd",
  "data:text/html,<script>alert(1)</script>",
  "#ff0000",
  "rgb(0,0,0)",
  "red",
];
// Strings JSON can carry but well-formed text cannot: lone surrogates.
const RAW_STRINGS = ['"\\ud800"', '"\\udfff"', '"a\\ud83dz"', '"\\u0000\\u0001\\u001f"'];
const NASTY_NUMBERS = ["0", "-0", "1", "-1", "0.5", "-0.5", "1e400", "-1e400", "1e308", "-1e308", "5e-324", "9007199254740993", "-9007199254740993", "2147483648", "4294967296", "1e21", "123456789012345678901234567890", "3.14159", "100000000"];

export class Gen {
  constructor(
    readonly rng: Rng,
    readonly ids: () => { own: string[]; other: string[]; all: string[] },
  ) {}
  string(): string {
    const r = this.rng;
    const roll = r.int(10);
    if (roll < 4) return r.pick(NASTY_STRINGS);
    if (roll < 5) return "x".repeat(r.pick([1000, 10_000, 100_000, 1_000_000]));
    if (roll < 6) return randomUuid(r);
    if (roll < 7) return r.pick(this.ids().all) ?? randomUuid(r);
    if (roll < 8) return String.fromCodePoint(...Array.from({ length: 1 + r.int(20) }, () => r.pick([0x41 + r.int(26), 0xe4, 0x4e2d, 0x1f600 + r.int(50), 0x202e, 0x0301, 0x10ffff, 0xfffd])));
    return Array.from({ length: 1 + r.int(12) }, () => "abcdefghij-_ .:/"[r.int(16)]).join("");
  }
  stringText() {
    return this.rng.chance(0.05) ? this.rng.pick(RAW_STRINGS) : q(this.string());
  }
  number() {
    return this.rng.chance(0.6) ? this.rng.pick(NASTY_NUMBERS) : String(this.rng.int(10) - 3);
  }
  // Any JSON value, `depth` levels deep at most.
  any(depth = 3): string {
    const r = this.rng;
    const roll = r.int(depth > 0 ? 12 : 8);
    switch (roll) {
      case 0:
        return "null";
      case 1:
        return r.chance(0.5) ? "true" : "false";
      case 2:
      case 3:
        return this.number();
      case 4:
      case 5:
      case 6:
      case 7:
        return this.stringText();
      case 8:
      case 9:
        return `[${Array.from({ length: r.int(4) }, () => this.any(depth - 1)).join(",")}]`;
      default:
        return this.object(depth - 1);
    }
  }
  object(depth = 2): string {
    const r = this.rng;
    const entries: Entry[] = [];
    for (let i = r.int(4); i > 0; i--) entries.push([r.chance(0.3) ? r.pick(PROTO_KEYS) : this.string().slice(0, 40), this.any(depth)]);
    return objectText(entries);
  }
  // Structures that stress parsers and recursive walkers.
  monster(): string {
    const r = this.rng;
    switch (r.int(7)) {
      case 0: {
        const n = r.pick([100, 1000, 5000, 20000]);
        return "[".repeat(n) + "]".repeat(n);
      }
      case 1: {
        const n = r.pick([100, 1000, 5000]);
        return '{"a":'.repeat(n) + "1" + "}".repeat(n);
      }
      case 2:
        return `[${Array.from({ length: r.pick([1000, 10000, 50000]) }, () => (r.chance(0.5) ? "0" : '"x"')).join(",")}]`;
      case 3:
        return objectText(Array.from({ length: r.pick([500, 5000]) }, (_, i) => [`k${i}`, "1"] as Entry));
      case 4:
        return objectText(PROTO_KEYS.map((k) => [k, objectText([["polluted", "true"], ["isAdmin", "true"], ["role", '"owner"']])] as Entry));
      case 5:
        return `{"__proto__":{"polluted":true,"isAdmin":true},"constructor":{"prototype":{"polluted":true}}}`;
      default:
        return q("x".repeat(r.pick([100_000, 2_000_000])));
    }
  }
}
export const PROTO_KEYS = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "__defineGetter__"];

// ---- The actions of /api/command, read from lib/api.ts ----

// What the fuzzer knows of an action's input: the fields it reads, and per
// field what its schema wants (learnt from the ZodErrors of plain payloads).
export type Hint = { type?: string; values?: unknown[]; format?: string; nonEmpty?: boolean; keys?: Record<string, Hint> };
export type ActionSpec = { action: string; fields: string[]; hints?: Record<string, Hint> };
export function commandActions(root: string): ActionSpec[] {
  const source = readFileSync(join(root, "lib/api.ts"), "utf8");
  const start = source.indexOf("const execute = async () => {");
  const end = source.indexOf('throw new HttpError(400, "Unbekannte Aktion.")', start);
  if (start < 0 || end < 0) throw new Error("fuzz: the command switch of lib/api.ts was not found");
  const body = source.slice(start, end);
  const matches = [...body.matchAll(/case "([^"]+)":/g)];
  const specs: ActionSpec[] = [];
  let group: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    group.push(m[1]);
    const segment = body.slice(m.index! + m[0].length, i + 1 < matches.length ? matches[i + 1].index : body.length);
    if (!segment.trim()) continue;
    const fields = new Set<string>();
    for (const f of segment.matchAll(/\bb\.(\w+)/g)) fields.add(f[1]);
    // Handed on whole (manageWorkspace(user, b), e2eeCommand(user, action, b …)):
    // the fields the called function reads of its input.
    for (const call of segment.matchAll(/\b(\w+)\(\s*(?:user|writer)\s*,\s*(?:action\s*,\s*)?b\b/g)) for (const f of delegatedFields(root, call[1])) fields.add(f);
    // The shorthands of runCommand: pid() and write() read pageId, wid() workspaceId.
    if (/\b(pid|write)\(\)/.test(segment)) fields.add("pageId");
    if (/\bwid\(\)/.test(segment)) fields.add("workspaceId");
    for (const f of segment.matchAll(/\bb\[["'](\w+)["']\]/g)) fields.add(f[1]);
    // Keys of z.object({ … }) schemas that parse `b` as a whole.
    for (const f of segment.matchAll(/[{,]\s*(\w+)\s*:\s*(?:z\.|uuid\b|str\b|\w+Schema\b)/g)) fields.add(f[1]);
    for (const action of group) specs.push({ action, fields: [...fields].filter((f) => f !== "action") });
    group = [];
  }
  // Only names that are actions (nested switches have other labels).
  const seen = new Set<string>();
  return specs.filter((s) => /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(s.action) && !seen.has(s.action) && seen.add(s.action));
}

let libSources: { file: string; text: string }[] | null = null;
function delegatedFields(root: string, name: string): string[] {
  libSources ??= readdirSync(join(root, "lib"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(join(root, "lib", f), "utf8") }));
  const fields = new Set<string>();
  for (const { text } of libSources) {
    const at = text.search(new RegExp(`export async function ${name}\\s*\\(`));
    if (at < 0) continue;
    const end = text.indexOf("\n}\n", at);
    const body = text.slice(at, end < 0 ? undefined : end);
    // The name of the input parameter: the one after `user`.
    const param = /\(\s*\w+\s*:\s*[\w.]+\s*,\s*(?:action\s*:\s*[^,]+,\s*)?(\w+)/.exec(body)?.[1] ?? "input";
    for (const f of body.matchAll(new RegExp(`\\b(?:${param}|input|raw|body|b)\\.(\\w+)`, "g"))) fields.add(f[1]);
    for (const f of body.matchAll(/[{,]\s*(\w+)\s*:\s*(?:z\.|uuid\b|str\b|\w+Schema\b)/g)) fields.add(f[1]);
    // A schema of the same file that parses the input as a whole.
    for (const schema of body.matchAll(/\b(\w+)\.(?:safe)?[pP]arse\(\s*(?:\w+)\s*\)/g)) {
      const def = text.indexOf(`const ${schema[1]} = z`);
      if (def < 0) continue;
      const block = text.slice(def, text.indexOf("\n});", def) + 1 || def + 2000);
      for (const f of block.matchAll(/^\s{2}(\w+)\s*:/gm)) fields.add(f[1]);
    }
  }
  return [...fields].filter((f) => !["length", "then", "map", "filter", "parse", "safeParse"].includes(f));
}

// Actions the fuzzer leaves out, and why.
export const SKIPPED_ACTIONS: Record<string, string> = {
  // Deletes the acting account; it is restored by nothing cheap.
  "account.delete": "deletes the actor",
  // Fits FSRS parameters for up to half a minute by design (#344).
  "study.optimize": "slow by design",
};

// ---- The world ----

export type Role = "owner" | "editor" | "viewer" | "guest" | "outsider";
export type Actor = { role: Role; user: Identity; token: string; device?: string };
export type World = {
  root: string;
  dir: string;
  actors: Record<Role, Actor>;
  wsA: string;
  wsB: string;
  teamA: string;
  privateA: string;
  teamB: string;
  ids: { own: string[]; other: string[] };
  pages: { doc: string; db: string; board: string; shared: string; privateDoc: string; dbB: string; docB: string };
  rows: { a: string[]; b: string[] };
  fields: string[];
  files: { a: string; b: string };
  // Guests beside the guest (the phones' twin accounts).
  guests: string[];
};

type Db = typeof import("../../lib/db");
type Api = typeof import("../../lib/api");
let modules: {
  db: Db;
  api: Api;
  auth: typeof import("../../lib/auth");
  general: typeof import("../../app/api/[...path]/handler");
  capture: typeof import("../../app/api/mobile/capture/[action]/handler");
  devices: typeof import("../../lib/mobile-devices");
} | null = null;

export const APP_URL = "https://flowplan.example.test";

// FLOWPLAN_DATA_DIR and APP_URL must be set before this is called.
export async function createWorld(root: string): Promise<World> {
  blockNetwork();
  const db = await import("../../lib/db");
  const api = await import("../../lib/api");
  const auth = await import("../../lib/auth");
  const seed = await import("../../lib/seed");
  const general = await import("../../app/api/[...path]/handler");
  const capture = await import("../../app/api/mobile/capture/[action]/handler");
  const devices = await import("../../lib/mobile-devices");
  modules = { db, api, auth, general, capture, devices };
  const { run, id } = db;
  const account = async (role: Role): Promise<Actor> => {
    const uid = id();
    await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, `fuzz-${role}`, `fuzz-${role}@example.test`);
    const user = { id: uid, name: `fuzz-${role}`, email: `fuzz-${role}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
    const { token } = await auth.createSession(uid, [], undefined, {}, new Headers());
    return { role, user, token };
  };
  const actors = {} as Record<Role, Actor>;
  for (const role of ["owner", "editor", "viewer", "guest", "outsider"] as Role[]) actors[role] = await account(role);
  const owner = actors.owner.user;
  const wsA = await seed.createWorkspace(owner.id, "Fuzz A");
  await run("INSERT INTO members VALUES(?,?,?)", wsA, actors.editor.user.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", wsA, actors.viewer.user.id, "viewer");
  await run("INSERT INTO members VALUES(?,?,?)", wsA, actors.guest.user.id, "viewer");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wsA, actors.guest.user.id);
  const wsB = await seed.createWorkspace(actors.outsider.user.id, "Fuzz B");
  const teamA = (await api.bootstrap(owner, wsA)).spaces[0].id;
  const teamB = (await api.bootstrap(actors.outsider.user, wsB)).spaces[0].id;
  const cmd = async (user: Identity, input: Record<string, unknown>) => (await api.command(user, input)) as { id: string };
  const privateA = (await cmd(owner, { action: "space.create", workspaceId: wsA, name: "Owner private", private: true })).id;
  const page = async (user: Identity, ws: string, space: string, title: string, kind = "document") => (await cmd(user, { action: "page.create", workspaceId: ws, spaceId: space, title, kind })).id;
  const doc = await page(owner, wsA, teamA, "Doc A");
  const dbPage = await page(owner, wsA, teamA, "DB A", "database");
  const board = await page(owner, wsA, teamA, "Board A", "whiteboard");
  const shared = await page(owner, wsA, teamA, "Shared with guest");
  const privateDoc = await page(owner, wsA, privateA, "Owner secret");
  const docB = await page(actors.outsider.user, wsB, teamB, "Doc B");
  const dbB = await page(actors.outsider.user, wsB, teamB, "DB B", "database");
  await api.command(owner, { action: "grant.set", resourceId: shared, userId: actors.guest.user.id, role: "viewer" });
  const fieldsOf = async (pid: string, user: Identity) => {
    const current = await api.database(pid);
    await api.command(user, {
      action: "database.update",
      pageId: pid,
      version: current.version,
      fields: [
        { id: "title", name: "Name", type: "text" },
        { id: "num", name: "Number", type: "number" },
        { id: "sel", name: "Status", type: "select", options: ["Open", "Done"] },
        { id: "due", name: "Due", type: "date" },
        { id: "att", name: "Files", type: "files" },
        { id: "done", name: "Done", type: "checkbox" },
      ],
      views: current.views,
    });
  };
  await fieldsOf(dbPage, owner);
  await fieldsOf(dbB, actors.outsider.user);
  const rowsA: string[] = [],
    rowsB: string[] = [];
  for (let i = 0; i < 3; i++) {
    rowsA.push((await cmd(owner, { action: "row.create", pageId: dbPage, cells: { title: `Row ${i}`, num: i } })).id);
    rowsB.push((await cmd(actors.outsider.user, { action: "row.create", pageId: dbB, cells: { title: `B ${i}` } })).id);
  }
  // One stored file per workspace.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = process.env.FLOWPLAN_DATA_DIR!;
  mkdirSync(join(dir, "uploads"), { recursive: true });
  const fileA = id(),
    fileB = id();
  for (const [fid, pid, uid] of [
    [fileA, doc, owner.id],
    [fileB, docB, actors.outsider.user.id],
  ]) {
    writeFileSync(join(dir, "uploads", fid), "hello");
    await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pid, "hello.txt", "text/plain", 5, uid);
  }
  // Device tokens for the phone's capture route.
  for (const actor of Object.values(actors)) {
    const { deviceToken } = await devices.registerMobileDevice(actor.user, auth.hash(actor.token), { installationId: id(), platform: "ios" });
    actor.device = deviceToken;
  }
  const own = [wsA, teamA, privateA, doc, dbPage, board, shared, privateDoc, ...rowsA, fileA, ...Object.values(actors).map((a) => a.user.id)];
  const other = [wsB, teamB, docB, dbB, ...rowsB, fileB];
  return {
    root,
    dir,
    actors,
    wsA,
    wsB,
    teamA,
    privateA,
    teamB,
    ids: { own, other },
    pages: { doc, db: dbPage, board, shared, privateDoc, dbB, docB },
    rows: { a: rowsA, b: rowsB },
    fields: ["title", "num", "sel", "due", "att", "done"],
    files: { a: fileA, b: fileB },
    guests: [],
  };
}

// Roles and memberships as seeded, sessions alive: whatever a
// fuzzed command changed about the actors themselves is put back.
async function restoreActors(world: World) {
  const { run, one, all } = modules!.db;
  const { actors, wsA, wsB } = world;
  const roles: [Role, string, string][] = [
    ["owner", wsA, "owner"],
    ["editor", wsA, "editor"],
    ["viewer", wsA, "viewer"],
    ["guest", wsA, "viewer"],
    ["outsider", wsB, "owner"],
  ];
  for (const [role, ws, memberRole] of roles) {
    const uid = actors[role].user.id;
    await run("UPDATE users SET disabled=0 WHERE id=?", uid);
    await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?) ON CONFLICT DO NOTHING", ws, uid, memberRole);
    await run("UPDATE members SET role=? WHERE workspace_id=? AND user_id=?", memberRole, ws, uid);
  }
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING", wsA, actors.guest.user.id);
  const guests = await all<{ user_id: string }>("SELECT user_id FROM workspace_guests WHERE workspace_id=?", wsA);
  for (const g of guests) if (g.user_id !== actors.guest.user.id && !world.guests.includes(g.user_id)) await run("DELETE FROM workspace_guests WHERE workspace_id=? AND user_id=?", wsA, g.user_id);
  for (const actor of Object.values(actors)) {
    const session = await one("SELECT 1 x FROM sessions WHERE token=?", modules!.auth.hash(actor.token));
    if (!session) actor.token = (await modules!.auth.createSession(actor.user.id, [], undefined, {}, new Headers())).token;
  }
}

// ---- Oracles ----

const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const VOLATILE = /updated_at|viewed|accessed|last_|_at$|position/;
const stable = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.test(k) || k === "deleted_at")));

// What `role` must not change in workspace A, per table (hashed).
export async function protectedState(world: World, role: Role): Promise<Record<string, string>> {
  const { all } = modules!.db;
  const { wsA, actors } = world;
  const state: Record<string, unknown> = {};
  state.workspace = await all("SELECT * FROM workspaces WHERE id=?", wsA);
  state.members = await all("SELECT workspace_id,user_id,role FROM members WHERE workspace_id=? ORDER BY user_id", wsA);
  state.guests = await all("SELECT * FROM workspace_guests WHERE workspace_id=? ORDER BY user_id", wsA);
  // The editor may change team content; the others nothing of A.
  const spaces =
    role === "editor"
      ? await all<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND visibility='private' AND owner_id<>?", wsA, actors.editor.user.id)
      : await all<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND NOT (visibility='private' AND owner_id=?)", wsA, actors[role].user.id);
  const ids = spaces.map((s) => s.id);
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    state.spaces = stable(await all(`SELECT * FROM spaces WHERE id IN (${marks}) ORDER BY id`, ...ids));
    state.pages = stable(await all(`SELECT id,title,icon,cover,kind,parent_id,space_id,workspace_id,deleted_at FROM pages WHERE space_id IN (${marks}) ORDER BY id`, ...ids));
    state.documents = await all(`SELECT d.page_id,d.html FROM documents d JOIN pages p ON p.id=d.page_id WHERE p.space_id IN (${marks}) ORDER BY d.page_id`, ...ids);
    state.databases = await all(`SELECT d.page_id,d.fields,d.views FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.space_id IN (${marks}) ORDER BY d.page_id`, ...ids);
    state.rows = await all(`SELECT r.id,r.page_id,r.cells,r.content FROM rows r JOIN pages p ON p.id=r.page_id WHERE p.space_id IN (${marks}) ORDER BY r.id`, ...ids);
    state.files = await all(`SELECT f.id,f.page_id,f.name FROM files f JOIN pages p ON p.id=f.page_id WHERE p.space_id IN (${marks}) ORDER BY f.id`, ...ids);
    state.grants = await all(`SELECT g.* FROM grants g JOIN pages p ON p.id=g.resource_id WHERE p.space_id IN (${marks}) ORDER BY g.resource_id,g.user_id`, ...ids);
  }
  return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, hashOf(v)]));
}
const changedTables = (before: Record<string, string>, after: Record<string, string>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);

// Pages that point across workspaces, rows of missing pages and the like.
export async function inconsistencies(): Promise<string[]> {
  const { all } = modules!.db;
  const problems: string[] = [];
  const check = async (what: string, sql: string) => {
    const rows = await all<Record<string, unknown>>(sql);
    if (rows.length) problems.push(`${what}: ${JSON.stringify(rows.slice(0, 3))}`);
  };
  await check("page whose parent is in another workspace", "SELECT p.id,p.parent_id FROM pages p JOIN pages q ON q.id=p.parent_id WHERE q.workspace_id<>p.workspace_id");
  await check("page whose space is in another workspace", "SELECT p.id,p.space_id FROM pages p JOIN spaces s ON s.id=p.space_id WHERE s.workspace_id<>p.workspace_id");
  await check("page whose parent is in another space", "SELECT p.id FROM pages p JOIN pages q ON q.id=p.parent_id WHERE q.space_id<>p.space_id");
  await check("page whose parent does not exist", "SELECT p.id FROM pages p WHERE p.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pages q WHERE q.id=p.parent_id)");
  await check("page that is its own parent", "SELECT id FROM pages WHERE parent_id=id");
  await check("row of a missing page", "SELECT r.id FROM rows r WHERE NOT EXISTS(SELECT 1 FROM pages p WHERE p.id=r.page_id)");
  await check("file of a missing page", "SELECT f.id FROM files f WHERE f.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pages p WHERE p.id=f.page_id)");
  await check("database page without its schema", "SELECT p.id FROM pages p WHERE p.kind='database' AND NOT EXISTS(SELECT 1 FROM databases d WHERE d.page_id=p.id)");
  // Stored JSON that no longer reads as what it is (checked here, not in
  // SQL: the same on SQLite and PostgreSQL).
  const notObject = (text: string) => {
    try {
      const value = JSON.parse(text);
      return !value || typeof value !== "object" || Array.isArray(value);
    } catch {
      return true;
    }
  };
  const notArray = (text: string) => {
    try {
      return !Array.isArray(JSON.parse(text));
    } catch {
      return true;
    }
  };
  const badRows = (await all<{ id: string; cells: string }>("SELECT id,cells FROM rows")).filter((r) => notObject(r.cells));
  if (badRows.length) problems.push(`row with cells that are not a JSON object: ${JSON.stringify(badRows.slice(0, 3).map((r) => [r.id, r.cells.slice(0, 60)]))}`);
  const badSchemas = (await all<{ page_id: string; fields: string; views: string }>("SELECT page_id,fields,views FROM databases")).filter((d) => notArray(d.fields) || notArray(d.views));
  if (badSchemas.length) problems.push(`database whose fields or views are not a JSON array: ${JSON.stringify(badSchemas.slice(0, 3).map((d) => [d.page_id, d.fields.slice(0, 60), d.views.slice(0, 60)]))}`);
  return problems;
}

const prototypeKeys = () => Object.getOwnPropertyNames(Object.prototype).sort().join(",");
const PROTOTYPE = prototypeKeys();
const ARRAY_PROTOTYPE = Object.getOwnPropertyNames(Array.prototype).sort().join(",");
function polluted(): string | null {
  if (prototypeKeys() !== PROTOTYPE) return `Object.prototype has new keys: ${Object.getOwnPropertyNames(Object.prototype).join(",")}`;
  if (Object.getOwnPropertyNames(Array.prototype).sort().join(",") !== ARRAY_PROTOTYPE) return "Array.prototype has new keys";
  for (const key of ["polluted", "isAdmin", "role"]) if (key in {}) return `({}).${key} exists`;
  return null;
}

// ---- Calling the routes ----

export type Answer = { status: number; body: string; error?: string; ms: number; network: number };
const errors: unknown[] = [];
let capturing = false;
const originalError = console.error;
console.error = (...args: unknown[]) => {
  if (capturing) errors.push(args.find((a) => a instanceof Error) ?? args.map(String).join(" "));
  else originalError(...args);
};
const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}\n${(e.stack || "").split("\n").slice(1, 12).join("\n")}` : String(e));

async function timed(run: () => Promise<Response>, timeoutMs: number): Promise<Answer> {
  const started = performance.now();
  const blockedBefore = network.blocked;
  errors.length = 0;
  capturing = true;
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      run(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`fuzz: no answer within ${timeoutMs} ms`)), timeoutMs))),
    ]);
    const body = await res.text();
    const logged = errors.length ? errors.map(describe).join("\n---\n") : undefined;
    return { status: res.status, body: body.slice(0, 500), error: logged, ms: performance.now() - started, network: network.blocked - blockedBefore };
  } catch (e) {
    return { status: -1, body: "", error: describe(e), ms: performance.now() - started, network: network.blocked - blockedBefore };
  } finally {
    clearTimeout(timer);
    capturing = false;
  }
}

function sessionRequest(actor: Actor, path: string, body: BodyInit, contentType: string | null, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { origin: APP_URL, cookie: `flowplan_session=${actor.token}`, ...extra };
  if (contentType !== null) headers["content-type"] = contentType;
  return new Request(`${APP_URL}/api/${path}`, { method: "POST", body, headers });
}
async function general(req: Request, path: string[]) {
  const { value, settled } = await inRequestScope(req, () => modules!.general.POST(req as never, { params: Promise.resolve({ path }) }));
  await settled;
  return value;
}
export async function postCommand(actor: Actor, text: string, timeoutMs = 10_000) {
  return await timed(() => general(sessionRequest(actor, "command", text, "application/json"), ["command"]), timeoutMs);
}

// ---- Findings ----

export type Finding = { kind: string; role: Role | "-"; target: string; payload: string; status: number; detail: string; count?: number; also?: string[] };
const short = (text: string, max = 1500) => (text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text);
export function formatFinding(f: Finding) {
  const more = f.count && f.count > 1 ? `\n  seen ${f.count}×, also: ${f.also?.join(", ") || "-"}` : "";
  return `[${f.kind}] ${f.role} ${f.target} → ${f.status}\n  payload: ${short(f.payload)}\n  ${short(f.detail, 3000).replace(/\n/g, "\n  ")}${more}`;
}
// One finding per cause: the error's first line (ids taken out) and the
// first frame in the app's code; forbidden writes per action.
const signature = (f: Finding) => {
  const lines = f.detail.split("\n");
  const frame = lines.find((l) => /^\s*at .*\/(lib|app)\//.test(l))?.replace(/:\d+\)?$/, "") ?? "";
  const head = lines[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").replace(/\d+/g, "N");
  return f.kind === "forbidden-write" || f.kind === "left-behind" ? `${f.kind}|${f.target}|${f.role}` : `${f.kind}|${head}|${frame.trim()}`;
};
class Reporter {
  readonly findings: Finding[] = [];
  private known = new Map<string, Finding>();
  constructor(private log?: (line: string) => void) {}
  add(f: Finding) {
    const key = signature(f);
    const known = this.known.get(key);
    if (known) {
      known.count = (known.count ?? 1) + 1;
      if (known.target !== f.target && !known.also!.includes(f.target) && known.also!.length < 30) known.also!.push(f.target);
      return;
    }
    const added = { ...f, count: 1, also: [] };
    this.known.set(key, added);
    this.findings.push(added);
    this.log?.(formatFinding(added));
  }
}
const crashed = (a: Answer) => a.status < 0 || a.status >= 500;

// ---- Command payloads ----

const PAGE_FIELD = /^(pageId|targetId|sourceId|parentId|databaseId|resourceId|rootId|toPageId|fromPageId|dashboardId|journalId|relatedPageId|linkedPageId|templatePageId)$|PageId$/;
function fieldValue(gen: Gen, world: World, field: string, plausible: boolean): string {
  const r = gen.rng;
  if (!plausible) return r.chance(0.08) ? gen.monster() : gen.any(3);
  const idOf = (own: string[], other: string[]) => q(r.chance(0.75) ? r.pick(own) : r.chance(0.7) ? r.pick(other) : randomUuid(r));
  const pages = Object.values(world.pages);
  if (field === "workspaceId") return idOf([world.wsA], [world.wsB]);
  if (field === "spaceId") return idOf([world.teamA, world.privateA], [world.teamB]);
  if (PAGE_FIELD.test(field)) return idOf(pages.slice(0, 5), [world.pages.docB, world.pages.dbB]);
  if (/^(rowId|parentRowId|recordId|targetRowId)$/.test(field)) return idOf(world.rows.a, world.rows.b);
  if (/^(userId|memberId|ownerId|assigneeId)$/.test(field)) return q(r.pick(Object.values(world.actors)).user.id);
  if (/^(fileId)$/.test(field)) return idOf([world.files.a], [world.files.b]);
  if (/^(fieldId|field|propertyId)$/.test(field)) return q(r.pick(world.fields));
  if (/Ids$/.test(field) || field === "ids" || field === "pageIds" || field === "rowIds")
    return `[${Array.from({ length: r.int(4) }, () => (field.startsWith("row") ? idOf(world.rows.a, world.rows.b) : idOf([...world.ids.own], world.ids.other))).join(",")}]`;
  if (/Id$|^id$/.test(field)) return idOf(world.ids.own, world.ids.other);
  if (field === "version" || /count|index|position|limit|offset|days|size|level|rating|minutes|seconds|order/i.test(field)) return r.chance(0.5) ? String(1 + r.int(4)) : gen.number();
  if (field === "kind") return q(r.pick(["document", "database", "whiteboard", "journal", "dashboard", "notebook", "workflow", "nope"]));
  if (field === "role") return q(r.pick(["owner", "editor", "viewer", "commenter", "guest", "admin"]));
  if (field === "cells") return objectText(world.fields.filter(() => r.chance(0.5)).map((f) => [f, gen.any(2)] as Entry));
  if (/^(private|enabled|allow|value|on|done|checked|resolved|archived|pinned|include\w*|dryRun)$/.test(field)) return r.chance(0.7) ? (r.chance(0.5) ? "true" : "false") : gen.any(1);
  if (/name|title|body|text|html|markdown|query|emoji|icon|color|label|note|description|url|email|message|content|summary/i.test(field)) return gen.stringText();
  return gen.any(2);
}

// A value as the schema wants it (mostly), from the learnt hint.
function hintedValue(gen: Gen, world: World, field: string, hint: Hint | undefined, depth = 0): string {
  const r = gen.rng;
  if (!hint || depth > 3) return fieldValue(gen, world, field, true);
  if (hint.values?.length && r.chance(0.9)) return JSON.stringify(r.pick(hint.values)) ?? "null";
  if (hint.format === "uuid" || hint.format === "guid") {
    const value = fieldValue(gen, world, field, true);
    return /^"[0-9a-f-]{36}"$/.test(value) ? value : q(r.chance(0.8) ? r.pick(world.ids.own) : r.pick(world.ids.other));
  }
  switch (hint.type) {
    case "string": {
      const value = fieldValue(gen, world, field, true);
      const text = value.startsWith('"') ? value : gen.stringText();
      return hint.nonEmpty && /^"\s*"$/.test(text) ? q("x") : text;
    }
    case "number":
    case "int":
      return r.chance(0.7) ? String(r.int(5)) : gen.number();
    case "boolean":
      return r.chance(0.5) ? "true" : "false";
    case "array":
      return hint.keys?.["0"] ? `[${Array.from({ length: 1 + r.int(2) }, () => hintedValue(gen, world, field, hint.keys!["0"], depth + 1)).join(",")}]` : r.chance(0.5) ? "[]" : `[${fieldValue(gen, world, field.replace(/s$/, ""), true)}]`;
    case "object":
    case "record":
      return objectText(Object.entries(hint.keys ?? {}).map(([k, h]) => [k, hintedValue(gen, world, k, h, depth + 1)] as Entry));
    default:
      return fieldValue(gen, world, field, true);
  }
}
function learnHint(hints: Record<string, Hint>, path: readonly PropertyKey[], issue: { code?: string; expected?: string; values?: unknown[]; format?: string }) {
  if (!path.length || typeof path[0] !== "string") return false;
  let hint = (hints[path[0]] ??= {});
  for (const key of path.slice(1)) {
    hint.type ??= typeof key === "number" ? "array" : "object";
    hint.keys ??= {};
    hint = hint.keys[typeof key === "number" ? "0" : String(key)] ??= {};
  }
  const before = JSON.stringify(hint);
  if (issue.code === "invalid_type" && issue.expected) hint.type = issue.expected;
  if (issue.code === "invalid_value" && issue.values) hint.values = issue.values;
  if (issue.code === "invalid_format" && issue.format) hint.format = issue.format;
  if (issue.code === "too_small") hint.nonEmpty = true;
  return JSON.stringify(hint) !== before;
}

// Plain payloads per action, called directly (lib/api.ts command) as the
// editor: what their ZodErrors name becomes the action's hints, until the
// payload passes the schemas or nothing new is learnt.
export async function learnActions(world: World, specs: ActionSpec[], rng: Rng, report: (f: Finding) => void, rounds = 6) {
  const { z } = await import("zod");
  const { HttpError } = modules!.auth;
  const editor = world.actors.editor;
  const gen = new Gen(rng, () => ({ own: world.ids.own, other: world.ids.other, all: [...world.ids.own, ...world.ids.other] }));
  type Issue = import("zod").core.$ZodIssue;
  // One plain call: passed, refused by a schema (its issues) or otherwise.
  const attempt = async (spec: ActionSpec, entries: Entry[]): Promise<Issue[] | null> => {
    const text = objectText([["action", q(spec.action)], ...entries]);
    errors.length = 0;
    capturing = true;
    const blockedBefore = network.blocked;
    try {
      // In a request scope, as the route runs it (cookies(), after()).
      const req = sessionRequest(editor, "command", text, "application/json");
      await (await inRequestScope(req, () => modules!.api.command(editor.user, JSON.parse(text)))).settled;
      return null;
    } catch (e) {
      if (e instanceof z.ZodError) return e.issues;
      if (!(e instanceof HttpError) && network.blocked === blockedBefore) report({ kind: "5xx", role: "editor", target: spec.action, payload: text, status: 500, detail: describe(e) });
      return null;
    } finally {
      capturing = false;
      await restoreActors(world);
    }
  };
  for (const spec of specs) {
    const hints = (spec.hints ??= {});
    for (let round = 0; round < rounds; round++) {
      const fields = [...new Set([...spec.fields, ...Object.keys(hints)])];
      const entries = fields.map((f) => [f, hintedValue(gen, world, f, hints[f])] as Entry);
      const issues = await attempt(spec, entries);
      if (!issues) break;
      let learnt = false;
      for (const issue of issues) learnt = learnHint(hints, issue.path, issue as never) || learnt;
      // `str.parse(b.name)` names no path: the field is the one whose
      // removal changes the complaint.
      const anonymous = issues.find((i) => !i.path.length && !/received undefined/.test(i.message));
      if (anonymous && !learnt)
        for (let i = 0; i < entries.length && i < 12; i++) {
          const without = await attempt(spec, entries.filter((_, j) => j !== i));
          const same = without?.find((x) => !x.path.length && x.message === anonymous.message);
          if (without && !same) {
            learnt = learnHint(hints, [entries[i][0]], anonymous as never) || learnt;
            break;
          }
        }
      if (!learnt) break;
    }
    for (const field of Object.keys(hints)) if (!spec.fields.includes(field)) spec.fields.push(field);
  }
}

// The actions to fuzz, their schemas learnt once per world.
const learnt = new WeakMap<World, ActionSpec[]>();
async function actionSpecs(world: World, rng: Rng, report: (f: Finding) => void, learn: boolean, only?: (action: string) => boolean) {
  let specs = learnt.get(world);
  if (!specs) {
    specs = commandActions(world.root).filter((s) => !(s.action in SKIPPED_ACTIONS));
    if (!learn) return specs.filter((s) => !only || only(s.action));
    await learnActions(world, specs, rng, report);
    learnt.set(world, specs);
  }
  return specs.filter((s) => !only || only(s.action));
}

export function commandPayload(gen: Gen, world: World, spec: ActionSpec, globalFields: string[]): { entries: Entry[]; text: string } {
  const r = gen.rng;
  const entries: Entry[] = [["action", q(spec.action)]];
  const structural = r.int(100);
  if (structural < 3) return { entries, text: r.pick(["{", '{"action":', "[]", "null", '"page.create"', "1e400", "", " ", '{"action":"page.create",}', "\u0000", "{\"action\":\"x\"}{}", "[".repeat(30000)]) };
  if (structural < 6) {
    const text = r.chance(0.5) ? `[${objectText(entries)}]` : objectText([["action", r.pick(["null", "1", "[]", "{}", "true", q(""), q(spec.action.toUpperCase()), q(` ${spec.action}`)])]]);
    return { entries, text };
  }
  const fields = spec.fields.length ? spec.fields : r.shuffle([...globalFields]).slice(0, 4);
  // Mostly well-formed payloads (to get past the schemas, into the code
  // behind them), or one field off, or many.
  const mode = r.int(10);
  const odd = mode < 4 ? -1 : mode < 8 ? r.int(fields.length) : -2;
  fields.forEach((field, i) => {
    if (r.chance(odd === -2 ? 0.15 : 0.03)) return;
    const wrong = odd === -2 ? r.chance(0.3) : i === odd;
    entries.push([field, wrong ? fieldValue(gen, world, field, false) : hintedValue(gen, world, field, spec.hints?.[field])]);
  });
  if (r.chance(0.15)) for (let i = r.int(3) + 1; i > 0; i--) entries.push([r.pick(globalFields), fieldValue(gen, world, r.pick(globalFields), r.chance(0.5))]);
  if (r.chance(0.08)) entries.push([r.pick(PROTO_KEYS), gen.object(1)]);
  if (r.chance(0.04)) entries.push(["action", q(r.pick(["page.delete", "workspace.delete", "admin.user", spec.action]))]);
  return { entries, text: objectText(entries) };
}

// ---- Runs ----

export type RunOptions = {
  seed: number;
  // Payloads per action and role.
  perAction: number;
  roles?: Role[];
  only?: (action: string) => boolean;
  timeoutMs?: number;
  minimize?: boolean;
  // Learn the schemas' wishes first (learnActions); default on.
  learn?: boolean;
  log?: (line: string) => void;
  // Every answer, for looking at what the payloads reach.
  trace?: (role: Role, target: string, answer: Answer) => void;
};
export type RunResult = { findings: Finding[]; calls: number; statuses: Record<string, number>; network: string[]; ms: number };

export async function fuzzCommands(world: World, options: RunOptions): Promise<RunResult> {
  const rng = new Rng(options.seed);
  const gen = new Gen(rng, () => ({ own: world.ids.own, other: world.ids.other, all: [...world.ids.own, ...world.ids.other] }));
  const roles = options.roles ?? (["editor", "viewer", "guest", "outsider"] as Role[]);
  const reporter = new Reporter(options.log);
  const result: RunResult = { findings: reporter.findings, calls: 0, statuses: {}, network: [], ms: 0 };
  const started = performance.now();
  const report = (f: Finding) => reporter.add(f);
  const specs = await actionSpecs(world, rng, report, options.learn !== false, options.only);
  const globalFields = [...new Set(specs.flatMap((s) => s.fields))].sort();
  for (const role of roles) {
    const actor = world.actors[role];
    let before = await protectedState(world, role);
    const order = rng.shuffle(specs.flatMap((s) => Array.from({ length: options.perAction }, () => s)));
    for (const spec of order) {
      const payload = commandPayload(gen, world, spec, globalFields);
      const answer = await postCommand(actor, payload.text, options.timeoutMs);
      options.trace?.(role, spec.action, answer);
      result.calls++;
      const bucket = answer.status < 0 ? "exception" : `${Math.floor(answer.status / 100)}xx`;
      result.statuses[bucket] = (result.statuses[bucket] || 0) + 1;
      if (crashed(answer)) {
        if (answer.network) {
          result.network.push(`${spec.action} (${network.last})`);
        } else {
          let text = payload.text;
          if (options.minimize !== false) text = await minimize(actor, payload.entries, text, answer, options.timeoutMs);
          report({ kind: answer.status === -1 && answer.error?.includes("no answer within") ? "hang" : "5xx", role, target: spec.action, payload: text, status: answer.status, detail: answer.error || answer.body });
        }
      }
      const pollution = polluted();
      if (pollution) {
        report({ kind: "prototype-pollution", role, target: spec.action, payload: payload.text, status: answer.status, detail: pollution });
        for (const key of Object.getOwnPropertyNames(Object.prototype)) if (!PROTOTYPE.split(",").includes(key)) delete (Object.prototype as Record<string, unknown>)[key];
      }
      // A write the role forbids (only answers that claim success can write;
      // a refused one must not have either – checked the same way).
      const after = await protectedState(world, role);
      const changed = changedTables(before, after);
      if (changed.length) report({ kind: "forbidden-write", role, target: spec.action, payload: payload.text, status: answer.status, detail: `changed: ${changed.join(", ")} · answer: ${answer.body}` });
      await restoreActors(world);
      before = changed.length ? await protectedState(world, role) : after;
    }
    for (const problem of await inconsistencies()) report({ kind: "inconsistent", role, target: "database", payload: "(after the role's round)", status: 0, detail: problem });
  }
  result.ms = performance.now() - started;
  return result;
}

// Smaller payloads with the same failure: entries dropped, values made plain.
async function minimize(actor: Actor, entries: Entry[], text: string, first: Answer, timeoutMs?: number): Promise<string> {
  if (!entries.length || text !== objectText(entries)) return text;
  const same = (a: Answer) => crashed(a) && firstLine(a.error) === firstLine(first.error);
  let current = entries;
  let budget = 40;
  for (let i = current.length - 1; i >= 1 && budget > 0; i--) {
    const candidate = current.filter((_, j) => j !== i);
    budget--;
    if (same(await postCommand(actor, objectText(candidate), timeoutMs))) current = candidate;
  }
  for (let i = 1; i < current.length && budget > 0; i++)
    for (const plain of ["null", '""', "0", "{}", "[]", '"x"']) {
      if (current[i][1] === plain || budget-- <= 0) continue;
      const candidate = current.map((e, j) => (j === i ? ([e[0], plain] as Entry) : e));
      if (same(await postCommand(actor, objectText(candidate), timeoutMs))) {
        current = candidate;
        break;
      }
    }
  return objectText(current);
}
const firstLine = (s?: string) => (s || "").split("\n")[0].replace(/[0-9a-f-]{36}/g, "<id>");

// ---- Uploads ----

const BOUNDARY = "----fuzzBoundary7MA4YWxkTrZu0gW";
type Part = { name: string; value?: string; filename?: string; type?: string; data?: Buffer; raw?: string };
function multipart(parts: Part[], boundary = BOUNDARY, close = true) {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = p.raw ?? `form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ""}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${p.type !== undefined ? `Content-Type: ${p.type}\r\n` : ""}\r\n`));
    chunks.push(p.data ?? Buffer.from(p.value ?? ""));
    chunks.push(Buffer.from("\r\n"));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<html><body><script>alert(1)</script></body></html>");
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0xff, 0xd9]);
const FILE_NAMES = ["a.png", "doc.pdf", "", "../../../../etc/passwd", "..\\..\\x.png", "/abs/path.png", "a\u0000.png", "a\".png", "a\r\nX-Evil: 1.png", "😀.png", "x".repeat(300) + ".png", "x".repeat(10_000), ".htaccess", "CON.png", "a.svg", "a.html", "noext", "a.png.exe", "%2e%2e%2fa.png", "‮gnp.exe"];
const MIMES = ["image/png", "application/pdf", "image/svg+xml", "text/html", "application/octet-stream", "", "image/png; charset=utf-8", "x/x", "text/plain", "image/jpeg", "audio/webm", "application/x-msdownload", "image/avif"];

function filePart(r: Rng, name = "file"): Part {
  const data = r.pick([Buffer.alloc(0), PNG, PDF, SVG, HTML, JPEG_HEAD, Buffer.from("hello"), Buffer.from("FPX1rest"), Buffer.alloc(r.pick([1, 70_000, 2_000_000]), 0x61)]);
  return { name, filename: r.chance(0.9) ? r.pick(FILE_NAMES) : undefined, type: r.chance(0.85) ? r.pick(MIMES) : undefined, data };
}

type UploadCase = { label: string; body: Buffer; contentType: string | null; fields: Record<string, string> };
function uploadCase(r: Rng, world: World): UploadCase {
  const fields: Record<string, string> = {};
  const parts: Part[] = [];
  const id = (own: string[], other: string[]) => (r.chance(0.6) ? r.pick(own) : r.chance(0.6) ? r.pick(other) : r.pick([randomUuid(r), "", "x", "../x", "null", "00000000-0000-0000-0000-000000000000"]));
  const purpose = r.pick([undefined, "page", "page", "page", "cover", "comment", "e2ee", "icon", "", "PAGE", "__proto__"]);
  if (purpose !== undefined) fields.purpose = purpose;
  if (purpose === "page" || r.chance(0.2)) {
    if (r.chance(0.9)) fields.spaceId = id([world.teamA, world.privateA], [world.teamB]);
    if (r.chance(0.5)) fields.parentId = id([world.pages.doc, world.pages.privateDoc, world.pages.shared, world.pages.db], [world.pages.docB]);
  }
  if (purpose !== "page" || r.chance(0.2)) if (r.chance(0.9)) fields.pageId = id([world.pages.doc, world.pages.shared, world.pages.privateDoc, world.pages.db, world.pages.board], [world.pages.docB]);
  if (r.chance(0.2)) fields.rowId = id(world.rows.a, world.rows.b);
  if (r.chance(0.15)) fields.fileId = id([world.files.a, randomUuid(r)], [world.files.b]);
  const fieldParts = Object.entries(fields).map(([name, value]) => ({ name, value }) as Part);
  const file = filePart(r);
  // Fields before or after the file, sometimes a second file, sometimes none.
  const layout = r.int(10);
  if (layout < 6) parts.push(...fieldParts, file);
  else if (layout < 8) parts.push(file, ...fieldParts);
  else if (layout < 9) parts.push(...fieldParts, file, filePart(r));
  else parts.push(...fieldParts);
  if (r.chance(0.1)) parts.push({ name: r.pick(["purpose", "spaceId", "pageId"]), value: r.pick(["page", world.teamB, world.pages.docB, ""]) });
  if (r.chance(0.05)) parts.push({ name: "x", raw: r.pick(["form-data", "form-data; name=", 'form-data; name="file"; filename*=UTF-8\'\'%2e%2e%2fa.png', "attachment; filename=a.png", 'form-data; name="a"; name="b"']) });
  let boundary = BOUNDARY;
  let contentType: string | null = `multipart/form-data; boundary=${BOUNDARY}`;
  let close = true;
  const broken = r.int(40);
  if (broken === 0) contentType = "application/json";
  else if (broken === 1) contentType = null;
  else if (broken === 2) contentType = "multipart/form-data";
  else if (broken === 3) contentType = "multipart/form-data; boundary=";
  else if (broken === 4) contentType = `multipart/form-data; boundary=${"b".repeat(200)}`;
  else if (broken === 5) close = false;
  else if (broken === 6) boundary = "other";
  else if (broken === 7) contentType = `multipart/form-data; boundary="${BOUNDARY}"`;
  let body = multipart(parts, boundary, close);
  if (broken === 8) body = body.subarray(0, r.int(body.length));
  if (broken === 9) body = Buffer.from("not a form at all");
  return { label: `purpose=${purpose ?? "-"} layout=${layout} broken=${broken}`, body, contentType, fields };
}
// The size the body states: mostly true, sometimes missing or a lie.
function lengthHeader(r: Rng, body: Buffer): Record<string, string> {
  const roll = r.int(40);
  if (roll === 0) return {};
  if (roll === 1) return { "content-length": "0" };
  if (roll === 2) return { "content-length": String(body.length + 1000) };
  if (roll === 3) return { "content-length": "-1" };
  if (roll === 4) return { "content-length": "99999999999999999999" };
  return { "content-length": String(body.length) };
}
const describeUpload = (c: UploadCase) => `${c.label} ${JSON.stringify(c.fields)} content-type=${c.contentType} (${c.body.length} bytes)`;

async function storedCounts() {
  const { one } = modules!.db;
  return {
    pages: (await one<{ n: number }>("SELECT COUNT(*) n FROM pages"))!.n,
    files: (await one<{ n: number }>("SELECT COUNT(*) n FROM files"))!.n,
  };
}
const incomingLeft = (world: World) => {
  const dir = join(world.dir, "uploads", ".incoming");
  return existsSync(dir) ? readdirSync(dir).length : 0;
};
const uploadedTo = async (fileId: string) =>
  await modules!.db.one<{ workspace_id: string; space_id: string; page_id: string }>("SELECT p.workspace_id,p.space_id,f.page_id FROM files f JOIN pages p ON p.id=f.page_id WHERE f.id=?", fileId);

// Who may store a file on that page: editors of A (not in the owner's
// private space), the outsider in B; comments: whoever may read.
function mayUpload(world: World, role: Role, place: { workspace_id: string; space_id: string; page_id: string }, purpose?: string) {
  if (place.workspace_id === world.wsB) return role === "outsider";
  if (place.space_id === world.privateA) return role === "owner";
  if (role === "editor" || role === "owner") return true;
  // Comment attachments: whoever may read the page (the guest only the page shared with them).
  return purpose === "comment" && (role === "viewer" || (role === "guest" && place.page_id === world.pages.shared));
}

// A device token of an account with the same place as `role`'s: member
// of the same workspace in the same role, the guest's grant.
async function phoneOf(world: World, role: Role) {
  const { run, id } = modules!.db;
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, `fuzz-${role}-phone`, `fuzz-${role}-${uid.slice(0, 8)}@example.test`);
  const user = { id: uid, name: `fuzz-${role}-phone`, email: `fuzz-${role}-${uid.slice(0, 8)}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
  const membership = role === "outsider" ? [world.wsB, "owner"] : [world.wsA, role === "guest" ? "viewer" : role];
  await run("INSERT INTO members VALUES(?,?,?)", membership[0], uid, membership[1]);
  if (role === "guest") {
    await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", world.wsA, uid);
    world.guests.push(uid);
    // The guest's grants, copied (the shared page may be gone by now).
    for (const grant of await modules!.db.all<Record<string, unknown>>("SELECT * FROM grants WHERE user_id=?", world.actors.guest.user.id)) {
      const row = { ...grant, user_id: uid };
      await run(`INSERT INTO grants(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")}) ON CONFLICT DO NOTHING`, ...Object.values(row));
    }
  }
  const { token } = await modules!.auth.createSession(uid, [], undefined, {}, new Headers());
  return (await modules!.devices.registerMobileDevice(user, modules!.auth.hash(token), { installationId: id(), platform: "ios" })).deviceToken;
}

export async function fuzzUploads(world: World, options: { seed: number; count: number; roles?: Role[]; timeoutMs?: number; log?: (line: string) => void; trace?: RunOptions["trace"] }): Promise<RunResult> {
  const r = new Rng(options.seed ^ 0x5eed);
  const roles = options.roles ?? (["editor", "viewer", "guest", "outsider"] as Role[]);
  const reporter = new Reporter(options.log);
  const result: RunResult = { findings: reporter.findings, calls: 0, statuses: {}, network: [], ms: 0 };
  const started = performance.now();
  const report = (f: Finding) => reporter.add(f);
  const phones: Partial<Record<Role, string>> = {};
  for (let i = 0; i < options.count; i++) {
    const role = r.pick(roles);
    const actor = world.actors[role];
    const mobile = r.chance(0.3);
    if (mobile) phones[role] ??= await phoneOf(world, role);
    const before = await storedCounts();
    const stateBefore = await protectedState(world, role);
    let answer: Answer;
    let label: string;
    let purpose: string | undefined;
    if (!mobile) {
      const c = uploadCase(r, world);
      purpose = c.fields.purpose;
      label = describeUpload(c);
      answer = await timed(() => general(sessionRequest(actor, "upload", new Uint8Array(c.body), c.contentType, lengthHeader(r, c.body)), ["upload"]), options.timeoutMs ?? 10_000);
    } else {
      const c = captureCase(r, world);
      label = c.label;
      const device = phones[role]!;
      const req = new Request(`${APP_URL}/api/mobile/capture/save`, {
        method: "POST",
        body: new Uint8Array(c.body),
        headers: { authorization: `Bearer ${device}`, ...(c.contentType ? { "content-type": c.contentType } : {}), ...lengthHeader(r, c.body) },
      });
      answer = await timed(() => modules!.capture.POST(req, { params: Promise.resolve({ action: "save" }) }), options.timeoutMs ?? 10_000);
      // The phone routes allow 30 saves a minute and 20 uploads an hour per
      // account (lib/mobile-widgets.ts): the next save comes from another
      // phone of a twin account with the same role.
      if (answer.status === 429) delete phones[role];
    }
    result.calls++;
    const bucket = answer.status < 0 ? "exception" : `${Math.floor(answer.status / 100)}xx`;
    result.statuses[bucket] = (result.statuses[bucket] || 0) + 1;
    options.trace?.(role, `${mobile ? "capture" : "upload"} ${label.slice(0, 120)}`, answer);
    const target = mobile ? "POST /api/mobile/capture/save" : "POST /api/upload";
    if (crashed(answer)) {
      if (answer.network) result.network.push(`${target} (${network.last})`);
      else report({ kind: "5xx", role, target, payload: label, status: answer.status, detail: answer.error || answer.body });
    }
    const after = await storedCounts();
    const ok = answer.status >= 200 && answer.status < 300;
    if (!ok && (after.pages !== before.pages || after.files !== before.files))
      report({ kind: "left-behind", role, target, payload: label, status: answer.status, detail: `pages ${before.pages}→${after.pages}, files ${before.files}→${after.files} · ${answer.body}` });
    if (incomingLeft(world)) report({ kind: "left-behind", role, target, payload: label, status: answer.status, detail: `${incomingLeft(world)} temporary file(s) in uploads/.incoming · ${answer.body}` });
    if (ok && !mobile) {
      const fileId = /^\{"id":"([0-9a-f-]{36})"/.exec(answer.body)?.[1];
      const place = fileId ? await uploadedTo(fileId) : undefined;
      if (!place) report({ kind: "inconsistent", role, target, payload: label, status: answer.status, detail: `answered ${answer.body} but no file row` });
      else {
        if (!mayUpload(world, role, place, purpose)) report({ kind: "forbidden-write", role, target, payload: label, status: answer.status, detail: `stored on page ${place.page_id} (workspace ${place.workspace_id === world.wsA ? "A" : "B"}) · ${answer.body}` });
        if (!existsSync(join(world.dir, "uploads", fileId!))) report({ kind: "inconsistent", role, target, payload: label, status: answer.status, detail: "file row without its file on disk" });
      }
    }
    const changed = changedTables(stateBefore, await protectedState(world, role));
    // Uploads add files (and pages) where allowed; for the others nothing of A may change.
    if (changed.length && role !== "editor" && !((role === "viewer" || role === "guest") && purpose === "comment" && answer.status === 200 && changed.every((t) => t === "files")))
      report({ kind: "forbidden-write", role, target, payload: label, status: answer.status, detail: `changed: ${changed.join(", ")} · ${answer.body}` });
    await restoreActors(world);
  }
  for (const problem of await inconsistencies()) report({ kind: "inconsistent", role: "-", target: "database", payload: "(after the uploads)", status: 0, detail: problem });
  result.ms = performance.now() - started;
  return result;
}

function captureCase(r: Rng, world: World): { label: string; body: Buffer; contentType: string | null } {
  const gen = new Gen(r, () => ({ own: world.ids.own, other: world.ids.other, all: [...world.ids.own, ...world.ids.other] }));
  const pick = (own: string[], other: string[]) => (r.chance(0.6) ? r.pick(own) : r.chance(0.6) ? r.pick(other) : r.pick([randomUuid(r), "inbox", "", "x"]));
  const fields: Record<string, string> = {};
  if (r.chance(0.8)) fields.targetId = pick([world.pages.doc, world.pages.db, world.pages.shared, world.pages.privateDoc, "inbox"], [world.pages.docB, world.pages.dbB]);
  if (r.chance(0.5)) fields.place = r.pick(["subpage", "append", "pages", "pages", "", "PAGES"]);
  if (r.chance(0.5)) fields.spaceId = pick([world.teamA, world.privateA], [world.teamB]);
  if (r.chance(0.3)) fields.parentId = pick([world.pages.doc, world.pages.privateDoc], [world.pages.docB]);
  if (r.chance(0.3)) fields.rowId = pick(world.rows.a, world.rows.b);
  for (const key of ["title", "text", "url", "recognized"]) if (r.chance(0.4)) fields[key] = gen.string();
  if (r.chance(0.3)) fields.scan = r.pick(["1", "true", "0", "yes", ""]);
  if (r.chance(0.5)) {
    const entries: Entry[] = Object.entries(fields).map(([k, v]) => [k, r.chance(0.85) ? q(v) : gen.any(2)] as Entry);
    if (r.chance(0.1)) entries.push([r.pick(PROTO_KEYS), gen.object(1)]);
    const text = r.chance(0.05) ? r.pick(["{", "[]", "null", "1e400"]) : objectText(entries);
    return { label: `json ${short(text, 400)}`, body: Buffer.from(text), contentType: r.chance(0.9) ? "application/json" : null };
  }
  const parts: Part[] = Object.entries(fields).map(([name, value]) => ({ name, value }));
  for (let n = r.pick([0, 1, 1, 2, 11]); n > 0; n--) parts.push(filePart(r));
  const close = !r.chance(0.05);
  return { label: `multipart ${JSON.stringify(fields).slice(0, 400)} files=${parts.filter((p) => p.filename !== undefined || p.data).length}${close ? "" : " (body not closed: no final boundary)"}`, body: multipart(parts, BOUNDARY, close), contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

// ---- The public form (no sign-in) ----

// Answers to a public form of workspace A (app/api/forms/[token]): JSON
// and multipart, with or without a session. Every answer is deliberate;
// a refused one adds no record.
export async function fuzzForms(world: World, options: { seed: number; count: number; timeoutMs?: number; log?: (line: string) => void; trace?: RunOptions["trace"] }): Promise<RunResult> {
  const r = new Rng(options.seed ^ 0xf0f0);
  const gen = new Gen(r, () => ({ own: world.ids.own, other: world.ids.other, all: [...world.ids.own, ...world.ids.other] }));
  const { api, db } = modules!;
  const owner = world.actors.owner.user;
  const formPage = ((await api.command(owner, { action: "page.create", workspaceId: world.wsA, spaceId: world.teamA, title: "Public form", kind: "database" })) as { id: string }).id;
  const current = await api.database(formPage);
  await api.command(owner, {
    action: "database.update",
    pageId: formPage,
    version: current.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "num", name: "Number", type: "number" },
      { id: "sel", name: "Status", type: "select", options: ["Open", "Done"] },
      { id: "due", name: "Due", type: "date" },
      { id: "att", name: "Files", type: "files" },
      { id: "done", name: "Done", type: "checkbox" },
      { id: "mail", name: "Mail", type: "email" },
    ],
    views: current.views,
  });
  await api.command(owner, { action: "form.update", pageId: formPage, enabled: true, internal: false, anonymous: true });
  const token = (await db.one<{ token: string }>("SELECT token FROM forms WHERE page_id=?", formPage))!.token;
  const route = await import("../../app/api/forms/[token]/handler");
  const reporter = new Reporter(options.log);
  const result: RunResult = { findings: reporter.findings, calls: 0, statuses: {}, network: [], ms: 0 };
  const started = performance.now();
  const records = async () => (await db.one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", formPage))!.n;
  for (let i = 0; i < options.count; i++) {
    const cells: Entry[] = ["title", "num", "sel", "due", "done", "mail", "att", "nope", "__proto__"].filter(() => r.chance(0.5)).map((f) => [f, r.chance(0.05) ? nested(r.pick([1000, 5000, 20000]), r.pick(["array", "object", "mixed"] as const)) : r.chance(0.6) ? gen.any(2) : gen.stringText()] as Entry);
    let payload = objectText([["cells", r.chance(0.9) ? objectText(cells) : gen.any(2)], ...(r.chance(0.1) ? [[r.pick(PROTO_KEYS), gen.object(1)] as Entry] : [])]);
    if (r.chance(0.05)) payload = r.pick(["{", "[]", "null", "1e400", '{"cells":', ""]);
    const multipartBody = r.chance(0.35);
    let body: Buffer, contentType: string | null;
    if (multipartBody) {
      const parts: Part[] = [{ name: "payload", value: payload }];
      for (let n = r.pick([0, 1, 2, 6]); n > 0; n--) parts.push(filePart(r, r.pick(["file:att", "file:title", "file:nope", "file"])));
      body = multipart(parts, BOUNDARY, !r.chance(0.08));
      contentType = r.chance(0.95) ? `multipart/form-data; boundary=${BOUNDARY}` : "multipart/form-data; boundary=wrong";
    } else {
      body = Buffer.from(payload);
      contentType = r.pick(["application/json", "application/json", "text/plain", null]);
    }
    const signedIn = r.chance(0.3) ? r.pick(Object.values(world.actors)) : null;
    const headers: Record<string, string> = { origin: APP_URL, ...lengthHeader(r, body), ...(contentType ? { "content-type": contentType } : {}) };
    if (signedIn) headers.cookie = `flowplan_session=${signedIn.token}`;
    const label = `${multipartBody ? "multipart" : "json"} ${signedIn ? signedIn.role : "anonymous"} ${short(payload, 400)} (${body.length} bytes)`;
    const before = await records();
    const req = new Request(`${APP_URL}/api/forms/${token}`, { method: "POST", body: new Uint8Array(body), headers });
    const answer = await timed(async () => (await inRequestScope(req, () => route.POST(req, { params: Promise.resolve({ token }) }))).value, options.timeoutMs ?? 10_000);
    result.calls++;
    const bucket = answer.status < 0 ? "exception" : `${Math.floor(answer.status / 100)}xx`;
    result.statuses[bucket] = (result.statuses[bucket] || 0) + 1;
    options.trace?.(signedIn?.role ?? "outsider", `form ${label.slice(0, 120)}`, answer);
    const target = "POST /api/forms/[token]";
    if (crashed(answer)) {
      if (answer.network) result.network.push(`${target} (${network.last})`);
      else reporter.add({ kind: "5xx", role: signedIn?.role ?? "-", target, payload: label, status: answer.status, detail: answer.error || answer.body });
    }
    const after = await records();
    const ok = answer.status >= 200 && answer.status < 300;
    if (after !== before + (ok ? 1 : 0))
      reporter.add({ kind: ok ? "inconsistent" : "left-behind", role: signedIn?.role ?? "-", target, payload: label, status: answer.status, detail: `records ${before}→${after} · ${answer.body}` });
    if (signedIn) await restoreActors(world);
  }
  for (const problem of await inconsistencies()) reporter.add({ kind: "inconsistent", role: "-", target: "database", payload: "(after the form answers)", status: 0, detail: problem });
  result.ms = performance.now() - started;
  return result;
}

// ---- Deep nesting ----

// Values nested `depth` levels deep – arrays, objects, or both in turn.
export function nested(depth: number, kind: "array" | "object" | "mixed"): string {
  if (kind === "array") return "[".repeat(depth) + "]".repeat(depth);
  if (kind === "object") return '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
  const half = Math.floor(depth / 2);
  return '{"a":['.repeat(half) + "1" + "]}".repeat(half);
}

// Every action as the editor, its fields well-formed but one (in turn, up
// to `fieldsPerAction`) nested `depth` levels deep – where a schema takes
// any value (z.unknown, z.record), such a value reaches the code behind it.
export async function depthSweep(world: World, options: { seed: number; depth: number; fieldsPerAction?: number; only?: (action: string) => boolean; log?: (line: string) => void }): Promise<RunResult> {
  const rng = new Rng(options.seed);
  const gen = new Gen(rng, () => ({ own: world.ids.own, other: world.ids.other, all: [...world.ids.own, ...world.ids.other] }));
  const reporter = new Reporter(options.log);
  const result: RunResult = { findings: reporter.findings, calls: 0, statuses: {}, network: [], ms: 0 };
  const started = performance.now();
  const specs = await actionSpecs(world, rng, (f) => reporter.add(f), true, options.only);
  const actor = world.actors.editor;
  for (const spec of specs) {
    const fields = [...spec.fields, "extra"];
    for (const deep of fields.slice(0, options.fieldsPerAction ?? 4)) {
      const kind = rng.pick(["array", "object", "mixed"] as const);
      const entries: Entry[] = [["action", q(spec.action)], ...fields.map((f) => [f, f === deep ? nested(options.depth, kind) : hintedValue(gen, world, f, spec.hints?.[f])] as Entry)];
      const text = objectText(entries);
      const answer = await postCommand(actor, text);
      result.calls++;
      const bucket = answer.status < 0 ? "exception" : `${Math.floor(answer.status / 100)}xx`;
      result.statuses[bucket] = (result.statuses[bucket] || 0) + 1;
      if (crashed(answer) && !answer.network)
        reporter.add({ kind: "5xx", role: "editor", target: spec.action, payload: `${deep} nested ${options.depth} deep (${kind}): ${short(text, 300)}`, status: answer.status, detail: answer.error || answer.body });
      await restoreActors(world);
    }
  }
  result.ms = performance.now() - started;
  return result;
}
