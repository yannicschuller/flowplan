import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tests-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { requirePage, requireAdmin } = await import("../lib/permissions");
const { extractGroups, identityFromToken, hash } = await import("../lib/auth");
const { formula, queryRows } = await import("../lib/database");
const { htmlState, stateHtml, cleanHtml } =
  await import("../lib/document-server");
import type { Identity, Page, Row, Field, View } from "../lib/types";
function user(name: string, groups: string[] = []): Identity {
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
    groups,
    isAdmin: groups.includes("flowplan-admins"),
  };
}
const owner = user("owner"),
  editor = user("editor"),
  viewer = user("viewer"),
  stranger = user("stranger");
const wid = createWorkspace(owner.id, "Test", true);
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const boot = bootstrap(owner, wid),
  page = boot.pages.find((p) => p.kind === "document")!,
  database = boot.pages.find((p) => p.kind === "database")!;
test("workspace and page access does not leak across users", () => {
  assert.throws(() => requirePage(stranger, page.id), /Berechtigung/);
  assert.equal(requirePage(viewer, page.id).id, page.id);
  assert.throws(
    () =>
      command(viewer, {
        action: "page.update",
        pageId: page.id,
        patch: { title: "attack" },
      }),
    /Berechtigung/,
  );
  assert.equal(
    one<Page>("SELECT * FROM pages WHERE id=?", page.id)?.title,
    page.title,
  );
});
test("private spaces and explicit grants are enforced", () => {
  const space = command(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  }) as { id: string };
  const p = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: space.id,
    title: "Secret",
  }) as { id: string };
  assert.throws(() => requirePage(editor, p.id), /Berechtigung/);
  command(owner, {
    action: "grant.set",
    resourceId: p.id,
    userId: editor.id,
    role: "viewer",
  });
  assert.equal(requirePage(editor, p.id).id, p.id);
  assert.throws(() => requirePage(editor, p.id, true), /Berechtigung/);
  assert.throws(() => bootstrap(stranger), /Arbeitsbereich/);
});
test("admin requires exact verified group, never a substring", () => {
  assert.throws(() => requireAdmin(owner), /Gruppe/);
  assert.throws(
    () => requireAdmin(user("fake", ["not-flowplan-admins"])),
    /Gruppe/,
  );
  assert.doesNotThrow(() => requireAdmin(user("admin", ["flowplan-admins"])));
  assert.deepEqual(extractGroups({ groups: ["x", 3, "flowplan-admins"] }), [
    "x",
    "flowplan-admins",
  ]);
});
test("expired and disabled sessions are rejected", () => {
  const token = "test-secret";
  run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    hash(token),
    owner.id,
    "[]",
    Date.now() + 10000,
  );
  assert.equal(identityFromToken(token)?.id, owner.id);
  run("UPDATE users SET disabled=1 WHERE id=?", owner.id);
  assert.equal(identityFromToken(token), null);
  run("UPDATE users SET disabled=0 WHERE id=?", owner.id);
  run(
    "UPDATE sessions SET expires=? WHERE token=?",
    Date.now() - 1,
    hash(token),
  );
  assert.equal(identityFromToken(token), null);
});
test("last owner cannot be removed and trees cannot become cyclic", () => {
  assert.throws(
    () =>
      command(owner, {
        action: "member.role",
        workspaceId: wid,
        userId: owner.id,
        role: "remove",
      }),
    /Eigentümer/,
  );
  const child = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    parentId: page.id,
    title: "Child",
  }) as { id: string };
  assert.throws(
    () =>
      command(owner, {
        action: "page.move",
        pageId: page.id,
        parentId: child.id,
      }),
    /Verschieben/,
  );
});
test("trash removes publications and restores descendants", () => {
  command(owner, { action: "page.publish", pageId: page.id, enabled: true });
  command(owner, { action: "page.delete", pageId: page.id });
  assert.throws(() => requirePage(owner, page.id), /gefunden/);
  assert.equal(
    one<Page>("SELECT * FROM pages WHERE id=?", page.id)?.public_token,
    null,
  );
  command(owner, { action: "page.restore", pageId: page.id });
  assert.equal(requirePage(owner, page.id).deleted_at, null);
});
test("row version guards prevent lost updates", () => {
  const r = command(editor, {
    action: "row.create",
    pageId: database.id,
    cells: { title: "A" },
  }) as { id: string };
  command(editor, {
    action: "row.update",
    pageId: database.id,
    rowId: r.id,
    version: 1,
    cells: { title: "B" },
  });
  assert.throws(
    () =>
      command(owner, {
        action: "row.update",
        pageId: database.id,
        rowId: r.id,
        version: 1,
        cells: { title: "C" },
      }),
    /geändert/,
  );
  assert.equal(
    JSON.parse(
      one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", r.id)!.cells,
    ).title,
    "B",
  );
});
test("formulas evaluate data without executing JavaScript", () => {
  assert.equal(formula('prop("Hours") * 2 + 1', { Hours: 4 }), 9);
  assert.equal(formula('if(prop("done"), "yes", "no")', { done: true }), "yes");
  assert.equal(formula("round(10 / 3, 2)", {}), 3.33);
  assert.equal(formula("globalThis.process.exit()", {}), "#ERROR");
  assert.equal(formula("1 / 0", {}), "#DIV/0");
});
test("filters and numeric sorting operate on formula results", () => {
  const fields: Field[] = [
    { id: "n", name: "n", type: "number" },
    { id: "double", name: "Double", type: "formula", formula: "n * 2" },
  ];
  const rows = [1, 10, 3].map(
    (n, i) => ({ id: String(i), cells: { n }, position: i }) as unknown as Row,
  );
  const view: View = {
    id: "v",
    name: "view",
    type: "table",
    filters: [{ field: "double", op: "gt", value: "5" }],
    sorts: [{ field: "double", direction: "desc" }],
  };
  assert.deepEqual(
    queryRows(rows, fields, view).map((r) => r.cells.double),
    [20, 6],
  );
});
test("Yjs merges independent edits and persists canonical HTML", () => {
  const state = htmlState("<p>Start</p>"),
    a = new Y.Doc(),
    b = new Y.Doc();
  Y.applyUpdate(a, state);
  Y.applyUpdate(b, state);
  const textA = (a.getXmlFragment("default").get(0) as Y.XmlElement).get(
    0,
  ) as Y.XmlText;
  const textB = (b.getXmlFragment("default").get(0) as Y.XmlElement).get(
    0,
  ) as Y.XmlText;
  textA.insert(0, "A ");
  textB.insert(5, " B");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.equal(stateHtml(a), stateHtml(b));
  assert.match(stateHtml(a), /A Start B/);
  const pd = pageData(owner, page.id) as { generation: string };
  command(owner, {
    action: "document.sync",
    pageId: page.id,
    generation: pd.generation,
    update: Buffer.from(state).toString("base64"),
    html: "<script>attack</script>",
  });
  assert.ok(
    !one<{ html: string }>(
      "SELECT html FROM documents WHERE page_id=?",
      page.id,
    )?.html.includes("script"),
  );
  a.destroy();
  b.destroy();
});
test("public HTML sanitization blocks scripts, event handlers, unsafe URLs", () => {
  const html = cleanHtml(
    '<script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">bad</a><iframe src="https://evil.test"></iframe><p>safe</p>',
  );
  assert.ok(!html.includes("script"));
  assert.ok(!html.includes("onerror"));
  assert.ok(!html.includes("iframe"));
  assert.ok(html.includes("<p>safe</p>"));
});
test("restoring a version rejects stale collaboration generations", () => {
  command(owner, { action: "page.snapshot", pageId: page.id });
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    page.id,
  )!;
  const prior = pageData(owner, page.id) as { generation: string };
  command(owner, {
    action: "snapshot.restore",
    pageId: page.id,
    snapshotId: snapshot.id,
  });
  assert.throws(
    () =>
      command(owner, {
        action: "document.sync",
        pageId: page.id,
        generation: prior.generation,
        update: Buffer.from(htmlState("<p>stale</p>")).toString("base64"),
      }),
    /Dokumentversion/,
  );
});

