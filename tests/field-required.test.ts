// Required properties (#443, lib/field-required.ts): new records get the
// default or, for a select, its first option; clearing a value is refused
// (API, bulk changes, board moves, share links, workflows); forms ask them
// as required questions; a grouping by one hides the empty group while no
// record is empty. Existing empty records stay as they are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, Row } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-field-required-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database, rows } = await import("../lib/api");
const required = await import("../lib/field-required");
const { withDefaults } = await import("../lib/field-defaults");
const { applyQueue } = await import("../lib/offline-queue");
const { databaseGroups, configuredGroups } = await import("../lib/database-groups");
const { saveFormSubmission } = await import("../lib/forms");
const { withRequiredProperties, validateFormValues, formConfigSchema } = await import("../lib/form-settings");
const { englishMessage } = await import("../lib/i18n-errors");
const { openApiDocument } = await import("../lib/openapi");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Ada", "ada@example.test");
const owner = { id: uid, name: "Ada", email: "ada@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Pflichtfelder");
const space = (await bootstrap(owner, wid)).spaces[0].id;

const plain: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
  { id: "priority", name: "Priorität", type: "select", options: ["Hoch", "Niedrig"] },
  { id: "note", name: "Notiz", type: "text" },
];
const withRequired: Field[] = [
  plain[0],
  { ...plain[1], required: true },
  { ...plain[2], required: true, defaultValue: { kind: "value", value: "Niedrig" } },
  { ...plain[3], required: true },
];
async function databaseWith(title: string, fields: Field[]) {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, kind: "database" })) as { id: string }).id;
  await setFields(pageId, fields);
  return pageId;
}
async function setFields(pageId: string, fields: Field[], views?: unknown[]) {
  const d = await database(pageId);
  await command(owner, { action: "database.update", pageId, version: d.version, views: views ?? d.views, fields });
}
const rowOf = async (pageId: string, rowId: string) => (await rows(pageId)).find((r) => r.id === rowId)!;
const create = async (pageId: string, cells: Record<string, unknown>) =>
  ((await command(owner, { action: "row.create", pageId, cells })) as { id: string }).id;
const update = async (pageId: string, rowId: string, cells: Record<string, unknown>) =>
  command(owner, { action: "row.update", pageId, rowId, version: (await rowOf(pageId, rowId)).version, cells });

test("which properties can be required, and what is stored", () => {
  const f = (p: Partial<Field>) => ({ id: "x", name: "X", type: "text", ...p }) as Field;
  for (const type of ["text", "number", "date", "select", "multiselect", "url", "email", "phone", "person", "relation", "files"] as const)
    assert.ok(required.canBeRequired(f({ type })), type);
  for (const type of ["checkbox", "formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id", "progress", "time", "sprint", "checklist", "aliases"] as const)
    assert.equal(required.canBeRequired(f({ type })), false, type);
  assert.equal(required.canBeRequired(f({ type: "text", ai: { prompt: "Fasse {Name} zusammen" } })), false, "AI fills it");
  assert.equal(required.canBeRequired(f({ type: "relation", parent: true })), false, "top-level records have no parent");
  const cleaned = required.cleanRequired([f({ id: "a", required: true }), f({ id: "b", type: "formula", required: true }), f({ id: "c", required: false })]);
  assert.deepEqual(cleaned.map((x) => x.required), [true, undefined, undefined]);
});

test("a new record: the default, else a select's first option, else empty and missing", () => {
  const cells = withDefaults(withRequired, { title: "Neu" }, { creator: owner.id });
  assert.equal(cells.status, "Offen", "no default: the first option");
  assert.equal(cells.priority, "Niedrig", "the default wins over the first option");
  assert.equal(cells.note, undefined, "text without a default stays empty");
  assert.deepEqual(required.missingRequired(withRequired, cells).map((f) => f.id), ["note"]);
  // An empty given value counts as none, also in an import's "missing" mode.
  assert.equal(withDefaults(withRequired, { status: "" }, { creator: null, mode: "missing" }).status, "Offen");
  assert.equal(withDefaults(plain, { status: "" }, { creator: null, mode: "missing" }).status, "", "not required: the file says empty");
  assert.equal(withDefaults(withRequired, { status: "Erledigt" }, { creator: null }).status, "Erledigt", "a given value wins");
  // A select without options has nothing to give.
  assert.equal(withDefaults([{ id: "s", name: "S", type: "select", options: [], required: true }], {}, { creator: null }).s, undefined);
  // Offline: the device shows the same values before the record is sent.
  const shown = applyQueue([], [{ id: "c1", kind: "create", pageId: "p", rowId: "r1", cells: { title: "Wartet" }, at: Date.now() }], "p", { fields: withRequired, creator: owner.id });
  assert.equal(shown[0].cells.status, "Offen");
  assert.equal(shown[0].cells.priority, "Niedrig");
});

