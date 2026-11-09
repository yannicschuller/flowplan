// Folding the properties of database records (#186): the choice per person
// and database, separately for phones and larger screens, in the account;
// the default (open; on phones folded with more than four properties); the
// folded line (the most telling values first, "+N").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-record-fold-"));
const { one, run, id, SCHEMA_VERSION } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { commandActionNames, commandActions } = await import("../lib/openapi");
const { isRecordFolded, summaryFields, SUMMARY_VALUES, SUMMARY_VALUES_NARROW } = await import("../lib/record-properties");
const { deleteInactiveAccount } = await import("../lib/account-deletion");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Olga"),
  viewer = await account("Vera"),
  stranger = await account("Sven");
const wid = await createWorkspace(owner.id, "Agentur");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as Record<string, unknown>;
const page = async (title: string, kind: string) => ((await act({ action: "page.create", workspaceId: wid, spaceId: team, title, kind })) as { id: string }).id;
const choice = async (pageId: string, as = owner) =>
  ((await pageData(as, pageId)) as { recordPropertiesCollapsed?: { phone: boolean | null; desktop: boolean | null } }).recordPropertiesCollapsed;
const fold = (pageId: string, device: string, collapsed: unknown, as = owner) =>
  act({ action: "database.collapseRecordProperties", pageId, device, collapsed }, as);

const aufgaben = await page("Aufgaben", "database");
const kunden = await page("Kunden", "database");
const notiz = await page("Notiz", "document");

test("schema 99: the columns exist", async () => {
  assert.ok(SCHEMA_VERSION >= 99);
  await run("INSERT INTO page_view_prefs(user_id,page_id,record_properties_phone,record_properties_desktop,updated_at) VALUES(?,?,1,0,1)", stranger.id, notiz);
  const row = await one<{ record_properties_phone: number; record_properties_desktop: number }>(
    "SELECT record_properties_phone,record_properties_desktop FROM page_view_prefs WHERE user_id=?",
    stranger.id,
  );
  assert.deepEqual([Number(row!.record_properties_phone), Number(row!.record_properties_desktop)], [1, 0]);
  await run("DELETE FROM page_view_prefs WHERE user_id=?", stranger.id);
});

test("stored per person and database, separately for phone and desktop", async () => {
  assert.deepEqual(await choice(aufgaben), { phone: null, desktop: null });
  assert.deepEqual(await fold(aufgaben, "phone", true), { device: "phone", collapsed: true });
  assert.deepEqual(await choice(aufgaben), { phone: true, desktop: null });
  // Desktop, another database and another person are untouched.
  assert.deepEqual(await choice(kunden), { phone: null, desktop: null });
  assert.deepEqual(await choice(aufgaben, viewer), { phone: null, desktop: null });
  await fold(aufgaben, "desktop", false);
  assert.deepEqual(await choice(aufgaben), { phone: true, desktop: false });
  // Readers choose for themselves too.
  await fold(aufgaben, "desktop", true, viewer);
  assert.deepEqual(await choice(aufgaben, viewer), { phone: null, desktop: true });
  assert.deepEqual(await choice(aufgaben), { phone: true, desktop: false });
  // null forgets one choice; with none left the row goes.
  await fold(aufgaben, "phone", null);
  assert.deepEqual(await choice(aufgaben), { phone: null, desktop: false });
  await fold(aufgaben, "desktop", null);
  assert.deepEqual(await choice(aufgaben), { phone: null, desktop: null });
  assert.equal(await one("SELECT 1 FROM page_view_prefs WHERE user_id=? AND page_id=?", owner.id, aufgaben), undefined);
});

test("shares the row with the bar's choice without touching it", async () => {
  await act({ action: "page.collapseProperties", pageId: kunden, collapsed: true });
  await fold(kunden, "phone", false);
  await fold(kunden, "phone", null);
  const row = await one<{ properties_collapsed: number; record_properties_phone: number | null }>(
    "SELECT properties_collapsed,record_properties_phone FROM page_view_prefs WHERE user_id=? AND page_id=?",
    owner.id,
    kunden,
  );
  assert.deepEqual([Number(row!.properties_collapsed), row!.record_properties_phone], [1, null]);
  await act({ action: "page.collapseProperties", pageId: kunden, collapsed: null });
});

