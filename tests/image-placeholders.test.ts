// Image placeholders: decoding (lib/image-decode.ts, lib/jpeg-decode.ts,
// lib/webp-decode.ts), ThumbHash (lib/thumbhash.ts), storage, access rules
// and computing them later (lib/image-placeholders.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-placeholders-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { id, one, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { decodeImage, decodeImageInSlices, imageInfo } = await import("../lib/image-decode");
const { Downsampler } = await import("../lib/image-small");
const T = await import("../lib/thumbhash");
const P = await import("../lib/image-placeholders");

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "images", name));
const small = (name: string) => {
  const decoded = decodeImage(fixture(name));
  assert.ok(decoded?.small, name);
  return decoded.small;
};
/** Mean absolute difference of the colour channels where both are visible. */
function difference(a: Uint8Array, b: Uint8Array) {
  let sum = 0,
    n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (a[i + 3] > 200 && b[i + 3] > 200) {
      for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]);
      n += 3;
    }
  return sum / n;
}

// ---- decoding ----

test("sizes come from the headers of every supported type", () => {
  for (const [name, mime] of [
    ["photo.png", "image/png"],
    ["palette.gif", "image/gif"],
    ["photo.jpg", "image/jpeg"],
    ["photo-lossy.webp", "image/webp"],
    ["alpha-lossless.webp", "image/webp"],
    ["alpha-lossy.webp", "image/webp"],
    ["photo.avif", "image/avif"],
  ])
    assert.deepEqual(imageInfo(fixture(name)), { mime, width: 64, height: 48 }, name);
  // Turned photos: the size the browser shows.
  assert.deepEqual(decodeImage(fixture("photo-rotated.jpg"))?.width, 48);
  assert.equal(imageInfo(Buffer.from("not an image at all")), null);
  assert.equal(imageInfo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
});

test("lossless formats decode to exactly the same pixels", () => {
  const png = small("photo.png");
  assert.deepEqual([...png.rgba.subarray(0, 4)], [40, 61, 198, 255]);
  const alpha = small("alpha.png");
  assert.deepEqual(small("alpha-interlaced.png").rgba, alpha.rgba, "Adam7");
  assert.deepEqual(small("alpha-lossless.webp").rgba, alpha.rgba, "VP8L");
  assert.deepEqual(small("palette.gif").rgba, small("palette.png").rgba, "GIF");
  assert.deepEqual(small("gray16.png").rgba, small("gray.png").rgba, "16 bit");
});

test("lossy formats come close to the original", () => {
  const png = small("photo.png");
  const webp = small("photo-lossy.webp");
  assert.equal(webp.width, 64);
  // (libwebp's own decoder differs by about 7 here: the photo is noisy.)
  assert.ok(difference(webp.rgba, png.rgba) < 9, "VP8");
  const alpha = small("alpha.png");
  const lossyAlpha = small("alpha-lossy.webp");
  assert.ok(difference(lossyAlpha.rgba, alpha.rgba) < 10, "VP8 with ALPH");
  let alphaError = 0;
  for (let i = 3; i < alpha.rgba.length; i += 4) alphaError += Math.abs(alpha.rgba[i] - lossyAlpha.rgba[i]);
  assert.ok(alphaError / (64 * 48) < 2);
  // JPEG at an eighth: one pixel per 8×8 block, its average (colour per
  // 16×16 block, as the file stores it). Brightness per block and the
  // average colour match.
  const eighth = new Downsampler(64, 48, 8);
  for (let y = 0; y < 48; y++) eighth.row(y, png.rgba.subarray(y * 64 * 4, (y + 1) * 64 * 4));
  const reference = eighth.result();
  const luma = (p: Uint8Array, i: number) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
  const mean = (p: Uint8Array, c: number) => p.reduce((sum, v, i) => (i % 4 === c ? sum + v : sum), 0) / (p.length / 4);
  for (const name of ["photo.jpg", "photo-progressive.jpg"]) {
    const jpeg = small(name);
    assert.deepEqual([jpeg.width, jpeg.height], [8, 6], name);
    for (let i = 0; i < jpeg.rgba.length; i += 4) assert.ok(Math.abs(luma(jpeg.rgba, i) - luma(reference.rgba, i)) < 6, `${name} block ${i / 4}`);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(mean(jpeg.rgba, c) - mean(reference.rgba, c)) < 4, `${name} channel ${c}`);
  }
  // EXIF orientation 6: turned a quarter clockwise.
  const turned = small("photo-rotated.jpg"),
    upright = small("photo.jpg");
  assert.deepEqual([turned.width, turned.height], [6, 8]);
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 8; x++)
      for (let c = 0; c < 3; c++)
        assert.ok(Math.abs(turned.rgba[(x * 6 + (5 - y)) * 4 + c] - upright.rgba[(y * 8 + x) * 4 + c]) <= 2);
});

