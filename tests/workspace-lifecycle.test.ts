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
function user(name: string): Identity {
  const uid = id();
  run(
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
function fixture() {
  const owner = user("Owner"),
    editor = user("Editor"),
    viewer = user("Viewer"),
    stranger = user("Stranger"),
    wid = createWorkspace(owner.id, "Lifecycle");
  run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const sid = one<{ id: string }>(
    "SELECT id FROM spaces WHERE workspace_id=?",
    wid,
  )!.id;
  const space = (privateSpace = false, actor = owner, name = "Area") =>
    (
      command(actor, {
        action: "space.create",
        workspaceId: wid,
        name,
        private: privateSpace,
      }) as { id: string }
    ).id;
  const page = (
    spaceId = sid,
    title = "Page",
    kind = "document",
    actor = owner,
    parentId?: string,
  ) =>
    (
      command(actor, {
        action: "page.create",
        workspaceId: wid,
        spaceId,
        title,
        kind,
        parentId,
      }) as { id: string }
    ).id;
  return { owner, editor, viewer, stranger, wid, sid, space, page };
}
const spaceData = (sid: string) =>
  one<Space>("SELECT * FROM spaces WHERE id=?", sid)!;
function spaceAction(
  actor: Identity,
  action: string,
  sid: string,
  extra: Record<string, unknown> = {},
) {
  const space = spaceData(sid);
  return command(actor, {
    action,
    spaceId: sid,
    version: space.version,
    confirmName: space.name,
    ...extra,
  });
}
function file(pageId: string, actor: Identity) {
  const fid = id(),
    path = join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid),
    bytes = Buffer.from("Unique upload " + fid);
  mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), {
    recursive: true,
  });
  writeFileSync(path, bytes);
  run(
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

test("space management requires ownership and current confirmation/version; restore preserves pre-existing trash", () => {
  const f = fixture(),
    sid = f.space(true, f.editor),
    root = f.page(sid, "Root", "document", f.editor),
    child = f.page(sid, "Child", "document", f.editor, root),
    old = f.page(sid, "Already trashed", "document", f.editor);
  command(f.editor, { action: "page.delete", pageId: old });
  assert.throws(
    () => spaceAction(f.owner, "space.delete", f.sid, { version: 999 }),
    { status: 409 },
  );
  const initial = spaceData(sid);
  for (const actor of [f.viewer, f.stranger])
    assert.throws(() => spaceAction(actor, "space.delete", sid), {
      status: 403,
    });
  assert.throws(
    () => spaceAction(f.editor, "space.delete", sid, { confirmName: "Wrong" }),
    { status: 409 },
  );
  command(f.editor, {
    action: "space.update",
    spaceId: sid,
    version: initial.version,
    name: "Renamed",
    private: true,
  });
  assert.throws(
    () =>
      spaceAction(f.editor, "space.delete", sid, { version: initial.version }),
    { status: 409 },
  );
  assert.equal(requirePage(f.editor, root).deleted_at, null);
  spaceAction(f.editor, "space.delete", sid);
  assert.equal(
    bootstrap(f.editor, f.wid).spaces.some((s) => s.id === sid),
    false,
  );
  assert.equal(bootstrap(f.viewer, f.wid).trashedSpaces.length, 0);
  assert.equal(
    bootstrap(f.owner, f.wid).trashedSpaces.some((s) => s.id === sid),
    true,
  );
  assert.throws(
    () => command(f.editor, { action: "page.restore", pageId: root }),
    { status: 403 },
  );
  assert.throws(() => f.page(sid, "No creation", "document", f.editor), {
    status: 403,
  });
  assert.throws(
    () =>
      command(f.editor, {
        action: "space.update",
        spaceId: sid,
        name: "No rename",
        private: false,
      }),
    { status: 409 },
  );
  spaceAction(f.owner, "space.restore", sid);
  assert.equal(requirePage(f.editor, root).deleted_at, null);
  assert.equal(requirePage(f.editor, child).parent_id, root);
  assert.ok(one<Page>("SELECT * FROM pages WHERE id=?", old)!.deleted_at);
  assert.throws(() => requirePage(f.owner, root), { status: 403 }); // management does not confer private-content access
  assert.equal(spaceData(sid).owner_id, f.editor.id);
});

test("trashing a space revokes publications, guest links, forms and pending notifications; archive excludes it", async () => {
  const f = fixture(),
    sid = f.space(),
    root = f.page(sid),
    table = f.page(sid, "Form", "database"),
    asset = file(root, f.owner);
  command(f.owner, { action: "page.publish", pageId: root, enabled: true });
  const publicToken = one<Page>(
    "SELECT * FROM pages WHERE id=?",
    root,
  )!.public_token!;
  const share = command(f.owner, {
    action: "share.create",
    pageId: root,
    name: "Editor link",
    role: "editor",
  }) as { token: string };
  command(f.owner, {
    action: "form.update",
    pageId: table,
    enabled: true,
    internal: false,
    anonymous: true,
  });
  const token = String(
    one("SELECT token FROM forms WHERE page_id=?", table)!.token,
  );
  run(
    "INSERT INTO notifications(id,user_id,page_id,body) VALUES(?,?,?,?)",
    id(),
    f.editor.id,
    root,
    "Queued",
  );
  run("INSERT INTO grants VALUES(?,?,?,?)", root, f.viewer.id, "", "editor");
  spaceAction(f.owner, "space.delete", sid);
  for (const t of [publicToken, share.token])
    assert.throws(() => publicTree(t), { status: 404 });
  assert.throws(() => getForm(token, null), { status: 404 });
  assert.throws(() => pageData(f.viewer, root));
  assert.equal(
    all("SELECT * FROM notifications WHERE page_id=?", root).length,
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
  spaceAction(f.owner, "space.restore", sid);
  assert.equal(requirePage(f.viewer, root).deleted_at, null);
  assert.throws(() => publicTree(share.token), { status: 404 });
  assert.throws(() => getForm(token, null), { status: 404 });
});

test("permanent space deletion cleans records, references, grants and uploads without touching other content; rollback preserves files", () => {
  const f = fixture(),
    sid = f.space(),
    table = f.page(sid, "Source", "database"),
    other = f.page(f.sid, "Other", "database"),
    outside = f.page(f.sid, "Keep"),
    asset = file(table, f.owner),
    keep = file(outside, f.owner);
  const row = command(f.owner, {
    action: "row.create",
    pageId: table,
    cells: { title: "Deleted" },
  }) as { id: string };
  const db = database(other);
  command(f.owner, {
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
  const retained = command(f.owner, {
    action: "row.create",
    pageId: other,
    cells: { title: "Keep", rel: [row.id], note: row.id },
  }) as { id: string };
  const connected = database(other);
  command(f.owner, {
    action: "database.update",
    pageId: other,
    version: connected.version,
    fields: connected.fields,
    views: connected.views,
    relation: {
      fieldId: "rel",
      enabled: true,
      name: "Inverse",
      targetVersion: database(table).version,
    },
  });
  assert.equal(
    all(
      "SELECT * FROM two_way_relations WHERE left_page=? OR right_page=?",
      table,
      table,
    ).length,
    1,
  );
  run("UPDATE pages SET locked=1 WHERE id=?", other);
  run("UPDATE pages SET cover=? WHERE id=?", `/api/files/${asset.fid}`, table);
  const template = command(f.owner, {
    action: "template.save",
    pageId: table,
    name: "Independent template",
  }) as { id: string };
  run("INSERT INTO grants VALUES(?,?,?,?)", table, f.viewer.id, "", "viewer");
  assert.throws(() => spaceAction(f.owner, "space.purge", sid), {
    status: 409,
  });
  spaceAction(f.owner, "space.delete", sid);
  assert.throws(
    () =>
      transaction(() => {
        command(
          f.owner,
          {
            action: "space.purge",
            spaceId: sid,
            version: spaceData(sid).version,
            confirmName: "Area",
          },
          true,
        );
        throw Error("rollback");
      }, f.owner),
    /rollback/,
  );
  assert.ok(existsSync(asset.path));
  assert.ok(spaceData(sid));
  assert.equal(all("SELECT * FROM pending_file_deletions").length, 0);
  spaceAction(f.owner, "space.purge", sid);
  assert.equal(spaceData(sid), undefined);
  assert.equal(one("SELECT id FROM rows WHERE id=?", row.id), undefined);
  assert.equal(one("SELECT id FROM files WHERE id=?", asset.fid), undefined);
  assert.equal(existsSync(asset.path), false);
  assert.deepEqual(readFileSync(keep.path), keep.bytes);
  assert.equal(
    all(
      "SELECT * FROM two_way_relations WHERE left_page=? OR right_page=?",
      table,
      table,
    ).length,
    0,
  );
  assert.ok(one("SELECT id FROM templates WHERE id=?", template.id));
  assert.deepEqual(
    Buffer.from(
      one<{ data: Uint8Array }>(
        "SELECT data FROM template_files WHERE template_id=?",
        template.id,
      )!.data,
    ),
    asset.bytes,
  );

  assert.deepEqual(
    rows(other).find((r) => r.id === retained.id)!.cells.rel,
    [],
  );
  assert.equal(rows(other)[0].cells.note, row.id);
  assert.equal(
    all("SELECT * FROM grants WHERE resource_id=?", table).length,
    0,
  );
});

test("workspace deletion requires owner, exact name and another workspace; removes private data and all dependent metadata", () => {
  const f = fixture();
  assert.throws(() => spaceAction(f.owner, "space.delete", f.sid), {
    status: 409,
  });
  assert.throws(
    () =>
      command(f.owner, {
        action: "workspace.delete",
        workspaceId: f.wid,
        confirmName: "Lifecycle",
      }),
    { status: 409 },
  );
  const other = createWorkspace(f.owner.id, "Keep workspace"),
    privateArea = f.space(true, f.editor),
    root = f.page(privateArea, "Secret", "document", f.editor),
    asset = file(root, f.editor);
  const keepPage = one<{ id: string }>(
      "SELECT id FROM pages WHERE workspace_id=?",
      other,
    )!.id,
    keep = file(keepPage, f.owner);
  command(f.editor, {
    action: "template.save",
    pageId: root,
    name: "Private template",
    private: true,
  });
  command(f.owner, {
    action: "member.invite",
    workspaceId: f.wid,
    email: "invite@example.test",
    role: "editor",
  });
  command(f.owner, {
    action: "group.create",
    workspaceId: f.wid,
    name: "Group",
  });
  const gid = one<{ id: string }>(
    "SELECT id FROM groups WHERE workspace_id=?",
    f.wid,
  )!.id;
  command(f.owner, {
    action: "group.member",
    groupId: gid,
    userId: f.viewer.id,
    enabled: true,
  });
  command(f.owner, {
    action: "grant.set",
    resourceId: privateArea,
    groupId: gid,
    role: "viewer",
  });
  run("INSERT INTO presence VALUES(?,?,?)", root, f.editor.id, Date.now());
  run(
    "INSERT INTO notifications(id,user_id,page_id,body) VALUES(?,?,?,?)",
    id(),
    f.viewer.id,
    root,
    "Private",
  );
  for (const actor of [f.editor, f.viewer, f.stranger])
    assert.throws(
      () =>
        command(actor, {
          action: "workspace.delete",
          workspaceId: f.wid,
          confirmName: "Lifecycle",
        }),
      { status: 403 },
    );
  assert.throws(
    () =>
      command(f.owner, {
        action: "workspace.delete",
        workspaceId: f.wid,
        confirmName: "Old name",
      }),
    { status: 409 },
  );
  const result = command(f.owner, {
    action: "workspace.delete",
    workspaceId: f.wid,
    confirmName: "Lifecycle",
  }) as { nextWorkspaceId: string };
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
      all(
        `SELECT * FROM ${table} WHERE ${table === "workspaces" ? "id" : "workspace_id"}=?`,
        f.wid,
      ).length,
      0,
      table,
    );
  for (const table of ["presence", "notifications"])
    assert.equal(all(`SELECT * FROM ${table} WHERE page_id=?`, root).length, 0);
  assert.equal(
    all(
      "SELECT * FROM grants WHERE resource_id=? OR group_id=?",
      privateArea,
      gid,
    ).length,
    0,
  );
  assert.equal(existsSync(asset.path), false);
  assert.deepEqual(readFileSync(keep.path), keep.bytes);
  assert.ok(one("SELECT id FROM users WHERE id=?", f.editor.id));
  assert.equal(bootstrap(f.owner).workspace.id, other);
});

test("leaving transfers owned private areas explicitly and removes only this membership and its grants, groups and invitations", () => {
  const f = fixture(),
    sid = f.space(true),
    root = f.page(sid),
    other = createWorkspace(f.owner.id, "Other");
  assert.throws(
    () =>
      command(f.owner, {
        action: "workspace.leave",
        workspaceId: f.wid,
        confirmName: "Lifecycle",
      }),
    { status: 409 },
  );
  command(f.owner, {
    action: "member.role",
    workspaceId: f.wid,
    userId: f.editor.id,
    role: "owner",
  });
  run("UPDATE users SET disabled=1 WHERE id=?", f.editor.id);
  assert.throws(
    () =>
      command(f.owner, {
        action: "workspace.leave",
        workspaceId: f.wid,
        confirmName: "Lifecycle",
        transferTo: f.editor.id,
      }),
    { status: 409 },
  );
  run("UPDATE users SET disabled=0 WHERE id=?", f.editor.id);
  assert.throws(
    () =>
      command(f.owner, {
        action: "workspace.leave",
        workspaceId: f.wid,
        confirmName: "Lifecycle",
        transferTo: f.viewer.id,
      }),
    { status: 409 },
  );
  command(f.owner, {
    action: "group.create",
    workspaceId: f.wid,
    name: "Membership",
  });
  const gid = one<{ id: string }>(
    "SELECT id FROM groups WHERE workspace_id=?",
    f.wid,
  )!.id;
  run("INSERT INTO group_members VALUES(?,?)", gid, f.owner.id);
  run("INSERT INTO grants VALUES(?,?,?,?)", root, f.owner.id, "", "editor");
  command(f.owner, { action: "favorite", pageId: root, value: true });
  command(f.owner, {
    action: "member.invite",
    workspaceId: f.wid,
    email: f.owner.email,
    role: "editor",
  });
  const result = command(f.owner, {
    action: "workspace.leave",
    workspaceId: f.wid,
    confirmName: "Lifecycle",
    transferTo: f.editor.id,
  }) as { nextWorkspaceId: string };
  assert.equal(result.nextWorkspaceId, other);
  assert.equal(spaceData(sid).owner_id, f.editor.id);
  assert.equal(requirePage(f.editor, root).id, root);
  assert.throws(() => requirePage(f.owner, root), { status: 403 });
  assert.equal(
    all(
      "SELECT * FROM grants WHERE user_id=? AND resource_id=?",
      f.owner.id,
      root,
    ).length,
    0,
  );
  assert.equal(
    all(
      "SELECT * FROM group_members WHERE user_id=? AND group_id=?",
      f.owner.id,
      gid,
    ).length,
    0,
  );
  assert.equal(
    all(
      "SELECT * FROM favorites WHERE user_id=? AND page_id=?",
      f.owner.id,
      root,
    ).length,
    0,
  );
  assert.equal(
    all(
      "SELECT * FROM invites WHERE workspace_id=? AND email=?",
      f.wid,
      f.owner.email,
    ).length,
    0,
  );
  assert.ok(
    one(
      "SELECT * FROM members WHERE workspace_id=? AND user_id=?",
      other,
      f.owner.id,
    ),
  );
  const left = command(f.viewer, {
    action: "workspace.leave",
    workspaceId: f.wid,
    confirmName: "Lifecycle",
  }) as { nextWorkspaceId: null };
  assert.equal(left.nextWorkspaceId, null);
});

test("failed physical upload cleanup is durable and retries after commit without reporting a false database failure", () => {
  const f = fixture(),
    sid = f.space(),
    root = f.page(sid),
    asset = file(root, f.owner);
  rmSync(asset.path);
  mkdirSync(asset.path); // Reproduce an unlink failure without mocking application code.
  spaceAction(f.owner, "space.delete", sid);
  spaceAction(f.owner, "space.purge", sid);
  assert.ok(one("SELECT id FROM pending_file_deletions WHERE id=?", asset.fid));
  assert.equal(one("SELECT id FROM pages WHERE id=?", root), undefined);
  rmSync(asset.path, { recursive: true });
  writeFileSync(asset.path, asset.bytes);
  transaction(() => {});
  assert.equal(existsSync(asset.path), false);
  assert.equal(
    one("SELECT id FROM pending_file_deletions WHERE id=?", asset.fid),
    undefined,
  );
  const pending = Array.from({ length: 1001 }, () => ({ id: id(), path: "" }));
  transaction(() => {
    for (const item of pending) {
      item.path = join(process.env.FLOWPLAN_DATA_DIR!, "uploads", item.id);
      writeFileSync(item.path, "Queued test upload");
      run("INSERT INTO pending_file_deletions VALUES(?)", item.id);
    }
  });
  assert.equal(all("SELECT id FROM pending_file_deletions").length, 0);
  assert.ok(pending.every((item) => !existsSync(item.path)));
});
