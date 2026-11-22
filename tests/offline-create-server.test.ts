import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-offline-create-"));
const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { claimFileId } = await import("../lib/client-ids");
const { templateCatalog } = await import("../lib/template-catalog");

// Issue #370: pages made offline bring their own id (and the ids of a
// template's records, a notebook's first sheet, an upload's file).
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
const create = (who: Identity, extra: Record<string, unknown>) => command(who, { action: "page.create", workspaceId: wid, spaceId: space, title: "Offline", ...extra }) as Promise<{ id: string }>;
const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};

test("page.create takes the device's id once; the same page sent again is created once", async () => {
  const pid = randomUUID();
  assert.equal((await create(owner, { pageId: pid })).id, pid);
  // Again (the answer was lost, the Idempotency-Key expired): nothing new.
  assert.equal((await create(owner, { pageId: pid, title: "Zweimal" })).id, pid);
  assert.equal((await all("SELECT id FROM pages WHERE id=?", pid)).length, 1);
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", pid))?.title, "Offline");
  // Someone else's id, or the same id in another place: refused.
  assert.equal(await status(create(alice, { pageId: pid })), 409);
  // Not a UUID: a validation error (400 through the API).
  assert.notEqual(await status(create(owner, { pageId: "not-a-uuid" })), 200);
  // A sub-page made offline below it.
  const sub = randomUUID();
  await create(owner, { pageId: sub, parentId: pid });
  assert.equal((await one<{ parent_id: string }>("SELECT parent_id FROM pages WHERE id=?", sub))?.parent_id, pid);
});

test("a database from a template gets its example records under the ids sent", async () => {
  const pid = randomUUID();
  const rows = (templateCatalog.project.rows || []).map(() => randomUUID());
  await create(owner, { pageId: pid, kind: "database", starterTemplate: "project", rowIds: rows });
  const data = (await pageData(owner, pid)) as { rows: { id: string }[] };
  assert.deepEqual(data.rows.map((r) => r.id).sort(), [...rows].sort());
  // Records made offline in it fit (their own ids, the template's fields).
  await command(owner, { action: "row.create", pageId: pid, rowId: randomUUID(), cells: { title: "Offline" } });
  // Too few ids, or ids in use: refused, nothing created.
  const other = randomUUID();
  assert.equal(await status(create(owner, { pageId: other, kind: "database", starterTemplate: "project", rowIds: rows.slice(1) })), 400);
  assert.equal(await status(create(owner, { pageId: other, kind: "database", starterTemplate: "project", rowIds: rows })), 409);
  assert.equal(await one("SELECT 1 FROM pages WHERE id=?", other), undefined);
});

test("a notebook made offline keeps its first sheet's id", async () => {
  const pid = randomUUID();
  await create(owner, { pageId: pid, kind: "notebook", sheetId: "sheet-offline-1" });
  assert.deepEqual(await all("SELECT id FROM notebook_sheets WHERE page_id=?", pid), [{ id: "sheet-offline-1" }]);
  assert.equal(await status(create(owner, { pageId: randomUUID(), kind: "notebook", sheetId: "sheet-offline-1" })), 409);
  assert.notEqual(await status(create(owner, { pageId: randomUUID(), kind: "notebook", sheetId: "bad id!" })), 200);
});

test("an upload's id from the device: new, the same upload again, someone else's", async () => {
  const pid = (await create(owner, {})).id;
  const fid = randomUUID();
  assert.deepEqual(await claimFileId(owner, pid, fid), { id: fid, existing: null });
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pid, "bild.png", "image/png", 3, owner.id);
  assert.deepEqual(await claimFileId(owner, pid, fid.toUpperCase()), { id: fid, existing: { name: "bild.png", mime: "image/png" } });
  await assert.rejects(claimFileId(alice, pid, fid), (e: { status?: number }) => e.status === 409);
  await assert.rejects(claimFileId(owner, randomUUID(), fid), (e: { status?: number }) => e.status === 409);
  await assert.rejects(claimFileId(owner, pid, "nope"));
});

test("a record made offline gets a blank document with the generation the device chose; its offline text merges in (#370)", async () => {
  const Y = await import("yjs");
  const { rowDocumentData } = await import("../lib/row-documents");
  const pid = (await create(owner, { kind: "database" })).id;
  const rid = randomUUID();
  await command(owner, { action: "row.create", pageId: pid, rowId: rid, cells: {}, templateId: null, documentGeneration: rid });
  // Sent again (lost answer): still one record, the same document.
  await command(owner, { action: "row.create", pageId: pid, rowId: rid, cells: {}, templateId: null, documentGeneration: randomUUID() });
  assert.equal((await rowDocumentData(owner, pid, rid)).generation, rid);
  // What was written offline, in a document of its own (no server state).
  const offline = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("Offline geschrieben")]);
  offline.getXmlFragment("default").insert(0, [paragraph]);
  await command(owner, { action: "row.document.sync", pageId: pid, rowId: rid, generation: rid, update: Buffer.from(Y.encodeStateAsUpdate(offline)).toString("base64") });
  // The blank paragraph gives way: just the text.
  assert.equal((await rowDocumentData(owner, pid, rid)).html, "<p>Offline geschrieben</p>");
  // Without a device id the generation is not taken; not a UUID: refused.
  const other = randomUUID();
  assert.notEqual(await status(command(owner, { action: "row.create", pageId: pid, rowId: other, cells: {}, templateId: null, documentGeneration: "nope" })), 200);
  const plain = (await command(owner, { action: "row.create", pageId: pid, cells: {}, templateId: null, documentGeneration: other })) as { id: string };
  assert.notEqual((await rowDocumentData(owner, pid, plain.id)).generation, other);
});
