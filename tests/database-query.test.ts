// Server-side database queries (#383 #12, lib/database-query.ts): the
// conditions pushed into SQL only narrow, the rest is decided as before –
// for a broad matrix of filters, sorts and pages the answer is exactly what
// queryRows() over every visible record gives (ids, order, total, computed
// cells), for an owner and for a member with hidden records and a hidden
// property. Runs on SQLite and, with DATABASE_URL, on PostgreSQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Filter, FilterGroup, FilterNode, Identity, Page, Row, View } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-database-query-"));
const { id, run, one } = await import("../lib/db");
const { bootstrap, command, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { relatedData } = await import("../lib/related-data");
const { queryRows } = await import("../lib/database");
const { queryDatabaseRows, filterSql } = await import("../lib/database-query");
const { visibleRows } = await import("../lib/row-access");
const { visibleFields } = await import("../lib/field-access");
const { operatorsFor } = await import("../lib/database-filters");

async function person(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
}
const ana = await person("Ana"),
  ben = await person("Ben");
const wid = await createWorkspace(ana.id, "Query");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = (await bootstrap(ana, wid)).spaces[0].id;
async function database(title: string, fields: Field[]) {
  const pid = ((await command(ana, { action: "page.create", workspaceId: wid, spaceId: space, title, kind: "database" })) as { id: string }).id;
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), pid);
  return pid;
}
// A small deterministic random source.
let seed = 383;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const projects = await database("Projekte", [
  { id: "title", name: "Name", type: "text" },
  { id: "budget", name: "Budget", type: "number" },
]);
const projectIds: string[] = [];
for (let i = 0; i < 6; i++) {
  const rid = id();
  projectIds.push(rid);
  await run("INSERT INTO rows(id,page_id,cells,position,created_by) VALUES(?,?,?,?,?)", rid, projects, JSON.stringify({ title: pick(["Alpha", "beta", "Gamma", "Äpfel", "zeta"]) + i, budget: i * 10 }), i, ana.id);
}
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "notes", name: "Notizen", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt", "Ärger"] },
  { id: "tags", name: "Tags", type: "multiselect", options: ["Design", "Technik", "Größe"] },
  { id: "estimate", name: "Aufwand", type: "number" },
  { id: "due", name: "Fällig", type: "date" },
  { id: "done", name: "Erledigt", type: "checkbox" },
  { id: "owner", name: "Zuständig", type: "person" },
  { id: "link", name: "Link", type: "url" },
  { id: "list", name: "Liste", type: "checklist" },
  { id: "project", name: "Projekt", type: "relation", relationPage: projects },
  { id: "created", name: "Erstellt", type: "created_at" },
  { id: "creator", name: "Erstellt von", type: "created_by" },
  { id: "ticket", name: "Nummer", type: "id", prefix: "T" },
  { id: "double", name: "Doppelt", type: "formula", formula: "Aufwand * 2" },
  { id: "budget", name: "Budget", type: "rollup", relationField: "project", rollupField: "budget", aggregate: "sum" },
  { id: "secret", name: "Geheim", type: "text", access: { read: "owners" } },
  { id: "odd key", name: "Seltsam", type: "text" },
] as Field[];
const tasks = await database("Aufgaben", fields);
// Values of every kind, also those SQL cannot compare like JavaScript.
const texts = [undefined, null, "", "  ", "Alpha", "alpha beta", "ALPHA", "Äpfel", "straße", "Kelvin", "İstanbul", "a**b**", "x\\*y", "line\r\nbreak", "[link](https://x.test)", "_kursiv_", "5", "10", "2026-01-05", "Erledigt", "erledigt", "Offen", "k", 5, 0, true, ["Alpha"], { a: 1, b: "x" }];
const numbers = [undefined, null, "", 0, 1, 5, 5.5, 6, -3, 12, 9007199254740993, "5", "abc", " 7 ", true, [5], 1e21];
const dates = [undefined, null, "", "2026-01-05", "2026-01-06", "2025-12-31", "2026-02-30", "2026-1-5", "2026-01-05T23:30:00Z", "2026-01-05 10:00", "x", 20260105, ["2026-01-05"], "2026-01-05abc"];
const selects = [undefined, null, "", "Offen", "Erledigt", "erledigt", "Ärger", "ärger", "  ", 5, ["Offen"]];
const multi = [undefined, null, [], ["Design"], ["Design", "Technik"], ["design"], ["Größe"], ["größe"], [""], [5], [null], "Design", ["  "], [["Design"]]];
const checks = [undefined, null, true, false, "true", 1, 0];
const lists = [undefined, [], [{ text: "a", done: true }], [{ text: "a", done: false }, { text: "b", done: true }]];
let position = 0;
for (let i = 0; i < 140; i++) {
  const cells: Record<string, unknown> = {};
  const set = (key: string, pool: readonly unknown[]) => {
    const value = pick(pool);
    if (value !== undefined) cells[key] = value;
  };
  set("title", texts);
  set("notes", texts);
  set("status", selects);
  set("tags", multi);
  set("estimate", numbers);
  set("due", dates);
  set("done", checks);
  set("owner", [undefined, ana.id, ben.id, "", "ghost"]);
  set("link", texts);
  set("list", lists);
  set("project", [undefined, [], [pick(projectIds)], [pick(projectIds), pick(projectIds)], "x"]);
  set("secret", texts);
  set("odd key", texts);
  // A cell of no property.
  if (rand() < 0.2) cells.stale = pick(texts);
  const access = rand() < 0.15 ? "private" : rand() < 0.1 ? "readonly" : "inherit";
  // Distinct positions (equal positions have no defined order on either path).
  position += 1 + Math.floor(rand() * 3);
  await run(
    "INSERT INTO rows(id,page_id,cells,position,created_by,created_at,number,access) VALUES(?,?,?,?,?,?,?,?)",
    id(),
    tasks,
    JSON.stringify(cells),
    position,
    pick([ana.id, ben.id]),
    `2026-01-0${1 + Math.floor(rand() * 9)} 1${Math.floor(rand() * 10)}:00:00`,
    rand() < 0.1 ? null : i + 1,
    access,
  );
}
const page = (await one<Page>("SELECT * FROM pages WHERE id=?", tasks))!;
const now = new Date("2026-01-05T12:00:00Z");
const labels = { members: [{ id: ana.id, name: "Ana" }, { id: ben.id, name: "Ben" }] };

