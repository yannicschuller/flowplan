import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tests-"));
const { one, run, id, sql } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { requirePage, requireAdmin } = await import("../lib/permissions");
const { extractGroups, identityFromToken, hash } = await import("../lib/auth");
const { formula, queryRows } = await import("../lib/database");
const { htmlState, stateHtml, cleanHtml } =
  await import("../lib/document-server");
import type { Identity, Page, Row, Field, View } from "../lib/types";
import { everyAsync } from "../lib/each-async";
async function user(name: string, groups: string[] = []): Promise<Identity> {
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
    groups,
    isAdmin: groups.includes("flowplan-admins"),
  };
}
const owner = await user("owner"),
  editor = await user("editor"),
  viewer = await user("viewer"),
  stranger = await user("stranger");
const wid = await createWorkspace(owner.id, "Test", true);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const boot = await bootstrap(owner, wid),
  page = boot.pages.find((p) => p.kind === "document")!,
  database = boot.pages.find((p) => p.kind === "database")!;
test("workspace and page access does not leak across users", async () => {
  await assert.rejects(async () => await requirePage(stranger, page.id), /Berechtigung/);
  assert.equal((await requirePage(viewer, page.id)).id, page.id);
  await assert.rejects(
    async () =>
      await command(viewer, {
        action: "page.update",
        pageId: page.id,
        patch: { title: "attack" },
      }),
    /Berechtigung/,
  );
  assert.equal(
    (await one<Page>("SELECT * FROM pages WHERE id=?", page.id))?.title,
    page.title,
  );
});
test("private spaces and explicit grants are enforced", async () => {
  const space = (await command(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  })) as { id: string };
  const p = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: space.id,
    title: "Secret",
  })) as { id: string };
  await assert.rejects(async () => await requirePage(editor, p.id), /Berechtigung/);
  await command(owner, {
    action: "grant.set",
    resourceId: p.id,
    userId: editor.id,
    role: "viewer",
  });
  assert.equal((await requirePage(editor, p.id)).id, p.id);
  await assert.rejects(async () => await requirePage(editor, p.id, true), /Berechtigung/);
  await assert.rejects(async () => await bootstrap(stranger), /Arbeitsbereich/);
});
test("admin requires exact verified group, never a substring", async () => {
  assert.throws(() => requireAdmin(owner), /Gruppe/);
  await assert.rejects(
    async () => requireAdmin(await user("fake", ["not-flowplan-admins"])),
    /Gruppe/,
  );
  await assert.doesNotReject(async () => requireAdmin(await user("admin", ["flowplan-admins"])));
  assert.deepEqual(extractGroups({ groups: ["x", 3, "flowplan-admins"] }), [
    "x",
    "flowplan-admins",
  ]);
});
test("expired and disabled sessions are rejected", async () => {
  const token = "test-secret";
  await run(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
    hash(token),
    owner.id,
    "[]",
    Date.now() + 10000,
  );
  assert.equal((await identityFromToken(token))?.id, owner.id);
  await run("UPDATE users SET disabled=1 WHERE id=?", owner.id);
  assert.equal(await identityFromToken(token), null);
  await run("UPDATE users SET disabled=0 WHERE id=?", owner.id);
  await run(
    "UPDATE sessions SET expires=? WHERE token=?",
    Date.now() - 1,
    hash(token),
  );
  assert.equal(await identityFromToken(token), null);
});
test("last owner cannot be removed and trees cannot become cyclic", async () => {
  await assert.rejects(
    async () =>
      await command(owner, {
        action: "member.role",
        workspaceId: wid,
        userId: owner.id,
        role: "remove",
      }),
    /Eigentümer/,
  );
  const child = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    parentId: page.id,
    title: "Child",
  })) as { id: string };
  await assert.rejects(
    async () =>
      await command(owner, {
        action: "page.move",
        pageId: page.id,
        parentId: child.id,
      }),
    /Verschieben/,
  );
});
test("trash removes publications and restores descendants", async () => {
  await command(owner, { action: "page.publish", pageId: page.id, enabled: true });
  await command(owner, { action: "page.delete", pageId: page.id });
  await assert.rejects(async () => await requirePage(owner, page.id), /gefunden/);
  assert.equal(
    (await one<Page>("SELECT * FROM pages WHERE id=?", page.id))?.public_token,
    null,
  );
  await command(owner, { action: "page.restore", pageId: page.id });
  assert.equal((await requirePage(owner, page.id)).deleted_at, null);
});
test("row version guards prevent lost updates", async () => {
  const r = (await command(editor, {
    action: "row.create",
    pageId: database.id,
    cells: { title: "A" },
  })) as { id: string };
  await command(editor, {
    action: "row.update",
    pageId: database.id,
    rowId: r.id,
    version: 1,
    cells: { title: "B" },
  });
  await assert.rejects(
    async () =>
      await command(owner, {
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
      (await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", r.id))!.cells,
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
test("Yjs merges independent edits and persists canonical HTML", async () => {
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
  const pd = (await pageData(owner, page.id)) as { generation: string };
  await command(owner, {
    action: "document.sync",
    pageId: page.id,
    generation: pd.generation,
    update: Buffer.from(state).toString("base64"),
    html: "<script>attack</script>",
  });
  assert.ok(
    !(await one<{ html: string }>(
      "SELECT html FROM documents WHERE page_id=?",
      page.id,
    ))?.html.includes("script"),
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
test("restoring a version rejects stale collaboration generations", async () => {
  await command(owner, { action: "page.snapshot", pageId: page.id });
  const snapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    page.id,
  ))!;
  const prior = (await pageData(owner, page.id)) as { generation: string };
  await command(owner, {
    action: "snapshot.restore",
    pageId: page.id,
    snapshotId: snapshot.id,
  });
  await assert.rejects(
    async () =>
      await command(owner, {
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
  const r = (await command(owner, {
    action: "row.create",
    pageId: database.id,
    cells: { title: "Rich row" },
    templateId: null,
  })) as { id: string };
  const initial = await rowDocumentData(owner, database.id, r.id);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(initial.state, "base64"));
  Y.applyUpdate(doc, htmlState("<h2>A complete record document</h2>"));
  await command(owner, {
    action: "row.document.sync",
    pageId: database.id,
    rowId: r.id,
    generation: initial.generation,
    update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
  });
  assert.match(
    (await rowDocumentData(viewer, database.id, r.id)).html,
    /<h2[^>]*>A complete record document<\/h2>/,
  );
  await assert.rejects(
    async () => await rowDocumentData(stranger, database.id, r.id),
    /Berechtigung/,
  );
  await assert.rejects(
    async () =>
      await command(viewer, {
        action: "row.document.sync",
        pageId: database.id,
        rowId: r.id,
        generation: initial.generation,
        update: initial.state,
      }),
    /Berechtigung/,
  );
  await assert.rejects(async () => await rowDocumentData(owner, page.id, r.id), /Datenbank/);
  const snap = (await command(owner, {
    action: "row.snapshot",
    pageId: database.id,
    rowId: r.id,
  })) as { id: string };
  await command(owner, {
    action: "row.snapshot.restore",
    pageId: database.id,
    rowId: r.id,
    snapshotId: snap.id,
  });
  assert.notEqual(
    (await rowDocumentData(owner, database.id, r.id)).generation,
    initial.generation,
  );
  await assert.rejects(
    async () =>
      await command(owner, {
        action: "row.document.sync",
        pageId: database.id,
        rowId: r.id,
        generation: initial.generation,
        update: initial.state,
      }),
    /Dokumentversion/,
  );
  await command(owner, { action: "row.delete", pageId: database.id, rowId: r.id });
  assert.equal(
    await one("SELECT row_id FROM row_documents WHERE row_id=?", r.id),
    undefined,
  );
  doc.destroy();
});
test("record templates clone properties, relations and rich documents with independent CRDT identities", async () => {
  const { rowDocumentData, replaceRowDocument } =
    await import("../lib/row-documents");
  const original = (await command(owner, {
    action: "row.create",
    pageId: database.id,
    templateId: null,
    cells: {
      title: "Template source",
      status: "In Arbeit",
      link: ["related-id"],
    },
  })) as { id: string };
  await replaceRowDocument(
    original.id,
    "<h2>Briefing</h2><ul><li><p>Deliverable</p></li></ul>",
    owner.id,
  );
  const template = (await command(owner, {
    action: "row.template.save",
    pageId: database.id,
    rowId: original.id,
    name: "Project briefing",
  })) as { id: string };
  await command(owner, {
    action: "row.template.default",
    pageId: database.id,
    templateId: template.id,
    enabled: true,
  });
  const copy = (await command(editor, {
    action: "row.create",
    pageId: database.id,
    cells: { title: "New project" },
  })) as { id: string };
  const copied = (await one<{ cells: string }>(
    "SELECT cells FROM rows WHERE id=?",
    copy.id,
  ))!;
  assert.deepEqual(JSON.parse(copied.cells), {
    title: "New project",
    status: "In Arbeit",
    link: ["related-id"],
  });
  assert.match(
    (await rowDocumentData(editor, database.id, copy.id)).html,
    /<h2[^>]*>Briefing/,
  );
  assert.notEqual(
    (await rowDocumentData(editor, database.id, copy.id)).state,
    (await rowDocumentData(owner, database.id, original.id)).state,
  );
  const other = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Other database",
    kind: "database",
  })) as { id: string };
  await assert.rejects(
    async () =>
      await command(owner, {
        action: "row.create",
        pageId: other.id,
        templateId: template.id,
      }),
    /vorlage/,
  );
  await assert.rejects(
    async () =>
      await command(viewer, {
        action: "row.template.delete",
        pageId: database.id,
        templateId: template.id,
      }),
    /Berechtigung/,
  );
  await command(owner, {
    action: "row.template.delete",
    pageId: database.id,
    templateId: template.id,
  });
});

test("recursive page copies preserve children, rich row content and internal relations without sharing CRDT IDs", async () => {
  const { replaceRowDocument, rowDocumentData } =
    await import("../lib/row-documents");
  const root = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Project wiki",
  })) as { id: string };
  const child = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    parentId: root.id,
    title: "Child tasks",
    kind: "database",
  })) as { id: string };
  const first = (await command(owner, {
    action: "row.create",
    pageId: child.id,
    templateId: null,
    cells: { title: "First" },
  })) as { id: string };
  const second = (await command(owner, {
    action: "row.create",
    pageId: child.id,
    templateId: null,
    cells: { title: "Second", relation: [first.id] },
  })) as { id: string };
  await replaceRowDocument(first.id, "<h2>Detailed record</h2>", owner.id);
  const raw = (await one<{ fields: string; views: string; version: number }>(
    "SELECT * FROM databases WHERE page_id=?",
    child.id,
  ))!;
  await command(owner, {
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
  await run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    root.id,
  );
  const clone = (await command(owner, {
    action: "page.duplicate",
    pageId: root.id,
  })) as { id: string; pages: number };
  assert.equal(clone.pages, 2);
  const copiedChild = (await one<Page>(
    "SELECT * FROM pages WHERE parent_id=?",
    clone.id,
  ))!;
  const copiedRows = await (await import("../lib/api")).rows(copiedChild.id);
  const copiedFirst = copiedRows.find((r) => r.cells.title === "First")!,
    copiedSecond = copiedRows.find((r) => r.cells.title === "Second")!;
  assert.deepEqual(copiedSecond.cells.relation, [copiedFirst.id]);
  assert.notEqual(copiedFirst.id, first.id);
  assert.match(
    (await rowDocumentData(owner, copiedChild.id, copiedFirst.id)).html,
    /Detailed record/,
  );
  assert.ok(
    (await one<{ html: string }>(
      "SELECT html FROM documents WHERE page_id=?",
      clone.id,
    ))!.html.includes(copiedChild.id),
  );
  const fields = JSON.parse(
    (await one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      copiedChild.id,
    ))!.fields,
  );
  assert.equal(
    fields.find((f: Field) => f.id === "relation").relationPage,
    copiedChild.id,
  );
  await command(owner, {
    action: "page.move",
    pageId: copiedChild.id,
    targetId: root.id,
    placement: "before",
  });
  assert.equal(
    (await one<Page>("SELECT * FROM pages WHERE id=?", copiedChild.id))!.parent_id,
    null,
  );
  const ordered = (await (await import("../lib/db"))
    .all<Page>(
      "SELECT * FROM pages WHERE parent_id IS NULL AND space_id=? ORDER BY position",
      page.space_id,
    ))
    .map((p) => p.id);
  assert.equal(ordered.indexOf(copiedChild.id) + 1, ordered.indexOf(root.id));
});
test("starter templates create real content and reject mismatched page kinds atomically", async () => {
  const created = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Meeting",
    kind: "document",
    starterTemplate: "meeting",
  })) as { id: string };
  assert.match(
    (await one<{ html: string }>(
      "SELECT html FROM documents WHERE page_id=?",
      created.id,
    ))!.html,
    /<h2>Agenda<\/h2>/,
  );
  await assert.rejects(
    async () =>
      await command(owner, {
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
    await one("SELECT id FROM pages WHERE title=?", "Rejected template"),
    undefined,
  );
});

