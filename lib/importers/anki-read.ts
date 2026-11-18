// db-dialect-scan: sqlite-only file – reads Anki's own SQLite collection, never Flowplan's database.
// Anki packages (docs/specs/flashcards.md §8.1): a deck export (.apkg) or a
// whole collection (.colpkg) is a ZIP with
// - the collection: `collection.anki21b` (Anki ≥ 2.1.50 without "support
//   older versions": zstd-compressed, schema 18 – note types, fields,
//   templates and decks in tables of their own, their settings protobuf),
//   `collection.anki21` (schema 11, JSON in `col`) or `collection.anki2`
//   (the oldest; newer Anki writes a placeholder note "please update" there
//   next to an anki21b, which is why it is read last),
// - `media`: JSON {"0": "bild.png"} (legacy) or a zstd-compressed protobuf
//   list of names (latest), and the media files as `0`, `1`, … (latest:
//   each zstd-compressed),
// - `meta` (latest): a protobuf with the package version.
// The collection is opened read-only with node:sqlite on a temporary file
// (like the AFFiNE workspace, lib/importers/affine-read.ts): only real tables
// are read (a view of the same name never runs), query_only, no extensions,
// and every count is bounded. Everything comes back as plain data; the
// SQLite file is gone when this returns.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as zlib from "node:zlib";
import { ARCHIVE_LIMIT, readZip } from "../archive";
import { HttpError } from "../auth";
import { maxImportFiles } from "./types";

export const ANKI_LIMITS = {
  notes: 50_000,
  cards: 200_000,
  // Reviews beyond this are not read: the learning state is then not taken over.
  reviews: 1_000_000,
  notetypes: 500,
  decks: 2000,
  fields: 50,
  // Characters of one field; longer ones are cut.
  fieldChars: 100_000,
  // The unpacked collection (zstd).
  collectionBytes: 1024 * 1024 * 1024,
} as const;

export type AnkiFormat = "anki2" | "anki21" | "anki21b";
export type AnkiTemplate = { name: string; qfmt: string; afmt: string };
// `stock`: Anki's original stock kind (schema 18; 0 when unknown):
// 1 basic, 2 basic and reversed, 3 basic optional reversed, 4 typing,
// 5 cloze, 6 image occlusion.
export type AnkiNotetype = { id: string; name: string; cloze: boolean; stock: number; fields: string[]; templates: AnkiTemplate[] };
export type AnkiDeck = { id: string; name: string };
export type AnkiNote = { id: string; mid: string; tags: string[]; fields: string[] };
// queue -1: suspended; data: JSON with FSRS memory ({"s":…,"d":…}) since Anki 23.10.
export type AnkiCard = { id: string; nid: string; did: string; ord: number; queue: number; type: number; data: string };
// id: the time of the review (ms); ease 1–4 (0: a manual change); type 0
// learn, 1 review, 2 relearn, 3 filtered/cram, 4 manual, 5 rescheduled.
export type AnkiReview = { at: number; cid: string; ease: number; type: number };
export type AnkiMedia = { name: string; entry: string; size: number };
export type AnkiPackage = {
  format: AnkiFormat;
  notetypes: Map<string, AnkiNotetype>;
  decks: Map<string, AnkiDeck>;
  notes: AnkiNote[];
  cards: AnkiCard[];
  reviews: AnkiReview[];
  // By file name, as the fields name them.
  media: Map<string, AnkiMedia>;
  // A media file's bytes (unpacked), null when missing or unreadable.
  readMedia: (name: string) => Buffer | null;
  warnings: string[];
  // More notes than one import may bring: nothing else was read.
  tooMany?: number;
  reviewsSkipped?: boolean;
};

// ---- zstd and protobuf ----

// zstd in Node itself (zlib.zstdDecompressSync, Node ≥ 22.15 / 23.8).
export function zstdAvailable() {
  return typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function";
}
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const isZstd = (data: Buffer) => data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC);
export const ANKI21B_UNSUPPORTED =
  "Dieses Anki-Paket ist im neuen Format (Anki 2.1.50 und neuer) und braucht eine neuere Node-Version des Servers. Exportiere den Stapel in Anki mit „Ältere Anki-Versionen unterstützen“ und importiere ihn erneut.";
function unzstd(data: Buffer, max: number): Buffer {
  if (!zstdAvailable()) throw new HttpError(400, ANKI21B_UNSUPPORTED);
  try {
    return (zlib as unknown as { zstdDecompressSync: (b: Buffer, o: { maxOutputLength: number }) => Buffer }).zstdDecompressSync(data, { maxOutputLength: max });
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new HttpError(413, "Die Anki-Sammlung ist zu groß.");
    throw new HttpError(400, "Die Anki-Datei ist beschädigt.");
  }
}

