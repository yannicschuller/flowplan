// Content archives of workspaces with large databases: a database with
// 12,000 records (and a version of it, record comments and record
// contents) goes out and comes back – the archive used to stop at 5,000
// records per database with HTTP 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-archive-large-"));
const { one, all, run, id, sql } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database } = await import("../lib/api");
const { exportArchive, importArchive, readZip, MAX_ARCHIVE_ROWS } = await import("../lib/archive");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
// ARCHIVE_TEST_RECORDS measures other sizes (e.g. 40000, 100000) by hand.
const RECORDS = Number(process.env.ARCHIVE_TEST_RECORDS || 12_000);
const owner = user("Owner"),
  wid = createWorkspace(owner.id, "Large"),
  space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
// The default database has title, status, priority, date, assignee and tags.
const table = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tasks", kind: "database" }) as { id: string }).id;
{
  const db = database(table);
  command(owner, {
    action: "database.update",
    pageId: table,
    version: db.version,
    fields: [
      ...db.fields,
      { id: "pts", name: "Points", type: "number" },
      { id: "memo", name: "Memo", type: "text" },
    ],
    views: db.views,
  });
}
for (let i = 0; i < RECORDS; i += 5000)
  command(owner, {
    action: "rows.import",
    pageId: table,
    rows: Array.from({ length: Math.min(5000, RECORDS - i) }, (_, k) => ({
      title: `Task ${i + k}`,
      status: (i + k) % 3 ? "Open" : "Done",
      pts: (i + k) % 13,
      date: `2026-${String(((i + k) % 12) + 1).padStart(2, "0")}-15`,
      assignee: owner.id,
      memo: `Note for record ${i + k} with a little text`,
    })),
  });
// Some records carry content and comments; one version of the whole database.
const sample = all<{ id: string }>("SELECT id FROM rows WHERE page_id=? ORDER BY position LIMIT 50", table);
for (const r of sample) {
  run("UPDATE rows SET content=? WHERE id=?", `<p>Content of ${r.id}</p>`, r.id);
  command(owner, { action: "comment.create", pageId: table, rowId: r.id, body: "Looks fine" });
}
command(owner, { action: "page.snapshot", pageId: table });

test(`a database with ${RECORDS} records round-trips through the content archive`, async () => {
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", table)!.n), RECORDS);
  assert.ok(MAX_ARCHIVE_ROWS >= 100_000);
  const heap = process.memoryUsage().heapUsed;
  let t = performance.now();
  const zip = await exportArchive(owner, wid);
  const exportMs = performance.now() - t;
  const manifest = (await readZip(zip)).get("flowplan.json")!;
  const data = JSON.parse(manifest.toString("utf8"));
  const exportedTable = data.pages.find((p: { id: string }) => p.id === table);
  assert.equal(exportedTable.database.rows.length, RECORDS);
  // The version fits next to 12,000 records; much larger databases keep
  // their versions behind once flowplan.json would grow beyond its limit.
  if (RECORDS <= 12_000) assert.equal(exportedTable.snapshots.length, 1);
  assert.equal(exportedTable.comments.length, sample.length);

  const target = createWorkspace(owner.id, "Restored");
  t = performance.now();
  await importArchive(owner, target, zip);
  const importMs = performance.now() - t;
  const restored = one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND kind='database' AND title='Tasks'", target)!.id;
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", restored)!.n), RECORDS);
  const cells = JSON.parse(one<{ cells: string }>(`SELECT cells FROM rows WHERE page_id=? AND ${sql.jsonText("cells", "$.title")}='Task 11999'`, restored)!.cells);
  assert.equal(cells.title, "Task 11999");
  assert.equal(cells.memo, "Note for record 11999 with a little text");
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM comments WHERE page_id=?", restored)!.n), sample.length);
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM snapshots WHERE page_id=?", restored)!.n), exportedTable.snapshots.length);
  const heapMb = Math.round((process.memoryUsage().heapUsed - heap) / 1048576);
  console.log(
    `archive: ${RECORDS} records, ZIP ${(zip.length / 1048576).toFixed(1)} MB, manifest ${(manifest.length / 1048576).toFixed(1)} MB, export ${Math.round(exportMs)} ms, import ${Math.round(importMs)} ms, heap +${heapMb} MB, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`,
  );
  // Generous bounds against regressions to quadratic work.
  assert.ok(exportMs < 60_000 && importMs < 120_000);
});

test("more records than the archive allows per database are refused with a clear limit", async () => {
  const zip = await exportArchive(owner, wid);
  const entries = await readZip(zip);
  const data = JSON.parse(entries.get("flowplan.json")!.toString("utf8"));
  const p = data.pages.find((page: { id: string }) => page.id === table);
  const row = p.database.rows[0];
  p.database.rows = Array.from({ length: MAX_ARCHIVE_ROWS + 1 }, () => ({ ...row, id: crypto.randomUUID() }));
  p.snapshots = [];
  p.comments = [];
  // Only checked by the schema, so build the manifest without the ZIP size.
  const { archiveSchema } = await import("../lib/archive");
  assert.equal(archiveSchema.safeParse(data).success, false);
});
