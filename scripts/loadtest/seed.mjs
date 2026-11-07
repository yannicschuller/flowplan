// db-dialect-scan: sqlite-only file – seeds the SQLite file of a test instance.
// Seeds a Flowplan instance for the load test (scripts/loadtest/README.md).
//
// Content goes through the HTTP API as the first account (it becomes the
// admin): spaces, documents with text, a task database with a few thousand
// records (one rows.import, like the CSV import) and a few views with
// filters and sorts. The other accounts, their memberships, browser
// sessions and read-only API tokens are written straight into the SQLite
// file – signing up hundreds of people through the API would run into the
// sign-up and invitation limits. So the seeder needs the data directory
// (run it on the server host or inside the container).
//
// Writes a JSON file with everything the runner needs (cookies, tokens,
// ids). Never run this against an instance with real people: it creates an
// admin, accounts and content.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import * as Y from "yjs";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3497" },
    data: { type: "string" },
    users: { type: "string", default: "400" },
    docs: { type: "string", default: "300" },
    records: { type: "string", default: "3000" },
    spaces: { type: "string", default: "6" },
    out: { type: "string", default: "loadtest-seed.json" },
  },
});
if (!opt.data) {
  console.error("--data <FLOWPLAN_DATA_DIR of the instance> is required (accounts and sessions are written into its SQLite file).");
  process.exit(2);
}
const origin = new URL(opt.url).origin;
const N_USERS = Number(opt.users),
  N_DOCS = Number(opt.docs),
  N_RECORDS = Number(opt.records),
  N_SPACES = Number(opt.spaces);
const sha256 = (v) => createHash("sha256").update(v).digest("hex");

let adminCookie = "";
async function call(path, { method = "GET", body, cookie = adminCookie } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = response.headers.getSetCookie?.() || [];
  for (const c of set) if (c.startsWith("flowplan_session=")) adminCookie = c.split(";")[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} ${body?.action || ""}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const command = (body) => call("/api/command", { method: "POST", body });

// --- Text ------------------------------------------------------------------
const WORDS =
  "projekt planung release kunde angebot rechnung meeting protokoll entscheidung roadmap budget risiko termin design prototyp feedback onboarding vertrag server datenbank migration backup sicherheit export import suche index team sprint aufgabe ziel quartal bericht analyse marketing vertrieb support ticket dokumentation handbuch richtlinie prozess workflow automatisierung qualität test".split(
    " ",
  );
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pick = (list) => list[Math.floor(rand() * list.length)];
const sentence = (n = 8 + Math.floor(rand() * 10)) => {
  const words = Array.from({ length: n }, () => pick(WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ") + ".";
};
// A Yjs update with headings and paragraphs, as the editor (TipTap /
// y-prosemirror) stores them in the fragment "default".
function documentUpdate(state, paragraphs) {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, Buffer.from(state, "base64"));
  const before = Y.encodeStateVector(doc);
  const fragment = doc.getXmlFragment("default");
  doc.transact(() => {
    if (fragment.length) fragment.delete(0, fragment.length);
    const nodes = [];
    for (let i = 0; i < paragraphs; i++) {
      const el = new Y.XmlElement(i % 6 === 0 ? "heading" : "paragraph");
      if (i % 6 === 0) el.setAttribute("level", 2);
      el.insert(0, [new Y.XmlText(i % 6 === 0 ? sentence(4) : `${sentence()} ${sentence()} ${sentence()}`)]);
      nodes.push(el);
    }
    fragment.insert(0, nodes);
  });
  return Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");
}

async function pool(items, concurrency, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

// --- Admin and content -------------------------------------------------------
const t0 = Date.now();
const adminEmail = `loadtest-admin-${Date.now()}@example.test`;
await call("/api/auth/register", { method: "POST", body: { name: "Loadtest Admin", email: adminEmail, password: "loadtest-passwort-lang-genug" }, cookie: "" });
if (!adminCookie) throw new Error("No session cookie after sign-up – is this a fresh instance (first account becomes admin)?");
await command({ action: "profile.onboarded" }).catch(() => {});
let boot = await call("/api/bootstrap");
const workspaceId = boot.workspace.id;
const spaceIds = [boot.spaces[0].id];
for (let i = 1; i < N_SPACES; i++) {
  const s = await command({ action: "space.create", workspaceId, name: `Bereich ${i}` });
  spaceIds.push(s.id ?? s.space?.id);
}
console.log(`admin + ${spaceIds.length} spaces (${Date.now() - t0} ms)`);

// Task database with views (filters and sorts are evaluated on the server
// for the MCP/API queries, in the browser for the table view).
const db = await command({ action: "page.create", workspaceId, spaceId: spaceIds[0], title: "Aufgaben", kind: "database" });
const STATUS = ["Offen", "In Arbeit", "Review", "Erledigt"],
  PRIO = ["Hoch", "Mittel", "Niedrig"],
  TAGS = ["Design", "Produkt", "Technik", "Vertrieb", "Support"];
const fields = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: STATUS },
  { id: "priority", name: "Priorität", type: "select", options: PRIO },
  { id: "estimate", name: "Aufwand", type: "number" },
  { id: "due", name: "Fällig", type: "date" },
  { id: "tags", name: "Tags", type: "multiselect", options: TAGS },
  { id: "notes", name: "Notizen", type: "text" },
];
const views = [
  { id: "table", name: "Alle", type: "table", filters: [], sorts: [] },
  {
    id: "open-high",
    name: "Offen, hoch, nach Fälligkeit",
    type: "table",
    filters: [
      { field: "status", op: "neq", value: "Erledigt" },
      { field: "priority", op: "eq", value: "Hoch" },
    ],
    sorts: [{ field: "due", direction: "asc" }],
  },
  {
    id: "big",
    name: "Groß, nach Aufwand",
    type: "table",
    filters: [{ field: "estimate", op: "gt", value: "5" }],
    sorts: [{ field: "estimate", direction: "desc" }, { field: "title", direction: "asc" }],
  },
  { id: "board", name: "Board", type: "board", filters: [], sorts: [], groupBy: "status" },
];
const version = (await call(`/api/pages/${db.id}`)).database.version;
await command({ action: "database.update", pageId: db.id, version, fields, views });
const record = (i) => ({
  title: `${pick(WORDS)} ${pick(WORDS)} #${i}`,
  status: pick(STATUS),
  priority: pick(PRIO),
  estimate: Math.floor(rand() * 13),
  due: new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 365) * 86400_000).toISOString().slice(0, 10),
  tags: [pick(TAGS)],
  notes: sentence(),
});
for (let i = 0; i < N_RECORDS; i += 5000)
  await command({ action: "rows.import", pageId: db.id, rows: Array.from({ length: Math.min(5000, N_RECORDS - i) }, (_, k) => record(i + k)) });
