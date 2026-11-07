// Audit (Nov 2026): a database's files were hidden only while no visible
// record used them. An editor who knew the id of a private record's file
// wrote `/api/files/<id>` into a record they can see and downloaded it
// (GET /api/files checks hiddenFileIds). Now a reference in a visible record
// does not open a file uploaded for a hidden one (lib/row-files.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-private-file-ref-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database, pageData } = await import("../lib/api");
const { requirePage } = await import("../lib/permissions");
const { hiddenFileIds } = await import("../lib/row-files");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("owner"),
  editor = await account("editor"),
  helper = await account("helper"),
  viewer = await account("viewer");
const wid = await createWorkspace(owner.id, "WS");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, helper.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const dbId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "HR", kind: "database" })) as { id: string }).id;
await command(owner, {
  action: "database.update",
  pageId: dbId,
  version: (await database(dbId)).version,
  fields: [
    { id: "title", name: "Name", type: "text" },
    { id: "att", name: "Files", type: "files" },
  ],
  views: (await database(dbId)).views,
});
async function upload(u: Identity, name: string) {
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, dbId, name, "text/plain", 1, u.id);
  return fid;
}
async function record(u: Identity, title: string, files: string[], access?: "private", grants: unknown[] = []) {
  const rowId = ((await command(u, { action: "row.create", pageId: dbId, cells: { title, att: files.map((f) => `/api/files/${f}`) } })) as { id: string }).id;
  if (access) await command(u, { action: "row.access", pageId: dbId, rowId, access, grants });
  return rowId;
}
const hiddenFor = async (u: Identity) => await hiddenFileIds(u, await requirePage(u, dbId));
const listed = async (u: Identity) => ((await pageData(u, dbId)) as unknown as { files: { id: string }[] }).files.map((f) => f.id);

test("a private record's file is not opened by a reference written into a visible record", async () => {
  const secret = await upload(owner, "salaries.pdf");
  await record(owner, "Private", [secret], "private");
  assert.ok((await hiddenFor(editor)).has(secret));
  // The editor writes the reference into a record everyone sees.
  await record(editor, "Bait", [secret]);
  assert.ok((await hiddenFor(editor)).has(secret), "the reference does not open the file for its writer");
  assert.ok((await hiddenFor(viewer)).has(secret), "nor for anyone else who cannot see the private record");
  assert.ok(!(await listed(editor)).includes(secret));
  assert.ok(!(await hiddenFor(owner)).has(secret), "the owner still sees their file");
});

test("a file uploaded by someone with a grant on the private record stays hidden too", async () => {
  const secret = await upload(helper, "notes.txt");
  await record(owner, "Shared privately", [secret], "private", [{ userId: helper.id, role: "editor" }]);
  await record(editor, "Bait 2", [secret]);
  assert.ok((await hiddenFor(editor)).has(secret));
  assert.ok(!(await hiddenFor(helper)).has(secret));
});

test("files of visible records stay visible when a private record uses them as well", async () => {
  // The editor's file in a public record, also put into the owner's private one.
  const shared = await upload(editor, "agenda.txt");
  await record(editor, "Public", [shared]);
  await record(owner, "Private copy", [shared], "private");
  assert.ok(!(await hiddenFor(viewer)).has(shared));
  assert.ok(!(await hiddenFor(editor)).has(shared));
  // One's own upload is never hidden from oneself.
  const own = await upload(editor, "mine.txt");
  await record(owner, "Private with the editor's file", [own], "private");
  await record(editor, "Mine", [own]);
  assert.ok(!(await hiddenFor(editor)).has(own));
  // Only in a private record: hidden as before.
  const only = await upload(owner, "only.txt");
  await record(owner, "Only private", [only], "private");
  assert.ok((await hiddenFor(viewer)).has(only));
});

test("a file of a record template appears in private and visible records made from it", async () => {
  const logo = await upload(owner, "logo.png");
  await run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,created_by) VALUES(?,?,?,?,?,?)",
    id(),
    dbId,
    "With logo",
    JSON.stringify({ att: [`/api/files/${logo}`] }),
    "",
    owner.id,
  );
  await record(owner, "From template, private", [logo], "private");
  await record(owner, "From template", [logo]);
  assert.ok(!(await hiddenFor(viewer)).has(logo));
  // A template written by someone else does not open a private record's file.
  const secret = await upload(owner, "contract.pdf");
  await record(owner, "Contract", [secret], "private");
  await run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,created_by) VALUES(?,?,?,?,?,?)",
    id(),
    dbId,
    "Bait",
    JSON.stringify({ att: [`/api/files/${secret}`] }),
    "",
    editor.id,
  );
  await record(editor, "From the bait template", [secret]);
  assert.ok((await hiddenFor(editor)).has(secret));
});
