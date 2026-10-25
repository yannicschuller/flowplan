// A page (or a record's document) as a Word file, written without a Word
// library: the sanitised document HTML (lib/export-content.ts) becomes
// WordprocessingML – headings, paragraphs, marks, links, lists, tasks,
// tables, pictures as media parts, callouts as shaded paragraphs, code in
// a monospace style and footnotes as real footnotes – packed as a ZIP
// (lib/archive.ts).
import type { Node } from "@tiptap/pm/model";
import { audit } from "./db";
import { appUrl, HttpError } from "./auth";
import { writeZip } from "./archive";
import { calloutType } from "./document-schema";
import { citedWorks, formatReference, inlineCitation, parseItemAttribute } from "./citations";
import { ct, contentLocale } from "./content-locale";
import { localeTag } from "./i18n";
import { footnoteText } from "./footnotes";
import { exportName } from "./export-name";
import { collectExportContent, documentNode, imageExtension, type ExportFile } from "./export-content";
import type { Identity } from "./types";

export type DocxSection = {
  title: string;
  html: string;
  svg?: string | null;
  cover?: string | null;
  // Drawing blocks and notebook sheets: their typed and recognised text
  // (the picture is not part of the Word file).
  ink?: (attrs: Record<string, unknown>) => { text: string } | null;
};
export type DocxOptions = {
  title: string;
  // The document, or several pages one after another (each with its title
  // as a heading on a new page).
  sections: DocxSection[];
  creator?: string;
  // The file behind a picture address, null when it is not available.
  file: (raw: string) => ExportFile | null;
  // The address a link keeps, null to drop the link.
  url: (raw: string) => string | null;
  whiteboard?: (pageId: string) => { title: string; url: string } | null;
  linked?: (source: string) => { title: string; url: string } | null;
};

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main",
  PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture",
  REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU_PER_INCH = 914400,
  TEXT_WIDTH_INCH = 6.3,
  TABLE_WIDTH_TWIPS = 9072;
const esc = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const CALLOUT_COLOURS: Record<string, { fill: string; line: string }> = {
  note: { fill: "E8F0FE", line: "1A73E8" },
  tip: { fill: "E6F4EA", line: "188038" },
  important: { fill: "F3E8FD", line: "8430CE" },
  warning: { fill: "FEF7E0", line: "B06000" },
  caution: { fill: "FCE8E6", line: "C5221F" },
};
const calloutTitle = (type: string) =>
  ({
    note: ct("Hinweis", "Note"),
    tip: ct("Tipp", "Tip"),
    important: ct("Wichtig", "Important"),
    warning: ct("Warnung", "Warning"),
    caution: ct("Achtung", "Caution"),
  })[type] || ct("Hinweis", "Note");

// Width and height in pixels from the file's header (PNG, JPEG, GIF, WebP);
// null when the picture is of another kind or damaged.
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && bytes.subarray(0, 6).toString("latin1").startsWith("GIF8"))
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    const kind = bytes.subarray(12, 16).toString("latin1");
    if (kind === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1, height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1 };
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        offset += marker === 0xff ? 1 : 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0–SOF15 (without the DHT, JPG and DAC markers) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
  }
  return null;
}

