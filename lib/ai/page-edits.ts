// Changes the AI proposes to a page (#135, "Als Änderungsvorschlag
// einfügen"): never written over the page, always as suggested changes
// (lib/suggestions.ts) that people with edit rights accept or reject one by
// one.
//
// Works with every provider – a plain chat answer, no tool use: the page
// goes to the model as numbered blocks ([B1], [B2] … – every paragraph,
// heading, list item, table cell and code block), and the model answers
// with edit tags:
//   <edit op="replace" block="B3">the block's complete new content</edit>
//   <edit op="insert_after" block="B5">new blocks (Markdown)</edit>
//   <edit op="insert_before" block="B1">…</edit>
//   <edit op="delete" block="B7"></edit>
// Applying finds each block again (by its block id, else at the same place
// with the same text, else by its unique text) – a block that changed in the
// meantime or cannot be found is reported as not applied, nothing is
// guessed. A replaced block is compared word by word (a code block line by
// line): unchanged words keep their formatting, removed ones are marked as
// deletion, new ones as insertion – one suggestion per edit, so each can be
// accepted or rejected on its own. Pure functions on ProseMirror nodes;
// lib/ai/page-edit.ts runs them on the stored document.
import { Fragment, type Mark, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { validBlockId } from "../block-ids";
import { markdownSymbol } from "../task-status";
import type { SuggestionAttrs } from "../suggestions";

// Inline objects (mentions, formulas, footnotes) in a block's text.
export const OBJECT = "\uFFFC";
const ITEMS = new Set(["listItem", "taskItem"]);
const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
const CELLS = new Set(["tableCell", "tableHeader"]);

export type PageBlock = { handle: string; index: number; pos: number; node: PMNode; blockId: string | null; text: string; type: string };
// What is kept of a block between the prompt and applying.
export type BlockSnapshot = { handle: string; index: number; blockId: string | null; text: string; type: string };

// A block's text: one character per position (text, "\n" for a line
// break, OBJECT for other inline nodes), so text offsets are positions.
export function blockText(node: PMNode) {
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text;
    else if (child.type.name === "hardBreak") text += "\n";
    else text += OBJECT.repeat(child.nodeSize);
  });
  return text;
}

// Every text block in document order, with its handle.
export function pageBlocks(doc: PMNode): PageBlock[] {
  const out: PageBlock[] = [];
  doc.descendants((node, pos, parent, index) => {
    if (!node.isTextblock) return true;
    // The first paragraph of a list item is the item's text: the item has the id.
    const itemText = index === 0 && node.type.name === "paragraph" && !!parent && ITEMS.has(parent.type.name);
    const blockId = validBlockId(node.attrs.blockId) || (itemText ? validBlockId(parent!.attrs.blockId) : null);
    out.push({ handle: `B${out.length + 1}`, index: out.length, pos, node, blockId, text: blockText(node), type: node.type.name });
    return false;
  });
  return out;
}
export const snapshotOf = (block: PageBlock): BlockSnapshot => ({ handle: block.handle, index: block.index, blockId: block.blockId, text: block.text, type: block.type });

// Inline objects as the model sees them: ⟨@Ada⟩, ⟨formula⟩ …
function objectLabel(node: PMNode) {
  const label = String(node.attrs.label || node.attrs.title || node.attrs.name || node.attrs.latex || node.type.name).replace(/[⟨⟩\n]/g, " ").slice(0, 40);
  return `⟨${label}⟩`;
}
function shownText(node: PMNode, indent: string) {
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text;
    else if (child.type.name === "hardBreak") text += `\n${indent}`;
    else text += objectLabel(child);
  });
  return text;
}

