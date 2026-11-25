import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notion-api-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap, rows } = await import("../lib/api");
const { launchJob, jobOutcome } = await import("../lib/background-jobs");
const { listNotionRoots, parseNotionApi, notionClient, checkNotionToken } = await import("../lib/importers/notion-api");
const { importNotion, listNotion } = await import("../lib/importers/notion-import");
const { writeImport } = await import("../lib/importers/write");

// A mock of Notion's API (https://api.notion.com/v1, Notion-Version
// 2022-06-28) on a local port: the sandbox cannot reach Notion, and the
// client takes another base address only from tests.
const TOKEN = "ntn_" + "T0k3nS3cr3t".repeat(4);
const uuid = (n: number) => {
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const bare = (n: number) => uuid(n).replaceAll("-", "");
const PAGE_A = 0xa1, PAGE_B = 0xb1, PAGE_OUT = 0xc1, DB_TASKS = 0xd1, DB_PEOPLE = 0xd2, ROW_1 = 0xe1, ROW_2 = 0xe2, ROW_P1 = 0xf1, ROW_P2 = 0xf2, SYNC_ORIGINAL = 0x51;
const rt = (content: string, extra: Record<string, unknown> = {}) => ({
  type: "text",
  text: { content, link: (extra.link as string) ? { url: extra.link } : null },
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default", ...((extra.annotations as object) || {}) },
  plain_text: content,
  href: (extra.link as string) || null,
});
const block = (n: number, type: string, data: Record<string, unknown>, hasChildren = false) => ({ object: "block", id: uuid(n), type, has_children: hasChildren, [type]: data });

// The mock's address first: file addresses in the data below use it.
const server = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const file = (name: string) => ({ type: "file", file: { url: `${base}/files/${name}?X-Amz-Signature=abc`, expiry_time: "2026-11-14T12:00:00.000Z" } });
const children: Record<string, unknown[]> = {
  [bare(PAGE_A)]: [
    block(1, "paragraph", {
      rich_text: [
        rt("Fett", { annotations: { bold: true } }),
        rt(" und "),
        rt("rot", { annotations: { color: "red" } }),
        rt(" "),
        { type: "mention", mention: { type: "page", page: { id: uuid(PAGE_B) } }, annotations: {}, plain_text: "Seite B", href: `https://www.notion.so/${bare(PAGE_B)}` },
        rt(" "),
        rt("extern", { link: "https://example.org/x" }),
        rt(" "),
        rt("draußen", { link: `/${bare(PAGE_OUT)}` }),
      ],
      color: "default",
    }),
    block(2, "heading_2", { rich_text: [rt("Abschnitt")], is_toggleable: true, color: "default" }, true),
    block(3, "bulleted_list_item", { rich_text: [rt("Eins")] }),
    block(4, "bulleted_list_item", { rich_text: [rt("Zwei")] }, true),
    block(5, "to_do", { rich_text: [rt("Erledigt")], checked: true }),
    block(6, "toggle", { rich_text: [rt("Mehr")] }, true),
    block(7, "quote", { rich_text: [rt("Zitat")] }),
    block(8, "callout", { rich_text: [rt("Hinweis")], icon: { type: "emoji", emoji: "💡" }, color: "blue_background" }),
    block(9, "code", { rich_text: [rt("const x = 1;")], language: "javascript", caption: [] }),
    block(10, "equation", { expression: "a^2+b^2" }),
    block(11, "divider", {}),
    block(12, "table", { table_width: 2, has_column_header: true, has_row_header: false }, true),
    block(13, "image", { ...file("bild.png"), caption: [rt("Ein Bild")] }),
    block(14, "file", { ...file("gross.bin"), caption: [], name: "gross.bin" }),
    block(15, "bookmark", { url: "https://example.com/artikel", caption: [] }),
    block(16, "embed", { url: "https://www.youtube.com/watch?v=x" }),
    // A sub-page's block has the sub-page's id, an inline database's the database's.
    block(PAGE_B, "child_page", { title: "Seite B" }),
    block(DB_PEOPLE, "child_database", { title: "Personen" }),
    block(18, "synced_block", { synced_from: { type: "block_id", block_id: uuid(SYNC_ORIGINAL) } }, true),
    block(19, "column_list", {}, true),
    block(20, "link_to_page", { type: "database_id", database_id: uuid(DB_TASKS) }),
    block(21, "ai_block", {}),
    block(22, "pdf", { type: "external", external: { url: "https://example.com/doc.pdf" }, caption: [] }),
    // A toggle heading at the end: its content is its section.
    block(23, "heading_1", { rich_text: [rt("Schluss")], is_toggleable: true, color: "default" }, true),
  ],
  [bare(23)]: [block(2301, "paragraph", { rich_text: [rt("Letzte Worte")] })],
  [bare(2)]: [block(201, "paragraph", { rich_text: [rt("Im Abschnitt")] })],
  [bare(4)]: [block(401, "bulleted_list_item", { rich_text: [rt("Zwei a")] })],
  [bare(6)]: [block(601, "paragraph", { rich_text: [rt("Innen")] })],
  [bare(12)]: [
    block(1201, "table_row", { cells: [[rt("Kopf 1")], [rt("Kopf 2")]] }),
    block(1202, "table_row", { cells: [[rt("a")], [rt("b")]] }),
  ],
  [bare(SYNC_ORIGINAL)]: [block(5101, "paragraph", { rich_text: [rt("Synchron")] })],
  [bare(19)]: [block(1901, "column", {}, true), block(1902, "column", {}, true)],
  [bare(1901)]: [block(19011, "paragraph", { rich_text: [rt("Spalte links")] })],
  [bare(1902)]: [block(19021, "paragraph", { rich_text: [rt("Spalte rechts")] })],
  [bare(PAGE_B)]: [block(3001, "paragraph", { rich_text: [rt("Inhalt B")] })],
  [bare(ROW_1)]: [block(4001, "paragraph", { rich_text: [rt("Text des Eintrags")] })],
  [bare(ROW_2)]: [],
  [bare(ROW_P1)]: [],
  [bare(ROW_P2)]: [],
};
const pageObject = (n: number, title: string, parent: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  object: "page",
  id: uuid(n),
  created_time: "2025-03-01T10:00:00.000Z",
  last_edited_time: "2025-03-02T11:30:00.000Z",
  parent,
  archived: false,
  properties: { title: { id: "title", type: "title", title: [rt(title)] } },
  ...extra,
});
const pages: Record<string, unknown> = {
  [bare(PAGE_A)]: pageObject(PAGE_A, "Seite A", { type: "workspace", workspace: true }, { icon: { type: "emoji", emoji: "🚀" }, cover: file("cover.png") }),
  [bare(PAGE_B)]: pageObject(PAGE_B, "Seite B", { type: "page_id", page_id: uuid(PAGE_A) }),
};
const tasksSchema = {
  object: "database",
  id: uuid(DB_TASKS),
  title: [rt("Aufgaben")],
  parent: { type: "workspace", workspace: true },
  icon: { type: "emoji", emoji: "✅" },
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Status: { id: "st", name: "Status", type: "status", status: { options: [{ name: "Offen", color: "red" }, { name: "Fertig", color: "green" }] } },
    Tags: { id: "tg", name: "Tags", type: "multi_select", multi_select: { options: [{ name: "A", color: "blue" }, { name: "B", color: "brown" }] } },
    Fällig: { id: "du", name: "Fällig", type: "date", date: {} },
    Punkte: { id: "pt", name: "Punkte", type: "number", number: {} },
    Erledigt: { id: "ok", name: "Erledigt", type: "checkbox", checkbox: {} },
    Link: { id: "ur", name: "Link", type: "url", url: {} },
    Personen: { id: "pp", name: "Personen", type: "relation", relation: { database_id: uuid(DB_PEOPLE), type: "single_property" } },
    Anzahl: { id: "rc", name: "Anzahl", type: "rollup", rollup: { relation_property_name: "Personen", relation_property_id: "pp", rollup_property_name: "Alter", rollup_property_id: "ag", function: "count" } },
    Altersschnitt: { id: "ra", name: "Altersschnitt", type: "rollup", rollup: { relation_property_name: "Personen", relation_property_id: "pp", rollup_property_name: "Alter", rollup_property_id: "ag", function: "average" } },
    Doppelt: { id: "fd", name: "Doppelt", type: "formula", formula: { expression: "{{notion:block_property:pt:00000000-0000-0000-0000-000000000000:abc}} * 2" } },
    Länge: { id: "fl", name: "Länge", type: "formula", formula: { expression: 'prop("Name").length()' } },
    Zuständig: { id: "ow", name: "Zuständig", type: "people", people: {} },
    Erstellt: { id: "ct", name: "Erstellt", type: "created_time", created_time: {} },
  },
};
const peopleSchema = {
  object: "database",
  id: uuid(DB_PEOPLE),
  title: [rt("Personen")],
  parent: { type: "page_id", page_id: uuid(PAGE_A) },
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Alter: { id: "ag", name: "Alter", type: "number", number: {} },
  },
};
const rowObject = (n: number, db: number, properties: Record<string, unknown>) => ({
  object: "page",
  id: uuid(n),
  parent: { type: "database_id", database_id: uuid(db) },
  created_time: "2025-01-05T08:00:00.000Z",
  last_edited_time: "2025-01-06T09:00:00.000Z",
  properties,
});
const title = (text: string) => ({ id: "title", type: "title", title: [rt(text)] });
const taskRows = [
  rowObject(ROW_1, DB_TASKS, {
    Name: title("Planen"),
    Status: { id: "st", type: "status", status: { name: "Offen", color: "red" } },
    Tags: { id: "tg", type: "multi_select", multi_select: [{ name: "A" }, { name: "B" }] },
    Fällig: { id: "du", type: "date", date: { start: "2026-05-01T14:30:00.000+02:00", end: null } },
    Punkte: { id: "pt", type: "number", number: 3 },
    Erledigt: { id: "ok", type: "checkbox", checkbox: true },
    Link: { id: "ur", type: "url", url: "https://example.org" },
    // More than 25 relations: the full list comes from the property endpoint.
    Personen: { id: "pp", type: "relation", relation: [{ id: uuid(ROW_P1) }], has_more: true },
    Anzahl: { id: "rc", type: "rollup", rollup: { type: "number", number: 2, function: "count" } },
    Altersschnitt: { id: "ra", type: "rollup", rollup: { type: "number", number: 35, function: "average" } },
    Doppelt: { id: "fd", type: "formula", formula: { type: "number", number: 6 } },
    Länge: { id: "fl", type: "formula", formula: { type: "number", number: 6 } },
    Zuständig: { id: "ow", type: "people", people: [{ object: "user", id: uuid(0x99), name: "Notion Owner", person: { email: "notion-owner@example.test" } }] },
    Erstellt: { id: "ct", type: "created_time", created_time: "2025-01-05T08:00:00.000Z" },
  }),
  rowObject(ROW_2, DB_TASKS, {
    Name: title("Bauen"),
    Status: { id: "st", type: "status", status: { name: "Fertig", color: "green" } },
    Tags: { id: "tg", type: "multi_select", multi_select: [] },
    Fällig: { id: "du", type: "date", date: null },
    Punkte: { id: "pt", type: "number", number: null },
    Erledigt: { id: "ok", type: "checkbox", checkbox: false },
    Link: { id: "ur", type: "url", url: null },
    // A record the integration does not see.
    Personen: { id: "pp", type: "relation", relation: [{ id: uuid(0x777) }], has_more: false },
    Anzahl: { id: "rc", type: "rollup", rollup: { type: "number", number: 1, function: "count" } },
    Altersschnitt: { id: "ra", type: "rollup", rollup: { type: "number", number: 0, function: "average" } },
    Doppelt: { id: "fd", type: "formula", formula: { type: "number", number: 0 } },
    Länge: { id: "fl", type: "formula", formula: { type: "number", number: 5 } },
    Zuständig: { id: "ow", type: "people", people: [] },
    Erstellt: { id: "ct", type: "created_time", created_time: "2025-01-05T08:00:00.000Z" },
  }),
];
const peopleRows = [
  rowObject(ROW_P1, DB_PEOPLE, { Name: title("Ada"), Alter: { id: "ag", type: "number", number: 36 } }),
  rowObject(ROW_P2, DB_PEOPLE, { Name: title("Grace"), Alter: { id: "ag", type: "number", number: 34 } }),
];

