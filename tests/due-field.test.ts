// The due date of a database (#248): the explicit setting under "Status
// rules and done", "no due date", and name guesses for every UI language;
// plus done statuses in French, Italian, Spanish and Chinese.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";
import { doneRule, dueField, guessDueField, writableDueField, type DatabaseSettings } from "../lib/database-settings-schema";
import { parseCapture, type CaptureProperty } from "../lib/capture-parse";

const date = (id: string, name: string): Field => ({ id, name, type: "date" }) as Field;
const select = (id: string, name: string, options: string[]): Field => ({ id, name, type: "select", options }) as Field;
const pick = (fields: Field[], settings?: DatabaseSettings) => dueField(fields, settings)?.id;

test("name guesses: French, Italian, Spanish and Chinese, accents optional", () => {
  assert.equal(pick([date("buy", "Date d'achat"), date("end", "Échéance")]), "end");
  assert.equal(pick([date("buy", "Date d'achat"), date("end", "Echeance")]), "end");
  // The reporter's database: the end of validity, not the purchase date.
  assert.equal(pick([date("buy", "Date d'achat"), date("end", "Fin de validité")]), "end");
  assert.equal(pick([date("a", "Data"), date("b", "Scadenza")]), "b");
  assert.equal(pick([date("a", "Creado"), date("b", "Fecha límite")]), "b");
  assert.equal(pick([date("a", "Fecha"), date("b", "Vencimiento")]), "b");
  assert.equal(pick([date("a", "创建日期"), date("b", "截止日期")]), "b");
  assert.equal(pick([date("a", "购买日期"), date("b", "到期日")]), "b");
  assert.equal(pick([date("a", "Créé"), date("b", "Date limite")]), "b");
  // Clear words beat weaker ones: "Terminé le" is no deadline.
  assert.equal(pick([date("a", "Terminé le"), date("b", "Échéance")]), "b");
});

test("existing guesses stay as they were", () => {
  assert.equal(pick([date("a", "Start"), date("b", "Fällig am")]), "b");
  assert.equal(pick([date("a", "Start"), date("b", "Faellig")]), "b");
  assert.equal(pick([date("a", "Start"), date("b", "Due")]), "b");
  assert.equal(pick([date("a", "Start"), date("b", "Deadline")]), "b");
  assert.equal(pick([date("a", "Start"), date("b", "Abgabefrist")]), "b");
  assert.equal(pick([date("a", "Start"), date("b", "Termin")]), "b");
  assert.equal(pick([date("a", "Von"), date("b", "Bis")]), "b");
  assert.equal(pick([date("a", "Start"), date("b", "Gültig bis")]), "b");
  // Nothing named so: the first date property.
  assert.equal(pick([date("a", "Erstellt"), date("b", "Geändert")]), "a");
  assert.equal(pick([{ id: "t", name: "Due", type: "text" } as Field]), undefined);
  assert.equal(guessDueField([date("a", "Erstellt")]), undefined);
});

test("the explicit setting wins; a deleted or changed property falls back to the guess", () => {
  const fields = [date("buy", "Date d'achat"), date("end", "Échéance")];
  assert.equal(pick(fields, { due: { field: "buy" } }), "buy");
  assert.equal(pick(fields, { due: { none: true } }), undefined);
  assert.equal(pick(fields, { due: { field: "gone" } }), "end");
  assert.equal(pick([...fields, { id: "txt", name: "Text", type: "text" } as Field], { due: { field: "txt" } }), "end");
  // Where a captured date goes: only writable properties.
  assert.equal(writableDueField(fields, { due: { field: "buy" } }, [fields[1]])?.id, undefined);
  assert.equal(writableDueField(fields, undefined, [fields[1]])?.id, "end");
  assert.equal(writableDueField(fields, { due: { none: true } }, fields)?.id, undefined);
});

test("done statuses in every UI language; expired is not done", () => {
  const status = (options: string[]) => doneRule([select("s", "Statut", options)], undefined)?.values;
  assert.deepEqual(status(["Actif", "Utilisé", "Expiré"]), ["Utilisé"]);
  assert.deepEqual(status(["À faire", "En cours", "Terminé"]), ["Terminé"]);
  assert.deepEqual(status(["Ouvert", "Fermé", "Résolu", "Clos"]), ["Fermé", "Résolu", "Clos"]);
  assert.deepEqual(status(["Aperto", "Completato", "Chiuso"]), ["Completato", "Chiuso"]);
  assert.deepEqual(status(["Pendiente", "Hecho", "Cerrado"]), ["Hecho", "Cerrado"]);
  assert.deepEqual(status(["待办", "进行中", "已完成"]), ["已完成"]);
  assert.deepEqual(status(["Open", "Expired"]), undefined);
  // German and English as before (with or without umlauts).
  assert.deepEqual(status(["Offen", "Erledigt", "Gelöst"]), ["Erledigt", "Gelöst"]);
  assert.deepEqual(status(["Todo", "Done", "Closed"]), ["Done", "Closed"]);
  // A French checkbox.
  assert.equal(doneRule([{ id: "c", name: "Terminé", type: "checkbox" } as Field], undefined)?.field.id, "c");
});

