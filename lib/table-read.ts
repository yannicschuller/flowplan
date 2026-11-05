// The cells of an editor table as plain text for "In Datenbank umwandeln"
// (#118, lib/table-database.ts): one row per table row, one cell per grid
// column (a merged cell counts in its first column, its other columns stay
// empty); formatting goes, a cell that is entirely one link keeps it.
import type { Node as PMNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import { captionText } from "./block-captions";
import type { TableCell } from "./table-database";
import { escapeInline, safeHref, serializeInline, type InlineRun } from "./inline-markdown";

function leafText(node: PMNode) {
  if (node.type.name === "hardBreak") return "\n";
  const attrs = node.attrs as Record<string, unknown>;
  if (node.type.name === "mention" && attrs.label) return `@${attrs.label}`;
  for (const key of ["label", "title", "expression"])
    if (typeof attrs[key] === "string" && attrs[key]) return String(attrs[key]);
  return "";
}

export function readCell(cell: PMNode): TableCell {
  const text = cell.textBetween(0, cell.content.size, "\n", leafText).replace(/[ \t]+\n/g, "\n").trim();
  // A cell that is only one link (all its text carries the same link).
  const links = new Set<string>();
  let unlinked = false;
  cell.descendants((node) => {
    if (!node.isText || !node.text?.trim()) return;
    const link = node.marks.find((m) => m.type.name === "link");
    if (link && typeof link.attrs.href === "string") links.add(link.attrs.href);
    else unlinked = true;
  });
  const href = !unlinked && links.size === 1 ? [...links][0] : undefined;
  const markdown = cellMarkdown(cell);
  return { text, ...(href ? { href } : {}), ...(markdown !== escapeInline(text) ? { markdown } : {}) };
}

// The cell's inline formatting as inline Markdown (#126): bold, italic,
// strike, code and web links; paragraphs and line breaks as line breaks.
function cellMarkdown(cell: PMNode): string {
  const runs: InlineRun[] = [];
  let blocks = 0;
  cell.descendants((node) => {
    if (node.isTextblock) {
      if (blocks++ > 0) runs.push({ text: "\n" });
      return true;
    }
    if (node.isText && node.text) {
      const run: InlineRun = { text: node.text };
      for (const mark of node.marks) {
        const name = mark.type.name;
        if (name === "bold") run.bold = true;
        if (name === "italic") run.italic = true;
        if (name === "strike") run.strike = true;
        if (name === "code") run.code = true;
        if (name === "link" && typeof mark.attrs.href === "string") run.href = safeHref(mark.attrs.href);
      }
      runs.push(run);
    } else if (node.isLeaf) {
      const text = leafText(node);
      if (text) runs.push({ text });
    }
    return true;
  });
  // As in `text`: no space before a line break, none at the ends.
  const md = serializeInline(runs);
  return md.replace(/[ \t]+\n/g, "\n").trim();
}

export function readTable(table: PMNode): TableCell[][] {
  const map = TableMap.get(table);
  const seen = new Set<number>();
  const rows: TableCell[][] = [];
  for (let r = 0; r < map.height; r++) {
    const row: TableCell[] = [];
    for (let c = 0; c < map.width; c++) {
      const offset = map.map[r * map.width + c];
      if (seen.has(offset)) {
        row.push({ text: "" });
        continue;
      }
      seen.add(offset);
      const cell = table.nodeAt(offset);
      row.push(cell ? readCell(cell) : { text: "" });
    }
    rows.push(row);
  }
  return rows;
}

// The name of the new database: the table's caption, else the nearest
// heading above the table, else empty (the server says "Tabelle").
export function tableTitle(doc: PMNode, tablePos: number): string {
  const table = doc.nodeAt(tablePos);
  const caption = captionText(table?.attrs.caption);
  if (caption) return caption.slice(0, 200);
  let heading = "";
  doc.nodesBetween(0, tablePos, (node, pos) => {
    if (node.type.name === "heading" && pos + node.nodeSize <= tablePos) heading = node.textContent.replace(/\s+/g, " ").trim();
    return pos < tablePos;
  });
  return heading.slice(0, 200);
}
