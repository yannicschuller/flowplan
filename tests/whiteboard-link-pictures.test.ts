// Pictures of link cards on whiteboards (#455 follow-up, lib/link-pictures.ts):
// fetched once by the server for someone who may edit the board, drawn anew
// (no metadata, nothing active), stored as files of the board; stored
// previews show only such files; share links, copies and portable templates
// carry them correctly. A local HTTP server stands in for other sites (no
// network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import * as Y from "yjs";
import sharp from "sharp";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-link-pictures-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { englishMessage } = await import("../lib/i18n-errors");
const { ICON_EDGE, PICTURE_EDGE, PICTURE_MAX_BYTES, fetchPicture, pngFromIco, previewForBoard, rasterKind, reencodePicture } = await import("../lib/link-pictures");
const { linkPreviewSchema, withValidExtras } = await import("../lib/whiteboard-embeds");
const { cellLink, keptLinks, tablePageLinks } = await import("../lib/whiteboard-tables");
const { projectItem } = await import("../lib/share-canvas");
const { copyWhiteboard, writeWhiteboard } = await import("../lib/whiteboard");
const { portableTemplateItems } = await import("../lib/whiteboard-user-templates");

// ---- pictures ----

const photo = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 40, b: 30 } } })
  .jpeg()
  .withExif({ IFD0: { Copyright: "geheim-exif", Artist: "Jemand" } })
  .toBuffer();
const iconPng = await sharp({ create: { width: 180, height: 180, channels: 4, background: { r: 20, g: 60, b: 220, alpha: 1 } } })
  .png()
  .toBuffer();
// An .ico with one PNG entry.
function ico(png: Buffer) {
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt32LE(png.length, 6 + 8);
  head.writeUInt32LE(head.length, 6 + 12);
  return Buffer.concat([head, png]);
}

test("pictures are drawn anew: small, without metadata, only raster images", async () => {
  const picture = (await reencodePicture(photo, "picture"))!;
  assert.equal(picture.mime, "image/webp");
  const meta = await sharp(picture.data).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(Math.max(meta.width!, meta.height!), PICTURE_EDGE);
  assert.equal(meta.exif, undefined);
  assert.ok(!picture.data.toString("latin1").includes("geheim-exif"));
  const icon = (await reencodePicture(iconPng, "icon"))!;
  assert.equal(icon.mime, "image/png");
  assert.equal((await sharp(icon.data).metadata()).width, ICON_EDGE);
  // The PNG inside an .ico.
  assert.equal(rasterKind(ico(iconPng)), "ico");
  assert.deepEqual(Buffer.from(pngFromIco(ico(iconPng))!), iconPng);
  assert.equal((await reencodePicture(ico(iconPng), "icon"))?.mime, "image/png");
  // Small pictures are not enlarged.
  const tiny = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#fff" } }).png().toBuffer();
  assert.equal((await sharp((await reencodePicture(tiny, "picture"))!.data).metadata()).width, 40);
  // No SVG, no HTML, nothing broken.
  for (const bad of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    Buffer.from("<html><body>hi</body></html>"),
    Buffer.concat([photo.subarray(0, 200)]),
    Buffer.alloc(0),
  ])
    assert.equal(await reencodePicture(bad, "picture"), null);
});

// ---- another site ----

