// What a marketplace needs to show a flashcard deck without Flowplan's own
// code (docs: Marketplace, docs/specs/flashcards.md §8.4):
// `payload/study-meta.json` next to payload/template.zip in every package of
// a database template with a card mapping (`settings.study`), the template
// itself left unchanged so imports keep working –
//
//   { format: "flowplan.study-meta", version: 1,
//     records, cards, reverse,
//     types: { basic?, cloze?, typed?, choice?, occlusion? }   (cards per type)
//     samples: [ { type,
//                  front: [ {text, gap?: true} ], back: [ {text, gap?: true} ],
//                  choices?: [text],                         (multiple choice, sorted)
//                  image?: { file: <id of files/<id> in payload/template.zip>, alt },
//                  masks?: [ {shape: "rect"|"ellipse"|"polygon", x, y, w, h,
//                             points?: [[x, y]], label?, asked?: true} ] } ] }
//
// Plain text only, never HTML: a side is a list of runs; `gap` marks a
// cloze – on the front the hidden gap (its text is the hint or "…"), on the
// back the revealed answer. Masks are fractions (0–1) of the picture. The
// picture of an occlusion sample is one of the template's own attachments
// (only PNG, JPEG or WebP; others are left out, the masks stay). At most
// five samples, one per card type first, from the records in their order.
// No learning state (memory, due dates, reviews) and nothing about people:
// the deck's numbers and the content of a few cards. Package text, not
// interface text.
import { Parser } from "htmlparser2";
import { clozeHtml, parseClozeText } from "./study-cloze";
import { deriveCards, sideIsEmpty, sidePlain, type CardSide, type DerivedCard } from "./study-content";
import { cardTypes, fittingStudySettings, type CardType } from "./study-schema";
import { toPlain } from "./inline-markdown";
import type { Field } from "./types";

export const STUDY_META_FORMAT = "flowplan.study-meta";
export const STUDY_META_VERSION = 1;
export const STUDY_META_PATH = "payload/study-meta.json";
export const STUDY_META_LIMITS = { samples: 5, runs: 40, run: 500, side: 1200, choices: 5, choice: 200, masks: 100, points: 64, label: 200, alt: 200, bytes: 64 * 1024 } as const;

export type StudyRun = { text: string; gap?: true };
export type StudyMetaMask = { shape: "rect" | "ellipse" | "polygon"; x: number; y: number; w: number; h: number; points?: [number, number][]; label?: string; asked?: true };
export type StudySample = { type: CardType; front: StudyRun[]; back: StudyRun[]; choices?: string[]; image?: { file: string; alt: string }; masks?: StudyMetaMask[] };
export type StudyMeta = {
  format: typeof STUDY_META_FORMAT;
  version: number;
  records: number;
  cards: number;
  reverse: boolean;
  types: Partial<Record<CardType, number>>;
  samples: StudySample[];
};

// The content of a database template (flowplan-template-1's payload).
export type DeckContent = {
  database?: { fields?: Field[]; settings?: { study?: unknown } };
  rows?: { cells?: Record<string, unknown>; content?: string }[];
};
export type TemplateFile = { id: string; mime: string };

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const fileId = (src: string) => /^\/api\/files\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(src)?.[1]?.toLowerCase() ?? null;
const round = (n: number) => Math.round(n * 10000) / 10000;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Runs: adjacent ones of the same kind joined, whitespace tidied, the side
// cut at STUDY_META_LIMITS.side characters.
function tidy(runs: StudyRun[]): StudyRun[] {
  const out: StudyRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && !last.gap && !r.gap) last.text += r.text;
    else out.push(r.gap ? { text: r.text, gap: true } : { text: r.text });
  }
  for (const r of out) r.text = r.text.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n");
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, "");
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, "");
  }
  let left: number = STUDY_META_LIMITS.side;
  const cut: StudyRun[] = [];
  for (const r of out.filter((x) => x.text).slice(0, STUDY_META_LIMITS.runs)) {
    if (left <= 0) break;
    const text = clip(r.text.slice(0, STUDY_META_LIMITS.run), Math.min(STUDY_META_LIMITS.run, left));
    left -= text.length;
    cut.push(r.gap ? { text, gap: true } : { text });
  }
  return cut;
}

