// ZIP entry names from macOS, Windows and Info-ZIP (#556): raw UTF-8 without
// bit 11, the Unicode Path extra field, CP437, NFD → NFC, and an Obsidian
// vault zipped by Finder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-zip-names-"));
const { readZip } = await import("../lib/archive");
const { zipEntries } = await import("../lib/importers");
const { parseObsidian } = await import("../lib/importers/obsidian");

type RawEntry = { name: Buffer; data?: Buffer; utf8Flag?: boolean; extra?: Buffer };
// A minimal ZIP writer (stored entries) that writes names as given, unlike
// yazl, which always sets bit 11.
function rawZip(entries: RawEntry[]) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.from("x"),
      extra = e.extra ?? Buffer.alloc(0),
      flag = e.utf8Flag ? 0x800 : 0,
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(flag, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(e.name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(flag, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(e.name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    const block = Buffer.concat([local, e.name, extra, data]);
    locals.push(block);
    centrals.push(Buffer.concat([central, e.name, extra]));
    offset += block.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
// Info-ZIP Unicode Path extra field (0x7075, version 1).
function unicodePath(raw: Buffer, name: string, crc = crc32(raw)) {
  const utf8 = Buffer.from(name, "utf8"),
    field = Buffer.alloc(9);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(5 + utf8.length, 2);
  field.writeUInt8(1, 4);
  field.writeUInt32LE(crc, 5);
  return Buffer.concat([field, utf8]);
}
const nfd = (s: string) => Buffer.from(s.normalize("NFD"), "utf8");
const names = async (zip: Buffer) => [...(await readZip(zip, { foreign: true })).keys()];

test("entry names: UTF-8 with and without bit 11, Unicode Path field, CP437, all NFC", async () => {
  const cp437 = Buffer.from([0x44, 0x69, 0x61, 0x82, 0x72, 0x69, 0x61, 0x73, 0x2e, 0x6d, 0x64]); // "Diaérias.md" in CP437
  const latin = Buffer.from("Ma\xf1ana.md", "latin1"); // invalid UTF-8, CP437 0xf1 = "±"
  const result = await names(
    rawZip([
      { name: nfd("Diárias/Diárias.md") }, // macOS: raw UTF-8 (NFD), no bit 11
      { name: Buffer.from("Größe.md", "utf8"), utf8Flag: true },
      { name: cp437 },
      { name: latin },
      // A CP437 name with a Unicode Path field: the field wins.
      { name: Buffer.from("Cafe.md"), extra: unicodePath(Buffer.from("Cafe.md"), "Café.md") },
      // A field whose CRC does not match the name is ignored.
      { name: Buffer.from("Old.md"), extra: unicodePath(Buffer.from("Old.md"), "New.md", 1) },
    ]),
  );
  assert.deepEqual(result, ["Diárias/Diárias.md", "Größe.md", "Diaérias.md", "Ma±ana.md", "Café.md", "Old.md"]);
  for (const name of result) assert.equal(name, name.normalize("NFC"));
});

test("entry names: NFC/NFD twins are duplicates, unsafe paths stay refused", async () => {
  await assert.rejects(names(rawZip([{ name: nfd("Diárias.md") }, { name: Buffer.from("Diárias.md".normalize("NFC")) }])), /doppelte/);
  for (const bad of ["../x.md", "a/../../x.md", "/etc/passwd", "C:/x.md", "a\\..\\x.md"])
    await assert.rejects(names(rawZip([{ name: Buffer.from(bad) }])), /Beschädigtes ZIP-Archiv/, bad);
  // Also when the path only appears after UTF-8 decoding or in a Unicode Path field.
  await assert.rejects(names(rawZip([{ name: Buffer.from("é/../../x.md", "utf8") }])), /Beschädigtes ZIP-Archiv/);
  await assert.rejects(names(rawZip([{ name: Buffer.from("x.md"), extra: unicodePath(Buffer.from("x.md"), "../x.md") }])), /Beschädigtes ZIP-Archiv/);
});

test("Obsidian vault zipped on macOS: NFD names, NFC links, embeds and titles", async () => {
  const note = "# Diárias\n\nSiehe [[Café]] und ![[Fotografía.png]] sowie [Bild](Fotograf%C3%ADa.png).\n";
  const zip = rawZip([
    { name: nfd("Vault/Diárias.md"), data: Buffer.from(note) },
    // A link written NFD (as Obsidian may generate it from the file name).
    { name: nfd("Vault/Café.md"), data: Buffer.from(`[[${"Diárias".normalize("NFD")}]]\n`) },
    { name: nfd("Vault/Fotografía.png"), data: Buffer.from("png") },
  ]);
  const entries = await zipEntries(zip);
  assert.deepEqual([...entries.keys()].sort(), ["Café.md", "Diárias.md", "Fotografía.png"]);
  const tree = parseObsidian(entries);
  const page = (title: string) => tree.pages.find((p) => p.title === title)!;
  const diarias = page("Diárias");
  assert.ok(diarias, "title in NFC");
  assert.doesNotMatch(diarias.html, /<h1/, "the H1 repeating the title is dropped");
  assert.match(diarias.html, new RegExp(`fp-import://page/${encodeURIComponent("Café.md")}`));
  assert.match(diarias.html, new RegExp(`<img src="fp-import://file/${encodeURIComponent("Fotografía.png")}"`));
  assert.match(diarias.html, new RegExp(`<a href="fp-import://file/${encodeURIComponent("Fotografía.png")}">Bild</a>`));
  assert.doesNotMatch(diarias.html, /\[\[/);
  assert.match(page("Café").html, new RegExp(`fp-import://page/${encodeURIComponent("Diárias.md")}`));
  assert.ok(tree.files.has("Fotografía.png"));
});
