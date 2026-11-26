// The Office preview (#562): the content of an uploaded presentation
// (.pptx, .odp) or text document (.docx, .odt) as JSON for the read-only
// viewer (components/office-viewer-dialog.tsx) – slides with their title,
// paragraphs with list levels, tables, pictures and speaker notes, or a
// document's headings, paragraphs, lists, tables and pictures. Never the
// layout, never anything executed or converted: the parts are unpacked
// with the spreadsheet preview's capped reader (lib/sheet-xlsx.ts
// zipParts: a cap on the bytes actually read per part and one budget for
// all) and their XML is walked once by a linear tokenizer (#470). The old
// binary formats (.ppt, .doc) are refused (415): the viewer offers their
// download. Who may see it is decided by the caller with the download's
// own checks (lib/file-access.ts readableFile, lib/publication.ts
// publicFile).
//
// Pictures (GET …/office/image?name=<part>): only a part that one of the
// slides or the document shows, read up to OFFICE_IMAGE_BYTES, with the
// type sniffed from its bytes (PNG, JPEG, GIF, WebP – no SVG, no EMF/WMF)
// and served as that type with nosniff and a sandbox.
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { HttpError } from "./auth";
import { sniffImage } from "./avatars";
import { ct } from "./content-locale";
import { decode } from "./office-text";
import { OFFICE_LIMITS, OFFICE_PREVIEW_LIMIT, officeKindOf, type OfficeBlock, type OfficePreview, type OfficeSlide } from "./office-files";
import { attributes, isType, relationships, relsOf, zipParts, type Part } from "./sheet-xlsx";
import { localUpload, uploadPath } from "./storage";

// The largest file the preview reads: FLOWPLAN_OFFICE_PREVIEW_MB, default
// 20 MB, at most 100 MB – the whole file is read into memory.
export const OFFICE_PREVIEW_MAX_MB = 100;
export function officePreviewLimit(raw = process.env.FLOWPLAN_OFFICE_PREVIEW_MB) {
  const mb = Number(raw);
  if (!raw || !Number.isFinite(mb) || mb <= 0) return OFFICE_PREVIEW_LIMIT;
  return Math.round(Math.min(mb, OFFICE_PREVIEW_MAX_MB) * 1024 * 1024);
}
// Unpacked bytes: each XML part, the main part (cut there instead of
// refused), all parts together, one picture.
export const OFFICE_PART_BYTES = 32 * 1024 * 1024;
export const OFFICE_MAIN_BYTES = 64 * 1024 * 1024;
export const OFFICE_TOTAL_BYTES = 160 * 1024 * 1024;
export const OFFICE_IMAGE_BYTES = 20 * 1024 * 1024;

const tooLarge = () =>
  new HttpError(413, ct("Die Datei ist entpackt zu groß für die Vorschau. Du kannst sie herunterladen.", "Unpacked, the file is too large for the preview. You can download it."));
const unreadable = () => new HttpError(422, ct("Die Datei konnte nicht gelesen werden.", "The file could not be read."));
const errors = { tooLarge, unreadable };
const notPreviewable = (name: string) => {
  const kind = officeKindOf(name);
  return new HttpError(
    415,
    kind === "ppt"
      ? ct("PowerPoint-97–2003-Dateien (.ppt) zeigt die Vorschau nicht – du kannst sie herunterladen.", "The preview does not show PowerPoint 97–2003 files (.ppt) – you can download them.")
      : kind === "doc"
        ? ct("Word-97–2003-Dateien (.doc) zeigt die Vorschau nicht – du kannst sie herunterladen.", "The preview does not show Word 97–2003 files (.doc) – you can download them.")
        : ct("Keine Präsentation und kein Textdokument.", "Not a presentation or text document."),
  );
};

/* ---------- XML, walked once ---------- */

