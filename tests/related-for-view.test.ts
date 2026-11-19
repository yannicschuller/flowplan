// What opening a database sends of related databases (#383,
// lib/related-data.ts relatedForView()): every record of a directly related
// database with its title and icon, the cells its rollups read (through
// formulas and rollups, also into a further database), nothing of
// databases no rollup reaches, no legacy text – and every computed value
// of the view (lib/database.ts computedCells()) is the same as with all
// related data (relatedData()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, Row } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-related-view-"));
const { id, run } = await import("../lib/db");
const { bootstrap, command, pageData, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { relatedData, relatedForView } = await import("../lib/related-data");
const { computedCells } = await import("../lib/database");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Owner", "owner@example.com");
const owner = { id: uid, name: "Owner", email: "owner@example.com", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Related");
const space = (await bootstrap(owner, wid)).spaces[0].id;
async function database(title: string, fields: Field[]) {
  const pid = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, kind: "database" })) as { id: string }).id;
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), pid);
  return pid;
}
const setFields = (pid: string, fields: Field[]) => run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), pid);
async function record(pid: string, cells: Record<string, unknown>, extra: { content?: string; icon?: string } = {}) {
  const rid = id();
  await run("INSERT INTO rows(id,page_id,cells,created_by,content,icon,number) VALUES(?,?,?,?,?,?,?)", rid, pid, JSON.stringify(cells), owner.id, extra.content || "", extra.icon || "", Math.floor(Math.random() * 1000));
  return rid;
}
const f = (field: Partial<Field> & { id: string; type: Field["type"] }) => ({ name: field.id, ...field }) as Field;

// D ← C ← B ← A (root), plus E only B relates to (no rollup reaches it).
const D = await database("D", [f({ id: "title", type: "text" }), f({ id: "weight", type: "number" })]);
const E = await database("E", [f({ id: "title", type: "text" }), f({ id: "secret", type: "text" })]);
const C = await database("C", [
  f({ id: "name", type: "text" }),
  f({ id: "y", type: "number" }),
  f({ id: "unused", type: "text" }),
  f({ id: "toD", type: "relation", relationPage: D }),
  f({ id: "dWeight", type: "rollup", relationField: "toD", rollupField: "weight", aggregate: "sum" }),
]);
const B = await database("B", [
  f({ id: "title", type: "text" }),
  f({ id: "estimate", type: "number" }),
  f({ id: "x", type: "number" }),
  f({ id: "notes", type: "text" }),
  f({ id: "done", type: "checkbox" }),
  f({ id: "toC", type: "relation", relationPage: C }),
  f({ id: "toE", type: "relation", relationPage: E }),
  f({ id: "cSum", type: "rollup", relationField: "toC", rollupField: "y", aggregate: "sum" }),
  f({ id: "cDeep", type: "rollup", relationField: "toC", rollupField: "dWeight", aggregate: "sum" }),
  f({ id: "calc", type: "formula", formula: 'prop("x") * 2 + prop("cSum")' }),
  f({ id: "when", type: "created_at" }),
]);
const A = await database("A", [
  f({ id: "title", type: "text" }),
  f({ id: "toB", type: "relation", relationPage: B }),
  f({ id: "self", type: "relation", relationPage: "" }),
  f({ id: "bEstimate", type: "rollup", relationField: "toB", rollupField: "estimate", aggregate: "sum" }),
  f({ id: "bCalc", type: "rollup", relationField: "toB", rollupField: "calc", aggregate: "max" }),
  f({ id: "bCount", type: "rollup", relationField: "toB", aggregate: "count" }),
  f({ id: "bDone", type: "rollup", relationField: "toB", rollupField: "done", aggregate: "percent_checked" }),
  f({ id: "bDeep", type: "rollup", relationField: "toB", rollupField: "cDeep", aggregate: "sum" }),
  f({ id: "bWhen", type: "rollup", relationField: "toB", rollupField: "when", aggregate: "latest_date" }),
  f({ id: "bOriginal", type: "rollup", relationField: "toB", rollupField: "notes", aggregate: "show_original" }),
  f({ id: "local", type: "formula", formula: 'prop("bEstimate") + 1' }),
]);
// A self relation of A.
const fieldsA = JSON.parse(JSON.stringify([
  f({ id: "title", type: "text" }),
  f({ id: "toB", type: "relation", relationPage: B }),
  f({ id: "self", type: "relation", relationPage: A }),
  f({ id: "bEstimate", type: "rollup", relationField: "toB", rollupField: "estimate", aggregate: "sum" }),
  f({ id: "bCalc", type: "rollup", relationField: "toB", rollupField: "calc", aggregate: "max" }),
  f({ id: "bCount", type: "rollup", relationField: "toB", aggregate: "count" }),
  f({ id: "bDone", type: "rollup", relationField: "toB", rollupField: "done", aggregate: "percent_checked" }),
  f({ id: "bDeep", type: "rollup", relationField: "toB", rollupField: "cDeep", aggregate: "sum" }),
  f({ id: "bWhen", type: "rollup", relationField: "toB", rollupField: "when", aggregate: "latest_date" }),
  f({ id: "bOriginal", type: "rollup", relationField: "toB", rollupField: "notes", aggregate: "show_original" }),
  f({ id: "selfCount", type: "rollup", relationField: "self", aggregate: "count" }),
  f({ id: "local", type: "formula", formula: 'prop("bEstimate") + 1' }),
])) as Field[];
await setFields(A, fieldsA);
const ds = [await record(D, { title: "d1", weight: 3 }), await record(D, { title: "d2", weight: 4 })];
const es = [await record(E, { title: "e1", secret: "s" })];
const cs = [await record(C, { name: "c1", y: 5, unused: "u", toD: ds }), await record(C, { name: "c2", y: 7, unused: "v", toD: [ds[0]] })];
const bs = [
  await record(B, { title: "b1", estimate: 2, x: 1, notes: "n1", done: true, toC: cs, toE: es }, { content: "<p>legacy text</p>", icon: "star" }),
  await record(B, { title: "b2", estimate: 5, x: 4, notes: "n2", done: false, toC: [cs[1]] }),
  await record(B, { title: "b3", estimate: 1, x: 0, notes: "n3" }),
];
const as = [await record(A, { title: "a1", toB: [bs[0], bs[1]] }), await record(A, { title: "a2", toB: [bs[2]], self: [] })];
await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ title: "a2", toB: [bs[2]], self: [as[0]] }), as[1]);