test("clearing: only a value that is there is protected", () => {
  assert.equal(required.clearedRequired(withRequired, { status: "" }, { status: "Offen" })?.id, "status");
  assert.equal(required.clearedRequired(withRequired, { status: "Erledigt" }, { status: "Offen" }), undefined);
  assert.equal(required.clearedRequired(withRequired, { status: "" }, {}), undefined, "already empty may stay so");
  assert.equal(required.clearedRequired(withRequired, { note: "  " }, { note: "Text" })?.id, "note", "blank text is empty");
  assert.equal(required.clearedRequired(plain, { status: "" }, { status: "Offen" }), undefined);
  assert.equal(required.requiredMessage({ name: "Status" }), "„Status“ ist ein Pflichtfeld und kann nicht leer sein.");
  assert.equal(englishMessage(required.requiredMessage({ name: "Status" })), "“Status” is required and cannot be empty.");
});

test("the API: schema, creation, refused clearing, bulk changes and old empty records", async () => {
  const pageId = await databaseWith("Aufgaben", plain);
  const old = await create(pageId, { title: "Alt" });
  // Switching it on while records are empty is allowed; they stay empty.
  await setFields(pageId, [...withRequired, { id: "calc", name: "Formel", type: "formula", formula: "1", required: true } as Field]);
  const stored = (await database(pageId)).fields;
  assert.equal(stored.find((f) => f.id === "status")?.required, true);
  assert.equal(stored.find((f) => f.id === "calc")?.required, undefined, "a formula cannot be required");
  assert.equal((await rowOf(pageId, old)).cells.status, undefined, "no migration");
  assert.equal(required.missingCount(stored.find((f) => f.id === "status")!, await rows(pageId)), 1);

  const fresh = await create(pageId, { title: "Neu", status: "" });
  const cells = (await rowOf(pageId, fresh)).cells;
  assert.equal(cells.status, "Offen");
  assert.equal(cells.priority, "Niedrig");
  assert.equal(cells.note, undefined, "created anyway, marked as missing");

  await assert.rejects(() => update(pageId, fresh, { status: "" }), (e: Error & { status?: number }) => {
    assert.equal(e.message, "„Status“ ist ein Pflichtfeld und kann nicht leer sein.");
    assert.equal(e.status, 400);
    return true;
  });
  await update(pageId, fresh, { note: "Jetzt mit Text" });
  await assert.rejects(() => update(pageId, fresh, { note: "" }), /„Notiz“ ist ein Pflichtfeld/);
  await update(pageId, fresh, { status: "Erledigt" });
  assert.equal((await rowOf(pageId, fresh)).cells.status, "Erledigt");
  // The old empty record: other changes work, empty may stay empty.
  await update(pageId, old, { title: "Alt, umbenannt", status: "" });
  assert.equal((await rowOf(pageId, old)).cells.title, "Alt, umbenannt");

  // Bulk changes: refused as a whole when one record would lose its value.
  const selection = await Promise.all([old, fresh].map(async (rid) => ({ id: rid, version: (await rowOf(pageId, rid)).version })));
  await assert.rejects(
    () => command(owner, { action: "rows.bulk", pageId, operation: "update", rows: selection, cells: { status: "" } }),
    /„Status“ ist ein Pflichtfeld/,
  );
  assert.equal((await rowOf(pageId, fresh)).cells.status, "Erledigt", "nothing changed");
});

