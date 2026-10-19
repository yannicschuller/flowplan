// "Wer hat was geschrieben": every character of a Yjs document carries the
// id of the editor session (Yjs client) that typed it. The server notes which
// person each client belongs to when it stores their changes
// (lib/document-authors.ts); here the text is split into runs per client and
// mapped onto ProseMirror positions. Text from sessions the server never
// recorded (before this was tracked, imports, restored versions) has no
// author: it is shown as "früher". Client-safe; changes nothing in the
// document.
import * as Y from "yjs";
import type { Node as PMNode } from "@tiptap/pm/model";

export type AuthorRun = { from: number; to: number; client: number };
export type AuthorRange = { from: number; to: number; userId: string | null };
type Mapping = Map<Y.AbstractType<unknown>, PMNode | PMNode[]>;
type ItemLike = {
  deleted: boolean;
  countable: boolean;
  length: number;
  id: { client: number };
  right: ItemLike | null;
};

// Runs of text per client, in document order (adjacent runs of the same
// client merged). Elements are found through the binding's mapping; a part
// that cannot be matched is skipped rather than guessed.
export function authorRuns(fragment: Y.XmlFragment, doc: PMNode, mapping: Mapping): AuthorRun[] {
  const positions = new Map<PMNode, number>();
  doc.descendants((node, pos) => {
    if (!node.isText) positions.set(node, pos);
  });
  const runs: AuthorRun[] = [];
  const push = (from: number, to: number, client: number) => {
    const last = runs[runs.length - 1];
    if (last && last.client === client && last.to === from) last.to = to;
    else runs.push({ from, to, client });
  };
  const walk = (parent: Y.XmlFragment | Y.XmlElement, contentStart: number, depth: number) => {
    if (depth > 200) return;
    let pos = contentStart;
    for (const child of parent.toArray()) {
      if (child instanceof Y.XmlText) {
        let item = (child as unknown as { _start: ItemLike | null })._start,
          offset = 0;
        while (item) {
          if (!item.deleted && item.countable) {
            push(pos + offset, pos + offset + item.length, item.id.client);
            offset += item.length;
          }
          item = item.right;
        }
        pos += offset;
      } else if (child instanceof Y.XmlElement) {
        const node = mapping.get(child as Y.AbstractType<unknown>);
        const at = node && !Array.isArray(node) ? positions.get(node) : undefined;
        if (node === undefined || Array.isArray(node) || at === undefined) continue;
        if (!node.isLeaf) walk(child, at + 1, depth + 1);
        pos = at + node.nodeSize;
      }
    }
  };
  walk(fragment, 0, 0);
  return runs;
}

// Runs as ranges per person; unknown clients are null ("früher"). The
// editor's own, not yet stored session counts as `self`.
export function attributeRuns(
  runs: AuthorRun[],
  clients: Record<string, string>,
  self?: { client: number; userId: string },
): AuthorRange[] {
  const ranges: AuthorRange[] = [];
  for (const run of runs) {
    const userId = clients[run.client] ?? (self && run.client === self.client ? self.userId : null);
    const last = ranges[ranges.length - 1];
    if (last && last.userId === userId && last.to === run.from) last.to = run.to;
    else ranges.push({ from: run.from, to: run.to, userId });
  }
  return ranges;
}

// Characters per person (null: "früher"), most first.
export function authorShares(ranges: AuthorRange[]) {
  const totals = new Map<string | null, number>();
  for (const r of ranges) totals.set(r.userId, (totals.get(r.userId) || 0) + (r.to - r.from));
  return [...totals].sort((a, b) => b[1] - a[1]);
}

// A stable colour per person: the same hue on every device and in every
// document, light enough as a background in both themes.
export function authorHue(userId: string) {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Golden-angle steps spread neighbouring hashes over the circle.
  return Math.round(((hash >>> 0) % 360) * 137.508) % 360;
}
export const authorColor = (userId: string, alpha = 0.3) => `hsl(${authorHue(userId)} 80% 55% / ${alpha})`;

// The clients whose clock moved between two state vectors: the sessions
// whose changes an update brought.
export function changedClients(before: Uint8Array, after: Uint8Array) {
  const a = Y.decodeStateVector(before),
    b = Y.decodeStateVector(after);
  return [...b].filter(([client, clock]) => clock > (a.get(client) || 0)).map(([client]) => client);
}