const BLOCKS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "tr", "summary", "details", "figcaption", "aside"]);
// The runs of HTML whose clozes clozeHtml marked (span.cloze-gap hidden,
// span.cloze-answer revealed).
function htmlRuns(html: string): StudyRun[] {
  const runs: StudyRun[] = [];
  const stack: boolean[] = [];
  let inGap = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "br") runs.push({ text: "\n" });
        if (BLOCKS.has(name)) runs.push({ text: "\n" });
        if (name === "span") {
          const cls = ` ${attributes.class || ""} `;
          const gap = cls.includes(" cloze-gap ") || cls.includes(" cloze-answer ");
          stack.push(gap);
          if (gap) inGap++;
        }
      },
      onclosetag(name) {
        if (BLOCKS.has(name)) runs.push({ text: "\n" });
        if (name === "span" && stack.pop()) inGap--;
      },
      ontext(text) {
        runs.push(inGap > 0 ? { text, gap: true } : { text });
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  // A hidden gap reads "[…]" / "[hint]": its text without the brackets.
  return runs.map((r) => (r.gap ? { text: r.text.replace(/^\[(.*)\]$/s, "$1") || "…", gap: true } : r));
}

// A side as runs: plain text, or (a cloze card's side with the clozes) the
// gaps of number n hidden or revealed, the other clozes as text.
function sideRuns(side: CardSide, cloze?: { n: number; revealed: boolean }): StudyRun[] {
  if (!cloze) return tidy([{ text: sidePlain(side) }]);
  if ("html" in side) return tidy(htmlRuns(clozeHtml(side.html, cloze.n, cloze.revealed)));
  const text = side.text;
  return tidy(
    parseClozeText(text).map((s) => {
      const plain = (t: string) => (side.formatted ? toPlain(t) : t);
      if (s.type === "text") return { text: plain(s.text) };
      if (s.n !== cloze.n) return { text: plain(s.answer) };
      return cloze.revealed ? { text: plain(s.answer), gap: true as const } : { text: s.hint || "…", gap: true as const };
    }),
  );
}

function sample(card: DerivedCard, others: string[], files: Map<string, string>): StudySample {
  const type = card.kind;
  if (card.cloze) {
    const on = card.cloze.on === "front" ? card.front : card.back;
    const other = card.cloze.on === "front" ? card.back : card.front;
    const front = sideRuns(on, { n: card.cloze.n, revealed: false });
    const back = sideRuns(on, { n: card.cloze.n, revealed: true });
    const rest = sideIsEmpty(other) ? [] : sideRuns(other);
    return { type, front, back: tidy([...back, ...(rest.length ? [{ text: "\n" }, ...rest] : [])]) };
  }
  const front = sideRuns(card.front);
  const back = sideRuns(card.back);
  const out: StudySample = { type, front, back };
  if (type === "choice") {
    const correct = sidePlain(card.back);
    const wrong = (card.choices?.length ? card.choices : others.filter((o) => o && o !== correct)).slice(0, STUDY_META_LIMITS.choices - 1);
    out.choices = [...new Set([correct, ...wrong].map((c) => clip(c, STUDY_META_LIMITS.choice)))].sort((a, b) => a.localeCompare(b));
  }
  if (card.occlusion) {
    const o = card.occlusion;
    const id = fileId(o.src);
    const mime = id ? files.get(id) : undefined;
    if (id && mime && IMAGE_MIMES.has(mime)) out.image = { file: id, alt: clip(o.alt || "", STUDY_META_LIMITS.alt) };
    const asked = new Set(o.target);
    out.masks = o.masks.slice(0, STUDY_META_LIMITS.masks).map((m) => ({
      shape: m.shape,
      x: round(m.x),
      y: round(m.y),
      w: round(m.w),
      h: round(m.h),
      ...(m.shape === "polygon" && m.points ? { points: m.points.slice(0, STUDY_META_LIMITS.points).map(([x, y]) => [round(x), round(y)] as [number, number]) } : {}),
      ...(m.label ? { label: clip(m.label, STUDY_META_LIMITS.label) } : {}),
      ...(asked.has(m.id) ? { asked: true as const } : {}),
    }));
  }
  return out;
}