// The page as numbered blocks for the prompt, at most `maxChars` long.
export function pageOutline(doc: PMNode, maxChars: number) {
  const all = pageBlocks(doc);
  const byPos = new Map(all.map((b) => [b.pos, b]));
  const lines: string[] = [];
  const shown: PageBlock[] = [];
  let size = 0;
  let truncated = false;
  const push = (line: string, block?: PageBlock) => {
    if (truncated) return;
    if (size + line.length + 1 > maxChars && lines.length) {
      truncated = true;
      return;
    }
    lines.push(line);
    size += line.length + 1;
    if (block) shown.push(block);
  };
  const visit = (node: PMNode, pos: number, indent: string, marker: string) => {
    if (truncated) return;
    if (node.isTextblock) {
      const block = byPos.get(pos)!;
      const label = `[${block.handle}] `;
      if (node.type.name === "codeBlock") {
        const fence = node.textContent.includes("```") ? "````" : "```";
        const code = node.textContent.split("\n").map((l) => indent + l).join("\n");
        push(`${indent}${label}${marker}${fence}${String(node.attrs.language || "")}\n${code}\n${indent}${fence}`, block);
      } else {
        const heading = node.type.name === "heading" ? "#".repeat(Number(node.attrs.level) || 1) + " " : "";
        push(`${indent}${label}${marker}${heading}${shownText(node, indent)}`, block);
      }
      return;
    }
    const type = node.type.name;
    if (node.isAtom || node.isLeaf) return push(`${indent}${marker}(${type})`);
    if (LISTS.has(type)) {
      const start = Number(node.attrs.start) || 1;
      node.forEach((item, offset, i) => {
        const bullet = type === "orderedList" ? `${start + i}. ` : "- ";
        const box = item.type.name === "taskItem" ? `[${markdownSymbol(item.attrs)}] ` : "";
        item.forEach((child, childOffset, j) =>
          visit(child, pos + 1 + offset + 1 + childOffset, j === 0 ? indent : indent + "  ", j === 0 ? `${marker}${bullet}${box}` : ""),
        );
      });
      return;
    }
    const inner = type === "blockquote" || type === "callout" ? indent + "> " : CELLS.has(type) ? indent + "| " : indent;
    node.forEach((child, offset) => visit(child, pos + 1 + offset, inner, ""));
  };
  doc.forEach((node, offset) => visit(node, offset, "", ""));
  return { text: lines.join("\n"), blocks: shown, truncated };
}

// ---- The model's answer ----

export type PageEditOp = "replace" | "insert_after" | "insert_before" | "delete";
export type PageEdit = { op: PageEditOp; handle: string; content: string };
const OPS: Record<string, PageEditOp> = {
  replace: "replace",
  update: "replace",
  change: "replace",
  insert_after: "insert_after",
  after: "insert_after",
  append: "insert_after",
  add: "insert_after",
  insert: "insert_after",
  insert_before: "insert_before",
  before: "insert_before",
  delete: "delete",
  remove: "delete",
};
const attribute = (attrs: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, "i").exec(attrs)?.slice(1).find((v) => v !== undefined);

// The edit tags of an answer; anything else in it is ignored.
export function parsePageEdits(answer: string): PageEdit[] {
  const edits: PageEdit[] = [];
  for (const match of answer.matchAll(/<edit\b([^>]*?)(?:\/>|>([\s\S]*?)<\/edit\s*>)/gi)) {
    const op = OPS[(attribute(match[1], "op") || "").toLowerCase().replace(/[-\s]/g, "_")];
    const handle = /^\[?B(\d{1,5})\]?$/i.exec((attribute(match[1], "block") || "").trim());
    if (!op || !handle) continue;
    const content = (match[2] || "").replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "");
    edits.push({ op, handle: `B${Number(handle[1])}`, content });
  }
  return edits;
}

// ---- Word and line differences ----

type Hunk = { oldFrom: number; oldTo: number; newFrom: number; newTo: number };
const words = (text: string) => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
// Larger differences are not compared token by token: the changed middle
// is replaced as a whole.
const MAX_CELLS = 4_000_000;

