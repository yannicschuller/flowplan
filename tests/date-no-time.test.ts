// Date properties without a time of day (#327, "Mit Uhrzeit" off,
// `noTime: true`): interactive and API writes may not add a time, a value
// that already has one keeps it (it can be moved or removed), imports,
// automations and quick capture take the date only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-date-no-time-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database, rows } = await import("../lib/api");
const { cleanNoTime, dateOnly, newTimeRefused, withoutNewTimes, NO_TIME_MESSAGE } = await import("../lib/date-values");
const { field } = await import("../lib/database-schema");
const { formConfigSchema, validateFormValues } = await import("../lib/form-settings");
const { validateSurvey, surveySchema } = await import("../lib/survey");
const { coerceToField } = await import("../lib/workflows/values");
const { mapTokens, cellsOf, tokens } = await import("../lib/capture-parse");
const { englishMessage } = await import("../lib/i18n-errors");
const { openApiDocument } = await import("../lib/openapi");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Zeit", "zeit@example.test");
const owner = { id: uid, name: "Zeit", email: "zeit@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Zeit");
const space = (await bootstrap(owner, wid)).spaces[0].id;

const plain: Field = { id: "d", name: "Datum", type: "date" };
const dateOnlyField: Field = { ...plain, noTime: true };
const refused = (e: Error & { status?: number }) => {
  assert.equal(e.status, 400);
  assert.equal(e.message, NO_TIME_MESSAGE);
  return true;
};

test("the rule: no new time, an existing one may stay, move or go", () => {
  assert.equal(newTimeRefused(dateOnlyField, "2026-05-04T09:30:00Z", ""), true);
  assert.equal(newTimeRefused(dateOnlyField, "2026-05-04T09:30:00Z", "2026-05-04"), true);
  assert.equal(newTimeRefused(dateOnlyField, "2026-05-04T09:30:00Z", undefined), true);
  assert.equal(newTimeRefused(dateOnlyField, "2026-05-05T10:00:00Z", "2026-05-04T09:30:00Z"), false);
  assert.equal(newTimeRefused(dateOnlyField, "2026-05-04", "2026-05-04T09:30:00Z"), false);
  assert.equal(newTimeRefused(dateOnlyField, "2026-05-04", ""), false);
  assert.equal(newTimeRefused(dateOnlyField, "", ""), false);
  // With time (the default) and other types: anything goes as before.
  assert.equal(newTimeRefused(plain, "2026-05-04T09:30:00Z", ""), false);
  assert.equal(newTimeRefused({ type: "text", noTime: true }, "2026-05-04T09:30", ""), false);
  // The day of a timed value, in a time zone.
  assert.equal(dateOnly("2026-05-04T23:30:00Z", "Europe/Berlin"), "2026-05-05");
  assert.equal(dateOnly("2026-05-04T23:30:00Z"), "2026-05-04");
  assert.equal(dateOnly("2026-05-04T09:30"), "2026-05-04");
  assert.equal(dateOnly("2026-05-04"), "2026-05-04");
  assert.equal(dateOnly(""), "");
  assert.deepEqual(withoutNewTimes([dateOnlyField, { id: "e", type: "date" }], { d: "2026-05-04T09:30Z", e: "2026-05-04T10:00Z" }), {
    d: "2026-05-04",
    e: "2026-05-04T10:00Z",
  });
  // English for the browser.
  assert.equal(englishMessage(NO_TIME_MESSAGE), "This property has no time. Please enter only a date.");
});

test("the setting: optional, stored only as noTime: true on date properties, in the API schema", () => {
  assert.equal(field.safeParse({ id: "d", name: "Datum", type: "date" }).success, true);
  assert.equal(field.safeParse({ id: "d", name: "Datum", type: "date", noTime: true }).success, true);
  assert.equal(field.safeParse({ id: "d", name: "Datum", type: "date", noTime: "ja" }).success, false);
  const fields = [
    { id: "a", type: "date", noTime: true },
    { id: "b", type: "date", noTime: false },
    { id: "c", type: "text", noTime: true },
    { id: "d", type: "date" },
  ];
  cleanNoTime(fields);
  assert.deepEqual(fields, [{ id: "a", type: "date", noTime: true }, { id: "b", type: "date" }, { id: "c", type: "text" }, { id: "d", type: "date" }]);
  assert.match(JSON.stringify(openApiDocument()), /"noTime":\{"type":"boolean"\}/);
});

