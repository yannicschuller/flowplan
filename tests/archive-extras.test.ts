// Workspace archives carry more than pages, records and files: database
// settings, time entries and the status log, record access, journal
// settings and tracker values, PDF ink, synced blocks, the exporter's start
// page, and references inside blocks and on whiteboard cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-archive-extras-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database, rows } = await import("../lib/api");
const { exportArchive, importArchive, readZip, writeZip } = await import("../lib/archive");
const { htmlState } = await import("../lib/document-server");
const { databaseSettings, storeSettings } = await import("../lib/database-settings");
const { journalSettings, dayEntry } = await import("../lib/journal-extras");
const { homeLayout } = await import("../lib/home-layout");
const { saveFileInk, readFileInk } = await import("../lib/ink-store");
const { writeWhiteboard, whiteboardData } = await import("../lib/whiteboard");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = user("Exporter");
const wid = createWorkspace(owner.id, "Source");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const act = (body: Record<string, unknown>, as = owner): any => command(as, body);
const page = (title: string, kind = "document", parentId?: string) => act({ action: "page.create", workspaceId: wid, spaceId: space, title, kind, ...(parentId ? { parentId } : {}) }).id as string;
const setHtml = (pid: string, html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pid);

// A ticket database: settings, a template used by a scheduled rule, time, status log, a private record.
const tickets = page("Tickets", "database");
const d = database(tickets);
act({
  action: "database.update",
  pageId: tickets,
  version: d.version,
  views: d.views,
  fields: [...d.fields, { id: "spent", name: "Spent", type: "time" }],
});
const ticket = act({ action: "row.create", pageId: tickets, cells: { title: "Ticket", assignee: owner.id } }).id as string;
const secret = act({ action: "row.create", pageId: tickets, cells: { title: "Secret" } }).id as string;
act({ action: "row.access", pageId: tickets, rowId: secret, access: "private", grants: [] });
const templateId = act({ action: "row.template.save", pageId: tickets, rowId: ticket, name: "Weekly" }).id as string;
act({
  action: "database.settings",
  pageId: tickets,
  settings: {
    done: { field: "status", values: ["Erledigt"] },
    automations: [
      { id: "notify", name: "Tell me", enabled: true, trigger: { type: "created" }, conditions: [], actions: [{ type: "notify", to: owner.id, message: "New" }] },
      { id: "weekly", name: "Weekly", enabled: true, trigger: { type: "schedule", freq: "weekly", interval: 1, weekday: 1, day: 1, time: "09:00", timeZone: "Europe/Berlin" }, conditions: [], actions: [{ type: "create", template: templateId, cells: { assignee: owner.id }, dates: {} }] },
    ],
  },
});
storeSettings(tickets, { ...databaseSettings(tickets), git: { token: "t".repeat(40), secret: "s".repeat(40), createdAt: new Date().toISOString() } });
act({ action: "time.add", pageId: tickets, rowId: ticket, fieldId: "spent", minutes: 90, date: "2026-10-01", note: "Work" });
run("INSERT INTO row_status_log(id,page_id,row_id,done,at) VALUES(?,?,?,?,?)", id(), tickets, ticket, 1, 1_700_000_000_000);

// A journal with settings and a day with tracker values.
const journal = page("Journal", "journal");
act({ action: "journal.settings", pageId: journal, trackers: [{ id: "mood", name: "Mood", kind: "mood" }, { id: "sleep", name: "Sleep", kind: "number", unit: "h" }], template: "<h3>Grateful for</h3><p></p>" });
const dayId = page("Day", "document", journal);
run("UPDATE pages SET journal_date='2026-10-01' WHERE id=?", dayId);
act({ action: "journal.entry", pageId: dayId, entry: { values: { mood: 4, sleep: 7.5 }, place: "Hamburg", lat: 53.5, lon: 10 } });

