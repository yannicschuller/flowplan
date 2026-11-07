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
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run(
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
const owner = await user("owner"),
  viewer = await user("viewer"),
  wid = await createWorkspace(owner.id, "Covers"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, as = owner): Promise<any> =>
  await command(as, body);
const create = async (kind = "document") =>
  (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Cover page",
    kind,
  })).id as string;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
async function file(pid: string, mime = "image/png") {
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fid), png);
  await run(
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
const data = async (pid: string): Promise<any> => await pageData(owner, pid);
const set = async (pid: string, cover: string, position = 50) =>
  await act({
    action: "page.update",
    pageId: pid,
    coverBase: pageAppearance((await data(pid)).page),
    patch: { cover, cover_position: position },
  });
test("cover schemas reject arbitrary URLs and invalid positions; writes require own raster images, rights, unlocked pages and current cover state", async () => {
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
  const p = await create(),
    foreign = await create(),
    url = await file(p),
    other = await file(foreign),
    svg = await file(p, "image/svg+xml");
  const count = async () =>
    (await one<{ n: number }>("SELECT COUNT(*) n FROM snapshots WHERE page_id=?", p))!
      .n;
  for (const cover of [other, svg, `/api/files/${id()}`])
    await assert.rejects(async () => await set(p, cover), /Bild dieser Seite/);
  assert.equal(await count(), 0);
  await assert.rejects(
    async () =>
      await act({ action: "page.update", pageId: p, patch: { cover: url } }, viewer),
    /Berechtigung/,
  );
  await set(p, url, 23);
  assert.equal((await data(p)).page.cover_position, 23);
  assert.equal(await count(), 1);
  await assert.rejects(
    async () =>
      await act({
        action: "page.update",
        pageId: p,
        coverBase: { cover: "", coverPosition: 50 },
        patch: { cover: "" },
      }),
    /inzwischen/,
  );
  assert.equal(await count(), 1);
  await act({ action: "page.update", pageId: p, patch: { locked: true } });
  await assert.rejects(async () => await set(p, ""), /gesperrt/);
  assert.equal((await data(p)).page.cover, url);
});
test("only the active cover is public; replacement, removal and link revocation remove access immediately", async () => {
  const p = await create(),
    a = await file(p),
    b = await file(p),
    link = (await act({
      action: "share.create",
      pageId: p,
      name: "Cover",
      role: "viewer",
    })).token;
  await assert.rejects(
    async () => await publicFile(link, a.split("/").at(-1)!),
    /nicht veröffentlicht/,
  );
  await set(p, a);
  assert.equal((await publicFile(link, a.split("/").at(-1)!)).page_id, p);
  await set(p, b);
  await assert.rejects(
    async () => await publicFile(link, a.split("/").at(-1)!),
    /nicht veröffentlicht/,
  );
  assert.equal((await publicFile(link, b.split("/").at(-1)!)).page_id, p);
  await set(p, "");
  await assert.rejects(
    async () => await publicFile(link, b.split("/").at(-1)!),
    /nicht veröffentlicht/,
  );
  await set(p, b);
  await act({ action: "share.revoke", pageId: p, token: link });
  await assert.rejects(async () => await publicFile(link, b.split("/").at(-1)!), /nicht gefunden/);
});
test("covers, focal positions and gallery preferences survive independent copies, frozen templates, ZIP and snapshot restoration", async () => {
  const p = await create("database"),
    url = await file(p),
    d = await database(p);
  const fields: Field[] = [
    ...d.fields,
    { id: "photo", name: "Bild", type: "files" },
  ];
  await act({
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
  const row = (await act({
    action: "row.create",
    pageId: p,
    cells: { title: "Bild", photo: url },
  })).id;
  await replaceRowDocument(row, `<p><img src="${url}" alt="Bild"></p>`, owner.id);
  await set(p, url, 77);
  await act({ action: "page.snapshot", pageId: p });
  const check = async (pid: string) => {
    const current = await data(pid);
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
  await check((await act({ action: "page.duplicate", pageId: p })).id);
  const template = (await act({
    action: "template.save",
    pageId: p,
    name: "Cover template",
  })).id;
  const templatePage = async () =>
    (await act({
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Cover template copy",
      templateId: template,
    })).id;
  await check(await templatePage());
  const archive = await exportArchive(owner, wid),
    destination = await createWorkspace(owner.id, "Cover restore");
  const imported = await importArchive(owner, destination, archive),
    restored = imported.pageIds[p];
  await check(restored);
  const snapshot = (await all<{ id: string; appearance: string }>(
    "SELECT id,appearance FROM snapshots WHERE page_id=?",
    restored,
  )).find((s) => JSON.parse(s.appearance).coverPosition === 77)!;
  await set(restored, "#dce7f5", 50);
  await act({
    action: "snapshot.restore",
    pageId: restored,
    snapshotId: snapshot.id,
  });
  await check(restored);
  const importedTemplate = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    destination,
    "Cover template",
  ))!.id;
  await check(
    (await act({
      action: "page.create",
      workspaceId: destination,
      spaceId: imported.spaces[0],
      title: "Imported template",
      templateId: importedTemplate,
    })).id,
  );
  await set(p, "#cdded8");
  writeFileSync(
    join(process.env.FLOWPLAN_DATA_DIR!, "uploads", url.split("/").at(-1)!),
    Buffer.from("changed original"),
  );
  await check(await templatePage());
  // Applying a template backs up the previous cover and restores it with its content.
  const target = await create("database"),
    old = await file(target);
  await set(target, old, 12);
  const applied = await act({
    action: "template.apply",
    pageId: target,
    templateId: template,
    version: (await database(target)).version,
  });
  await check(target);
  await act({
    action: "snapshot.restore",
    pageId: target,
    snapshotId: applied.snapshotId,
  });
  assert.equal((await data(target)).page.cover, old);
  assert.equal((await data(target)).page.cover_position, 12);
});
test("gallery selects only authorized image files, persists source choices and clears removed source properties", async () => {
  const p = await create("database"),
    url = await file(p),
    d = await database(p);
  const row = (await act({
    action: "row.create",
    pageId: p,
    cells: { title: "Image" },
  })).id;
  await replaceRowDocument(row, `<p><img src="${url}"></p>`, owner.id);
  const r = (await data(p)).rows[0] as Row;
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
  await act({
    action: "database.update",
    pageId: p,
    version: d.version,
    fields: [...d.fields, field],
    views,
  });
  await act({
    action: "database.update",
    pageId: p,
    version: (await database(p)).version,
    fields: d.fields,
    views,
  });
  assert.equal((await database(p)).views[0].gallery?.cover, "none");
});

test("document templates and archived cover snapshots retain images, while foreign cover references roll back the entire import", async () => {
  const p = await create(),
    other = await create(),
    url = await file(p),
    foreign = await file(other);
  await set(p, url, 19);
  const template = (await act({
    action: "template.save",
    pageId: p,
    name: "Document image cover",
  })).id;
  const copy = (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Document copy",
    templateId: template,
  })).id;
  assert.equal((await data(copy)).page.cover_position, 19);
  assert.notEqual((await data(copy)).page.cover, url);
  const archive = await exportArchive(owner, wid),
    entries = await readZip(archive),
    manifest = JSON.parse(entries.get("flowplan.json")!.toString());
  const destination = await createWorkspace(owner.id, "Document cover import");
  const imported = await importArchive(owner, destination, archive);
  const tid = (await one<{ id: string }>(
    "SELECT id FROM templates WHERE workspace_id=? AND name=?",
    destination,
    "Document image cover",
  ))!.id;
  const restored = (await act({
    action: "page.create",
    workspaceId: destination,
    spaceId: imported.spaces[0],
    title: "Document restored",
    templateId: tid,
  })).id;
  assert.equal((await data(restored)).page.cover_position, 19);
  assert.deepEqual(
    readFileSync(
      join(
        process.env.FLOWPLAN_DATA_DIR!,
        "uploads",
        (await data(restored)).page.cover.split("/").at(-1)!,
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
  assert.equal((await data(older.pageIds[p])).page.cover_position, 50);
  assert.ok(
    (await all<{ appearance: string | null }>(
      "SELECT appearance FROM snapshots WHERE page_id=?",
      older.pageIds[p],
    )).every((snapshot) => snapshot.appearance === null),
  );
  manifest.pages.find((page: { id: string }) => page.id === p).cover = foreign;
  entries.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const before = (await one<{ n: number }>(
    "SELECT COUNT(*) n FROM pages WHERE workspace_id=?",
    destination,
  ))!.n;
  await assert.rejects(
    importArchive(owner, destination, await writeZip(entries)),
    /Bild dieser Seite/,
  );
  assert.equal(
    (await one<{ n: number }>(
      "SELECT COUNT(*) n FROM pages WHERE workspace_id=?",
      destination,
    ))!.n,
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
  const p = await create(),
    other = await create(),
    icon = await file(p),
    foreign = await file(other),
    text = await file(p, "text/plain");
  const setIcon = async (value: string, as = owner) =>
    await act({ action: "page.update", pageId: p, patch: { icon: value } }, as);
  await assert.rejects(async () => await setIcon(foreign), /Seitensymbol/);
  await assert.rejects(async () => await setIcon(text), /Seitensymbol/);
  await assert.rejects(async () => await setIcon(icon, viewer), /Berechtigung/);
  await setIcon(icon);
  assert.equal((await data(p)).page.icon, icon);

  const link = (await act({
    action: "share.create",
    pageId: p,
    name: "Icon",
    role: "viewer",
  })).token;
  const iconId = icon.split("/").at(-1)!;
  assert.equal((await publicFile(link, iconId)).page_id, p);
  await setIcon("📘");
  await assert.rejects(async () => await publicFile(link, iconId), /nicht veröffentlicht/);
  await setIcon(icon);

  const copy = (await act({ action: "page.duplicate", pageId: p })).id;
  const copiedIcon = (await data(copy)).page.icon as string;
  assert.match(copiedIcon, /^\/api\/files\//);
  assert.notEqual(copiedIcon, icon);
  assert.equal(
    (await one<{ page_id: string }>(
      "SELECT page_id FROM files WHERE id=?",
      copiedIcon.split("/").at(-1)!,
    ))?.page_id,
    copy,
  );

  const archive = await exportArchive(owner, wid),
    destination = await createWorkspace(owner.id, "Icon restore");
  const imported = await importArchive(owner, destination, archive);
  const restoredIcon = (await data(imported.pageIds[p])).page.icon as string;
  assert.match(restoredIcon, /^\/api\/files\//);
  assert.equal(
    (await one<{ page_id: string }>(
      "SELECT page_id FROM files WHERE id=?",
      restoredIcon.split("/").at(-1)!,
    ))?.page_id,
    imported.pageIds[p],
  );
});
test("record icons and covers are versioned, use database images and survive duplication, copies, snapshots and ZIP", async () => {
  const { galleryImage } = await import("../lib/database-gallery");
  const p = await create("database"),
    other = await create(),
    image = await file(p),
    foreign = await file(other),
    row = (await act({
      action: "row.create",
      pageId: p,
      cells: { title: "Eintrag" },
    })).id;
  const version = async () =>
    (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", row))!
      .version;
  const setLook = async (patch: Record<string, unknown>, as = owner) =>
    await act(
      {
        action: "row.appearance",
        pageId: p,
        rowId: row,
        version: await version(),
        ...patch,
      },
      as,
    );
  await assert.rejects(async () => await setLook({ cover: foreign }), /Cover/);
  await assert.rejects(async () => await setLook({ icon: foreign }), /Seitensymbol/);
  await assert.rejects(async () => await setLook({ icon: "🚀" }, viewer), /Berechtigung/);
  await assert.rejects(
    async () =>
      await act({
        action: "row.appearance",
        pageId: p,
        rowId: row,
        version: (await version()) + 1,
        icon: "🚀",
      }),
    /geändert/,
  );
  const before = await version();
  await setLook({ icon: "🚀", cover: image });
  assert.equal(await version(), before + 1);
  await setLook({ icon: image });
  const stored = (await data(p)).rows[0];
  assert.equal(stored.icon, image);
  assert.equal(stored.cover, image);
  assert.equal(
    galleryImage(
      stored,
      { cover: "record", fit: "cover", size: "medium" },
      [],
      new Set([image]),
    ),
    image,
  );
  await setLook({ cover: "#dce7f5" });
  assert.equal((await data(p)).rows[0].cover, "#dce7f5");
  await setLook({ cover: image });

  // Duplicating a record keeps its look.
  await act({
    action: "rows.bulk",
    pageId: p,
    operation: "duplicate",
    rows: [{ id: row, version: await version() }],
  });
  assert.equal(
    (await data(p)).rows.filter((r: { cover: string }) => r.cover === image).length,
    2,
  );

  // Page copies point to their own image copies.
  const copy = (await act({ action: "page.duplicate", pageId: p })).id;
  const copied = (await data(copy)).rows[0];
  assert.notEqual(copied.cover, image);
  assert.equal(copied.cover, copied.icon);
  assert.equal(
    (await one<{ page_id: string }>(
      "SELECT page_id FROM files WHERE id=?",
      copied.cover.split("/").at(-1)!,
    ))?.page_id,
    copy,
  );

  // Snapshots restore the look.
  await act({ action: "page.snapshot", pageId: p });
  const snapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=? ORDER BY created_at DESC LIMIT 1",
    p,
  ))!.id;
  await setLook({ icon: "", cover: "" });
  await act({ action: "snapshot.restore", pageId: p, snapshotId: snapshot });
  assert.equal(
    (await data(p)).rows.find((r: { id: string }) => r.id === row).cover,
    image,
  );

  const archive = await exportArchive(owner, wid),
    destination = await createWorkspace(owner.id, "Record look restore");
  const imported = await importArchive(owner, destination, archive);
  const restored = (await data(imported.pageIds[p])).rows[0];
  assert.match(restored.cover, /^\/api\/files\//);
  assert.notEqual(restored.cover, image);
  assert.equal(
    (await one<{ page_id: string }>(
      "SELECT page_id FROM files WHERE id=?",
      restored.cover.split("/").at(-1)!,
    ))?.page_id,
    imported.pageIds[p],
  );
});
test("files cells hold several own uploads or links and keep them through copies, templates and ZIP", async () => {
  const { galleryImage } = await import("../lib/database-gallery");
  const { fileUrls, mapFileCell } = await import("../lib/file-cells");
  assert.deepEqual(fileUrls("/api/files/x"), ["/api/files/x"]);
  assert.deepEqual(fileUrls(["a", 3, "", "b"]), ["a", "b"]);
  assert.deepEqual(fileUrls(null), []);
  assert.deepEqual(
    mapFileCell(["a", "b"], (u) => u + "!"),
    ["a!", "b!"],
  );
  assert.equal(
    mapFileCell("a", (u) => u + "!"),
    "a!",
  );

  const p = await create("database"),
    other = await create(),
    first = await file(p),
    second = await file(p, "application/pdf"),
    foreign = await file(other),
    d = await database(p);
  await act({
    action: "database.update",
    pageId: p,
    version: d.version,
    fields: [...d.fields, { id: "media", name: "Medien", type: "files" }],
    views: d.views,
  });
  const row = (await act({
    action: "row.create",
    pageId: p,
    cells: { title: "Mappe" },
  })).id;
  const update = async (media: unknown) =>
    await act({
      action: "row.update",
      pageId: p,
      rowId: row,
      version: (await one<{ version: number }>(
        "SELECT version FROM rows WHERE id=?",
        row,
      ))!.version,
      cells: { media },
    });
  await assert.rejects(async () => await update([foreign]), /gehört nicht/);
  await assert.rejects(async () => await update(["javascript:alert(1)"]), /Ungültige|http/);
  await assert.rejects(async () => await update(Array.from({ length: 51 }, () => first)));
  await update([first, second, "https://example.com/plan.pdf", first]);
  const media = async () =>
    (await data(p)).rows.find((r: { id: string }) => r.id === row).cells.media;
  assert.deepEqual(await media(), [first, second, "https://example.com/plan.pdf"]);
  // Legacy single strings are still accepted and read.
  await update(first);
  assert.deepEqual(await media(), [first]);
  await update([second, first]);
  assert.equal(
    galleryImage(
      (await data(p)).rows.find((r: { id: string }) => r.id === row),
      { cover: "field", fieldId: "media", fit: "cover", size: "medium" },
      [...d.fields, { id: "media", name: "Medien", type: "files" }],
      new Set([first]),
    ),
    first,
  );
  assert.ok(
    (await data(p)).files.some(
      (f: { url: string; mime: string }) =>
        f.url === second && f.mime === "application/pdf",
    ),
  );

  const copy = (await act({ action: "page.duplicate", pageId: p })).id;
  const copied = (await data(copy)).rows[0].cells.media as string[];
  assert.equal(copied.length, 2);
  for (const url of copied)
    assert.equal(
      (await one<{ page_id: string }>(
        "SELECT page_id FROM files WHERE id=?",
        url.split("/").at(-1)!,
      ))?.page_id,
      copy,
    );

  const template = (await act({
    action: "template.save",
    pageId: p,
    name: "Medienvorlage",
  })).id;
  const fromTemplate = (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Aus Vorlage",
    templateId: template,
  })).id;
  const templated = (await data(fromTemplate)).rows[0].cells.media as string[];
  assert.equal(templated.length, 2);
  assert.ok(templated.every((url) => !url.includes(first.split("/").at(-1)!)));

  const archive = await exportArchive(owner, wid),
    destination = await createWorkspace(owner.id, "Medien restore");
  const imported = await importArchive(owner, destination, archive);
  const restored = (await data(imported.pageIds[p])).rows[0].cells.media as string[];
  assert.equal(restored.length, 2);
  assert.ok(restored.every((url) => url !== first && url !== second));
});
