// "Created time" and "Edited time" are SQLite CURRENT_TIMESTAMP text in UTC
// ("2026-11-05 17:39:02"). People see them in their time zone, like a date
// property with time; exports write ISO 8601 instants, like date properties.
process.env.TZ = "America/New_York";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-timestamps-"));
process.env.APP_URL = "https://flowplan.example.test";
const { displayText, formatTimestamp, formatFieldDate } = await import("../lib/field-format");
const { clipboardCell } = await import("../lib/database-clipboard");
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database } = await import("../lib/api");
const { exportMarkdown } = await import("../lib/markdown-export");
const { collectExportContent } = await import("../lib/export-content");
const { readExportZip } = await import("./helpers/read-export-zip");

const created: Field = { id: "created", name: "Created", type: "created_at" };
const edited: Field = { id: "edited", name: "Edited", type: "updated_at", format: "iso", timeFormat: "12" };

test("created and edited time show in the viewer's zone like a date with time", () => {
  // 17:39 UTC is 12:39 in New York (EST, UTC−5) – the browser's zone.
  assert.equal(formatTimestamp("2026-11-05 17:39:02", created), "5. Nov. 2026, 12:39 (UTC-05:00)");
  assert.equal(formatTimestamp("2026-11-05 17:39:02", created), formatFieldDate("2026-11-05T17:39:02Z", {}));
  // The field's date and time format apply as for date properties.
  assert.equal(formatTimestamp("2026-11-05 17:39:02", edited), "2026-11-05, 12:39 PM (UTC-05:00)");
  // Across midnight the local day changes.
  assert.equal(formatTimestamp("2026-11-06 02:00:00", edited), "2026-11-05, 9:00 PM (UTC-05:00)");
  // Summer time.
  assert.equal(formatTimestamp("2026-07-01 12:00:00", edited), "2026-07-01, 8:00 AM (UTC-04:00)");
  assert.equal(formatTimestamp("2026-11-05 17:39:02", created, "Europe/Berlin"), "5. Nov. 2026, 18:39 (UTC+01:00)");
  assert.equal(formatTimestamp("", created), "");
  assert.equal(formatTimestamp(undefined, created), "");
  // Plain text for previews and published pages (which pass their zone).
  assert.equal(displayText(created, "2026-11-05 17:39:02"), "5. Nov. 2026, 12:39 (UTC-05:00)");
  assert.equal(displayText(created, "2026-11-05 17:39:02", "UTC"), "5. Nov. 2026, 17:39 (UTC+00:00)");
  // Copying cells.
  const ctx = { yes: "Ja", no: "Nein", untitled: "Ohne Titel", unavailable: "Nicht verfügbar", zone: "America/New_York" };
  assert.equal(clipboardCell(edited, "2026-11-05 17:39:02", ctx), "2026-11-05, 12:39 PM (UTC-05:00)");
});

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}

test("exports write created and edited time as ISO 8601 instants", async () => {
  const owner = user("Exporter"),
    wid = createWorkspace(owner.id, "Timestamps"),
    space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!;
  const table = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title: "Records", kind: "database" }) as { id: string }).id;
  const schema = database(table);
  command(owner, {
    action: "database.update",
    pageId: table,
    version: schema.version,
    fields: [schema.fields[0], created, edited],
    views: schema.views,
  });
  const row = command(owner, { action: "row.create", pageId: table, cells: { title: "Task" } }) as { id: string };
  run("UPDATE rows SET created_at='2026-11-05 17:39:02',updated_at='2026-11-06 08:00:00' WHERE id=?", row.id);
  const zip = await readExportZip((await exportMarkdown(owner, { pageId: table, format: "zip", includeSubpages: false })).bytes);
  const csv = zip.get(`tables/${table}.csv`)!.toString();
  assert.match(csv, /"2026-11-05T17:39:02Z","2026-11-06T08:00:00Z"/);
  const index = zip.get("index.md")!.toString();
  assert.match(index, /\| 2026-11-05T17:39:02Z \| 2026-11-06T08:00:00Z \|/);
  const record = zip.get([...zip.keys()].find((k) => k.startsWith("records/"))!)!.toString();
  assert.match(record, /Created: "?2026-11-05T17:39:02Z"?/);
  assert.match(record, /Edited: "?2026-11-06T08:00:00Z"?/);
  // Word, PDF and EPUB read the same text.
  const content = collectExportContent(owner, { pageId: table, maxPages: 10, format: "PDF" });
  assert.match(content.pages[0].html, /<td>2026-11-05T17:39:02Z<\/td><td>2026-11-06T08:00:00Z<\/td>/);
});