// Values to compare with, per kind.
const values = ["", "a", "alpha", "ALPHA", "Ä", "äpfel", "k", "**", "x*y", "5", "5.5", "-3", "abc", "2026-01-05", "2026-01-05T10:00", "erledigt", "Offen", "ärger", " "];
const multiValues = [["design"], ["Design", "Technik"], ["größe"], [""], ["offen", "erledigt"], ["5"]];
function conditions(field: Field): Filter[] {
  const out: Filter[] = [];
  const ops = new Set<Filter["op"]>([...operatorsFor(field), "contains", "eq", "gt", "lte", "before", "empty", "notempty"]);
  for (const op of ops) {
    if (["any_of", "none_of", "all_of"].includes(op)) for (const vs of multiValues) out.push({ field: field.id, op, value: "", values: vs });
    else if (["empty", "notempty", "checked", "unchecked", "complete", "incomplete"].includes(op)) out.push({ field: field.id, op, value: "" });
    else if (op === "between")
      out.push({ field: field.id, op, value: "2026-01-01", to: "2026-01-05" }, { field: field.id, op, value: "6", to: "1" }, { field: field.id, op, value: "x", to: "5" });
    else if (op === "in_relative" || op === "not_in_relative") out.push({ field: field.id, op, value: "this_week", timeZone: "Europe/Berlin" });
    // A deterministic sample of the values (all of them would take minutes on PostgreSQL).
    else for (const value of values) if (rand() < 0.45) out.push({ field: field.id, op, value, ...(rand() < 0.3 ? { timeZone: "Pacific/Kiritimati" } : {}) });
  }
  return out;
}
const all = fields.flatMap(conditions);
all.push({ field: "gone", op: "eq", value: "a" });
const view = (filterGroup: FilterGroup | undefined, sorts: View["sorts"] = [], filters: Filter[] = [], rowOrder?: string[]): View =>
  ({ id: "v", name: "V", type: "table", filters, sorts, filterGroup, rowOrder }) as unknown as View;
const group = (join: "and" | "or", rules: FilterNode[]): FilterGroup => ({ kind: "group", join, rules });
const cond = (f: Filter): FilterNode => ({ ...f, kind: "condition" });

// What queryRows() gives over every record the person sees (the records
// and related data read once per person: nothing changes them here).
const base = new Map<string, Promise<{ fields: Field[]; rows: Row[]; related: Awaited<ReturnType<typeof relatedData>> }>>();
const baseOf = (user: Identity) => {
  if (!base.has(user.id))
    base.set(user.id, (async () => ({ fields: await visibleFields(user, page, fields), rows: await visibleRows(user, page, await rows(tasks)), related: await relatedData(user, page) }))());
  return base.get(user.id)!;
};
async function reference(user: Identity, v: View, query = "", withLabels = false, allFields = false) {
  const b = await baseOf(user);
  const shown = allFields ? fields : b.fields;
  return { fields: shown, rows: queryRows(b.rows, shown, v, query, b.related.related, b.related.relatedSchemas, now, withLabels ? labels : {}) };
}
let compared = 0;
async function same(user: Identity, v: View, pages: [number, number | undefined][] = [[0, undefined]], query = "", withLabels = false) {
  const expected = await reference(user, v, query, withLabels);
  for (const [offset, limit] of pages) {
    const got = await queryDatabaseRows(user, page, expected.fields, v, { offset, limit, now, query, ...(withLabels ? { labels } : {}) });
    const want = expected.rows.slice(offset, limit === undefined ? undefined : offset + limit);
    const label = JSON.stringify({ user: user.name, filter: v.filterGroup || v.filters, sorts: v.sorts, offset, limit, query });
    assert.equal(got.total, expected.rows.length, `total ${label}`);
    assert.deepEqual(got.rows.map((r) => r.id), want.map((r) => r.id), `ids ${label}`);
    assert.deepEqual(got.rows.map((r) => r.cells), want.map((r) => r.cells), `cells ${label}`);
    compared++;
  }
}

