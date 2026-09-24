import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coverSchema,
  appearanceSchema,
  pageAppearance,
} from "../lib/page-appearance";
import {
  defaultGallery,
  galleryImage,
  gallerySchema,
} from "../lib/database-gallery";
import type { Identity, Row, Field } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-covers-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap, pageData, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { publicFile } = await import("../lib/publication");
const { exportArchive, importArchive, readZip, writeZip } =
  await import("../lib/archive");
const { replaceRowDocument } = await import("../lib/row-documents");
function user(name: string): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@test.invalid`,
  );
  return {
    id: uid,
    name,
    email: `${name}@test.invalid`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  viewer = user("viewer"),
  wid = createWorkspace(owner.id, "Covers"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, as = owner): any =>
  command(as, body);
const create = (kind = "document") =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Cover page",
    kind,
  }).id as string;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
function file(pid: string, mime = "image/png") {
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fid), png);
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    pid,
    "Cover.png",
    mime,
    png.length,
    owner.id,
  );
  return `/api/files/${fid}`;
}
const data = (pid: string): any => pageData(owner, pid);
const set = (pid: string, cover: string, position = 50) =>
  act({
    action: "page.update",
    pageId: pid,
    coverBase: pageAppearance(data(pid).page),
    patch: { cover, cover_position: position },
  });
test("cover schemas reject arbitrary URLs and invalid positions; writes require own raster images, rights, unlocked pages and current cover state", () => {
  for (const value of [
    "https://example.com/image.png",
    "/api/files/not-an-id",
    "/api/files/" + id() + "?x=1",
    "url(javascript:alert(1))",
  ])
    assert.equal(coverSchema.safeParse(value).success, false);
  assert.equal(
    appearanceSchema.safeParse({ cover: "", coverPosition: 101 }).success,
    false,
  );
  const p = create(),
    foreign = create(),
    url = file(p),
    other = file(foreign),
    svg = file(p, "image/svg+xml");
  const count = () =>
    one<{ n: number }>("SELECT COUNT(*) n FROM snapshots WHERE page_id=?", p)!
      .n;
  for (const cover of [other, svg, `/api/files/${id()}`])
    assert.throws(() => set(p, cover), /Bild dieser Seite/);
  assert.equal(count(), 0);
  assert.throws(
    () =>
      act({ action: "page.update", pageId: p, patch: { cover: url } }, viewer),
    /Berechtigung/,
  );
  set(p, url, 23);
  assert.equal(data(p).page.cover_position, 23);
  assert.equal(count(), 1);
  assert.throws(
    () =>
      act({
        action: "page.update",
        pageId: p,
        coverBase: { cover: "", coverPosition: 50 },
        patch: { cover: "" },
      }),
    /inzwischen/,
  );
  assert.equal(count(), 1);
  act({ action: "page.update", pageId: p, patch: { locked: true } });
  assert.throws(() => set(p, ""), /gesperrt/);
  assert.equal(data(p).page.cover, url);
});
test("only the active cover is public; replacement, removal and link revocation remove access immediately", () => {
  const p = create(),
    a = file(p),
    b = file(p),
    link = act({
      action: "share.create",
      pageId: p,
      name: "Cover",
      role: "viewer",
    }).token;
  assert.throws(
    () => publicFile(link, a.split("/").at(-1)!),
    /nicht veröffentlicht/,
  );
  set(p, a);
  assert.equal(publicFile(link, a.split("/").at(-1)!).page_id, p);
  set(p, b);
  assert.throws(
    () => publicFile(link, a.split("/").at(-1)!),
    /nicht veröffentlicht/,
  );
  assert.equal(publicFile(link, b.split("/").at(-1)!).page_id, p);
  set(p, "");
  assert.throws(
    () => publicFile(link, b.split("/").at(-1)!),
    /nicht veröffentlicht/,
  );
  set(p, b);
  act({ action: "share.revoke", pageId: p, token: link });
  assert.throws(() => publicFile(link, b.split("/").at(-1)!), /nicht gefunden/);
});
test("covers, focal positions and gallery preferences survive independent copies, frozen templates, ZIP and snapshot restoration", async () => {
  const p = create("database"),
    url = file(p),
    d = database(p);
  const fields: Field[] = [
    ...d.fields,
    { id: "photo", name: "Bild", type: "files" },
  ];
  act({
    action: "database.update",
    pageId: p,
    version: d.version,
    fields,
    views: [
      {
        id: "gallery",
        name: "Galerie",
        type: "gallery",
        filters: [],
        sorts: [],
        gallery: {
          cover: "field",
          fieldId: "photo",
          fit: "contain",
          size: "large",
        },
      },
    ],
  });
  const row = act({
    action: "row.create",
    pageId: p,
    cells: { title: "Bild", photo: url },
  }).id;
  replaceRowDocument(row, `<p><img src="${url}" alt="Bild"></p>`, owner.id);
  set(p, url, 77);
  act({ action: "page.snapshot", pageId: p });
  const check = (pid: string) => {
    const current = data(pid);
    assert.equal(current.page.cover_position, 77);
    assert.notEqual(current.page.cover, url);
    assert.deepEqual(current.database.views[0].gallery, {
      cover: "field",
      fieldId: "photo",
      fit: "contain",
      size: "large",
    });
    assert.equal(current.rows[0].cells.photo, current.page.cover);
    assert.equal(current.rows[0].preview.image, current.page.cover);
    assert.ok(current.images.some((f: any) => f.url === current.page.cover));
    assert.deepEqual(
      readFileSync(
        join(
          process.env.FLOWPLAN_DATA_DIR!,
          "uploads",
          current.page.cover.split("/").at(-1)!,
        ),
      ),
      png,
    );
  };
  check(act({ action: "page.duplicate", pageId: p }).id);
  const template = act({
    action: "template.save",
    pageId: p,
    name: "Cover template",
  }).id;
  const templatePage = () =>
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Cover template copy",
      templateId: template,
    }).id;
  check(templatePage());
  const archive = await exportArchive(owner, wid),
    destination = createWorkspace(owner.id, "Cover restore");
  const imported = await importArchive(owner, destination, archive),
    restored = imported.pageIds[p];
  check(restored);
  const snapshot = all<{ id: string; appearance: string }>(
    "SELECT id,appearance FROM snapshots WHERE page_id=?",
    restored,
  ).find((s) => JSON.parse(s.appearance).coverPosition === 77)!;
  set(restored, "#dce7f5", 50);
  act({
    action: "snapshot.restore",
    pageId: restored,
    snapshotId: snapshot.id,
  });
  check(restored);
  const importedTemplate = one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    destination,
    "Cover template",
  )!.id;
  check(
    act({
      action: "page.create",
      workspaceId: destination,
      spaceId: imported.spaces[0],
      title: "Imported template",
      templateId: importedTemplate,
    }).id,
  );
  set(p, "#cdded8");
  writeFileSync(
    join(process.env.FLOWPLAN_DATA_DIR!, "uploads", url.split("/").at(-1)!),
    Buffer.from("changed original"),
  );
  check(templatePage());
  // Applying a template backs up the previous cover and restores it with its content.
  const target = create("database"),
    old = file(target);
  set(target, old, 12);
  const applied = act({
    action: "template.apply",
    pageId: target,
    templateId: template,
    version: database(target).version,
  });
  check(target);
  act({
    action: "snapshot.restore",
    pageId: target,
    snapshotId: applied.snapshotId,
  });
  assert.equal(data(target).page.cover, old);
  assert.equal(data(target).page.cover_position, 12);
});
test("gallery selects only authorized image files, persists source choices and clears removed source properties", () => {
  const p = create("database"),
    url = file(p),
    d = database(p);
  const row = act({
    action: "row.create",
    pageId: p,
    cells: { title: "Image" },
  }).id;
  replaceRowDocument(row, `<p><img src="${url}"></p>`, owner.id);
  const r = data(p).rows[0] as Row;
  assert.equal(galleryImage(r, defaultGallery, d.fields, new Set([url])), url);
  assert.equal(galleryImage(r, defaultGallery, d.fields, new Set()), undefined);
  assert.equal(
    gallerySchema.safeParse({ ...defaultGallery, cover: "field" }).success,
    false,
  );
  const field: Field = { id: "photo", name: "Bild", type: "files" },
    g = {
      cover: "field" as const,
      fieldId: "photo",
      fit: "contain" as const,
      size: "small" as const,
    };
  assert.equal(
    galleryImage({ ...r, cells: { photo: url } }, g, [field], new Set([url])),
    url,
  );
  assert.equal(
    galleryImage(
      { ...r, cells: { photo: url } },
      g,
      [{ ...field, type: "text" }],
      new Set([url]),
    ),
    undefined,
  );
  const views = [{ ...d.views[0], type: "gallery", gallery: g }];
  act({
    action: "database.update",
    pageId: p,
    version: d.version,
    fields: [...d.fields, field],
    views,
  });
  act({
    action: "database.update",
    pageId: p,
    version: database(p).version,
    fields: d.fields,
    views,
  });
  assert.equal(database(p).views[0].gallery?.cover, "none");
});

test("document templates and archived cover snapshots retain images, while foreign cover references roll back the entire import", async () => {
  const p = create(),
    other = create(),
    url = file(p),
    foreign = file(other);
  set(p, url, 19);
  const template = act({
    action: "template.save",
    pageId: p,
    name: "Document image cover",
  }).id;
  const copy = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Document copy",
    templateId: template,
  }).id;
  assert.equal(data(copy).page.cover_position, 19);
  assert.notEqual(data(copy).page.cover, url);
  const archive = await exportArchive(owner, wid),
    entries = await readZip(archive),
    manifest = JSON.parse(entries.get("flowplan.json")!.toString());
  const destination = createWorkspace(owner.id, "Document cover import");
  const imported = await importArchive(owner, destination, archive);
  const tid = one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    destination,
    "Document image cover",
  )!.id;
  const restored = act({
    action: "page.create",
    workspaceId: destination,
    spaceId: imported.spaces[0],
    title: "Document restored",
    templateId: tid,
  }).id;
  assert.equal(data(restored).page.cover_position, 19);
  assert.deepEqual(
    readFileSync(
      join(
        process.env.FLOWPLAN_DATA_DIR!,
        "uploads",
        data(restored).page.cover.split("/").at(-1)!,
      ),
    ),
    png,
  );
  const legacy = structuredClone(manifest);
  for (const archived of legacy.pages) {
    delete archived.cover_position;
    for (const snapshot of archived.snapshots) delete snapshot.appearance;
  }
  const legacyEntries = new Map(entries);
  legacyEntries.set("flowplan.json", Buffer.from(JSON.stringify(legacy)));
  const older = await importArchive(
    owner,
    destination,
    await writeZip(legacyEntries),
  );
  assert.equal(data(older.pageIds[p]).page.cover_position, 50);
  assert.ok(
    all<{ appearance: string | null }>(
      "SELECT appearance FROM snapshots WHERE page_id=?",
      older.pageIds[p],
    ).every((snapshot) => snapshot.appearance === null),
  );
  manifest.pages.find((page: { id: string }) => page.id === p).cover = foreign;
  entries.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const before = one<{ n: number }>(
    "SELECT COUNT(*) n FROM pages WHERE workspace_id=?",
    destination,
  )!.n;
  await assert.rejects(
    importArchive(owner, destination, await writeZip(entries)),
    /Bild dieser Seite/,
  );
  assert.equal(
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM pages WHERE workspace_id=?",
      destination,
    )!.n,
    before,
  );
});
test("page image icons require own raster images and survive copies, publication and ZIP restoration", async () => {
  const { pageIconSchema } = await import("../lib/page-appearance");
  assert.equal(pageIconSchema.safeParse("🚀").success, true);
  assert.equal(pageIconSchema.safeParse("file").success, true);
  for (const bad of [
    "/etc/passwd",
    "/api/files/x",
    "https://example.com/i.png",
  ])
    assert.equal(pageIconSchema.safeParse(bad).success, false, bad);
  const p = create(),
    other = create(),
    icon = file(p),
    foreign = file(other),
    text = file(p, "text/plain");
  const setIcon = (value: string, as = owner) =>
    act({ action: "page.update", pageId: p, patch: { icon: value } }, as);
  assert.throws(() => setIcon(foreign), /Seitensymbol/);
  assert.throws(() => setIcon(text), /Seitensymbol/);
  assert.throws(() => setIcon(icon, viewer), /Berechtigung/);
  setIcon(icon);
  assert.equal(data(p).page.icon, icon);

  const link = act({
    action: "share.create",
    pageId: p,
    name: "Icon",
    role: "viewer",
  }).token;
  const iconId = icon.split("/").at(-1)!;
  assert.equal(publicFile(link, iconId).page_id, p);
  setIcon("📘");
  assert.throws(() => publicFile(link, iconId), /nicht veröffentlicht/);
  setIcon(icon);

  const copy = act({ action: "page.duplicate", pageId: p }).id;
  const copiedIcon = data(copy).page.icon as string;
  assert.match(copiedIcon, /^\/api\/files\//);
  assert.notEqual(copiedIcon, icon);
  assert.equal(
    one<{ page_id: string }>(
      "SELECT page_id FROM files WHERE id=?",
      copiedIcon.split("/").at(-1)!,
    )?.page_id,
    copy,
  );

  const archive = await exportArchive(owner, wid),
    destination = createWorkspace(owner.id, "Icon restore");
  const imported = await importArchive(owner, destination, archive);
  const restoredIcon = data(imported.pageIds[p]).page.icon as string;
  assert.match(restoredIcon, /^\/api\/files\//);
  assert.equal(
    one<{ page_id: string }>(
      "SELECT page_id FROM files WHERE id=?",
      restoredIcon.split("/").at(-1)!,
    )?.page_id,
    imported.pageIds[p],
  );
});
