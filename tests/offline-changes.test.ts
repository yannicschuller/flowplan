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

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  alice = await user("alice");
const wid = await createWorkspace(owner.id, "Offline");
await run("INSERT INTO members VALUES(?,?,?)", wid, alice.id, "editor");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string, kind = "document", spaceId = space) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId, title, kind })) as { id: string }).id;
const doc = await create("Reiseplan"),
  table = await create("Packliste", "database"),
  other = await create("Unverändert");
const row = async (title: string, who = owner) =>
  ((await command(who, { action: "row.create", pageId: table, cells: { title } })) as { id: string }).id;
const passport = await row("Reisepass"),
  tickets = await row("Tickets");
// Each step asks from a point after everything before it.
let mark = 0;
const step = async () => {
  await new Promise((r) => setTimeout(r, 15));
  mark = Date.now();
  await new Promise((r) => setTimeout(r, 15));
};
const changedNow = async (who: Identity = owner) => await offlineChanges(who, wid, mark, Date.now(), 0);

test("without since everything readable counts as changed", async () => {
  const all = await offlineChanges(owner, wid, null);
  assert.equal(all.full, true);
  for (const pid of [doc, table, other]) assert.ok(all.pages.includes(pid) && all.changed.includes(pid));
  assert.equal(parseSince(all.now), Date.parse(all.now));
  assert.equal(parseSince("nonsense"), null);
});

test("document, record, record document and file edits are reported", async () => {
  await step();
  assert.deepEqual((await changedNow()).changed, []);
  // Document edit through the collaboration sync.
  const pd = (await pageData(owner, doc)) as { generation: string; state: string };
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, htmlState("<p>Zug um 8 Uhr</p>"));
  await command(owner, { action: "document.sync", pageId: doc, generation: pd.generation, update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64") });
  let changes = await changedNow();
  assert.deepEqual(changes.changed, [doc]);
  assert.equal(changes.full, false);

  // A record edit does not touch pages.updated_at, the log catches it.
  await step();
  const version = Number(((await pageData(owner, table)) as { rows: { id: string; version: number }[] }).rows.find((r) => r.id === passport)!.version);
  await command(owner, { action: "row.update", pageId: table, rowId: passport, version, cells: { title: "Reisepass (neu)" } });
  changes = await changedNow();
  assert.deepEqual(changes.changed, [table]);
  assert.deepEqual(changes.rows[table], [passport]);

  // A record document.
  await step();
  const initial = await rowDocumentData(owner, table, tickets);
  const rdoc = new Y.Doc();
  Y.applyUpdate(rdoc, Buffer.from(initial.state, "base64"));
  Y.applyUpdate(rdoc, htmlState("<p>Platz 42</p>"));
  await command(owner, { action: "row.document.sync", pageId: table, rowId: tickets, generation: initial.generation, update: Buffer.from(Y.encodeStateAsUpdate(rdoc)).toString("base64") });
  changes = await changedNow();
  assert.deepEqual(changes.changed, [table]);
  assert.deepEqual(changes.rows[table], [tickets]);

  // A file of the page.
  await step();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", id(), other, "karte.pdf", "application/pdf", 3, owner.id);
  assert.deepEqual((await changedNow()).changed, [other]);

  // A record deleted: its page changed, the record is no longer named.
  await step();
  await command(owner, { action: "row.delete", pageId: table, rowId: tickets });
  changes = await changedNow();
  assert.deepEqual(changes.changed, [table]);
  assert.equal(changes.rows[table], undefined);
});

test("private records stay unnamed for others", async () => {
  await step();
  const secret = await row("Gehalt", alice);
  await command(alice, { action: "row.access", pageId: table, rowId: secret, access: "private", grants: [] });
  assert.ok((await changedNow(alice)).rows[table].includes(secret));
  const forOwner = await changedNow(owner);
  assert.ok(forOwner.changed.includes(table));
  // The owner of the database manages permissions and may see it; a third
  // member may not.
  const bob = await user("bob");
  await run("INSERT INTO members VALUES(?,?,?)", wid, bob.id, "editor");
  assert.ok(!((await changedNow(bob)).rows[table] || []).includes(secret));
});

test("deleted, unreadable and locked pages are left out", async () => {
  // A private space alice may not read.
  const hidden = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true })) as { id: string }).id;
  const secret = await create("Geheim", "document", hidden);
  await step();
  await run("UPDATE documents SET html='<p>neu</p>' WHERE page_id=?", secret);
  assert.ok((await changedNow(owner)).changed.includes(secret));
  assert.ok(!(await changedNow(alice)).changed.includes(secret));
  assert.ok(!(await changedNow(alice)).pages.includes(secret));
  assert.ok((await changedNow(alice)).pages.includes(doc));

  // In the trash: neither listed nor changed.
  const gone = await create("Wird gelöscht");
  await command(owner, { action: "page.delete", pageId: gone });
  const after = await changedNow(owner);
  assert.ok(!after.pages.includes(gone) && !after.changed.includes(gone));

  // A journal behind a PIN, with its days.
  const journal = await create("Tagebuch", "journal");
  await command(owner, { action: "journal.lock", pageId: journal, pin: "471108" });
  await command(owner, { action: "journal.relock", pageId: journal });
  const locked = await offlineChanges(owner, wid, null);
  assert.ok(!locked.pages.includes(journal));
  await command(owner, { action: "journal.unlock", pageId: journal, pin: "471108" });
  assert.ok((await offlineChanges(owner, wid, null)).pages.includes(journal));
});

test("a since older than the log asks for everything", async () => {
  assert.equal((await offlineChanges(owner, wid, 1)).full, true);
  // Not a member: refused.
  const stranger = await user("stranger");
  await assert.rejects(async () => await offlineChanges(stranger, wid, null));
});