test("boards and groupings: no empty group unless records still need a value", async () => {
  const field = { ...plain[1], required: true } as Field;
  const row = (rid: string, status?: string) => ({ id: rid, cells: status ? { status } : {} }) as unknown as Row;
  const full = databaseGroups([row("a", "Offen"), row("b", "Erledigt")], field, {});
  assert.deepEqual(full.map((g) => g.key), ['"Offen"', '"In Arbeit"', '"Erledigt"'], "no empty column");
  const withOld = databaseGroups([row("a", "Offen"), row("b")], field, {}, [], (de) => de);
  const empty = withOld.find((g) => g.key === "empty")!;
  assert.equal(empty.label, "Wert fehlt (Pflichtfeld)");
  assert.equal(empty.missing, true);
  assert.deepEqual(empty.rows.map((r) => r.id), ["b"]);
  // Not required: the empty group as always.
  assert.equal(databaseGroups([row("a", "Offen")], plain[1], {}, [], (de) => de).find((g) => g.key === "empty")?.label, "Ohne Gruppe");
  const board = { id: "v", name: "Board", type: "board", filters: [], sorts: [], groupBy: "status" } as never;
  assert.ok(configuredGroups(withOld, board).some((g) => g.key === "empty"), "a board shows the records that need a value");

  // Moving a card to the empty column is refused like clearing it.
  const pageId = await databaseWith("Board", plain);
  const d = await database(pageId);
  const views = [{ id: "board", name: "Board", type: "board", filters: [], sorts: [], groupBy: "status" }];
  await setFields(pageId, d.fields, views);
  const old = await create(pageId, { title: "Alt" });
  await setFields(pageId, [plain[0], { ...plain[1], required: true }, plain[2], plain[3]], views);
  const card = await create(pageId, { title: "Karte" });
  assert.equal((await rowOf(pageId, card)).cells.status, "Offen");
  await assert.rejects(
    async () =>
      command(owner, {
        action: "row.move",
        pageId,
        viewId: "board",
        version: (await database(pageId)).version,
        rowId: card,
        rowVersion: 1,
        targetId: old,
        placement: "after",
        group: { from: '"Offen"', to: "empty" },
      }),
    /„Status“ ist ein Pflichtfeld/,
  );
  // Out of the empty column into a status works.
  await command(owner, {
    action: "row.move",
    pageId,
    viewId: "board",
    version: (await database(pageId)).version,
    rowId: old,
    rowVersion: (await rowOf(pageId, old)).version,
    targetId: card,
    placement: "after",
    group: { from: "empty", to: '"Offen"' },
  });
  assert.equal((await rowOf(pageId, old)).cells.status, "Offen");
});

test("forms ask a required property as a required question", async () => {
  const config = formConfigSchema.parse({});
  const asked = withRequiredProperties(withRequired, config);
  assert.deepEqual(asked.requiredFields.sort(), ["note", "priority", "status"]);
  assert.deepEqual(config.requiredFields, [], "the stored settings stay as they are");
  assert.match(validateFormValues(withRequired, asked, { title: "x" }).errors.note ?? "", /Notiz: Bitte ausfüllen/);

  const pageId = await databaseWith("Anfragen", withRequired);
  await command(owner, { action: "form.update", pageId, enabled: true, internal: false, anonymous: true });
  await assert.rejects(() => saveFormSubmission(pageId, null, { title: "Ohne Notiz", status: "Offen", priority: "Hoch" }), /Notiz: Bitte ausfüllen/);
  // A question hidden in the form is not asked: the record gets the default
  // or first option there.
  await command(owner, { action: "form.update", pageId, config: { ...config, hiddenFields: ["status", "priority"] } });
  await saveFormSubmission(pageId, null, { title: "Mit Notiz", note: "Bitte zurückrufen" });
  const answer = (await rows(pageId)).find((r) => r.cells.title === "Mit Notiz")!;
  assert.equal(answer.cells.status, "Offen");
  assert.equal(answer.cells.priority, "Niedrig");
});

test("the CSV import gives an empty required select its first option", async () => {
  const pageId = await databaseWith("Import", withRequired);
  await command(owner, { action: "rows.import", pageId, rows: [{ title: "Zeile", status: "" }] });
  const imported = (await rows(pageId)).find((r) => r.cells.title === "Zeile")!;
  assert.equal(imported.cells.status, "Offen");
  assert.equal(imported.cells.priority, "Niedrig");
});

test("the API schema documents the switch", () => {
  const property = (openApiDocument() as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } }).components.schemas.Field;
  assert.ok(property.properties.required);
});
