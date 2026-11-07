import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page, Row, Field } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-archive-"),
);
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, pageData, rows, database } = await import("../lib/api");
const { exportArchive, importArchive, readZip, writeZip } =
  await import("../lib/archive");
const { replaceRowDocument, rowDocumentData } =
  await import("../lib/row-documents");
const { htmlState } = await import("../lib/document-server");
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    name + "@example.test",
  );
  return {
    id: uid,
    name,
    email: name + "@example.test",
    disabled: 0,
    created_at: "",
    groups: [],
    isAdmin: false,
  };
}
const owner = await user("Archiver"),
  viewer = await user("Reader"),
  wid = await createWorkspace(owner.id, "Archive source");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = (await one<{ id: string }>(
  "SELECT id FROM spaces WHERE workspace_id=?",
  wid,
))!;
const page = (await command(owner, {
  action: "page.create",
  workspaceId: wid,
  spaceId: space.id,
  title: "Guide",
})) as { id: string };
const table = (await command(owner, {
  action: "page.create",
  workspaceId: wid,
  spaceId: space.id,
  parentId: page.id,
  title: "Project",
  kind: "database",
})) as { id: string };
const a = (await command(owner, {
  action: "row.create",
  pageId: table.id,
  cells: { title: "First" },
})) as { id: string };
const b = (await command(owner, {
  action: "row.create",
  pageId: table.id,
  cells: { title: "Second", related: [a.id], notes: `Literal ID ${a.id}` },
})) as { id: string };
const db = await database(table.id);
await command(owner, {
  action: "database.update",
  pageId: table.id,
  version: db.version,
  fields: [
    ...db.fields,
    {
      id: "related",
      name: "Related",
      type: "relation",
      relationPage: table.id,
    },
    { id: "notes", name: "Notes", type: "text" },
  ],
  views: db.views,
});
const fid = id(),
  bytes = Buffer.from("Original binary content \0 ü");
mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid), bytes);
await run(
  "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
  fid,
  page.id,
  "notes.txt",
  "text/plain",
  bytes.length,
  owner.id,
);
const html = `<h2>My guide</h2><p><a href="/#page=${table.id}">Project</a><a href="/api/files/${fid}">Attachment</a></p>`;
await run(
  "UPDATE documents SET html=?,state=? WHERE page_id=?",
  html,
  htmlState(html),
  page.id,
);
await replaceRowDocument(a.id, "<h2>Rich record</h2>", owner.id);
await command(owner, { action: "row.snapshot", pageId: table.id, rowId: a.id });
await command(owner, {
  action: "row.template.save",
  pageId: table.id,
  rowId: b.id,
  name: "Related task",
});
await command(owner, { action: "page.snapshot", pageId: page.id });
await command(owner, {
  action: "comment.create",
  pageId: table.id,
  rowId: a.id,
  body: "Preserve discussion",
});
await command(owner, { action: "page.snapshot", pageId: table.id });
await command(owner, {
  action: "page.publish",
  pageId: page.id,
  enabled: true,
  includeChildren: true,
});
await command(owner, {
  action: "template.save",
  pageId: page.id,
  name: "Guide template",
});
await command(owner, {
  action: "template.save",
  pageId: table.id,
  name: "Database template",
});
await command(owner, { action: "favorite", pageId: page.id, value: true });
await command(owner, {
  action: "form.update",
  pageId: table.id,
  enabled: true,
  internal: false,
  anonymous: true,
  config: {
    title: "Restored form",
    requiredFields: ["title"],
    successMessage: "Received",
  },
});
await command(owner, {
  action: "space.create",
  workspaceId: wid,
  name: "Empty area",
  private: false,
});
let exported: Buffer;
test("ZIP round trip preserves nested content, binary files, relations, templates and versions with new identities", async () => {
  await run(
    "INSERT INTO shared_comments(id,page_id,name,body) VALUES(?,?,?,?)",
    id(),
    page.id,
    "Externer Gast",
    "Gastfeedback für das Archiv",
  );
  exported = await exportArchive(owner, wid);
  const destination = await createWorkspace(owner.id, "Restored");
  const result = await importArchive(owner, destination, exported);
  assert.equal(result.files, 1);
  assert.equal(result.spaces.length, 2);
  assert.ok(
    await one(
      "SELECT id FROM spaces WHERE workspace_id=? AND name=?",
      destination,
      "Empty area (Import)",
    ),
  );
  assert.equal(result.pages, 3);
  assert.equal(result.omittedRelations, 0);
  const copiedPage = (await one<Page>(
      "SELECT * FROM pages WHERE id=?",
      result.pageIds[page.id],
    ))!,
    copiedTable = (await one<Page>(
      "SELECT * FROM pages WHERE id=?",
      result.pageIds[table.id],
    ))!;
  assert.equal(copiedTable.parent_id, copiedPage.id);
  assert.equal(copiedPage.public_token, null);
  const guestComment = await one<{ body: string }>(
    "SELECT body FROM comments WHERE page_id=? AND body LIKE ?",
    copiedPage.id,
    "%Gastfeedback für das Archiv%",
  );
  assert.match(guestComment!.body, /Externer Gast \(Gast\)/);
  assert.equal(
    (await one<{ visibility: string }>(
      "SELECT visibility FROM spaces WHERE id=?",
      copiedPage.space_id,
    ))!.visibility,
    "private",
  );
  const importedTemplate = (await one<{
    id: string;
    visibility: string;
    payload: string;
  }>(
    "SELECT id,visibility,payload FROM templates WHERE workspace_id=? AND name='Guide template'",
    destination,
  ))!;
  assert.equal(importedTemplate.visibility, "private");
  assert.match(importedTemplate.payload, new RegExp(copiedTable.id));
  const dbTemplate = (await one<{ id: string; payload: string }>(
    "SELECT id,payload FROM templates WHERE workspace_id=? AND name='Database template'",
    destination,
  ))!;
  assert.equal(JSON.parse(dbTemplate.payload).rows.length, 2);
  const fromTemplate = (await command(owner, {
    action: "page.create",
    workspaceId: destination,
    spaceId: copiedTable.space_id,
    title: "Restored template instance",
    templateId: dbTemplate.id,
  })) as { id: string };
  const templateRows = await rows(fromTemplate.id);
  const templateFirst = templateRows.find((r) => r.cells.title === "First")!;
  const templateSecond = templateRows.find((r) => r.cells.title === "Second")!;
  assert.deepEqual(templateSecond.cells.related, [templateFirst.id]);
  assert.notEqual(
    templateFirst.id,
    (await rows(copiedTable.id)).find((r) => r.cells.title === "First")!.id,
  );
  assert.match(
    (await rowDocumentData(owner, fromTemplate.id, templateFirst.id)).html,
    /Rich record/,
  );
  assert.ok(
    await one("SELECT id FROM row_templates WHERE page_id=?", fromTemplate.id),
  );

  const form = (await one<{ enabled: number; anonymous: number }>(
    "SELECT enabled,anonymous FROM forms WHERE page_id=?",
    copiedTable.id,
  ))!;
  assert.equal(form.enabled, 0);
  assert.equal(form.anonymous, 1);
  const restoredForm = (await (await import("../lib/forms")).formSettings(
    copiedTable.id,
  ))!;
  assert.equal(restoredForm.config.title, "Restored form");
  assert.deepEqual(restoredForm.config.requiredFields, ["title"]);
  assert.ok(
    await one(
      "SELECT page_id FROM favorites WHERE user_id=? AND page_id=?",
      owner.id,
      copiedPage.id,
    ),
  );
  await run("INSERT INTO members VALUES(?,?,?)", destination, viewer.id, "editor");
  const target = (await one<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND title=?",
    destination,
    "Willkommen bei Flowplan",
  ))!;
  await assert.rejects(
    async () =>
      await command(viewer, {
        action: "template.apply",
        pageId: target.id,
        templateId: importedTemplate.id,
      }),
    /Private Vorlage/,
  );
  const copiedRows = await rows(copiedTable.id),
    first = copiedRows.find((r) => r.cells.title === "First")!,
    second = copiedRows.find((r) => r.cells.title === "Second")!;
  assert.notEqual(first.id, a.id);
  assert.deepEqual(second.cells.related, [first.id]);
  assert.equal(second.cells.notes, `Literal ID ${a.id}`);
  assert.match(
    (await rowDocumentData(owner, copiedTable.id, first.id)).html,
    /<h2>Rich record<\/h2>/,
  );
  assert.equal(
    (await rowDocumentData(owner, copiedTable.id, first.id)).snapshots.length,
    1,
  );
  assert.equal(
    (await database(copiedTable.id)).fields.find((f) => f.id === "related")!
      .relationPage,
    copiedTable.id,
  );
  const file = (await one<{ id: string }>(
    "SELECT id FROM files WHERE page_id=?",
    copiedPage.id,
  ))!;
  assert.notEqual(file.id, fid);
  assert.deepEqual(
    readFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", file.id)),
    bytes,
  );
  const doc = await pageData(owner, copiedPage.id);
  assert.match(doc.html!, new RegExp(`/api/files/${file.id}`));
  assert.match(doc.html!, new RegExp(copiedTable.id));
  const template = (await one<{ cells: string }>(
    "SELECT cells FROM row_templates WHERE page_id=?",
    copiedTable.id,
  ))!;
  assert.deepEqual(JSON.parse(template.cells).related, [first.id]);
  const comment = (await one<{ body: string; row_id: string }>(
    "SELECT body,row_id FROM comments WHERE page_id=?",
    copiedTable.id,
  ))!;
  assert.equal(comment.row_id, first.id);
  assert.match(comment.body, /Import · Archiver/);
  const snapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    copiedTable.id,
  ))!;
  await command(owner, {
    action: "row.delete",
    pageId: copiedTable.id,
    rowId: first.id,
  });
  await command(owner, {
    action: "snapshot.restore",
    pageId: copiedTable.id,
    snapshotId: snapshot.id,
  });
  assert.deepEqual(
    (await rows(copiedTable.id)).find((r) => r.id === second.id)!.cells.related,
    [first.id],
  );
  assert.equal(
    (await rows(copiedTable.id)).find((r) => r.id === first.id)!.cells.title,
    "First",
  );
  const restoredComment = (await one<{ body: string; row_id: string }>(
    "SELECT body,row_id FROM comments WHERE page_id=?",
    copiedTable.id,
  ))!;
  assert.equal(restoredComment.row_id, first.id);
  assert.match(restoredComment.body, /Preserve discussion/);
});
test("archive exports respect private page access and restore requires write membership", async () => {
  const privateSpace = (await command(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Secret",
    private: true,
  })) as { id: string };
  const secret = (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: privateSpace.id,
    title: "Do not export to reader",
  })) as { id: string };
  const entries = await readZip(await exportArchive(viewer, wid));
  const manifest = JSON.parse(entries.get("flowplan.json")!.toString());
  assert.equal(
    manifest.pages.some((p: Page) => p.id === secret.id),
    false,
  );
  await assert.rejects(importArchive(viewer, wid, exported), /Berechtigung/);
});
test("invalid checksums, tree cycles, unknown entries and late failures leave no partial imports", async () => {
  const beforePages = (await one<{ count: number }>(
      "SELECT count(*) count FROM pages",
    ))!.count,
    beforeFiles = readdirSync(
      join(process.env.FLOWPLAN_DATA_DIR!, "uploads"),
    ).sort();
  const entries = await readZip(exported),
    manifest = JSON.parse(entries.get("flowplan.json")!.toString());
  const damaged = new Map(entries);
  damaged.set("files/" + fid, Buffer.from("bad"));
  await assert.rejects(
    importArchive(owner, wid, await writeZip(damaged)),
    /Prüfsumme/,
  );
  const cyclic = structuredClone(manifest);
  cyclic.pages.find((p: Page) => p.id === page.id).parent_id = table.id;
  const cycleEntries = new Map(entries);
  cycleEntries.set("flowplan.json", Buffer.from(JSON.stringify(cyclic)));
  await assert.rejects(
    importArchive(owner, wid, await writeZip(cycleEntries)),
    /Seitenbaum/,
  );
  const unknown = new Map(entries);
  unknown.set("unknown.txt", Buffer.from("x"));
  await assert.rejects(
    importArchive(owner, wid, await writeZip(unknown)),
    /unbekannte/,
  );
  const badHtml = structuredClone(manifest);
  badHtml.pages.find((p: Page) => p.id === table.id).snapshots[0].html =
    "not json";
  const badEntries = new Map(entries);
  badEntries.set("flowplan.json", Buffer.from(JSON.stringify(badHtml)));
  await assert.rejects(
    importArchive(owner, wid, await writeZip(badEntries)),
    /Datenbankversion/,
  );
  const brokenTemplate = structuredClone(manifest);
  brokenTemplate.templates[0].payload = "broken";
  const lateEntries = new Map(entries);
  lateEntries.set("flowplan.json", Buffer.from(JSON.stringify(brokenTemplate)));
  await assert.rejects(
    importArchive(owner, wid, await writeZip(lateEntries)),
    /Seitenvorlage/,
  );
  assert.equal(
    (await one<{ count: number }>("SELECT count(*) count FROM pages"))!.count,
    beforePages,
  );
  assert.deepEqual(
    readdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads")).sort(),
    beforeFiles,
  );
  await assert.rejects(readZip(Buffer.from("not a zip")), /Ungültige ZIP/);
});