// One pass over the tags and texts. Attributes end at "<" as well as ">"
// and nothing scans back, so the walk is linear in the (capped) part, also
// on crafted XML (#470). Comments, processing instructions and doctypes
// are passed over; a stray "<" is text that is dropped.
const TOKEN = /<\/([^\s<>/]+)\s*>|<([^\s<>/!?]+)([^<>]*?)(\/?)>|<[!?][^<>]*>|([^<]+)/g;
// Element names without their namespace prefix.
const local = (name: string) => name.slice(name.indexOf(":") + 1);
type Attrs = Record<string, string>;
// An attribute by its name without prefix ("r:embed" → "embed"), or with a
// prefix only ("r:id", not "id").
function attr(attrs: Attrs, name: string, prefixed = false) {
  for (const [key, value] of Object.entries(attrs)) {
    const colon = key.indexOf(":");
    if (key.slice(colon + 1) === name && (!prefixed || colon > 0)) return value;
  }
  return undefined;
}
type Visitor = {
  // `false`: the element and everything in it are passed over.
  open(name: string, attrs: Attrs, empty: boolean, parent: string): boolean | void;
  close?(name: string): void;
  text?(text: string, parent: string): void;
};
const MAX_DEPTH = 512;
function walk(xml: string, visitor: Visitor) {
  const stack: string[] = [];
  let skip = 0;
  for (const m of xml.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      const name = local(m[1]);
      // Closes the innermost open element of that name and any left open
      // inside it; a closing tag without an open one is passed over.
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) {
        const closed = stack.pop()!;
        if (skip) {
          if (stack.length < skip) skip = 0;
          continue;
        }
        visitor.close?.(closed);
      }
    } else if (m[2] !== undefined) {
      const name = local(m[2]);
      const empty = m[4] === "/";
      if (!skip) {
        const parent = stack[stack.length - 1] ?? "";
        const go = visitor.open(name, attributes(m[3]), empty, parent);
        if (go === false && !empty) skip = stack.length + 1;
        else if (empty && go !== false) visitor.close?.(name);
      }
      if (!empty) {
        stack.push(name);
        if (stack.length > MAX_DEPTH) throw unreadable();
      }
    } else if (m[5] !== undefined && !skip && visitor.text) visitor.text(decode(m[5]), stack[stack.length - 1] ?? "");
  }
}

/* ---------- What one answer may hold ---------- */

class Collector {
  chars = 0;
  blocks = 0;
  images = 0;
  truncated = false;
  constructor(readonly limits = OFFICE_LIMITS) {}
  // Text up to what is left of the characters.
  text(raw: string) {
    const text = tidy(raw);
    const room = this.limits.chars - this.chars;
    if (text.length > room) {
      this.truncated = true;
      this.chars = this.limits.chars;
      return text.slice(0, Math.max(0, room));
    }
    this.chars += text.length;
    return text;
  }
  add(to: OfficeBlock[], block: OfficeBlock) {
    if (this.blocks >= this.limits.blocks || (block.type === "image" && this.images >= this.limits.images)) {
      this.truncated = true;
      return;
    }
    if (block.type === "image") this.images++;
    this.blocks++;
    to.push(block);
  }
  get full() {
    return this.blocks >= this.limits.blocks || this.chars >= this.limits.chars;
  }
}
// Runs of spaces and tabs as one space, each line trimmed, no blank lines
// at the ends or more than one in a row.
const tidy = (text: string) =>
  text
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
// Pictures the browser shows safely: by the part's name here, by the bytes
// when served.
const SHOWN = /\.(png|jpe?g|gif|webp)$/i;
type Table = { rows: string[][]; row: string[] | null; cell: string | null };
function tableRow(table: Table, out: Collector) {
  if (!table.row) return;
  if (table.rows.length >= out.limits.rows) out.truncated = true;
  else table.rows.push(table.row);
  table.row = null;
}
function tableCell(table: Table, out: Collector) {
  if (table.cell === null || !table.row) return;
  if (table.row.length >= out.limits.columns) out.truncated = true;
  else table.row.push(out.text(table.cell));
  table.cell = null;
}
function tableBlock(table: Table): OfficeBlock | null {
  // Trailing empty cells and rows away; nothing at all is no table.
  const rows = table.rows.map((row) => {
    let end = row.length;
    while (end && !row[end - 1]) end--;
    return row.slice(0, end);
  });
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows.some((row) => row.length) ? { type: "table", rows } : null;
}

/* ---------- PowerPoint (.pptx) ---------- */

// Placeholders whose text is layout, not content.
const PPT_LAYOUT = new Set(["dt", "ftr", "hdr", "sldNum", "sldImg"]);
// Subtrees passed over: the background, extensions, the older copy of
// newer content, animation and transitions.
const PPT_SKIP = new Set(["bg", "extLst", "Fallback", "timing", "transition"]);
type PptPara = { text: string; level: number; list?: "bullet" | "number" | "none" };