type Block = {
  // Paragraph properties of the surrounding blocks: list numbering, indent,
  // borders and shading of quotes and callouts.
  numPr?: string;
  indent: number;
  border?: string;
  shading?: string;
  inTable: boolean;
  // Header cells of a table.
  bold?: boolean;
};
// Run properties, written in the order the schema demands (Word checks it).
type RunProps = {
  rStyle?: string;
  fonts?: string;
  b?: boolean;
  i?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  u?: boolean;
  shd?: string;
  vertAlign?: "superscript" | "subscript";
};
const rPr = (p: RunProps) =>
  [
    p.rStyle && `<w:rStyle w:val="${p.rStyle}"/>`,
    p.fonts && `<w:rFonts w:ascii="${p.fonts}" w:hAnsi="${p.fonts}" w:cs="${p.fonts}"/>`,
    p.b && "<w:b/>",
    p.i && "<w:i/>",
    p.strike && "<w:strike/>",
    p.color && `<w:color w:val="${p.color}"/>`,
    p.highlight && `<w:highlight w:val="${p.highlight}"/>`,
    p.u && '<w:u w:val="single"/>',
    p.shd && `<w:shd w:val="clear" w:color="auto" w:fill="${p.shd}"/>`,
    p.vertAlign && `<w:vertAlign w:val="${p.vertAlign}"/>`,
  ]
    .filter(Boolean)
    .join("");
type Run = { text?: string; xml?: string; props?: RunProps };