test("records: new times refused, existing ones kept, moved and removed; imports keep the day", async () => {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Termine", kind: "database" })) as { id: string }).id;
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "d", name: "Datum", type: "date" },
    { id: "n", name: "Notiz", type: "text", noTime: true },
  ];
  let d = await database(pageId);
  await command(owner, { action: "database.update", pageId, version: d.version, views: d.views, fields });
  // A record with a time from before the switch.
  const timed = ((await command(owner, { action: "row.create", pageId, cells: { title: "Alt", d: "2026-05-04T09:30:00Z" } })) as { id: string }).id;
  const allDay = ((await command(owner, { action: "row.create", pageId, cells: { title: "Tag", d: "2026-05-04" } })) as { id: string }).id;
  d = await database(pageId);
  await command(owner, {
    action: "database.update",
    pageId,
    version: d.version,
    views: d.views,
    fields: fields.map((f) => (f.id === "d" ? { ...f, noTime: true } : f)),
  });
  d = await database(pageId);
  assert.equal(d.fields.find((f) => f.id === "d")?.noTime, true);
  assert.equal(d.fields.find((f) => f.id === "n")?.noTime, undefined, "only date properties keep the setting");
  const row = async (rid: string) => (await rows(pageId)).find((r) => r.id === rid)!;
  const update = async (rid: string, cells: Record<string, unknown>) =>
    await command(owner, { action: "row.update", pageId, rowId: rid, version: (await row(rid)).version, cells });

  // New records and all-day ones get no time.
  await assert.rejects(async () => await command(owner, { action: "row.create", pageId, cells: { title: "Neu", d: "2026-05-06T08:00:00Z" } }), refused);
  await assert.rejects(async () => await update(allDay, { d: "2026-05-04T09:00:00Z" }), refused);
  await command(owner, { action: "row.create", pageId, cells: { title: "Neu", d: "2026-05-06" } });
  await update(allDay, { d: "2026-05-05" });
  assert.equal((await row(allDay)).cells.d, "2026-05-05");
  // The existing time stays, can move and can be removed – then it is gone for good.
  assert.equal((await row(timed)).cells.d, "2026-05-04T09:30:00Z");
  await update(timed, { title: "Alt (geändert)" });
  assert.equal((await row(timed)).cells.d, "2026-05-04T09:30:00Z");
  await update(timed, { d: "2026-05-05T10:00:00Z" });
  assert.equal((await row(timed)).cells.d, "2026-05-05T10:00:00Z");
  await update(timed, { d: "2026-05-05" });
  assert.equal((await row(timed)).cells.d, "2026-05-05");
  await assert.rejects(async () => await update(timed, { d: "2026-05-05T10:00:00Z" }), refused);
  // Bulk edits are refused like single ones.
  await assert.rejects(
    async () => await command(owner, { action: "rows.bulk", pageId, operation: "update", rows: [{ id: allDay, version: (await row(allDay)).version }], cells: { d: "2026-05-04T09:00:00Z" } }),
    refused,
  );

  // The CSV import keeps the day, in the importing person's time zone.
  await command(owner, { action: "rows.import", pageId, timeZone: "Europe/Berlin", rows: [{ title: "CSV", d: "2026-05-04T23:30:00Z" }, { title: "CSV 2", d: "2026-05-07T08:00" }] });
  const imported = (await rows(pageId)).filter((r) => String(r.cells.title).startsWith("CSV")).map((r) => r.cells.d);
  assert.deepEqual(imported.sort(), ["2026-05-05", "2026-05-07"]);
});