test("every single condition gives what queryRows() gives", async () => {
  for (const f of all) {
    const v = view(group("and", [cond(f)]));
    await same(ana, v);
    if (rand() < 0.35) await same(ben, v, [[0, undefined], [2, 5]]);
  }
  assert.ok(compared > 1500, `${compared} queries compared`);
  console.log(`${compared} single conditions compared`);
});

test("SQL narrows: simple conditions become SQL, the others stay with JavaScript", () => {
  const sqlOf = (f: Filter) => filterSql(group("and", [cond(f)]), fields)?.sql || null;
  assert.ok(sqlOf({ field: "status", op: "eq", value: "Offen" }));
  assert.ok(sqlOf({ field: "estimate", op: "gt", value: "5" }));
  assert.ok(sqlOf({ field: "due", op: "before", value: "2026-01-05" }));
  assert.ok(sqlOf({ field: "tags", op: "any_of", value: "", values: ["Design"] }));
  assert.ok(sqlOf({ field: "done", op: "checked", value: "" }));
  assert.ok(sqlOf({ field: "title", op: "empty", value: "" }));
  assert.equal(sqlOf({ field: "double", op: "gt", value: "5" }), null);
  assert.equal(sqlOf({ field: "budget", op: "gt", value: "5" }), null);
  assert.equal(sqlOf({ field: "created", op: "before", value: "2026-01-05" }), null);
  assert.equal(sqlOf({ field: "due", op: "in_relative", value: "this_week", timeZone: "UTC" }), null);
  // Non-ASCII values are left to JavaScript (lower() folds ASCII only).
  assert.equal(sqlOf({ field: "status", op: "eq", value: "Ärger" }), null);
  // An OR with a condition SQL cannot judge narrows nothing.
  assert.equal(filterSql(group("or", [cond({ field: "status", op: "eq", value: "Offen" }), cond({ field: "double", op: "gt", value: "1" })]), fields), null);
  assert.ok(filterSql(group("and", [cond({ field: "status", op: "eq", value: "Offen" }), cond({ field: "double", op: "gt", value: "1" })]), fields));
});

test("groups, sorts, the saved order, pages, search and labels", async () => {
  const sortable = fields.filter((f) => f.type !== "checklist");
  const pages: [number, number | undefined][] = [[0, undefined], [0, 7], [5, 10], [200, 10], [3, 0]];
  for (let i = 0; i < 160; i++) {
    const rules: FilterNode[] = [];
    const n = Math.floor(rand() * 4);
    for (let k = 0; k < n; k++)
      rules.push(rand() < 0.25 ? group(pick(["and", "or"] as const), [cond(pick(all)), cond(pick(all))]) : cond(pick(all)));
    const sorts = Array.from({ length: Math.floor(rand() * 3) }, () => ({ field: pick(sortable).id, direction: pick(["asc", "desc"] as const) }));
    const v = view(rules.length ? group(pick(["and", "or"] as const), rules) : undefined, sorts);
    await same(pick([ana, ben]), v, pages, "", rand() < 0.3);
  }
  // Legacy filters (no group), a saved row order, a search.
  const ids = (await rows(tasks)).map((r) => r.id);
  await same(ana, view(undefined, [], [{ field: "estimate", op: "gte", value: "5" }]), pages);
  await same(ana, view(undefined, [], [], [ids[7], ids[3], ids[90]]), pages);
  await same(ben, view(undefined, [{ field: "estimate", direction: "desc" }], [], [ids[7], ids[3]]), pages);
  await same(ana, view(group("and", [cond({ field: "status", op: "neq", value: "Erledigt" })]), [], []), pages, "alpha");
  await same(ben, view(undefined), pages, "Ana", true);
  // No filter, no sort: the page straight from SQL.
  await same(ana, view(undefined), pages);
  await same(ben, view(undefined), pages);
  // countOnly
  const counted = await queryDatabaseRows(ben, page, await visibleFields(ben, page, fields), view(group("and", [cond({ field: "estimate", op: "gt", value: "5" })])), { countOnly: true, now });
  assert.equal(counted.total, (await reference(ben, view(group("and", [cond({ field: "estimate", op: "gt", value: "5" })])))).rows.length);
  assert.deepEqual(counted.rows, []);
});

test("with all properties and hidden cells empty (as dashboards pass them)", async () => {
  for (let i = 0; i < 60; i++) {
    const f = pick(all);
    const v = view(group("and", [cond(f)]), [{ field: pick(fields).id, direction: "asc" }]);
    const expected = (await reference(ben, v, "", false, true)).rows;
    const got = await queryDatabaseRows(ben, page, fields, v, { now });
    assert.deepEqual(got.rows.map((r) => r.id), expected.map((r) => r.id), JSON.stringify(v.filterGroup));
    assert.deepEqual(got.rows.map((r) => r.cells), expected.map((r) => r.cells));
  }
});
