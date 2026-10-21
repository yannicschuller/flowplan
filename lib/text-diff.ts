// Myers diff (O((N+M)·D)) over arbitrary token arrays. Versions of a page are
// usually similar, so D stays small even for long documents.
export type DiffOp<T> = { type: "same" | "added" | "removed"; value: T };
export const MAX_DIFF_EDITS = 2000;

export function diff<T>(
  a: T[],
  b: T[],
  equal: (x: T, y: T) => boolean = (x, y) => x === y,
): DiffOp<T>[] | null {
  const n = a.length,
    m = b.length,
    max = Math.min(n + m, MAX_DIFF_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  // Each step stores only the diagonals it can reach (k in -d-1..d+1).
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && equal(a[x], b[y])) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, d);
      }
    }
    v = next;
  }
  // Too many differences: callers fall back to a coarser comparison.
  return null;
}
function backtrack<T>(trace: Int32Array[], a: T[], b: T[], depth: number) {
  const ops: DiffOp<T>[] = [];
  let x = a.length,
    y = b.length;
  for (let d = depth; d > 0; d--) {
    const v = trace[d],
      at = (k: number) => v[k + d + 1];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK),
      prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: "same", value: a[x] });
    }
    if (x === prevX) ops.push({ type: "added", value: b[--y] });
    else ops.push({ type: "removed", value: a[--x] });
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ type: "same", value: a[x] });
  }
  return ops.reverse();
}

export type TextPart = { type: "same" | "added" | "removed"; text: string };
export type TextChange =
  | { type: "same" | "added" | "removed"; text: string }
  | { type: "changed"; parts: TextPart[] };

// Words and the whitespace between them, so joining the tokens gives the
// text back unchanged.
export const wordTokens = (text: string) => text.match(/\s+|[^\s]+/g) || [];
export const countWords = (text: string) => (text.match(/\S+/g) || []).length;

// Word-level comparison of two texts; null when they differ too much.
function inlineChange(before: string, after: string): TextPart[] | null {
  const inline = diff(wordTokens(before), wordTokens(after));
  if (!inline) return null;
  const parts: TextPart[] = [];
  for (const part of inline) {
    const last = parts.at(-1);
    if (last?.type === part.type) last.text += part.value;
    else parts.push({ type: part.type, text: part.value });
  }
  return parts;
}

// Paragraph-level comparison; a removed paragraph directly followed by an
// added one is shown as an inline word-level change.
export function compareParagraphs(
  before: string[],
  after: string[],
): TextChange[] | null {
  const ops = diff(before, after);
  if (!ops) return null;
  const changes: TextChange[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i],
      next = ops[i + 1];
    if (op.type === "removed" && next?.type === "added") {
      const parts = inlineChange(op.value, next.value);
      if (parts) {
        changes.push({ type: "changed", parts });
        i++;
        continue;
      }
    }
    changes.push({ type: op.type, text: op.value });
  }
  return changes;
}

// ---- Structured documents ------------------------------------------------

// A block of text with the structure it came from, so a comparison can keep
// headings, list items and table cells apart.
export type BlockKind =
  | "heading"
  | "paragraph"
  | "item"
  | "cell"
  | "quote"
  | "code";
export type TextBlock = { kind: BlockKind; text: string };
export type BlockChange = TextChange & { kind: BlockKind };
export type DocumentDiff = {
  changes: BlockChange[];
  // Words that came in and went out, for the summary line.
  words: { added: number; removed: number };
};
// Documents with more words than this (both sides together) are not
// compared; the version can still be previewed and restored.
export const MAX_DIFF_WORDS = 60_000;
export type DiffLimit = "size" | "edits";

const BLOCK_TAGS: Record<string, BlockKind | "flush"> = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  li: "item",
  td: "cell",
  th: "cell",
  blockquote: "quote",
  pre: "code",
  p: "paragraph",
  div: "paragraph",
  figcaption: "paragraph",
  summary: "paragraph",
  dt: "paragraph",
  dd: "paragraph",
  // Containers without text of their own: they only end the block before.
  tr: "flush",
  table: "flush",
  ul: "flush",
  ol: "flush",
  details: "flush",
  aside: "flush",
  section: "flush",
  article: "flush",
  hr: "flush",
};
const ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
};
export function decodeEntities(text: string) {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, code: string) => {
      if (code[0] === "#") {
        const point =
          code[1] === "x" || code[1] === "X"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    },
  );
}

// Text blocks of stored (sanitised) document HTML with their kind. Text in
// a paragraph inside a list item or table cell belongs to that item or
// cell; a line break starts a new block of the same kind.
export function htmlBlocks(html: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const stack: BlockKind[] = [];
  let text = "";
  const kind = (): BlockKind => {
    for (let i = stack.length - 1; i >= 0; i--)
      if (stack[i] !== "paragraph") return stack[i];
    return "paragraph";
  };
  const flush = () => {
    const clean = decodeEntities(text).replace(/\s+/g, " ").trim();
    if (clean) blocks.push({ kind: kind(), text: clean });
    text = "";
  };
  const source = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let last = 0;
  for (let match = tag.exec(source); match; match = tag.exec(source)) {
    text += source.slice(last, match.index);
    last = match.index + match[0].length;
    const closing = match[1] === "/",
      name = match[2].toLowerCase();
    if (name === "br") {
      flush();
      continue;
    }
    const block = BLOCK_TAGS[name];
    if (!block) continue;
    flush();
    if (block === "flush") continue;
    if (!closing) stack.push(block);
    else {
      const index = stack.lastIndexOf(block);
      if (index >= 0) stack.splice(index);
    }
  }
  text += source.slice(last);
  flush();
  return blocks;
}

// Block-level comparison that keeps the structure: a block only matches a
// block of the same kind. A removed block directly followed by an added one
// of the same kind is shown as an inline word-level change.
export function compareBlocks(
  before: TextBlock[],
  after: TextBlock[],
): DocumentDiff | DiffLimit {
  const total = (blocks: TextBlock[]) =>
    blocks.reduce((sum, b) => sum + countWords(b.text), 0);
  if (total(before) + total(after) > MAX_DIFF_WORDS) return "size";
  const ops = diff(before, after, (x, y) => x.kind === y.kind && x.text === y.text);
  if (!ops) return "edits";
  const changes: BlockChange[] = [];
  const words = { added: 0, removed: 0 };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i],
      next = ops[i + 1];
    if (
      op.type === "removed" &&
      next?.type === "added" &&
      op.value.kind === next.value.kind
    ) {
      const parts = inlineChange(op.value.text, next.value.text);
      if (parts) {
        for (const part of parts) {
          if (part.type === "added") words.added += countWords(part.text);
          if (part.type === "removed") words.removed += countWords(part.text);
        }
        changes.push({ type: "changed", kind: next.value.kind, parts });
        i++;
        continue;
      }
    }
    if (op.type === "added") words.added += countWords(op.value.text);
    if (op.type === "removed") words.removed += countWords(op.value.text);
    changes.push({ type: op.type, kind: op.value.kind, text: op.value.text });
  }
  return { changes, words };
}

// Two versions of a document as stored HTML.
export const compareDocuments = (before: string, after: string) =>
  compareBlocks(htmlBlocks(before), htmlBlocks(after));
