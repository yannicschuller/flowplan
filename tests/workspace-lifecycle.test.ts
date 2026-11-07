import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Space, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-lifecycle-"),
);
const { one, all, run, id, transaction } = await import("../lib/db");
const { command, bootstrap, pageData, database, rows } =
  await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { requirePage } = await import("../lib/permissions");
const { publicTree } = await import("../lib/publication");
const { getForm } = await import("../lib/forms");
const { exportArchive, readZip } = await import("../lib/archive");
async function user(name: string): Promise<Identity> {
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
    disabled: 0,
    created_at: "",
    groups: [],
    isAdmin: false,
  };
}
async function fixture() {
  const owner = await user("Owner"),
    editor = await user("Editor"),
    viewer = await user("Viewer"),
    stranger = await user("Stranger"),
    wid = await createWorkspace(owner.id, "Lifecycle");
  await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const sid = (await one<{ id: string }>(
    "SELECT id FROM spaces WHERE workspace_id=?",
    wid,
  ))!.id;
  const space = async (privateSpace = false, actor = owner, name = "Area") =>
    (
      (await command(actor, {
        action: "space.create",
        workspaceId: wid,
        name,
        private: privateSpace,
      })) as { id: string }
    ).id;
  const page = async (
    spaceId = sid,
    title = "Page",
    kind = "document",
    actor = owner,
    parentId?: string,
  ) =>
    (
      (await command(actor, {
        action: "page.create",
        workspaceId: wid,
        spaceId,
        title,
        kind,
        parentId,
      })) as { id: string }
    ).id;
  return { owner, editor, viewer, stranger, wid, sid, space, page };
}
const spaceData = async (sid: string) =>
  (await one<Space>("SELECT * FROM spaces WHERE id=?", sid))!;
async function spaceAction(
  actor: Identity,
  action: string,
  sid: string,
  extra: Record<string, unknown> = {},
) {
  const space = await spaceData(sid);
  return await command(actor, {
    action,
    spaceId: sid,
    version: space.version,
    confirmName: space.name,
    ...extra,
  });
}
async function file(pageId: string, actor: Identity) {
  const fid = id(),
    path = join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid),
    bytes = Buffer.from("Unique upload " + fid);
  mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), {
    recursive: true,
  });
  writeFileSync(path, bytes);
  await run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    pageId,
    "attachment.txt",
    "text/plain",
    bytes.length,
    actor.id,
  );
  return { fid, path, bytes };
}

test("space management requires ownership and current confirmation/version; restore preserves pre-existing trash", async () => {
  const f = await fixture(),
    sid = await f.space(true, f.editor),
    root = await f.page(sid, "Root", "document", f.editor),
    child = await f.page(sid, "Child", "document", f.editor, root),
    old = await f.page(sid, "Already trashed", "document", f.editor);
  await command(f.editor, { action: "page.delete", pageId: old });
  await assert.rejects(
    async () => await spaceAction(f.owner, "space.delete", f.sid, { version: 999 }),
    { status: 409 },
  );
  const initial = await spaceData(sid);
  for (const actor of [f.viewer, f.stranger])
    await assert.rejects(async () => await spaceAction(actor, "space.delete", sid), {
      status: 403,
    });
  await assert.rejects(
    async () => await spaceAction(f.editor, "space.delete", sid, { confirmName: "Wrong" }),
    { status: 409 },
  );
  await command(f.editor, {
    action: "space.update",
    spaceId: sid,
    version: initial.version,
    name: "Renamed",
    private: true,
  });
  await assert.rejects(
    async () =>
      await spaceAction(f.editor, "space.delete", sid, { version: initial.version }),
    { status: 409 },
  );
  assert.equal((await requirePage(f.editor, root)).deleted_at, null);
  await spaceAction(f.editor, "space.delete", sid);
  assert.equal(
    (await bootstrap(f.editor, f.wid)).spaces.some((s) => s.id === sid),
    false,
  );
  assert.equal((await bootstrap(f.viewer, f.wid)).trashedSpaces.length, 0);
  assert.equal(
    (await bootstrap(f.owner, f.wid)).trashedSpaces.some((s) => s.id === sid),
    true,
  );
  await assert.rejects(
    async () => await command(f.editor, { action: "page.restore", pageId: root }),
    { status: 403 },
  );
  await assert.rejects(async () => await f.page(sid, "No creation", "document", f.editor), {
    status: 403,
  });
  await assert.rejects(
    async () =>
      await command(f.editor, {
        action: "space.update",
        spaceId: sid,
        name: "No rename",
        private: false,
      }),
    { status: 409 },
  );
  await spaceAction(f.owner, "space.restore", sid);
  assert.equal((await requirePage(f.editor, root)).deleted_at, null);
  assert.equal((await requirePage(f.editor, child)).parent_id, root);
  assert.ok((await one<Page>("SELECT * FROM pages WHERE id=?", old))!.deleted_at);
  await assert.rejects(async () => await requirePage(f.owner, root), { status: 403 }); // management does not confer private-content access
  assert.equal((await spaceData(sid)).owner_id, f.editor.id);
});