test("record documents retain rich content and enforce database permissions", async () => {
  const { rowDocumentData } = await import("../lib/row-documents");
  const r = command(owner, {
    action: "row.create",
    pageId: database.id,
    cells: { title: "Rich row" },
    templateId: null,
  }) as { id: string };
  const initial = rowDocumentData(owner, database.id, r.id);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(initial.state, "base64"));
  Y.applyUpdate(doc, htmlState("<h2>A complete record document</h2>"));
  command(owner, {
    action: "row.document.sync",
    pageId: database.id,
    rowId: r.id,
    generation: initial.generation,
    update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
  });
  assert.match(
    rowDocumentData(viewer, database.id, r.id).html,
    /<h2[^>]*>A complete record document<\/h2>/,
  );
  assert.throws(
    () => rowDocumentData(stranger, database.id, r.id),
    /Berechtigung/,
  );
  assert.throws(
    () =>
      command(viewer, {
        action: "row.document.sync",
        pageId: database.id,
        rowId: r.id,
        generation: initial.generation,
        update: initial.state,
      }),
    /Berechtigung/,
  );
  assert.throws(() => rowDocumentData(owner, page.id, r.id), /Datenbank/);
  const snap = command(owner, {
    action: "row.snapshot",
    pageId: database.id,
    rowId: r.id,
  }) as { id: string };
  command(owner, {
    action: "row.snapshot.restore",
    pageId: database.id,
    rowId: r.id,
    snapshotId: snap.id,
  });
  assert.notEqual(
    rowDocumentData(owner, database.id, r.id).generation,
    initial.generation,
  );
  assert.throws(
    () =>
      command(owner, {
        action: "row.document.sync",
        pageId: database.id,
        rowId: r.id,
        generation: initial.generation,
        update: initial.state,
      }),
    /Dokumentversion/,
  );
  command(owner, { action: "row.delete", pageId: database.id, rowId: r.id });
  assert.equal(
    one("SELECT row_id FROM row_documents WHERE row_id=?", r.id),
    undefined,
  );
  doc.destroy();
});
test("record templates clone properties, relations and rich documents with independent CRDT identities", async () => {
  const { rowDocumentData, replaceRowDocument } =
    await import("../lib/row-documents");
  const original = command(owner, {
    action: "row.create",
    pageId: database.id,
    templateId: null,
    cells: {
      title: "Template source",
      status: "In Arbeit",
      link: ["related-id"],
    },
  }) as { id: string };
  replaceRowDocument(
    original.id,
    "<h2>Briefing</h2><ul><li><p>Deliverable</p></li></ul>",
    owner.id,
  );
  const template = command(owner, {
    action: "row.template.save",
    pageId: database.id,
    rowId: original.id,
    name: "Project briefing",
  }) as { id: string };
  command(owner, {
    action: "row.template.default",
    pageId: database.id,
    templateId: template.id,
    enabled: true,
  });
  const copy = command(editor, {
    action: "row.create",
    pageId: database.id,
    cells: { title: "New project" },
  }) as { id: string };
  const copied = one<{ cells: string }>(
    "SELECT cells FROM rows WHERE id=?",
    copy.id,
  )!;
  assert.deepEqual(JSON.parse(copied.cells), {
    title: "New project",
    status: "In Arbeit",
    link: ["related-id"],
  });
  assert.match(
    rowDocumentData(editor, database.id, copy.id).html,
    /<h2[^>]*>Briefing/,
  );
  assert.notEqual(
    rowDocumentData(editor, database.id, copy.id).state,
    rowDocumentData(owner, database.id, original.id).state,
  );
  const other = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Other database",
    kind: "database",
  }) as { id: string };
  assert.throws(
    () =>
      command(owner, {
        action: "row.create",
        pageId: other.id,
        templateId: template.id,
      }),
    /vorlage/,
  );
  assert.throws(
    () =>
      command(viewer, {
        action: "row.template.delete",
        pageId: database.id,
        templateId: template.id,
      }),
    /Berechtigung/,
  );
  command(owner, {
    action: "row.template.delete",
    pageId: database.id,
    templateId: template.id,
  });
});

