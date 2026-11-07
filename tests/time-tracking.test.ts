import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-time-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { timeReport } = await import("../lib/time-tracking");
const { parseMinutes, formatDuration } = await import("../lib/durations");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("Olivia"),
  editor = await user("Eddie");
const wid = await createWorkspace(owner.id, "Time"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Work" })).id as string;
await act({
  action: "database.update",
  pageId,
  version: (await database(pageId)).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "est", name: "Estimate", type: "number" },
    { id: "spent", name: "Time", type: "time", estimateField: "est" },
  ],
  views: (await database(pageId)).views,
});
const a = (await act({ action: "row.create", pageId, cells: { title: "A", est: 2 } })).id;
const b = (await act({ action: "row.create", pageId, cells: { title: "B" } })).id;
const spent = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells).spent;
const today = new Date().toISOString().slice(0, 10);

test("timers: one per person, totals in the property", async () => {
  await act({ action: "time.start", pageId, rowId: a, fieldId: "spent" });
  // Starting on another record stops the first timer.
  const second = await act({ action: "time.start", pageId, rowId: b, fieldId: "spent" });
  assert.ok(second.running);
  assert.equal((await one<{ n: number }>(`SELECT count(*) n FROM time_entries WHERE "end" IS NULL`))!.n, 1);
  await act({ action: "time.stop", pageId, rowId: b, fieldId: "spent" });
  const added = await act({ action: "time.add", pageId, rowId: a, fieldId: "spent", minutes: 90, date: today, note: "Review" }, editor);
  assert.ok(added.total >= 5400);
  assert.ok((await spent(a)) >= 5400);
  // The property is not edited by hand.
  await assert.rejects(async () => await act({ action: "row.update", pageId, rowId: a, version: 1, cells: { spent: 1 } }));
  // Only own entries can be deleted (owners may correct).
  const entry = added.entries.find((e: { note: string }) => e.note === "Review");
  await act({ action: "time.delete", pageId, entryId: entry.id });
  assert.ok((await spent(a)) < 5400);
});

test("weekly report per person with estimates", async () => {
  await act({ action: "time.add", pageId, rowId: a, fieldId: "spent", minutes: 150, date: today }, editor);
  const report = await timeReport(owner, pageId, 4);
  assert.equal(report.weeks.length, 4);
  const eddie = report.people.find((p) => p.name === "Eddie")!;
  assert.equal(eddie.total, 9000);
  const record = report.records.find((r) => r.title === "A")!;
  assert.equal(record.estimate, 7200);
});

test("durations", () => {
  assert.equal(parseMinutes("1:30"), 90);
  assert.equal(parseMinutes("1,5h"), 90);
  assert.equal(parseMinutes("45"), 45);
  assert.equal(formatDuration(5400), "1 h 30 min");
});