test("hiding changes nothing else: no version, no notification", async () => {
  const before = await one<{ version: number }>("SELECT version FROM databases WHERE page_id=?", aufgaben);
  const notices = await one<{ n: number }>("SELECT COUNT(*) n FROM notifications");
  await fold(aufgaben, "phone", true, viewer);
  assert.deepEqual(await one("SELECT version FROM databases WHERE page_id=?", aufgaben), before);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications"))!.n), Number(notices!.n));
});

test("only for databases one may open; bad input is refused", async () => {
  await assert.rejects(async () => await fold(aufgaben, "phone", true, stranger), /Seite|Berechtigung/);
  assert.equal(await one("SELECT 1 FROM page_view_prefs WHERE user_id=?", stranger.id), undefined);
  await assert.rejects(async () => await fold(notiz, "phone", true), /Keine Datenbank/);
  await assert.rejects(async () => await fold(aufgaben, "tablet", true));
  await assert.rejects(async () => await fold(aufgaben, "phone", "yes"));
  await assert.rejects(async () => await fold("nope", "phone", true));
  // Ordinary pages carry no record choice.
  assert.equal(await choice(notiz), undefined);
});

test("gone with the database and with the account", async () => {
  const temp = await page("Temp", "database");
  await fold(temp, "phone", true);
  await run("DELETE FROM pages WHERE id=?", temp);
  assert.equal(await one("SELECT 1 FROM page_view_prefs WHERE page_id=?", temp), undefined);
  const tim = await account("Tim");
  await run("INSERT INTO members VALUES(?,?,?)", wid, tim.id, "editor");
  await fold(kunden, "desktop", true, tim);
  await deleteInactiveAccount(tim.id);
  assert.equal(await one("SELECT 1 FROM page_view_prefs WHERE user_id=?", tim.id), undefined);
});

test("listed for the API", () => {
  assert.ok(commandActionNames.includes("database.collapseRecordProperties"));
  assert.ok(commandActions.some((a) => a.action === "database.collapseRecordProperties"));
});

test("default: open on desktop; on phones folded with more than four properties; a choice wins", () => {
  assert.equal(isRecordFolded(null, 12, "desktop"), false);
  assert.equal(isRecordFolded(undefined, 4, "phone"), false);
  assert.equal(isRecordFolded(null, 5, "phone"), true);
  assert.equal(isRecordFolded(false, 9, "phone"), false);
  assert.equal(isRecordFolded(true, 1, "desktop"), true);
});

test("folded line: status first, then choices, dates and people; empty and plain ones left out", () => {
  const f = (fid: string, type: string) => ({ id: fid, type }) as { id: string; type: never };
  const fields = [f("notes", "text"), f("due", "date"), f("owner", "person"), f("prio", "select"), f("status", "select"), f("tags", "multiselect"), f("link", "relation")];
  const cells = { notes: "x", due: "2026-11-20", owner: "u1", prio: "Hoch", status: "In Arbeit", tags: [], link: ["r"] };
  const ids = (r: { shown: { id: string }[]; more: number }) => [r.shown.map((x) => x.id), r.more];
  assert.equal(SUMMARY_VALUES, 3);
  assert.equal(SUMMARY_VALUES_NARROW, 2);
  assert.deepEqual(ids(summaryFields(fields, cells, 3, "status")), [["status", "prio", "due"], 4]);
  assert.deepEqual(ids(summaryFields(fields, cells, 2, "status")), [["status", "prio"], 5]);
  // Without a status: the record's order among equals.
  assert.deepEqual(ids(summaryFields(fields, { ...cells, prio: "" }, 3)), [["status", "due", "owner"], 4]);
  assert.deepEqual(ids(summaryFields([f("notes", "text")], { notes: "x" }, 3)), [[], 1]);
  assert.deepEqual(ids(summaryFields([], {}, 3)), [[], 0]);
});
