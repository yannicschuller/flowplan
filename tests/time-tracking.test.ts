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

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("Olivia"),
  editor = user("Eddie");
const wid = createWorkspace(owner.id, "Time"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = (body: Record<string, unknown>, who = owner): any => command(who, body);
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Work" }).id as string;
act({
  action: "database.update",
  pageId,
  version: database(pageId).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "est", name: "Estimate", type: "number" },
    { id: "spent", name: "Time", type: "time", estimateField: "est" },
  ],
  views: database(pageId).views,
});
const a = act({ action: "row.create", pageId, cells: { title: "A", est: 2 } }).id;
const b = act({ action: "row.create", pageId, cells: { title: "B" } }).id;
const spent = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells).spent;
const today = new Date().toISOString().slice(0, 10);

test("timers: one per person, totals in the property", () => {
  act({ action: "time.start", pageId, rowId: a, fieldId: "spent" });
  // Starting on another record stops the first timer.
  const second = act({ action: "time.start", pageId, rowId: b, fieldId: "spent" });
  assert.ok(second.running);
  assert.equal(one<{ n: number }>("SELECT count(*) n FROM time_entries WHERE end IS NULL")!.n, 1);
  act({ action: "time.stop", pageId, rowId: b, fieldId: "spent" });
  const added = act({ action: "time.add", pageId, rowId: a, fieldId: "spent", minutes: 90, date: today, note: "Review" }, editor);
  assert.ok(added.total >= 5400);
  assert.ok(spent(a) >= 5400);
  // The property is not edited by hand.
  assert.throws(() => act({ action: "row.update", pageId, rowId: a, version: 1, cells: { spent: 1 } }));
  // Only own entries can be deleted (owners may correct).
  const entry = added.entries.find((e: { note: string }) => e.note === "Review");
  act({ action: "time.delete", pageId, entryId: entry.id });
  assert.ok(spent(a) < 5400);
});

test("weekly report per person with estimates", () => {
  act({ action: "time.add", pageId, rowId: a, fieldId: "spent", minutes: 150, date: today }, editor);
  const report = timeReport(owner, pageId, 4);
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
