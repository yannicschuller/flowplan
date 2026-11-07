import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentPreview } from "../lib/document-preview";
import { defaultFeed } from "../lib/database-feed";
import { queryRows } from "../lib/database";
import { view as viewSchema } from "../lib/database-schema";
import type { Field, View, Identity, Row } from "../lib/types";
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
];
const view: View = {
  id: "feed",
  name: "Feed",
  type: "feed",
  filters: [],
  sorts: [],
  feed: { ...defaultFeed, content: "compact" },
  hiddenFields: ["status"],
};
test("read-only previews sanitize legacy HTML, retain rich media and disable tasks without changing stored content", () => {
  const source =
    '<h2>Release</h2><p>co<strong>de</strong> &amp; &#x1f600;</p><script>alert(1)</script><img src="/api/files/demo" onerror="alert(1)"><input type="checkbox" checked><input type="text" value="injected"><a href="javascript:alert(1)">Link</a><iframe src="https://evil.invalid"></iframe><video src="/api/files/video" autoplay></video>';
  const p = documentPreview(source);
  assert.match(p.html, /<h2>Release<\/h2>/);
  assert.match(p.html, /<strong>de<\/strong>/);
  assert.doesNotMatch(
    p.html,
    /script|onerror|javascript|evil.invalid|autoplay|type="text"/,
  );
  assert.match(p.html, /type="checkbox" disabled checked/);
  assert.match(p.html, /preload="none"/);
  assert.match(p.text, /Release code & 😀/);
  assert.equal(p.hasContent, true);
  assert.equal(documentPreview("<p><br></p>").hasContent, false);
  assert.equal(documentPreview('<img src="/api/files/demo">').hasContent, true);
  assert.equal(
    documentPreview("Plain <angle> & text\nNext").text,
    "Plain <angle> & text Next",
  );
});
test("feed view schema validates preferences and body search combines with filters, sorts and manual order", () => {
  assert.deepEqual(viewSchema.parse(view), view);
  assert.equal(
    viewSchema.safeParse({
      ...view,
      feed: { ...defaultFeed, content: "execute" },
    }).success,
    false,
  );
  const make = (id: string, status: string, body: string): Row => ({
    id,
    page_id: "p",
    cells: { title: id, status },
    position: 0,
    version: 1,
    created_at: "",
    updated_at: "",
    created_by: "",
    updated_by: "",
    preview: documentPreview(body),
  });
  const data = [
    make("Alpha", "Open", "<p>Body needle</p>"),
    make("Beta", "Done", "needle"),
    make("Gamma", "Open", "<p>More needle</p>"),
  ];
  assert.deepEqual(
    queryRows(
      data,
      fields,
      {
        ...view,
        filters: [{ field: "status", op: "eq", value: "Open" }],
        rowOrder: ["Gamma", "Alpha"],
      },
      "needle",
    ).map((r) => r.id),
    ["Gamma", "Alpha"],
  );
  assert.deepEqual(
    queryRows(
      data,
      fields,
      { ...view, sorts: [{ field: "title", direction: "desc" }] },
      "needle",
    ).map((r) => r.id),
    ["Gamma", "Beta", "Alpha"],
  );
});
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-feed-"));
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap, pageData } =
  await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { replaceRowDocument } = await import("../lib/row-documents");
const { exportArchive, importArchive } = await import("../lib/archive");
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
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  stranger = await user("stranger"),
  wid = await createWorkspace(owner.id, "Feed"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, as = owner): Promise<any> =>
  await command(as, body);
async function fixture() {
  const page = (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    kind: "database",
    title: "Feed database",
  })).id;
  await act({
    action: "database.update",
    pageId: page,
    version: (await database(page)).version,
    fields,
    views: [view],
  });
  const row = (await act({
    action: "row.create",
    pageId: page,
    cells: { title: "Release", status: "Open" },
  })).id;
  await replaceRowDocument(
    row,
    "<h2>Canonical document</h2><p>Searchable body</p>",
    owner.id,
  );
  return { page, row };
}
test("API previews prefer canonical documents, respect page permissions and never create or edit row documents on read", async () => {
  const { page, row } = await fixture();
  await run("UPDATE rows SET content=? WHERE id=?", "Stale row text", row);
  const legacy = (await act({
    action: "row.create",
    pageId: page,
    cells: { title: "Legacy" },
  })).id;
  await run(
    "UPDATE rows SET content=? WHERE id=?",
    '<p>Legacy</p><img src="x" onerror="alert(1)">',
    legacy,
  );
  const count = async () =>
    (await one<{ n: number }>("SELECT COUNT(*) n FROM row_documents"))!.n;
  const before = await count();
  const data = (await pageData(viewer, page)) as any;
  assert.match(
    data.rows.find((r: Row) => r.id === row).preview.html,
    /Canonical document/,
  );
  assert.doesNotMatch(
    data.rows.find((r: Row) => r.id === legacy).preview.html,
    /onerror/,
  );
  assert.equal(await count(), before);
  assert.equal((await rows(page)).find((r) => r.id === row)!.content, "Stale row text");
  await assert.rejects(async () => await pageData(stranger, page), /Berechtigung/);
  const update = {
    action: "database.update",
    pageId: page,
    version: (await database(page)).version,
    fields,
    views: [{ ...view, feed: defaultFeed }],
  };
  await assert.rejects(async () => await act(update, viewer), /Berechtigung/);
  await assert.rejects(async () => await act({ ...update, version: 0 }), /zwischenzeitlich/);
  await act({ action: "page.update", pageId: page, patch: { locked: true } });
  await assert.rejects(async () => await act(update), /gesperrt/);
  await act({ action: "page.delete", pageId: page });
  await assert.rejects(async () => await pageData(owner, page), /nicht gefunden/);
});
test("feed preferences, rich previews, property visibility and contents survive copies, templates, ZIP and snapshots", async () => {
  const { page } = await fixture();
  const check = async (target: string) => {
    const d = (await pageData(owner, target)) as any;
    assert.deepEqual(d.database.views[0].feed, view.feed);
    assert.deepEqual(d.database.views[0].hiddenFields, ["status"]);
    assert.equal(d.rows[0].preview.text, "Canonical document Searchable body");
  };
  await act({ action: "page.snapshot", pageId: page });
  await check((await act({ action: "page.duplicate", pageId: page })).id);
  const template = (await act({
    action: "template.save",
    pageId: page,
    name: "Feed template",
  })).id;
  await check(
    (await act({
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Feed copy",
      templateId: template,
    })).id,
  );
  const destination = await createWorkspace(owner.id, "Feed restore");
  const imported = await importArchive(
    owner,
    destination,
    await exportArchive(owner, wid),
  );
  const restored = imported.pageIds[page];
  await check(restored);
  const snapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored,
  ))!.id;
  await act({
    action: "database.update",
    pageId: restored,
    version: (await database(restored)).version,
    fields,
    views: [{ ...view, feed: defaultFeed }],
  });
  await act({ action: "snapshot.restore", pageId: restored, snapshotId: snapshot });
  await check(restored);
});

test("previews come from a cache keyed by the source and are copies", () => {
  const first = documentPreview("<p>Gleich</p>");
  (first as { text: string }).text = "verändert";
  assert.equal(documentPreview("<p>Gleich</p>").text, "Gleich");
  assert.notEqual(documentPreview(""), documentPreview(""));
  assert.deepEqual(documentPreview(""), documentPreview(""));
  const long = `<p>${"x".repeat(5000)}</p>`;
  assert.equal(documentPreview(long).text.length, 5000);
});
