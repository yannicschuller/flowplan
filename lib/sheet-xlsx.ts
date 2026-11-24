// The cells of an .xlsx workbook for the spreadsheet preview (#402,
// lib/sheet-preview.ts): the sheets' names, and of one sheet its values as
// Excel shows them – shared and inline strings (rich text runs joined),
// numbers as stored, numbers with a date format as ISO dates, booleans,
// errors, and of formulas their cached value. Nothing is calculated and
// nothing but the few parts needed is unpacked: the workbook, its
// relationships, the shared strings, the styles and the one sheet.
//
// Zip bombs: every part is read with a cap on its unpacked size (the
// declared size is not trusted, the bytes are counted), and all parts
// together share one budget. A sheet larger than its cap is read up to the
// cap – enough for the rows the preview shows – and the answer says it is
// cut; any other part over its cap refuses the preview.
import { posix } from "node:path";
import { fromBuffer, type Entry } from "yauzl";
import { HttpError } from "./auth";
import { ct } from "./content-locale";
import { decode } from "./office-text";
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, columnIndex } from "./sheet-files";

export type XlsxLimits = {
  // Unpacked bytes of the sheet read at most (the rest is left out).
  sheetBytes: number;
  // Unpacked bytes of each other part (shared strings, styles …).
  partBytes: number;
  // Unpacked bytes of all parts together.
  totalBytes: number;
  rows: number;
  columns: number;
};
export const XLSX_LIMITS: XlsxLimits = {
  sheetBytes: 64 * 1024 * 1024,
  partBytes: 64 * 1024 * 1024,
  totalBytes: 160 * 1024 * 1024,
  rows: SHEET_MAX_ROWS,
  columns: SHEET_MAX_COLUMNS,
};

const tooLarge = () =>
  new HttpError(413, ct("Die Tabelle ist entpackt zu groß für die Vorschau. Du kannst sie herunterladen.", "Unpacked, the spreadsheet is too large for the preview. You can download it."));
const unreadable = () => new HttpError(422, ct("Die Tabelle konnte nicht gelesen werden.", "The spreadsheet could not be read."));

type Part = { data: Buffer; cut: boolean };
// The entries `want` names, each up to its cap; `cut` ones are kept
// shortened instead of refused. Encrypted entries and the others are
// skipped unread.
function zipParts(bytes: Buffer, want: (name: string) => { max: number; cut?: boolean } | null, budget: { left: number }) {
  return new Promise<Map<string, Part>>((resolve, reject) =>
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (error, zip) => {
      if (error || !zip) return reject(unreadable());
      const parts = new Map<string, Part>();
      let failed = false,
        count = 0;
      const fail = (e: unknown) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(e instanceof HttpError ? e : unreadable());
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!failed) resolve(parts);
      });
      zip.on("entry", (entry: Entry) => {
        if (failed) return;
        // A workbook has a few dozen parts; tens of thousands are no workbook.
        if (++count > 20_000) return fail(unreadable());
        const wanted = parts.has(entry.fileName) || entry.isEncrypted() ? null : want(entry.fileName);
        if (!wanted) return zip.readEntry();
        if (!wanted.cut && (entry.uncompressedSize > wanted.max || entry.uncompressedSize > budget.left)) return fail(tooLarge());
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return fail(err);
          const chunks: Buffer[] = [];
          let size = 0,
            done = false;
          const keep = (cut: boolean) => {
            if (done || failed) return;
            done = true;
            parts.set(entry.fileName, { data: Buffer.concat(chunks), cut });
            zip.readEntry();
          };
          stream.on("error", (e) => {
            if (!done) fail(e);
          });
          stream.on("data", (chunk: Buffer) => {
            if (done || failed) return;
            const room = Math.min(wanted.max - size, budget.left);
            if (chunk.length > room) {
              if (!wanted.cut || room <= 0 && !size) {
                done = true;
                stream.destroy();
                return fail(tooLarge());
              }
              chunks.push(chunk.subarray(0, Math.max(0, room)));
              budget.left -= Math.max(0, room);
              size += Math.max(0, room);
              stream.destroy();
              return keep(true);
            }
            chunks.push(chunk);
            size += chunk.length;
            budget.left -= chunk.length;
          });
          stream.on("end", () => keep(false));
        });
      });
      zip.readEntry();
    }),
  );
}

