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
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run(
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
const owner = await user("owner"),
  viewer = await user("viewer"),
  wid = await createWorkspace(owner.id, "Sharing"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
async function page(extra = {}) {
  return (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Shared",
      ...extra,
    })) as { id: string }
  ).id;
}
async function link(pageId: string, role = "viewer", includeChildren = false) {
  return (
    (await command(owner, {
      action: "share.create",
      pageId,
      role,
      includeChildren,
      name: role,
    })) as { token: string }
  ).token;
}
async function save(
  token: string,
  pageId: string,
  html = "<p>Changed</p>",
  extra = {},
) {
  const data = await sharedContent(token, pageId);
  return await mutateSharedContent(token, {
    action: "save",
    pageId,
    version: data.version,
    title: data.title,
    html,
    ...extra,
  });
}
async function fails(fn: () => unknown, status: number) {
  await assert.rejects(async () => fn(), (e: any) => e.status === status);
}

test("independent links enforce read, comment and edit rights, hide tokens and revoke immediately", async () => {
  const pid = await page(),
    read = await link(pid),
    comment = await link(pid, "commenter"),
    edit = await link(pid, "editor");
  assert.equal(new Set([read, comment, edit]).size, 3);
  assert.equal((await listShareLinks(owner, pid)).length, 3);
  assert.deepEqual((await pageData(viewer, pid)).shareLinks, []);
  await fails(async () => await listShareLinks(viewer, pid), 403);
  await fails(
    async () =>
      await command(viewer, {
        action: "share.create",
        pageId: pid,
        name: "Bad",
        role: "editor",
      }),
    403,
  );
  await fails(async () => await save(read, pid), 403);
  await fails(async () => await save(comment, pid), 403);
  await fails(
    async () =>
      await mutateSharedContent(read, {
        action: "comment",
        pageId: pid,
        name: "Guest",
        body: "No",
      }),
    403,
  );
  await run(
    "INSERT INTO comments(id,page_id,author_id,body) VALUES(?,?,?,?)",
    id(),
    pid,
    owner.id,
    "Private internal comment",
  );
  await mutateSharedContent(comment, {
    action: "comment",
    pageId: pid,
    name: "Guest",
    body: "Public feedback",
  });
  assert.equal((await sharedContent(read, pid)).comments.length, 1);
  assert.equal((await sharedContent(read, pid)).comments[0].body, "Public feedback");
  assert.equal((await pageData(owner, pid)).comments.length, 2);
  await save(
    edit,
    pid,
    "<p>Edited <strong>content</strong><script>alert(1)</script></p>",
  );
  assert.match(
    String((await one("SELECT html FROM documents WHERE page_id=?", pid))?.html),
    /Edited/,
  );
  assert.doesNotMatch((await sharedContent(read, pid)).html, /<script/);
  assert.equal((await all("SELECT * FROM snapshots WHERE page_id=?", pid)).length, 1);
  await command(owner, { action: "share.revoke", pageId: pid, token: edit });
  await fails(async () => await sharedContent(edit, pid), 404);
  await fails(async () => await save(edit, pid), 404);
  assert.equal((await sharedContent(read, pid)).role, "viewer");
  await mutateSharedContent(comment, {
    action: "comment",
    pageId: pid,
    name: "Guest",
    body: "Still allowed",
  });
});

