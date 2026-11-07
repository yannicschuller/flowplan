// Audit (Nov 2026), second round: further ways that read the records or
// pages below a PIN-locked journal without the PIN – dashboard numbers,
// sprint charts, block extensions, linked databases, backlinks, link icons,
// ticket numbers, time reports, synced blocks, contacts (vCard, CardDAV),
// whiteboards, document authors, publishing with sub-pages, calendar and
// issue sync, webhooks and the text of notifications. Without the PIN none
// of them gives anything away; after journal.unlock they work again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-pin-readers-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.SMTP_HOST = "smtp.example.invalid";
// Only so a 127.0.0.1 dummy webhook target is accepted; nothing listens there.
process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
const { run, id, one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { computeMetric, metricSources } = await import("../lib/dashboard-metric");
const { sprintCharts } = await import("../lib/sprints");
const { queryPluginDatabase } = await import("../lib/plugins");
const { databasePermission } = await import("../lib/plugin-protocol");
const { linkedDatabaseData } = await import("../lib/linked-databases");
const { recordBacklinks } = await import("../lib/relation-backlinks");
const { linkTargets } = await import("../lib/link-targets");
const { readablePrefixes, resolveTicket } = await import("../lib/ticket-refs");
const { timeReportData } = await import("../lib/time-reports");
const { timeReport } = await import("../lib/time-tracking");
const { listSyncedBlocks } = await import("../lib/synced-blocks");
const { exportVCards } = await import("../lib/contacts-io");
const { createCardDavAccess } = await import("../lib/carddav");
const { documentAuthors } = await import("../lib/document-authors");
const { syncWhiteboard, whiteboardData } = await import("../lib/whiteboard");
const { facilitationState } = await import("../lib/whiteboard-facilitation");
const { saveCalendarMapping, syncCalendarMapping } = await import("../lib/calendar-sync");
const { syncIssues } = await import("../lib/issue-sync");
const { createWebhook } = await import("../lib/webhooks");
const { notificationFeed } = await import("../lib/notification-feed");
const { queueNotificationDigests } = await import("../lib/mail");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = account("Olga"),
  member = account("Max");
const wid = createWorkspace(owner.id, "Firma");
run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const act = (input: Record<string, unknown>, as = owner) => api.command(as, input) as Result;
const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const statusAsync = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const create = (input: Record<string, unknown>, as = owner) => act({ action: "page.create", workspaceId: wid, spaceId: team, ...input }, as).id;
const team = act({ action: "space.create", workspaceId: wid, name: "Team" }).id;

// A parent page with the journal below it; below the journal a database,
// a document, a whiteboard, a contacts database and a synced block.
const parent = create({ title: "Eltern" });
const journal = create({ title: "Tagebuch", kind: "journal", parentId: parent });
const db = create({ title: "Geheime DB", kind: "database", parentId: journal, databaseKind: "empty" });
const open = create({ title: "Offene DB", kind: "database", databaseKind: "empty" });
let d = api.database(db);
const title = d.fields[0].id;
act({
  action: "database.update",
  pageId: db,
  version: d.version,
  views: d.views,
  fields: [
    ...d.fields,
    { id: "points", name: "Punkte", type: "number" },
    { id: "key", name: "Schlüssel", type: "id", prefix: "SEC" },
    { id: "rel", name: "Bezug", type: "relation", relationPage: open },
  ],
});
d = api.database(db);
const openTitle = api.database(open).fields[0].id;
const target = act({ action: "row.create", pageId: open, cells: { [openTitle]: "Offenes Ziel" } }).id;
const rid = act({ action: "row.create", pageId: db, cells: { [title]: "SECRET-ROW-TITLE", points: 42, rel: [target] } }).id;
run("UPDATE rows SET number=1 WHERE id=?", rid);
const doc = create({ title: "Notiz", parentId: journal });
run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState("<p>SECRET-DOC</p>"), "<p>SECRET-DOC</p>", doc);
const board = create({ title: "Tafel", kind: "whiteboard", parentId: journal });
const contacts = create({ title: "Kontakte", kind: "database", databaseKind: "contacts", parentId: journal });
const contactTitle = api.database(contacts).fields[0].id;
act({ action: "row.create", pageId: contacts, cells: { [contactTitle]: "SECRET-CONTACT" } });
const synced = create({ title: "Synchron", parentId: journal });
run("UPDATE pages SET synced=1 WHERE id=?", synced);
run("UPDATE documents SET html=? WHERE page_id=?", "<p>SECRET-SYNCED</p>", synced);
// Outside the journal: the member's own document with a linked view of the
// locked database, a block extension allowed to read it, time on a record.
const host = create({ title: "Mit Einbettung" }, member);
const block = id();
const linkedHtml = `<div data-linked-database="${block}" data-linked-source="${db}" data-linked-views="${JSON.stringify(d.views).replace(/"/g, "&quot;")}" data-linked-version="1"></div>`;
run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(linkedHtml), linkedHtml, host);
const plugin = id();
run(
  "INSERT INTO plugins(id,workspace_id,url,origin,manifest,permissions,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  plugin,
  wid,
  "https://plugins.example.org/p.json",
  "https://plugins.example.org",
  JSON.stringify({ name: "P", entry: "https://plugins.example.org/" }),
  JSON.stringify([databasePermission(db)]),
  owner.id,
  Date.now(),
  Date.now(),
);
run(`INSERT INTO time_entries(id,page_id,row_id,field_id,user_id,start,"end",note) VALUES(?,?,?,?,?,?,?,?)`, id(), db, rid, "spent", owner.id, Date.now() - 3600_000, Date.now() - 1800_000, "");
// The member's calendar connection, and one mapping of the owner's issue sync.
const connection = id();
run("INSERT INTO calendar_connections(id,user_id,provider,account,refresh_token,created_at) VALUES(?,?,?,?,?,?)", connection, member.id, "google", "max@example.test", "x", Date.now());
const mapping = id();
run(
  "INSERT INTO calendar_sync_mappings(id,connection_id,user_id,page_id,view_id,calendar_id,created_at) VALUES(?,?,?,?,?,?,?)",
  mapping,
  connection,
  member.id,
  db,
  d.views[0].id,
  "primary",
  Date.now(),
);
const issues = id();
run(
  "INSERT INTO issue_connections(id,workspace_id,provider,token,hook_token,hook_secret,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
  issues,
  wid,
  "github",
  "x",
  id(),
  "x",
  owner.id,
  Date.now(),
);
run("INSERT INTO issue_sync_maps(page_id,connection_id,repo,config,created_at) VALUES(?,?,?,?,?)", db, issues, "acme/app", "{}", Date.now());
// A reminder about the record for the member, as the reminder job writes it.
run(
  "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind,created_at) VALUES(?,?,?,?,?,'mention',?)",
  id(),
  member.id,
  "Erinnerung: „SECRET-ROW-TITLE“ – Wann: 10.11.2026",
  db,
  rid,
  "2026-01-01 00:00:00",
);