// Two results per answer: every list is paginated.
function paginate(items: unknown[], cursor: string | null) {
  const start = cursor ? Number(cursor) : 0;
  const results = items.slice(start, start + 2);
  const next = start + 2 < items.length ? String(start + 2) : null;
  return { object: "list", results, has_more: next !== null, next_cursor: next };
}
const seen: { method: string; path: string; auth: string; version: string; at: number }[] = [];
let throttled = false;
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://x");
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : {};
  seen.push({ method: req.method || "", path: url.pathname, auth: String(req.headers.authorization), version: String(req.headers["notion-version"]), at: Date.now() });
  const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };
  if (url.pathname.startsWith("/files/")) {
    const name = url.pathname.slice("/files/".length);
    if (name === "gross.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.alloc(300_000, 1));
    }
    // A tiny PNG.
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex"));
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { object: "error", code: "unauthorized" });
  const path = url.pathname.replace(/^\/v1/, "");
  const cursor = url.searchParams.get("start_cursor") || json.start_cursor || null;
  if (path === "/search") return send(200, paginate([pages[bare(PAGE_A)], pages[bare(PAGE_B)], tasksSchema, peopleSchema, ...taskRows], cursor));
  // The first request for page A's blocks is refused once (rate limit).
  const kids = /^\/blocks\/([0-9a-f-]+)\/children$/.exec(path);
  if (kids) {
    const key = kids[1].replaceAll("-", "");
    if (key === bare(PAGE_A) && !throttled) {
      throttled = true;
      return send(429, { object: "error", code: "rate_limited" }, { "retry-after": "2" });
    }
    if (!children[key]) return send(404, { object: "error", code: "object_not_found" });
    return send(200, paginate(children[key], cursor));
  }
  const page = /^\/pages\/([0-9a-f-]+)$/.exec(path);
  if (page) return pages[page[1].replaceAll("-", "")] ? send(200, pages[page[1].replaceAll("-", "")]) : send(404, { code: "object_not_found" });
  const prop = /^\/pages\/([0-9a-f-]+)\/properties\/(.+)$/.exec(path);
  if (prop) return send(200, paginate([{ object: "property_item", type: "relation", relation: { id: uuid(ROW_P1) } }, { object: "property_item", type: "relation", relation: { id: uuid(ROW_P2) } }], cursor));
  const db = /^\/databases\/([0-9a-f-]+)(\/query)?$/.exec(path);
  if (db) {
    const key = db[1].replaceAll("-", "");
    const schema = key === bare(DB_TASKS) ? tasksSchema : key === bare(DB_PEOPLE) ? peopleSchema : null;
    if (!schema) return send(404, { code: "object_not_found" });
    if (!db[2]) return send(200, schema);
    return send(200, paginate(key === bare(DB_TASKS) ? taskRows : peopleRows, cursor));
  }
  send(404, { code: "object_not_found" });
}
const slept: number[] = [];
const testOptions = { base: `${base}/v1`, minIntervalMs: 0, sleep: async (ms: number) => void slept.push(ms) };

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("notion-owner");
const wid = await createWorkspace(owner.id, "Notion API");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const items = [
  { id: bare(PAGE_A), kind: "page" as const },
  { id: bare(DB_TASKS), kind: "database" as const },
];