type ProtoValue = number | Buffer;
// A protobuf message as its fields (number → values in order): varints as
// numbers (precise to 2^53, enough for the enums and sizes read here),
// length-delimited fields as bytes; fixed 32/64-bit fields are skipped.
export function protoFields(data: Buffer): Map<number, ProtoValue[]> {
  const out = new Map<number, ProtoValue[]>();
  let at = 0;
  const varint = () => {
    let value = 0,
      shift = 0;
    for (let i = 0; i < 10; i++) {
      if (at >= data.length) throw new Error("truncated");
      const byte = data[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
      shift += 7;
    }
    throw new Error("varint");
  };
  while (at < data.length) {
    const key = varint();
    const field = Math.floor(key / 8),
      wire = key % 8;
    let value: ProtoValue | null = null;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = varint();
      if (at + length > data.length) throw new Error("truncated");
      value = data.subarray(at, at + length);
      at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error("wire type");
    if (value !== null) out.set(field, [...(out.get(field) || []), value]);
  }
  return out;
}
const protoString = (fields: Map<number, ProtoValue[]>, n: number) => {
  const value = fields.get(n)?.[0];
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
};
const protoNumber = (fields: Map<number, ProtoValue[]>, n: number) => {
  const value = fields.get(n)?.[0];
  return typeof value === "number" ? value : 0;
};
const safeProto = (data: unknown) => {
  try {
    return Buffer.isBuffer(data) || data instanceof Uint8Array ? protoFields(Buffer.from(data as Uint8Array)) : new Map<number, ProtoValue[]>();
  } catch {
    return new Map<number, ProtoValue[]>();
  }
};

// ---- the package ----

export const isAnkiPackage = (entries: Map<string, Buffer>) => entries.has("collection.anki21b") || entries.has("collection.anki21") || entries.has("collection.anki2");

const COLLECTIONS: [string, AnkiFormat][] = [
  ["collection.anki21b", "anki21b"],
  ["collection.anki21", "anki21"],
  ["collection.anki2", "anki2"],
];
// meta: version 3 (latest) means compressed collection and media.
function packageVersion(entries: Map<string, Buffer>) {
  const meta = entries.get("meta");
  if (!meta) return 0;
  return protoNumber(safeProto(meta), 1);
}

const cleanKey = (key: string) => (key === "__proto__" || key === "constructor" || key === "prototype" ? "" : key);

export async function readAnkiPackage(bytes: Buffer): Promise<AnkiPackage> {
  if (bytes.length > ARCHIVE_LIMIT) throw new HttpError(413, "Anki-Pakete dürfen höchstens 100 MB groß sein.");
  // The collection and media files may be as large as the package.
  const entries = await readZip(bytes, { foreign: true, maxEntries: maxImportFiles() + 10, budget: { left: 1024 * 1024 * 1024 }, largeEntries: /^(collection\.anki2(1b?)?|\d+)$/ });
  if (!isAnkiPackage(entries)) throw new HttpError(400, "Die Datei ist kein Anki-Paket (.apkg oder .colpkg).");
  const latest = packageVersion(entries) >= 3;
  const warnings: string[] = [];
  let chosen = COLLECTIONS.find(([name]) => entries.has(name))!;
  if (chosen[1] === "anki21b" && !zstdAvailable()) {
    // The compatible collection next to it, when there is a real one.
    const legacy = COLLECTIONS.find(([name, format]) => format !== "anki21b" && entries.has(name));
    if (!legacy) throw new HttpError(400, ANKI21B_UNSUPPORTED);
    chosen = legacy;
    warnings.push("Das neue Anki-Format kann dieser Server nicht entpacken; gelesen wurde die mitgelieferte ältere Sammlung.");
  }
  let data = entries.get(chosen[0])!;
  if (chosen[1] === "anki21b" || isZstd(data)) data = unzstd(data, ANKI_LIMITS.collectionBytes);
  const result = readCollection(data, chosen[1], warnings);
  // The placeholder of newer exports: "Please update to the latest Anki version".
  if (chosen[1] !== "anki21b" && entries.has("collection.anki21b") && result.notes.length <= 1 && result.notes.some((n) => /update to the latest/i.test(n.fields.join(" "))))
    throw new HttpError(400, ANKI21B_UNSUPPORTED);
  // Media: the list of names, then each file by its entry.
  const media = new Map<string, AnkiMedia>();
  const list = entries.get("media");
  if (list?.length) {
    try {
      if (latest || isZstd(list)) {
        const decoded = protoFields(unzstd(list, 64 * 1024 * 1024));
        (decoded.get(1) || []).forEach((raw, index) => {
          if (!Buffer.isBuffer(raw)) return;
          const entry = protoFields(raw);
          const name = protoString(entry, 1);
          const legacyName = entry.get(255)?.[0];
          const key = typeof legacyName === "number" ? String(legacyName) : String(index);
          if (name && cleanKey(name) && entries.has(key)) media.set(name, { name, entry: key, size: protoNumber(entry, 2) || entries.get(key)!.length });
        });
      } else {
        const json = JSON.parse(list.toString("utf8")) as Record<string, unknown>;
        for (const [key, name] of Object.entries(json))
          if (typeof name === "string" && cleanKey(name) && /^\d+$/.test(key) && entries.has(key)) media.set(name, { name, entry: key, size: entries.get(key)!.length });
      }
    } catch {
      // Also without zstd in Node: the notes still come, without media.
      warnings.push("Die Medienliste des Anki-Pakets ist nicht lesbar; Bilder und Töne fehlen.");
    }
  }
  const readMedia = (name: string) => {
    const file = media.get(name);
    const raw = file ? entries.get(file.entry) : undefined;
    if (!raw) return null;
    try {
      return latest || isZstd(raw) ? unzstd(raw, ARCHIVE_LIMIT) : raw;
    } catch {
      return null;
    }
  };
  // Unpacked sizes of compressed media are those of the list.
  return { ...result, media, readMedia, warnings };
}

// ---- the collection ----

type Raw = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number(value) || 0);

