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
import { htmlState } from "./document-server";
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
// The text block (paragraph, heading …) with this text, and where it is.
function findBlock(doc: PMNode, text: string) {
  const wanted = norm(text);
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isTextblock && norm(node.textContent) === wanted) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found as { node: PMNode; pos: number } | null;
}

export function restoreBlock(user: Identity, raw: unknown) {
  const b = input.parse(raw);
  const page = requirePage(user, b.pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if (b.rowId) requireRow(user, page.id, b.rowId, true);
  else if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  const snapshot = b.rowId
    ? one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM row_snapshots WHERE id=? AND row_id=?", b.snapshotId, b.rowId)
    : one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM snapshots WHERE id=? AND page_id=?", b.snapshotId, page.id);
  if (!snapshot) throw new HttpError(404, "Version nicht gefunden.");
  const old = findBlock(docOf(snapshot.state, snapshot.html || ""), b.text);
  if (!old) throw new HttpError(404, "Der Absatz steht nicht in dieser Version.");
  const block = rewriteSchema().nodeFromJSON(old.node.toJSON());
  const result = rewriteDocument(page.id, b.rowId || null, user.id, (doc) => {
    const tr = new Transform(doc);
    const current = b.replace ? findBlock(doc, b.replace) : null;
    if (current) tr.replaceWith(current.pos, current.pos + current.node.nodeSize, block);
    else {
      const anchor = b.after ? findBlock(doc, b.after) : null;
      // After its old neighbour; without one at the start, or at the end
      // when the neighbour is gone too.
      const at = anchor ? anchor.pos + anchor.node.nodeSize : b.after ? doc.content.size : 0;
      tr.insert(at, block);
    }
    return tr.doc;
  });
  return result?.publish ?? (() => {});
}