test("tokens are checked; the client sends the token and Notion's version, waits between requests and honours Retry-After", async () => {
  assert.throws(() => checkNotionToken("abc"), /Notion-Integrations-Token/);
  assert.equal(checkNotionToken(` ${TOKEN} `), TOKEN);
  const before = seen.length;
  const client = notionClient(TOKEN, { base: `${base}/v1`, minIntervalMs: 40 });
  const start = Date.now();
  for (let i = 0; i < 3; i++) await client.call("GET", `/pages/${bare(PAGE_B)}`);
  // Three requests start at least 40 ms apart each (Date.now() and the
  // timers round to whole milliseconds: one of slack per wait).
  assert.ok(Date.now() - start >= 78, `${Date.now() - start} ms`);
  const [first] = seen.slice(before);
  assert.equal(first.auth, `Bearer ${TOKEN}`);
  assert.equal(first.version, "2022-06-28");
  await assert.rejects(notionClient("ntn_wrongwrongwrongwrongwrong", testOptions).call("GET", "/search"), /abgelehnt/);
  // Only Notion's file hosts (and the mock in tests) are fetched.
  assert.deepEqual(await notionClient(TOKEN, {}).download("https://evil.example/x.png", 1000), { error: "host" });
});

test("listing: the shared top-level pages and databases, over every page of the search", async () => {
  const roots = await listNotionRoots(TOKEN, testOptions);
  assert.deepEqual(
    roots.map((r) => [r.id, r.kind, r.title]),
    [
      [bare(DB_TASKS), "database", "Aufgaben"],
      [bare(PAGE_A), "page", "Seite A"],
    ],
  );
  assert.equal(roots.find((r) => r.kind === "page")!.icon, "🚀");
  const listed = await listNotion(owner, wid, space, TOKEN, testOptions);
  assert.equal(listed.items.length, 2);
});