// The changed stretches between two texts (offsets in characters).
export function diffHunks(before: string, after: string, unit: "words" | "lines" = "words"): Hunk[] {
  const a = unit === "lines" ? lines(before) : words(before);
  const b = unit === "lines" ? lines(after) : words(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const offsets = (tokens: string[]) => {
    const out = [0];
    for (const t of tokens) out.push(out[out.length - 1] + t.length);
    return out;
  };
  const oa = offsets(a),
    ob = offsets(b);
  const n = endA - start,
    m = endB - start;
  if (!n && !m) return [];
  // Token pairs of the middle: the longest common subsequence.
  type Op = { kind: "eq" | "del" | "ins"; i: number; j: number };
  const ops: Op[] = [];
  if (n && m && n * m <= MAX_CELLS) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) ops.push({ kind: "eq", i: i++, j: j++ });
      else if (j < m && (i >= n || table[i * width + j + 1] >= table[(i + 1) * width + j])) ops.push({ kind: "ins", i, j: j++ });
      else ops.push({ kind: "del", i: i++, j });
    }
  } else {
    for (let i = 0; i < n; i++) ops.push({ kind: "del", i, j: 0 });
    for (let j = 0; j < m; j++) ops.push({ kind: "ins", i: n, j });
  }
  // Runs of changes; a short unchanged stretch between two changes (a
  // space, a comma) joins them, so the suggestion reads as words.
  const hunks: Hunk[] = [];
  let current: { i0: number; i1: number; j0: number; j1: number } | null = null;
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.kind === "eq") {
      let run = k;
      while (run < ops.length && ops[run].kind === "eq") run++;
      const text = a.slice(start + op.i, start + ops[run - 1].i + 1).join("");
      const bridge = current && run < ops.length && unit === "words" && text.length <= 2 && !/[\p{L}\p{N}]/u.test(text);
      if (bridge) {
        current!.i1 = ops[run - 1].i + 1;
        current!.j1 = ops[run - 1].j + 1;
      } else if (current) {
        hunks.push({ oldFrom: oa[start + current.i0], oldTo: oa[start + current.i1], newFrom: ob[start + current.j0], newTo: ob[start + current.j1] });
        current = null;
      }
      k = run;
      continue;
    }
    if (!current) current = { i0: op.i, i1: op.i, j0: op.j, j1: op.j };
    if (op.kind === "del") current.i1 = op.i + 1;
    else current.j1 = op.j + 1;
    k++;
  }
  if (current) hunks.push({ oldFrom: oa[start + current.i0], oldTo: oa[start + current.i1], newFrom: ob[start + current.j0], newTo: ob[start + current.j1] });
  return hunks;
}

// ---- Applying ----

export type ApplyOptions = {
  // Markdown → block nodes of the document's schema.
  parse: (markdown: string) => Fragment;
  author: { id: string; name: string };
  now?: number;
  newId?: () => string;
};
export type ApplyFailure = { handle: string; op: PageEditOp; reason: "not-found" | "changed" | "unsupported" | "empty" | "duplicate" };
export type ApplyResult = { doc: PMNode; applied: number; unchanged: number; failed: ApplyFailure[] };

const randomId = () => Math.random().toString(36).slice(2, 10);

// The block again, in the current document.
function locate(live: PageBlock[], snap: BlockSnapshot): PageBlock | "changed" | null {
  if (snap.blockId) {
    const same = live.filter((b) => b.blockId === snap.blockId);
    if (same.length === 1) return same[0].text === snap.text && same[0].type === snap.type ? same[0] : "changed";
  }
  const there = live[snap.index];
  if (there && there.text === snap.text && there.type === snap.type) return there;
  if (!snap.text.trim()) return null;
  const same = live.filter((b) => b.text === snap.text && b.type === snap.type);
  return same.length === 1 ? same[0] : null;
}