test("guest edits enforce version, locks, selected subtree and file boundaries", async () => {
  const pid = await page(),
    child = await page({ parentId: pid }),
    other = await page(),
    token = await link(pid, "editor", true);
  const fresh = await sharedContent(token, pid);
  await save(token, pid);
  await fails(
    async () =>
      await mutateSharedContent(token, {
        action: "save",
        pageId: pid,
        version: fresh.version,
        title: "Stale",
        html: "<p>Stale</p>",
      }),
    409,
  );
  assert.equal((await publicPage(token, child)).page.id, child);
  const later = await page({ parentId: pid });
  await fails(async () => await publicPage(token, later), 404);
  await fails(async () => await save(token, other), 404);
  await run("UPDATE pages SET locked=1 WHERE id=?", pid);
  await fails(async () => await save(token, pid), 409);
  await run("UPDATE pages SET locked=0 WHERE id=?", pid);
  const fid = id(),
    hidden = id();
  for (const f of [fid, hidden])
    await run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      f,
      pid,
      "File",
      "text/plain",
      1,
      owner.id,
    );
  await run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p><a href="/api/files/${fid}">Allowed file</a></p>`,
    pid,
  );
  assert.equal((await publicFile(token, fid)).id, fid);
  await fails(async () => await publicFile(token, hidden), 404);
  await save(
    token,
    pid,
    `<p><a href="/api/share/${token}/files/${fid}">Still allowed</a></p>`,
  );
  assert.match(
    String((await one("SELECT html FROM documents WHERE page_id=?", pid))?.html),
    new RegExp(`/api/files/${fid}`),
  );
  await fails(
    async () =>
      await save(
        token,
        pid,
        `<p><a href="/api/files/${hidden}">Private file</a></p>`,
      ),
    403,
  );
  await fails(
    async () =>
      await save(
        token,
        pid,
        `<p><a href="/api/share/${token}/files/${hidden}">Hidden file</a></p>`,
      ),
    404,
  );
  await run("UPDATE pages SET parent_id=NULL WHERE id=?", child);
  await fails(async () => await publicPage(token, child), 404);
  await command(owner, { action: "page.delete", pageId: pid });
  await fails(async () => await publicPage(token), 404);
  await command(owner, { action: "page.restore", pageId: pid });
  await fails(async () => await publicPage(token), 404);
});

test("database guest edits preserve private fields and reject unauthorized row and field access", async () => {
  const pid = await page({ kind: "database" }),
    token = await link(pid, "editor"),
    other = await page({ kind: "database" });
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "secret", name: "Person", type: "person" },
    { id: "done", name: "Done", type: "checkbox" },
  ];
  await run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify(fields),
    pid,
  );
  const rowId = id(),
    otherRow = id();
  await run(
    "INSERT INTO rows(id,page_id,cells,content,created_by,updated_by) VALUES(?,?,?,?,?,?)",
    rowId,
    pid,
    JSON.stringify({ title: "Before", secret: owner.id, done: false }),
    "<p>Old details</p>",
    owner.id,
    owner.id,
  );
  await run(
    "INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)",
    otherRow,
    other,
    "{}",
    owner.id,
  );
  const data = await sharedContent(token, pid, rowId);
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
  await fails(
    async () =>
      await mutateSharedContent(token, { ...mutation, cells: { secret: viewer.id } }),
    403,
  );
  await mutateSharedContent(token, mutation);
  const row = (await one<{ cells: string; content: string; version: number }>(
    "SELECT * FROM rows WHERE id=?",
    rowId,
  ))!;
  assert.deepEqual(JSON.parse(row.cells), {
    title: "After",
    secret: owner.id,
    done: true,
  });
  assert.equal(row.content, "<p>New details</p>");
  assert.equal(row.version, 2);
  assert.equal(
    (await all("SELECT * FROM row_snapshots WHERE row_id=?", rowId)).length,
    1,
  );
  await fails(async () => await sharedContent(token, pid, otherRow), 404);
});

test("guests with edit links add records with public properties only", async () => {
  const pid = await page({ kind: "database" });
  await run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify([
      { id: "title", name: "Name", type: "text" },
      { id: "owner", name: "Person", type: "person" },
      { id: "done", name: "Erledigt", type: "checkbox" },
    ]),
    pid,
  );
  const editor = await link(pid, "editor"),
    commenter = await link(pid, "commenter");
  assert.equal((await sharedContent(editor, pid)).titleField, "title");
  const create = async (token: string, cells: Record<string, unknown>) =>
    (await mutateSharedContent(token, { action: "create", pageId: pid, cells })) as {
      createdRowId?: string;
    };
  await fails(async () => await create(commenter, { title: "Nein" }), 403);
  await fails(async () => await create(editor, { owner: owner.id }), 403);
  const rid = (await create(editor, { title: "Gastidee", done: true })).createdRowId!;
  const row = (await one<{ cells: string; created_by: string | null }>(
    "SELECT cells,created_by FROM rows WHERE id=? AND page_id=?",
    rid,
    pid,
  ))!;
  assert.deepEqual(JSON.parse(row.cells), { title: "Gastidee", done: true });
  assert.equal(row.created_by, null);
  // The new record can be edited through the same link.
  assert.equal((await sharedContent(editor, pid, rid)).cells.title, "Gastidee");
  await run("UPDATE pages SET locked=1 WHERE id=?", pid);
  await fails(async () => await create(editor, { title: "Gesperrt" }), 409);
});

test("guest uploads are checked, readable only through their link until used, and cleaned up", async () => {
  const { guestUpload, purgeUnusedGuestUploads } =
    await import("../lib/shared-uploads");
  const pid = await page(),
    editor = await link(pid, "editor"),
    reader = await link(pid, "viewer");
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
  assert.equal((await publicFile(editor, fid)).id, fid);
  await fails(async () => await publicFile(reader, fid), 404);
  await save(editor, pid, `<p><img src="${uploaded.url}" alt="bild.png"></p>`);
  assert.match(
    String((await one("SELECT html FROM documents WHERE page_id=?", pid))?.html),
    new RegExp(`/api/files/${fid}`),
  );
  assert.equal((await publicFile(reader, fid)).id, fid);
  // Uploads draw on the link's daily budget, whatever the workspace quota.
  const { anonymousBytesToday } = await import("../lib/anonymous-budget");
  assert.ok((await anonymousBytesToday(`share:${editor}`)) > 0);
  await run("INSERT INTO anonymous_uploads(scope,bytes,at) VALUES(?,?,?)", `share:${editor}`, 200 * 1024 * 1024, Date.now());
  await rejects(guestUpload(editor, pid, png), 413);
  await run("DELETE FROM anonymous_uploads WHERE scope=?", `share:${editor}`);
  // And on a count per ten minutes.
  const { GUEST_UPLOADS_PER_10_MIN } = await import("../lib/shared-uploads");
  const fillers: string[] = [];
  for (let i = 0; i < GUEST_UPLOADS_PER_10_MIN; i++) {
    const filler = id();
    fillers.push(filler);
    await run("INSERT INTO files(id,page_id,name,mime,size) VALUES(?,?,?,?,?)", filler, pid, "f.png", "image/png", 1);
    await run("INSERT INTO share_uploads(file_id,token,created_at) VALUES(?,?,?)", filler, editor, Date.now());
  }
  await rejects(guestUpload(editor, pid, png), 429);
  for (const filler of fillers) await run("DELETE FROM files WHERE id=?", filler);
  // After a day: used uploads stay, unused ones are removed.
  const unused = await guestUpload(editor, pid, png);
  const unusedId = unused.url.split("/").pop()!;
  await purgeUnusedGuestUploads(Date.now() + 2 * 86400000);
  assert.ok(await one("SELECT 1 FROM files WHERE id=?", fid));
  assert.equal(await one("SELECT 1 FROM files WHERE id=?", unusedId), undefined);
  assert.equal(
    await one("SELECT 1 FROM share_uploads WHERE file_id=?", fid),
    undefined,
  );
});

test("public pages render linked views of published databases with public properties only", async () => {
  const { withPublicEmbeds } = await import("../lib/public-embeds");
  const { publishedHtml } = await import("../lib/publication");
  const { escaped } = await import("../lib/document-server");
  const host = await page(),
    inside = await page({ kind: "database", parentId: host }),
    outside = await page({ kind: "database" });
  for (const db of [inside, outside])
    await run(
      "UPDATE databases SET fields=? WHERE page_id=?",
      JSON.stringify([
        { id: "title", name: "Name", type: "text" },
        { id: "owner", name: "Person", type: "person" },
        { id: "done", name: "Erledigt", type: "checkbox" },
      ]),
      db,
    );
  await run(
    "INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)",
    id(),
    inside,
    JSON.stringify({
      title: "Sichtbar & <b>sicher</b>",
      owner: owner.id,
      done: true,
    }),
    owner.id,
  );
  const views = JSON.stringify([
    { id: id(), name: "Alle", type: "table", filters: [], sorts: [] },
  ]);
  const block = (source: string, blockId = id()) =>
    `<div data-linked-database="${blockId}" data-linked-source="${source}" data-linked-version="1" data-linked-views="${escaped(views)}">Platzhalter</div>`;
  const html = `<p>Start</p>${block(inside)}${block(outside)}`;
  await run("UPDATE documents SET html=? WHERE page_id=?", html, host);
  await command(owner, {
    action: "page.publish",
    pageId: host,
    enabled: true,
    includeChildren: true,
  });
  const token = (await one<{ public_token: string }>(
    "SELECT public_token FROM pages WHERE id=?",
    host,
  ))!.public_token;
  const { pages } = await publicPage(token);
  const rendered = await withPublicEmbeds(
    await publishedHtml(html, token, pages),
    html,
    token,
    pages,
  );
  assert.match(rendered, /class="public-embed"/);
  assert.match(rendered, /Sichtbar &amp; &lt;b&gt;sicher&lt;\/b&gt;/);
  assert.match(rendered, new RegExp(`/share/${token}/${inside}\\?row=`));
  assert.match(rendered, /<th>Erledigt<\/th>/);
  // People stay private; the outside source keeps its placeholder.
  assert.doesNotMatch(rendered, /<th>Person<\/th>|owner/);
  assert.equal((rendered.match(/class="public-embed"/g) || []).length, 1);
  assert.match(rendered, /Platzhalter/);
});

test("guests edit relations into shared databases, files and single properties", async () => {
  const { guestUpload } = await import("../lib/shared-uploads");
  const host = await page(),
    tasks = await page({ kind: "database", parentId: host }),
    people = await page({ kind: "database", parentId: host }),
    hidden = await page({ kind: "database" });
  await run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify([
      { id: "title", name: "Name", type: "text" },
      { id: "who", name: "Beteiligte", type: "relation", relationPage: people },
      { id: "secret", name: "Intern", type: "relation", relationPage: hidden },
      { id: "docs", name: "Dateien", type: "files" },
      { id: "due", name: "Fällig", type: "date" },
    ]),
    tasks,
  );
  const ada = id(),
    foreign = id(),
    task = id();
  await run(
    "INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)",
    ada,
    people,
    JSON.stringify({ title: "Ada" }),
    owner.id,
  );
  await run(
    "INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)",
    foreign,
    hidden,
    JSON.stringify({ title: "Geheim" }),
    owner.id,
  );
  await run(
    "INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)",
    task,
    tasks,
    JSON.stringify({ title: "Aufgabe", secret: [foreign], due: "2026-09-01" }),
    owner.id,
  );
  const editor = await link(host, "editor", true),
    reader = await link(host, "viewer", true);
  const data = await sharedContent(editor, tasks, task);
  // Relations into databases outside the share stay hidden.
  assert.deepEqual(
    data.fields.map((f) => f.id),
    ["title", "who", "docs", "due"],
  );
  assert.deepEqual(data.related[people], [
    { id: ada, cells: { title: "Ada" } },
  ]);
  assert.equal(data.related[hidden], undefined);
  const cells = async (patch: Record<string, unknown>, token = editor) =>
    await mutateSharedContent(token, {
      action: "cells",
      pageId: tasks,
      rowId: task,
      version: (await sharedContent(editor, tasks, task)).version,
      cells: patch,
    });
  await fails(async () => await cells({ due: "2026-09-02" }, reader), 403);
  await fails(async () => await cells({ secret: [] }), 403);
  await fails(async () => await cells({ who: [foreign] }), 400);
  await cells({ who: [ada], due: "2026-09-03" });
  // Stale versions are rejected.
  await fails(
    async () =>
      await mutateSharedContent(editor, {
        action: "cells",
        pageId: tasks,
        rowId: task,
        version: data.version,
        cells: { due: "2026-09-04" },
      }),
    409,
  );
  // Uploads of this link become files of the record, foreign files do not.
  const upload = await guestUpload(
    editor,
    tasks,
    new File(["Protokoll"], "notiz.txt", { type: "text/plain" }),
  );
  const fid = upload.url.split("/").pop()!;
  await fails(async () => await cells({ docs: ["/api/files/" + id()] }), 400);
  await cells({ docs: [upload.url, "https://example.com/plan.pdf"] });
  const row = JSON.parse(
    String((await one("SELECT cells FROM rows WHERE id=?", task))?.cells),
  );
  assert.deepEqual(row.who, [ada]);
  assert.deepEqual(row.secret, [foreign]);
  assert.equal(row.due, "2026-09-03");
  assert.deepEqual(row.docs, [
    `/api/files/${fid}`,
    "https://example.com/plan.pdf",
  ]);
  // The attached file is now readable through every link of the share.
  assert.equal((await publicFile(reader, fid)).id, fid);
  assert.deepEqual((await sharedContent(reader, tasks, task)).cells.docs, [
    `/api/share/${reader}/files/${fid}`,
    "https://example.com/plan.pdf",
  ]);
});

test("a guest save keeps PDF blocks, also of files the guest cannot see", async () => {
  const pid = await page(),
    elsewhere = await page(),
    token = await link(pid, "editor");
  const shown = id(),
    hidden = id();
  for (const [fid, on] of [[shown, pid], [hidden, elsewhere]])
    await run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      fid,
      on,
      "plan.pdf",
      "application/pdf",
      1,
      owner.id,
    );
  const pdf = (fid: string) => `<div data-pdf="/api/files/${fid}" data-title="Plan" class="pdf-block"><a href="/api/files/${fid}">Plan</a></div>`;
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p>Text</p>${pdf(shown)}${pdf(hidden)}`, pid);
  const data = await sharedContent(token, pid);
  // The guest sees the visible PDF through the link, the other one only as a placeholder.
  assert.match(data.html, new RegExp(`data-pdf="/api/share/${token}/files/${shown}"`));
  assert.doesNotMatch(data.html, new RegExp(hidden));
  assert.match(data.html, new RegExp(`data-pdf="/share/${token}/hidden/[0-9a-f]+"`));
  await save(token, pid, data.html.replace("<p>Text</p>", "<p>Text, edited</p>"));
  const stored = String((await one("SELECT html FROM documents WHERE page_id=?", pid))?.html);
  assert.match(stored, /Text, edited/);
  assert.match(stored, new RegExp(`data-pdf="/api/files/${shown}"`));
  assert.match(stored, new RegExp(`data-pdf="/api/files/${hidden}"`));
  assert.doesNotMatch(stored, /\/hidden\//);
  assert.doesNotMatch(stored, /\/api\/share\//);
  // A guest cannot point a PDF block at a file outside the link.
  const other = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", other, elsewhere, "x.pdf", "application/pdf", 1, owner.id);
  await fails(async () => await save(token, pid, `<div data-pdf="/api/files/${other}" class="pdf-block"></div>`), 403);
});