// A board with a record card, a synced block and a document using both.
const board = page("Board", "whiteboard");
{
  const doc = new Y.Doc();
  const card = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ type: "card", x: 0, y: 0, w: 200, h: 100, z: 0, pageId: tickets, rowId: ticket })) card.set(k, v);
  doc.getMap("items").set(id(), card);
  writeWhiteboard(board, Y.encodeStateAsUpdate(doc));
}
const synced = act({ action: "synced.create", pageId: board, html: "<p>Shared words</p>" }).id as string;
const guide = page("Guide");
setHtml(
  guide,
  `<p><a href="/#page=${tickets}&amp;row=${ticket}">Ticket</a> <span data-mention="${owner.id}" class="mention">@Exporter</span></p>` +
    `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-11-01"><label><input type="checkbox"></label><div><p>Do it <span data-mention="${owner.id}" class="mention">@Exporter</span></p></div></li></ul>` +
    `<div data-whiteboard="${board}" data-whiteboard-height="300"></div><div data-synced-block="${synced}"></div>` +
    `<div data-metric="${JSON.stringify({ source: tickets, view: "", aggregate: "count", field: "" }).replace(/"/g, "&quot;")}"></div>`,
);

// A PDF with ink.
const fid = id();
const pdfBytes = Buffer.from("%PDF-1.4\n%%EOF\n");
mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid), pdfBytes);
run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, guide, "notes.pdf", "application/pdf", pdfBytes.length, owner.id);
saveFileInk(owner, fid, { base: 0, doc: { format: "flowplan-ink", version: 1, unit: "pt", pages: { "1": [{ id: "a1", type: "pen", color: "#1f1f1f", width: 2, points: [10, 10, 0.5, 40, 40, 0.5] }] } } });

// The exporter's start page, pinning the guide.
act({
  action: "home.save",
  workspaceId: wid,
  scope: "workspace",
  layout: { version: 1, appearance: { header: { type: "gradient", value: "dusk", position: 50 }, density: "comfortable", background: "none", icon: "", width: "normal" }, widgets: [{ id: "pin", kind: "pinned", size: "m", config: { pageId: guide, preview: true } }, { id: "greet", kind: "greeting", size: "full", config: {} }] },
});

const archive = await exportArchive(owner, wid);
const manifest = JSON.parse((await readZip(archive)).get("flowplan.json")!.toString("utf8"));

test("the export carries settings without secrets, journals, ink, home and the synced flag", () => {
  const db = manifest.pages.find((p: any) => p.id === tickets).database;
  assert.equal(db.settings.git, undefined);
  assert.equal(db.settings.automations[0].createdBy, undefined);
  assert.equal(db.timeEntries.length, 1);
  assert.equal(db.statusLog.length, 1);
  assert.equal(db.rows.find((r: any) => r.id === secret).access, "private");
  assert.ok(db.templates[0].id);
  const day = manifest.pages.find((p: any) => p.id === dayId);
  assert.equal(day.journal_date, "2026-10-01");
  assert.deepEqual(day.journalEntry, { values: { mood: 4, sleep: 7.5 }, place: "Hamburg" });
  assert.equal(manifest.pages.find((p: any) => p.id === journal).journal.trackers.length, 2);
  assert.equal(manifest.pages.find((p: any) => p.id === synced).synced, 1);
  assert.ok(manifest.files.find((f: any) => f.id === fid).ink.data.includes("a1"));
  assert.equal(manifest.home.widgets[0].config.pageId, guide);
  assert.equal(manifest.exportedBy, owner.id);
});