test("recursive page copies preserve children, rich row content and internal relations without sharing CRDT IDs", async () => {
  const { replaceRowDocument, rowDocumentData } =
    await import("../lib/row-documents");
  const root = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Project wiki",
  }) as { id: string };
  const child = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    parentId: root.id,
    title: "Child tasks",
    kind: "database",
  }) as { id: string };
  const first = command(owner, {
    action: "row.create",
    pageId: child.id,
    templateId: null,
    cells: { title: "First" },
  }) as { id: string };
  const second = command(owner, {
    action: "row.create",
    pageId: child.id,
    templateId: null,
    cells: { title: "Second", relation: [first.id] },
  }) as { id: string };
  replaceRowDocument(first.id, "<h2>Detailed record</h2>", owner.id);
  const raw = one<{ fields: string; views: string; version: number }>(
    "SELECT * FROM databases WHERE page_id=?",
    child.id,
  )!;
  command(owner, {
    action: "database.update",
    pageId: child.id,
    version: raw.version,
    fields: [
      ...JSON.parse(raw.fields),
      {
        id: "relation",
        name: "Related",
        type: "relation",
        relationPage: child.id,
      },
    ],
    views: JSON.parse(raw.views),
  });
  const html = `<p><a href="/#page=${child.id}">Tasks</a></p>`;
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    root.id,
  );
  const clone = command(owner, {
    action: "page.duplicate",
    pageId: root.id,
  }) as { id: string; pages: number };
  assert.equal(clone.pages, 2);
  const copiedChild = one<Page>(
    "SELECT * FROM pages WHERE parent_id=?",
    clone.id,
  )!;
  const copiedRows = (await import("../lib/api")).rows(copiedChild.id);
  const copiedFirst = copiedRows.find((r) => r.cells.title === "First")!,
    copiedSecond = copiedRows.find((r) => r.cells.title === "Second")!;
  assert.deepEqual(copiedSecond.cells.relation, [copiedFirst.id]);
  assert.notEqual(copiedFirst.id, first.id);
  assert.match(
    rowDocumentData(owner, copiedChild.id, copiedFirst.id).html,
    /Detailed record/,
  );
  assert.ok(
    one<{ html: string }>(
      "SELECT html FROM documents WHERE page_id=?",
      clone.id,
    )!.html.includes(copiedChild.id),
  );
  const fields = JSON.parse(
    one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      copiedChild.id,
    )!.fields,
  );
  assert.equal(
    fields.find((f: Field) => f.id === "relation").relationPage,
    copiedChild.id,
  );
  command(owner, {
    action: "page.move",
    pageId: copiedChild.id,
    targetId: root.id,
    placement: "before",
  });
  assert.equal(
    one<Page>("SELECT * FROM pages WHERE id=?", copiedChild.id)!.parent_id,
    null,
  );
  const ordered = (await import("../lib/db"))
    .all<Page>(
      "SELECT * FROM pages WHERE parent_id IS NULL AND space_id=? ORDER BY position",
      page.space_id,
    )
    .map((p) => p.id);
  assert.equal(ordered.indexOf(copiedChild.id) + 1, ordered.indexOf(root.id));
});
test("starter templates create real content and reject mismatched page kinds atomically", () => {
  const created = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Meeting",
    kind: "document",
    starterTemplate: "meeting",
  }) as { id: string };
  assert.match(
    one<{ html: string }>(
      "SELECT html FROM documents WHERE page_id=?",
      created.id,
    )!.html,
    /<h2>Agenda<\/h2>/,
  );
  assert.throws(
    () =>
      command(owner, {
        action: "page.create",
        workspaceId: wid,
        spaceId: page.space_id,
        title: "Rejected template",
        kind: "database",
        starterTemplate: "meeting",
      }),
    /Seitentyp/,
  );
  assert.equal(
    one("SELECT id FROM pages WHERE title=?", "Rejected template"),
    undefined,
  );
});