test("quick capture writes into the due date the server marked", () => {
  const today = "2026-10-26";
  const props = (marks?: (boolean | undefined)[]): CaptureProperty[] =>
    [
      { id: "buy", name: "Date d'achat", type: "date" },
      { id: "end", name: "Échéance", type: "date" },
    ].map((p, i) => (marks ? { ...p, due: marks[i] } : p));
  assert.deepEqual(parseCapture("Appel demain", { today, locale: "fr", properties: props() }).cells, { end: "2026-10-27" });
  assert.deepEqual(parseCapture("Appel demain", { today, locale: "fr", properties: props([true, false]) }).cells, { buy: "2026-10-27" });
  // "No due date": the date stays in the text.
  assert.deepEqual(parseCapture("Appel demain", { today, locale: "fr", properties: props([false, false]) }).cells, {});
});

/* ---------- My tasks, due notifications and widgets ---------- */

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-due-"));
const { id, run } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { crossRecords } = await import("../lib/cross-records");
const { dueItems } = await import("../lib/notification-events");
const { myRecordTasks } = await import("../lib/mobile-widgets");
const { captureProperties } = await import("../lib/desktop-capture");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "me", "me@test.invalid");
const me: Identity = { id: uid, name: "me", email: "me@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
const wid = await createWorkspace(me.id, "Vouchers"),
  boot = await bootstrap(me, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(me, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Bons" })).id as string;
await act({
  action: "database.update",
  pageId,
  version: (await database(pageId)).version,
  fields: [
    { id: "title", name: "Nom", type: "text" },
    { id: "state", name: "Statut", type: "select", options: ["Actif", "Utilisé", "Expiré"] },
    { id: "who", name: "Responsable", type: "person" },
    { id: "buy", name: "Date d'achat", type: "date" },
    { id: "end", name: "Échéance", type: "date" },
  ],
  views: (await database(pageId)).views,
});
await act({ action: "row.create", pageId, cells: { title: "Bon cadeau", state: "Actif", who: me.id, buy: "2020-01-01", end: "2099-12-31" } });
await act({ action: "row.create", pageId, cells: { title: "Bon utilisé", state: "Utilisé", who: me.id, buy: "2020-01-01", end: "2020-06-01" } });
const settings = async (patch: Record<string, unknown>) => await act({ action: "database.settings", pageId, settings: patch });
const dueOf = async () => (await crossRecords(me, wid, {})).records.map((r) => [r.title, r.due]);
const widgetDue = async () => (await myRecordTasks(me, () => true)).map((t) => [t.text, t.due]);

test("My tasks, notifications and widgets use the guessed due date; used vouchers are done", async () => {
  assert.deepEqual(await dueOf(), [["Bon cadeau", "2099-12-31"]]);
  assert.deepEqual(await widgetDue(), [["Bon cadeau", "2099-12-31"]]);
  assert.deepEqual((await dueItems(wid, pageId, "2026-11-12")).map((i) => i.title), []);
  const dates = (await captureProperties(me, await pageOf())).filter((p) => p.type === "date");
  assert.deepEqual(dates.map((p) => [p.id, p.due]), [["buy", false], ["end", true]]);
});

test("the explicit setting changes them all", async () => {
  await settings({ due: { field: "buy" } });
  assert.deepEqual(await dueOf(), [["Bon cadeau", "2020-01-01"]]);
  assert.deepEqual(await widgetDue(), [["Bon cadeau", "2020-01-01"]]);
  assert.deepEqual((await dueItems(wid, pageId, "2026-11-12")).map((i) => [i.title, i.due, i.overdue]), [["Bon cadeau", "2020-01-01", true]]);
});

test("no due date: records show without one and nothing is due", async () => {
  await settings({ due: { none: true } });
  assert.deepEqual(await dueOf(), [["Bon cadeau", null]]);
  assert.deepEqual(await widgetDue(), [["Bon cadeau", null]]);
  assert.deepEqual(await dueItems(wid, pageId, "2099-12-31"), []);
  assert.deepEqual((await crossRecords(me, wid, { due: "dated" })).records, []);
  assert.deepEqual((await captureProperties(me, await pageOf())).filter((p) => p.type === "date").map((p) => p.due), [false, false]);
  // Back to automatic.
  await settings({ due: null });
  assert.deepEqual(await dueOf(), [["Bon cadeau", "2099-12-31"]]);
});

test("the setting must name a date property", async () => {
  await assert.rejects(settings({ due: { field: "title" } }), /unbekannte Eigenschaft/);
  await assert.rejects(settings({ due: { field: "nope" } }), /unbekannte Eigenschaft/);
  await assert.rejects(settings({ due: { none: false } }));
});

async function pageOf() {
  const { one } = await import("../lib/db");
  return (await one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", pageId))!;
}
