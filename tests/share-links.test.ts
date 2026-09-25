import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-share-links-"),
);
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { sharedContent, mutateSharedContent } =
  await import("../lib/shared-content");
const { publicPage, publicFile } = await import("../lib/publication");
const { listShareLinks } = await import("../lib/share-links");
function user(name: string): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.com`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.com`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  viewer = user("viewer"),
  wid = createWorkspace(owner.id, "Sharing"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
function page(extra = {}) {
  return (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Shared",
      ...extra,
    }) as { id: string }
  ).id;
}
function link(pageId: string, role = "viewer", includeChildren = false) {
  return (
    command(owner, {
      action: "share.create",
      pageId,
      role,
      includeChildren,
      name: role,
    }) as { token: string }
  ).token;
}
function save(
  token: string,
  pageId: string,
  html = "<p>Changed</p>",
  extra = {},
) {
  const data = sharedContent(token, pageId);
  return mutateSharedContent(token, {
    action: "save",
    pageId,
    version: data.version,
    title: data.title,
    html,
    ...extra,
  });
}
function fails(fn: () => unknown, status: number) {
  assert.throws(fn, (e: any) => e.status === status);
}

test("independent links enforce read, comment and edit rights, hide tokens and revoke immediately", () => {
  const pid = page(),
    read = link(pid),
    comment = link(pid, "commenter"),
    edit = link(pid, "editor");
  assert.equal(new Set([read, comment, edit]).size, 3);
  assert.equal(listShareLinks(owner, pid).length, 3);
  assert.deepEqual(pageData(viewer, pid).shareLinks, []);
  fails(() => listShareLinks(viewer, pid), 403);
  fails(
    () =>
      command(viewer, {
        action: "share.create",
        pageId: pid,
        name: "Bad",
        role: "editor",
      }),
    403,
  );
  fails(() => save(read, pid), 403);
  fails(() => save(comment, pid), 403);
  fails(
    () =>
      mutateSharedContent(read, {
        action: "comment",
        pageId: pid,
        name: "Guest",
        body: "No",
      }),
    403,
  );
  run(
    "INSERT INTO comments(id,page_id,author_id,body) VALUES(?,?,?,?)",
    id(),
    pid,
    owner.id,
    "Private internal comment",
  );
  mutateSharedContent(comment, {
    action: "comment",
    pageId: pid,
    name: "Guest",
    body: "Public feedback",
  });
  assert.equal(sharedContent(read, pid).comments.length, 1);
  assert.equal(sharedContent(read, pid).comments[0].body, "Public feedback");
  assert.equal(pageData(owner, pid).comments.length, 2);
  save(
    edit,
    pid,
    "<p>Edited <strong>content</strong><script>alert(1)</script></p>",
  );
  assert.match(
    String(one("SELECT html FROM documents WHERE page_id=?", pid)?.html),
    /Edited/,
  );
  assert.doesNotMatch(sharedContent(read, pid).html, /<script/);
  assert.equal(all("SELECT * FROM snapshots WHERE page_id=?", pid).length, 1);
  command(owner, { action: "share.revoke", pageId: pid, token: edit });
  fails(() => sharedContent(edit, pid), 404);
  fails(() => save(edit, pid), 404);
  assert.equal(sharedContent(read, pid).role, "viewer");
  mutateSharedContent(comment, {
    action: "comment",
    pageId: pid,
    name: "Guest",
    body: "Still allowed",
  });
});