test("trashing a space revokes publications, guest links, forms and pending notifications; archive excludes it", async () => {
  const f = await fixture(),
    sid = await f.space(),
    root = await f.page(sid),
    table = await f.page(sid, "Form", "database"),
    asset = await file(root, f.owner);
  await command(f.owner, { action: "page.publish", pageId: root, enabled: true });
  const publicToken = (await one<Page>(
    "SELECT * FROM pages WHERE id=?",
    root,
  ))!.public_token!;
  const share = (await command(f.owner, {
    action: "share.create",
    pageId: root,
    name: "Editor link",
    role: "editor",
  })) as { token: string };
  await command(f.owner, {
    action: "form.update",
    pageId: table,
    enabled: true,
    internal: false,
    anonymous: true,
  });
  const token = String(
    (await one("SELECT token FROM forms WHERE page_id=?", table))!.token,
  );
  await run(
    "INSERT INTO notifications(id,user_id,page_id,body) VALUES(?,?,?,?)",
    id(),
    f.editor.id,
    root,
    "Queued",
  );
  await run("INSERT INTO grants VALUES(?,?,?,?)", root, f.viewer.id, "", "editor");
  await spaceAction(f.owner, "space.delete", sid);
  for (const t of [publicToken, share.token])
    await assert.rejects(async () => await publicTree(t), { status: 404 });
  await assert.rejects(async () => await getForm(token, null), { status: 404 });
  await assert.rejects(async () => await pageData(f.viewer, root));
  assert.equal(
    (await all("SELECT * FROM notifications WHERE page_id=?", root)).length,
    0,
  );
  assert.ok(existsSync(asset.path));
  const zip = await readZip(await exportArchive(f.owner, f.wid));
  const manifest = JSON.parse(zip.get("flowplan.json")!.toString());
  assert.equal(
    manifest.spaces.some((s: { id: string }) => s.id === sid),
    false,
  );
  assert.equal(
    manifest.pages.some((p: { id: string }) => p.id === root),
    false,
  );
  await spaceAction(f.owner, "space.restore", sid);
  assert.equal((await requirePage(f.viewer, root)).deleted_at, null);
  await assert.rejects(async () => await publicTree(share.token), { status: 404 });
  await assert.rejects(async () => await getForm(token, null), { status: 404 });
});