test("broken and hostile files give no picture, never an exception", async () => {
  const png = fixture("photo.png");
  for (const data of [
    png.subarray(0, 60),
    Buffer.concat([png.subarray(0, 33), Buffer.alloc(500, 0xff)]),
    fixture("photo-lossy.webp").subarray(0, 40),
    fixture("alpha-lossless.webp").subarray(0, 60),
    fixture("photo.jpg").subarray(0, 300),
    fixture("palette.gif").subarray(0, 50),
    Buffer.alloc(200, 0xff),
  ]) {
    const decoded = decodeImage(data);
    if (decoded) assert.ok(decoded.small === null || decoded.small.width <= 100);
  }
  // A huge declared size is not decoded (only the size is kept).
  const huge = Buffer.from(png);
  huge.writeUInt32BE(30000, 16);
  huge.writeUInt32BE(30000, 20);
  assert.deepEqual(await decodeImageInSlices(huge), { width: 30000, height: 30000, small: null });
});

// ---- ThumbHash ----

test("hashes match the reference implementation and decode to a picture", () => {
  const photo = small("photo.png");
  const hash = T.rgbaToThumbHash(photo.width, photo.height, photo.rgba);
  assert.equal(T.thumbHashToBase64(hash), "XwgGPYiGmHeAd3h6d4eGd2CFpPId");
  const alpha = small("alpha.png");
  assert.equal(T.thumbHashToBase64(T.rgbaToThumbHash(alpha.width, alpha.height, alpha.rgba)), "HkmCDIY1VcuQXJvmxW0Ij5h1gHiIN6h4Bw==");
  assert.deepEqual(T.thumbHashFromBase64("XwgGPYiGmHeAd3h6d4eGd2CFpPId"), hash);
  assert.equal(T.thumbHashFromBase64("<script>"), null);
  assert.ok(Math.abs(T.thumbHashAspectRatio(hash) - 64 / 48) < 0.1);
  assert.equal(T.thumbHashAverage(hash), "rgba(132,128,117,1)");
  // The picture: 32 px on the long side, a valid PNG with exactly its pixels.
  const picture = T.thumbHashToRGBA(hash);
  assert.deepEqual([picture.w, picture.h], [32, 23]);
  const url = T.thumbHashToDataURL(hash);
  assert.match(url, /^data:image\/png;base64,/);
  const png = decodeImage(Buffer.from(url.split(",")[1], "base64"));
  assert.deepEqual(png?.small?.rgba, picture.rgba);
});

// ---- storage, access and computing later ----

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("owner"),
  viewer = account("viewer"),
  stranger = account("stranger");
const wid = createWorkspace(owner.id, "Bilder");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
createWorkspace(stranger.id, "Elsewhere");
const space = bootstrap(owner, wid).spaces[0].id;
const newPage = (title: string, kind = "document", spaceId = space) =>
  (command(owner, { action: "page.create", workspaceId: wid, spaceId, title, kind }) as { id: string }).id;
const pageId = newPage("Fotos");
mkdirSync(join(dir, "uploads"), { recursive: true });
/** A file as earlier versions stored it: no placeholder yet. */
function storedFile(page: string, name: string, mime = "image/png", data: Buffer = fixture("photo.png")) {
  const fid = id();
  writeFileSync(join(dir, "uploads", fid), data);
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, page, name, mime, data.length, owner.id);
  return fid;
}
const stored = (fid: string) => one<{ width: number | null; height: number | null; thumbhash: string | null }>("SELECT width,height,thumbhash FROM files WHERE id=?", fid);

test("an upload stores size and hash and answers with them", async () => {
  const fid = storedFile(pageId, "photo.webp", "image/webp", fixture("photo-lossy.webp"));
  const answer = await P.placeholderForUpload(fid, "image/webp", pageId, fixture("photo-lossy.webp"));
  assert.equal(answer?.w, 64);
  assert.equal(answer?.h, 48);
  assert.ok(answer?.hash && T.thumbHashFromBase64(answer.hash));
  assert.deepEqual(stored(fid), { width: 64, height: 48, thumbhash: answer.hash });
  // Other files: nothing to show, and marked so they are not tried again.
  const pdf = storedFile(pageId, "a.pdf", "application/pdf", Buffer.from("%PDF-1.4"));
  assert.equal(await P.placeholderForUpload(pdf, "application/pdf", pageId, Buffer.from("%PDF-1.4")), null);
  assert.deepEqual(stored(pdf), { width: null, height: null, thumbhash: "" });
  // AVIF: the size only.
  const avif = storedFile(pageId, "photo.avif", "image/avif", fixture("photo.avif"));
  assert.deepEqual(await P.placeholderForUpload(avif, "image/avif", pageId, fixture("photo.avif")), { w: 64, h: 48 });
});

