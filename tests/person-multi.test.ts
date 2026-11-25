// Person properties with several people (#535, lib/person-values.ts):
// "Mehrere Personen" makes the value a list of member ids; without it a
// property keeps one id. Writes take either shape, switching the setting
// converts the records (off: the first person stays), board moves, CSV
// imports and workflows follow, and an assignment notification reaches
// only the people a change added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-person-multi-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const people = await import("../lib/person-values");
const { searchOptions } = await import("../lib/option-search");
const { databaseGroups, groupCellValue } = await import("../lib/database-groups");
const { csvImporter, databaseCsv } = await import("../lib/database-csv");
const { coerceToField } = await import("../lib/workflows/values");
const { withDefaults } = await import("../lib/field-defaults");
const { titleDisplayText, titleMode } = await import("../lib/title-input");
const { englishMessage } = await import("../lib/i18n-errors");
const { validateFormValues, formConfigSchema } = await import("../lib/form-settings");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@test.invalid`);
  return { id: uid, name, email: `${name.toLowerCase()}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const ada = await user("Ada"),
  ben = await user("Ben"),
  cleo = await user("Cleo"),
  stranger = await user("Fremd");
const wid = await createWorkspace(ada.id, "Personen"),
  boot = await bootstrap(ada, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, cleo.id, "editor");
const act = async (body: Record<string, unknown>, who = ada): Promise<any> => await command(who, body);

const single: Field = { id: "owner", name: "Zuständig", type: "person" };
const multi: Field = { id: "team", name: "Team", type: "person", multiPerson: true };
const fields: Field[] = [{ id: "title", name: "Titel", type: "text" }, single, multi];
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Tickets" })).id as string;
const setFields = async (next: Field[]) => {
  const d = await database(pageId);
  await act({ action: "database.update", pageId, version: d.version, fields: next, views: d.views });
};
await setFields(fields);
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const update = async (rid: string, patch: Record<string, unknown>) =>
  await act({ action: "row.update", pageId, rowId: rid, version: await version(rid), cells: patch });
const create = async (c: Record<string, unknown>) => (await act({ action: "row.create", pageId, cells: c })).id as string;

test("values: one id or a list, read alike; stored in the property's shape", () => {
  assert.deepEqual(people.personIds("u1"), ["u1"]);
  assert.deepEqual(people.personIds(["u1", "u2", "u1", "", null]), ["u1", "u2"]);
  assert.deepEqual(people.personIds(""), []);
  assert.deepEqual(people.personIds(null), []);
  assert.equal(people.personCell(single, ["u1", "u2"]), "u1");
  assert.equal(people.personCell(single, []), "");
  assert.deepEqual(people.personCell(multi, ["u1", "u2", "u1"]), ["u1", "u2"]);
  assert.deepEqual(people.addedPeople(["u1"], ["u1", "u2"]), ["u2"]);
  assert.deepEqual(people.addedPeople("u1", "u2"), ["u2"]);
  assert.deepEqual(people.addedPeople(["u1", "u2"], ["u2"]), []);
  assert.equal(people.isMultiPerson({ type: "select", multiPerson: true }), false);
  const stored = [{ ...single, multiPerson: false }, { id: "d", name: "D", type: "date", multiPerson: true } as Field, { ...multi }];
  people.cleanMultiPerson(stored);
  assert.deepEqual(stored.map((f) => f.multiPerson), [undefined, undefined, true]);
  assert.deepEqual(people.multiPersonSwitchedOff([single, { ...multi, multiPerson: undefined }], [single, multi]), ["team"]);
  assert.deepEqual(people.multiPersonSwitchedOn([{ ...single, multiPerson: true }, multi], [single, multi]), ["owner"]);
  assert.equal(people.recordsWithSeveralPeople([{ cells: { team: ["a", "b"] } }, { cells: { team: ["a"] } }, { cells: { team: "a" } }], "team"), 1);
});

test("the picker finds members by name, not by id", () => {
  const names = new Map([["u1", "Ada Lovelace"], ["u2", "Ben"], ["u3", "Cléo"]]);
  const found = searchOptions(["u1", "u2", "u3"], "cleo", { labelOf: (o) => names.get(o)! });
  assert.deepEqual(found.matches, ["u3"]);
  assert.equal(found.exact, "u3");
  assert.deepEqual(searchOptions(["u1", "u2", "u3"], "", { exclude: ["u2"], labelOf: (o) => names.get(o)! }).matches, ["u1", "u3"]);
  assert.deepEqual(searchOptions(["u1"], "u1", { labelOf: (o) => names.get(o)! }).matches, [], "ids are not searched");
});

test("writes: a list for several people, one id otherwise; members only", async () => {
  const rid = await create({ title: "A", team: [ben.id, cleo.id, ben.id], owner: [ben.id] });
  assert.deepEqual((await cells(rid)).team, [ben.id, cleo.id]);
  assert.equal((await cells(rid)).owner, ben.id, "a list with one person is that person");
  await update(rid, { team: ada.id });
  assert.deepEqual((await cells(rid)).team, [ada.id], "one id becomes a list of one");
  await update(rid, { owner: [cleo.id] });
  assert.equal((await cells(rid)).owner, cleo.id);
  await assert.rejects(async () => await update(rid, { owner: [ben.id, cleo.id] }), (e: Error) => {
    assert.equal(e.message, people.ONE_PERSON_MESSAGE);
    assert.equal(englishMessage(e.message), "This property takes only one person. Turn on “Several people” to enter more.");
    return true;
  });
  await assert.rejects(async () => await update(rid, { team: [ben.id, stranger.id] }), /Mitglied fehlt/);
  await update(rid, { team: [] });
  assert.deepEqual((await cells(rid)).team, []);
});