test("archived database templates retain self-relations after the source page is removed", async () => {
  const sourceWorkspace = await createWorkspace(owner.id, "Template-only archive");
  const space = (await one<{ id: string }>(
    "SELECT id FROM spaces WHERE workspace_id=?",
    sourceWorkspace,
  ))!;
  const source = (await command(owner, {
    action: "page.create",
    workspaceId: sourceWorkspace,
    spaceId: space.id,
    title: "Removed source",
    kind: "database",
  })) as { id: string };
  const schema = await database(source.id);
  await command(owner, {
    action: "database.update",
    pageId: source.id,
    version: schema.version,
    fields: [
      ...schema.fields,
      {
        id: "self",
        name: "Related",
        type: "relation",
        relationPage: source.id,
      },
    ],
    views: schema.views,
  });
  const first = (await command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "First archived template row" },
  })) as { id: string };
  await command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "Second archived template row", self: [first.id] },
  });
  await replaceRowDocument(
    first.id,
    `<p>Original source: ${source.id}</p><p><a href="/#page=${source.id}">This project</a></p>`,
    owner.id,
  );
  await command(owner, {
    action: "template.save",
    pageId: source.id,
    name: "Surviving template",
  });
  await run("DELETE FROM pages WHERE id=?", source.id);
  const bytes = await exportArchive(owner, sourceWorkspace);
  const targetWorkspace = await createWorkspace(owner.id, "Template destination");
  await importArchive(owner, targetWorkspace, bytes);
  const template = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    targetWorkspace,
    "Surviving template",
  ))!;
  const targetSpace = (await one<{ id: string }>(
    "SELECT id FROM spaces WHERE workspace_id=?",
    targetWorkspace,
  ))!;
  const target = (await command(owner, {
    action: "page.create",
    workspaceId: targetWorkspace,
    spaceId: targetSpace.id,
    title: "Restored surviving template",
    templateId: template.id,
  })) as { id: string };
  const restoredRows = await rows(target.id);
  const restoredFirst = restoredRows.find(
    (r) => r.cells.title === "First archived template row",
  )!;
  assert.deepEqual(
    restoredRows.find((r) => r.cells.title === "Second archived template row")!
      .cells.self,
    [restoredFirst.id],
  );
  assert.equal(
    (await database(target.id)).fields.find((f) => f.id === "self")!.relationPage,
    target.id,
  );
  const html = (await rowDocumentData(owner, target.id, restoredFirst.id)).html;
  assert.match(html, new RegExp(`href="/#page=${target.id}"`));
  assert.match(html, new RegExp(`Original source: ${source.id}`));
});
test("archives with unusable linked database blocks restore them as placeholders", async () => {
  const sourceWorkspace = await createWorkspace(owner.id, "Broken linked blocks");
  const space = (await one<{ id: string }>(
    "SELECT id FROM spaces WHERE workspace_id=?",
    sourceWorkspace,
  ))!;
  const source = (await command(owner, {
    action: "page.create",
    workspaceId: sourceWorkspace,
    spaceId: space.id,
    title: "Linked source",
    kind: "database",
  })) as { id: string };
  const row = (await command(owner, {
    action: "row.create",
    pageId: source.id,
    cells: { title: "Row with embed" },
  })) as { id: string };
  const doc = (await command(owner, {
    action: "page.create",
    workspaceId: sourceWorkspace,
    spaceId: space.id,
    title: "Host",
  })) as { id: string };
  const block = (views: string) =>
    `<div data-linked-database="${id()}" data-linked-source="${source.id}" data-linked-views="${views}" data-linked-version="1">Linked</div>`;
  const valid = JSON.stringify((await database(source.id)).views).replaceAll(
    '"',
    "&quot;",
  );
  // An empty views list, as a block without stored views is parsed.
  await replaceRowDocument(row.id, `<p>Row text</p>${block("[]")}`, owner.id);
  await command(owner, {
    action: "document.sync",
    pageId: doc.id,
    generation: ((await pageData(owner, doc.id)) as { generation: string }).generation,
    update: Buffer.from(
      htmlState(`<p>Host text</p>${block("[")}${block(valid)}`),
    ).toString("base64"),
  });
  const target = await createWorkspace(owner.id, "Broken linked destination");
  const result = await importArchive(
    owner,
    target,
    await exportArchive(owner, sourceWorkspace),
  );
  const newSource = result.pageIds[source.id],
    newDoc = result.pageIds[doc.id];
  const host = ((await pageData(owner, newDoc)) as { html: string }).html;
  assert.match(host, /Host text/);
  const blocks = [...host.matchAll(/<div[^>]*data-linked-database[^>]*>/g)].map(
    (m) => m[0],
  );
  assert.equal(blocks.length, 2);
  assert.doesNotMatch(blocks[0], /data-linked-source|data-linked-views/);
  assert.match(blocks[1], new RegExp(`data-linked-source="${newSource}"`));
  const restoredRow = (await rows(newSource))[0];
  const rowHtml = (await rowDocumentData(owner, newSource, restoredRow.id)).html;
  assert.match(rowHtml, /Row text/);
  assert.match(rowHtml, /data-linked-database/);
  assert.doesNotMatch(rowHtml, new RegExp(source.id));
});