test("permanent space deletion cleans records, references, grants and uploads without touching other content; rollback preserves files", async () => {
  const f = await fixture(),
    sid = await f.space(),
    table = await f.page(sid, "Source", "database"),
    other = await f.page(f.sid, "Other", "database"),
    outside = await f.page(f.sid, "Keep"),
    asset = await file(table, f.owner),
    keep = await file(outside, f.owner);
  const row = (await command(f.owner, {
    action: "row.create",
    pageId: table,
    cells: { title: "Deleted" },
  })) as { id: string };
  const db = await database(other);
  await command(f.owner, {
    action: "database.update",
    pageId: other,
    version: db.version,
    fields: [
      ...db.fields,
      { id: "rel", name: "Link", type: "relation", relationPage: table },
      { id: "note", name: "Note", type: "text" },
    ],
    views: db.views,
  });
  const retained = (await command(f.owner, {
    action: "row.create",
    pageId: other,
    cells: { title: "Keep", rel: [row.id], note: row.id },
  })) as { id: string };
  const connected = await database(other);
  await command(f.owner, {
    action: "database.update",
    pageId: other,
    version: connected.version,
    fields: connected.fields,
    views: connected.views,
    relation: {
      fieldId: "rel",
      enabled: true,
      name: "Inverse",
      targetVersion: (await database(table)).version,
    },
  });
  assert.equal(
    (await all(
      "SELECT * FROM two_way_relations WHERE left_page=? OR right_page=?",
      table,
      table,
    )).length,
    1,
  );
  await run("UPDATE pages SET locked=1 WHERE id=?", other);
  await run("UPDATE pages SET cover=? WHERE id=?", `/api/files/${asset.fid}`, table);
  const template = (await command(f.owner, {
    action: "template.save",
    pageId: table,
    name: "Independent template",
  })) as { id: string };
  await run("INSERT INTO grants VALUES(?,?,?,?)", table, f.viewer.id, "", "viewer");
  await assert.rejects(async () => await spaceAction(f.owner, "space.purge", sid), {
    status: 409,
  });
  await spaceAction(f.owner, "space.delete", sid);
  await assert.rejects(
    async () =>
      await transaction(async () => {
        await command(
          f.owner,
          {
            action: "space.purge",
            spaceId: sid,
            version: (await spaceData(sid)).version,
            confirmName: "Area",
          },
          true,
        );
        throw Error("rollback");
      }, f.owner),
    /rollback/,
  );
  assert.ok(existsSync(asset.path));
  assert.ok(await spaceData(sid));
  assert.equal((await all("SELECT * FROM pending_file_deletions")).length, 0);
  await spaceAction(f.owner, "space.purge", sid);
  assert.equal(await spaceData(sid), undefined);
  assert.equal(await one("SELECT id FROM rows WHERE id=?", row.id), undefined);
  assert.equal(await one("SELECT id FROM files WHERE id=?", asset.fid), undefined);
  assert.equal(existsSync(asset.path), false);
  assert.deepEqual(readFileSync(keep.path), keep.bytes);
  assert.equal(
    (await all(
      "SELECT * FROM two_way_relations WHERE left_page=? OR right_page=?",
      table,
      table,
    )).length,
    0,
  );
  assert.ok(await one("SELECT id FROM templates WHERE id=?", template.id));
  assert.deepEqual(
    Buffer.from(
      (await one<{ data: Uint8Array }>(
        "SELECT data FROM template_files WHERE template_id=?",
        template.id,
      ))!.data,
    ),
    asset.bytes,
  );

  assert.deepEqual(
    (await rows(other)).find((r) => r.id === retained.id)!.cells.rel,
    [],
  );
  assert.equal((await rows(other))[0].cells.note, row.id);
  assert.equal(
    (await all("SELECT * FROM grants WHERE resource_id=?", table)).length,
    0,
  );
});