console.log(`database with ${N_RECORDS} records (${Date.now() - t0} ms)`);
// A second, empty database for the import during the background load.
const importDb = await command({ action: "page.create", workspaceId, spaceId: spaceIds[0], title: "Import-Ziel", kind: "database" });
await command({ action: "database.update", pageId: importDb.id, version: (await call(`/api/pages/${importDb.id}`)).database.version, fields, views: [views[0]] });

// Documents with a few KB of text each.
const docIds = [];
await pool(
  Array.from({ length: N_DOCS }, (_, i) => i),
  4,
  async (i) => {
    const page = await command({ action: "page.create", workspaceId, spaceId: spaceIds[i % spaceIds.length], title: `${sentence(3).slice(0, -1)} ${i}`, kind: "document" });
    const { generation, state } = await call(`/api/pages/${page.id}`);
    await command({ action: "document.sync", pageId: page.id, generation, update: documentUpdate(state, 6 + (i % 20)) });
    docIds.push(page.id);
  },
);
console.log(`${N_DOCS} documents (${Date.now() - t0} ms)`);

// --- Accounts, sessions, tokens (straight into SQLite) -----------------------
const sqlite = new DatabaseSync(resolve(opt.data, "flowplan.sqlite"));
sqlite.exec("PRAGMA busy_timeout=10000");
const users = [];
const now = Date.now();
sqlite.exec("BEGIN IMMEDIATE");
try {
  const insertUser = sqlite.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)");
  const insertMember = sqlite.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')");
  const insertSession = sqlite.prepare(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,remember,sso,app,last_seen,agent) VALUES(?,?,'[]',?,?,0,0,0,?,'flowplan-loadtest')",
  );
  const insertToken = sqlite.prepare(
    "INSERT INTO api_tokens(id,user_id,name,scope,token_hash,prefix,created_at) VALUES(?,?,'loadtest','read',?,?,?)",
  );
  for (let i = 0; i < N_USERS; i++) {
    const uid = randomUUID();
    insertUser.run(uid, `loadtest:${uid}`, `Testperson ${i}`, `loadtest-${i}-${uid.slice(0, 8)}@example.test`, now);
    insertMember.run(workspaceId, uid);
    const session = randomBytes(32).toString("base64url");
    insertSession.run(sha256(session), uid, now + 7 * 86400_000, now, now);
    const token = `fp_${randomBytes(30).toString("base64url")}`;
    insertToken.run(randomUUID(), uid, sha256(token), token.slice(0, 10), now);
    users.push({ id: uid, cookie: `flowplan_session=${session}`, token });
  }
  sqlite.exec("COMMIT");
} catch (e) {
  sqlite.exec("ROLLBACK");
  throw e;
}
sqlite.close();
console.log(`${N_USERS} accounts with sessions and API tokens (${Date.now() - t0} ms)`);

// One check that a seeded session works.
await call("/api/bootstrap", { cookie: users[0].cookie });
// Records with what the runner needs for conflict-free edits (version and
// the values it changes, sent as `base`).
const rows = (await call(`/api/pages/${db.id}`)).rows.map((r) => ({
  id: r.id,
  version: r.version,
  cells: { status: r.cells.status, estimate: r.cells.estimate, notes: r.cells.notes },
}));
writeFileSync(
  opt.out,
  JSON.stringify({ origin, workspaceId, spaceIds, databaseId: db.id, importDatabaseId: importDb.id, rows, docIds, users, admin: { email: adminEmail, cookie: adminCookie } }, null, 1),
);
console.log(`seed written to ${opt.out} (${Date.now() - t0} ms)`);