test("publications require edit access to the full tree, publish only selected descendants and revoke moved or deleted pages", async () => {
  const { publicPage, publicTree, publishedHtml, publicFile } =
    await import("../lib/publication");
  const create = async (title: string, parentId?: string) =>
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: page.space_id,
      title,
      parentId,
    })) as { id: string };
  const root = await create("Public wiki"),
    child = await create("Public child", root.id),
    privatePage = await create("Keep private");
  await run(
    "INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)",
    child.id,
    editor.id,
    "viewer",
  );
  await assert.rejects(
    async () =>
      await command(editor, {
        action: "page.publish",
        pageId: root.id,
        enabled: true,
        includeChildren: true,
      }),
    /Berechtigung/,
  );
  assert.equal(
    (await one<Page>("SELECT * FROM pages WHERE id=?", root.id))!.public_token,
    null,
  );
  await command(owner, {
    action: "page.publish",
    pageId: root.id,
    enabled: true,
    includeChildren: true,
  });
  const token = (await one<Page>(
    "SELECT * FROM pages WHERE id=?",
    root.id,
  ))!.public_token!;
  assert.equal((await publicPage(token, child.id)).page.id, child.id);
  await assert.rejects(
    async () => await publicPage(token, privatePage.id),
    /nicht veröffentlicht/,
  );
  const added = await create("New private child", root.id);
  await assert.rejects(async () => await publicPage(token, added.id), /nicht veröffentlicht/);
  const file = id(),
    unused = id();
  for (const fid of [file, unused])
    await run(
      "INSERT INTO files(id,page_id,name,mime,size) VALUES(?,?,?,?,?)",
      fid,
      child.id,
      "picture.png",
      "image/png",
      3,
    );
  await run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<img src="/api/files/${file}"><a href="/#page=${root.id}">Home</a><a href="/#page=${privatePage.id}">Private</a>`,
    child.id,
  );
  assert.equal((await publicFile(token, file)).id, file);
  await assert.rejects(async () => await publicFile(token, unused), /nicht veröffentlicht/);
  const published = await publishedHtml(
    String((await one("SELECT html FROM documents WHERE page_id=?", child.id))!.html),
    token,
    (await publicTree(token)).pages,
  );
  assert.match(published, new RegExp(`/api/share/${token}/files/${file}`));
  assert.ok(published.includes(`/share/${token}/${root.id}`));
  assert.ok(!published.includes(privatePage.id));
  await command(owner, { action: "page.move", pageId: child.id, parentId: null });
  await assert.rejects(async () => await publicPage(token, child.id), /nicht veröffentlicht/);
  await assert.rejects(async () => await publicFile(token, file), /nicht veröffentlicht/);
  await command(owner, { action: "page.move", pageId: child.id, parentId: root.id });
  await command(owner, { action: "page.delete", pageId: child.id });
  await command(owner, { action: "page.restore", pageId: child.id });
  await assert.rejects(async () => await publicPage(token, child.id), /nicht veröffentlicht/);
  await command(owner, { action: "page.publish", pageId: root.id, enabled: false });
  await assert.rejects(async () => await publicTree(token), /nicht gefunden/);
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

test("legacy JSON import remaps page links and row relations without changing literal text", async () => {
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
  const result = (await command(owner, {
    action: "workspace.import",
    workspaceId: wid,
    spaceId: page.space_id,
    backup,
  })) as { pageIds: Record<string, string> };
  const document = (await one<{ html: string }>(
    "SELECT html FROM documents WHERE page_id=?",
    result.pageIds[oldPage],
  ))!;
  assert.ok(document.html.includes(result.pageIds[oldDatabase]));
  const imported = (await one<{ fields: string }>(
    "SELECT fields FROM databases WHERE page_id=?",
    result.pageIds[oldDatabase],
  ))!;
  assert.equal(
    JSON.parse(imported.fields)[1].relationPage,
    result.pageIds[oldDatabase],
  );
  const firstRow = (await one<{ id: string; content: string }>(
    `SELECT id,content FROM rows WHERE page_id=? AND ${sql.jsonText("cells", "$.title")}=?`,
    result.pageIds[oldDatabase],
    "First",
  ))!;
  const secondRow = (await one<{ cells: string }>(
    `SELECT cells FROM rows WHERE page_id=? AND ${sql.jsonText("cells", "$.title")}=?`,
    result.pageIds[oldDatabase],
    first,
  ))!;
  assert.deepEqual(JSON.parse(secondRow.cells).related, [firstRow.id]);
  assert.match(firstRow.content, /Rich legacy record/);
});

test("bulk operations reject stale versions atomically, clone rich rows and restore deleted discussions", async () => {
  const { rows, database: readDatabase } = await import("../lib/api");
  const { replaceRowDocument, rowDocumentData } =
    await import("../lib/row-documents");
  const table = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Bulk",
    kind: "database",
  })) as { id: string };
  const first = (await command(owner, {
    action: "row.create",
    pageId: table.id,
    cells: { title: "First", status: "Nicht begonnen" },
  })) as { id: string };
  const second = (await command(owner, {
    action: "row.create",
    pageId: table.id,
    cells: { title: "Second", status: "Nicht begonnen" },
  })) as { id: string };
  await replaceRowDocument(first.id, "<h2>Preserved detail</h2>", owner.id);
  await command(owner, {
    action: "comment.create",
    pageId: table.id,
    rowId: first.id,
    body: "Preserved discussion",
  });
  await command(owner, {
    action: "row.update",
    pageId: table.id,
    rowId: second.id,
    version: 1,
    cells: { status: "In Arbeit" },
  });
  await assert.rejects(
    async () =>
      await command(owner, {
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
  assert.equal((await rows(table.id))[0].cells.status, "Nicht begonnen");
  const ids = async () =>
    (await rows(table.id)).map((r) => ({ id: r.id, version: r.version }));
  await command(owner, {
    action: "rows.bulk",
    pageId: table.id,
    operation: "update",
    rows: await ids(),
    cells: { status: "Erledigt" },
  });
  assert.ok((await rows(table.id)).every((r) => r.cells.status === "Erledigt"));
  await assert.rejects(
    async () =>
      await command(viewer, {
        action: "rows.bulk",
        pageId: table.id,
        operation: "delete",
        rows: await ids(),
      }),
    /Berechtigung/,
  );
  const schema = await readDatabase(table.id);
  await command(owner, {
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
  const current = (await rows(table.id)).find((r) => r.id === second.id)!;
  await command(owner, {
    action: "row.update",
    pageId: table.id,
    rowId: second.id,
    version: current.version,
    cells: { related: [first.id] },
  });
  const copies = (await command(owner, {
    action: "rows.bulk",
    pageId: table.id,
    operation: "duplicate",
    rows: await ids(),
  })) as { ids: string[] };
  const cloneA = (await rows(table.id)).find(
      (r) => copies.ids.includes(r.id) && r.cells.title === "First",
    )!,
    cloneB = (await rows(table.id)).find(
      (r) => copies.ids.includes(r.id) && r.cells.title === "Second",
    )!;
  assert.deepEqual(cloneB.cells.related, [cloneA.id]);
  assert.match(
    (await rowDocumentData(owner, table.id, cloneA.id)).html,
    /Preserved detail/,
  );
  const deletion = (await command(owner, {
    action: "rows.bulk",
    pageId: table.id,
    operation: "delete",
    rows: await ids(),
  })) as { snapshotId: string };
  assert.equal((await rows(table.id)).length, 0);
  await command(owner, {
    action: "snapshot.restore",
    pageId: table.id,
    snapshotId: deletion.snapshotId,
  });
  assert.equal((await rows(table.id)).length, 4);
  assert.match(
    (await rowDocumentData(owner, table.id, first.id)).html,
    /Preserved detail/,
  );
  assert.equal(
    (await one<{ body: string }>("SELECT body FROM comments WHERE row_id=?", first.id))!
      .body,
    "Preserved discussion",
  );
});

test("view-specific column settings persist with schema version and width guards", async () => {
  const { database: readDatabase } = await import("../lib/api");
  const before = await readDatabase(database.id);
  const next = before.views.map((v, i) =>
    i === 0
      ? {
          ...v,
          fieldOrder: ["status", "title"],
          columnWidths: { title: 360, status: 120 },
        }
      : v,
  );
  await command(owner, {
    action: "database.update",
    pageId: database.id,
    version: before.version,
    fields: before.fields,
    views: next,
  });
  const current = await readDatabase(database.id);
  assert.equal(current.views[0].columnWidths?.title, 360);
  assert.deepEqual(current.views[0].fieldOrder, ["status", "title"]);
  assert.equal(current.views[1].columnWidths, undefined);
  await assert.rejects(async () =>
    await command(owner, {
      action: "database.update",
      pageId: database.id,
      version: current.version,
      fields: current.fields,
      views: [{ ...next[0], columnWidths: { title: 900 } }],
    }),
  );
  assert.equal((await readDatabase(database.id)).version, current.version);
});

test("form configuration validates required fields, types and hidden answers on every submission path", async () => {
  const { rows, database: readDatabase } = await import("../lib/api");
  const { formSettings, getForm, saveFormSubmission } =
    await import("../lib/forms");
  const { formConfigSchema, validateFormValues } =
    await import("../lib/form-settings");
  const table = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: page.space_id,
    title: "Validated form",
    kind: "database",
  })) as { id: string };
  const d = await readDatabase(table.id);
  const fields: Field[] = [
    ...d.fields,
    { id: "email", name: "E-Mail", type: "email" },
    { id: "number", name: "Zahl", type: "number" },
  ];
  await command(owner, {
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
  await command(owner, {
    action: "form.update",
    pageId: table.id,
    enabled: true,
    internal: false,
    anonymous: true,
    config,
  });
  const settings = (await formSettings(table.id))!;
  assert.equal((await getForm(settings.token, null)).fields[0].id, "email");
  await assert.rejects(
    async () => await saveFormSubmission(table.id, null, { email: "wrong", number: 0 }),
    /Bitte ausfüllen/,
  );
  assert.equal((await rows(table.id)).length, 0);
  const accepted = await saveFormSubmission(table.id, null, {
    title: "Test",
    email: "test@example.test",
    number: 0,
    priority: "Hoch",
    assignee: owner.id,
  });
  const row = (await rows(table.id)).find((r) => r.id === accepted.id)!;
  assert.equal(row.cells.number, 0);
  assert.equal(row.cells.priority, undefined);
  assert.equal(row.cells.assignee, undefined);
  assert.equal(row.created_by, null);
  await assert.rejects(
    async () =>
      await command(owner, {
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
  await command(owner, { action: "form.update", pageId: table.id, enabled: false });
  assert.equal((await formSettings(table.id))!.config.title, "Feedback");
  await assert.rejects(async () => await getForm(settings.token, null), /nicht gefunden/);
});

test("saved database page templates copy records, self-relations, rich text, row templates and form design atomically", async () => {
  const { database: readDatabase, rows: readRows } = await import("../lib/api");
  const { replaceRowDocument, rowDocumentData } =
    await import("../lib/row-documents");
  const create = async (title: string, extra = {}) =>
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      kind: "database",
      title,
      ...extra,
    })) as { id: string };
  const source = await create("Reusable project");
  const schema = await readDatabase(source.id);
  await command(owner, {
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
  const a = (await command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "Kickoff", assignee: owner.id },
  })) as { id: string };
  const b = (await command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "Delivery", related: [a.id] },
  })) as { id: string };
  await replaceRowDocument(
    a.id,
    `<h2>Project brief</h2><p><a href="/#page=${source.id}">Project home</a></p>`,
    owner.id,
  );
  await replaceRowDocument(b.id, "<p>Delivery instructions</p>", owner.id);
  const rowTemplate = (await command(owner, {
    action: "row.template.save",
    pageId: source.id,
    rowId: b.id,
    name: "Milestone",
  })) as { id: string };
  await command(owner, {
    action: "row.template.default",
    pageId: source.id,
    templateId: rowTemplate.id,
    enabled: true,
  });
  await command(owner, {
    action: "form.update",
    pageId: source.id,
    enabled: true,
    internal: false,
    anonymous: true,
    config: { title: "New proposal", requiredFields: ["title"] },
  });
  await command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Reusable complete database",
  });
  const saved = (await one<{ id: string; payload: string }>(
    "SELECT id,payload FROM templates WHERE name=?",
    "Reusable complete database",
  ))!;
  // The saved content is a snapshot, independent of subsequent source edits.
  await replaceRowDocument(a.id, "<p>Changed later</p>", owner.id);
  await command(owner, { action: "row.delete", pageId: source.id, rowId: b.id });
  const copy = await create("Copied project", { templateId: saved.id });
  const copiedRows = await readRows(copy.id);
  assert.equal(copiedRows.length, 2);
  const first = copiedRows.find((r) => r.cells.title === "Kickoff")!;
  const second = copiedRows.find((r) => r.cells.title === "Delivery")!;
  assert.notEqual(first.id, a.id);
  assert.deepEqual(second.cells.related, [first.id]);
  assert.equal(
    (await readDatabase(copy.id)).fields.find((f) => f.id === "related")!.relationPage,
    copy.id,
  );
  const doc = await rowDocumentData(owner, copy.id, first.id);
  assert.match(doc.html, /Project brief/);
  assert.match(doc.html, new RegExp(copy.id));
  assert.notEqual(
    doc.generation,
    (await rowDocumentData(owner, source.id, a.id)).generation,
  );
  const third = (await command(owner, { action: "row.create", pageId: copy.id })) as {
    id: string;
  };
  assert.deepEqual(
    (await readRows(copy.id)).find((r) => r.id === third.id)!.cells.related,
    [first.id],
  );
  assert.match(
    (await rowDocumentData(owner, copy.id, third.id)).html,
    /Delivery instructions/,
  );
  const form = (await one<{
    enabled: number;
    internal: number;
    anonymous: number;
    config: string;
  }>("SELECT * FROM forms WHERE page_id=?", copy.id))!;
  assert.equal(form.enabled, 0);
  assert.equal(form.internal, 1);
  assert.equal(form.anonymous, 0);
  assert.equal(JSON.parse(form.config).title, "New proposal");
  // Private templates and malformed templates cannot leave a half-created page.
  await run("UPDATE templates SET visibility='private' WHERE id=?", saved.id);
  await assert.rejects(
    async () =>
      await command(editor, {
        action: "page.create",
        workspaceId: wid,
        spaceId: boot.spaces[0].id,
        title: "Unauthorized template copy",
        templateId: saved.id,
      }),
    /Private Vorlage/,
  );
  assert.equal(
    await one("SELECT id FROM pages WHERE title=?", "Unauthorized template copy"),
    undefined,
  );
  const broken = JSON.parse(saved.payload);
  broken.rows.push(broken.rows[0]);
  await run(
    "UPDATE templates SET payload=? WHERE id=?",
    JSON.stringify(broken),
    saved.id,
  );
  await assert.rejects(
    async () => await create("Broken template copy", { templateId: saved.id }),
    /Doppelte/,
  );
  assert.equal(
    await one("SELECT id FROM pages WHERE title=?", "Broken template copy"),
    undefined,
  );
});

test("replacing a database with a saved template checks versions and restores the full prior database", async () => {
  const { database: readDatabase, rows: readRows } = await import("../lib/api");
  const create = async (title: string) =>
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      kind: "database",
      title,
    })) as { id: string };
  const source = await create("Replacement source");
  await command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "Replacement row" },
  });
  await command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Replacement template",
  });
  const template = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE name=?",
    "Replacement template",
  ))!;
  const target = await create("Existing database");
  const row = (await command(owner, {
    action: "row.create",
    pageId: target.id,
    cells: { title: "Original row" },
  })) as { id: string };
  await command(owner, {
    action: "comment.create",
    pageId: target.id,
    rowId: row.id,
    body: "Original discussion",
  });
  await command(owner, {
    action: "row.template.save",
    pageId: target.id,
    rowId: row.id,
    name: "Original template",
  });
  await command(owner, {
    action: "form.update",
    pageId: target.id,
    config: { title: "Original form" },
  });
  const version = (await readDatabase(target.id)).version;
  await assert.rejects(
    async () =>
      await command(owner, {
        action: "template.apply",
        pageId: target.id,
        templateId: template.id,
        version: version - 1,
      }),
    /zwischenzeitlich/,
  );
  assert.equal((await readRows(target.id))[0].id, row.id);
  const applied = (await command(owner, {
    action: "template.apply",
    pageId: target.id,
    templateId: template.id,
    version,
  })) as { snapshotId: string };
  assert.equal((await readRows(target.id)).length, 1);
  assert.equal((await readRows(target.id))[0].cells.title, "Replacement row");
  assert.equal(
    await one("SELECT id FROM comments WHERE page_id=?", target.id),
    undefined,
  );
  await command(owner, {
    action: "snapshot.restore",
    pageId: target.id,
    snapshotId: applied.snapshotId,
  });
  assert.equal((await readRows(target.id))[0].id, row.id);
  assert.equal(
    (await one<{ body: string }>("SELECT body FROM comments WHERE row_id=?", row.id))!
      .body,
    "Original discussion",
  );
  assert.equal(
    (await one<{ name: string }>(
      "SELECT name FROM row_templates WHERE page_id=?",
      target.id,
    ))!.name,
    "Original template",
  );
  assert.equal(
    JSON.parse(
      (await one<{ config: string }>(
        "SELECT config FROM forms WHERE page_id=?",
        target.id,
      ))!.config,
    ).title,
    "Original form",
  );
});

test("shared page templates omit inaccessible external relations and non-member people", async () => {
  const { database: readDatabase, rows: readRows } = await import("../lib/api");
  const privateSpace = (await command(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Template relation secrets",
    private: true,
  })) as { id: string };
  const secret = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: privateSpace.id,
    title: "Private relation target",
    kind: "database",
  })) as { id: string };
  const secretRow = (await command(owner, {
    action: "row.create",
    pageId: secret.id,
    cells: { title: "Secret record" },
  })) as { id: string };
  const source = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Shared relation template source",
    kind: "database",
  })) as { id: string };
  const schema = await readDatabase(source.id);
  await command(owner, {
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
  await command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: {
      title: "Public starter task",
      external: [secretRow.id],
      assignee: stranger.id,
    },
  });
  await command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Shared restricted relations",
  });
  const templateId = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE name=?",
    "Shared restricted relations",
  ))!.id;
  const copy = (await command(editor, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Member template instance",
    templateId,
  })) as { id: string };
  assert.equal(
    (await readDatabase(copy.id)).fields.find((f) => f.id === "external")!.relationPage,
    undefined,
  );
  assert.deepEqual((await readRows(copy.id))[0].cells.external, []);
  assert.equal((await readRows(copy.id))[0].cells.assignee, "");
  const otherWorkspace = await createWorkspace(owner.id, "Other template workspace");
  const otherBoot = await bootstrap(owner, otherWorkspace);
  await assert.rejects(
    async () =>
      await command(owner, {
        action: "page.create",
        workspaceId: otherWorkspace,
        spaceId: otherBoot.spaces[0].id,
        title: "Cross-workspace template",
        templateId,
      }),
    /Arbeitsbereich/,
  );
  assert.equal(
    await one("SELECT id FROM pages WHERE title=?", "Cross-workspace template"),
    undefined,
  );
});

test("document template replacement snapshots content and rotates collaboration identity", async () => {
  const source = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Document template source",
  })) as { id: string };
  await run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    "<h2>Reusable agenda</h2>",
    htmlState("<h2>Reusable agenda</h2>"),
    source.id,
  );
  await command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Document replacement template",
  });
  const templateId = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE name=?",
    "Document replacement template",
  ))!.id;
  const target = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Document before replacement",
  })) as { id: string };
  await run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    "<p>Keep my old content</p>",
    htmlState("<p>Keep my old content</p>"),
    target.id,
  );
  const generation = (await one<{ generation: string }>(
    "SELECT generation FROM documents WHERE page_id=?",
    target.id,
  ))!.generation;
  const result = (await command(owner, {
    action: "template.apply",
    pageId: target.id,
    templateId,
  })) as { snapshotId: string };
  const replaced = (await one<{ html: string; generation: string }>(
    "SELECT html,generation FROM documents WHERE page_id=?",
    target.id,
  ))!;
  assert.match(replaced.html, /Reusable agenda/);
  assert.notEqual(replaced.generation, generation);
  await command(owner, {
    action: "snapshot.restore",
    pageId: target.id,
    snapshotId: result.snapshotId,
  });
  assert.match(
    (await one<{ html: string }>(
      "SELECT html FROM documents WHERE page_id=?",
      target.id,
    ))!.html,
    /Keep my old content/,
  );
});

test("form file questions accept only server-attached uploads and enforce required answers", async () => {
  const { formConfigSchema, validateFormValues, publicFormFields } =
    await import("../lib/form-settings");
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "cv", name: "Lebenslauf", type: "files" },
  ];
  assert.ok(publicFormFields(fields).some((f) => f.id === "cv"));
  const config = formConfigSchema.parse({ requiredFields: ["cv"] });
  const upload = "/api/files/0f0e3b9e-2f59-4c55-9d7a-0d1c3c3c1a11";
  assert.deepEqual(
    validateFormValues(fields, config, { cv: [upload] }).cells.cv,
    [upload],
  );
  assert.match(
    validateFormValues(fields, config, { cv: [] }).errors.cv,
    /ausfüllen/,
  );
  for (const bad of [
    ["https://evil.example/x"],
    upload,
    Array.from({ length: 6 }, () => upload),
    [{ url: upload }],
  ])
    assert.ok(validateFormValues(fields, config, { cv: bad }).errors.cv);
});

test("bulk page actions move, duplicate and trash several pages atomically", async () => {
  const space = boot.spaces[0].id;
  const create = async (title: string, parentId?: string) =>
    (
      (await command(owner, {
        action: "page.create",
        workspaceId: wid,
        spaceId: space,
        title,
        parentId,
      })) as { id: string }
    ).id;
  const target = await create("Bulk Ziel"),
    a = await create("Bulk A"),
    b = await create("Bulk B"),
    child = await create("Bulk Kind", a);
  const pageOf = async (pid: string) =>
    (await one<{
      parent_id: string | null;
      deleted_at: string | null;
      position: number;
    }>("SELECT parent_id,deleted_at,position FROM pages WHERE id=?", pid))!;
  const bulk = async (input: Record<string, unknown>, as = owner) =>
    (await command(as, { action: "pages.bulk", workspaceId: wid, ...input })) as {
      count: number;
      created: string[];
    };
  // A selected child travels with its selected parent.
  assert.equal(
    (await bulk({ operation: "move", pageIds: [b, a, child], parentId: target })).count,
    2,
  );
  assert.equal((await pageOf(a)).parent_id, target);
  assert.equal((await pageOf(b)).parent_id, target);
  assert.equal((await pageOf(child)).parent_id, a);
  assert.ok((await pageOf(b)).position < (await pageOf(a)).position);
  // Moving into one of the moved pages fails without partial changes.
  await assert.rejects(
    async () => await bulk({ operation: "move", pageIds: [target, b], parentId: a }),
    /Ungültiges Verschieben/,
  );
  assert.equal((await pageOf(target)).parent_id, null);
  assert.equal((await pageOf(b)).parent_id, target);
  const { created } = await bulk({ operation: "duplicate", pageIds: [a, b] });
  assert.equal(created.length, 2);
  assert.ok(await everyAsync(created, async (pid) => (await pageOf(pid)).deleted_at === null));
  await bulk({ operation: "delete", pageIds: [a, b] });
  assert.ok(
    (await pageOf(a)).deleted_at && (await pageOf(child)).deleted_at && (await pageOf(b)).deleted_at,
  );
  await assert.rejects(async () => await bulk({ operation: "delete", pageIds: [] }));
  const other = await createWorkspace(owner.id, "Bulk fremd");
  const foreign = (
    (await command(owner, {
      action: "page.create",
      workspaceId: other,
      spaceId: (await bootstrap(owner, other)).spaces[0].id,
      title: "Fremd",
    })) as { id: string }
  ).id;
  await assert.rejects(
    async () => await bulk({ operation: "delete", pageIds: [target, foreign] }),
    /anderen Arbeitsbereich/,
  );
  assert.equal((await pageOf(target)).deleted_at, null);
});

test("internal forms ask for people and relations; public forms never expose them", async () => {
  const { getForm, saveFormSubmission } = await import("../lib/forms");
  const { database: readDatabase, rows } = await import("../lib/api");
  const create = async (title: string) =>
    (
      (await command(owner, {
        action: "page.create",
        workspaceId: wid,
        spaceId: page.space_id,
        title,
        kind: "database",
      })) as { id: string }
    ).id;
  const people = await create("Formular Kontakte"),
    requests = await create("Formular Anfragen");
  const contact = (
    (await command(owner, {
      action: "row.create",
      pageId: people,
      cells: { title: "Kim" },
    })) as {
      id: string;
    }
  ).id;
  const d = await readDatabase(requests);
  await command(owner, {
    action: "database.update",
    pageId: requests,
    version: d.version,
    fields: [
      { id: "title", name: "Titel", type: "text" },
      { id: "owner", name: "Zuständig", type: "person" },
      {
        id: "contact",
        name: "Kontakt",
        type: "relation",
        relationPage: people,
      },
    ],
    views: d.views,
  });
  await command(owner, {
    action: "form.update",
    pageId: requests,
    enabled: true,
    internal: true,
    anonymous: false,
  });
  const token = (await one<{ token: string }>(
    "SELECT token FROM forms WHERE page_id=?",
    requests,
  ))!.token;
  const internal = await getForm(token, editor);
  assert.deepEqual(
    internal.fields.map((f) => f.id),
    ["title", "owner", "contact"],
  );
  assert.ok(internal.members.some((m) => m.id === owner.id));
  assert.deepEqual(
    internal.related[people].map((r) => r.cells.title),
    ["Kim"],
  );
  await saveFormSubmission(requests, editor, {
    title: "Frage",
    owner: owner.id,
    contact: [contact],
  });
  const saved = (await rows(requests)).find((r) => r.cells.title === "Frage")!;
  assert.equal(saved.cells.owner, owner.id);
  assert.deepEqual(saved.cells.contact, [contact]);
  await assert.rejects(
    async () =>
      await saveFormSubmission(requests, editor, { title: "x", owner: stranger.id }),
    /Mitglied/,
  );
  await assert.rejects(
    async () => await saveFormSubmission(requests, editor, { title: "x", contact: [id()] }),
    /Eintrag nicht gefunden/,
  );
  // Public forms drop people and relations and never list members.
  await command(owner, {
    action: "form.update",
    pageId: requests,
    enabled: true,
    internal: false,
    anonymous: true,
  });
  const open = await getForm(token, null);
  assert.deepEqual(
    open.fields.map((f) => f.id),
    ["title"],
  );
  assert.deepEqual(open.members, []);
  assert.deepEqual(open.related, {});
  await saveFormSubmission(requests, null, {
    title: "Anonym",
    owner: owner.id,
    contact: [contact],
  });
  const anon = (await rows(requests)).find((r) => r.cells.title === "Anonym")!;
  assert.equal(anon.cells.owner, undefined);
  assert.equal(anon.cells.contact, undefined);
});

test("each copy of a page sits directly after its source, without ties", async () => {
  const create = async (title: string, parentId?: string) =>
    ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: page.space_id, title, parentId })) as { id: string }).id;
  const parent = await create("Kopien");
  const a = await create("A", parent),
    b = await create("B", parent);
  const dup = async (pageId: string) => ((await command(owner, { action: "page.duplicate", pageId })) as { id: string }).id;
  const first = await dup(a),
    second = await dup(a),
    copyOfCopy = await dup(second);
  const order = (
    await (await import("../lib/db")).all<{ id: string; position: number }>(
      "SELECT id,position FROM pages WHERE parent_id=? AND deleted_at IS NULL ORDER BY position,id",
      parent,
    )
  );
  assert.deepEqual(order.map((p) => p.id), [a, second, copyOfCopy, first, b]);
  assert.equal(new Set(order.map((p) => p.position)).size, order.length);
});