function readCollection(data: Buffer, format: AnkiFormat, warnings: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-anki-"));
  const path = join(dir, "collection.sqlite");
  let db: DatabaseSync | null = null;
  try {
    writeFileSync(path, data, { mode: 0o600 });
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA query_only=1; PRAGMA trusted_schema=0;");
    } catch {
      throw new HttpError(400, "Die Anki-Sammlung kann nicht gelesen werden.");
    }
    const open = db;
    const tables = new Map<string, Set<string>>();
    try {
      for (const { name } of open.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(name)) continue;
        tables.set(name, new Set((open.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name)));
      }
    } catch {
      throw new HttpError(400, "Die Anki-Sammlung kann nicht gelesen werden.");
    }
    const has = (table: string, ...columns: string[]) => columns.every((c) => tables.get(table)?.has(c));
    if (!has("notes", "id", "mid", "flds", "tags") || !has("cards", "id", "nid", "did", "ord", "queue", "type")) throw new HttpError(400, "Die Datei ist keine Anki-Sammlung.");
    const all = (sql: string, ...params: (string | number)[]) => {
      try {
        return open.prepare(sql).all(...params) as Raw[];
      } catch {
        throw new HttpError(400, "Die Anki-Sammlung kann nicht gelesen werden.");
      }
    };
    const notetypes = new Map<string, AnkiNotetype>();
    const decks = new Map<string, AnkiDeck>();
    if (has("notetypes", "id", "name", "config") && has("fields", "ntid", "ord", "name") && has("templates", "ntid", "ord", "name", "config")) {
      // Schema 18.
      const fields = new Map<string, string[]>();
      for (const f of all(`SELECT CAST(ntid AS TEXT) ntid, ord, name FROM fields ORDER BY ntid, ord LIMIT ${ANKI_LIMITS.notetypes * ANKI_LIMITS.fields}`))
        fields.set(text(f.ntid), [...(fields.get(text(f.ntid)) || []), text(f.name)]);
      const templates = new Map<string, AnkiTemplate[]>();
      for (const t of all(`SELECT CAST(ntid AS TEXT) ntid, ord, name, config FROM templates ORDER BY ntid, ord LIMIT ${ANKI_LIMITS.notetypes * 50}`)) {
        const config = safeProto(t.config);
        templates.set(text(t.ntid), [...(templates.get(text(t.ntid)) || []), { name: text(t.name), qfmt: protoString(config, 1), afmt: protoString(config, 2) }]);
      }
      for (const n of all(`SELECT CAST(id AS TEXT) id, name, config FROM notetypes LIMIT ${ANKI_LIMITS.notetypes}`)) {
        const config = safeProto(n.config);
        const id = text(n.id);
        notetypes.set(id, { id, name: text(n.name).slice(0, 200), cloze: protoNumber(config, 1) === 1, stock: protoNumber(config, 9), fields: (fields.get(id) || []).slice(0, ANKI_LIMITS.fields), templates: templates.get(id) || [] });
      }
      if (has("decks", "id", "name"))
        for (const d of all(`SELECT CAST(id AS TEXT) id, name FROM decks LIMIT ${ANKI_LIMITS.decks}`))
          decks.set(text(d.id), { id: text(d.id), name: text(d.name).split("\u001f").join("::").slice(0, 500) });
    } else if (has("col", "models", "decks")) {
      // Schema 11: JSON in the single row of col.
      const col = all("SELECT models, decks FROM col LIMIT 1")[0];
      const parse = (value: unknown): Raw => {
        try {
          const parsed = JSON.parse(text(value) || "{}");
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Raw) : {};
        } catch {
          return {};
        }
      };
      for (const [key, raw] of Object.entries(parse(col?.models)).slice(0, ANKI_LIMITS.notetypes)) {
        if (!cleanKey(key) || !raw || typeof raw !== "object") continue;
        const m = raw as Raw;
        const flds = Array.isArray(m.flds) ? (m.flds as Raw[]) : [];
        const tmpls = Array.isArray(m.tmpls) ? (m.tmpls as Raw[]) : [];
        const id = text(m.id ?? key);
        notetypes.set(id, {
          id,
          name: text(m.name).slice(0, 200),
          cloze: num(m.type) === 1,
          stock: 0,
          fields: [...flds].sort((a, b) => num(a?.ord) - num(b?.ord)).map((f) => text(f?.name)).slice(0, ANKI_LIMITS.fields),
          templates: [...tmpls].sort((a, b) => num(a?.ord) - num(b?.ord)).slice(0, 50).map((t) => ({ name: text(t?.name), qfmt: text(t?.qfmt), afmt: text(t?.afmt) })),
        });
      }
      for (const [key, raw] of Object.entries(parse(col?.decks)).slice(0, ANKI_LIMITS.decks)) {
        if (!cleanKey(key) || !raw || typeof raw !== "object") continue;
        const d = raw as Raw;
        decks.set(text(d.id ?? key), { id: text(d.id ?? key), name: text(d.name).slice(0, 500) });
      }
    } else throw new HttpError(400, "Die Datei ist keine Anki-Sammlung.");

    const count = num(all("SELECT COUNT(*) n FROM notes")[0]?.n);
    if (count > ANKI_LIMITS.notes)
      return { format, notetypes, decks, notes: [] as AnkiNote[], cards: [] as AnkiCard[], reviews: [] as AnkiReview[], tooMany: count };
    let cut = 0;
    const notes = all(`SELECT CAST(id AS TEXT) id, CAST(mid AS TEXT) mid, tags, flds FROM notes ORDER BY id LIMIT ${ANKI_LIMITS.notes}`).map((n) => {
      const fields = text(n.flds)
        .split("\u001f")
        .slice(0, ANKI_LIMITS.fields)
        .map((f) => {
          if (f.length <= ANKI_LIMITS.fieldChars) return f;
          cut++;
          return f.slice(0, ANKI_LIMITS.fieldChars);
        });
      const tags = text(n.tags)
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 50)
        .map((t) => t.slice(0, 100));
      return { id: text(n.id), mid: text(n.mid), tags, fields };
    });
    if (cut) warnings.push(`${cut} sehr lange Felder wurden nach ${ANKI_LIMITS.fieldChars} Zeichen gekürzt.`);
    const odid = has("cards", "odid");
    const cards = all(
      `SELECT CAST(id AS TEXT) id, CAST(nid AS TEXT) nid, CAST(${odid ? "CASE WHEN odid<>0 THEN odid ELSE did END" : "did"} AS TEXT) did, ord, queue, type${has("cards", "data") ? ", data" : ""} FROM cards ORDER BY nid, ord LIMIT ${ANKI_LIMITS.cards}`,
    ).map((c) => ({ id: text(c.id), nid: text(c.nid), did: text(c.did), ord: num(c.ord), queue: num(c.queue), type: num(c.type), data: text(c.data).slice(0, 2000) }));
    let reviews: AnkiReview[] = [];
    let reviewsSkipped = false;
    if (has("revlog", "id", "cid", "ease", "type")) {
      const total = num(all("SELECT COUNT(*) n FROM revlog")[0]?.n);
      if (total > ANKI_LIMITS.reviews) reviewsSkipped = true;
      else reviews = all("SELECT id, CAST(cid AS TEXT) cid, ease, type FROM revlog ORDER BY id").map((r) => ({ at: num(r.id), cid: text(r.cid), ease: num(r.ease), type: num(r.type) }));
    }
    return { format, notetypes, decks, notes, cards, reviews, ...(reviewsSkipped ? { reviewsSkipped } : {}) };
  } finally {
    try {
      db?.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}