test("workspace deletion requires owner, exact name and another workspace; removes private data and all dependent metadata", async () => {
  const f = await fixture();
  await assert.rejects(async () => await spaceAction(f.owner, "space.delete", f.sid), {
    status: 409,
  });
  await assert.rejects(
    async () =>
      await command(f.owner, {
        action: "workspace.delete",
        workspaceId: f.wid,
        confirmName: "Lifecycle",
      }),
    { status: 409 },
  );
  const other = await createWorkspace(f.owner.id, "Keep workspace"),
    privateArea = await f.space(true, f.editor),
    root = await f.page(privateArea, "Secret", "document", f.editor),
    asset = await file(root, f.editor);
  const keepPage = (await one<{ id: string }>(
      "SELECT id FROM pages WHERE workspace_id=?",
      other,
    ))!.id,
    keep = await file(keepPage, f.owner);
  await command(f.editor, {
    action: "template.save",
    pageId: root,
    name: "Private template",
    private: true,
  });
  await command(f.owner, {
    action: "member.invite",
    workspaceId: f.wid,
    email: "invite@example.test",
    role: "editor",
  });
  await command(f.owner, {
    action: "group.create",
    workspaceId: f.wid,
    name: "Group",
  });
  const gid = (await one<{ id: string }>(
    "SELECT id FROM groups WHERE workspace_id=?",
    f.wid,
  ))!.id;
  await command(f.owner, {
    action: "group.member",
    groupId: gid,
    userId: f.viewer.id,
    enabled: true,
  });
  await command(f.owner, {
    action: "grant.set",
    resourceId: privateArea,
    groupId: gid,
    role: "viewer",
  });
  await run("INSERT INTO presence VALUES(?,?,?)", root, f.editor.id, Date.now());
  await run(
    "INSERT INTO notifications(id,user_id,page_id,body) VALUES(?,?,?,?)",
    id(),
    f.viewer.id,
    root,
    "Private",
  );
  for (const actor of [f.editor, f.viewer, f.stranger])
    await assert.rejects(
      async () =>
        await command(actor, {
          action: "workspace.delete",
          workspaceId: f.wid,
          confirmName: "Lifecycle",
        }),
      { status: 403 },
    );
  await assert.rejects(
    async () =>
      await command(f.owner, {
        action: "workspace.delete",
        workspaceId: f.wid,
        confirmName: "Old name",
      }),
    { status: 409 },
  );
  const result = (await command(f.owner, {
    action: "workspace.delete",
    workspaceId: f.wid,
    confirmName: "Lifecycle",
  })) as { nextWorkspaceId: string };
  assert.equal(result.nextWorkspaceId, other);
  for (const table of [
    "workspaces",
    "spaces",
    "pages",
    "templates",
    "invites",
    "groups",
  ])
    assert.equal(
      (await all(
        `SELECT * FROM ${table} WHERE ${table === "workspaces" ? "id" : "workspace_id"}=?`,
        f.wid,
      )).length,
      0,
      table,
    );
  for (const table of ["presence", "notifications"])
    assert.equal((await all(`SELECT * FROM ${table} WHERE page_id=?`, root)).length, 0);
  assert.equal(
    (await all(
      "SELECT * FROM grants WHERE resource_id=? OR group_id=?",
      privateArea,
      gid,
    )).length,
    0,
  );
  assert.equal(existsSync(asset.path), false);
  assert.deepEqual(readFileSync(keep.path), keep.bytes);
  assert.ok(await one("SELECT id FROM users WHERE id=?", f.editor.id));
  assert.equal((await bootstrap(f.owner)).workspace.id, other);
});