test("an import maps everything to the new ids and the importing person", async () => {
  const other = user("Importer");
  const target = createWorkspace(other.id, "Target");
  const result = await importArchive(other, target, archive);
  const map = (pid: string) => result.pageIds[pid];
  const newTickets = map(tickets);
  // Settings: rules act for the importer, the template id follows, Git stays behind.
  const settings = databaseSettings(newTickets);
  assert.equal(settings.git, undefined);
  assert.ok(settings.automations!.every((a) => a.createdBy === other.id));
  const weekly = settings.automations!.find((a) => a.id === "weekly")!.actions[0] as { template: string; cells: Record<string, unknown> };
  assert.equal(one<{ page_id: string }>("SELECT page_id FROM row_templates WHERE id=?", weekly.template)?.page_id, newTickets);
  assert.equal(weekly.cells.assignee, other.id);
  assert.equal((settings.automations![0].actions[0] as { to: string }).to, other.id);
  // Records: assignee becomes the importer, the private record stays private.
  const imported = rows(newTickets);
  const newTicket = imported.find((r) => r.cells.title === "Ticket")!;
  assert.equal(newTicket.cells.assignee, other.id);
  assert.equal(imported.find((r) => r.cells.title === "Secret")!.access, "private");
  assert.equal(all("SELECT * FROM time_entries WHERE page_id=? AND user_id=?", newTickets, other.id).length, 1);
  assert.equal(all("SELECT * FROM row_status_log WHERE page_id=? AND row_id=?", newTickets, newTicket.id).length, 1);
  // Journal.
  const newDay = one<{ journal_date: string; parent_id: string }>("SELECT journal_date,parent_id FROM pages WHERE id=?", map(dayId))!;
  assert.equal(newDay.journal_date, "2026-10-01");
  assert.equal(newDay.parent_id, map(journal));
  assert.deepEqual(dayEntry(map(dayId)), { values: { mood: 4, sleep: 7.5 }, place: "Hamburg", lat: null, lon: null });
  assert.deepEqual(journalSettings(map(journal)).trackers.map((t) => t.id), ["mood", "sleep"]);
  assert.match(journalSettings(map(journal)).template, /Grateful for/);
  // Synced block, references in blocks, links to records, mentions and tasks.
  assert.equal(one<{ synced: number }>("SELECT synced FROM pages WHERE id=?", map(synced))!.synced, 1);
  const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", map(guide))!.html;
  assert.ok(html.includes(`data-whiteboard="${map(board)}"`));
  assert.ok(html.includes(`data-synced-block="${map(synced)}"`));
  assert.ok(html.includes(map(tickets)) && !html.includes(tickets));
  assert.ok(html.includes(`row=${newTicket.id}`));
  assert.ok(html.includes(`data-mention="${other.id}"`) && !html.includes(owner.id));
  assert.equal(all("SELECT * FROM doc_tasks WHERE page_id=? AND assignee=?", map(guide), other.id).length, 1);
  // Whiteboard cards point to the new record.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(whiteboardData({ id: map(board) } as never).state, "base64"));
  const card = [...doc.getMap<Y.Map<unknown>>("items").values()][0];
  assert.equal(card.get("pageId"), newTickets);
  assert.equal(card.get("rowId"), newTicket.id);
  // PDF ink.
  const newFile = one<{ id: string }>("SELECT id FROM files WHERE page_id=?", map(guide))!.id;
  assert.equal(readFileInk(other, newFile).doc.pages["1"].length, 1);
  // The start page comes along for someone without one.
  const home = homeLayout(other, target);
  assert.equal(home.source, "workspace");
  assert.equal((home.layout.widgets[0].config as { pageId: string }).pageId, map(guide));
});

test("within the exporter's own workspace, their assignments stay theirs", async () => {
  const colleague = user("Colleague");
  run("INSERT INTO members VALUES(?,?,?)", wid, colleague.id, "editor");
  const result = await importArchive(colleague, wid, archive);
  const copy = rows(result.pageIds[tickets]).find((r) => r.cells.title === "Ticket")!;
  assert.equal(copy.cells.assignee, owner.id);
});

test("an existing start page is kept, and older archives without the new parts still import", async () => {
  const other = user("Keeper");
  const target = createWorkspace(other.id, "Kept");
  act({ action: "home.save", workspaceId: target, scope: "personal", layout: { version: 1, appearance: { header: { type: "none", value: "", position: 50 }, density: "compact", background: "none", icon: "", width: "normal" }, widgets: [] } }, other);
  await importArchive(other, target, archive);
  assert.equal(homeLayout(other, target).source, "personal");
  // Without the optional parts (as written by earlier versions).
  const legacy = structuredClone(manifest);
  delete legacy.home;
  delete legacy.exportedBy;
  for (const p of legacy.pages) {
    delete p.journal;
    delete p.journalEntry;
    delete p.synced;
    if (p.database) {
      delete p.database.settings;
      delete p.database.timeEntries;
      delete p.database.statusLog;
      for (const r of p.database.rows) delete r.access;
      for (const t of p.database.templates) delete t.id;
    }
  }
  for (const f of legacy.files) delete f.ink;
  const entries = await readZip(archive);
  entries.set("flowplan.json", Buffer.from(JSON.stringify(legacy)));
  const result = await importArchive(other, target, await writeZip(entries));
  assert.equal(result.pages, manifest.pages.length);
  // Without the exporter, their assignments are not anyone's.
  const newTickets = result.pageIds[tickets];
  assert.equal(rows(newTickets).find((r) => r.cells.title === "Ticket")!.cells.assignee, "");
});
