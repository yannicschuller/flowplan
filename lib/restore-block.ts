// Restoring a single paragraph from an older version: the paragraph is taken
// from the saved version (with its formatting) and either put back after
// the paragraph that preceded it, or – when it was changed since – takes
// the place of the changed paragraph. The live document gets the change
// like an edit by a person.
import { z } from "zod";
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { one } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireRow } from "./row-documents";
import { htmlState, jsonHtml } from "./document-server";
import { htmlBlocks } from "./text-diff";
import { rewriteDocument, rewriteSchema } from "./document-rewrite";
import type { Identity } from "./types";

const input = z.object({
  pageId: z.uuid(),
  rowId: z.uuid().nullish(),
  snapshotId: z.uuid(),
  // The paragraph in the old version, the one before it there, and – for a
  // changed paragraph – its current text.
  text: z.string().min(1).max(20000),
  after: z.string().max(20000).nullish(),
  replace: z.string().max(20000).nullish(),
});

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function docOf(state: Uint8Array | null, html: string) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state || htmlState(html));
  const doc = PMNode.fromJSON(rewriteSchema(), yDocToProsemirrorJSON(ydoc, "default"));
  ydoc.destroy();
  return doc;
}
// The text blocks (paragraph, heading …) in order, with their text as the
// comparison (lib/text-diff.ts) shows it: split at line breaks, with the
// text of formulas and mentions – which ProseMirror's textContent lacks.
type Found = { node: PMNode; pos: number; lines: string[] };
function textBlocks(doc: PMNode) {
  const found: Found[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let plain = true;
    node.forEach((child) => {
      if (!child.isText) plain = false;
    });
    const lines = plain
      ? [norm(node.textContent)].filter(Boolean)
      : htmlBlocks(jsonHtml({ type: "doc", content: [node.toJSON()] })).map((block) => block.text);
    found.push({ node, pos, lines });
    return false;
  });
  return found;
}
const has = (block: Found, text: string) => block.lines.includes(norm(text));
const LIST_ITEMS = new Set(["listItem", "taskItem"]);

export async function restoreBlock(user: Identity, raw: unknown) {
  const b = input.parse(raw);
  const page = await requirePage(user, b.pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if (b.rowId) await requireRow(user, page.id, b.rowId, true);
  else if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  const snapshot = b.rowId
    ? (await one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM row_snapshots WHERE id=? AND row_id=?", b.snapshotId, b.rowId))
    : (await one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM snapshots WHERE id=? AND page_id=?", b.snapshotId, page.id));
  if (!snapshot) throw new HttpError(404, "Version nicht gefunden.");
  const oldDoc = docOf(snapshot.state, snapshot.html || "");
  const oldBlocks = textBlocks(oldDoc);
  // The old block: with an old neighbour, the first one after it.
  const candidates = oldBlocks.map((block, index) => ({ block, index })).filter(({ block }) => has(block, b.text));
  const before = (index: number) => oldBlocks.slice(0, index).filter((block) => b.after && has(block, b.after)).length;
  const chosen = candidates.find(({ index }) => !b.after || before(index) > 0) ?? candidates[0];
  if (!chosen) throw new HttpError(404, "Der Absatz steht nicht in dieser Version.");
  const old = chosen.block;
  // The neighbour is a line of the same paragraph (split at a line break):
  // the paragraph takes the place of what is left of it.
  const sameBlock = !!b.after && old.lines.indexOf(norm(b.after)) >= 0 && old.lines.indexOf(norm(b.after)) < old.lines.indexOf(norm(b.text));
  // Which of several blocks with the neighbour's text it was.
  const occurrence = Math.max(0, before(chosen.index) - 1);
  const $old = oldDoc.resolve(old.pos);
  const schema = rewriteSchema();
  const block = schema.nodeFromJSON(old.node.toJSON());
  // A list item's text comes back as a list item (with its checkbox state).
  const item = LIST_ITEMS.has($old.parent.type.name) && $old.index() === 0 && $old.depth > 1 ? $old.parent : null;
  const list = item ? $old.node($old.depth - 1) : null;
  const result = await rewriteDocument(page.id, b.rowId || null, user.id, (doc) => {
    const tr = new Transform(doc);
    const blocks = textBlocks(doc);
    const current = b.replace ? blocks.find((found) => has(found, b.replace!)) : null;
    const anchors = b.after ? blocks.filter((found) => has(found, b.after!)) : [];
    const anchor = anchors[Math.min(occurrence, anchors.length - 1)];
    if (current) tr.replaceWith(current.pos, current.pos + current.node.nodeSize, block);
    else if (anchor && sameBlock) tr.replaceWith(anchor.pos, anchor.pos + anchor.node.nodeSize, block);
    else if (!anchor) {
      // Without its old neighbour at the start, or at the end when the
      // neighbour is gone too.
      const at = b.after ? doc.content.size : 0;
      tr.insert(at, item && list ? schema.nodeFromJSON({ ...list.toJSON(), content: [{ ...item.toJSON(), content: [old.node.toJSON()] }] }) : block);
    } else {
      const $anchor = doc.resolve(anchor.pos);
      const after = (depth: number) => (depth === $anchor.depth ? anchor.pos + anchor.node.nodeSize : $anchor.after(depth + 1));
      let placed = false;
      if (item && list) {
        // After the neighbour's own item, in a list of the same kind.
        const restored = schema.nodeFromJSON({ ...item.toJSON(), content: [old.node.toJSON()] });
        for (let depth = $anchor.depth - 1; depth >= 0 && !placed; depth--)
          if ($anchor.node(depth).type.name === list.type.name) {
            tr.insert(after(depth), restored);
            placed = true;
          }
        if (!placed) {
          tr.insert(anchor.pos + anchor.node.nodeSize, schema.nodeFromJSON({ ...list.toJSON(), content: [restored.toJSON()] }));
          placed = true;
        }
      }
      // After the neighbour, at most as deep as the block was: a paragraph
      // that followed a list goes after the list, not into its last item.
      for (let depth = Math.min($anchor.depth, $old.depth); depth >= 0 && !placed; depth--) {
        const index = $anchor.index(depth);
        if ($anchor.node(depth).canReplaceWith(index + 1, index + 1, block.type)) {
          tr.insert(after(depth), block);
          placed = true;
        }
      }
      if (!placed) tr.insert(anchor.pos + anchor.node.nodeSize, block);
    }
    return tr.doc;
  });
  return result?.publish ?? (() => {});
}