/* ---------- XML ---------- */

// Element names with any namespace prefix (strict OOXML, other writers).
const el = (name: string) => `(?:[\\w.-]+:)?${name}`;
// The patterns here stay linear on crafted XML (#470): attributes end at
// the next "<" as well as at ">" ("[^<>]"), so an unclosed start tag never
// scans on to the end; a name starts only where no name character comes
// before it; and lazy scans for a closing tag only run on the text up to
// the last closing tag (throughLastClose).
function attributes(text: string) {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(?<![\w.:-])([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3] ?? "");
  return out;
}
// Where the last closing tag of `name` ends (0 without one). A start tag
// after it can have no closing tag, so a lazy scan from there is useless.
const closing = new Map<string, RegExp>();
function lastCloseEnd(xml: string, name: string) {
  if (!xml.includes(`${name}>`)) return 0;
  let pattern = closing.get(name);
  if (!pattern) closing.set(name, (pattern = new RegExp(`<\\/${el(name)}>`, "g")));
  let end = 0;
  for (const m of xml.matchAll(pattern)) end = m.index + m[0].length;
  return end;
}
const throughLastClose = (xml: string, name: string) => xml.slice(0, lastCloseEnd(xml, name));
// "_x000D_" and the like: characters XML cannot hold, as Excel escapes them.
const unescapeX = (text: string) => text.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const T_RUN = new RegExp(`<${el("t")}\\b[^<>]*?(?:\\/>|>([^<]*)<\\/${el("t")}>)`, "g");
const PHONETIC = new RegExp(`<${el("rPh")}\\b[\\s\\S]*?<\\/${el("rPh")}>`, "g");
// The text of a string item: plain or rich text runs, joined; phonetic
// guides (Japanese ruby) left out.
const stringText = (xml: string) => {
  const end = lastCloseEnd(xml, "rPh");
  const plain = xml.slice(0, end).replace(PHONETIC, "") + xml.slice(end);
  return unescapeX([...plain.matchAll(T_RUN)].map((m) => decode(m[1] ?? "")).join(""));
};

export function sharedStrings(xml: string) {
  const end = lastCloseEnd(xml, "si");
  // After the last closing tag only empty items (<si/>) can follow.
  const empty = xml.slice(end).match(new RegExp(`<${el("si")}\\b[^<>]*?\\/>`, "g"))?.length ?? 0;
  return [
    ...[...xml.slice(0, end).matchAll(new RegExp(`<${el("si")}\\b[^<>]*?(?:\\/>|>([\\s\\S]*?)<\\/${el("si")}>)`, "g"))].map((m) => stringText(m[1] ?? "")),
    ...Array<string>(empty).fill(""),
  ];
}

// Which cell styles show a number as a date or time: the built-in formats
// (14–22, 45–47 and the East Asian 27–36, 50–58) and own formats with day,
// month, year, hour or second codes outside quoted text, escapes and
// [brackets] (colours, locales).
const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
export function isDateFormat(id: number, code?: string) {
  if (code === undefined) return BUILTIN_DATES.has(id);
  const bare = code
    .split(";")[0]
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^[\]]*\]/g, "")
    .replace(/_.|\*./g, "");
  return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}
export function dateStyles(xml: string) {
  const codes = new Map<number, string>();
  for (const m of xml.matchAll(new RegExp(`<${el("numFmt")}\\b([^<>]*?)\\/?>`, "g"))) {
    const a = attributes(m[1]);
    if (a.numFmtId) codes.set(Number(a.numFmtId), a.formatCode ?? "");
  }
  const xfs = new RegExp(`<${el("cellXfs")}\\b[^<>]*>([\\s\\S]*?)<\\/${el("cellXfs")}>`).exec(throughLastClose(xml, "cellXfs"))?.[1] ?? "";
  return [...xfs.matchAll(new RegExp(`<${el("xf")}\\b([^<>]*?)\\/?>`, "g"))].map((m) => {
    const id = Number(attributes(m[1]).numFmtId || 0);
    return isDateFormat(id, codes.get(id));
  });
}

