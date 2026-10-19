// Citations: references as CSL-JSON items (the format Zotero, Crossref and
// Pandoc share), read from BibTeX or CSL-JSON, cited inline as
// "(Müller 2021)" and listed in an APA-like bibliography. Client-safe; no
// CSL engine – a small, predictable style.
export type CslName = { family?: string; given?: string; literal?: string };
export type CslItem = {
  id: string;
  type?: string;
  title?: string;
  author?: CslName[];
  editor?: CslName[];
  issued?: { "date-parts"?: number[][]; literal?: string };
  "container-title"?: string;
  "collection-title"?: string;
  publisher?: string;
  "publisher-place"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  edition?: string;
  genre?: string;
  DOI?: string;
  URL?: string;
  ISBN?: string;
};
export type Say = (de: string, en: string) => string;
const german: Say = (de) => de;
export const CITATION_LIMITS = { text: 5_000_000, items: 5000, field: 2000, names: 100 };

/* ---------- cleaning ---------- */

const clean = (value: unknown, max = CITATION_LIMITS.field) =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
        .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
// Citation keys as Pandoc reads them after "@".
export function citationKey(value: unknown) {
  return clean(value, 200)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_:.#$%&+?<>~/-]/g, "")
    .replace(/^[^A-Za-z0-9_]+/, "")
    .slice(0, 100);
}
export function normalizeDoi(input: unknown): string | null {
  const text = clean(input, 400)
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  const match = /^(10\.\d{4,9}\/[^\s"<>]+)$/.exec(text);
  return match && match[1].length <= 200 ? match[1].replace(/[.,;]+$/, "") : null;
}
const names = (value: unknown): CslName[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .slice(0, CITATION_LIMITS.names)
    .map((n) => {
      if (!n || typeof n !== "object") return null;
      const o = n as Record<string, unknown>;
      const name: CslName = {};
      if (clean(o.family, 200)) name.family = clean(o.family, 200);
      if (clean(o.given, 200)) name.given = clean(o.given, 200);
      if (clean(o.literal ?? o.name, 200) && !name.family) name.literal = clean(o.literal ?? o.name, 200);
      return name.family || name.literal ? name : null;
    })
    .filter((n): n is CslName => !!n);
  return list.length ? list : undefined;
};
// A CSL-JSON item with only known fields, plain text, bounded; null when it
// has neither a title nor authors.
export function sanitizeItem(raw: unknown, fallbackKey = ""): CslItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = citationKey(o["citation-key"] ?? o.id ?? fallbackKey);
  const item: CslItem = { id };
  for (const field of ["type", "title", "container-title", "collection-title", "publisher", "publisher-place", "volume", "issue", "page", "edition", "genre", "ISBN"] as const) {
    const value = clean(Array.isArray(o[field]) ? (o[field] as unknown[])[0] : o[field]);
    if (value) item[field] = value;
  }
  const doi = normalizeDoi(o.DOI ?? o.doi);
  if (doi) item.DOI = doi;
  const url = clean(o.URL ?? o.url, 2000);
  if (/^https?:\/\/[^\s"<>]+$/i.test(url)) item.URL = url;
  const author = names(o.author),
    editor = names(o.editor);
  if (author) item.author = author;
  if (editor) item.editor = editor;
  const issued = (o.issued ?? o.date) as { "date-parts"?: unknown; literal?: unknown; raw?: unknown } | undefined;
  if (issued && typeof issued === "object") {
    const parts = Array.isArray(issued["date-parts"]) ? (issued["date-parts"] as unknown[])[0] : undefined;
    const numbers = Array.isArray(parts) ? parts.slice(0, 3).map(Number).filter((n) => Number.isInteger(n) && Math.abs(n) < 10000) : [];
    if (numbers.length) item.issued = { "date-parts": [numbers] };
    else if (clean(issued.literal ?? issued.raw, 100)) item.issued = { literal: clean(issued.literal ?? issued.raw, 100) };
  }
  if (!item.title && !item.author && !item.editor) return null;
  if (!item.id) item.id = suggestKey(item);
  return item;
}

/* ---------- keys ---------- */

const ascii = (text: string) =>
  text
    .replace(/ä/gi, (c) => (c === "ä" ? "ae" : "Ae"))
    .replace(/ö/gi, (c) => (c === "ö" ? "oe" : "Oe"))
    .replace(/ü/gi, (c) => (c === "ü" ? "ue" : "Ue"))
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
const STOP = new Set(["a", "an", "the", "der", "die", "das", "ein", "eine", "on", "of", "zur", "zum", "and", "und"]);
// "mueller2021deep", like Zotero/Better BibTeX keys.
export function suggestKey(item: Omit<CslItem, "id"> & { id?: string }) {
  const first = (item.author || item.editor || [])[0];
  const who = ascii(first?.family || first?.literal?.split(" ")[0] || "").toLowerCase();
  const year = String(item.issued?.["date-parts"]?.[0]?.[0] ?? "");
  const word = ascii(
    (item.title || "")
      .split(/\s+/)
      .find((w) => w.length > 2 && !STOP.has(w.toLowerCase())) || "",
  ).toLowerCase();
  return (who + year + word).slice(0, 60) || "ref";
}
export function uniqueKey(key: string, taken: (key: string) => boolean) {
  if (!taken(key)) return key;
  for (let i = 0; i < 26 * 26; i++) {
    const suffix = i < 26 ? String.fromCharCode(97 + i) : String(i);
    if (!taken(key + suffix)) return key + suffix;
  }
  return `${key}-${Date.now().toString(36)}`;
}

/* ---------- BibTeX ---------- */

const COMBINING: Record<string, string> = {
  '"': "̈",
  "'": "́",
  "`": "̀",
  "^": "̂",
  "~": "̃",
  "=": "̄",
  ".": "̇",
  c: "̧",
  v: "̌",
  u: "̆",
  H: "̋",
  k: "̨",
  r: "̊",
};
const SYMBOLS: Record<string, string> = {
  ss: "ß",
  o: "ø",
  O: "Ø",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  aa: "å",
  AA: "Å",
  l: "ł",
  L: "Ł",
  i: "ı",
  textendash: "–",
  textemdash: "—",
  textquoteright: "’",
  textquoteleft: "‘",
  euro: "€",
  S: "§",
  TeX: "TeX",
  LaTeX: "LaTeX",
};
// LaTeX in BibTeX values as plain Unicode text.
export function latexText(value: string) {
  let text = value
    .replace(/\\([cvuHkr])\s*\{\s*(\\?[A-Za-z])\s*\}/g, (_, mark, ch) => ch.replace("\\", "") + COMBINING[mark])
    .replace(/\\([cvuHkr])\s+([A-Za-z])/g, (_, mark, ch) => ch + COMBINING[mark])
    .replace(/\{?\\(["'`^~=.])\s*\{?\s*\\?([A-Za-z])\s*\}?\}?/g, (_, mark, ch) => (ch === "i" ? "i" : ch) + COMBINING[mark])
    .replace(/\\(ss|o|O|ae|AE|oe|OE|aa|AA|l|L|i|textendash|textemdash|textquoteright|textquoteleft|euro|S|TeX|LaTeX)(?![A-Za-z])\s*(\{\})?/g, (_, name) => SYMBOLS[name])
    .replace(/\\([&%$#_{}])/g, "$1")
    .replace(/\\(?:emph|textit|textbf|textsc|textrm|textsf|texttt|mkbibquote|enquote|url|mathrm)\s*\{/g, "{")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/(?<!\\)~/g, " ")
    .replace(/\\[A-Za-z]+\s*/g, "")
    .replace(/[{}]/g, "");
  text = text.normalize("NFC");
  return clean(text);
}
const BIB_TYPES: Record<string, string> = {
  article: "article-journal",
  book: "book",
  booklet: "book",
  inbook: "chapter",
  incollection: "chapter",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  proceedings: "book",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  thesis: "thesis",
  techreport: "report",
  report: "report",
  manual: "report",
  online: "webpage",
  electronic: "webpage",
  www: "webpage",
  misc: "document",
  unpublished: "manuscript",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// Splits at a word outside braces ("and" between names).
function splitTop(value: string, separator: RegExp) {
  const parts: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      separator.lastIndex = i;
      const m = separator.exec(value);
      if (m && m.index === i) {
        parts.push(value.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(value.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}
export function bibtexNames(value: string): CslName[] {
  return splitTop(value, /\s+and\s+/iy)
    .filter((n) => n.toLowerCase() !== "others")
    .slice(0, CITATION_LIMITS.names)
    .map((raw): CslName => {
      if (/^\{[^]*\}$/.test(raw) && splitTop(raw.slice(1, -1), /,/y).length === 1 && !/[{}]/.test(raw.slice(1, -1)))
        return { literal: latexText(raw) };
      const parts = splitTop(raw, /,/y);
      if (parts.length >= 2) {
        const given = latexText(parts[parts.length - 1]);
        return { family: latexText(parts[0]), ...(given ? { given } : {}) };
      }
      const words = splitTop(raw, /\s+/y);
      if (words.length === 1) return { family: latexText(words[0]) };
      // "Ludwig van Beethoven": lower-case particles belong to the family name.
      let split = words.length - 1;
      while (split > 1 && /^[a-z]/.test(words[split - 1])) split--;
      return { family: latexText(words.slice(split).join(" ")), given: latexText(words.slice(0, split).join(" ")) };
    })
    .filter((n) => n.family || n.literal);
}
type BibEntry = { type: string; key: string; fields: Record<string, string> };
// A tolerant BibTeX reader (BibLaTeX fields too): @string macros, "#"
// concatenation, braces and quotes; @comment and @preamble are skipped.
export function readBibtex(source: string): BibEntry[] {
  if (source.length > CITATION_LIMITS.text) throw new Error("Die Datei ist zu groß.");
  const entries: BibEntry[] = [];
  const macros: Record<string, string> = Object.fromEntries(MONTHS.map((m, i) => [m, String(i + 1)]));
  let i = 0;
  const space = () => {
    while (i < source.length && /\s/.test(source[i])) i++;
  };
  // A braced value without its outer braces (inner ones are kept for name
  // parsing and protected words).
  const braced = () => {
    let depth = 0,
      out = "";
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "\\" && i + 1 < source.length) {
        out += c + source[++i];
        continue;
      }
      if (c === "{" && ++depth === 1) continue;
      if (c === "}" && --depth === 0) {
        i++;
        return out;
      }
      out += c;
    }
    throw new Error("Unvollständiger Eintrag.");
  };
  const value = () => {
    let out = "";
    for (;;) {
      space();
      const c = source[i];
      if (c === "{") out += braced();
      else if (c === '"') {
        i++;
        let depth = 0,
          text = "";
        for (; i < source.length; i++) {
          const d = source[i];
          if (d === "{") depth++;
          if (d === "}") depth--;
          if (d === '"' && depth === 0 && source[i - 1] !== "\\") break;
          text += d;
        }
        i++;
        out += text;
      } else {
        const m = /^[A-Za-z0-9_:.\-+/]+/.exec(source.slice(i, i + 200));
        if (!m) break;
        i += m[0].length;
        out += /^\d+$/.test(m[0]) ? m[0] : (macros[m[0].toLowerCase()] ?? m[0]);
      }
      space();
      if (source[i] === "#") {
        i++;
        continue;
      }
      break;
    }
    return out;
  };
  while (i < source.length && entries.length < CITATION_LIMITS.items) {
    const at = source.indexOf("@", i);
    if (at < 0) break;
    i = at + 1;
    const type = /^[A-Za-z]+/.exec(source.slice(i, i + 40))?.[0]?.toLowerCase();
    if (!type) continue;
    i += type.length;
    space();
    const open = source[i];
    if (open !== "{" && open !== "(") continue;
    const close = open === "{" ? "}" : ")";
    i++;
    try {
      if (type === "comment" || type === "preamble") {
        let depth = 1;
        for (; i < source.length && depth; i++) {
          if (source[i] === open) depth++;
          else if (source[i] === close) depth--;
        }
        continue;
      }
      if (type === "string") {
        space();
        const name = /^[A-Za-z0-9_:.\-+]+/.exec(source.slice(i, i + 200))?.[0];
        if (!name) continue;
        i += name.length;
        space();
        if (source[i] !== "=") continue;
        i++;
        macros[name.toLowerCase()] = value();
        continue;
      }
      space();
      const keyEnd = source.slice(i, i + 300).search(/[,\s}\)]/);
      const key = keyEnd < 0 ? "" : source.slice(i, i + keyEnd);
      i += Math.max(0, keyEnd);
      const fields: Record<string, string> = {};
      for (let guard = 0; guard < 200; guard++) {
        space();
        if (source[i] === ",") i++;
        space();
        if (source[i] === close || i >= source.length) {
          i++;
          break;
        }
        const name = /^[A-Za-z][A-Za-z0-9_\-+]*/.exec(source.slice(i, i + 100))?.[0];
        if (!name) {
          // Something unreadable: skip to the end of the entry.
          const end = source.indexOf("\n@", i);
          i = end < 0 ? source.length : end + 1;
          break;
        }
        i += name.length;
        space();
        if (source[i] !== "=") continue;
        i++;
        fields[name.toLowerCase()] = value().slice(0, 20000);
      }
      entries.push({ type, key, fields });
    } catch {
      break;
    }
  }
  return entries;
}
function bibDate(fields: Record<string, string>): CslItem["issued"] {
  const date = fields.date && /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(fields.date);
  if (date) return { "date-parts": [[Number(date[1]), ...(date[2] ? [Number(date[2])] : []), ...(date[3] ? [Number(date[3])] : [])]] };
  const year = /\d{4}/.exec(fields.year || "")?.[0];
  if (!year) return fields.year ? { literal: latexText(fields.year) } : undefined;
  const month = Number(fields.month) || MONTHS.indexOf((fields.month || "").slice(0, 3).toLowerCase()) + 1;
  return { "date-parts": [[Number(year), ...(month >= 1 && month <= 12 ? [month] : [])]] };
}
export function parseBibtex(source: string): CslItem[] {
  return readBibtex(source)
    .map((entry) => {
      const f = entry.fields,
        type = BIB_TYPES[entry.type] || "document";
      const container = f.journaltitle || f.journal || f.booktitle;
      const raw: Record<string, unknown> = {
        id: entry.key,
        type,
        title: f.title && latexText(f.title),
        "container-title": container && latexText(container),
        "collection-title": f.series && latexText(f.series),
        publisher: latexText(f.publisher || f.school || f.institution || f.organization || ""),
        "publisher-place": latexText(f.address || f.location || ""),
        volume: f.volume && latexText(f.volume),
        issue: latexText(f.number || f.issue || ""),
        page: f.pages && latexText(f.pages).replace(/\s*[-–]+\s*/g, "–"),
        edition: f.edition && latexText(f.edition),
        genre: entry.type === "phdthesis" ? "Dissertation" : entry.type === "mastersthesis" ? "Masterarbeit" : undefined,
        DOI: f.doi,
        URL: f.url,
        ISBN: f.isbn && latexText(f.isbn),
        author: f.author ? bibtexNames(f.author) : undefined,
        editor: f.editor ? bibtexNames(f.editor) : undefined,
        issued: bibDate(f),
      };
      return sanitizeItem(raw);
    })
    .filter((item): item is CslItem => !!item);
}
export function parseCslJson(source: string): CslItem[] {
  if (source.length > CITATION_LIMITS.text) throw new Error("Die Datei ist zu groß.");
  const data = JSON.parse(source);
  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [data];
  return list
    .slice(0, CITATION_LIMITS.items)
    .map((raw: unknown) => sanitizeItem(raw))
    .filter((item: CslItem | null): item is CslItem => !!item);
}
// BibTeX/BibLaTeX or CSL-JSON (Zotero's "Better BibTeX", "CSL JSON").
export function parseReferences(source: string): CslItem[] {
  const text = source.replace(/^﻿/, "").trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return parseCslJson(text);
    } catch {
      if (text.startsWith("[")) throw new Error("Das CSL-JSON ist ungültig.");
    }
  }
  return parseBibtex(text);
}

/* ---------- formatting ---------- */

export function itemYear(item: CslItem, say: Say = german) {
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  return year !== undefined ? String(year) : item.issued?.literal || say("o. J.", "n.d.");
}
const family = (n: CslName) => n.family || n.literal || "";
// "(Müller 2021)", "(Müller & Schmidt 2021, S. 12)", "(Müller et al. 2021)".
export function inlineCitation(item: CslItem | null, locator = "", say: Say = german) {
  if (!item) return say("(Quelle fehlt)", "(missing source)");
  const people = item.author || item.editor || [];
  const who = !people.length
    ? (item.title || item.id).split(/\s+/).slice(0, 4).join(" ")
    : people.length === 1
      ? family(people[0])
      : people.length === 2
        ? `${family(people[0])} & ${family(people[1])}`
        : `${family(people[0])} et al.`;
  const where = clean(locator, 100);
  return `(${who} ${itemYear(item, say)}${where ? `, ${/^\d/.test(where) ? say("S. ", "p. ") : ""}${where}` : ""})`;
}
const initials = (given = "") =>
  given
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.split("-").map((p) => (p[0] ? `${p[0].toUpperCase()}.` : "")).join("-"))
    .join(" ");
const fullName = (n: CslName) => (n.literal ? n.literal : [n.family, initials(n.given)].filter(Boolean).join(", "));
function nameList(list: CslName[]) {
  const names = list.map(fullName);
  if (names.length === 1) return names[0];
  if (names.length > 20) return `${names.slice(0, 19).join(", ")}, … ${names[names.length - 1]}`;
  return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
}
export type Segment = { text: string; italic?: boolean };
const end = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
// APA-like reference as text segments (italic parts marked).
export function formatReference(item: CslItem, say: Say = german): Segment[] {
  const out: Segment[] = [];
  const add = (text: string, italic = false) => text && out.push({ text, italic });
  const people = item.author || item.editor;
  const eds = !item.author && item.editor ? say(" (Hrsg.)", item.editor.length > 1 ? " (Eds.)" : " (Ed.)") : "";
  if (people) add(`${nameList(people)}${eds} `);
  add(`(${itemYear(item, say)}). `);
  const type = item.type || "document";
  const container = item["container-title"];
  const pages = item.page ? item.page.replace(/-/g, "–") : "";
  const link = item.DOI ? `https://doi.org/${item.DOI}` : item.URL || "";
  if (type === "article-journal" || type === "article-magazine" || type === "article-newspaper") {
    if (item.title) add(`${end(item.title)} `);
    if (container) {
      add(container, true);
      if (item.volume) {
        add(", ");
        add(item.volume, true);
      }
      if (item.issue) add(`(${item.issue})`);
      if (pages) add(`, ${pages}`);
      add(". ");
    }
  } else if ((type === "chapter" || type === "paper-conference") && container) {
    if (item.title) add(`${end(item.title)} `);
    add(say("In ", "In "));
    if (item.editor && item.author)
      add(
        `${item.editor.map((n) => n.literal || [initials(n.given), n.family].filter(Boolean).join(" ")).join(", ")} ${say("(Hrsg.)", item.editor.length > 1 ? "(Eds.)" : "(Ed.)")}, `,
      );
    add(container, true);
    if (pages) add(` (${say("S.", "pp.")} ${pages})`);
    add(". ");
    if (item.publisher) add(`${end(item.publisher)} `);
  } else {
    if (item.title) add(item.title, true);
    const details = [item.edition && `${item.edition}. ${say("Aufl.", "ed.")}`, item.genre].filter(Boolean).join(", ");
    if (details) add(` (${details})`);
    add(/[.!?]$/.test(details ? ")" : item.title || "") ? " " : ". ");
    const source = [container, item.publisher].filter(Boolean).join(", ");
    if (source) add(`${end(source)} `);
  }
  if (link) add(link);
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  return out;
}
export const referenceText = (item: CslItem, say: Say = german) =>
  formatReference(item, say)
    .map((s) => s.text)
    .join("");
// Bibliography order: first author (or title), then year.
export function sortReferences(items: CslItem[]) {
  const sortKey = (item: CslItem) =>
    `${(item.author || item.editor)?.map(family).join(" ") || item.title || item.id}`.toLocaleLowerCase("de");
  return [...items].sort(
    (a, b) => sortKey(a).localeCompare(sortKey(b), "de") || itemYear(a).localeCompare(itemYear(b)) || (a.title || "").localeCompare(b.title || ""),
  );
}
// The item stored in a citation's attribute, or null.
export function parseItemAttribute(value: unknown): CslItem | null {
  if (typeof value !== "string" || !value || value.length > 50000) return null;
  try {
    return sanitizeItem(JSON.parse(value));
  } catch {
    return null;
  }
}
// Distinct cited works, in bibliography order.
export function citedWorks(citations: { key: string; item: string }[]) {
  const byKey = new Map<string, CslItem>();
  for (const c of citations) {
    const item = parseItemAttribute(c.item);
    if (item && !byKey.has(c.key || item.id)) byKey.set(c.key || item.id, { ...item, id: c.key || item.id });
  }
  return sortReferences([...byKey.values()]);
}
// "[@mueller2021]" or "[@mueller2021, p. 12]" (Pandoc).
export function pandocCitation(key: string, locator = "") {
  const safe = /^[A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*$/.test(key) && !/[:.#$%&+?<>~/-]$/.test(key) ? `@${key}` : `@{${key.replace(/[{}]/g, "")}}`;
  const where = clean(locator, 100).replace(/[\[\]]/g, "");
  return `[${safe}${where ? `, ${/^\d/.test(where) ? "p. " : ""}${where}` : ""}]`;
}
