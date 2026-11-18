// db-dialect-scan: sqlite-only file – writes an Anki collection (its own SQLite file), never Flowplan's database.
// The Anki export (docs/specs/flashcards.md §8.2): a deck as an .apkg in the
// legacy format (collection.anki2, schema 11, and the `media` JSON), which
// every Anki version (desktop, AnkiDroid, AnkiMobile) imports. Note types:
// "Basic", "Basic (and reversed card)", "Basic (type in the answer)" and
// "Cloze" (each with Hint and Extra; named "… (Flowplan)" so they do not
// merge with a collection's own), multiple choice as Basic with the options
// on the front. Cards come as new – the learning state stays in Flowplan.
// The collection is written with node:sqlite into a temporary file and
// zipped with the media (lib/archive.ts writeZip).
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sanitize from "sanitize-html";
import { writeZip } from "./archive";

export type AnkiModelKind = "basic" | "reversed" | "typed" | "cloze";
// One note: its fields as Anki HTML (Front/Text, Back/Back Extra, Hint,
// Extra), the template ordinals of its cards (cloze N → N-1), its tags and
// sub-deck ("Teil::Kapitel" below the deck).
export type AnkiExportNote = { kind: AnkiModelKind; fields: [string, string, string, string]; ords: number[]; tags: string[]; subdeck?: string };
export type AnkiExportMedia = { name: string; data: Buffer };

const CSS = ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }\n.cloze { font-weight: bold; color: blue; }\n.nightMode .cloze { color: lightblue; }";
const HINT = "{{#Hint}}<br>{{hint:Hint}}{{/Hint}}";
const EXTRA = "{{#Extra}}<br><br>{{Extra}}{{/Extra}}";
const MODELS: Record<AnkiModelKind, { name: string; type: 0 | 1; fields: string[]; templates: { name: string; qfmt: string; afmt: string }[] }> = {
  basic: {
    name: "Basic (Flowplan)",
    type: 0,
    fields: ["Front", "Back", "Hint", "Extra"],
    templates: [{ name: "Card 1", qfmt: `{{Front}}${HINT}`, afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}${EXTRA}` }],
  },
  reversed: {
    name: "Basic (and reversed card) (Flowplan)",
    type: 0,
    fields: ["Front", "Back", "Hint", "Extra"],
    templates: [
      { name: "Card 1", qfmt: `{{Front}}${HINT}`, afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}${EXTRA}` },
      { name: "Card 2", qfmt: `{{Back}}${HINT}`, afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}${EXTRA}` },
    ],
  },
  typed: {
    name: "Basic (type in the answer) (Flowplan)",
    type: 0,
    fields: ["Front", "Back", "Hint", "Extra"],
    templates: [{ name: "Card 1", qfmt: `{{Front}}${HINT}\n\n{{type:Back}}`, afmt: `{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}${EXTRA}` }],
  },
  cloze: {
    name: "Cloze (Flowplan)",
    type: 1,
    fields: ["Text", "Back Extra", "Hint", "Extra"],
    templates: [{ name: "Cloze", qfmt: `{{cloze:Text}}${HINT}`, afmt: `{{cloze:Text}}<br>\n{{Back Extra}}${EXTRA}` }],
  },
};

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);`;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeAttr = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const FILE_ID = /\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
// A document side (sanitised HTML of a record's document) as an Anki field:
// the editor's cloze marks as {{cN::…(::hint)}}, formulas as \(…\) and
// \[…\], pictures and sounds of uploads as placeholders with the file's id
// (`file` registers it; the caller puts in the media name), everything else
// down to basic formatting.
export function ankiFieldHtml(html: string, file: (fileId: string) => string) {
  let out = html
    .replace(/<span\b[^>]*\bdata-math="([^"]*)"[^>]*>\s*<\/span>/g, (_, tex: string) => escapeHtml(`\\(${unescapeAttr(tex)}\\)`))
    .replace(/<div\b[^>]*\bdata-math="([^"]*)"[^>]*>\s*<\/div>/g, (_, tex: string) => escapeHtml(`\\[${unescapeAttr(tex)}\\]`))
    .replace(/<(audio|video)\b[^>]*\bsrc="([^"]*)"[^>]*>(?:\s*<\/\1>)?/gi, (_, _tag: string, src: string) => {
      const id = FILE_ID.exec(src)?.[1];
      return id ? `[sound:${file(id)}]` : "";
    });
  // Cloze marks (innermost text; nested marks are flattened by Anki's syntax).
  for (let i = 0; i < 5 && /data-cloze="/.test(out); i++)
    out = out.replace(/<span\b([^>]*)\bdata-cloze="(\d{1,2})"([^>]*)>((?:(?!<span\b)[\s\S])*?)<\/span>/g, (_, a: string, n: string, b: string, inner: string) => {
      const hint = /\bdata-cloze-hint="([^"]*)"/.exec(a + b)?.[1];
      return `{{c${n}::${inner}${hint ? `::${hint}` : ""}}}`;
    });
  out = sanitize(out, {
    allowedTags: ["b", "strong", "i", "em", "u", "s", "sub", "sup", "br", "p", "div", "span", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "img", "a", "pre", "code", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "mark"],
    allowedAttributes: { img: ["src", "alt"], a: ["href"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      img: (tagName, attribs): sanitize.Tag => {
        const id = FILE_ID.exec(attribs.src || "")?.[1];
        return id ? { tagName, attribs: { src: file(id) } } : { tagName: "span", attribs: {} as Record<string, string> };
      },
    },
  });
  // Upload links in the text stay out (Anki cannot reach them).
  return out.replace(/<a href="\/api\/files\/[^"]*">([\s\S]*?)<\/a>/g, "$1").trim();
}

