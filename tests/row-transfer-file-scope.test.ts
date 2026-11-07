// Security: copying records (rows.transfer, copy mode) duplicates only the
// source database's own, visible, untrashed files. A reference to a file of
// another database or workspace, or in the trash, stays as it is, so
// GET /api/files keeps enforcing that file's permissions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-transfer-scope-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { id, run, one, nowText } = await import("../lib/db");
const { command, database, bootstrap, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
async function makeDb(u: Identity, wid: string, spaceId: string, title: string) {
  const pageId = ((await command(u, { action: "page.create", workspaceId: wid, spaceId, kind: "database", title })) as { id: string }).id;
  const d = await database(pageId);
  await command(u, {
    action: "database.update",
    pageId,
    version: d.version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "note", name: "Note", type: "text" },
    ],
    views: d.views,
  });
  return pageId;
}
async function upload(u: Identity, pageId: string, content: string) {
  const fid = id();
  mkdirSync(join(dir, "uploads"), { recursive: true });
  writeFileSync(join(dir, "uploads", fid), content);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, "s.txt", "text/plain", content.length, u.id);
  return fid;
}

const victim = await user("victim");
const vw = await createWorkspace(victim.id, "Victim");
const vb = await bootstrap(victim, vw);
const vdb = await makeDb(victim, vw, vb.spaces[0].id, "Secrets");
const attacker = await user("attacker");
const aw = await createWorkspace(attacker.id, "Attacker");
const ab = await bootstrap(attacker, aw);
const src = await makeDb(attacker, aw, ab.spaces[0].id, "Src");
const dst = await makeDb(attacker, aw, ab.spaces[0].id, "Dst");

async function copyNote(u: Identity, from: string, to: string, note: string) {
  const r = ((await command(u, { action: "row.create", pageId: from, cells: { title: "x", note } })) as { id: string }).id;
  const res = (await command(u, { action: "rows.transfer", pageId: from, rowIds: [r], targetPageId: to, mode: "copy" })) as { ids: string[] };
  return String((await rows(to)).find((x) => x.id === res.ids[0])!.cells.note);
}
const filesOn = async (pageId: string) => (await one<{ n: number }>("SELECT COUNT(*) n FROM files WHERE page_id=?", pageId))!.n;

test("copying a record does not duplicate a file of another workspace", async () => {
  const secret = await upload(victim, vdb, "SECRET");
  const before = await filesOn(dst);
  assert.equal(await copyNote(attacker, src, dst, `/api/files/${secret}`), `/api/files/${secret}`);
  assert.equal(await filesOn(dst), before);
});

test("copying a record does not duplicate a file in the trash", async () => {
  const trashed = await upload(attacker, src, "T");
  await run("UPDATE files SET deleted_at=? WHERE id=?", nowText(), trashed);
  const before = await filesOn(dst);
  assert.equal(await copyNote(attacker, src, dst, `/api/files/${trashed}`), `/api/files/${trashed}`);
  assert.equal(await filesOn(dst), before);
});

test("copying a record still duplicates the source database's own visible file", async () => {
  const own = await upload(attacker, src, "OWN");
  const url = await copyNote(attacker, src, dst, `/api/files/${own}`);
  assert.notEqual(url, `/api/files/${own}`);
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", url.split("/").pop()!))!.page_id, dst);
});
