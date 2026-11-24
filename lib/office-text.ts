import { readZip } from "./archive";

// Text of Office Open XML and OpenDocument files for the search index.
export const OFFICE_TYPES: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
};
export function officeKind(mime: string, name: string) {
  const byMime = OFFICE_TYPES[mime];
  if (byMime) return byMime;
  const ext = /\.([a-z]{3,4})$/i.exec(name)?.[1]?.toLowerCase();
  return ext && Object.values(OFFICE_TYPES).includes(ext) ? ext : null;
}
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
// XML text with its entities resolved; also for the spreadsheet preview
// (lib/sheet-xlsx.ts, #402). A reference to no character stays as it is.
export const decode = (text: string) =>
  text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const point =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : Number(code.slice(1));
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return entities[code] ?? match;
  });
// Text runs of the given element names, joined per paragraph. Attributes
// end at the next "<" as well as at ">": with "[^>]*" every unclosed start
// tag scanned on to the end of the part, which made a crafted part
// quadratic (#470); with "[^<>]*" each scan stops at the next tag.
function runs(xml: string, tags: string[], breaks: string[]) {
  const pattern = new RegExp(
    `<(${tags.join("|")})(?:\\s[^<>]*)?>([^<]*)<\\/\\1>|<(?:${breaks.join("|")})(?:\\s[^<>]*)?\\/?>|<\\/(?:${breaks.join("|")})>`,
    "g",
  );
  let out = "";
  for (const m of xml.matchAll(pattern))
    out += m[2] !== undefined ? decode(m[2]) : "\n";
  return out;
}
// Runs of spaces as one, and every stretch of white space that holds a
// line break as one line break. Per line instead of /\s*\n\s*/, which
// rescans a long run of other white space (\r, \f …) from each of its
// characters (#470).
const tidy = (text: string) =>
  text
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
const MAX_TEXT = 100_000;

export async function officeText(data: Buffer, kind: string) {
  const entries = await readZip(data, { foreign: true, maxEntries: 5000 });
  const xml = (name: string) => entries.get(name)?.toString("utf8") || "";
  const sorted = (pattern: RegExp) =>
    [...entries.keys()]
      .filter((n) => pattern.test(n))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  let text = "";
  if (kind === "docx")
    text = [
      "word/document.xml",
      ...sorted(/^word\/(header|footer|footnotes|endnotes)\d*\.xml$/),
    ]
      .map((n) => runs(xml(n), ["w:t"], ["w:p", "w:br", "w:tab"]))
      .join("\n");
  else if (kind === "xlsx")
    text = [
      runs(xml("xl/sharedStrings.xml"), ["t"], ["si"]),
      ...sorted(/^xl\/worksheets\/sheet\d+\.xml$/).map((n) =>
        runs(xml(n), ["t", "v"], ["row"]),
      ),
    ].join("\n");
  else if (kind === "pptx")
    text = sorted(/^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/)
      .map((n) => runs(xml(n), ["a:t"], ["a:p"]))
      .join("\n");
  else {
    // OpenDocument paragraphs nest spans and links; keep all text nodes.
    const body = xml("content.xml").replace(/^[\s\S]*?<office:body>/, "");
    text = decode(
      body
        .replace(
          /<\/text:(p|h)>|<text:line-break\/>|<\/table:table-row>/g,
          "\n",
        )
        .replace(/<text:(tab|s)\b[^<>]*\/>/g, " ")
        .replace(/<[^<>]+>/g, ""),
    );
  }
  return tidy(text).slice(0, MAX_TEXT);
}