const served = new Map<string, { type: string; body: Buffer }>();
const requests: string[] = [];
const server = createServer((req, res) => {
  requests.push(req.url || "");
  const hit = served.get(req.url || "");
  if (!hit) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": hit.type }).end(hit.body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
// Open until the process ends (a root `after` may run before tests that
// were registered after awaiting the database).
server.unref();
const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
served.set("/cover.jpg", { type: "image/jpeg", body: photo });
served.set("/favicon.ico", { type: "image/x-icon", body: ico(iconPng) });
served.set("/page.html", { type: "text/html", body: Buffer.from("<html></html>") });
served.set("/fake.png", { type: "image/png", body: Buffer.from("<svg onload=alert(1)>") });
served.set("/huge.jpg", { type: "image/jpeg", body: Buffer.concat([photo, Buffer.alloc(PICTURE_MAX_BYTES)]) });
const local = { allowPrivate: true };

test("a picture of another site is fetched with the checks of link previews", async () => {
  assert.equal((await fetchPicture(`${site}/cover.jpg`, "picture", local))?.mime, "image/webp");
  assert.equal((await fetchPicture(`${site}/favicon.ico`, "icon", local))?.mime, "image/png");
  for (const path of ["/page.html", "/fake.png", "/huge.jpg", "/missing.png"]) assert.equal(await fetchPicture(`${site}${path}`, "picture", local), null, path);
  // Only https, never internal addresses, never other schemes.
  assert.equal(await fetchPicture(`${site}/cover.jpg`, "picture"), null);
  assert.equal(await fetchPicture("https://127.0.0.1/cover.jpg", "picture"), null);
  assert.equal(await fetchPicture("data:image/png;base64,AAAA", "picture"), null);
  assert.equal(await fetchPicture("javascript:alert(1)", "picture"), null);
});

// ---- the board ----

async function user(name: string, demo = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false, ...(demo ? { demo: true } : {}) } as Identity;
}
const owner = await user("Olga Owner"),
  viewer = await user("Vera Viewer");
const wid = await createWorkspace(owner.id, "Links");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const create = async (input: Record<string, unknown>) => ((await command(owner, input)) as { id: string }).id;
const board = await create({ action: "page.create", workspaceId: wid, spaceId: space, title: "Board", kind: "whiteboard" });
const resolve = async (raw: string) =>
  raw.includes("youtube")
    ? ({ kind: "player", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", provider: "YouTube" } as const)
    : ({
        kind: "card",
        url: raw,
        title: "Beispielseite",
        provider: "Beispiel",
        description: "Eine Seite",
        image: `${site}/cover.jpg`,
        icon: `${site}/favicon.ico`,
      } as const);
const deps = { resolve, allowPrivate: true, still: async () => `${site}/cover.jpg` };
const fileOf = (address: string) => /^\/api\/files\/([\w-]+)$/.exec(address)?.[1] || "";

test("the preview's pictures become files of the board, for those who may edit it", async () => {
  const card = await previewForBoard(owner, board, "https://example.org/artikel", deps);
  assert.equal(card.kind, "card");
  if (card.kind !== "card") return;
  assert.equal(card.title, "Beispielseite");
  assert.equal(card.site, "Beispiel");
  assert.match(card.image!, /^\/api\/files\/[\w-]+$/);
  assert.match(card.icon!, /^\/api\/files\/[\w-]+$/);
  const files = await all<{ id: string; page_id: string; mime: string; size: number; created_by: string | null }>(
    "SELECT id,page_id,mime,size,created_by FROM files WHERE id IN (?,?)",
    fileOf(card.image!),
    fileOf(card.icon!),
  );
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.equal(f.page_id, board);
    // The uploader's storage counts it.
    assert.equal(f.created_by, owner.id);
    assert.ok(f.size > 0 && f.size < 200_000);
  }
  assert.deepEqual(files.map((f) => f.mime).sort(), ["image/png", "image/webp"]);
  // A video: its still picture.
  const player = await previewForBoard(owner, board, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", deps);
  assert.equal(player.kind, "player");
  assert.match(player.image!, /^\/api\/files\//);
  // A picture that cannot be read: the card without it.
  const without = await previewForBoard(owner, board, "https://example.org/x", { ...deps, resolve: async (raw) => ({ ...(await resolve(raw)), image: `${site}/page.html`, icon: "" }) });
  assert.equal(without.kind === "card" && (without.image ?? without.icon), undefined);
  // Who may not edit, the demo, locked boards, other pages: refused.
  const refused = async (who: Identity, pageId: string, message: string) =>
    assert.rejects(() => previewForBoard(who, pageId, "https://example.org/", deps), (e: Error) => englishMessage(e.message).includes(message));
  await assert.rejects(() => previewForBoard(viewer, board, "https://example.org/", deps));
  await refused(await user("Demo", true), board, "demo");
  const doc = await create({ action: "page.create", workspaceId: wid, spaceId: space, title: "Text" });
  await refused(owner, doc, "Not a whiteboard");
  await run("UPDATE pages SET locked=1 WHERE id=?", board);
  await refused(owner, board, "locked");
  await run("UPDATE pages SET locked=0 WHERE id=?", board);
  // Nothing of the board's pictures came from anywhere else than the site.
  assert.ok(requests.includes("/cover.jpg") && requests.includes("/favicon.ico"));
});

test("stored previews show only files of the board", () => {
  const preview = linkPreviewSchema.parse({ title: "T", site: "S", image: "https://img.example.org/x.png", icon: "/api/files/abc-1" });
  assert.deepEqual(preview, { title: "T", site: "S", icon: "/api/files/abc-1" });
  assert.equal(linkPreviewSchema.parse({ title: "T", site: "S", image: "/api/share/tok/files/f1" }).image, "/api/share/tok/files/f1");
  for (const bad of ["/api/files/../x", "javascript:alert(1)", "/api/files/a b", "//evil.example/x.png", "data:image/png;base64,AA"])
    assert.equal(linkPreviewSchema.parse({ title: "T", site: "S", image: bad }).image, undefined, bad);
  // Tables: a video cell's still only from the kept preview.
  const table = { type: "table" as const, cells: [["https://youtu.be/dQw4w9WgXcQ", "https://example.org/"]] };
  assert.deepEqual(cellLink("https://youtu.be/dQw4w9WgXcQ"), { kind: "player", url: "https://youtu.be/dQw4w9WgXcQ", provider: "YouTube" });
  assert.deepEqual(cellLink("https://youtu.be/dQw4w9WgXcQ", { "https://youtu.be/dQw4w9WgXcQ": { title: "YouTube", site: "YouTube", image: "/api/files/f9" } }), {
    kind: "player",
    url: "https://youtu.be/dQw4w9WgXcQ",
    provider: "YouTube",
    thumbnail: "/api/files/f9",
  });
  assert.equal((cellLink("https://youtu.be/dQw4w9WgXcQ", { "https://youtu.be/dQw4w9WgXcQ": { title: "Y", site: "Y", image: "https://i.ytimg.com/x.jpg" } }) as { thumbnail?: string }).thumbnail, undefined);
  assert.deepEqual(tablePageLinks(table), ["https://youtu.be/dQw4w9WgXcQ", "https://example.org/"]);
  const stored = withValidExtras({ ...table, links: { "https://youtu.be/dQw4w9WgXcQ": { title: "YouTube", site: "YouTube", image: "/api/files/f9" } } });
  assert.deepEqual(keptLinks(stored), { "https://youtu.be/dQw4w9WgXcQ": { title: "YouTube", site: "YouTube", image: "/api/files/f9" } });
});

test("share links show the board's pictures through the link; copies and templates carry them right", async () => {
  const fid = id(),
    other = id();
  const page = (await one("SELECT * FROM pages WHERE id=?", board)) as never;
  const ctx = { token: "tok123", page, shared: new Set<string>(), files: new Map([[fid, true], [other, false]]) };
  const raw = {
    type: "embed",
    url: "https://example.org/",
    preview: { title: "T", site: "S", image: `/api/files/${fid}`, icon: `/api/files/${other}` },
  };
  assert.deepEqual(projectItem(raw, ctx).preview, { title: "T", site: "S", image: `/api/share/tok123/files/${fid}` });
  const legacy = { type: "table", links: { "https://example.org/": { title: "T", site: "S", image: "https://img.example.org/x.png" } } };
  assert.deepEqual(projectItem(legacy, ctx).links, { "https://example.org/": { title: "T", site: "S" } });

  // A copy of the board maps the files of its pictures like its images.
  const state = new Y.Doc();
  const map = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ type: "embed", x: 0, y: 0, w: 300, h: 200, url: "https://example.org/", preview: raw.preview })) map.set(k, v);
  state.getMap("items").set("card-1", map);
  const copy = await create({ action: "page.create", workspaceId: wid, spaceId: space, title: "Kopie", kind: "whiteboard" });
  await writeWhiteboard(board, Y.encodeStateAsUpdate(state));
  await copyWhiteboard(board, copy, undefined, (value) => value.replace(`/api/files/${fid}`, "/api/files/new-file"));
  const copied = new Y.Doc();
  Y.applyUpdate(copied, (await one<{ state: Uint8Array }>("SELECT state FROM whiteboards WHERE page_id=?", copy))!.state);
  assert.equal((copied.getMap<Y.Map<unknown>>("items").get("card-1")!.get("preview") as { image: string }).image, "/api/files/new-file");

  // Templates for other instances keep the text, not the pictures.
  const { items } = portableTemplateItems([
    { id: "a", type: "embed", x: 0, y: 0, w: 1, h: 1, url: "https://example.org/", preview: { title: "T", site: "S", image: "/api/files/x", icon: "/api/files/y" } },
    { id: "b", type: "table", x: 0, y: 0, w: 1, h: 1, links: { "https://example.org/": { title: "T", site: "S", image: "/api/files/z" } } },
  ]);
  assert.deepEqual(items[0].preview, { title: "T", site: "S" });
  assert.deepEqual(items[1].links, { "https://example.org/": { title: "T", site: "S" } });
});
