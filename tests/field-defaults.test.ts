// Default values per database property (#411, lib/field-defaults.ts): new
// records without a value get the property's default – made in a view, by
// the API, a form (hidden or empty questions too), an automation, an
// import (only for properties the file does not carry) or offline;
// existing records never change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-field-defaults-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database, rows } = await import("../lib/api");
const { field } = await import("../lib/database-schema");
const defaults = await import("../lib/field-defaults");
const { applyQueue } = await import("../lib/offline-queue");
const { saveFormSubmission } = await import("../lib/forms");
const { openApiDocument } = await import("../lib/openapi");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Ada", "ada@example.test");
const owner = { id: uid, name: "Ada", email: "ada@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Standardwerte");
const space = (await bootstrap(owner, wid)).spaces[0].id;

const schema: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"], defaultValue: { kind: "value", value: "Offen" } },
  { id: "tags", name: "Tags", type: "multiselect", options: ["a", "b", "c"], defaultValue: { kind: "value", value: ["a", "c"] } },
  { id: "note", name: "Notiz", type: "text", defaultValue: { kind: "value", value: "Bitte prüfen" } },
  { id: "points", name: "Punkte", type: "number", defaultValue: { kind: "value", value: 3 } },
  { id: "urgent", name: "Dringend", type: "checkbox", defaultValue: { kind: "value", value: true } },
  { id: "due", name: "Fällig", type: "date", noTime: true, defaultValue: { kind: "now" } },
  { id: "logged", name: "Erfasst", type: "date", defaultValue: { kind: "now" } },
  { id: "start", name: "Start", type: "date", defaultValue: { kind: "value", value: "2026-12-01" } },
  { id: "owner", name: "Verantwortlich", type: "person", defaultValue: { kind: "creator" } },
];
async function databaseWith(title: string, fields: Field[]) {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, kind: "database" })) as { id: string }).id;
  const d = await database(pageId);
  await command(owner, { action: "database.update", pageId, version: d.version, views: d.views, fields });
  return pageId;
}
const cellsOf = async (pageId: string, rowId: string) => (await rows(pageId)).find((r) => r.id === rowId)!.cells;

test("what a property may have as default, and what is dropped", () => {
  const ok = (f: Partial<Field> & { defaultValue: unknown }) => defaults.cleanDefault({ id: "x", name: "X", type: "text", ...f } as Field);
  assert.deepEqual(ok({ type: "select", options: ["A"], defaultValue: { kind: "value", value: "A" } }), { kind: "value", value: "A" });
  assert.equal(ok({ type: "select", options: ["A"], defaultValue: { kind: "value", value: "B" } }), undefined, "an option that is gone");
  assert.deepEqual(ok({ type: "multiselect", options: ["A", "B"], defaultValue: { kind: "value", value: ["B", "Z", "B"] } }), { kind: "value", value: ["B"] });
  assert.equal(ok({ type: "number", defaultValue: { kind: "value", value: "3" } }), undefined);
  assert.equal(ok({ type: "checkbox", defaultValue: { kind: "value", value: false } }), undefined, "unchecked is empty anyway");
  assert.equal(ok({ type: "text", defaultValue: { kind: "value", value: "  " } }), undefined);
  assert.deepEqual(ok({ type: "date", noTime: true, defaultValue: { kind: "value", value: "2026-05-04T10:00:00Z" } }), { kind: "value", value: "2026-05-04" });
  assert.equal(ok({ type: "date", defaultValue: { kind: "value", value: "morgen" } }), undefined);
  assert.equal(ok({ type: "text", defaultValue: { kind: "now" } }), undefined, "Heute/Jetzt only for dates");
  assert.equal(ok({ type: "date", defaultValue: { kind: "creator" } }), undefined);
  assert.deepEqual(ok({ type: "person", defaultValue: { kind: "creator" } }), { kind: "creator" });
  assert.equal(ok({ type: "person", defaultValue: { kind: "value", value: "someone" } }), undefined);
  for (const type of ["url", "relation", "formula", "files", "rollup", "created_by"] as const) assert.equal(ok({ type, defaultValue: { kind: "value", value: "x" } }), undefined, type);
  assert.equal(ok({ type: "multiselect", tagOptions: true, defaultValue: { kind: "value", value: ["a"] } }), undefined, "tags as options");
  assert.equal(field.safeParse({ id: "x", name: "X", type: "text", defaultValue: { kind: "maybe" } }).success, false);
  // A renamed option takes the default along.
  const fields = defaults.cleanDefaults([{ id: "s", name: "S", type: "select", options: ["Neu"], defaultValue: { kind: "value", value: "Alt" } }] as Field[], [{ field: "s", from: "Alt", to: "Neu" }]);
  assert.deepEqual(fields[0].defaultValue, { kind: "value", value: "Neu" });
});

test("only missing or empty values get the default; dynamic values are of the moment", () => {
  const now = Date.parse("2026-05-04T22:30:00Z");
  const cells = defaults.withDefaults(schema, { title: "A", status: "Erledigt", note: "" }, { creator: "u1", now, timeZone: "Europe/Berlin" });
  assert.deepEqual(cells, {
    title: "A",
    status: "Erledigt",
    tags: ["a", "c"],
    note: "Bitte prüfen",
    points: 3,
    urgent: true,
    // Already the 5th in Berlin.
    due: "2026-05-05",
    logged: "2026-05-04T22:30Z",
    start: "2026-12-01",
    owner: "u1",
  });
  // An import: what the file carries stays, even empty.
  assert.deepEqual(defaults.withDefaults(schema.slice(0, 4), { title: "B", status: "", tags: [] }, { creator: "u1", mode: "missing" }), {
    title: "B",
    status: "",
    tags: [],
    note: "Bitte prüfen",
  });
  // Nobody creates an anonymous answer: no "Ersteller".
  assert.equal("owner" in defaults.withDefaults(schema, {}, { creator: null }), false);
  // A record made offline: its moment, within the last 30 days.
  assert.equal(defaults.creationTime(now, now + 1000), now);
  assert.equal(defaults.creationTime(now + 5000, now), now, "not in the future");
  assert.equal(defaults.creationTime(now - 31 * 86_400_000, now), now);
  assert.equal(defaults.creationTime("gestern", now), now);
});

