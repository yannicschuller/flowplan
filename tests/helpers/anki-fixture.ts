// db-dialect-scan: sqlite-only file – builds Anki collections (their own SQLite files) for the tests.
// Small Anki packages for the import tests (tests/study-anki.test.ts and the
// browser spec): a legacy collection (schema 11, JSON in `col`) or a new one
// (schema 18, note types in tables with protobuf settings, zstd-compressed,
// as Anki ≥ 2.1.50 writes without "support older versions"), built with
// node:sqlite and zipped with yazl – never downloaded.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { ZipFile } from "yazl";

export type FixtureNotetype = { id: number; name: string; cloze?: boolean; stock?: number; fields: string[]; templates: { name: string; qfmt: string; afmt: string }[] };
export type FixtureNote = { id: number; mid: number; fields: string[]; tags?: string[]; deck: number; cards?: { ord: number; queue?: number; data?: string; id?: number }[] };
export type FixtureReview = { at: number; cardId: number; ease: number; type?: number };
export type Fixture = {
  notetypes: FixtureNotetype[];
  decks: { id: number; name: string }[];
  notes: FixtureNote[];
  reviews?: FixtureReview[];
  media?: Record<string, Buffer>;
  format?: "legacy" | "latest";
};

export const BASIC: FixtureNotetype = { id: 1001, name: "Basic", fields: ["Front", "Back"], templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}" }] };
export const REVERSED: FixtureNotetype = {
  id: 1002,
  name: "Basic (and reversed card)",
  fields: ["Front", "Back"],
  templates: [
    { name: "Card 1", qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}" },
    { name: "Card 2", qfmt: "{{Back}}", afmt: "{{FrontSide}}<hr id=answer>{{Front}}" },
  ],
};
export const CLOZE: FixtureNotetype = { id: 1003, name: "Cloze", cloze: true, fields: ["Text", "Back Extra"], templates: [{ name: "Cloze", qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}<br>{{Back Extra}}" }] };
export const TYPED: FixtureNotetype = { id: 1004, name: "Basic (type in the answer)", fields: ["Front", "Back"], templates: [{ name: "Card 1", qfmt: "{{Front}}\n{{type:Back}}", afmt: "{{Front}}<hr id=answer>{{type:Back}}" }] };
export const OCCLUSION: FixtureNotetype = { id: 1005, name: "Image Occlusion", cloze: true, stock: 6, fields: ["Occlusion", "Image", "Header", "Back Extra", "Comments"], templates: [{ name: "Image Occlusion", qfmt: "{{cloze:Occlusion}}", afmt: "{{cloze:Occlusion}}" }] };
// An own note type: the word on the front, meaning and example behind, a hint.
export const VOCAB: FixtureNotetype = {
  id: 1006,
  name: "Vokabel",
  fields: ["Wort", "Bedeutung", "Beispiel", "Eselsbrücke", "Notiz intern"],
  templates: [{ name: "Karte", qfmt: "{{Wort}}{{#Eselsbrücke}}<br>{{hint:Eselsbrücke}}{{/Eselsbrücke}}", afmt: "{{FrontSide}}<hr id=answer>{{Bedeutung}}<br><i>{{Beispiel}}</i>" }],
};

// A 1×1 PNG.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
// The first bytes of an MP3 (an ID3 header).
export const MP3 = Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000", "latin1"), Buffer.alloc(64)]);

// ---- protobuf (schema 18 settings) ----
const varint = (n: number) => {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
};
const pbVarint = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);
const pbBytes = (field: number, value: Buffer | string) => {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
};

const SCHEMA11 = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);`;
const SCHEMA18 = `
CREATE TABLE notetypes (id integer not null primary key, name text not null, mtime_secs integer not null, usn integer not null, config blob not null);
CREATE TABLE fields (ntid integer not null, ord integer not null, name text not null, config blob not null, primary key (ntid, ord));
CREATE TABLE templates (ntid integer not null, ord integer not null, name text not null, mtime_secs integer not null, usn integer not null, config blob not null, primary key (ntid, ord));
CREATE TABLE decks (id integer primary key not null, name text not null, mtime_secs integer not null, usn integer not null, common blob not null, kind blob not null);`;

// The collection's SQLite file.
function collection(fixture: Fixture): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "anki-fixture-"));
  const path = join(dir, "collection");
  try {
    const db = new DatabaseSync(path);
    db.exec(SCHEMA11);
    const latest = fixture.format === "latest";
    if (latest) {
      db.exec(SCHEMA18);
      for (const nt of fixture.notetypes) {
        db.prepare("INSERT INTO notetypes VALUES(?,?,0,0,?)").run(nt.id, nt.name, Buffer.concat([pbVarint(1, nt.cloze ? 1 : 0), pbBytes(3, ".card {}"), ...(nt.stock ? [pbVarint(9, nt.stock)] : [])]));
        nt.fields.forEach((f, ord) => db.prepare("INSERT INTO fields VALUES(?,?,?,?)").run(nt.id, ord, f, Buffer.alloc(0)));
        nt.templates.forEach((t, ord) => db.prepare("INSERT INTO templates VALUES(?,?,?,0,0,?)").run(nt.id, ord, t.name, Buffer.concat([pbBytes(1, t.qfmt), pbBytes(2, t.afmt)])));
      }
      for (const d of fixture.decks) db.prepare("INSERT INTO decks VALUES(?,?,0,0,?,?)").run(d.id, d.name.split("::").join("\u001f"), Buffer.alloc(0), Buffer.alloc(0));
      db.prepare("INSERT INTO col VALUES(1,0,0,0,18,0,0,0,'','','','','')").run();
    } else {
      const models = Object.fromEntries(
        fixture.notetypes.map((nt) => [
          String(nt.id),
          { id: nt.id, name: nt.name, type: nt.cloze ? 1 : 0, flds: nt.fields.map((name, ord) => ({ name, ord })), tmpls: nt.templates.map((t, ord) => ({ ...t, ord })) },
        ]),
      );
      const decks = Object.fromEntries(fixture.decks.map((d) => [String(d.id), { id: d.id, name: d.name }]));
      db.prepare("INSERT INTO col VALUES(1,0,0,0,11,0,0,0,'{}',?,?,'{}','{}')").run(JSON.stringify(models), JSON.stringify(decks));
    }
    let cardId = 5000;
    for (const note of fixture.notes) {
      db.prepare("INSERT INTO notes VALUES(?,?,?,0,0,?,?,'',0,0,'')").run(note.id, `g${note.id}`, note.mid, note.tags?.length ? ` ${note.tags.join(" ")} ` : "", note.fields.join("\u001f"));
      for (const card of note.cards || [{ ord: 0 }])
        db.prepare("INSERT INTO cards VALUES(?,?,?,?,0,0,0,?,0,0,0,0,0,0,0,0,0,?)").run(card.id ?? ++cardId, note.id, note.deck, card.ord, card.queue ?? 0, card.data ?? "");
    }
    // The review's time is its id: one millisecond apart where two coincide.
    (fixture.reviews || []).forEach((r, i) => db.prepare("INSERT INTO revlog VALUES(?,?,0,?,0,0,0,1000,?)").run(r.at + i, r.cardId, r.ease, r.type ?? 1));
    db.close();
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The .apkg.
export async function ankiPackage(fixture: Fixture): Promise<Buffer> {
  const latest = fixture.format === "latest";
  const zip = new ZipFile();
  const data = collection(fixture);
  const media = Object.entries(fixture.media || {});
  if (latest) {
    zip.addBuffer(zstdCompressSync(data), "collection.anki21b");
    zip.addBuffer(pbVarint(1, 3), "meta");
    zip.addBuffer(zstdCompressSync(Buffer.concat(media.map(([name, bytes]) => pbBytes(1, Buffer.concat([pbBytes(1, name), pbVarint(2, bytes.length)]))))), "media");
    media.forEach(([, bytes], i) => zip.addBuffer(zstdCompressSync(bytes), String(i)));
  } else {
    zip.addBuffer(data, "collection.anki2");
    zip.addBuffer(Buffer.from(JSON.stringify(Object.fromEntries(media.map(([name], i) => [String(i), name])))), "media");
    media.forEach(([, bytes], i) => zip.addBuffer(bytes, String(i)));
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// A deck with every note type (legacy format unless `format` says latest).
export function sampleFixture(format: Fixture["format"] = "legacy"): Fixture {
  const day = 86_400_000;
  const start = Date.UTC(2026, 9, 1, 8);
  return {
    format,
    notetypes: [BASIC, REVERSED, CLOZE, TYPED, OCCLUSION, VOCAB],
    decks: [
      { id: 1, name: "Default" },
      { id: 10, name: "Spanisch" },
      { id: 11, name: "Spanisch::Lektion 1" },
      { id: 20, name: "Biologie" },
    ],
    notes: [
      { id: 1, mid: BASIC.id, fields: ["<b>hola</b>", "hallo<script>alert(1)</script>"], tags: ["gruss", "a1"], deck: 10, cards: [{ ord: 0, id: 101 }] },
      { id: 2, mid: REVERSED.id, fields: ["perro", "<span style=\"color:red\" onclick=\"x()\">Hund</span>"], tags: ["tiere"], deck: 11, cards: [{ ord: 0, id: 201 }, { ord: 1, id: 202 }] },
      { id: 3, mid: TYPED.id, fields: ["gato", "Katze"], deck: 11, cards: [{ ord: 0, id: 301, queue: -1 }] },
      { id: 4, mid: VOCAB.id, fields: ["la casa", "das Haus", "Mi casa es su casa.", "Haus", "nur für mich"], deck: 10, cards: [{ ord: 0, id: 401 }] },
      { id: 5, mid: CLOZE.id, fields: ["Die {{c1::Mitochondrien}} sind die {{c2::Kraftwerke::Bild}} der Zelle. H<sub>2</sub>O", "Zellbiologie"], tags: ["zelle"], deck: 20, cards: [{ ord: 0, id: 501 }, { ord: 1, id: 502 }] },
      { id: 6, mid: BASIC.id, fields: ["Was zeigt das Bild? <img src=\"zelle.png\">", "Eine Zelle [sound:zelle.mp3] <img src=\"fehlt.png\">"], deck: 20, cards: [{ ord: 0, id: 601 }] },
      { id: 7, mid: OCCLUSION.id, fields: ["{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}", "<img src=\"zelle.png\">", "Organellen", "", ""], deck: 20, cards: [{ ord: 0, id: 701 }] },
      { id: 8, mid: BASIC.id, fields: ["Formel?", "\\(E=mc^2\\)"], deck: 20, cards: [{ ord: 0, id: 801, data: '{"s":42.5,"d":4.2}' }] },
    ],
    reviews: [
      { at: start, cardId: 101, ease: 3, type: 0 },
      { at: start + 10 * 60_000, cardId: 101, ease: 3, type: 0 },
      { at: start + 3 * day, cardId: 101, ease: 3, type: 1 },
      { at: start, cardId: 202, ease: 1, type: 0 },
      { at: start + 60_000, cardId: 202, ease: 4, type: 0 },
      { at: start, cardId: 301, ease: 3, type: 0 },
      { at: start, cardId: 501, ease: 2, type: 0 },
      // A manual change is no review.
      { at: start + day, cardId: 501, ease: 0, type: 4 },
      { at: start, cardId: 801, ease: 4, type: 0 },
      { at: start + 5 * day, cardId: 801, ease: 3, type: 1 },
    ],
    media: { "zelle.png": PNG, "zelle.mp3": MP3, "unbenutzt.png": PNG },
  };
}
