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
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  viewer = user("viewer"),
  stranger = user("stranger"),
  wid = createWorkspace(owner.id, "Feed"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, as = owner): any =>
  command(as, body);
function fixture() {
  const page = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    kind: "database",
    title: "Feed database",
  }).id;
  act({
    action: "database.update",
    pageId: page,
    version: database(page).version,
    fields,
    views: [view],
  });
  const row = act({
    action: "row.create",
    pageId: page,
    cells: { title: "Release", status: "Open" },
  }).id;
  replaceRowDocument(
    row,
    "<h2>Canonical document</h2><p>Searchable body</p>",
    owner.id,
  );
  return { page, row };
}
test("API previews prefer canonical documents, respect page permissions and never create or edit row documents on read", () => {
  const { page, row } = fixture();
  run("UPDATE rows SET content=? WHERE id=?", "Stale row text", row);
  const legacy = act({
    action: "row.create",
    pageId: page,
    cells: { title: "Legacy" },
  }).id;
  run(
    "UPDATE rows SET content=? WHERE id=?",
    '<p>Legacy</p><img src="x" onerror="alert(1)">',
    legacy,
  );
  const count = () =>
    one<{ n: number }>("SELECT COUNT(*) n FROM row_documents")!.n;
  const before = count();
  const data = pageData(viewer, page) as any;
  assert.match(
    data.rows.find((r: Row) => r.id === row).preview.html,
    /Canonical document/,
  );
  assert.doesNotMatch(
    data.rows.find((r: Row) => r.id === legacy).preview.html,
    /onerror/,
  );
  assert.equal(count(), before);
  assert.equal(rows(page).find((r) => r.id === row)!.content, "Stale row text");
  assert.throws(() => pageData(stranger, page), /Berechtigung/);
  const update = {
    action: "database.update",
    pageId: page,
    version: database(page).version,
    fields,
    views: [{ ...view, feed: defaultFeed }],
  };
  assert.throws(() => act(update, viewer), /Berechtigung/);
  assert.throws(() => act({ ...update, version: 0 }), /zwischenzeitlich/);
  act({ action: "page.update", pageId: page, patch: { locked: true } });
  assert.throws(() => act(update), /gesperrt/);
  act({ action: "page.delete", pageId: page });
  assert.throws(() => pageData(owner, page), /nicht gefunden/);
});
test("feed preferences, rich previews, property visibility and contents survive copies, templates, ZIP and snapshots", async () => {
  const { page } = fixture();
  const check = (target: string) => {
    const d = pageData(owner, target) as any;
    assert.deepEqual(d.database.views[0].feed, view.feed);
    assert.deepEqual(d.database.views[0].hiddenFields, ["status"]);
    assert.equal(d.rows[0].preview.text, "Canonical document Searchable body");
  };
  act({ action: "page.snapshot", pageId: page });
  check(act({ action: "page.duplicate", pageId: page }).id);
  const template = act({
    action: "template.save",
    pageId: page,
    name: "Feed template",
  }).id;
  check(
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Feed copy",
      templateId: template,
    }).id,
  );
  const destination = createWorkspace(owner.id, "Feed restore");
  const imported = await importArchive(
    owner,
    destination,
    await exportArchive(owner, wid),
  );
  const restored = imported.pageIds[page];
  check(restored);
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored,
  )!.id;
  act({
    action: "database.update",
    pageId: restored,
    version: database(restored).version,
    fields,
    views: [{ ...view, feed: defaultFeed }],
  });
  act({ action: "snapshot.restore", pageId: restored, snapshotId: snapshot });
  check(restored);
});