test("blocks, sub-pages, databases with relations and rollups, files, synced blocks and the report", async () => {
  slept.length = 0;
  const tree = await parseNotionApi(TOKEN, items, { ...testOptions, maxFileBytes: 100_000, member: (p) => (p.email === "notion-owner@example.test" ? owner.id : undefined) });
  // 429 with Retry-After: 2 → waited two seconds, then asked again.
  assert.ok(slept.includes(2000), String(slept));
  const result = await writeImport(owner, wid, space, tree);
  tree.close?.();
  const pageOf = async (t: string) => (await one<{ id: string; parent_id: string | null; kind: string; icon: string; cover: string }>("SELECT id,parent_id,kind,icon,cover FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL", wid, t))!;
  const a = await pageOf("Seite A"),
    b = await pageOf("Seite B"),
    tasks = await pageOf("Aufgaben"),
    people = await pageOf("Personen");
  assert.equal(b.parent_id, a.id);
  assert.equal(people.parent_id, a.id);
  assert.equal(people.kind, "database");
  assert.equal(tasks.parent_id, null);
  assert.equal(a.icon, "🚀");
  assert.equal(tasks.icon, "✅");
  assert.match(a.cover, /^\/api\/files\//);
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", a.id))!.html;
  assert.match(html, /<strong>Fett<\/strong> und <span style="color:#e03131">rot<\/span>/);
  // Mentions and links to imported pages are internal links; to pages
  // outside the import they keep Notion's address.
  assert.match(html, new RegExp(`<a [^>]*href="/#page=${b.id}"[^>]*>Seite B</a>`));
  assert.match(html, /href="https:\/\/example\.org\/x"/);
  assert.match(html, new RegExp(`href="https://www\\.notion\\.so/${bare(PAGE_OUT)}"`));
  // A toggle heading followed by other blocks stays a toggle; one whose
  // section is its content becomes a heading (which folds).
  assert.match(html, /<details[^>]*><summary>Abschnitt<\/summary><div><p[^>]*>Im Abschnitt<\/p><\/div><\/details>/);
  assert.match(html, /<h1[^>]*>Schluss<\/h1><p[^>]*>Letzte Worte<\/p>$/);
  assert.match(html, /<ul><li[^>]*><p[^>]*>Eins<\/p><\/li><li[^>]*><p[^>]*>Zwei<\/p><ul><li[^>]*><p[^>]*>Zwei a<\/p><\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /data-type="taskItem" data-checked="true"/);
  assert.match(html, /<details[^>]*><summary>Mehr<\/summary>/);
  assert.match(html, /<blockquote[^>]*><p[^>]*>Zitat<\/p><\/blockquote>/);
  assert.match(html, /data-callout-icon="💡" data-callout-color="blue"/);
  assert.match(html, /<pre[^>]*><code class="language-javascript">const x = 1;<\/code><\/pre>/);
  assert.match(html, /data-math="a\^2\+b\^2"/);
  assert.match(html, /<hr/);
  assert.match(html, /<th[^>]*><p[^>]*>Kopf 1<\/p><\/th>/);
  assert.match(html, /<figcaption>Ein Bild<\/figcaption>/);
  assert.match(html, /href="https:\/\/example\.com\/artikel"/);
  assert.match(html, /Synchron/);
  assert.match(html, /Spalte links<\/p><p[^>]*>Spalte rechts/);
  assert.match(html, new RegExp(`<a [^>]*href="/#page=${tasks.id}"[^>]*>Aufgaben</a>`));
  // The inline database is shown where it was.
  assert.match(html, new RegExp(`data-linked-source="${people.id}"`));
  // Files: the image downloaded and stored, the one too large left out.
  const files = await all<{ id: string; name: string; mime: string }>("SELECT id,name,mime FROM files WHERE page_id=? ORDER BY name", a.id);
  assert.deepEqual(files.map((f) => f.name), ["bild.png", "cover.png"]);
  assert.match(html, new RegExp(`<img [^>]*src="/api/files/${files[0].id}"`));
  assert.doesNotMatch(html, /X-Amz-Signature|gross\.bin|127\.0\.0\.1/);

  // The database: property types, options with Notion's colours, cells.
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", tasks.id))!.fields) as { id: string; name: string; type: string; options?: string[]; optionColors?: Record<string, string>; relationPage?: string; relationField?: string; rollupField?: string; aggregate?: string; formula?: string }[];
  const field = (name: string) => fields.find((f) => f.name === name)!;
  assert.deepEqual(fields.map((f) => [f.name, f.type]), [
    ["Name", "text"], ["Status", "select"], ["Tags", "multiselect"], ["Fällig", "date"], ["Punkte", "number"], ["Erledigt", "checkbox"], ["Link", "url"],
    ["Personen", "relation"], ["Anzahl", "rollup"], ["Altersschnitt", "rollup"], ["Doppelt", "formula"], ["Länge", "text"], ["Zuständig", "person"], ["Erstellt", "created_at"],
  ]);
  assert.deepEqual(field("Status").optionColors, { Offen: "red", Fertig: "green" });
  assert.deepEqual(field("Tags").optionColors, { A: "blue", B: "orange" });
  assert.equal(field("Personen").relationPage, people.id);
  assert.equal(field("Anzahl").relationField, field("Personen").id);
  assert.equal(field("Anzahl").aggregate, "count");
  assert.equal(field("Altersschnitt").aggregate, "average");
  const peopleFields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", people.id))!.fields) as { id: string; name: string }[];
  assert.equal(field("Altersschnitt").rollupField, peopleFields.find((f) => f.name === "Alter")!.id);
  assert.equal(field("Doppelt").formula, 'prop("Punkte") * 2');
  const records = await rows(tasks.id);
  const persons = await rows(people.id);
  const planen = records.find((r) => r.cells.title === "Planen")!;
  assert.equal(planen.cells[field("Status").id], "Offen");
  assert.deepEqual(planen.cells[field("Tags").id], ["A", "B"]);
  assert.equal(planen.cells[field("Fällig").id], "2026-05-01T14:30");
  assert.equal(planen.cells[field("Erledigt").id], true);
  // Both related records, also those beyond the first answer (has_more).
  assert.deepEqual(new Set(planen.cells[field("Personen").id] as string[]), new Set(persons.map((p) => p.id)));
  assert.equal(planen.cells[field("Länge").id], "6");
  // One person per record: a person property with one, stored as one id (#535).
  assert.equal(planen.cells[field("Zuständig").id], owner.id);
  assert.equal((field("Zuständig") as { multiPerson?: boolean }).multiPerson, undefined);
  assert.match(planen.created_at, /^2025-01-05/);
  const bauen = records.find((r) => r.cells.title === "Bauen")!;
  assert.deepEqual(bauen.cells[field("Personen").id], []);
  const rowHtml = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", planen.id))!.html;
  assert.match(rowHtml, /Text des Eintrags/);

  // The report lists what was approximated, with links to the pages.
  assert.ok(result.report);
  const report = (await one<{ id: string; title: string }>("SELECT id,title FROM pages WHERE id=?", result.report!.pageId))!;
  assert.match(report.title, /^Importbericht: Notion/);
  const reportHtml = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", report.id))!.html;
  for (const expected of [
    /Nicht übernommene Blöcke \(1\)/,
    new RegExp(`<a [^>]*href="/#page=${a.id}"[^>]*>Seite A</a>: ai_block`),
    /Synchronisierte Blöcke \(Inhalt kopiert\) \(1\)/,
    /bookmark: https:\/\/example\.com\/artikel/,
    /embed: https:\/\/www\.youtube\.com/,
    /pdf: https:\/\/example\.com\/doc\.pdf/,
    /Formel „Länge“: Werte als Text übernommen/,
    /„gross\.bin“ ist größer als/,
    new RegExp(`href="/#page=${tasks.id}&amp;row=${bauen.id}"[^>]*>Bauen</a>: „Personen“: 1 verknüpfte Einträge sind nicht Teil des Imports`),
  ])
    assert.match(reportHtml, expected);
  assert.doesNotMatch(reportHtml, /Rollups ohne Gegenstück/);
});

// Every file below a folder, for the token check.
const filesBelow = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesBelow(join(dir, name)) : [join(dir, name)]));