test("switching on makes lists, switching off keeps the first person", async () => {
  const rid = await create({ title: "B", owner: ben.id, team: [cleo.id, ben.id] });
  const other = await create({ title: "C", team: [ada.id] });
  await setFields([fields[0], { ...single, multiPerson: true }, { ...multi, multiPerson: undefined }]);
  assert.deepEqual((await cells(rid)).owner, [ben.id]);
  assert.equal((await cells(rid)).team, cleo.id, "the first person stays");
  assert.equal((await cells(other)).team, ada.id);
  const stored = (await database(pageId)).fields;
  assert.equal(stored.find((f) => f.id === "owner")!.multiPerson, true);
  assert.equal(stored.find((f) => f.id === "team")!.multiPerson, undefined);
  await setFields(fields);
  assert.equal((await cells(rid)).owner, ben.id);
  assert.deepEqual((await cells(rid)).team, [cleo.id]);
});

test("new records: the creator default as a list; templates' single ids become lists", async () => {
  const withDefault = { ...multi, defaultValue: { kind: "creator" as const } };
  assert.deepEqual(withDefaults([withDefault], {}, { creator: ada.id }).team, [ada.id]);
  assert.equal(withDefaults([{ ...single, defaultValue: { kind: "creator" as const } }], {}, { creator: ada.id }).owner, ada.id);
  const rid = await create({ title: "D", team: ben.id });
  assert.deepEqual((await cells(rid)).team, [ben.id]);
});

test("board: a record with two people sits in both columns; a move swaps the person", () => {
  const members = [ada, ben, cleo];
  const row = { id: "r", page_id: "p", cells: { team: [ada.id, ben.id] }, position: 0, created_at: "", updated_at: "", created_by: "", updated_by: "", version: 1 };
  const groups = databaseGroups([row], multi, {}, members);
  assert.deepEqual(groups.filter((g) => g.rows.length).map((g) => g.label), ["Ada", "Ben"]);
  const from = groups.find((g) => g.label === "Ada")!.key;
  assert.deepEqual(groupCellValue(multi, cleo.id, [ada.id, ben.id], from), [ben.id, cleo.id]);
  assert.deepEqual(groupCellValue(multi, ada.id, ben.id), [ben.id, ada.id], "a stored single id counts");
  assert.deepEqual(groupCellValue(multi, null, [ada.id]), []);
  assert.equal(groupCellValue(single, cleo.id, ada.id), cleo.id);
});

test("CSV: names separated by commas, read back as a list; one person for a property with one", () => {
  const ctx = { members: [ada, ben, cleo].map((m) => ({ id: m.id, name: m.name, email: m.email })), untitled: "Ohne Titel", unavailable: "Nicht verfügbar" };
  const out = databaseCsv(fields, fields, [{ cells: { title: "A", owner: ada.id, team: [ben.id, cleo.id] } }], ctx);
  assert.match(out, /Ben, Cleo/);
  const read = csvImporter(fields, fields, ctx)({ Titel: "A", Zuständig: "Ada, Ben", Team: "Ben, cleo@test.invalid" });
  assert.equal(read.owner, ada.id);
  assert.deepEqual(read.team, [ben.id, cleo.id]);
});

test("workflows, titles and forms take the property's shape", () => {
  assert.deepEqual(coerceToField([{ id: "u1" }, "u2"], multi), ["u1", "u2"]);
  assert.equal(coerceToField(["u1"], single), "u1");
  assert.equal(titleMode(multi), "editor");
  assert.equal(titleMode(single), "typed");
  assert.equal(titleDisplayText(multi, [ada.id, ben.id], { members: [ada, ben] }), "Ada, Ben");
  const form = formConfigSchema.parse({ fields: ["team", "owner"] });
  const ok = validateFormValues(fields, form, { team: [ada.id, ben.id], owner: ben.id }, true);
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.cells.team, [ada.id, ben.id]);
  assert.equal(ok.cells.owner, ben.id);
  assert.ok(validateFormValues(fields, form, { owner: [ada.id, ben.id] }, true).errors.owner);
});

test("an assignment rule notifies only the people a change added", async () => {
  await act({
    action: "database.settings",
    pageId,
    settings: { automations: [{ id: "assign", name: "Zugewiesen", trigger: { type: "changed", field: "team" }, actions: [{ type: "notify", to: "field:team", message: "Neu zugewiesen" }] }] },
  });
  const rid = await create({ title: "E" });
  await update(rid, { team: [ben.id] });
  await update(rid, { team: [ben.id, cleo.id] });
  const notes = await all<{ user_id: string }>("SELECT user_id FROM notifications WHERE row_id=? AND kind='automation'", rid);
  const count = (uid: string) => notes.filter((n) => n.user_id === uid).length;
  assert.equal(count(ben.id), 1, "Ben was told once, when he was added");
  assert.equal(count(cleo.id), 1);
  await update(rid, { team: [cleo.id] });
  assert.equal((await all("SELECT 1 FROM notifications WHERE row_id=? AND kind='automation'", rid)).length, 2, "removing someone tells nobody");
  await act({ action: "database.settings", pageId, settings: { automations: [] } });
});

test("the listing gives both shapes as stored", async () => {
  const rid = await create({ title: "F", owner: ben.id, team: [ada.id, cleo.id] });
  const row = (await rows(pageId)).find((r) => r.id === rid)!;
  assert.equal(row.cells.owner, ben.id);
  assert.deepEqual(row.cells.team, [ada.id, cleo.id]);
});