// Anki's checksum of a note's first field: the first 8 hex digits of the
// SHA-1 of its text without HTML.
export const fieldText = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
const checksum = (text: string) => parseInt(createHash("sha1").update(text).digest("hex").slice(0, 8), 16);
const GUID = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";
const guid = () => [...randomBytes(10)].map((b) => GUID[b % GUID.length]).join("");
const tagText = (tags: string[]) => {
  const clean = [...new Set(tags.map((t) => t.trim().replace(/\s+/g, "_")).filter(Boolean))];
  return clean.length ? ` ${clean.join(" ")} ` : "";
};

function deckJson(id: number, name: string, now: number) {
  return { id, name, mod: Math.floor(now / 1000), usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false, desc: "", dyn: 0, conf: 1, extendNew: 0, extendRev: 0 };
}
const DCONF = {
  1: {
    id: 1,
    name: "Default",
    mod: 0,
    usn: 0,
    maxTaken: 60,
    autoplay: true,
    timer: 0,
    replayq: true,
    dyn: false,
    new: { delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, separate: true, order: 1, perDay: 20, bury: false },
    rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 },
    lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 1 },
  },
};

// The .apkg of a deck.
export async function buildAnkiPackage(deckName: string, notes: AnkiExportNote[], media: AnkiExportMedia[], now = Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-anki-export-"));
  const path = join(dir, "collection.anki2");
  try {
    const db = new DatabaseSync(path);
    try {
      db.exec(SCHEMA);
      const name = deckName.replace(/::+/g, ":").trim() || "Flowplan";
      // Ids are milliseconds in Anki; models and decks get their own range.
      const baseId = now - (now % 1000);
      const decks: Record<string, unknown> = { 1: deckJson(1, "Default", now) };
      const deckIds = new Map<string, number>();
      const deckId = (sub?: string) => {
        const full = sub ? `${name}::${sub.split("::").map((p) => p.trim()).filter(Boolean).join("::")}` : name;
        let did = deckIds.get(full);
        if (!did) {
          did = baseId + 100 + deckIds.size;
          deckIds.set(full, did);
          decks[String(did)] = deckJson(did, full, now);
        }
        return did;
      };
      deckId();
      const used = new Set(notes.map((n) => n.kind));
      const models: Record<string, unknown> = {};
      const modelIds = new Map<AnkiModelKind, number>();
      [...used].forEach((kind, i) => {
        const model = MODELS[kind];
        const mid = baseId + 10 + i;
        modelIds.set(kind, mid);
        models[String(mid)] = {
          id: mid,
          name: model.name,
          type: model.type,
          mod: Math.floor(now / 1000),
          usn: -1,
          sortf: 0,
          did: deckIds.get(name),
          tmpls: model.templates.map((t, ord) => ({ name: t.name, ord, qfmt: t.qfmt, afmt: t.afmt, did: null, bqfmt: "", bafmt: "" })),
          flds: model.fields.map((f, ord) => ({ name: f, ord, sticky: false, rtl: false, font: "Arial", size: 20, media: [] })),
          css: CSS,
          latexPre: "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
          latexPost: "\\end{document}",
          latexsvg: false,
          req: model.type === 1 ? [[0, "any", [0]]] : model.templates.map((_, ord) => [ord, "any", [ord === 1 ? 1 : 0]]),
          tags: [],
          vers: [],
        };
      });
      const conf = { activeDecks: [1], curDeck: deckIds.get(name), newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: null, nextPos: notes.length + 1, sortType: "noteFld", sortBackwards: false, addToCur: true };
      const insertNote = db.prepare("INSERT INTO notes(id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data) VALUES(?,?,?,?,?,?,?,?,?,0,'')");
      const insertCard = db.prepare("INSERT INTO cards(id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES(?,?,?,?,?,-1,0,0,?,0,0,0,0,0,0,0,0,'')");
      const seconds = Math.floor(now / 1000);
      let cardId = baseId - 10_000_000;
      db.exec("BEGIN");
      notes.forEach((note, i) => {
        const nid = baseId - 20_000_000 - notes.length + i;
        const sort = fieldText(note.fields[0]);
        insertNote.run(nid, guid(), modelIds.get(note.kind)!, seconds, -1, tagText(note.tags), note.fields.join("\u001f"), sort, checksum(sort));
        const did = deckId(note.subdeck);
        for (const ord of [...new Set(note.ords)].sort((a, b) => a - b)) insertCard.run(++cardId, nid, did, ord, seconds, i + 1);
      });
      db.exec("COMMIT");
      db.prepare("INSERT INTO col VALUES(1,?,?,?,11,0,0,0,?,?,?,?,'{}')").run(Math.floor((now - (now % 86_400_000)) / 1000), now, now, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(DCONF));
    } finally {
      db.close();
    }
    const entries = new Map<string, Buffer>([["collection.anki2", readFileSync(path)]]);
    const list: Record<string, string> = {};
    media.forEach((file, i) => {
      list[String(i)] = file.name;
      entries.set(String(i), file.data);
    });
    entries.set("media", Buffer.from(JSON.stringify(list)));
    return await writeZip(entries);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
