// ZIP imports read from disk (#673): Obsidian and Confluence ZIPs are read
// where the upload lies – notes at once, attachments only when they are
// written – so a vault may be larger than 100 MB while memory stays flat.
// The zip-bomb checks hold for the lazy entries as well.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, deflateRawSync } from "node:zlib";
import { ZipFile } from "yazl";
import type { Identity } from "../lib/types";

const dataDir = mkdtempSync(join(tmpdir(), "flowplan-zip-disk-"));
process.env.FLOWPLAN_DATA_DIR = dataDir;
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip, readZipFile, ARCHIVE_LIMIT } = await import("../lib/archive");
const { readZipEntrySync, readZipEntryHead } = await import("../lib/zip-file");
const { importFromSource, parseImport } = await import("../lib/importers");
const { uploadsDir } = await import("../lib/storage");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "disk", "disk@example.test");
const owner = { id: uid, name: "disk", email: "disk@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Große Importe");
const space = (await bootstrap(owner, wid)).spaces[0].id;

// Generated ZIPs go into a folder of their own, removed at the end.
const zips = mkdtempSync(join(tmpdir(), "flowplan-zip-disk-files-"));
test.after(() => rmSync(zips, { recursive: true, force: true }));
const fixtures = join(import.meta.dirname, "fixtures", "import");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
async function fixtureZip(dir: string, name: string) {
  const bytes = await writeZip(new Map(walk(join(fixtures, dir)).map((f) => [relative(join(fixtures, dir), f), readFileSync(f)] as [string, Buffer])));
  const path = join(zips, name);
  writeFileSync(path, bytes);
  return { path, bytes };
}
const pageHtml = async (title: string) =>
  (await one<{ html: string }>(
    "SELECT d.html FROM documents d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=? AND p.title=? AND p.deleted_at IS NULL ORDER BY p.seq DESC LIMIT 1",
    wid,
    title,
  ))!.html;

test("an Obsidian ZIP on disk: notes read at once, attachments when they are written", async () => {
  const { path } = await fixtureZip("obsidian", "Tresor.zip");
  const tree = await parseImport("Tresor.zip", { path });
  assert.equal(tree.source, "obsidian");
  const picture = tree.files.get("Anhänge/diagramm.png")!;
  assert.ok(picture && !("data" in picture) && "zip" in picture && picture.zip, "the attachment stays in the ZIP");
  const original = readFileSync(join(fixtures, "obsidian/Anhänge/diagramm.png"));
  assert.ok(picture.read().equals(original));
  assert.ok(picture.head!().equals(original.subarray(0, 64)));
  // The import (through the worker's tree) stores the same bytes.
  const result = await importFromSource(owner, wid, space, { name: "Tresor.zip", path });
  assert.equal(result.files, 1);
  const file = (await one<{ id: string; mime: string; size: number }>(
    "SELECT f.id,f.mime,f.size FROM files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id=? AND f.name='diagramm.png'",
    wid,
  ))!;
  assert.match(await pageHtml("Start"), new RegExp(`<img src="/api/files/${file.id}"`));
  assert.equal(file.mime, "image/png");
  assert.equal(file.size, original.length);
  assert.ok(readFileSync(join(uploadsDir(), file.id)).equals(original));
  // A source chosen by hand reads from disk as well.
  assert.equal((await parseImport("Tresor.zip", { path }, "obsidian")).files.size, 1);
});

test("a Confluence ZIP on disk keeps its attachments lazy too", async () => {
  for (const dir of ["confluence-html", "confluence-xml"]) {
    const { path, bytes } = await fixtureZip(dir, `${dir}.zip`);
    const fromDisk = await parseImport("space.zip", { path });
    const inMemory = await parseImport("space.zip", bytes);
    assert.equal(fromDisk.source, "confluence");
    assert.deepEqual(fromDisk.pages.map((p) => p.title), inMemory.pages.map((p) => p.title));
    assert.deepEqual([...fromDisk.files.keys()], [...inMemory.files.keys()]);
    for (const [key, file] of fromDisk.files) {
      assert.ok(!("data" in file), `${dir}: ${key} is lazy`);
      const memory = inMemory.files.get(key)!;
      assert.ok(file.read().equals("data" in memory ? memory.data : memory.read()));
    }
  }
});

test("other sources on disk are still read into memory, up to 100 MB", async () => {
  const { path } = await fixtureZip("google-takeout", "takeout.zip");
  const tree = await parseImport("takeout.zip", { path });
  assert.equal(tree.source, "gdocs");
});

