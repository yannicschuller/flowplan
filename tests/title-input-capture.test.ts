// Titles of another type than text (#529) on the server: quick capture reads
// a typed date or number into the title's value; record updates stay strict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-title-input-"));
process.env.APP_URL = "https://flowplan.example.test";
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Anna", "anna@example.test");
const anna = { id: uid, name: "Anna", email: "anna@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
const wid = await createWorkspace(anna.id, "Team");
const space = (await bootstrap(anna, wid)).spaces[0].id;
const act = async (b: Record<string, unknown>) => (await command(anna, { workspaceId: wid, ...b })) as Record<string, unknown>;
async function databaseWithTitle(title: Field) {
  const pageId = String((await act({ action: "page.create", spaceId: space, title: `DB ${title.type}`, kind: "database" })).id);
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([title]), pageId);
  return pageId;
}
const row = async (rowId: unknown) => {
  const r = (await one<{ cells: string; content: string; version: number }>("SELECT cells,content,version FROM rows WHERE id=?", String(rowId)))!;
  return { cells: JSON.parse(r.cells) as Record<string, unknown>, content: r.content || "", version: r.version };
};

test("quick capture into a database with a date title takes the date", async () => {
  const pageId = await databaseWithTitle({ id: "title", name: "Tag", type: "date" });
  const ok = await act({ action: "capture.record", pageId, title: "23.11.2026", text: "Notiz zum Tag" });
  assert.equal((await row(ok.rowId)).cells.title, "2026-11-23");
  // Not a date: no title, the text keeps what was typed.
  const bad = await act({ action: "capture.record", pageId, title: "Quatsch" });
  const stored = await row(bad.rowId);
  assert.equal(stored.cells.title, undefined);
  assert.match(stored.content, /Quatsch/);
});

test("quick capture into a database with a number title takes the number", async () => {
  const pageId = await databaseWithTitle({ id: "title", name: "Gewicht", type: "number", unit: "kg" });
  const ok = await act({ action: "capture.record", pageId, title: "12,5 kg" });
  assert.equal((await row(ok.rowId)).cells.title, 12.5);
});

test("a date title is saved as its value; a localized text stays refused", async () => {
  const pageId = await databaseWithTitle({ id: "title", name: "Tag", type: "date" });
  const created = await act({ action: "row.create", pageId, cells: {} });
  await assert.rejects(
    async () => await act({ action: "row.update", pageId, rowId: created.id, version: (await row(created.id)).version, cells: { title: "23.11.2026" } }),
    /Ungültiges Datum/,
  );
  await act({ action: "row.update", pageId, rowId: created.id, version: (await row(created.id)).version, cells: { title: "2026-11-23" } });
  assert.equal((await row(created.id)).cells.title, "2026-11-23");
});