export async function buildDocx(options: DocxOptions): Promise<Buffer> {
  const body: string[] = [];
  const relationships: string[] = [];
  const media = new Map<string, Buffer>();
  const footnotes: string[] = [];
  const numbering: string[] = [];
  let relationshipCount = 3, // styles, numbering, footnotes, settings are fixed below
    imageCount = 0,
    numCount = 0,
    pictureCount = 0;
  const relationship = (type: string, target: string, external = false) => {
    const id = `rId${++relationshipCount + 1}`;
    relationships.push(`<Relationship Id="${id}" Type="${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`);
    return id;
  };
  const pictures = new Map<string, { rId: string; width: number; height: number } | null>();
  const picture = (raw: string) => {
    if (pictures.has(raw)) return pictures.get(raw)!;
    const file = options.file(raw),
      ext = file && imageExtension(file.mime);
    if (!file || !ext || ext === "svg" || ext === "avif") {
      pictures.set(raw, null);
      return null;
    }
    const name = `image${++imageCount}.${ext === "jpg" ? "jpeg" : ext}`;
    media.set(`word/media/${name}`, file.bytes);
    const size = imageSize(file.bytes) || { width: 600, height: 400 };
    const entry = { rId: relationship(`${REL}/image`, `media/${name}`), width: size.width, height: size.height };
    pictures.set(raw, entry);
    return entry;
  };
  const paragraph = (runs: string, pPr = "") => body.push(`<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`);
  const run = ({ text, xml, props = {} }: Run) => {
    const properties = rPr(props);
    return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}${xml ?? ""}${text !== undefined ? textRuns(text) : ""}</w:r>`;
  };
  const textRuns = (text: string) =>
    text
      .split("\n")
      .map((line) => `<w:t xml:space="preserve">${esc(line)}</w:t>`)
      .join("<w:br/>");
  const numbered = (abstract: 0 | 1, level: number, start = 1) => {
    const id = ++numCount;
    numbering.push(
      `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstract}"/><w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`,
    );
    return id;
  };
  const indentTwips = (block: Block, extra = 0) => block.indent + extra;
  // Paragraph properties in schema order: style, numbering, borders,
  // shading, direction, indent, alignment.
  const paragraphProps = (node: Node | null, block: Block, style?: string, extra: { jc?: string } = {}) => {
    const indent = indentTwips(block);
    const align = extra.jc || (["center", "right", "justify"].includes(String(node?.attrs.textAlign || "")) ? String(node!.attrs.textAlign) : "");
    return [
      style && `<w:pStyle w:val="${style}"/>`,
      block.numPr,
      block.border,
      block.shading,
      node?.attrs.dir === "rtl" && "<w:bidi/>",
      indent && !block.numPr && `<w:ind w:left="${indent}"/>`,
      align && `<w:jc w:val="${align === "justify" ? "both" : align}"/>`,
    ]
      .filter(Boolean)
      .join("");
  };

  const cited: { key: string; item: string }[] = [];
  function inline(node: Node, block: Block): string {
    const base: RunProps = block.bold ? { b: true } : {};
    if (node.type.name === "hardBreak") return "<w:r><w:br/></w:r>";
    if (node.type.name === "citation")
      return run({ text: inlineCitation(parseItemAttribute(node.attrs.item), String(node.attrs.locator || ""), ct), props: base });
    if (node.type.name === "footnote") {
      const id = footnotes.length + 1;
      footnotes.push(
        `<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${run({ text: ` ${footnoteText(node.attrs.note)}` })}</w:p></w:footnote>`,
      );
      return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
    }
    if (node.type.name === "mention") return run({ text: `@${String(node.attrs.label || "")}`, props: base });
    if (node.type.name === "mathInline") return run({ text: String(node.attrs.expression || ""), props: { ...base, rStyle: "CodeChar" } });
    if (!node.isText) {
      let result = "";
      node.forEach((child) => (result += inline(child, block)));
      return result;
    }
    const props: RunProps = { ...base };
    let link: string | null = null;
    const hex = (value: unknown) => (/^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).slice(1).toUpperCase() : null);
    for (const mark of node.marks) {
      switch (mark.type.name) {
        case "bold":
          props.b = true;
          break;
        case "italic":
          props.i = true;
          break;
        case "underline":
          props.u = true;
          break;
        case "strike":
          props.strike = true;
          break;
        case "code":
          props.rStyle = "CodeChar";
          break;
        case "highlight":
          if (hex(mark.attrs.color)) props.shd = hex(mark.attrs.color)!;
          else props.highlight = "yellow";
          break;
        case "textColor":
          if (hex(mark.attrs.color)) props.color = hex(mark.attrs.color)!;
          break;
        case "superscript":
          props.vertAlign = "superscript";
          break;
        case "subscript":
          props.vertAlign = "subscript";
          break;
        case "link":
          link = options.url(String(mark.attrs.href || ""));
          break;
      }
    }
    // A link's style; code inside a link keeps the link's look.
    if (link) props.rStyle = "Hyperlink";
    const text = run({ text: node.text || "", props });
    return link ? `<w:hyperlink r:id="${relationship(`${REL}/hyperlink`, link, true)}">${text}</w:hyperlink>` : text;
  }
  const pictureRun = (entry: { rId: string; width: number; height: number }, alt: string, block: Block) => {
    const maxWidth = (block.inTable ? TEXT_WIDTH_INCH / 2 : TEXT_WIDTH_INCH) * EMU_PER_INCH;
    // 96 pixels per inch, scaled down to the text width.
    let cx = Math.round((entry.width / 96) * EMU_PER_INCH),
      cy = Math.round((entry.height / 96) * EMU_PER_INCH);
    if (cx > maxWidth) {
      cy = Math.round((cy * maxWidth) / cx);
      cx = Math.round(maxWidth);
    }
    const id = ++pictureCount;
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${id}" name="Picture ${id}" descr="${esc(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="${PIC_NS}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${entry.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  };
  const linkParagraph = (label: string, url: string | null, block: Block, prefix = "") => {
    const runs =
      (prefix ? run({ text: prefix }) : "") +
      (url
        ? `<w:hyperlink r:id="${relationship(`${REL}/hyperlink`, url, true)}">${run({ text: label, props: { rStyle: "Hyperlink" } })}</w:hyperlink>`
        : run({ text: label }));
    paragraph(runs, paragraphProps(null, block));
  };
  const codeParagraph = (source: string, block: Block) => paragraph(run({ text: source.replace(/\n$/, "") }), paragraphProps(null, block, "Code"));
  function children(node: Node, block: Block) {
    node.forEach((child) => blockNode(child, block));
  }
  function list(node: Node, block: Block, level: number) {
    const kind = node.type.name;
    const numId = kind === "taskList" ? 0 : numbered(kind === "orderedList" ? 1 : 0, level, Number(node.attrs.start) || 1);
    node.forEach((item) => {
      const itemBlock: Block = {
        ...block,
        indent: 720 + 360 * level,
        numPr: numId ? `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>` : undefined,
      };
      let first = true;
      item.forEach((child) => {
        if (["bulletList", "orderedList", "taskList"].includes(child.type.name)) {
          list(child, { ...block }, Math.min(8, level + 1));
          return;
        }
        if (child.type.name === "paragraph") {
          const prefix =
            kind === "taskList" && first
              ? run({ text: item.attrs.checked ? "☑ " : "☐ ", props: { fonts: "Segoe UI Symbol" } })
              : "";
          const due =
            kind === "taskList" && first && /^\d{4}-\d{2}-\d{2}$/.test(String(item.attrs.due || ""))
              ? run({ text: ` (${ct("fällig", "due")} ${item.attrs.due})`, props: { color: "666666" } })
              : "";
          // Only the first paragraph of an item carries the number or box;
          // the following ones hang below it.
          const props = first ? itemBlock : { ...itemBlock, numPr: undefined, indent: itemBlock.indent };
          paragraph(prefix + inline(child, props) + due, paragraphProps(child, props, numId ? "ListParagraph" : undefined));
          first = false;
          return;
        }
        blockNode(child, { ...itemBlock, numPr: undefined });
        first = false;
      });
      if (first) paragraph(kind === "taskList" ? run({ text: item.attrs.checked ? "☑" : "☐" }) : "", paragraphProps(null, itemBlock, numId ? "ListParagraph" : undefined));
    });
  }
  function table(node: Node, block: Block) {
    // Merged cells: every grid position knows the cell covering it. A cell
    // spanning columns is one tc with gridSpan; one spanning rows starts a
    // vMerge and continues with an empty tc in the rows below.
    type Cell = { node: Node; row: number; column: number; colspan: number; rowspan: number; head: boolean };
    const grid: (Cell | undefined)[][] = [];
    let width = 0;
    node.forEach((row, _offset, rowIndex) => {
      grid[rowIndex] ||= [];
      let column = 0;
      row.forEach((cell) => {
        while (grid[rowIndex][column]) column++;
        const colspan = Math.max(1, Number(cell.attrs.colspan) || 1),
          rowspan = Math.max(1, Number(cell.attrs.rowspan) || 1);
        if (column + colspan > 200 || rowIndex + rowspan > 5000) throw new HttpError(413, "Tabelle zu groß (höchstens 200 Spalten und 5.000 Zeilen).");
        const entry: Cell = { node: cell, row: rowIndex, column, colspan, rowspan, head: cell.type.name === "tableHeader" };
        for (let r = rowIndex; r < rowIndex + rowspan; r++) {
          grid[r] ||= [];
          for (let c = column; c < column + colspan; c++) grid[r][c] = entry;
        }
        column += colspan;
        width = Math.max(width, column);
      });
    });
    if (!width) return;
    const columnWidth = Math.floor(TABLE_WIDTH_TWIPS / width);
    let rows = "";
    grid.forEach((row, rowIndex) => {
      let cells = "";
      for (let column = 0; column < width; ) {
        const cell = row[column];
        if (!cell) {
          cells += `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
          column++;
          continue;
        }
        const span = cell.colspan;
        const tcW = `<w:tcW w:w="${columnWidth * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}`;
        if (cell.row !== rowIndex) {
          cells += `<w:tc><w:tcPr>${tcW}<w:vMerge/></w:tcPr><w:p/></w:tc>`;
          column += span;
          continue;
        }
        const start = body.length;
        children(cell.node, { ...block, indent: 0, numPr: undefined, border: undefined, shading: undefined, inTable: true, bold: cell.head });
        const content = body.splice(start).join("") || "<w:p/>";
        cells +=
          `<w:tc><w:tcPr>${tcW}${cell.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : ""}${cell.head ? '<w:shd w:val="clear" w:color="auto" w:fill="E7E6E6"/>' : ""}</w:tcPr>${content}</w:tc>`;
        column += span;
      }
      rows += `<w:tr>${cells}</w:tr>`;
    });
    body.push(
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
        `<w:tblGrid>${Array.from({ length: width }, () => `<w:gridCol w:w="${columnWidth}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`,
    );
    // Word needs a paragraph after a table (and before the next one).
    body.push("<w:p/>");
  }
  function blockNode(node: Node, block: Block) {
    switch (node.type.name) {
      case "paragraph":
        return paragraph(inline(node, block), paragraphProps(node, block));
      case "heading": {
        const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
        return paragraph(inline(node, block), paragraphProps(node, block, `Heading${level}`));
      }
      case "horizontalRule":
        return paragraph("", `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>`);
      case "codeBlock":
        return codeParagraph(node.textContent, block);
      case "mathBlock":
        return codeParagraph(String(node.attrs.expression || ""), block);
      case "mermaidBlock":
        return codeParagraph(String(node.attrs.source || ""), block);
      case "functionPlot":
        return paragraph(run({ text: ct("Funktionsgraph (nur in Flowplan)", "Function plot (only in Flowplan)"), props: { i: true } }), paragraphProps(null, block));
      case "metricBlock":
        return paragraph(run({ text: ct("Kennzahl (nur in Flowplan)", "Metric (only in Flowplan)"), props: { i: true } }), paragraphProps(null, block));
      case "bibliography": {
        paragraph(run({ text: String(node.attrs.title || ct("Literaturverzeichnis", "References")) }), paragraphProps(null, block, "Heading2"));
        for (const item of citedWorks(cited))
          paragraph(formatReference(item, ct).map((part) => run({ text: part.text, props: { i: !!part.italic } })).join(""), paragraphProps(null, block));
        return;
      }
      case "image": {
        const src = String(node.attrs.src || ""),
          alt = String(node.attrs.alt || ""),
          entry = picture(src);
        if (!entry) {
          const url = options.url(src);
          return linkParagraph(`${alt || ct("Bild", "Image")} ${url ? "" : ct("(nicht verfügbar)", "(not available)")}`.trim(), url, block);
        }
        paragraph(pictureRun(entry, alt, block), paragraphProps(null, block, undefined, block.inTable ? {} : { jc: "center" }));
        if (node.attrs.title) paragraph(run({ text: String(node.attrs.title) }), paragraphProps(null, block, "Caption"));
        return;
      }
      case "media": {
        const url = options.url(String(node.attrs.src || "")),
          title = String(node.attrs.title || { audio: "Audio", video: "Video", embed: "Video", pdf: "PDF" }[String(node.attrs.kind)] || ct("Medium", "Media"));
        return linkParagraph(url ? title : `${title} ${ct("(nicht verfügbar)", "(not available)")}`, url, block);
      }
      case "linkCard": {
        const url = options.url(String(node.attrs.url || ""));
        return linkParagraph(String(node.attrs.title || node.attrs.url || ""), url, block);
      }
      case "bulletList":
      case "orderedList":
      case "taskList":
        // Nested lists are handled inside list(); here a list starts anew.
        return list(node, block, 0);
      case "blockquote":
        return children(node, {
          ...block,
          indent: block.indent + 480,
          border: '<w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="BFBFBF"/></w:pBdr>',
        });
      case "callout": {
        const type = calloutType(node.attrs.type),
          colours = CALLOUT_COLOURS[type];
        const inner: Block = {
          ...block,
          indent: block.indent + 240,
          border: `<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${colours.line}"/></w:pBdr>`,
          shading: `<w:shd w:val="clear" w:color="auto" w:fill="${colours.fill}"/>`,
        };
        paragraph(run({ text: calloutTitle(type), props: { b: true, color: colours.line } }), paragraphProps(null, inner));
        return children(node, inner);
      }
      case "toggle":
        paragraph(run({ text: String(node.attrs.title || "Details"), props: { b: true } }), paragraphProps(null, block));
        return children(node, block);
      case "columns":
        return node.forEach((column) => children(column, block));
      case "whiteboardEmbed": {
        const board = options.whiteboard?.(String(node.attrs.pageId || ""));
        return board
          ? linkParagraph(board.title || "Whiteboard", board.url, block, `${ct("Whiteboard", "Whiteboard")}: `)
          : paragraph(run({ text: ct("Whiteboard nicht verfügbar", "Whiteboard not available"), props: { i: true } }), paragraphProps(null, block));
      }
      case "drawBlock": {
        const ink = currentInk?.(node.attrs);
        paragraph(run({ text: ct("Handschrift (in Word nicht als Bild enthalten)", "Handwriting (not included as a picture in Word)"), props: { i: true } }), paragraphProps(null, block));
        for (const line of (ink?.text || "").split("\n").filter(Boolean)) paragraph(run({ text: line }), paragraphProps(null, block));
        return;
      }
      case "linkedDatabase": {
        const linked = options.linked?.(String(node.attrs.source || ""));
        return linked
          ? linkParagraph(linked.title, linked.url, block, `${ct("Verknüpfte Datenbank", "Linked database")}: `)
          : paragraph(run({ text: ct("Verknüpfte Datenbank nicht verfügbar", "Linked database not available"), props: { i: true } }), paragraphProps(null, block));
      }
      case "table":
        return table(node, block);
      default:
        return children(node, block);
    }
  }

  const base: Block = { indent: 0, inTable: false };
  let currentInk: DocxSection["ink"];
  options.sections.forEach((section, index) => {
    currentInk = section.ink;
    if (index === 0) paragraph(run({ text: section.title }), '<w:pStyle w:val="Title"/>');
    else paragraph(run({ text: section.title }), '<w:pStyle w:val="Heading1"/><w:pageBreakBefore/>');
    if (section.cover) {
      const entry = picture(section.cover);
      if (entry) paragraph(pictureRun(entry, "", base), '<w:jc w:val="center"/>');
    }
    if (section.svg !== undefined && section.svg !== null)
      paragraph(run({ text: ct("Das Whiteboard dieser Seite ist in Word nicht enthalten.", "The whiteboard of this page is not part of the Word file."), props: { i: true } }));
    if (!section.html) return;
    const doc = documentNode(section.html);
    cited.length = 0;
    let bibliographies = 0;
    doc.descendants((node) => {
      if (node.type.name === "citation") cited.push({ key: String(node.attrs.key || ""), item: String(node.attrs.item || "") });
      if (node.type.name === "bibliography") bibliographies++;
    });
    children(doc, base);
    if (cited.length && !bibliographies) {
      paragraph(run({ text: ct("Literaturverzeichnis", "References") }), '<w:pStyle w:val="Heading2"/>');
      for (const item of citedWorks(cited))
        paragraph(formatReference(item, ct).map((part) => run({ text: part.text, props: { i: !!part.italic } })).join(""));
    }
  });
  const language = localeTag(contentLocale());
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}"><w:body>${body.join("")}` +
    `<w:sectPr><w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const headingSizes = [32, 26, 24, 22, 22, 22];
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="${language}"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>` +
    headingSizes
      .map(
        (size, index) =>
          `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
          `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${index ? 200 : 360}" w:after="80"/><w:outlineLvl w:val="${index}"/></w:pPr><w:rPr><w:b/>${index > 2 ? "<w:i/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`,
      )
      .join("") +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:keepLines/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/><w:ind w:left="120" w:right="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:sz w:val="19"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders></w:tblPr></w:style>` +
    `</w:styles>`;
  const bullets = ["•", "◦", "▪"],
    formats = [
      ["decimal", "%1."],
      ["lowerLetter", "%2."],
      ["lowerRoman", "%3."],
    ];
  const levels = (abstract: 0 | 1) =>
    Array.from({ length: 9 }, (_, level) => {
      const [format, text] = abstract ? formats[level % 3] : ["bullet", bullets[level % 3]];
      return (
        `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${abstract ? text.replace(/%\d/, `%${level + 1}`) : text}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${720 + 360 * level}" w:hanging="360"/></w:pPr></w:lvl>`
      );
    }).join("");
  const numberingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(0)}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(1)}</w:abstractNum>` +
    numbering.join("") +
    `</w:numbering>`;
  const footnotesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${W_NS}" xmlns:r="${R_NS}">` +
    `<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
    footnotes.join("") +
    `</w:footnotes>`;
  const settings =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W_NS}"><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(options.title)}</dc:title><dc:creator>${esc(options.creator || "Flowplan")}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const extensions = new Set([...media.keys()].map((path) => path.slice(path.lastIndexOf(".") + 1)));
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    [...extensions].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext === "jpg" ? "jpeg" : ext}"/>`).join("") +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>` +
    `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const documentRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/footnotes" Target="footnotes.xml"/><Relationship Id="rId4" Type="${REL}/settings" Target="settings.xml"/>` +
    relationships.join("") +
    `</Relationships>`;
  const entries = new Map<string, Buffer>([
    ["[Content_Types].xml", Buffer.from(contentTypes)],
    ["_rels/.rels", Buffer.from(rootRels)],
    ["docProps/core.xml", Buffer.from(core)],
    ["word/document.xml", Buffer.from(document)],
    ["word/_rels/document.xml.rels", Buffer.from(documentRels)],
    ["word/styles.xml", Buffer.from(styles)],
    ["word/numbering.xml", Buffer.from(numberingXml)],
    ["word/footnotes.xml", Buffer.from(footnotesXml)],
    ["word/settings.xml", Buffer.from(settings)],
    ...media,
  ]);
  return writeZip(entries);
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// A page, or one record of a database, as a Word file for the person.
export async function exportDocx(user: Identity, options: { pageId: string; rowId?: string }) {
  const content = collectExportContent(user, { pageId: options.pageId, rowId: options.rowId, children: false, maxPages: 1, format: "Word" });
  const page = content.pages[0];
  const bytes = await buildDocx({
    title: content.name,
    creator: user.name,
    sections: [{ title: page.title, html: page.html, svg: page.svg, cover: page.cover, ink: (attrs) => content.ink(page.page.id, attrs) }],
    file: content.file,
    url: (raw) => exportUrl(raw, content.readable, content.pageUrl),
    whiteboard: (pageId) => {
      const board = content.readable(pageId);
      return board && board.kind === "whiteboard" ? { title: board.title, url: content.pageUrl(board.id) } : null;
    },
    linked: (source) => {
      const db = content.readable(source);
      return db && db.kind === "database" ? { title: db.title, url: content.pageUrl(db.id) } : null;
    },
  });
  audit(user.id, options.rowId ? "record.docx.export" : "page.docx.export", options.pageId);
  return { bytes, name: `${exportName(content.name)}.docx`, mime: DOCX_MIME };
}

// Links an export keeps: web addresses, mail, and pages of Flowplan the
// person may read (as absolute addresses); files only when readable.
export function exportUrl(raw: string, readable: (idOrUrl: string) => unknown, pageUrl: (id: string) => string, file?: (raw: string) => unknown) {
  const base = appUrl();
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password) return null;
  if (url.origin === new URL(base).origin) {
    if (/^\/api\/files\/[a-f0-9-]{36}$/i.test(url.pathname)) return file && file(url.pathname) ? url.href : null;
    if (url.hash.startsWith("#page=")) {
      const id = new URLSearchParams(url.hash.slice(1)).get("page") || "";
      return readable(id) ? pageUrl(id) : null;
    }
  }
  return url.href;
}
