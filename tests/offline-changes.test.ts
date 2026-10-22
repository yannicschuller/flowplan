import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-offline-changes-"));
const { id, run } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { rowDocumentData } = await import("../lib/row-documents");
const { htmlState } = await import("../lib/document-server");
const { offlineChanges, parseSince } = await import("../lib/offline-changes");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  alice = user("alice");
const wid = createWorkspace(owner.id, "Offline");
run("INSERT INTO members VALUES(?,?,?)", wid, alice.id, "editor");
const space = bootstrap(owner, wid).spaces[0].id;
const create = (title: string, kind = "document", spaceId = space) =>
  (command(owner, { action: "page.create", workspaceId: wid, spaceId, title, kind }) as { id: string }).id;
const doc = create("Reiseplan"),
  table = create("Packliste", "database"),
  other = create("Unverändert");
const row = (title: string, who = owner) =>
  (command(who, { action: "row.create", pageId: table, cells: { title } }) as { id: string }).id;
const passport = row("Reisepass"),
  tickets = row("Tickets");
// Each step asks from a point after everything before it.
let mark = 0;
const step = async () => {
  await new Promise((r) => setTimeout(r, 15));
  mark = Date.now();
  await new Promise((r) => setTimeout(r, 15));
};
const changedNow = (who: Identity = owner) => offlineChanges(who, wid, mark, Date.now(), 0);

test("without since everything readable counts as changed", () => {
  const all = offlineChanges(owner, wid, null);
  assert.equal(all.full, true);
  for (const pid of [doc, table, other]) assert.ok(all.pages.includes(pid) && all.changed.includes(pid));
  assert.equal(parseSince(all.now), Date.parse(all.now));
  assert.equal(parseSince("nonsense"), null);
});

test("document, record, record document and file edits are reported", async () => {
  await step();
  assert.deepEqual(changedNow().changed, []);
  // Document edit through the collaboration sync.
  const pd = pageData(owner, doc) as { generation: string; state: string };
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, htmlState("<p>Zug um 8 Uhr</p>"));
  command(owner, { action: "document.sync", pageId: doc, generation: pd.generation, update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64") });
  let changes = changedNow();
  assert.deepEqual(changes.changed, [doc]);
  assert.equal(changes.full, false);

  // A record edit does not touch pages.updated_at, the log catches it.
  await step();
  const version = Number((pageData(owner, table) as { rows: { id: string; version: number }[] }).rows.find((r) => r.id === passport)!.version);
  command(owner, { action: "row.update", pageId: table, rowId: passport, version, cells: { title: "Reisepass (neu)" } });
  changes = changedNow();
  assert.deepEqual(changes.changed, [table]);
  assert.deepEqual(changes.rows[table], [passport]);

  // A record document.
  await step();
  const initial = rowDocumentData(owner, table, tickets);
  const rdoc = new Y.Doc();
  Y.applyUpdate(rdoc, Buffer.from(initial.state, "base64"));
  Y.applyUpdate(rdoc, htmlState("<p>Platz 42</p>"));
  command(owner, { action: "row.document.sync", pageId: table, rowId: tickets, generation: initial.generation, update: Buffer.from(Y.encodeStateAsUpdate(rdoc)).toString("base64") });
  changes = changedNow();
  assert.deepEqual(changes.changed, [table]);
  assert.deepEqual(changes.rows[table], [tickets]);

  // A file of the page.
  await step();
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", id(), other, "karte.pdf", "application/pdf", 3, owner.id);
  assert.deepEqual(changedNow().changed, [other]);

  // A record deleted: its page changed, the record is no longer named.
  await step();
  command(owner, { action: "row.delete", pageId: table, rowId: tickets });
  changes = changedNow();
  assert.deepEqual(changes.changed, [table]);
  assert.equal(changes.rows[table], undefined);
});

test("private records stay unnamed for others", async () => {
  await step();
  const secret = row("Gehalt", alice);
  command(alice, { action: "row.access", pageId: table, rowId: secret, access: "private", grants: [] });
  assert.ok(changedNow(alice).rows[table].includes(secret));
  const forOwner = changedNow(owner);
  assert.ok(forOwner.changed.includes(table));
  // The owner of the database manages permissions and may see it; a third
  // member may not.
  const bob = user("bob");
  run("INSERT INTO members VALUES(?,?,?)", wid, bob.id, "editor");
  assert.ok(!(changedNow(bob).rows[table] || []).includes(secret));
});

test("deleted, unreadable and locked pages are left out", async () => {
  // A private space alice may not read.
  const hidden = (command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true }) as { id: string }).id;
  const secret = create("Geheim", "document", hidden);
  await step();
  run("UPDATE documents SET html='<p>neu</p>' WHERE page_id=?", secret);
  assert.ok(changedNow(owner).changed.includes(secret));
  assert.ok(!changedNow(alice).changed.includes(secret));
  assert.ok(!changedNow(alice).pages.includes(secret));
  assert.ok(changedNow(alice).pages.includes(doc));

  // In the trash: neither listed nor changed.
  const gone = create("Wird gelöscht");
  command(owner, { action: "page.delete", pageId: gone });
  const after = changedNow(owner);
  assert.ok(!after.pages.includes(gone) && !after.changed.includes(gone));

  // A journal behind a PIN, with its days.
  const journal = create("Tagebuch", "journal");
  command(owner, { action: "journal.lock", pageId: journal, pin: "471108" });
  command(owner, { action: "journal.relock", pageId: journal });
  const locked = offlineChanges(owner, wid, null);
  assert.ok(!locked.pages.includes(journal));
  command(owner, { action: "journal.unlock", pageId: journal, pin: "471108" });
  assert.ok(offlineChanges(owner, wid, null).pages.includes(journal));
});

test("a since older than the log asks for everything", () => {
  assert.equal(offlineChanges(owner, wid, 1).full, true);
  // Not a member: refused.
  const stranger = user("stranger");
  assert.throws(() => offlineChanges(stranger, wid, null));
});