async function compare(label: string) {
  const { stored } = { stored: (await import("../lib/db")).one };
  const root = (await stored<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", A))!;
  const full = await relatedData(owner, root);
  const slim = await relatedForView(owner, root);
  const own = await rows(A);
  // The view adds the root's own records (components/database-view.tsx).
  const view = (r: { related: Record<string, Row[]>; relatedSchemas: Record<string, Field[]> }) => ({ ...r.related, [A]: own });
  for (const row of own)
    assert.deepEqual(
      computedCells(row, fieldsA, view(slim), slim.relatedSchemas),
      computedCells(row, fieldsA, view(full), full.relatedSchemas),
      `${label}: computed cells of ${row.cells.title}`,
    );
  // Every record of a directly related database with title and icon.
  assert.deepEqual(slim.related[B].map((r) => [r.id, r.cells.title, r.icon]), full.related[B].map((r) => [r.id, r.cells.title, r.icon]));
  return { slim, full };
}

test("the view computes the same values with the slim related data", async () => {
  const { slim, full } = await compare("start");
  // B: the title and the stored cells the rollups read (estimate, done,
  // notes, the formula's x, the relation of cSum and cDeep), not toE.
  assert.deepEqual(Object.keys(slim.related[B].find((r) => r.id === bs[0])!.cells).sort(), ["done", "estimate", "notes", "title", "toC", "x"].sort());
  assert.ok(!slim.related[B].some((r) => "content" in r), "no legacy text");
  // C for cSum and cDeep (y, dWeight with toD); D for dWeight; not E.
  assert.deepEqual(Object.keys(slim.related[C][0].cells).sort(), ["name", "toD", "y"].sort());
  assert.ok(slim.related[D]);
  assert.ok(full.related[E] && !slim.related[E], "E is reached by no rollup");
  assert.ok(!slim.relatedSchemas[E]);
  assert.deepEqual(slim.related[A], []);
  assert.deepEqual(slim.relatedSchemas[B], full.relatedSchemas[B]);
});

test("a formula with a computed prop() reads all properties; changes keep the values equal", async () => {
  const fieldsB = (JSON.parse((await (await import("../lib/db")).one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", B))!.fields) as Field[]).map((x) =>
    x.id === "calc" ? { ...x, formula: 'prop("not" + "es") + prop("x")' } : x,
  );
  await setFields(B, fieldsB);
  const { slim } = await compare("dynamic prop");
  assert.ok("toE" in slim.related[B].find((r) => r.id === bs[0])!.cells, "all cells of B");
  // A progress property read by a rollup: all of that database.
  await setFields(C, [
    f({ id: "name", type: "text" }),
    f({ id: "y", type: "number" }),
    f({ id: "parent", type: "relation", relationPage: C, parent: true }),
    f({ id: "state", type: "text" }),
    f({ id: "progress", type: "progress", parentField: "parent", doneField: "state", doneValues: ["Done"] }),
    f({ id: "toD", type: "relation", relationPage: D }),
    f({ id: "dWeight", type: "rollup", relationField: "toD", rollupField: "weight", aggregate: "sum" }),
  ]);
  await setFields(B, fieldsB.map((x) => (x.id === "cSum" ? { ...x, rollupField: "progress", aggregate: "average" } : x)));
  await setFields(A, [...fieldsA, f({ id: "bProgress", type: "rollup", relationField: "toB", rollupField: "cSum", aggregate: "sum" })]);
  fieldsA.push(f({ id: "bProgress", type: "rollup", relationField: "toB", rollupField: "cSum", aggregate: "sum" }));
  // c1 has two subtasks, one of them done.
  const c3 = await record(C, { name: "c3", y: 1, parent: [cs[0]] });
  await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ name: "c2", y: 7, state: "Done", parent: [cs[0]], toD: [ds[0]] }), cs[1]);
  await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ title: "b3", estimate: 1, x: 0, notes: "n3", toC: [cs[0], c3] }), bs[2]);
  const { full } = await compare("progress");
  const progressOf = computedCells(full.related[C].find((r) => r.id === cs[0])!, full.relatedSchemas[C], full.related, full.relatedSchemas).progress;
  assert.equal(progressOf, 0.5, "the fixture has progress to compare");
  // A database reached only by a count rollup: its records, no cells.
  const G = await database("G", [f({ id: "title", type: "text" }), f({ id: "z", type: "number" })]);
  const g1 = await record(G, { title: "g1", z: 1 });
  const fieldsC = JSON.parse((await (await import("../lib/db")).one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", C))!.fields) as Field[];
  await setFields(C, [...fieldsC, f({ id: "toG", type: "relation", relationPage: G }), f({ id: "gCount", type: "rollup", relationField: "toG", aggregate: "count" })]);
  await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ name: "c1", y: 5, toD: ds, toG: [g1] }), cs[0]);
  await setFields(B, fieldsB.map((x) => (x.id === "cSum" ? { ...x, rollupField: "gCount", aggregate: "sum" } : x)));
  const counted = await compare("count only");
  assert.deepEqual(counted.slim.related[G].map((r) => Object.keys(r.cells).sort()), [["title"]]);
  // A rollup of the root that goes nowhere, one on a missing property.
  await setFields(A, [...fieldsA, f({ id: "broken", type: "rollup", relationField: "nope", rollupField: "x", aggregate: "sum" }), f({ id: "missing", type: "rollup", relationField: "toB", rollupField: "gone", aggregate: "sum" })]);
  await compare("broken rollups");
});

test("opening the database sends the slim related data and still works for its own records", async () => {
  const data = (await pageData(owner, A, { presence: false })) as unknown as { rows: Row[]; related: Record<string, Row[]>; relatedSchemas: Record<string, Field[]> };
  assert.equal(data.rows.length, 2);
  assert.ok(data.related[B] && !data.related[E]);
  assert.deepEqual(data.related[A], []);
});
