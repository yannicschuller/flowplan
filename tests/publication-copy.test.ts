import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-pubcopy-"),
);
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database, rows } = await import("../lib/api");

async function account(name: string) {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const owner = await account("pub-owner"),
  visitor = await account("pub-visitor");
const wid = await createWorkspace(owner.id, "Quelle"),
  space = (await bootstrap(owner, wid)).spaces[0].id;
const visitorWorkspace = await createWorkspace(visitor.id, "Besucher"),
  visitorSpace = (await bootstrap(visitor, visitorWorkspace)).spaces[0].id;
const act = async (input: Record<string, unknown>, as = owner) =>
  (await command(as, input)) as { id: string; token?: string };
const create = async (title: string, kind = "document", parentId?: string) =>
  (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: space,
    title,
    kind,
    parentId,
  })).id;
async function file(pageId: string, name: string) {
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fid), name);
  await run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    pageId,
    name,
    "image/png",
    name.length,
    owner.id,
  );
  return `/api/files/${fid}`;
}

const root = await create("Handbuch"),
  child = await create("Kapitel", "document", root),
  table = await create("Kontakte", "database", root);
const shown = await file(root, "shown.png"),
  hidden = await file(root, "hidden.png");
await run(
  "UPDATE documents SET html=? WHERE page_id=?",
  `<p>Siehe <a href="/#page=${child}">Kapitel</a> und <a href="/#page=${wid}">fremd</a></p><p><img src="${shown}"></p><div data-linked-database="1" data-linked-source="${table}"></div>`,
  root,
);
const d = await database(table);
await command(owner, {
  action: "database.update",
  pageId: table,
  version: d.version,
  fields: [
    { id: "title", name: "Name", type: "text" },
    { id: "phone", name: "Telefon", type: "phone" },
    { id: "who", name: "Zuständig", type: "person" },
    { id: "rel", name: "Bezug", type: "relation", relationPage: table },
  ],
  views: d.views,
});
await act({
  action: "row.create",
  pageId: table,
  cells: { title: "Kim", phone: "123", who: owner.id },
});
const token = async () =>
  (await one<{ public_token: string }>(
    "SELECT public_token FROM pages WHERE id=?",
    root,
  ))!.public_token;

test("visitors copy only the published pages, public properties and published files", async () => {
  await act({
    action: "page.publish",
    pageId: root,
    enabled: true,
    includeChildren: true,
  });
  const copy = (await act(
    {
      action: "publication.copy",
      token: await token(),
      workspaceId: visitorWorkspace,
      spaceId: visitorSpace,
    },
    visitor,
  )).id;
  const copied = await all<{
    id: string;
    title: string;
    parent_id: string | null;
    workspace_id: string;
  }>(
    "SELECT id,title,parent_id,workspace_id FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND title IN ('Handbuch (Kopie)','Kapitel','Kontakte')",
    visitorWorkspace,
  );
  assert.equal(copied.length, 3);
  const copiedChild = copied.find((p) => p.title === "Kapitel")!;
  const copiedTable = copied.find((p) => p.title === "Kontakte")!;
  assert.equal(copiedChild.parent_id, copy);
  const html = (await one<{ html: string }>(
    "SELECT html FROM documents WHERE page_id=?",
    copy,
  ))!.html;
  assert.match(html, new RegExp(`#page=${copiedChild.id}`));
  assert.doesNotMatch(html, new RegExp(wid));
  assert.doesNotMatch(html, new RegExp(table));
  const files = await all<{ name: string; id: string }>(
    "SELECT id,name FROM files WHERE page_id=?",
    copy,
  );
  assert.deepEqual(
    files.map((f) => f.name),
    ["shown.png"],
  );
  assert.ok(
    existsSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", files[0].id)),
  );
  assert.match(html, new RegExp(files[0].id));
  const fields = (await database(copiedTable.id)).fields.map((f) => f.id);
  assert.deepEqual(fields, ["title", "phone"]);
  const [row] = await rows(copiedTable.id);
  assert.deepEqual(row.cells, { title: "Kim", phone: "123" });
  assert.equal(row.created_by, visitor.id);
  // The visitor can work with the copy.
  await command(visitor, {
    action: "page.update",
    pageId: copy,
    patch: { title: "Mein Handbuch" },
  });
  void hidden;
});

test("copying requires a publication that allows it and write access to the target", async () => {
  const input = {
    action: "publication.copy",
    workspaceId: visitorWorkspace,
    spaceId: visitorSpace,
  };
  await act({
    action: "page.publish",
    pageId: root,
    enabled: true,
    includeChildren: true,
    allowCopy: false,
  });
  await assert.rejects(
    async () => await act({ ...input, token: await token() }, visitor),
    /nicht kopiert/,
  );
  await act({
    action: "page.publish",
    pageId: root,
    enabled: true,
    includeChildren: false,
  });
  // Without children only the root page is copied.
  const before = (await one<{ n: number }>(
    "SELECT COUNT(*) n FROM pages WHERE workspace_id=?",
    visitorWorkspace,
  ))!.n;
  await act({ ...input, token: await token() }, visitor);
  assert.equal(
    (await one<{ n: number }>(
      "SELECT COUNT(*) n FROM pages WHERE workspace_id=?",
      visitorWorkspace,
    ))!.n,
    before + 1,
  );
  await assert.rejects(
    async () =>
      await act(
        { ...input, token: await token(), workspaceId: wid, spaceId: space },
        visitor,
      ),
    /Berechtigung|Mitglied|Zugriff/i,
  );
  const share = await act({
    action: "share.create",
    pageId: root,
    name: "Link",
    role: "viewer",
  });
  await assert.rejects(
    async () => await act({ ...input, token: share.token! }, visitor),
    /nicht kopiert/,
  );
  await act({ action: "page.publish", pageId: root, enabled: false });
  await assert.rejects(
    async () => await act({ ...input, token: "missing" }, visitor),
    /nicht kopiert/,
  );
});
