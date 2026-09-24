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

export type TextChange =
  | { type: "same" | "added" | "removed"; text: string }
  | {
      type: "changed";
      parts: { type: "same" | "added" | "removed"; text: string }[];
    };
const words = (text: string) => text.match(/\s+|[^\s]+/g) || [];
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
      const inline = diff(words(op.value), words(next.value));
      if (inline) {
        const parts: { type: "same" | "added" | "removed"; text: string }[] =
          [];
        for (const part of inline) {
          const last = parts.at(-1);
          if (last?.type === part.type) last.text += part.value;
          else parts.push({ type: part.type, text: part.value });
        }
        changes.push({ type: "changed", parts });
        i++;
        continue;
      }
    }
    changes.push({ type: op.type, text: op.value });
  }
  return changes;
}