test("files from before get their placeholder when first asked for, once", async () => {
  const fid = storedFile(pageId, "old.png");
  assert.equal(stored(fid)?.thumbhash, null);
  const first = P.backfillPlaceholder(fid);
  assert.equal(P.backfillPlaceholder(fid), first, "the same file is not computed twice at once");
  await first;
  assert.deepEqual(stored(fid), { width: 64, height: 48, thumbhash: "XwgGPYiGmHeAd3h6d4eGd2CFpPId" });
  // Through the request: computed while it waits.
  const later = storedFile(pageId, "later.jpg", "image/jpeg", fixture("photo-rotated.jpg"));
  const answer = await P.placeholdersFor(viewer, [later]);
  assert.equal(answer[later]?.w, 48);
  assert.equal(answer[later]?.h, 64);
  assert.ok(answer[later]?.hash);
  // A file that cannot be decoded keeps its size, without a picture.
  const broken = fixture("photo.png");
  const truncated = storedFile(pageId, "broken.png", "image/png", Buffer.concat([broken.subarray(0, 60), Buffer.alloc(40)]));
  assert.deepEqual((await P.placeholdersFor(owner, [truncated]))[truncated], { w: 64, h: 48 });
  // Missing on disk: nothing, and not tried again.
  const gone = id();
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", gone, pageId, "gone.png", "image/png", 10, owner.id);
  assert.deepEqual(await P.placeholdersFor(owner, [gone]), {});
  assert.equal(stored(gone)?.thumbhash, "");
});

test("placeholders follow the access rules of the file", async () => {
  const fid = storedFile(pageId, "shared.png");
  await P.backfillPlaceholder(fid);
  assert.ok((await P.placeholdersFor(viewer, [fid]))[fid]);
  // No member of the workspace: nothing, as for a file that does not exist.
  assert.deepEqual(await P.placeholdersFor(stranger, [fid, id()]), {});
  // A private space of the owner.
  const privateSpace = (command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true }) as { id: string }).id;
  const privatePage = newPage("Mein", "document", privateSpace);
  const mine = storedFile(privatePage, "mine.png");
  assert.ok((await P.placeholdersFor(owner, [mine]))[mine]);
  assert.deepEqual(await P.placeholdersFor(viewer, [mine]), {});
  // An attachment of a record hidden from the viewer.
  const db = newPage("HR", "database");
  command(owner, {
    action: "database.update",
    pageId: db,
    version: database(db).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "att", name: "Files", type: "files" },
    ],
    views: database(db).views,
  });
  const attachment = storedFile(db, "salary.png");
  const row = (command(owner, { action: "row.create", pageId: db, cells: { title: "Private", att: [`/api/files/${attachment}`] } }) as { id: string }).id;
  command(owner, { action: "row.access", pageId: db, rowId: row, access: "private", grants: [] });
  assert.ok((await P.placeholdersFor(owner, [attachment]))[attachment]);
  assert.deepEqual(await P.placeholdersFor(viewer, [attachment]), {});
  // Pages in the trash.
  const trashed = newPage("Weg");
  const old = storedFile(trashed, "old.png");
  await P.backfillPlaceholder(old);
  run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", trashed);
  assert.deepEqual(await P.placeholdersFor(owner, [old]), {});
  // Not more than a request may ask for; junk ids are ignored.
  assert.deepEqual(await P.placeholdersFor(owner, ["../../etc/passwd", "", "avatar:x"]), {});
});

test("files of end-to-end encrypted spaces are never looked into", async () => {
  const sealed = (command(owner, { action: "space.create", workspaceId: wid, name: "Tresor" }) as { id: string }).id;
  run("UPDATE spaces SET encrypted=1,key_version=1 WHERE id=?", sealed);
  const vault = id();
  run("INSERT INTO pages(id,workspace_id,space_id,title,kind,created_by) VALUES(?,?,?,?,?,?)", vault, wid, sealed, "Tresor", "document", owner.id);
  // Even an image the server could read (it never should get one) …
  const plain = storedFile(vault, "leak.png");
  assert.equal(await P.placeholderForUpload(plain, "image/png", vault, fixture("photo.png")), null);
  assert.deepEqual(stored(plain), { width: null, height: null, thumbhash: "" });
  const later = storedFile(vault, "later.png");
  await P.backfillPlaceholder(later);
  assert.deepEqual(stored(later), { width: null, height: null, thumbhash: "" });
  // … and a stored hash (from before the space was sealed) is not handed out.
  run("UPDATE files SET width=64,height=48,thumbhash='XwgGPYiGmHeAd3h6d4eGd2CFpPId' WHERE id=?", later);
  assert.deepEqual(await P.placeholdersFor(owner, [plain, later]), {});
  // What uploads to encrypted pages are: ciphertext, stored as a download.
  const cipher = storedFile(vault, "encrypted.bin", "application/octet-stream", Buffer.concat([Buffer.from("FPX1"), fixture("photo.png")]));
  await P.backfillPlaceholder(cipher);
  assert.equal(stored(cipher)?.thumbhash, "");
  assert.deepEqual(await P.placeholdersFor(owner, [cipher]), {});
});

test("profile pictures: for people sharing a workspace only", async () => {
  run("INSERT INTO user_avatars(user_id,mime,data) VALUES(?,?,?)", owner.id, "image/png", fixture("photo.png"));
  const key = `avatar:${owner.id}`;
  const answer = await P.placeholdersFor(viewer, [key]);
  assert.deepEqual(answer[key], { w: 64, h: 48, hash: "XwgGPYiGmHeAd3h6d4eGd2CFpPId" });
  assert.deepEqual(await P.placeholdersFor(stranger, [key]), {});
});