test("leaving transfers owned private areas explicitly and removes only this membership and its grants, groups and invitations", async () => {
  const f = await fixture(),
    sid = await f.space(true),
    root = await f.page(sid),
    other = await createWorkspace(f.owner.id, "Other");
  await assert.rejects(
    async () =>
      await command(f.owner, {
        action: "workspace.leave",
        workspaceId: f.wid,
        confirmName: "Lifecycle",
      }),
    { status: 409 },
  );
  await command(f.owner, {
    action: "member.role",
    workspaceId: f.wid,
    userId: f.editor.id,
    role: "owner",
  });
  await run("UPDATE users SET disabled=1 WHERE id=?", f.editor.id);
  await assert.rejects(
    async () =>
      await command(f.owner, {
        action: "workspace.leave",
        workspaceId: f.wid,
        confirmName: "Lifecycle",
        transferTo: f.editor.id,
      }),
    { status: 409 },
  );
  await run("UPDATE users SET disabled=0 WHERE id=?", f.editor.id);
  await assert.rejects(
    async () =>
      await command(f.owner, {
        action: "workspace.leave",
        workspaceId: f.wid,
        confirmName: "Lifecycle",
        transferTo: f.viewer.id,
      }),
    { status: 409 },
  );
  await command(f.owner, {
    action: "group.create",
    workspaceId: f.wid,
    name: "Membership",
  });
  const gid = (await one<{ id: string }>(
    "SELECT id FROM groups WHERE workspace_id=?",
    f.wid,
  ))!.id;
  await run("INSERT INTO group_members VALUES(?,?)", gid, f.owner.id);
  await run("INSERT INTO grants VALUES(?,?,?,?)", root, f.owner.id, "", "editor");
  await command(f.owner, { action: "favorite", pageId: root, value: true });
  await command(f.owner, {
    action: "member.invite",
    workspaceId: f.wid,
    email: f.owner.email,
    role: "editor",
  });
  const result = (await command(f.owner, {
    action: "workspace.leave",
    workspaceId: f.wid,
    confirmName: "Lifecycle",
    transferTo: f.editor.id,
  })) as { nextWorkspaceId: string };
  assert.equal(result.nextWorkspaceId, other);
  assert.equal((await spaceData(sid)).owner_id, f.editor.id);
  assert.equal((await requirePage(f.editor, root)).id, root);
  await assert.rejects(async () => await requirePage(f.owner, root), { status: 403 });
  assert.equal(
    (await all(
      "SELECT * FROM grants WHERE user_id=? AND resource_id=?",
      f.owner.id,
      root,
    )).length,
    0,
  );
  assert.equal(
    (await all(
      "SELECT * FROM group_members WHERE user_id=? AND group_id=?",
      f.owner.id,
      gid,
    )).length,
    0,
  );
  assert.equal(
    (await all(
      "SELECT * FROM favorites WHERE user_id=? AND page_id=?",
      f.owner.id,
      root,
    )).length,
    0,
  );
  assert.equal(
    (await all(
      "SELECT * FROM invites WHERE workspace_id=? AND email=?",
      f.wid,
      f.owner.email,
    )).length,
    0,
  );
  assert.ok(
    await one(
      "SELECT * FROM members WHERE workspace_id=? AND user_id=?",
      other,
      f.owner.id,
    ),
  );
  const left = (await command(f.viewer, {
    action: "workspace.leave",
    workspaceId: f.wid,
    confirmName: "Lifecycle",
  })) as { nextWorkspaceId: null };
  assert.equal(left.nextWorkspaceId, null);
});

test("failed physical upload cleanup is durable and retries after commit without reporting a false database failure", async () => {
  const f = await fixture(),
    sid = await f.space(),
    root = await f.page(sid),
    asset = await file(root, f.owner);
  rmSync(asset.path);
  mkdirSync(asset.path); // Reproduce an unlink failure without mocking application code.
  await spaceAction(f.owner, "space.delete", sid);
  await spaceAction(f.owner, "space.purge", sid);
  assert.ok(await one("SELECT id FROM pending_file_deletions WHERE id=?", asset.fid));
  assert.equal(await one("SELECT id FROM pages WHERE id=?", root), undefined);
  rmSync(asset.path, { recursive: true });
  writeFileSync(asset.path, asset.bytes);
  await transaction(() => {});
  assert.equal(existsSync(asset.path), false);
  assert.equal(
    await one("SELECT id FROM pending_file_deletions WHERE id=?", asset.fid),
    undefined,
  );
  const pending = Array.from({ length: 1001 }, () => ({ id: id(), path: "" }));
  await transaction(async () => {
    for (const item of pending) {
      item.path = join(process.env.FLOWPLAN_DATA_DIR!, "uploads", item.id);
      writeFileSync(item.path, "Queued test upload");
      await run("INSERT INTO pending_file_deletions VALUES(?)", item.id);
    }
  });
  assert.equal((await all("SELECT id FROM pending_file_deletions")).length, 0);
  assert.ok(pending.every((item) => !existsSync(item.path)));
});