// A ZIP of one stored or deflated entry, written by hand so its central
// directory can say something else than the data.
function oneEntryZip(name: string, data: Buffer, { method = 8, size = data.length, crc }: { method?: number; size?: number; crc?: number } = {}) {
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBytes = Buffer.from(name);
  const sum = crc ?? crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(sum >>> 0, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(sum >>> 0, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralStart = 30 + nameBytes.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}
const lazyOnly = { maxEntries: 10, eager: () => false };
const write = (name: string, bytes: Buffer) => {
  const path = join(zips, name);
  writeFileSync(path, bytes);
  return path;
};

test("lazy entries keep the zip-bomb checks: size, checksum, ratio, names, count", async () => {
  const data = randomBytes(200_000);
  // As stated: read, also its first bytes only.
  const good = await readZipFile(write("good.zip", oneEntryZip("a.bin", data)), lazyOnly);
  const entry = good.get("a.bin")!;
  assert.ok(!Buffer.isBuffer(entry) && entry.read().equals(data));
  assert.ok(!Buffer.isBuffer(entry) && entry.head().equals(data.subarray(0, 64)));
  // More data than the directory states: inflating stops there.
  const small = await readZipFile(write("small.zip", oneEntryZip("a.bin", data, { size: 1000 })), lazyOnly);
  assert.throws(() => (small.get("a.bin") as { read: () => Buffer }).read(), (e: Error & { status?: number }) => e.status === 413);
  // A wrong checksum.
  const crc = await readZipFile(write("crc.zip", oneEntryZip("a.bin", data, { crc: 1234 })), lazyOnly);
  assert.throws(() => (crc.get("a.bin") as { read: () => Buffer }).read(), /Beschädigtes ZIP-Archiv/);
  const ref = (good.get("a.bin") as { zip: Parameters<typeof readZipEntrySync>[0] }).zip;
  assert.throws(() => readZipEntrySync({ ...ref, offset: ref.offset + 1 }), /Beschädigtes ZIP-Archiv/);
  assert.throws(() => readZipEntrySync({ ...ref, compressedSize: 10 ** 9 }), /Beschädigtes ZIP-Archiv/);
  assert.equal(readZipEntryHead(ref, 16).length, 16);
  // A zip bomb: 20 MB of zeros in a few KB.
  await assert.rejects(readZipFile(write("bomb.zip", oneEntryZip("zeros.bin", Buffer.alloc(20 * 1024 * 1024))), lazyOnly), (e: Error & { status?: number }) => e.status === 413);
  // Paths out of the ZIP.
  await assert.rejects(readZipFile(write("escape.zip", oneEntryZip("../../etc/x.md", data)), lazyOnly), /Beschädigtes ZIP-Archiv/);
  // The total of everything unpacked and the text read at once.
  await assert.rejects(readZipFile(write("total.zip", oneEntryZip("a.bin", data)), { ...lazyOnly, totalBytes: 1000 }), /Größenlimit/);
  await assert.rejects(readZipFile(write("text.zip", oneEntryZip("a.md", data)), { maxEntries: 10, eager: () => true, textBytes: 1000 }), /Größenlimit/);
  // The number of entries.
  const many = await writeZip(new Map(Array.from({ length: 12 }, (_, i) => [`n${i}.md`, Buffer.from("x")] as [string, Buffer])));
  await assert.rejects(readZipFile(write("many.zip", many), lazyOnly), /doppelte oder verschlüsselte/);
});

test("a vault ZIP larger than 100 MB imports from disk with flat memory", async () => {
  // Everything on this thread, so the measurement sees it all.
  process.env.FLOWPLAN_WORKERS = "0";
  const count = 36,
    each = 4 * 1024 * 1024;
  const block = randomBytes(1024 * 1024);
  const pdf = (i: number) =>
    Readable.from(
      (function* () {
        const header = Buffer.from(`%PDF-1.4\n% ${i}\n`);
        for (let at = 0; at < each; at += block.length) yield at ? block : Buffer.concat([header, block.subarray(header.length)]);
      })(),
    );
  const zip = new ZipFile();
  const path = join(zips, "Großer Tresor.zip");
  const written = pipeline(zip.outputStream, createWriteStream(path));
  zip.addBuffer(Buffer.from("{}"), "Tresor/.obsidian/app.json");
  for (let i = 0; i < count; i++) {
    zip.addBuffer(Buffer.from(`# Notiz ${i}\n\nSiehe ![[Dokument ${i}.pdf]] und [[Notiz ${(i + 1) % count}]].\n`), `Tresor/Notizen/Notiz ${i}.md`);
    zip.addReadStream(pdf(i), `Tresor/Anhänge/Dokument ${i}.pdf`, { compress: false, size: each });
  }
  zip.end();
  await written;
  assert.ok(statSync(path).size > ARCHIVE_LIMIT, "larger than the in-memory limit");
  const used = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const base = used();
  let peak = 0;
  const sampler = setInterval(() => (peak = Math.max(peak, used() - base)), 5);
  try {
    const preview = await importFromSource(owner, wid, space, { name: "Großer Tresor.zip", path }, { dryRun: true });
    assert.equal(preview.files, count);
    assert.equal(preview.bytes, count * each);
    const result = await importFromSource(owner, wid, space, { name: "Großer Tresor.zip", path });
    assert.equal(result.files, count);
  } finally {
    clearInterval(sampler);
    delete process.env.FLOWPLAN_WORKERS;
  }
  peak = Math.max(peak, used() - base);
  const stored = await all<{ id: string; size: number; mime: string }>("SELECT f.id,f.size,f.mime FROM files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id=? AND f.name LIKE 'Dokument %.pdf'", wid);
  assert.equal(stored.length, count);
  assert.ok(stored.every((f) => f.size === each && f.mime === "application/pdf"));
  const expected = createHash("sha256");
  for await (const chunk of pdf(7)) expected.update(chunk as Buffer);
  const seven = (await one<{ id: string }>("SELECT f.id FROM files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id=? AND f.name='Dokument 7.pdf'", wid))!;
  assert.equal(createHash("sha256").update(readFileSync(join(uploadsDir(), seven.id))).digest("hex"), expected.digest("hex"));
  // The ZIP is 144 MB; what the import held at any time stays far below.
  assert.ok(peak < 96 * 1024 * 1024, `memory grew by ${Math.round(peak / 1024 / 1024)} MB`);
  // The stored attachments are this test's: gone with its data folder.
  for (const f of stored) rmSync(join(uploadsDir(), f.id), { force: true });
  rmSync(path, { force: true });
});