// The deck's numbers and samples, or null when the template is no deck (no
// mapping, or one that does not fit its properties – then applying it
// gives no cards either).
export function studyMeta(content: DeckContent, files: TemplateFile[] = []): StudyMeta | null {
  const fields = Array.isArray(content.database?.fields) ? content.database!.fields! : [];
  const settings = fittingStudySettings(content.database?.settings?.study, fields);
  if (!settings) return null;
  const rows = Array.isArray(content.rows) ? content.rows : [];
  const cards = rows.map((r) => {
    try {
      return deriveCards(settings, fields, r.cells && typeof r.cells === "object" ? r.cells : {}, typeof r.content === "string" ? r.content : null);
    } catch {
      return [];
    }
  });
  const all = cards.flat();
  const types: Partial<Record<CardType, number>> = {};
  for (const c of all) types[c.kind] = (types[c.kind] ?? 0) + 1;
  // One per type first (in the order of the types; of pictures with masks
  // one that comes with the package), then the next records.
  const fileTypes = new Map(files.map((f) => [f.id.toLowerCase(), f.mime]));
  const pictured = (c: DerivedCard) => {
    const id = c.occlusion ? fileId(c.occlusion.src) : null;
    return !!id && IMAGE_MIMES.has(fileTypes.get(id) ?? "");
  };
  const picked: DerivedCard[] = [];
  for (const type of cardTypes) {
    const candidates = all.filter((c) => c.kind === type && c.sub !== "r");
    const first = candidates.find((c) => type !== "occlusion" || pictured(c)) ?? candidates[0];
    if (first && picked.length < STUDY_META_LIMITS.samples) picked.push(first);
  }
  for (const c of all) {
    if (picked.length >= STUDY_META_LIMITS.samples) break;
    if (!picked.includes(c) && c.sub !== "r" && !picked.some((p) => p.occlusion && c.occlusion && p.occlusion.src === c.occlusion.src)) picked.push(c);
  }
  picked.sort((a, b) => all.indexOf(a) - all.indexOf(b));
  const backs = all.filter((c) => c.kind === "basic" || c.kind === "choice" || c.kind === "typed").map((c) => clip(sidePlain(c.back), STUDY_META_LIMITS.choice));
  return {
    format: STUDY_META_FORMAT,
    version: STUDY_META_VERSION,
    records: rows.length,
    cards: all.length,
    reverse: settings.reverse,
    types,
    samples: picked.map((c) => sample(c, [...new Set(backs)].slice(0, 20), fileTypes)),
  };
}

// As the package entry: samples left out from the end while it is too large.
export function studyMetaBytes(meta: StudyMeta): Buffer {
  let m = meta;
  let bytes = Buffer.from(JSON.stringify(m, null, 2));
  while (bytes.length > STUDY_META_LIMITS.bytes && m.samples.length) {
    m = { ...m, samples: m.samples.slice(0, -1) };
    bytes = Buffer.from(JSON.stringify(m, null, 2));
  }
  return bytes;
}

// From a flowplan-template-1 manifest (template.json of payload/template.zip).
export function templateStudyMeta(manifest: { kind?: unknown; payload?: unknown; files?: unknown }): StudyMeta | null {
  if (manifest.kind !== "database" || typeof manifest.payload !== "string") return null;
  let content: DeckContent;
  try {
    content = JSON.parse(manifest.payload) as DeckContent;
  } catch {
    return null;
  }
  if (!content || typeof content !== "object") return null;
  const files = Array.isArray(manifest.files)
    ? (manifest.files as { id?: unknown; mime?: unknown }[]).flatMap((f) => (typeof f?.id === "string" && typeof f.mime === "string" ? [{ id: f.id, mime: f.mime }] : []))
    : [];
  return studyMeta(content, files);
}