// One slide (or, with `notes`, its notes page).
export function pptxSlide(xml: string, images: (rId: string) => string | null, out: Collector, notes = false) {
  const slide: OfficeSlide = { title: "", blocks: [], notes: [] };
  let shape: { ph: string | null; paras: PptPara[] } | null = null;
  let para: PptPara | null = null;
  let table: Table | null = null;
  let tables = 0;
  const shown = new Set<string>();
  walk(xml, {
    open(name, attrs) {
      if (PPT_SKIP.has(name)) return false;
      if (name === "sp") shape = { ph: null, paras: [] };
      else if (name === "ph" && shape) shape.ph = attrs.type || "body";
      else if (name === "p") para = { text: "", level: 0 };
      else if (name === "pPr" && para) para.level = Math.min(8, Math.max(0, Number(attrs.lvl) || 0));
      else if (para && (name === "buNone" || name === "buChar" || name === "buAutoNum" || name === "buBlip"))
        para.list = name === "buNone" ? "none" : name === "buAutoNum" ? "number" : "bullet";
      else if (name === "br" && para) para.text += "\n";
      else if (name === "tbl" && !notes) {
        if (!tables++) table = { rows: [], row: null, cell: null };
      } else if (name === "tr" && table && tables === 1) table.row = [];
      else if (name === "tc" && table && tables === 1) table.cell = "";
      else if (name === "blip" && !notes) {
        const target = images(attr(attrs, "embed") ?? "");
        if (target && !shown.has(target)) {
          shown.add(target);
          out.add(slide.blocks, { type: "image", image: target });
        }
      }
    },
    text(text, parent) {
      if (parent === "t" && para) para.text += text;
    },
    close(name) {
      if (name === "p" && para) {
        const done = para;
        para = null;
        if (table?.cell != null) table.cell += (table.cell ? "\n" : "") + done.text;
        else if (shape) shape.paras.push(done);
      } else if (name === "tc" && table && tables === 1) tableCell(table, out);
      else if (name === "tr" && table && tables === 1) tableRow(table, out);
      else if (name === "tbl" && !notes && !--tables && table) {
        const block = tableBlock(table);
        table = null;
        if (block) out.add(slide.blocks, block);
      } else if (name === "sp" && shape) {
        const { ph, paras } = shape;
        shape = null;
        if (ph && PPT_LAYOUT.has(ph)) return;
        if (notes) {
          if (ph === "body") for (const p of paras) if (!out.full) {
            const text = out.text(p.text);
            if (text) slide.notes.push(text);
          }
          return;
        }
        if ((ph === "title" || ph === "ctrTitle") && !slide.title) {
          slide.title = out.text(paras.map((p) => p.text).join(" "));
          return;
        }
        // Body and content placeholders are bulleted unless a paragraph
        // says otherwise; text boxes and subtitles only where one says so.
        const bulleted = ph === "body" || ph === "obj";
        for (const p of paras) {
          if (out.full) break;
          const text = out.text(p.text);
          if (!text) continue;
          const list = p.list === "none" ? undefined : (p.list ?? (bulleted ? "bullet" : undefined));
          out.add(slide.blocks, list ? { type: "paragraph", text, level: p.level, list } : { type: "paragraph", text, level: p.level });
        }
      }
    },
  });
  return slide;
}