test("publications require edit access to the full tree, publish only selected descendants and revoke moved or deleted pages", async () => {
  const { publicPage, publicTree, publishedHtml, publicFile } =
    await import("../lib/publication");
  const create = (title: string, parentId?: string) =>
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: page.space_id,
      title,
      parentId,
    }) as { id: string };
  const root = create("Public wiki"),
    child = create("Public child", root.id),
    privatePage = create("Keep private");
  run(
    "INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)",
    child.id,
    editor.id,
    "viewer",
  );
  assert.throws(
    () =>
      command(editor, {
        action: "page.publish",
        pageId: root.id,
        enabled: true,
        includeChildren: true,
      }),
    /Berechtigung/,
  );
  assert.equal(
    one<Page>("SELECT * FROM pages WHERE id=?", root.id)!.public_token,
    null,
  );
  command(owner, {
    action: "page.publish",
    pageId: root.id,
    enabled: true,
    includeChildren: true,
  });
  const token = one<Page>(
    "SELECT * FROM pages WHERE id=?",
    root.id,
  )!.public_token!;
  assert.equal(publicPage(token, child.id).page.id, child.id);
  assert.throws(
    () => publicPage(token, privatePage.id),
    /nicht veröffentlicht/,
  );
  const added = create("New private child", root.id);
  assert.throws(() => publicPage(token, added.id), /nicht veröffentlicht/);
  const file = id(),
    unused = id();
  for (const fid of [file, unused])
    run(
      "INSERT INTO files(id,page_id,name,mime,size) VALUES(?,?,?,?,?)",
      fid,
      child.id,
      "picture.png",
      "image/png",
      3,
    );
  run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<img src="/api/files/${file}"><a href="/#page=${root.id}">Home</a><a href="/#page=${privatePage.id}">Private</a>`,
    child.id,
  );
  assert.equal(publicFile(token, file).id, file);
  assert.throws(() => publicFile(token, unused), /nicht veröffentlicht/);
  const published = publishedHtml(
    String(one("SELECT html FROM documents WHERE page_id=?", child.id)!.html),
    token,
    publicTree(token).pages,
  );
  assert.match(published, new RegExp(`/api/share/${token}/files/${file}`));
  assert.ok(published.includes(`/share/${token}/${root.id}`));
  assert.ok(!published.includes(privatePage.id));
  command(owner, { action: "page.move", pageId: child.id, parentId: null });
  assert.throws(() => publicPage(token, child.id), /nicht veröffentlicht/);
  assert.throws(() => publicFile(token, file), /nicht veröffentlicht/);
  command(owner, { action: "page.move", pageId: child.id, parentId: root.id });
  command(owner, { action: "page.delete", pageId: child.id });
  command(owner, { action: "page.restore", pageId: child.id });
  assert.throws(() => publicPage(token, child.id), /nicht veröffentlicht/);
  command(owner, { action: "page.publish", pageId: root.id, enabled: false });
  assert.throws(() => publicTree(token), /nicht gefunden/);
});

test("media responses support range seeking and never render executable uploads inline", async () => {
  const { fileResponse } = await import("../lib/file-response");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), {
    recursive: true,
  });
  const fid = id();
  writeFileSync(
    join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid),
    "0123456789",
  );
  const file = { id: fid, name: "sound.mp3", mime: "audio/mpeg" };
  const partial = await fileResponse(
    new Request("http://localhost", { headers: { range: "bytes=2-5" } }),
    file,
  );
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await partial.text(), "2345");
  const suffix = await fileResponse(
    new Request("http://localhost", { headers: { range: "bytes=-3" } }),
    file,
  );
  assert.equal(await suffix.text(), "789");
  assert.equal(
    (
      await fileResponse(
        new Request("http://localhost", { headers: { range: "bytes=99-100" } }),
        file,
      )
    ).status,
    416,
  );
  const head = await fileResponse(
    new Request("http://localhost", { method: "HEAD" }),
    file,
  );
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  const unsafe = await fileResponse(new Request("http://localhost"), {
    ...file,
    mime: "image/svg+xml",
  });
  assert.equal(unsafe.headers.get("content-type"), "application/octet-stream");
  assert.match(unsafe.headers.get("content-disposition")!, /^attachment/);
});

test("legacy JSON import remaps page links and row relations without changing literal text", () => {
  const oldPage = id(),
    oldDatabase = id(),
    first = id(),
    second = id();
  const backup = {
    format: "flowplan-1",
    pages: [
      {
        id: oldPage,
        parent_id: null,
        title: "Legacy guide",
        kind: "document",
        data: { html: `<p><a href="/#page=${oldDatabase}">Database</a></p>` },
      },
      {
        id: oldDatabase,
        parent_id: oldPage,
        title: "Legacy records",
        kind: "database",
        data: {
          database: {
            fields: [
              { id: "title", name: "Name", type: "text" },
              {
                id: "related",
                name: "Related",
                type: "relation",
                relationPage: oldDatabase,
              },
            ],
            views: [
              {
                id: "table",
                name: "Table",
                type: "table",
                filters: [],
                sorts: [],
              },
            ],
          },
          rows: [
            {
              id: first,
              cells: { title: "First" },
              content: "<h2>Rich legacy record</h2>",
            },
            { id: second, cells: { title: first, related: [first] } },
          ],
        },
      },
    ],
  };
  const result = command(owner, {
    action: "workspace.import",
    workspaceId: wid,
    spaceId: page.space_id,
    backup,
  }) as { pageIds: Record<string, string> };
  const document = one<{ html: string }>(
    "SELECT html FROM documents WHERE page_id=?",
    result.pageIds[oldPage],
  )!;
  assert.ok(document.html.includes(result.pageIds[oldDatabase]));
  const imported = one<{ fields: string }>(
    "SELECT fields FROM databases WHERE page_id=?",
    result.pageIds[oldDatabase],
  )!;
  assert.equal(
    JSON.parse(imported.fields)[1].relationPage,
    result.pageIds[oldDatabase],
  );
  const firstRow = one<{ id: string; content: string }>(
    "SELECT id,content FROM rows WHERE page_id=? AND json_extract(cells,'$.title')=?",
    result.pageIds[oldDatabase],
    "First",
  )!;
  const secondRow = one<{ cells: string }>(
    "SELECT cells FROM rows WHERE page_id=? AND json_extract(cells,'$.title')=?",
    result.pageIds[oldDatabase],
    first,
  )!;
  assert.deepEqual(JSON.parse(secondRow.cells).related, [firstRow.id]);
  assert.match(firstRow.content, /Rich legacy record/);
});

test("bulk operations reject stale versions atomically, clone rich rows and restore deleted discussions", async () => {
  const { rows, database: readDatabase } = await import("../lib/api");
  const { replaceRowDocument, rowDocumentData } =
    await import("../lib/row-documents");
  const table = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Bulk",
    kind: "database",
  }) as { id: string };
  const first = command(owner, {
    action: "row.create",
    pageId: table.id,
    cells: { title: "First", status: "Nicht begonnen" },
  }) as { id: string };
  const second = command(owner, {
    action: "row.create",
    pageId: table.id,
    cells: { title: "Second", status: "Nicht begonnen" },
  }) as { id: string };
  replaceRowDocument(first.id, "<h2>Preserved detail</h2>", owner.id);
  command(owner, {
    action: "comment.create",
    pageId: table.id,
    rowId: first.id,
    body: "Preserved discussion",
  });
  command(owner, {
    action: "row.update",
    pageId: table.id,
    rowId: second.id,
    version: 1,
    cells: { status: "In Arbeit" },
  });
  assert.throws(
    () =>
      command(owner, {
        action: "rows.bulk",
        pageId: table.id,
        operation: "update",
        rows: [
          { id: first.id, version: 1 },
          { id: second.id, version: 1 },
        ],
        cells: { status: "Erledigt" },
      }),
    /Auswahl erneuern/,
  );
  assert.equal(rows(table.id)[0].cells.status, "Nicht begonnen");
  const ids = () =>
    rows(table.id).map((r) => ({ id: r.id, version: r.version }));
  command(owner, {
    action: "rows.bulk",
    pageId: table.id,
    operation: "update",
    rows: ids(),
    cells: { status: "Erledigt" },
  });
  assert.ok(rows(table.id).every((r) => r.cells.status === "Erledigt"));
  assert.throws(
    () =>
      command(viewer, {
        action: "rows.bulk",
        pageId: table.id,
        operation: "delete",
        rows: ids(),
      }),
    /Berechtigung/,
  );
  const schema = readDatabase(table.id);
  command(owner, {
    action: "database.update",
    pageId: table.id,
    version: schema.version,
    fields: [
      ...schema.fields,
      {
        id: "related",
        name: "Related",
        type: "relation",
        relationPage: table.id,
      },
    ],
    views: schema.views,
  });
  const current = rows(table.id).find((r) => r.id === second.id)!;
  command(owner, {
    action: "row.update",
    pageId: table.id,
    rowId: second.id,
    version: current.version,
    cells: { related: [first.id] },
  });
  const copies = command(owner, {
    action: "rows.bulk",
    pageId: table.id,
    operation: "duplicate",
    rows: ids(),
  }) as { ids: string[] };
  const cloneA = rows(table.id).find(
      (r) => copies.ids.includes(r.id) && r.cells.title === "First",
    )!,
    cloneB = rows(table.id).find(
      (r) => copies.ids.includes(r.id) && r.cells.title === "Second",
    )!;
  assert.deepEqual(cloneB.cells.related, [cloneA.id]);
  assert.match(
    rowDocumentData(owner, table.id, cloneA.id).html,
    /Preserved detail/,
  );
  const deletion = command(owner, {
    action: "rows.bulk",
    pageId: table.id,
    operation: "delete",
    rows: ids(),
  }) as { snapshotId: string };
  assert.equal(rows(table.id).length, 0);
  command(owner, {
    action: "snapshot.restore",
    pageId: table.id,
    snapshotId: deletion.snapshotId,
  });
  assert.equal(rows(table.id).length, 4);
  assert.match(
    rowDocumentData(owner, table.id, first.id).html,
    /Preserved detail/,
  );
  assert.equal(
    one<{ body: string }>("SELECT body FROM comments WHERE row_id=?", first.id)!
      .body,
    "Preserved discussion",
  );
});

test("view-specific column settings persist with schema version and width guards", async () => {
  const { database: readDatabase } = await import("../lib/api");
  const before = readDatabase(database.id);
  const next = before.views.map((v, i) =>
    i === 0
      ? {
          ...v,
          fieldOrder: ["status", "title"],
          columnWidths: { title: 360, status: 120 },
        }
      : v,
  );
  command(owner, {
    action: "database.update",
    pageId: database.id,
    version: before.version,
    fields: before.fields,
    views: next,
  });
  const current = readDatabase(database.id);
  assert.equal(current.views[0].columnWidths?.title, 360);
  assert.deepEqual(current.views[0].fieldOrder, ["status", "title"]);
  assert.equal(current.views[1].columnWidths, undefined);
  assert.throws(() =>
    command(owner, {
      action: "database.update",
      pageId: database.id,
      version: current.version,
      fields: current.fields,
      views: [{ ...next[0], columnWidths: { title: 900 } }],
    }),
  );
  assert.equal(readDatabase(database.id).version, current.version);
});

test("form configuration validates required fields, types and hidden answers on every submission path", async () => {
  const { rows, database: readDatabase } = await import("../lib/api");
  const { formSettings, getForm, saveFormSubmission } =
    await import("../lib/forms");
  const { formConfigSchema, validateFormValues } =
    await import("../lib/form-settings");
  const table = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Validated form",
    kind: "database",
  }) as { id: string };
  const d = readDatabase(table.id);
  const fields: Field[] = [
    ...d.fields,
    { id: "email", name: "E-Mail", type: "email" },
    { id: "number", name: "Zahl", type: "number" },
  ];
  command(owner, {
    action: "database.update",
    pageId: table.id,
    version: d.version,
    fields,
    views: d.views,
  });
  const config = formConfigSchema.parse({
    title: "Feedback",
    description: "Your feedback",
    requiredFields: ["title", "email", "number"],
    hiddenFields: ["priority"],
    fieldOrder: ["email", "title"],
    successTitle: "Received",
  });
  command(owner, {
    action: "form.update",
    pageId: table.id,
    enabled: true,
    internal: false,
    anonymous: true,
    config,
  });
  const settings = formSettings(table.id)!;
  assert.equal(getForm(settings.token, null).fields[0].id, "email");
  assert.throws(
    () => saveFormSubmission(table.id, null, { email: "wrong", number: 0 }),
    /Bitte ausfüllen/,
  );
  assert.equal(rows(table.id).length, 0);
  const accepted = saveFormSubmission(table.id, null, {
    title: "Test",
    email: "test@example.test",
    number: 0,
    priority: "Hoch",
    assignee: owner.id,
  });
  const row = rows(table.id).find((r) => r.id === accepted.id)!;
  assert.equal(row.cells.number, 0);
  assert.equal(row.cells.priority, undefined);
  assert.equal(row.cells.assignee, undefined);
  assert.equal(row.created_by, null);
  assert.throws(
    () =>
      command(owner, {
        action: "form.submit",
        pageId: table.id,
        cells: { title: "Missing required" },
      }),
    /Bitte ausfüllen/,
  );
  const invalid = validateFormValues(fields, formConfigSchema.parse({}), {
    number: [],
    date: "2026-02-31",
    status: "invented",
  });
  assert.ok(invalid.errors.number);
  assert.ok(invalid.errors.date);
  assert.ok(invalid.errors.status);
  command(owner, { action: "form.update", pageId: table.id, enabled: false });
  assert.equal(formSettings(table.id)!.config.title, "Feedback");
  assert.throws(() => getForm(settings.token, null), /nicht gefunden/);
});

test("saved database page templates copy records, self-relations, rich text, row templates and form design atomically", async () => {
  const { database: readDatabase, rows: readRows } = await import("../lib/api");
  const { replaceRowDocument, rowDocumentData } =
    await import("../lib/row-documents");
  const create = (title: string, extra = {}) =>
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      kind: "database",
      title,
      ...extra,
    }) as { id: string };
  const source = create("Reusable project");
  const schema = readDatabase(source.id);
  command(owner, {
    action: "database.update",
    pageId: source.id,
    version: schema.version,
    fields: [
      ...schema.fields,
      {
        id: "related",
        name: "Related",
        type: "relation",
        relationPage: source.id,
      },
    ],
    views: schema.views,
  });
  const a = command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "Kickoff", assignee: owner.id },
  }) as { id: string };
  const b = command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "Delivery", related: [a.id] },
  }) as { id: string };
  replaceRowDocument(
    a.id,
    `<h2>Project brief</h2><p><a href="/#page=${source.id}">Project home</a></p>`,
    owner.id,
  );
  replaceRowDocument(b.id, "<p>Delivery instructions</p>", owner.id);
  const rowTemplate = command(owner, {
    action: "row.template.save",
    pageId: source.id,
    rowId: b.id,
    name: "Milestone",
  }) as { id: string };
  command(owner, {
    action: "row.template.default",
    pageId: source.id,
    templateId: rowTemplate.id,
    enabled: true,
  });
  command(owner, {
    action: "form.update",
    pageId: source.id,
    enabled: true,
    internal: false,
    anonymous: true,
    config: { title: "New proposal", requiredFields: ["title"] },
  });
  command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Reusable complete database",
  });
  const saved = one<{ id: string; payload: string }>(
    "SELECT id,payload FROM templates WHERE name=?",
    "Reusable complete database",
  )!;
  // The saved content is a snapshot, independent of subsequent source edits.
  replaceRowDocument(a.id, "<p>Changed later</p>", owner.id);
  command(owner, { action: "row.delete", pageId: source.id, rowId: b.id });
  const copy = create("Copied project", { templateId: saved.id });
  const copiedRows = readRows(copy.id);
  assert.equal(copiedRows.length, 2);
  const first = copiedRows.find((r) => r.cells.title === "Kickoff")!;
  const second = copiedRows.find((r) => r.cells.title === "Delivery")!;
  assert.notEqual(first.id, a.id);
  assert.deepEqual(second.cells.related, [first.id]);
  assert.equal(
    readDatabase(copy.id).fields.find((f) => f.id === "related")!.relationPage,
    copy.id,
  );
  const doc = rowDocumentData(owner, copy.id, first.id);
  assert.match(doc.html, /Project brief/);
  assert.match(doc.html, new RegExp(copy.id));
  assert.notEqual(
    doc.generation,
    rowDocumentData(owner, source.id, a.id).generation,
  );
  const third = command(owner, { action: "row.create", pageId: copy.id }) as {
    id: string;
  };
  assert.deepEqual(
    readRows(copy.id).find((r) => r.id === third.id)!.cells.related,
    [first.id],
  );
  assert.match(
    rowDocumentData(owner, copy.id, third.id).html,
    /Delivery instructions/,
  );
  const form = one<{
    enabled: number;
    internal: number;
    anonymous: number;
    config: string;
  }>("SELECT * FROM forms WHERE page_id=?", copy.id)!;
  assert.equal(form.enabled, 0);
  assert.equal(form.internal, 1);
  assert.equal(form.anonymous, 0);
  assert.equal(JSON.parse(form.config).title, "New proposal");
  // Private templates and malformed templates cannot leave a half-created page.
  run("UPDATE templates SET visibility='private' WHERE id=?", saved.id);
  assert.throws(
    () =>
      command(editor, {
        action: "page.create",
        workspaceId: wid,
        spaceId: boot.spaces[0].id,
        title: "Unauthorized template copy",
        templateId: saved.id,
      }),
    /Private Vorlage/,
  );
  assert.equal(
    one("SELECT id FROM pages WHERE title=?", "Unauthorized template copy"),
    undefined,
  );
  const broken = JSON.parse(saved.payload);
  broken.rows.push(broken.rows[0]);
  run(
    "UPDATE templates SET payload=? WHERE id=?",
    JSON.stringify(broken),
    saved.id,
  );
  assert.throws(
    () => create("Broken template copy", { templateId: saved.id }),
    /Doppelte/,
  );
  assert.equal(
    one("SELECT id FROM pages WHERE title=?", "Broken template copy"),
    undefined,
  );
});

test("replacing a database with a saved template checks versions and restores the full prior database", async () => {
  const { database: readDatabase, rows: readRows } = await import("../lib/api");
  const create = (title: string) =>
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      kind: "database",
      title,
    }) as { id: string };
  const source = create("Replacement source");
  command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "Replacement row" },
  });
  command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Replacement template",
  });
  const template = one<{ id: string }>(
    "SELECT id FROM templates WHERE name=?",
    "Replacement template",
  )!;
  const target = create("Existing database");
  const row = command(owner, {
    action: "row.create",
    pageId: target.id,
    cells: { title: "Original row" },
  }) as { id: string };
  command(owner, {
    action: "comment.create",
    pageId: target.id,
    rowId: row.id,
    body: "Original discussion",
  });
  command(owner, {
    action: "row.template.save",
    pageId: target.id,
    rowId: row.id,
    name: "Original template",
  });
  command(owner, {
    action: "form.update",
    pageId: target.id,
    config: { title: "Original form" },
  });
  const version = readDatabase(target.id).version;
  assert.throws(
    () =>
      command(owner, {
        action: "template.apply",
        pageId: target.id,
        templateId: template.id,
        version: version - 1,
      }),
    /zwischenzeitlich/,
  );
  assert.equal(readRows(target.id)[0].id, row.id);
  const applied = command(owner, {
    action: "template.apply",
    pageId: target.id,
    templateId: template.id,
    version,
  }) as { snapshotId: string };
  assert.equal(readRows(target.id).length, 1);
  assert.equal(readRows(target.id)[0].cells.title, "Replacement row");
  assert.equal(
    one("SELECT id FROM comments WHERE page_id=?", target.id),
    undefined,
  );
  command(owner, {
    action: "snapshot.restore",
    pageId: target.id,
    snapshotId: applied.snapshotId,
  });
  assert.equal(readRows(target.id)[0].id, row.id);
  assert.equal(
    one<{ body: string }>("SELECT body FROM comments WHERE row_id=?", row.id)!
      .body,
    "Original discussion",
  );
  assert.equal(
    one<{ name: string }>(
      "SELECT name FROM row_templates WHERE page_id=?",
      target.id,
    )!.name,
    "Original template",
  );
  assert.equal(
    JSON.parse(
      one<{ config: string }>(
        "SELECT config FROM forms WHERE page_id=?",
        target.id,
      )!.config,
    ).title,
    "Original form",
  );
});

test("shared page templates omit inaccessible external relations and non-member people", async () => {
  const { database: readDatabase, rows: readRows } = await import("../lib/api");
  const privateSpace = command(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Template relation secrets",
    private: true,
  }) as { id: string };
  const secret = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: privateSpace.id,
    title: "Private relation target",
    kind: "database",
  }) as { id: string };
  const secretRow = command(owner, {
    action: "row.create",
    pageId: secret.id,
    cells: { title: "Secret record" },
  }) as { id: string };
  const source = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Shared relation template source",
    kind: "database",
  }) as { id: string };
  const schema = readDatabase(source.id);
  command(owner, {
    action: "database.update",
    pageId: source.id,
    version: schema.version,
    fields: [
      ...schema.fields,
      {
        id: "external",
        name: "External",
        type: "relation",
        relationPage: secret.id,
      },
    ],
    views: schema.views,
  });
  command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: {
      title: "Public starter task",
      external: [secretRow.id],
      assignee: stranger.id,
    },
  });
  command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Shared restricted relations",
  });
  const templateId = one<{ id: string }>(
    "SELECT id FROM templates WHERE name=?",
    "Shared restricted relations",
  )!.id;
  const copy = command(editor, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Member template instance",
    templateId,
  }) as { id: string };
  assert.equal(
    readDatabase(copy.id).fields.find((f) => f.id === "external")!.relationPage,
    undefined,
  );
  assert.deepEqual(readRows(copy.id)[0].cells.external, []);
  assert.equal(readRows(copy.id)[0].cells.assignee, "");
  const otherWorkspace = createWorkspace(owner.id, "Other template workspace");
  const otherBoot = bootstrap(owner, otherWorkspace);
  assert.throws(
    () =>
      command(owner, {
        action: "page.create",
        workspaceId: otherWorkspace,
        spaceId: otherBoot.spaces[0].id,
        title: "Cross-workspace template",
        templateId,
      }),
    /Arbeitsbereich/,
  );
  assert.equal(
    one("SELECT id FROM pages WHERE title=?", "Cross-workspace template"),
    undefined,
  );
});

test("document template replacement snapshots content and rotates collaboration identity", () => {
  const source = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Document template source",
  }) as { id: string };
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    "<h2>Reusable agenda</h2>",
    htmlState("<h2>Reusable agenda</h2>"),
    source.id,
  );
  command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Document replacement template",
  });
  const templateId = one<{ id: string }>(
    "SELECT id FROM templates WHERE name=?",
    "Document replacement template",
  )!.id;
  const target = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Document before replacement",
  }) as { id: string };
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    "<p>Keep my old content</p>",
    htmlState("<p>Keep my old content</p>"),
    target.id,
  );
  const generation = one<{ generation: string }>(
    "SELECT generation FROM documents WHERE page_id=?",
    target.id,
  )!.generation;
  const result = command(owner, {
    action: "template.apply",
    pageId: target.id,
    templateId,
  }) as { snapshotId: string };
  const replaced = one<{ html: string; generation: string }>(
    "SELECT html,generation FROM documents WHERE page_id=?",
    target.id,
  )!;
  assert.match(replaced.html, /Reusable agenda/);
  assert.notEqual(replaced.generation, generation);
  command(owner, {
    action: "snapshot.restore",
    pageId: target.id,
    snapshotId: result.snapshotId,
  });
  assert.match(
    one<{ html: string }>(
      "SELECT html FROM documents WHERE page_id=?",
      target.id,
    )!.html,
    /Keep my old content/,
  );
});