act({ action: "journal.lock", pageId: journal, pin: "471108" });
act({ action: "journal.relock", pageId: journal });
const hook = await createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/hook", events: ["row.created", "row.updated"] });

const leaks = () => {
  const has = (value: unknown) => JSON.stringify(value ?? null).includes("SECRET");
  return {
    metric: status(() => computeMetric(member, { source: db, view: "", aggregate: "sum", field: "points" })) === 200,
    sources: metricSources(member, wid).some((s) => s.id === db),
    sprint: status(() => sprintCharts(member, db, "none")) !== 423,
    plugin: status(() => queryPluginDatabase(member, { pluginId: plugin, pageId: host, databaseId: db })) === 200,
    linked: status(() => linkedDatabaseData(member, host, block)) === 200,
    linkedHost: status(() => linkedDatabaseData(member, doc, id())) !== 423,
    backlinks: has(recordBacklinks(member, open, target)),
    icons: !!linkTargets(member, [`${db}:${rid}`])[`${db}:${rid}`],
    prefixes: readablePrefixes(member, wid).some((p) => p.prefix === "SEC"),
    ticket: has(resolveTicket(member, wid, "SEC-1")),
    timeReport: status(() => timeReport(member, db)) === 200,
    timeEntries: has(timeReportData(member, { workspace: wid })),
    synced: has(listSyncedBlocks(member, wid)),
    vcard: status(() => exportVCards(member, contacts)) === 200,
    carddav: status(() => createCardDavAccess(member, contacts)) === 200,
    authors: status(() => documentAuthors(member, doc)) === 200,
    board: status(() => syncWhiteboard(member, { pageId: board, generation: whiteboardData({ id: board } as never).generation })) === 200,
    facilitation: status(() => facilitationState(member, board)) === 200,
    inbox: has(api.bootstrap(member, wid).notifications),
    feed: has(notificationFeed(member, null)),
  };
};