test("records made in a view, by the API, from a template or offline get the defaults; existing ones do not", async () => {
  const pageId = await databaseWith("Aufgaben", [{ id: "title", name: "Name", type: "text" }, { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] }]);
  const before = ((await command(owner, { action: "row.create", pageId, cells: { title: "Alt" } })) as { id: string }).id;
  // Defaults set afterwards; invalid ones are dropped when saving.
  const d = await database(pageId);
  await command(owner, {
    action: "database.update",
    pageId,
    version: d.version,
    views: d.views,
    fields: [...schema, { id: "link", name: "Link", type: "url", defaultValue: { kind: "value", value: "https://example.org" } }, { id: "gone", name: "Weg", type: "select", options: ["x"], defaultValue: { kind: "value", value: "y" } }],
  });
  const stored = (await database(pageId)).fields;
  assert.deepEqual(stored.find((f) => f.id === "status")?.defaultValue, { kind: "value", value: "Offen" });
  assert.equal(stored.find((f) => f.id === "link")?.defaultValue, undefined);
  assert.equal(stored.find((f) => f.id === "gone")?.defaultValue, undefined);
  assert.equal((await cellsOf(pageId, before)).status, undefined, "an existing record stays as it was");

  const plain = ((await command(owner, { action: "row.create", pageId, cells: { title: "Neu", points: 8 }, timeZone: "UTC" })) as { id: string }).id;
  const cells = await cellsOf(pageId, plain);
  assert.equal(cells.status, "Offen");
  assert.deepEqual(cells.tags, ["a", "c"]);
  assert.equal(cells.points, 8, "a given value wins");
  assert.equal(cells.urgent, true);
  assert.equal(cells.owner, owner.id);
  assert.equal(cells.due, new Date().toISOString().slice(0, 10));
  assert.match(String(cells.logged), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  // Empty given values count as none (as an empty form question).
  const empty = ((await command(owner, { action: "row.create", pageId, cells: { title: "Leer", status: "", tags: [] } })) as { id: string }).id;
  assert.equal((await cellsOf(pageId, empty)).status, "Offen");
  // A record template's value wins over the default.
  await command(owner, { action: "row.update", pageId, rowId: plain, version: (await rows(pageId)).find((r) => r.id === plain)!.version, cells: { status: "Erledigt" } });
  const template = (await command(owner, { action: "row.template.save", pageId, rowId: plain, name: "Erledigt-Vorlage" })) as { id: string };
  const fromTemplate = ((await command(owner, { action: "row.create", pageId, cells: { title: "Aus Vorlage" }, templateId: template.id })) as { id: string }).id;
  assert.equal((await cellsOf(pageId, fromTemplate)).status, "Erledigt");
  // Made offline yesterday, sent today: "Heute" is the day it was made.
  const yesterday = Date.now() - 86_400_000;
  const offline = ((await command(owner, { action: "row.create", pageId, rowId: crypto.randomUUID(), cells: { title: "Offline" }, createdAt: yesterday, timeZone: "UTC" })) as { id: string }).id;
  assert.equal((await cellsOf(pageId, offline)).due, new Date(yesterday).toISOString().slice(0, 10));
  // On the device it shows with the same defaults before it is sent.
  const shown = applyQueue([], [{ id: "c1", kind: "create", pageId, rowId: "r1", cells: { title: "Wartet" }, at: yesterday }], pageId, { fields: stored, creator: owner.id });
  assert.equal(shown[0].cells.status, "Offen");
  assert.equal(shown[0].cells.owner, owner.id);
  assert.match(String(shown[0].cells.due), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(shown[0].cells.logged, `${new Date(yesterday).toISOString().slice(0, 16)}Z`);
});

test("the CSV import fills only properties the file has no column for", async () => {
  const pageId = await databaseWith("Import", schema.slice(0, 4));
  await command(owner, { action: "rows.import", pageId, rows: [{ title: "Zeile", status: "" }, { title: "Zeile 2", status: "Erledigt" }] });
  const imported = (await rows(pageId)).filter((r) => String(r.cells.title).startsWith("Zeile"));
  for (const r of imported) {
    assert.deepEqual(r.cells.tags, ["a", "c"], "no column: the default");
    assert.equal(r.cells.note, "Bitte prüfen");
  }
  assert.deepEqual(imported.map((r) => r.cells.status).sort(), ["", "Erledigt"], "an empty column stays empty");
});

test("a form answer gets the defaults for hidden and empty questions", async () => {
  const pageId = await databaseWith("Anfragen", schema);
  await command(owner, { action: "form.update", pageId, enabled: true, internal: false, anonymous: true });
  await saveFormSubmission(pageId, null, { title: "Anfrage", note: "" });
  const answer = (await rows(pageId)).find((r) => r.cells.title === "Anfrage")!;
  assert.equal(answer.cells.status, "Offen");
  assert.equal(answer.cells.note, "Bitte prüfen");
  assert.equal(answer.cells.owner, undefined, "an anonymous answer has no creator");
});

test("the API schema documents the default", () => {
  const property = (openApiDocument() as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } }).components.schemas.Field;
  assert.ok(property.properties.defaultValue);
});
