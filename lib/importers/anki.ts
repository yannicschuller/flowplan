// The Anki import (docs/specs/flashcards.md §8.1): a package read by
// lib/importers/anki-read.ts becomes one flashcard database per top-level
// deck, its sub-decks as the values of a select property "Deck" – or, on
// request (#341), every sub-deck a database of its own below the page of
// the deck above it (a deck without notes of its own is a plain page).
// - Note types → card types: Basic, Basic (and reversed card) → basic with
//   the reverse card, Cloze → cloze (the syntax stays, in documents as the
//   editor's cloze mark), "type in the answer" → typed; Image Occlusion →
//   occlusion: the masks of its field "Occlusion" on the picture
//   (lib/study-occlusion.ts), the header above, Back Extra after revealing
//   (as basic on request: the picture on both sides, without masks). Own
//   note types: their templates tell which fields
//   are on the front ({{Feld}} in the question), on the back (only in the
//   answer) and hints ({{hint:Feld}}); the person may change every field's
//   role in the preview (lib/anki-mapping.ts).
// - Fields are foreign HTML: sanitised to basic formatting (no scripts,
//   styles, classes or event attributes), Anki's media references become
//   files of the import (images, `[sound:…]` as audio blocks), MathJax
//   \(…\) / \[…\] formulas. A side without media, lists, tables or formulas
//   stays a text property (inline Markdown); otherwise it goes into the
//   record's document (front above the horizontal rule, back below) –
//   decided per database and side.
// - Tags → the multi-select "Tags", the note type's kind → "Kartentyp".
// - The learning state (opt-in, only for the person importing): Anki's
//   review log replayed through FSRS (lib/study.ts importStudyHistory);
//   suspended cards stay suspended, new ones as suspended new cards.
// The databases are written by lib/importers/write.ts like every importer's
// (rights, quotas, files, the import report), in one transaction.
import { readFileSync, statSync } from "node:fs";
import sanitize from "sanitize-html";
import { id } from "../db";
import { HttpError } from "../auth";
import { jobProgress } from "../background-jobs";
import { ct } from "../content-locale";
import { instanceSettings } from "../instance-settings";
import { htmlToInline } from "../inline-markdown-html";
import { toPlain } from "../inline-markdown";
import { parseClozeText } from "../study-cloze";
import { fromAnkiOcclusion, type Occlusion } from "../study-occlusion";
import { imageSize } from "../export-docx";
import { studySettingsSchema } from "../study-schema";
import { importStudyHistory } from "../study";
import { studyZone } from "../study-day";
import { ARCHIVE_LIMIT } from "../archive";
import type { Field, Identity, View } from "../types";
import { ANKI_MAX_DATABASES, ankiOptionsSchema, type AnkiCardType, type AnkiKind, type AnkiOptions, type AnkiPreview, type AnkiRole, type NotetypeMapping } from "../anki-mapping";
import { ANKI_LIMITS, readAnkiPackage, type AnkiNote, type AnkiNotetype, type AnkiPackage } from "./anki-read";
import { esc, fileRef, mimeOf } from "./html";
import { importReport, maxImportFiles, type ImportFile, type ImportPage, type ImportTree } from "./types";
import { previewImport, requireSpace, writeImport, type ImportPreview, type ImportResult } from "./write";

// ---- note types ----