test("guest edits enforce version, locks, selected subtree and file boundaries", () => {
  const pid = page(),
    child = page({ parentId: pid }),
    other = page(),
    token = link(pid, "editor", true);
  const fresh = sharedContent(token, pid);
  save(token, pid);
  fails(
    () =>
      mutateSharedContent(token, {
        action: "save",
        pageId: pid,
        version: fresh.version,
        title: "Stale",
        html: "<p>Stale</p>",
      }),
    409,
  );
  assert.equal(publicPage(token, child).page.id, child);
  const later = page({ parentId: pid });
  fails(() => publicPage(token, later), 404);
  fails(() => save(token, other), 404);
  run("UPDATE pages SET locked=1 WHERE id=?", pid);
  fails(() => save(token, pid), 409);
  run("UPDATE pages SET locked=0 WHERE id=?", pid);
  const fid = id(),
    hidden = id();
  for (const f of [fid, hidden])
    run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      f,
      pid,
      "File",
      "text/plain",
      1,
      owner.id,
    );
  run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p><a href="/api/files/${fid}">Allowed file</a></p>`,
    pid,
  );
  assert.equal(publicFile(token, fid).id, fid);
  fails(() => publicFile(token, hidden), 404);
  save(
    token,
    pid,
    `<p><a href="/api/share/${token}/files/${fid}">Still allowed</a></p>`,
  );
  assert.match(
    String(one("SELECT html FROM documents WHERE page_id=?", pid)?.html),
    new RegExp(`/api/files/${fid}`),
  );
  fails(
    () =>
      save(
        token,
        pid,
        `<p><a href="/api/files/${hidden}">Private file</a></p>`,
      ),
    403,
  );
  fails(
    () =>
      save(
        token,
        pid,
        `<p><a href="/api/share/${token}/files/${hidden}">Hidden file</a></p>`,
      ),
    404,
  );
  run("UPDATE pages SET parent_id=NULL WHERE id=?", child);
  fails(() => publicPage(token, child), 404);
  command(owner, { action: "page.delete", pageId: pid });
  fails(() => publicPage(token), 404);
  command(owner, { action: "page.restore", pageId: pid });
  fails(() => publicPage(token), 404);
});

test("database guest edits preserve private fields and reject unauthorized row and field access", () => {
  const pid = page({ kind: "database" }),
    token = link(pid, "editor"),
    other = page({ kind: "database" });
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "secret", name: "Person", type: "person" },
    { id: "done", name: "Done", type: "checkbox" },
  ];
  run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify(fields),
    pid,
  );
  const rowId = id(),
    otherRow = id();
  run(
    "INSERT INTO rows(id,page_id,cells,content,created_by,updated_by) VALUES(?,?,?,?,?,?)",
    rowId,
    pid,
    JSON.stringify({ title: "Before", secret: owner.id, done: false }),
    "<p>Old details</p>",
    owner.id,
    owner.id,
  );
  run(
    "INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)",
    otherRow,
    other,
    "{}",
    owner.id,
  );
  const data = sharedContent(token, pid, rowId);
  assert.equal(data.cells.secret, undefined);
  assert.ok(!data.fields.some((f) => f.id === "secret"));
  const mutation = {
    action: "save",
    pageId: pid,
    rowId,
    version: data.version,
    title: data.title,
    html: "<p>New details</p>",
    cells: { title: "After", done: true },
  };
  fails(
    () =>
      mutateSharedContent(token, { ...mutation, cells: { secret: viewer.id } }),
    403,
  );
  mutateSharedContent(token, mutation);
  const row = one<{ cells: string; content: string; version: number }>(
    "SELECT * FROM rows WHERE id=?",
    rowId,
  )!;
  assert.deepEqual(JSON.parse(row.cells), {
    title: "After",
    secret: owner.id,
    done: true,
  });
  assert.equal(row.content, "<p>New details</p>");
  assert.equal(row.version, 2);
  assert.equal(
    all("SELECT * FROM row_snapshots WHERE row_id=?", rowId).length,
    1,
  );
  fails(() => sharedContent(token, pid, otherRow), 404);
});

test("guests with edit links add records with public properties only", () => {
  const pid = page({ kind: "database" });
  run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify([
      { id: "title", name: "Name", type: "text" },
      { id: "owner", name: "Person", type: "person" },
      { id: "done", name: "Erledigt", type: "checkbox" },
    ]),
    pid,
  );
  const editor = link(pid, "editor"),
    commenter = link(pid, "commenter");
  assert.equal(sharedContent(editor, pid).titleField, "title");
  const create = (token: string, cells: Record<string, unknown>) =>
    mutateSharedContent(token, { action: "create", pageId: pid, cells }) as {
      createdRowId?: string;
    };
  fails(() => create(commenter, { title: "Nein" }), 403);
  fails(() => create(editor, { owner: owner.id }), 403);
  const rid = create(editor, { title: "Gastidee", done: true }).createdRowId!;
  const row = one<{ cells: string; created_by: string | null }>(
    "SELECT cells,created_by FROM rows WHERE id=? AND page_id=?",
    rid,
    pid,
  )!;
  assert.deepEqual(JSON.parse(row.cells), { title: "Gastidee", done: true });
  assert.equal(row.created_by, null);
  // The new record can be edited through the same link.
  assert.equal(sharedContent(editor, pid, rid).cells.title, "Gastidee");
  run("UPDATE pages SET locked=1 WHERE id=?", pid);
  fails(() => create(editor, { title: "Gesperrt" }), 409);
});

test("guest uploads are checked, readable only through their link until used, and cleaned up", async () => {
  const { guestUpload, purgeUnusedGuestUploads } =
    await import("../lib/shared-uploads");
  const pid = page(),
    editor = link(pid, "editor"),
    reader = link(pid, "viewer");
  const png = new File(
    [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    ],
    "bild.png",
    { type: "image/png" },
  );
  const rejects = (p: Promise<unknown>, status: number) =>
    assert.rejects(p, (e: any) => e.status === status);
  await rejects(guestUpload(reader, pid, png), 403);
  await rejects(
    guestUpload(
      editor,
      pid,
      new File(["<script>"], "x.html", { type: "text/html" }),
    ),
    415,
  );
  await rejects(
    guestUpload(
      editor,
      pid,
      new File(["nope"], "x.png", { type: "image/png" }),
    ),
    415,
  );
  const uploaded = await guestUpload(editor, pid, png);
  const fid = uploaded.url.split("/").pop()!;
  assert.equal(uploaded.url, `/api/share/${editor}/files/${fid}`);
  // Only the uploading link reads the unused file.
  assert.equal(publicFile(editor, fid).id, fid);
  fails(() => publicFile(reader, fid), 404);
  save(editor, pid, `<p><img src="${uploaded.url}" alt="bild.png"></p>`);
  assert.match(
    String(one("SELECT html FROM documents WHERE page_id=?", pid)?.html),
    new RegExp(`/api/files/${fid}`),
  );
  assert.equal(publicFile(reader, fid).id, fid);
  // After a day: used uploads stay, unused ones are removed.
  const unused = await guestUpload(editor, pid, png);
  const unusedId = unused.url.split("/").pop()!;
  purgeUnusedGuestUploads(Date.now() + 2 * 86400000);
  assert.ok(one("SELECT 1 FROM files WHERE id=?", fid));
  assert.equal(one("SELECT 1 FROM files WHERE id=?", unusedId), undefined);
  assert.equal(
    one("SELECT 1 FROM share_uploads WHERE file_id=?", fid),
    undefined,
  );
});