test("calendar: no new time from the date editor; an existing timed event still moves", async () => {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Kalender", kind: "database" })) as { id: string }).id;
  let d = await database(pageId);
  const view = { id: "cal", name: "Kalender", type: "calendar", filters: [], sorts: [], dateField: "d" };
  await command(owner, { action: "database.update", pageId, version: d.version, views: [view], fields: [{ id: "title", name: "Name", type: "text" }, { id: "d", name: "Datum", type: "date" }] });
  const timed = ((await command(owner, { action: "row.create", pageId, cells: { title: "Alt", d: "2026-05-04T09:30:00Z" } })) as { id: string }).id;
  const allDay = ((await command(owner, { action: "row.create", pageId, cells: { title: "Tag", d: "2026-05-04" } })) as { id: string }).id;
  d = await database(pageId);
  await command(owner, { action: "database.update", pageId, version: d.version, views: [view], fields: [{ id: "title", name: "Name", type: "text" }, { id: "d", name: "Datum", type: "date", noTime: true }] });
  const schedule = async (rowId: string, change: Record<string, unknown>) =>
    await command(owner, {
      action: "row.schedule",
      pageId,
      viewId: "cal",
      version: (await database(pageId)).version,
      rowId,
      rowVersion: (await rows(pageId)).find((r) => r.id === rowId)!.version,
      change: { timeZone: "Europe/Berlin", ...change },
    });
  await assert.rejects(async () => await schedule(allDay, { operation: "set-range", start: "2026-05-04T09:00", end: "" }), refused);
  await schedule(timed, { operation: "move-time", at: "2026-05-04T12:00:00Z" });
  assert.equal((await rows(pageId)).find((r) => r.id === timed)!.cells.d, "2026-05-04T12:00:00Z");
  await schedule(timed, { operation: "set-range", start: "2026-05-06", end: "" });
  assert.equal((await rows(pageId)).find((r) => r.id === timed)!.cells.d, "2026-05-06");
});

test("forms and surveys ask for the date only", () => {
  const fields: Field[] = [{ id: "title", name: "Name", type: "text" }, dateOnlyField];
  const config = formConfigSchema.parse({});
  assert.match(validateFormValues(fields, config, { title: "A", d: "2026-05-04T09:00" }).errors.d, /nur ein Datum/);
  assert.deepEqual(validateFormValues(fields, config, { title: "A", d: "2026-05-04" }), { cells: { title: "A", d: "2026-05-04" }, errors: {} });
  // Without the setting a time stays possible.
  assert.deepEqual(validateFormValues([fields[0], plain], config, { d: "2026-05-04T09:00" }).errors, {});
  const survey = surveySchema.parse({
    enabled: true,
    items: [{ kind: "question", id: "q1", type: "date", field: "d", title: "Wann?" }],
  });
  assert.match(validateSurvey(survey, fields, { d: "2026-05-04T09:00" }).errors.d, /nur ein Datum/);
  assert.deepEqual(validateSurvey(survey, fields, { d: "2026-05-04" }).cells, { d: "2026-05-04" });
});

test("automations and quick capture take the date only", () => {
  // "Jetzt" and timed placeholders: the day in the run's time zone.
  assert.equal(coerceToField("2026-05-04T23:30:00Z", dateOnlyField, "de", "Europe/Berlin"), "2026-05-05");
  assert.equal(coerceToField("2026-05-04T23:30:00Z", plain, "de", "Europe/Berlin"), "2026-05-04T23:30Z");
  // "morgen 15 Uhr" in a database whose due date has no time.
  const properties = [{ id: "d", name: "Fällig", type: "date", due: true, noTime: true }];
  const chips = mapTokens(tokens("Anrufen morgen 15 Uhr", { today: "2026-10-26", locale: "de" }), properties, []);
  assert.deepEqual(cellsOf(chips, properties), { d: "2026-10-27" });
  const timed = [{ ...properties[0], noTime: undefined }];
  assert.deepEqual(cellsOf(mapTokens(tokens("Anrufen morgen 15 Uhr", { today: "2026-10-26", locale: "de" }), timed, []), timed), { d: "2026-10-27T15:00" });
});