// Placeholders that are no field.
const SPECIAL = new Set(["FrontSide", "Tags", "Type", "Deck", "Subdeck", "Card", "CardFlag", "CardID"]);
// The fields a template shows ({{Feld}}, {{text:Feld}}, {{hint:Feld}},
// {{type:Feld}}, {{cloze:Text}}) with their filters; sections
// ({{#Feld}} … {{/Feld}}) and comments are no output.
export function templateRefs(format: string): { name: string; filter: string }[] {
  const out: { name: string; filter: string }[] = [];
  for (const m of format.matchAll(/\{\{([^{}]{1,300})\}\}/g)) {
    const inner = m[1].trim();
    if (/^[#^/!]/.test(inner)) continue;
    const parts = inner.split(":");
    const name = parts.pop()!.trim();
    if (!name || SPECIAL.has(name)) continue;
    out.push({ name, filter: parts.map((p) => p.trim().toLowerCase()).join(":") });
  }
  return out;
}

export function ankiKind(nt: Pick<AnkiNotetype, "name" | "cloze" | "stock" | "templates">): AnkiKind {
  if (nt.stock === 6 || /image occlusion|bildverdeckung/i.test(nt.name)) return "occlusion";
  if (nt.cloze || nt.stock === 5) return "cloze";
  if (nt.stock === 4 || /type in|eintippen/i.test(nt.name) || nt.templates.some((t) => /\{\{type:/i.test(t.qfmt))) return "typed";
  if (nt.stock === 3 || (/optional/i.test(nt.name) && nt.templates.length >= 2)) return "optional";
  if (nt.stock === 2 || (nt.templates.length >= 2 && /revers|umgekehrt|invers/i.test(nt.name))) return "reversed";
  if (nt.stock === 1 || /^(basic|einfach|basis)\b/i.test(nt.name)) return "basic";
  return "custom";
}

// The suggested mapping of a note type.
export function suggestNotetype(nt: AnkiNotetype): NotetypeMapping {
  const kind = ankiKind(nt);
  const roles: AnkiRole[] = nt.fields.map(() => "skip");
  const at = (name: string) => nt.fields.indexOf(name);
  const type: AnkiCardType = kind === "cloze" ? "cloze" : kind === "typed" ? "typed" : "basic";
  if (kind === "occlusion") {
    nt.fields.forEach((name, i) => {
      if (/^(header|titel|überschrift|image|bild)$/i.test(name)) roles[i] = "front";
      else if (/back extra|^extra$|rückseite/i.test(name)) roles[i] = "back";
      else if (/comments?|remarks?|kommentar|anmerkung/i.test(name)) roles[i] = "extra";
    });
    return { type: "occlusion", reverse: false, roles: fallback(roles) };
  }
  const template = nt.templates[0];
  const question = template ? templateRefs(template.qfmt).filter((r) => at(r.name) >= 0) : [];
  const answer = template ? templateRefs(template.afmt).filter((r) => at(r.name) >= 0) : [];
  for (const r of [...question, ...answer]) if (r.filter.includes("hint")) roles[at(r.name)] = "hint";
  for (const r of question) if (!r.filter.includes("hint") && !r.filter.includes("type")) roles[at(r.name)] = "front";
  let back = false;
  for (const r of answer) {
    const i = at(r.name);
    if (roles[i] !== "skip") continue;
    roles[i] = back ? "extra" : "back";
    back = true;
  }
  // Typing: the field typed into is the answer.
  for (const r of question) if (r.filter.includes("type") && roles[at(r.name)] === "skip") roles[at(r.name)] = back ? "extra" : "back";
  if (kind === "cloze") {
    // The cloze text in front, everything else after the answer.
    const text = question.find((r) => r.filter.includes("cloze")) || question[0];
    nt.fields.forEach((_, i) => {
      if (roles[i] === "front" && text && i !== at(text.name)) roles[i] = "extra";
    });
    if (!roles.includes("back")) {
      const extra = roles.indexOf("extra");
      if (extra >= 0) roles[extra] = "back";
    }
  }
  return { type, reverse: kind === "reversed", roles: fallback(roles) };
}
// Without anything on a side: the first field in front, the second behind.
function fallback(roles: AnkiRole[]): AnkiRole[] {
  const out = [...roles];
  if (!out.includes("front") && out.length) out[0] = "front";
  if (!out.includes("back") && out.length > 1) {
    const free = out.findIndex((r, i) => i > 0 && r === "skip");
    out[free >= 0 ? free : out.findIndex((r) => r !== "front")] = "back";
  }
  return out;
}

// ---- fields ----

// Media references, lists, tables, formulas or sub/superscript need the
// record's document; plain formatting fits a text property.
const RICH = /<img\b|\[sound:|<table\b|<[ou]l\b|<pre\b|<su[bp]\b|\\\(|\\\[|<video\b|<audio\b/i;
export const isRichField = (html: string) => RICH.test(html) || html.length > 4000;

const decode = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
const mediaName = (raw: string) => {
  const name = decode(raw).trim();
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};
// Anki's HTML down to basic formatting: no scripts or styles (their content
// goes too), no classes, styles or event attributes, links only http(s)
// and mail.
export function sanitizeAnkiHtml(html: string) {
  return sanitize(html, {
    allowedTags: ["b", "strong", "i", "em", "u", "s", "strike", "del", "sub", "sup", "br", "p", "div", "span", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "img", "a", "pre", "code", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr"],
    allowedAttributes: { img: ["src", "alt"], a: ["href"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    // A <div> per line, as Anki's editor writes them, stays a block.
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "head"],
  });
}

export type FieldContext = {
  // Media of the package by name → the import's file key (null: missing).
  media: (name: string) => string | null;
  missing: (name: string) => void;
};
// A field (or several, joined by line breaks) as document HTML: media as
// files of the import, formulas and clozes as the editor has them.
export function ankiDocumentHtml(html: string, ctx: FieldContext) {
  let out = sanitizeAnkiHtml(html);
  out = out.replace(/\[sound:([^\]]{1,300})\]/g, (_, raw: string) => {
    const name = mediaName(raw);
    const key = ctx.media(name);
    if (!key) {
      ctx.missing(name);
      return "";
    }
    return `<div data-import-file="${fileRef(key)}" data-title="${esc(name)}"></div>`;
  });
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1] || "";
    const name = mediaName(src);
    // Pictures from the web stay a link (nothing is loaded from elsewhere).
    if (/^https?:\/\//i.test(name)) return `<a href="${esc(name)}">${esc(name)}</a>`;
    const key = name ? ctx.media(name) : null;
    if (!key) {
      if (name) ctx.missing(name);
      return "";
    }
    return `<img src="${fileRef(key)}" alt="${esc(name)}">`;
  });
  out = out
    .replace(/\\\[([\s\S]{1,5000}?)\\\]/g, (_, tex: string) => `<div data-math="${esc(decode(tex.replace(/<[^>]*>/g, "")).trim())}" class="math-block"></div>`)
    .replace(/\\\(([\s\S]{1,2000}?)\\\)/g, (_, tex: string) => `<span data-math="${esc(decode(tex.replace(/<[^>]*>/g, "")).trim())}" class="math-inline"></span>`);
  if (out.includes("{{c"))
    out = parseClozeText(out)
      .map((s) =>
        s.type === "text"
          ? s.text
          : /[<>]/.test(s.answer + (s.hint || ""))
            ? `{{c${s.n}::${s.answer}${s.hint ? `::${s.hint}` : ""}}}`
            : `<span data-cloze="${s.n}"${s.hint ? ` data-cloze-hint="${esc(decode(s.hint))}"` : ""}>${s.answer}</span>`,
      )
      .join("");
  return out;
}
// A field as a text property: inline Markdown (bold, italic, strike, code,
// links); sounds and pictures do not fit and are left out.
export function ankiText(html: string) {
  const clean = sanitizeAnkiHtml(html.replace(/\[sound:[^\]]{1,300}\]/g, ""));
  return htmlToInline(clean).slice(0, 10_000);
}
export const ankiPlain = (html: string) => toPlain(ankiText(html)).replace(/\s+/g, " ").trim();

// ---- the plan ----

type Mapped = NotetypeMapping & { kind: AnkiKind };
const TYPE_OPTIONS = () => [
  ct("Vorder-/Rückseite", "Front/back"),
  ct("Lückentext", "Cloze"),
  ct("Antwort eintippen", "Type the answer"),
  ct("Multiple Choice", "Multiple choice"),
  ct("Bildverdeckung", "Image occlusion"),
];
const typeOption = (type: AnkiCardType) => TYPE_OPTIONS()[type === "cloze" ? 1 : type === "typed" ? 2 : type === "occlusion" ? 4 : 0];

export type AnkiPlan = {
  tree: ImportTree;
  preview: AnkiPreview;
  // For the learning state: the row of each note and how its cards map
  // (image occlusion: the card of each cloze number).
  rows: Map<string, { rowId: string; deck: number; mapping: Mapped; occlusion?: Map<number, string> }>;
};

// The masks of an Image Occlusion note (lib/study-occlusion.ts) on its
// first picture: from the field with "image-occlusion:" shapes, pixels of
// older Anki versions turned into proportions with the picture's size.
const FIRST_IMAGE = /<img\b[^>]*\bsrc="([^"]*)"/i;
function noteOcclusion(note: AnkiNote, pkg: AnkiPackage) {
  const field = note.fields.find((f) => f.includes("image-occlusion:"));
  if (!field) return null;
  const image = note.fields.map((f) => FIRST_IMAGE.exec(f)?.[1]).find(Boolean);
  const bytes = image ? pkg.readMedia(mediaName(image)) : null;
  return fromAnkiOcclusion(field, id, bytes ? imageSize(bytes) : null);
}
// The record's document with the masks on its first picture.
const withMasks = (html: string, occlusion: Occlusion) => html.replace(/<img\b/i, `<img data-occlusion="${esc(JSON.stringify(occlusion))}"`);

// What each role of a note gathers: its fields' HTML, in field order.
function sides(note: AnkiNote, mapping: NotetypeMapping) {
  const out: Record<AnkiRole, string[]> = { front: [], back: [], hint: [], extra: [], skip: [] };
  note.fields.forEach((value, i) => {
    const role = mapping.roles[i] || "skip";
    if (value.trim()) out[role].push(value);
  });
  return out;
}
const join = (parts: string[]) => parts.join("<br>");

export function planAnki(pkg: AnkiPackage, options: AnkiOptions, title: string, limits: { fileBytes: number; files: number }): AnkiPlan {
  const report = importReport();
  const warnings = [...pkg.warnings];
  // The mapping of every note type: the person's, else the suggestion.
  const mappings = new Map<string, Mapped>();
  for (const nt of pkg.notetypes.values()) {
    const chosen = options.notetypes[nt.id];
    const suggested = suggestNotetype(nt);
    const mapping = chosen ? { ...chosen, roles: nt.fields.map((_, i) => chosen.roles[i] || "skip") } : suggested;
    mappings.set(nt.id, { ...mapping, kind: ankiKind(nt) });
  }
  // Each note's deck: that of its first card.
  const cardsOf = new Map<string, AnkiPackage["cards"]>();
  for (const card of pkg.cards) cardsOf.set(card.nid, [...(cardsOf.get(card.nid) || []), card]);
  const deckOf = (note: AnkiNote) => {
    const first = [...(cardsOf.get(note.id) || [])].sort((a, b) => a.ord - b.ord)[0];
    return (first && pkg.decks.get(first.did)?.name) || "Default";
  };
  // The decks of the notes: a database per top-level deck (sub-decks as
  // values of "Deck"), or with sub-decks as databases one per deck path
  // with notes, below the page of the deck above it (#341).
  const paths = new Map<string, string[]>();
  let unknownType = 0;
  for (const note of pkg.notes) {
    if (!mappings.has(note.mid)) {
      unknownType++;
      continue;
    }
    paths.set(note.id, deckOf(note).split("::").map((part) => part.trim().slice(0, 200) || "Default"));
  }
  const pathsWithNotes = new Set([...paths.values()].map((p) => p.join("::")));
  let separate = options.subdecks === "databases" && [...paths.values()].some((p) => p.length > 1);
  if (separate && pathsWithNotes.size > ANKI_MAX_DATABASES) {
    separate = false;
    warnings.push(`Mehr als ${ANKI_MAX_DATABASES} Stapel: Unterstapel kommen in die Eigenschaft „Deck“ statt in eigene Datenbanken.`);
  }
  const groups = new Map<string, { path: string[]; notes: AnkiNote[]; subdecks: Set<string> }>();
  for (const note of pkg.notes) {
    const path = paths.get(note.id);
    if (!path) continue;
    const own = separate ? path : path.slice(0, 1);
    const key = own.join("::");
    const group = groups.get(key) || { path: own, notes: [], subdecks: new Set<string>() };
    group.notes.push(note);
    if (!separate && path.length > 1) group.subdecks.add(path.slice(1).join("::").slice(0, 100));
    groups.set(key, group);
  }
  if (unknownType) warnings.push(`${unknownType} Notizen ohne bekannten Notiztyp werden nicht übernommen.`);
  // Media: each file once, within the limits of an upload and an import.
  const files = new Map<string, ImportFile>();
  const media = { files: 0, bytes: 0, missing: 0, skipped: 0 };
  const missingNames = new Set<string>();
  const skippedNames = new Set<string>();
  const ctx = (deckKey: string): FieldContext => ({
    media: (name) => {
      const key = `anki-media/${name}`;
      if (files.has(key)) return key;
      const file = pkg.media.get(name);
      if (!file) return null;
      if (file.size > limits.fileBytes || files.size >= limits.files) {
        if (!skippedNames.has(name)) {
          skippedNames.add(name);
          report.add("file", `${name}: ${file.size > limits.fileBytes ? "größer als die Upload-Grenze" : "über der Grenze der Dateien je Import"}`, deckKey);
        }
        return null;
      }
      files.set(key, { key, name: name.slice(0, 200), mime: mimeOf(name), size: file.size, read: () => pkg.readMedia(name) || Buffer.alloc(0) });
      media.files++;
      media.bytes += file.size;
      return key;
    },
    missing: (name) => {
      if (skippedNames.has(name) || missingNames.has(name)) return;
      missingNames.add(name);
      report.add("file", `${name}: fehlt im Anki-Paket`, deckKey);
    },
  });
  const pages: ImportPage[] = [];
  const rows = new Map<string, { rowId: string; deck: number; mapping: Mapped; occlusion?: Map<number, string> }>();
  const deckInfo: AnkiPreview["decks"] = [];
  let occlusionNotes = 0,
    noMasks = 0,
    skippedShapes = 0;
  // Sub-decks as databases: the page of every deck above one (a database
  // when it has notes of its own, else a plain page holding them).
  const pageKeys = new Map<string, string>();
  const keyOf = (path: string[]) => pageKeys.get(path.join("::"));
  if (separate) {
    const needed = new Set<string>();
    for (const group of groups.values()) for (let n = 1; n < group.path.length; n++) needed.add(group.path.slice(0, n).join("::"));
    [...needed]
      .filter((p) => !groups.has(p))
      .sort((a, b) => a.split("::").length - b.split("::").length || a.localeCompare(b))
      .forEach((p, i) => pageKeys.set(p, `anki-folder-${i}`));
  }
  // Parents before children: shorter paths first.
  const ordered = [...groups].sort(([, a], [, b]) => a.path.length - b.path.length);
  ordered.forEach(([, group], deckIndex) => pageKeys.set(group.path.join("::"), `anki-deck-${deckIndex}`));
  for (const [p, key] of pageKeys) {
    if (!key.startsWith("anki-folder-")) continue;
    const path = p.split("::");
    pages.push({ key, parent: path.length > 1 ? keyOf(path.slice(0, -1)) ?? null : null, title: path[path.length - 1], html: "", folder: true });
  }
  const tops = new Map<string, AnkiPreview["decks"][number]>();
  ordered.forEach(([, group], deckIndex) => {
    const deckName = group.path.join("::");
    const key = `anki-deck-${deckIndex}`;
    const fieldCtx = ctx(key);
    const roleSides = group.notes.map((note) => {
      const mapping = mappings.get(note.mid)!;
      const s = sides(note, mapping);
      // Image occlusion: the masks go on the picture (the record's
      // document); as basic, the picture on both sides (Back Extra is
      // often empty), so the note still is a card.
      const occlusion = mapping.type === "occlusion" ? noteOcclusion(note, pkg) : null;
      if (mapping.type === "occlusion") {
        occlusionNotes++;
        skippedShapes += occlusion?.skipped || 0;
        if (!occlusion?.occlusion || !s.front.concat(s.back).some((f) => FIRST_IMAGE.test(f))) {
          noMasks++;
          report.add("block", "Bildverdeckung ohne Masken oder ohne Bild: keine Karte.", key);
        }
      } else if (mapping.kind === "occlusion" && !s.back.length) s.back = [...s.front];
      return { note, mapping, sides: s, occlusion };
    });
    // Per side: a text property, or the record's document.
    const richFront = roleSides.some((r) => r.sides.front.some(isRichField));
    const richBack = roleSides.some((r) => r.sides.back.some(isRichField));
    const basics = roleSides.filter((r) => r.mapping.type !== "cloze" && r.mapping.type !== "occlusion");
    const reversed = basics.filter((r) => r.mapping.reverse).length;
    const reverse = reversed > 0 && reversed * 2 >= basics.length;
    if (reversed > 0 && reversed < basics.length)
      warnings.push(`„${deckName}“: Notizen mit und ohne Rückwärtskarte – die Rückwärtskarte gilt in Flowplan für den ganzen Stapel (${reverse ? "an" : "aus"}).`);
    const hints = roleSides.some((r) => r.sides.hint.length),
      extras = roleSides.some((r) => r.sides.extra.length);
    const tags = [...new Set(group.notes.flatMap((n) => n.tags))];
    if (tags.length > 1000) warnings.push(`„${deckName}“: ${tags.length} Tags – übernommen werden die ersten 1000.`);
    const tagOptions = tags.slice(0, 1000);
    const known = new Set(tagOptions);
    const subdecks = [...group.subdecks].sort().slice(0, 1000);
    const fields: Field[] = [
      { id: "title", name: ct("Vorderseite", "Front"), type: "text" },
      ...(!richBack ? [{ id: "back", name: ct("Rückseite", "Back"), type: "text" } as Field] : []),
      ...(hints ? [{ id: "hint", name: ct("Hinweis", "Hint"), type: "text" } as Field] : []),
      ...(extras ? [{ id: "extra", name: ct("Zusatz", "Extra"), type: "text" } as Field] : []),
      { id: "tags", name: "Tags", type: "multiselect", options: tagOptions },
      { id: "type", name: ct("Kartentyp", "Card type"), type: "select", options: TYPE_OPTIONS() },
      ...(subdecks.length ? [{ id: "deck", name: ct("Deck", "Deck"), type: "select", options: subdecks } as Field] : []),
    ];
    const views: View[] = [
      { id: "study", name: ct("Lernen", "Study"), type: "study", filters: [], sorts: [], default: true } as View,
      { id: "table", name: ct("Alle Karten", "All cards"), type: "table", filters: [], sorts: [] } as View,
    ];
    const study = studySettingsSchema.parse({
      version: 1,
      type: { field: "type" },
      front: richFront ? { document: "above" } : { field: "title" },
      back: richBack ? { document: richFront ? "below" : "all" } : { field: "back" },
      ...(hints ? { hint: { field: "hint" } } : {}),
      ...(extras ? { extra: { field: "extra" } } : {}),
      tags: { field: "tags" },
      reverse,
    });
    const records = roleSides.map(({ note, mapping, sides: s, occlusion }) => {
      const rowId = id();
      rows.set(note.id, { rowId, deck: deckIndex, mapping, ...(occlusion?.occlusion ? { occlusion: occlusion.numbers } : {}) });
      if (mapping.kind === "occlusion" && mapping.type !== "occlusion") report.add("block", "Bildverdeckung: als Vorder-/Rückseite mit dem Bild übernommen (ohne Masken).", key);
      const front = join(s.front),
        back = join(s.back);
      const frontHtml = richFront ? ankiDocumentHtml(front, fieldCtx) : "",
        backHtml = richBack ? ankiDocumentHtml(back, fieldCtx) : "";
      // The masks go on the first picture of the document (normally the
      // field "Image" in front).
      const masks = occlusion?.occlusion;
      const onFront = !!masks && /<img\b/i.test(frontHtml);
      const html = richFront
        ? `${(onFront ? withMasks(frontHtml, masks) : frontHtml) || "<p></p>"}<hr>${masks && !onFront ? withMasks(backHtml, masks) : backHtml}`
        : richBack
          ? masks
            ? withMasks(backHtml, masks)
            : backHtml
          : "";
      const deck = separate ? "" : (paths.get(note.id) || []).slice(1).join("::").slice(0, 100);
      const cells: Record<string, unknown> = {
        // A picture without header is named by its file.
        title: (ankiPlain(front) || (masks ? mediaName(FIRST_IMAGE.exec(front + back)?.[1] || "") : "")).slice(0, 1000),
        ...(!richBack ? { back: ankiText(back) } : {}),
        ...(hints && s.hint.length ? { hint: ankiText(join(s.hint)) } : {}),
        ...(extras && s.extra.length ? { extra: ankiText(join(s.extra)) } : {}),
        tags: note.tags.filter((t) => known.has(t)),
        type: typeOption(mapping.type),
        ...(deck && subdecks.includes(deck) ? { deck } : {}),
      };
      return { id: rowId, cells, html };
    });
    const parent = group.path.length > 1 ? keyOf(group.path.slice(0, -1)) ?? null : null;
    pages.push({ key, parent, title: group.path[group.path.length - 1].slice(0, 200) || "Anki", html: "", kind: "database", database: { fields, views, rows: records, settings: { study } } });
    // The preview per top-level deck (its sub-decks' databases summed up).
    const top = tops.get(group.path[0]);
    const below = group.path.length > 1 ? [group.path.slice(1).join("::").slice(0, 100)] : [];
    if (top) {
      top.notes += group.notes.length;
      top.subdecks.push(...subdecks, ...below);
      top.rich ||= richFront || richBack;
      top.reverse ||= reverse;
    } else tops.set(group.path[0], { name: group.path[0], notes: group.notes.length, subdecks: [...subdecks, ...below], rich: richFront || richBack, reverse });
  });
  deckInfo.push(...[...tops.values()].map((d) => ({ ...d, subdecks: [...new Set(d.subdecks)].sort() })));
  media.missing = missingNames.size;
  media.skipped = skippedNames.size;
  if (missingNames.size) warnings.push(missingNames.size === 1 ? "1 Mediendatei fehlt im Anki-Paket." : `${missingNames.size} Mediendateien fehlen im Anki-Paket.`);
  if (skippedNames.size) warnings.push(`${skippedNames.size} Mediendateien sind zu groß oder zu viele und werden nicht übernommen.`);
  const asBasic = [...pkg.notes].filter((n) => mappings.get(n.mid)?.kind === "occlusion" && mappings.get(n.mid)?.type !== "occlusion").length;
  if (asBasic) warnings.push(`${asBasic} Bildverdeckungs-Notizen werden als Vorder-/Rückseite mit dem Bild übernommen (ohne Masken).`);
  if (noMasks) warnings.push(`${noMasks} von ${occlusionNotes} Bildverdeckungs-Notizen haben keine lesbaren Masken oder kein Bild und ergeben keine Karte.`);
  if (skippedShapes) warnings.push(`${skippedShapes} Formen der Bildverdeckung (Text oder unbekannt) werden nicht übernommen.`);
  if (pkg.reviewsSkipped) warnings.push(`Das Anki-Paket hat mehr als ${ANKI_LIMITS.reviews} Wiederholungen; der Lernstand kann nicht übernommen werden.`);
  const suspended = pkg.cards.filter((c) => c.queue === -1).length;
  const reviewed = new Set(pkg.reviews.map((r) => r.cid));
  const suspendedNew = pkg.cards.filter((c) => c.queue === -1 && !reviewed.has(c.id)).length;
  const noteCount = new Map<string, number>();
  for (const note of pkg.notes) noteCount.set(note.mid, (noteCount.get(note.mid) || 0) + 1);
  const preview: AnkiPreview = {
    format: pkg.format,
    notes: pkg.notes.length,
    cards: pkg.cards.length,
    reviews: pkg.reviews.length,
    suspended,
    suspendedNew,
    databases: pathsWithNotes.size,
    media,
    decks: deckInfo,
    notetypes: [...pkg.notetypes.values()]
      .filter((nt) => noteCount.get(nt.id))
      .map((nt) => {
        const mapping = mappings.get(nt.id)!;
        const notes = pkg.notes.filter((n) => n.mid === nt.id);
        return {
          id: nt.id,
          name: nt.name,
          kind: mapping.kind,
          notes: noteCount.get(nt.id) || 0,
          fields: nt.fields.map((name, i) => ({ name, sample: ankiPlain(notes.find((n) => n.fields[i]?.trim())?.fields[i] || "").slice(0, 80) })),
          mapping: { type: mapping.type, reverse: mapping.reverse, roles: mapping.roles },
          samples: notes.slice(0, 3).map((n) => {
            const s = sides(n, mapping);
            return { front: ankiPlain(join(s.front)).slice(0, 200), back: ankiPlain(join(s.back)).slice(0, 200) };
          }),
        };
      }),
  };
  const tree: ImportTree = { source: "anki", title, pages, files, warnings, report, maxRows: ANKI_LIMITS.notes };
  return { tree, preview, rows };
}

// ---- the import ----

export type AnkiImportOptions = { dryRun?: boolean; anki?: unknown; zone?: string };
const parseOptions = (raw: unknown): AnkiOptions => {
  if (typeof raw === "string" && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "Ungültige Zuordnung.");
    }
  }
  return ankiOptionsSchema.parse(raw && typeof raw === "object" ? raw : {});
};

export async function importAnki(
  user: Identity,
  workspaceId: string,
  spaceId: string,
  file: { name: string; bytes: Buffer } | { name: string; path: string },
  options: AnkiImportOptions = {},
): Promise<(ImportPreview | ImportResult) & { anki: AnkiPreview; reviews?: number }> {
  await requireSpace(user, workspaceId, spaceId);
  const opts = parseOptions(options.anki);
  if (!("bytes" in file) && statSync(file.path).size > ARCHIVE_LIMIT) throw new HttpError(413, "Anki-Pakete dürfen höchstens 100 MB groß sein.");
  const bytes = "bytes" in file ? file.bytes : readFileSync(file.path);
  const pkg = await readAnkiPackage(bytes);
  if (pkg.tooMany) throw new HttpError(413, `Das Anki-Paket hat ${pkg.tooMany} Notizen; erlaubt sind höchstens ${ANKI_LIMITS.notes} je Import.`);
  if (!pkg.notes.length) throw new HttpError(400, "Im Anki-Paket wurden keine Notizen gefunden.");
  await jobProgress(0.3);
  const title = file.name.replace(/\.(apkg|colpkg|zip)$/i, "").slice(0, 200) || "Anki";
  const plan = planAnki(pkg, opts, title, { fileBytes: Math.max(1, (await instanceSettings()).maxUploadMb) * 1024 * 1024, files: maxImportFiles() });
  await jobProgress(0.5);
  if (options.dryRun) return { ...(await previewImport(user, workspaceId, spaceId, plan.tree)), anki: plan.preview };
  const result = await writeImport(user, workspaceId, spaceId, plan.tree);
  let reviews = 0;
  if (opts.state && pkg.reviews.length) {
    await jobProgress(0.85);
    reviews = await replayAnki(user, pkg, plan, studyZone(options.zone));
  }
  return { ...result, anki: plan.preview, ...(opts.state ? { reviews } : {}) };
}

// The cards of a note as Flowplan's: Basic's first template is the card,
// its second the reverse; a cloze card N is "cN".
// Image occlusion: the mask or group of cloze number N.
export function cardSub(mapping: Pick<Mapped, "type">, ord: number, occlusion?: Map<number, string>) {
  if (mapping.type === "occlusion") return occlusion?.get(ord + 1) ?? null;
  if (mapping.type === "cloze") return `c${ord + 1}`;
  return ord === 0 ? "" : ord === 1 ? "r" : null;
}
// FSRS memory Anki stored with the card (≥ 23.10).
function ankiMemory(data: string) {
  try {
    const parsed = JSON.parse(data || "{}") as { s?: unknown; d?: unknown };
    const s = Number(parsed.s),
      d = Number(parsed.d);
    return Number.isFinite(s) && s > 0 && Number.isFinite(d) && d >= 1 && d <= 10 ? { stability: s, difficulty: d } : undefined;
  } catch {
    return undefined;
  }
}
async function replayAnki(user: Identity, pkg: AnkiPackage, plan: AnkiPlan, zone: string) {
  const byCard = new Map<string, { at: number; rating: 1 | 2 | 3 | 4 }[]>();
  for (const r of pkg.reviews)
    if (r.ease >= 1 && r.ease <= 4 && r.type >= 0 && r.type <= 3 && Number.isFinite(r.at) && r.at > 0)
      byCard.set(r.cid, [...(byCard.get(r.cid) || []), { at: r.at, rating: r.ease as 1 | 2 | 3 | 4 }]);
  const perRow = new Map<string, { rowId: string; sub: string; reviews: { at: number; rating: 1 | 2 | 3 | 4 }[]; suspended: boolean; memory?: { stability: number; difficulty: number } }[]>();
  for (const card of pkg.cards) {
    const row = plan.rows.get(card.nid);
    const reviews = byCard.get(card.id) || [];
    // A suspended card never studied stays a suspended new card.
    if (!row || (!reviews.length && card.queue !== -1)) continue;
    const sub = cardSub(row.mapping, card.ord, row.occlusion);
    if (sub === null) continue;
    const list = perRow.get(row.rowId) || [];
    list.push({ rowId: row.rowId, sub, reviews, suspended: card.queue === -1, memory: ankiMemory(card.data) });
    perRow.set(row.rowId, list);
  }
  let total = 0;
  const { one } = await import("../db");
  const decks = new Map<number, string[]>();
  for (const [rowId, row] of [...plan.rows].map(([, r]) => [r.rowId, r] as const)) if (perRow.has(rowId)) decks.set(row.deck, [...(decks.get(row.deck) || []), rowId]);
  for (const rowIds of decks.values()) {
    const page = await one<{ page_id: string }>("SELECT page_id FROM rows WHERE id=?", rowIds[0]);
    if (!page) continue;
    total += await importStudyHistory(user, page.page_id, rowIds.flatMap((r) => perRow.get(r) || []), zone);
  }
  return total;
}