test("without the PIN nothing below the journal comes through these ways", async () => {
  assert.deepEqual(leaks(), {
    metric: false,
    sources: false,
    sprint: false,
    plugin: false,
    linked: false,
    linkedHost: false,
    backlinks: false,
    icons: false,
    prefixes: false,
    ticket: false,
    timeReport: false,
    timeEntries: false,
    synced: false,
    vcard: false,
    carddav: false,
    authors: false,
    board: false,
    facilitation: false,
    inbox: false,
    feed: false,
  });
  // The inbox says why instead.
  assert.ok(api.bootstrap(member, wid).notifications.some((n) => n.body === "Dieses Journal ist gesperrt."));
  // Publishing the parent with its sub-pages would publish the journal.
  assert.equal(status(() => act({ action: "page.publish", pageId: parent, enabled: true, includeChildren: true }, member)), 423);
  assert.equal(one("SELECT 1 FROM publications WHERE page_id=?", parent), undefined);
  // Calendar and issue sync stay closed, setting them up as well.
  assert.equal(status(() => saveCalendarMapping(member, { connectionId: connection, pageId: db, viewId: d.views[0].id, calendarId: "other" })), 423);
  assert.equal(await statusAsync(() => syncCalendarMapping(mapping)), 423);
  const sync = await syncIssues(db);
  assert.equal(sync.ok, false);
  assert.equal((sync as { error?: string }).error, "Dieses Journal ist gesperrt.");
  // The e-mail digest names no record either.
  assert.equal(queueNotificationDigests(Date.now()), 1);
  const mail = all<{ text: string; html: string; subject: string }>("SELECT subject,text,html FROM mail_queue");
  assert.ok(mail.length && !mail.some((m) => (m.subject + m.text + m.html).includes("SECRET")));
  // A change by someone who entered the PIN goes to no webhook of the owner who has not.
  act({ action: "journal.unlock", pageId: journal, pin: "471108" }, member);
  act({ action: "row.create", pageId: db, cells: { [title]: "SECRET-NEW" } }, member);
  act({ action: "journal.relock", pageId: journal }, member);
  assert.deepEqual(all("SELECT 1 FROM webhook_deliveries WHERE webhook_id=?", hook.id), []);
});

test("after journal.unlock the same ways work again", () => {
  act({ action: "journal.unlock", pageId: journal, pin: "471108" }, member);
  const after = leaks();
  // Sprint charts: no such sprint (404), but no longer the lock.
  assert.deepEqual(after, {
    metric: true,
    sources: true,
    sprint: true,
    plugin: true,
    linked: true,
    linkedHost: true,
    backlinks: true,
    icons: true,
    prefixes: true,
    ticket: true,
    timeReport: true,
    timeEntries: true,
    synced: true,
    vcard: true,
    carddav: true,
    authors: true,
    board: true,
    facilitation: true,
    inbox: true,
    feed: true,
  });
  assert.equal(status(() => act({ action: "page.publish", pageId: parent, enabled: true, includeChildren: true }, member)), 200);
});