test("as a background job: done with the result; the token is nowhere in the database or the data folder", async () => {
  const job = await launchJob(owner, "import", "Notion", () => importNotion(owner, wid, space, TOKEN, [{ id: bare(PAGE_B), kind: "page" }], testOptions));
  let outcome = await jobOutcome(owner, job);
  for (let i = 0; i < 200 && outcome?.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 20));
    outcome = await jobOutcome(owner, job);
  }
  assert.equal(outcome?.status, "done");
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(TOKEN));
  // Every table, every column.
  const tables = /^postgres/.test(process.env.DATABASE_URL || "")
    ? await all<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()")
    : await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
  for (const { name } of tables) {
    const content = JSON.stringify(await all(`SELECT * FROM "${name}"`), (_, v) => (Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    assert.ok(!content.includes(TOKEN) && !content.includes("T0k3nS3cr3t"), `token in table ${name}`);
  }
  for (const path of filesBelow(process.env.FLOWPLAN_DATA_DIR!)) assert.ok(!readFileSync(path).includes("T0k3nS3cr3t"), `token in ${path}`);
  // The downloaded files' temporary folder is gone.
  assert.ok(!filesBelow(process.env.FLOWPLAN_DATA_DIR!).some((p) => /notion-[0-9a-f-]{36}/.test(p)));
});

test("an editor of the target space only; nothing chosen is refused", async () => {
  const other = await account("notion-stranger");
  await assert.rejects(importNotion(other, wid, space, TOKEN, items, testOptions));
  await assert.rejects(importNotion(owner, wid, space, TOKEN, [], testOptions), /mindestens eine/);
  await assert.rejects(listNotion({ ...owner, demo: true }, wid, space, TOKEN, testOptions));
});