// A fenced block's code; the content as it is otherwise.
function codeOf(content: string) {
  const fenced = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/.exec(content);
  return fenced ? fenced[2] : content;
}
// The one text block of a fragment, inside a single list or quote.
function singleTextblock(fragment: Fragment): PMNode | null {
  if (fragment.childCount !== 1) return null;
  const node = fragment.firstChild!;
  if (node.isTextblock) return node;
  if (LISTS.has(node.type.name) || ITEMS.has(node.type.name) || node.type.name === "blockquote") return singleTextblock(node.content);
  return null;
}
// Without empty paragraphs and blocks without text (a divider cannot be
// marked as a suggestion, and would stay when it is rejected).
function contentBlocks(fragment: Fragment) {
  const kept: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.textContent.replaceAll(OBJECT, "").trim()) kept.push(node);
  });
  return Fragment.fromArray(kept);
}

export function applyPageEdits(doc: PMNode, edits: PageEdit[], snapshots: BlockSnapshot[], options: ApplyOptions): ApplyResult {
  const schema = doc.type.schema as Schema;
  const type = schema.marks.suggestion;
  const tr = new Transform(doc);
  const failed: ApplyFailure[] = [];
  let applied = 0,
    unchanged = 0;
  if (!type) return { doc, applied, unchanged, failed: edits.map((e) => ({ handle: e.handle, op: e.op, reason: "unsupported" as const })) };
  const at = options.now ?? Date.now();
  const live = pageBlocks(doc);
  const byHandle = new Map(snapshots.map((s) => [s.handle, s]));

  // Each edit with its block; one replace or delete per block.
  const planned: { edit: PageEdit; block: PageBlock; order: number }[] = [];
  const changing = new Set<string>();
  edits.forEach((edit, order) => {
    const snap = byHandle.get(edit.handle);
    const block = snap ? locate(live, snap) : null;
    if (!block || block === "changed") return void failed.push({ handle: edit.handle, op: edit.op, reason: block === "changed" ? "changed" : "not-found" });
    if (edit.op === "replace" || edit.op === "delete") {
      if (changing.has(edit.handle)) return void failed.push({ handle: edit.handle, op: edit.op, reason: "duplicate" });
      changing.add(edit.handle);
    }
    planned.push({ edit, block, order });
  });
  // From the end of the document; at one block: after, then the block, then before.
  const rank: Record<PageEditOp, number> = { insert_after: 0, replace: 1, delete: 1, insert_before: 2 };
  planned.sort((x, y) => y.block.pos - x.block.pos || rank[x.edit.op] - rank[y.edit.op] || y.order - x.order);

  for (const { edit, block } of planned) {
    const attrs: SuggestionAttrs = { id: (options.newId || randomId)(), kind: "insert", author: options.author.id, name: options.author.name, at };
    const insertMark = type.create(attrs);
    const deleteMark = type.create({ ...attrs, kind: "delete" });
    const pos = tr.mapping.map(block.pos);
    const node = tr.doc.nodeAt(pos);
    if (!node || node.type.name !== block.type) {
      failed.push({ handle: edit.handle, op: edit.op, reason: "changed" });
      continue;
    }
    const before = tr.steps.length;
    // Marks every text of new blocks as inserted.
    const markInserted = (fragment: Fragment, parent?: PMNode): Fragment => {
      const out: PMNode[] = [];
      fragment.forEach((child) => {
        if (child.isText) {
          const text = child.text!.replaceAll(OBJECT, "");
          if (!text) return;
          const allowed = !parent || parent.type.allowsMarkType(type);
          out.push(schema.text(text, allowed ? insertMark.addToSet(child.marks) : child.marks));
        } else if (child.isInline) return;
        else out.push(child.copy(markInserted(child.content, child)));
      });
      return Fragment.fromArray(out);
    };
    const markAllDeleted = () => {
      if (node.content.size) tr.addMark(pos + 1, pos + 1 + node.content.size, deleteMark);
    };
    const insertBlocks = (fragment: Fragment, where: "after" | "before") => {
      const blocks = markInserted(contentBlocks(fragment));
      if (!blocks.childCount) return false;
      const $pos = tr.doc.resolve(pos);
      const d = $pos.depth;
      // Next to the item for list items; next to the whole list or table otherwise.
      let itemDepth = 0,
        outer = d + 1;
      for (let k = d; k >= 1; k--) {
        const name = $pos.node(k).type.name;
        if (ITEMS.has(name) && !itemDepth) itemDepth = k;
        if (LISTS.has(name) || ITEMS.has(name) || name === "table") outer = k;
      }
      if (itemDepth && blocks.childCount === 1 && LISTS.has(blocks.firstChild!.type.name)) {
        const parent = $pos.node(itemDepth - 1);
        const index = $pos.index(itemDepth - 1) + (where === "after" ? 1 : 0);
        if (parent.canReplace(index, index, blocks.firstChild!.content)) {
          tr.insert(where === "after" ? $pos.after(itemDepth) : $pos.before(itemDepth), blocks.firstChild!.content);
          return true;
        }
      }
      for (let depth = outer; depth >= 1; depth--) {
        const parent = $pos.node(depth - 1);
        const index = $pos.index(depth - 1) + (where === "after" ? 1 : 0);
        if (!parent.canReplace(index, index, blocks)) continue;
        const at = depth === d + 1 ? (where === "after" ? pos + node.nodeSize : pos) : where === "after" ? $pos.after(depth) : $pos.before(depth);
        tr.insert(at, blocks);
        return true;
      }
      return false;
    };
    // The block's text changed word by word (code line by line).
    const replaceText = (next: string, slice: (from: number, to: number) => Fragment, unit: "words" | "lines") => {
      const current = blockText(node);
      const hunks = diffHunks(current, next, unit);
      for (const hunk of [...hunks].reverse()) {
        if (hunk.newTo > hunk.newFrom) {
          const content = markInserted(slice(hunk.newFrom, hunk.newTo), node);
          if (content.size) tr.insert(pos + 1 + hunk.oldTo, content);
        }
        if (hunk.oldTo > hunk.oldFrom) tr.addMark(pos + 1 + hunk.oldFrom, pos + 1 + hunk.oldTo, deleteMark);
      }
    };

    try {
      if (edit.op === "delete") {
        if (!node.content.size) {
          failed.push({ handle: edit.handle, op: edit.op, reason: "empty" });
          continue;
        }
        markAllDeleted();
      } else if (edit.op === "insert_after" || edit.op === "insert_before") {
        if (!insertBlocks(options.parse(edit.content.replace(/⟨[^⟩\n]{0,60}⟩/g, "")), edit.op === "insert_after" ? "after" : "before")) {
          failed.push({ handle: edit.handle, op: edit.op, reason: edit.content.trim() ? "unsupported" : "empty" });
          continue;
        }
      } else if (node.type.name === "codeBlock") {
        const code = codeOf(edit.content);
        replaceText(code, (from, to) => (to > from ? Fragment.from(schema.text(code.slice(from, to))) : Fragment.empty), "lines");
      } else {
        // Objects the model kept (⟨@Ada⟩) stay where they are.
        const parsed = contentBlocks(options.parse(edit.content.replace(/⟨[^⟩\n]{0,60}⟩/g, OBJECT)));
        if (!parsed.childCount) markAllDeleted();
        else {
          const single = singleTextblock(parsed);
          if (single && (single.type === node.type || single.type.name === "paragraph")) {
            const next = blockText(single);
            replaceText(next, (from, to) => single.content.cut(from, to), "words");
          } else {
            // Other blocks: the new ones below, the old text marked as deleted.
            if (!insertBlocks(parsed, "after")) {
              failed.push({ handle: edit.handle, op: edit.op, reason: "unsupported" });
              continue;
            }
            markAllDeleted();
          }
        }
      }
    } catch {
      failed.push({ handle: edit.handle, op: edit.op, reason: "unsupported" });
      continue;
    }
    if (tr.steps.length > before) applied++;
    else unchanged++;
  }
  return { doc: tr.doc, applied, unchanged, failed };
}

// Marks of a suggestion in a document, for tests and summaries.
export const suggestionMarks = (node: PMNode): Mark[] => node.marks.filter((m) => m.type.name === "suggestion");