// An Excel serial number as an ISO date ("2026-11-20"), with the time where
// it has one ("2026-11-20 14:30", seconds only when there are some), or the
// time alone below 1. Workbooks in the 1904 system count from 1904-01-01;
// the 1900 system knows a 29 February 1900 that never was (serial 60).
export function serialDate(serial: number, date1904 = false) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_466) return null;
  const seconds = Math.round(serial * 86400);
  const base = date1904 ? Date.UTC(1904, 0, 1) : serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const iso = new Date(base + seconds * 1000).toISOString();
  const time = iso.slice(11, iso.endsWith(":00.000Z") ? 16 : 19);
  if (serial < 1) return time;
  return seconds % 86400 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
}
// A cell of type "d" holds an ISO date already.
const isoCell = (text: string) => {
  const m = /^(\d{4}-\d\d-\d\d)(?:T(\d\d:\d\d)(:\d\d)?(?:\.\d+)?Z?)?$/.exec(text.trim());
  if (!m) return text;
  if (!m[2] || (m[2] === "00:00" && (!m[3] || m[3] === ":00"))) return m[1];
  return `${m[1]} ${m[2]}${m[3] && m[3] !== ":00" ? m[3] : ""}`;
};

type Context = { strings: string[]; dates: boolean[]; date1904: boolean };
const ROW = new RegExp(`<${el("row")}\\b([^<>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${el("row")}>)`, "g");
const CELL = new RegExp(`<${el("c")}\\b([^<>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${el("c")}>)`, "g");
const VALUE = new RegExp(`<${el("v")}\\b[^<>]*>([^<]*)<\\/${el("v")}>`);
const INLINE = new RegExp(`<${el("is")}\\b[^<>]*>([\\s\\S]*?)<\\/${el("is")}>`);

function cellText(attrs: Record<string, string>, inner: string, ctx: Context) {
  const type = attrs.t || "n";
  if (type === "inlineStr") return stringText(INLINE.exec(throughLastClose(inner, "is"))?.[1] ?? "");
  // Formulas: only the value Excel saved with them; never calculated.
  const raw = VALUE.exec(inner)?.[1];
  if (raw === undefined) return "";
  const v = decode(raw);
  if (type === "s") return ctx.strings[Number(v)] ?? "";
  if (type === "b") return v.trim() === "1" || /^true$/i.test(v.trim()) ? "TRUE" : "FALSE";
  if (type === "d") return isoCell(v);
  if (type === "str" || type === "e") return unescapeX(v);
  if (ctx.dates[Number(attrs.s || 0)] && v.trim()) return serialDate(Number(v), ctx.date1904) ?? v;
  return v;
}

