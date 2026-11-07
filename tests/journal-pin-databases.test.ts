// Audit (Nov 2026): the records of a database below a PIN-locked journal
// were readable without the PIN – through a relation from another database,
// rows.transfer copy, the record document, the calendar feed, whiteboard
// cards, records across databases and the record trash. With the PIN set
// none of these returns data; after journal.unlock they do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-pin-db-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");
const { rowDocumentData } = await import("../lib/row-documents");
const { htmlState } = await import("../lib/document-server");
const { whiteboardRowCards } = await import("../lib/whiteboard-cards");
const { crossRecords } = await import("../lib/cross-records");
const { listRowTrash } = await import("../lib/row-trash");
const { createCalendarFeed, calendarFeed } = await import("../lib/calendar-feed");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = await account("Olga"),
  member = await account("Max");
const wid = await createWorkspace(owner.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const act = async (input: Record<string, unknown>, as = owner) => (await api.command(as, input)) as Result;
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const team = (await act({ action: "space.create", workspaceId: wid, name: "Team" })).id;
const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Tagebuch", kind: "journal" })).id;
const db = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Geheime DB", kind: "database", parentId: journal, databaseKind: "empty" })).id;
let d = await api.database(db);
await act({
  action: "database.update",
  pageId: db,
  version: d.version,
  views: [...d.views, { id: "cal", name: "Kalender", type: "calendar", dateField: "when", filters: [], sorts: [] }],
  fields: [...d.fields, { id: "when", name: "Wann", type: "date" }],
});
d = await api.database(db);
const title = d.fields[0].id;
const rid = (await act({ action: "row.create", pageId: db, cells: { [title]: "SECRET-ROW-TITLE", when: "2026-11-10" } })).id;
const trashed = (await act({ action: "row.create", pageId: db, cells: { [title]: "SECRET-TRASHED" } })).id;
await act({ action: "row.delete", pageId: db, rowId: trashed });
await run(
  "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET state=excluded.state,html=excluded.html,generation=excluded.generation",
  rid,
  htmlState("<p>SECRET-ROW-BODY</p>"),
  "<p>SECRET-ROW-BODY</p>",
  "g1",
);
// The member's own database with a relation to the one below the journal.
const mine = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Meine DB", kind: "database", databaseKind: "empty" }, member)).id;
const m = await api.database(mine);
await act({ action: "database.update", pageId: mine, version: m.version, views: m.views, fields: [...m.fields, { id: "rel1", name: "Link", type: "relation", relationPage: db }] }, member);
const token = (await createCalendarFeed(member, db, "cal")).url.split("/").pop()!.replace(/\.ics$/, "");

await act({ action: "journal.lock", pageId: journal, pin: "471108" });
await act({ action: "journal.relock", pageId: journal });

const leaks = async () => {
  const data = (await api.pageData(member, mine)) as { related?: Record<string, { cells: Record<string, unknown> }[]> };
  const cards = await whiteboardRowCards(member, [{ pageId: db, rowId: rid }]);
  const cross = await crossRecords(member, wid, { mine: false });
  const trash = await listRowTrash(member, wid);
  let ics = "";
  await status(async () => (ics = (await calendarFeed(token)) as unknown as string));
  let html = "";
  const doc = await status(async () => (html = ((await rowDocumentData(member, db, rid)) as { html: string }).html));
  return {
    related: JSON.stringify(data.related?.[db] ?? []).includes("SECRET-ROW-TITLE"),
    cards: !!cards[rid] || Object.values(cards).some((c) => c.title.includes("SECRET")),
    cross: JSON.stringify(cross).includes("SECRET-ROW-TITLE"),
    trash: trash.some((t) => t.title.includes("SECRET-TRASHED")),
    feed: String(ics).includes("SECRET-ROW-TITLE"),
    document: doc === 200 && html.includes("SECRET-ROW-BODY"),
  };
};

test("records below a locked journal stay closed without the PIN", async () => {
  assert.deepEqual(await leaks(), { related: false, cards: false, cross: false, trash: false, feed: false, document: false });
  // The lock screen of the journal instead of a server error.
  const data = (await api.pageData(member, db)) as { locked?: { journalId: string } };
  assert.equal(data.locked?.journalId, journal);
  assert.equal(await status(async () => await rowDocumentData(member, db, rid)), 423);
  // Copying records out of the database (or into it) needs the PIN too.
  assert.equal(await status(async () => await act({ action: "rows.transfer", pageId: db, rowIds: [rid], targetPageId: mine, mode: "copy" }, member)), 423);
  assert.equal((await api.rows(mine)).length, 0);
  const trashId = (await one<{ id: string }>("SELECT id FROM row_trash WHERE page_id=?", db))!.id;
  assert.equal(await status(async () => await act({ action: "row.trash.restore", trashId }, member)), 423);
});

test("after journal.unlock the same ways work again", async () => {
  await act({ action: "journal.unlock", pageId: journal, pin: "471108" }, member);
  assert.deepEqual(await leaks(), { related: true, cards: true, cross: true, trash: true, feed: true, document: true });
  assert.equal(await status(async () => await act({ action: "rows.transfer", pageId: db, rowIds: [rid], targetPageId: mine, mode: "copy" }, member)), 200);
  assert.equal((await api.rows(mine)).length, 1);
});

test("hover previews count only the records the person sees", async () => {
  const { pagePreview } = await import("../lib/page-preview");
  const open = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Offen", kind: "database", databaseKind: "empty" })).id;
  const f = (await api.database(open)).fields[0].id;
  await act({ action: "row.create", pageId: open, cells: { [f]: "Sichtbar" } });
  const hidden = (await act({ action: "row.create", pageId: open, cells: { [f]: "Privat" } })).id;
  await run("UPDATE rows SET access='private' WHERE id=?", hidden);
  assert.equal((await pagePreview(member, open)).rows, 1);
  assert.equal((await pagePreview(owner, open)).rows, 2);
  // Below a journal whose PIN the person has not entered: none.
  await act({ action: "journal.relock", pageId: journal }, member);
  assert.equal((await pagePreview(member, db)).rows, 0);
});