async function readPptx(bytes: Buffer, out: Collector) {
  const budget = { left: OFFICE_TOTAL_BYTES };
  const parts = await zipParts(
    bytes,
    (name) => (/\.rels$/i.test(name) || /(?:^|\/)presentation\.xml$/i.test(name) || /\/(?:slides|notesSlides)\/[^/]+\.xml$/i.test(name) ? { max: OFFICE_PART_BYTES } : null),
    budget,
    errors,
  );
  const text = (name: string) => parts.get(name)?.data.toString("utf8");
  const main = relationships(text("_rels/.rels"), "").find((r) => isType(r.type, "officeDocument"))?.target || "ppt/presentation.xml";
  const presentation = text(main);
  if (presentation === undefined) throw unreadable();
  const rels = relationships(text(relsOf(main)), main);
  // The order of the slides is presentation.xml's list, not their names.
  const ids: string[] = [];
  walk(presentation, {
    open(name, attrs) {
      if (name === "sldId") ids.push(attr(attrs, "id", true) ?? "");
    },
  });
  let targets = ids.map((id) => rels.find((r) => r.id === id && isType(r.type, "slide"))?.target).filter((t): t is string => !!t && parts.has(t));
  if (!targets.length)
    targets = rels
      .filter((r) => isType(r.type, "slide") && parts.has(r.target))
      .map((r) => r.target)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  // Hidden slides stay hidden, unless all are.
  const hidden = (t: string) => /<(?:[\w.-]+:)?sld\b[^<>]*\sshow\s*=\s*["'](?:0|false)["']/.test(text(t)!.slice(0, 4096));
  if (targets.some((t) => !hidden(t))) targets = targets.filter((t) => !hidden(t));
  if (targets.length > out.limits.slides) {
    out.truncated = true;
    targets = targets.slice(0, out.limits.slides);
  }
  const slides: OfficeSlide[] = [];
  for (const target of targets) {
    if (out.full) {
      out.truncated = true;
      break;
    }
    const slideRels = relationships(text(relsOf(target)), target);
    const image = (rId: string) => {
      const r = slideRels.find((r) => r.id === rId && isType(r.type, "image"));
      return r && SHOWN.test(r.target) ? r.target : null;
    };
    const slide = pptxSlide(text(target)!, image, out);
    const notes = slideRels.find((r) => isType(r.type, "notesSlide"))?.target;
    const notesXml = notes && text(notes);
    if (notesXml) slide.notes = pptxSlide(notesXml, () => null, out, true).notes;
    slides.push(slide);
  }
  return slides;
}

/* ---------- Word (.docx) ---------- */

type WordStyle = { name: string; basedOn?: string; outline?: number; numId?: string; ilvl?: number };
export function wordStyles(xml: string) {
  const styles = new Map<string, WordStyle>();
  let current: WordStyle | null = null;
  walk(xml, {
    open(name, attrs, _empty, parent) {
      if (name === "style") {
        current = { name: "" };
        if ((attr(attrs, "type") ?? "paragraph") === "paragraph") styles.set(attr(attrs, "styleId") ?? "", current);
      } else if (!current) return;
      else if (name === "name") current.name = attr(attrs, "val") ?? "";
      else if (name === "basedOn") current.basedOn = attr(attrs, "val");
      else if (name === "outlineLvl" && parent === "pPr") current.outline = Number(attr(attrs, "val"));
      else if (name === "numId") current.numId = attr(attrs, "val");
      else if (name === "ilvl") current.ilvl = Number(attr(attrs, "val")) || 0;
      else if (name === "rPr" && parent === "style") return false;
    },
    close(name) {
      if (name === "style") current = null;
    },
  });
  return styles;
}
// numId → for each level whether it counts ("number") or is bulleted.
export function wordNumbering(xml: string) {
  const abstract = new Map<string, Map<number, "bullet" | "number" | "none">>();
  const nums = new Map<string, string>();
  let levels: Map<number, "bullet" | "number" | "none"> | null = null;
  let level = 0;
  let num: string | null = null;
  walk(xml, {
    open(name, attrs) {
      if (name === "abstractNum") abstract.set(attr(attrs, "abstractNumId") ?? "", (levels = new Map()));
      else if (name === "lvl" && levels) level = Number(attr(attrs, "ilvl")) || 0;
      else if (name === "numFmt" && levels) {
        const fmt = attr(attrs, "val") ?? "";
        levels.set(level, fmt === "bullet" ? "bullet" : fmt === "none" ? "none" : "number");
      } else if (name === "num") num = attr(attrs, "numId") ?? "";
      else if (name === "abstractNumId" && num !== null) nums.set(num, attr(attrs, "val") ?? "");
      // Levels overridden per list keep the abstract list's format here.
      else if (name === "lvlOverride") return false;
    },
    close(name) {
      if (name === "abstractNum") levels = null;
      else if (name === "num") num = null;
    },
  });
  return (numId: string, ilvl: number) => abstract.get(nums.get(numId) ?? "")?.get(ilvl);
}
// Through the styles a paragraph is based on (at most a few steps).
function styleChain(styles: Map<string, WordStyle>, id: string | undefined) {
  const out: WordStyle[] = [];
  for (let i = 0; id && i < 12; i++) {
    const style = styles.get(id);
    if (!style || out.includes(style)) break;
    out.push(style);
    id = style.basedOn;
  }
  return out;
}
function headingLevel(chain: WordStyle[], outline: number | undefined) {
  const first = chain[0];
  if (first && /^title$/i.test(first.name.trim())) return 1;
  for (const style of chain) {
    const m = /^heading\s*(\d)$/i.exec(style.name.trim());
    if (m) return Math.min(6, Math.max(1, Number(m[1])));
  }
  const level = outline ?? chain.find((s) => s.outline !== undefined)?.outline;
  return level !== undefined && level >= 0 && level < 6 ? level + 1 : 0;
}
// Subtrees passed over: deleted and moved-away text, the older copy of
// newer content, changed formatting, field codes, section settings,
// comments' anchors.
const WORD_SKIP = new Set(["del", "moveFrom", "Fallback", "pPrChange", "rPrChange", "instrText", "delText", "sectPr", "extLst", "rPr"]);
type WordPara = { text: string; style?: string; numId?: string; ilvl: number; outline?: number; images: string[] };

export function docxBlocks(
  xml: string,
  ctx: { styles: Map<string, WordStyle>; list: (numId: string, ilvl: number) => "bullet" | "number" | "none" | undefined; image: (rId: string) => string | null },
  out: Collector,
) {
  const blocks: OfficeBlock[] = [];
  const paras: WordPara[] = [];
  let table: Table | null = null;
  let tables = 0;
  let tableImages: string[] = [];
  const shown = new Set<string>();
  const top = () => paras[paras.length - 1];
  const picture = (rId: string | undefined) => {
    const target = ctx.image(rId ?? "");
    if (!target || shown.has(target)) return;
    shown.add(target);
    (table ? tableImages : (top()?.images ?? tableImages)).push(target);
  };
  const flushImages = (images: string[]) => {
    for (const image of images) out.add(blocks, { type: "image", image });
  };
  const start = xml.search(/<(?:[\w.-]+:)?body\b/);
  walk(start < 0 ? xml : xml.slice(start), {
    open(name, attrs, _empty, parent) {
      if (WORD_SKIP.has(name)) return false;
      const p = top();
      if (name === "p") paras.push({ text: "", ilvl: 0, images: [] });
      else if (name === "pStyle" && p && parent === "pPr") p.style = attr(attrs, "val");
      else if (name === "numId" && p) p.numId = attr(attrs, "val");
      else if (name === "ilvl" && p) p.ilvl = Math.min(8, Math.max(0, Number(attr(attrs, "val")) || 0));
      else if (name === "outlineLvl" && p && parent === "pPr") p.outline = Number(attr(attrs, "val"));
      else if (p && (name === "tab" || name === "ptab") && parent === "r") p.text += "\t";
      else if (p && (name === "br" || name === "cr")) p.text += "\n";
      else if (p && name === "noBreakHyphen") p.text += "-";
      else if (name === "blip") picture(attr(attrs, "embed"));
      else if (name === "imagedata") picture(attr(attrs, "id", true));
      else if (name === "tbl") {
        if (!tables++) {
          table = { rows: [], row: null, cell: null };
          tableImages = [];
        }
      } else if (name === "tr" && table && tables === 1) table.row = [];
      else if (name === "tc" && table && tables === 1) table.cell = "";
    },
    text(text, parent) {
      if (parent === "t" && top()) top().text += text;
    },
    close(name) {
      if (name === "p") {
        const p = paras.pop();
        if (!p) return;
        if (table?.cell != null) {
          table.cell += (table.cell ? "\n" : "") + p.text;
          tableImages.push(...p.images);
          return;
        }
        if (out.full) {
          out.truncated = true;
          return;
        }
        const chain = styleChain(ctx.styles, p.style);
        const text = out.text(p.text);
        const heading = headingLevel(chain, p.outline);
        const numId = p.numId ?? chain.find((s) => s.numId)?.numId;
        const ilvl = p.numId !== undefined ? p.ilvl : (chain.find((s) => s.numId)?.ilvl ?? p.ilvl);
        const list = numId && numId !== "0" ? (ctx.list(numId, ilvl) ?? "bullet") : undefined;
        if (text) {
          if (heading) out.add(blocks, { type: "heading", level: heading, text });
          else if (list && list !== "none") out.add(blocks, { type: "paragraph", text, level: ilvl, list });
          else out.add(blocks, { type: "paragraph", text, level: 0 });
        }
        flushImages(p.images);
      } else if (name === "tc" && table && tables === 1) tableCell(table, out);
      else if (name === "tr" && table && tables === 1) tableRow(table, out);
      else if (name === "tbl" && !--tables && table) {
        const block = tableBlock(table);
        table = null;
        if (block) out.add(blocks, block);
        flushImages(tableImages);
        tableImages = [];
      }
    },
  });
  return blocks;
}

async function readDocx(bytes: Buffer, out: Collector) {
  const budget = { left: OFFICE_TOTAL_BYTES };
  const parts = await zipParts(
    bytes,
    (name) =>
      /\.rels$/i.test(name) || /(?:^|\/)(?:styles|numbering)\.xml$/i.test(name)
        ? { max: OFFICE_PART_BYTES }
        : /(?:^|\/)document\d*\.xml$/i.test(name)
          ? { max: OFFICE_MAIN_BYTES, cut: true }
          : null,
    budget,
    errors,
  );
  const text = (name: string) => parts.get(name)?.data.toString("utf8");
  const main = relationships(text("_rels/.rels"), "").find((r) => isType(r.type, "officeDocument"))?.target || "word/document.xml";
  const part = parts.get(main);
  if (!part) throw unreadable();
  if (part.cut) out.truncated = true;
  const rels = relationships(text(relsOf(main)), main);
  const target = (type: string, fallback: string) => rels.find((r) => isType(r.type, type))?.target ?? posix.join(posix.dirname(main), fallback);
  return docxBlocks(
    part.data.toString("utf8"),
    {
      styles: wordStyles(text(target("styles", "styles.xml")) ?? ""),
      list: wordNumbering(text(target("numbering", "numbering.xml")) ?? ""),
      image: (rId) => {
        const r = rels.find((r) => r.id === rId && isType(r.type, "image"));
        return r && SHOWN.test(r.target) ? r.target : null;
      },
    },
    out,
  );
}

/* ---------- OpenDocument (.odp, .odt) ---------- */

// List styles by name: per level whether they count or are bulleted.
type ListStyles = Map<string, Map<number, "bullet" | "number">>;
function odfListStyles(xml: string, styles: ListStyles = new Map()) {
  let current: Map<number, "bullet" | "number"> | null = null;
  walk(xml, {
    open(name, attrs) {
      if (name === "list-style") styles.set(attr(attrs, "name") ?? "", (current = new Map()));
      else if (current && /^list-level-style-(number|bullet|image)$/.test(name))
        current.set(Math.max(1, Number(attr(attrs, "level")) || 1), name.endsWith("number") && attr(attrs, "num-format") !== "" ? "number" : "bullet");
      else if (name === "body") return false;
    },
    close(name) {
      if (name === "list-style") current = null;
    },
  });
  return styles;
}
// Subtrees passed over: tracked changes (deleted text), comments,
// footnotes, alternative text, forms, the thumbnail on a notes page.
const ODF_SKIP = new Set(["tracked-changes", "annotation", "note", "title", "desc", "forms", "sequence-decls", "page-thumbnail", "scripts", "event-listeners"]);
// Frames whose text is layout (presentations).
const ODP_LAYOUT = new Set(["page-number", "footer", "date-time", "header", "page"]);
type OdfPara = { text: string; heading: number; level: number; list?: "bullet" | "number"; title: boolean; notes: boolean };

export function odfContent(xml: string, presentation: boolean, out: Collector, listStyles: ListStyles = new Map()) {
  const styles = odfListStyles(xml, listStyles);
  const slides: OfficeSlide[] = [];
  const blocks: OfficeBlock[] = [];
  let slide: OfficeSlide | null = null;
  const target = () => (presentation ? slide?.blocks : blocks);
  const paras: OdfPara[] = [];
  // Open lists: their style (inherited inward) and whether the next
  // paragraph starts an item (it gets the marker; later ones in the item
  // are its continuation).
  const lists: { style: string }[] = [];
  let item = false;
  const frames: { cls: string; images: string[] }[] = [];
  let notes = 0;
  let table: Table | null = null;
  let tables = 0;
  let tableImages: string[] = [];
  const inLayout = () => frames.some((f) => ODP_LAYOUT.has(f.cls));
  const inTitle = () => frames.some((f) => f.cls === "title");
  const start = xml.search(/<(?:[\w.-]+:)?body\b/);
  if (start < 0) throw unreadable();
  walk(xml.slice(start), {
    open(name, attrs) {
      if (ODF_SKIP.has(name)) return false;
      if (name === "page" && presentation && !notes) {
        if (slides.length >= out.limits.slides || out.full) {
          out.truncated = true;
          return false;
        }
        slide = { title: "", blocks: [], notes: [] };
        slides.push(slide);
      } else if (name === "notes") notes++;
      else if (name === "frame" || name === "custom-shape") frames.push({ cls: attr(attrs, "class") ?? "", images: [] });
      else if (name === "image") {
        const href = attr(attrs, "href") ?? "";
        const frame = frames[frames.length - 1];
        if (frame && href && !/^[a-z][\w+.-]*:|^\.\.\/|^\//i.test(href)) frame.images.push(posix.normalize(href.replace(/^\.\//, "")));
      } else if (name === "list") {
        const outer = lists[lists.length - 1]?.style ?? "";
        lists.push({ style: attr(attrs, "style-name") ?? outer });
      } else if (name === "list-item") item = true;
      else if (name === "list-header") item = false;
      else if (name === "p" || name === "h") {
        const level = Math.max(0, lists.length - 1);
        const marked = lists.length > 0 && item;
        item = false;
        let list: OdfPara["list"];
        if (marked) {
          const style = lists[lists.length - 1].style;
          list = styles.get(style)?.get(level + 1) ?? "bullet";
        }
        const heading =
          name === "h"
            ? Math.min(6, Math.max(1, Number(attr(attrs, "outline-level")) || 1))
            : /^Title$/.test(attr(attrs, "style-name") ?? "")
              ? 1
              : Number(/^Heading_20_([1-6])$/.exec(attr(attrs, "style-name") ?? "")?.[1] ?? 0);
        paras.push({ text: "", heading, level: lists.length ? level : 0, list, title: inTitle(), notes: notes > 0 });
      } else if (name === "s" && paras.length) paras[paras.length - 1].text += " ".repeat(Math.min(100, Math.max(1, Number(attr(attrs, "c")) || 1)));
      else if (name === "tab" && paras.length) paras[paras.length - 1].text += "\t";
      else if (name === "line-break" && paras.length) paras[paras.length - 1].text += "\n";
      else if (name === "table") {
        if (!tables++) {
          table = { rows: [], row: null, cell: null };
          tableImages = [];
        }
      } else if (name === "table-row" && table && tables === 1) table.row = [];
      else if ((name === "table-cell" || name === "covered-table-cell") && table && tables === 1) table.cell = "";
    },
    // White space in OpenDocument text is collapsed, line breaks included
    // (<text:s/>, <text:tab/> and <text:line-break/> are the kept ones).
    text(text) {
      if (paras.length) paras[paras.length - 1].text += text.replace(/[ \t\r\n]+/g, " ");
    },
    close(name) {
      if (name === "notes") notes--;
      else if (name === "list") lists.pop();
      else if (name === "list-item") item = false;
      else if (name === "p" || name === "h") {
        const p = paras.pop();
        if (!p) return;
        if (table?.cell != null) {
          table.cell += (table.cell ? "\n" : "") + p.text;
          return;
        }
        if (presentation && (!slide || inLayout())) return;
        if (out.full) {
          out.truncated = true;
          return;
        }
        const text = out.text(p.text);
        if (!text) return;
        if (p.notes) slide?.notes.push(text);
        else if (p.title && slide) slide.title = slide.title ? `${slide.title} ${text}` : text;
        else if (p.heading && !presentation) out.add(blocks, { type: "heading", level: p.heading, text });
        else out.add(target()!, p.list ? { type: "paragraph", text, level: p.level, list: p.list } : { type: "paragraph", text, level: p.level });
      } else if (name === "frame" || name === "custom-shape") {
        const frame = frames.pop();
        if (!frame || notes || (presentation && !slide) || ODP_LAYOUT.has(frame.cls)) return;
        // A frame may hold the picture in several formats: the first one
        // the browser shows safely.
        const image = frame.images.find((i) => SHOWN.test(i));
        if (!image) return;
        if (table) tableImages.push(image);
        else out.add(target()!, { type: "image", image });
      } else if ((name === "table-cell" || name === "covered-table-cell") && table && tables === 1) tableCell(table, out);
      else if (name === "table-row" && table && tables === 1) tableRow(table, out);
      else if (name === "table" && !--tables && table) {
        const block = tableBlock(table);
        table = null;
        if (block && (!presentation || slide) && !notes) out.add(target()!, block);
        for (const image of tableImages) if (!presentation || slide) out.add(target()!, { type: "image", image });
        tableImages = [];
      } else if (name === "page" && presentation && !notes) slide = null;
    },
  });
  return presentation ? { slides } : { blocks };
}

async function readOdf(bytes: Buffer, presentation: boolean, out: Collector) {
  const budget = { left: OFFICE_TOTAL_BYTES };
  const parts = await zipParts(
    bytes,
    (name) => (name === "content.xml" ? { max: OFFICE_MAIN_BYTES, cut: true } : name === "styles.xml" ? { max: OFFICE_PART_BYTES } : null),
    budget,
    errors,
  );
  const content = parts.get("content.xml");
  if (!content) throw unreadable();
  if (content.cut) out.truncated = true;
  const styles = odfListStyles(parts.get("styles.xml")?.data.toString("utf8") ?? "");
  return odfContent(content.data.toString("utf8"), presentation, out, styles);
}

/* ---------- The preview ---------- */

export async function readOffice(bytes: Buffer, name: string, limits = OFFICE_LIMITS): Promise<OfficePreview> {
  const kind = officeKindOf(name);
  if (kind !== "pptx" && kind !== "odp" && kind !== "docx" && kind !== "odt") throw notPreviewable(name);
  if (bytes.subarray(0, 4).toString("latin1") !== "PK\x03\x04") throw unreadable();
  const out = new Collector(limits);
  const base = { kind, limits };
  if (kind === "pptx") {
    const slides = await readPptx(bytes, out);
    return { ...base, slides, truncated: out.truncated };
  }
  if (kind === "docx") {
    const blocks = await readDocx(bytes, out);
    return { ...base, blocks, truncated: out.truncated };
  }
  const read = await readOdf(bytes, kind === "odp", out);
  return { ...base, ...read, truncated: out.truncated };
}
// The pictures a preview shows.
export function shownImages(preview: OfficePreview) {
  const out = new Set<string>();
  const from = (blocks: OfficeBlock[]) => {
    for (const block of blocks) if (block.type === "image") out.add(block.image);
  };
  from(preview.blocks ?? []);
  for (const slide of preview.slides ?? []) from(slide.blocks);
  return out;
}

// The file's bytes, refused before reading when it is too large.
async function fileBytes(file: { id: string; name: string }) {
  let handle;
  try {
    handle = await open((await localUpload(file.id)) ?? uploadPath(file.id), "r");
  } catch {
    throw new HttpError(404, "Datei fehlt.");
  }
  try {
    const stat = await handle.stat();
    const limit = officePreviewLimit();
    if (stat.size > limit) {
      const mb = Math.round((limit / 1024 / 1024) * 10) / 10;
      throw new HttpError(413, ct(`Die Datei ist zu groß für die Vorschau (höchstens ${mb} MB).`, `The file is too large for the preview (at most ${mb} MB).`));
    }
    return { bytes: await handle.readFile(), version: `${stat.size}:${stat.mtimeMs}` };
  } finally {
    await handle.close();
  }
}
const previewable = (name: string) => {
  const kind = officeKindOf(name);
  if (kind !== "pptx" && kind !== "odp" && kind !== "docx" && kind !== "odt") throw notPreviewable(name);
};

// The pictures each recently read file shows, so that the pictures of one
// preview do not each read the whole file again (a minute, a few files).
const recent = new Map<string, { at: number; images: Set<string> }>();
async function imagesOf(file: { id: string; name: string }, bytes: Buffer, version: string) {
  const key = `${file.id}:${version}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.images;
  const images = shownImages(await readOffice(bytes, file.name));
  recent.delete(key);
  recent.set(key, { at: Date.now(), images });
  while (recent.size > 16) recent.delete(recent.keys().next().value!);
  return images;
}

export async function officePreviewResponse(_req: Request, file: { id: string; name: string; mime: string }) {
  previewable(file.name);
  const { bytes, version } = await fileBytes(file);
  const preview = await readOffice(bytes, file.name);
  recent.set(`${file.id}:${version}`, { at: Date.now(), images: shownImages(preview) });
  while (recent.size > 16) recent.delete(recent.keys().next().value!);
  return Response.json(preview, {
    headers: {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

// GET …/office/image?name=<part>: one picture the preview shows.
export async function officeImageResponse(req: Request, file: { id: string; name: string; mime: string }) {
  previewable(file.name);
  const name = new URL(req.url).searchParams.get("name") || "";
  const missing = () => new HttpError(404, ct("Bild nicht gefunden.", "Picture not found."));
  if (!name || name.length > 512 || !SHOWN.test(name)) throw missing();
  const { bytes, version } = await fileBytes(file);
  if (!(await imagesOf(file, bytes, version)).has(name)) throw missing();
  const parts: Map<string, Part> = await zipParts(bytes, (entry) => (entry === name ? { max: OFFICE_IMAGE_BYTES } : null), { left: OFFICE_IMAGE_BYTES }, errors);
  const data = parts.get(name)?.data;
  if (!data) throw missing();
  const type = sniffImage(data);
  if (!type) throw new HttpError(415, ct("Dieses Bild kann die Vorschau nicht zeigen.", "The preview cannot show this picture."));
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(data.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