// The rows of a sheet's XML (possibly cut off – the last, incomplete row is
// then left out), up to `rows` × `columns`. Missing rows and cells are
// empty; merged cells keep their value in the first cell, the others stay
// empty, as Excel stores them.
export function sheetRows(xml: string, ctx: Context, limits: Pick<XlsxLimits, "rows" | "columns"> = XLSX_LIMITS) {
  const start = xml.search(new RegExp(`<${el("sheetData")}\\b`));
  const data = start < 0 ? "" : throughLastClose(xml.slice(start), "row");
  const rows: string[][] = [];
  let truncated = false,
    next = 0,
    width = 0;
  for (const row of data.matchAll(ROW)) {
    const r = attributes(row[1]).r;
    const index = r && /^\d+$/.test(r) ? Number(r) - 1 : next;
    next = index + 1;
    const cells: string[] = [];
    let col = 0;
    for (const cell of throughLastClose(row[2] ?? "", "c").matchAll(CELL)) {
      const attrs = attributes(cell[1]);
      const ref = /^([A-Za-z]{1,3})\d*$/.exec(attrs.r || "")?.[1];
      const c = ref ? columnIndex(ref) : col;
      col = c + 1;
      const text = cellText(attrs, cell[2] ?? "", ctx);
      if (!text) continue;
      if (c >= limits.columns) {
        truncated = true;
        continue;
      }
      while (cells.length < c) cells.push("");
      cells[c] = text;
    }
    if (!cells.length) continue;
    if (index >= limits.rows) {
      truncated = true;
      break;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = cells;
    width = Math.max(width, cells.length);
  }
  return { rows, columns: width, truncated };
}

/* ---------- The workbook ---------- */

// Relationship targets, relative to the part that names them.
function relationships(xml: string | undefined, from: string) {
  const out: { id: string; type: string; target: string }[] = [];
  for (const m of (xml ?? "").matchAll(new RegExp(`<${el("Relationship")}\\b([^<>]*?)\\/?>`, "g"))) {
    const a = attributes(m[1]);
    if (!a.Target || a.TargetMode === "External") continue;
    const target = a.Target.startsWith("/") ? a.Target.slice(1) : posix.join(posix.dirname(from), a.Target);
    out.push({ id: a.Id || "", type: a.Type || "", target: posix.normalize(target) });
  }
  return out;
}
const relsOf = (part: string) => posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
const isType = (type: string, name: string) => type.endsWith(`/${name}`);

export async function readXlsx(bytes: Buffer, sheet: number, limits: XlsxLimits = XLSX_LIMITS) {
  if (bytes.subarray(0, 4).toString("latin1") !== "PK\x03\x04") throw unreadable();
  const budget = { left: limits.totalBytes };
  // First the workbook's own parts (small, except possibly the shared strings) …
  const meta = await zipParts(bytes, (name) => (/\.rels$|(?:^|\/)(?:workbook|sharedStrings|styles)\.xml$/i.test(name) ? { max: limits.partBytes } : null), budget);
  const text = (name: string) => meta.get(name)?.data.toString("utf8");
  const book = relationships(text("_rels/.rels"), "").find((r) => isType(r.type, "officeDocument"))?.target || "xl/workbook.xml";
  const workbook = text(book);
  if (workbook === undefined) throw unreadable();
  const rels = relationships(text(relsOf(book)), book);
  const date1904 = /^(1|true)$/i.test(attributes(new RegExp(`<${el("workbookPr")}\\b([^<>]*?)\\/?>`).exec(workbook)?.[1] ?? "").date1904 || "");
  // Worksheets only (no chart sheets); hidden ones stay hidden, unless all are.
  const all = [...workbook.matchAll(new RegExp(`<${el("sheet")}\\b([^<>]*?)\\/?>`, "g"))]
    .map((m) => attributes(m[1]))
    .map((a) => ({
      name: a.name || "",
      hidden: /hidden/i.test(a.state || ""),
      target: rels.find((r) => r.id === Object.entries(a).find(([k]) => /(^|:)id$/.test(k) && k !== "sheetId")?.[1] && isType(r.type, "worksheet"))?.target,
    }))
    .filter((s): s is { name: string; hidden: boolean; target: string } => !!s.target);
  const sheets = all.some((s) => !s.hidden) ? all.filter((s) => !s.hidden) : all;
  if (!sheets.length) throw unreadable();
  const chosen = sheets[Math.min(Math.max(0, sheet), sheets.length - 1)];
  const strings = rels.find((r) => isType(r.type, "sharedStrings"))?.target ?? "xl/sharedStrings.xml";
  const styles = rels.find((r) => isType(r.type, "styles"))?.target ?? "xl/styles.xml";
  const ctx: Context = {
    strings: sharedStrings(text(strings) ?? ""),
    dates: dateStyles(text(styles) ?? ""),
    date1904,
  };
  meta.clear();
  // … then the one sheet, cut off at its cap.
  const part = (await zipParts(bytes, (name) => (name === chosen.target ? { max: limits.sheetBytes, cut: true } : null), budget)).get(chosen.target);
  if (!part) throw unreadable();
  const read = sheetRows(part.data.toString("utf8"), ctx, limits);
  return {
    sheets: sheets.map((s) => s.name),
    sheet: sheets.indexOf(chosen),
    ...read,
    truncated: read.truncated || part.cut,
  };
}
