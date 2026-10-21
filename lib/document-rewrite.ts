// Changes a stored document on the server (page or record document): the
// change is merged into its Yjs state as a diff, saved, and sent to open
// editors, like an edit by a person.
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { one, run } from "./db";
import { documentSchema } from "./document-schema";
import { htmlState, stateHtml } from "./document-server";
import { documentKey, documentChanged, publishDocumentUpdate } from "./document-live";
import { HttpError } from "./auth";

let cachedSchema: ReturnType<typeof documentSchema> | undefined;
export const rewriteSchema = () => (cachedSchema ??= documentSchema());

/**
 * Passes every string attribute of nodes and marks (image sources, link
 * targets, attachments …) through `replace`; returns the changed document
 * or null when nothing changed. Attribute changes keep every position, so
 * text comments and other anchors stay where they are.
 */
export function rewriteReferences(doc: PMNode, replace: (value: string) => string): PMNode | null {
  type Attrs = Record<string, unknown>;
  const changed = (attrs: Attrs): Attrs | null => {
    let next: Attrs | null = null;
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value !== "string" || !value) continue;
      const replaced = replace(value);
      if (replaced !== value) (next ??= { ...attrs })[key] = replaced;
    }
    return next;
  };
  const nodes: { pos: number; attrs: Attrs }[] = [];
  const marks: { from: number; to: number; mark: PMNode["marks"][number]; attrs: Attrs }[] = [];
  doc.descendants((node, pos) => {
    const attrs = changed(node.attrs);
    if (attrs) nodes.push({ pos, attrs });
    for (const mark of node.marks) {
      const next = changed(mark.attrs);
      if (next) marks.push({ from: pos, to: pos + node.nodeSize, mark, attrs: next });
    }
    return true;
  });
  if (!nodes.length && !marks.length) return null;
  const tr = new Transform(doc);
  for (const { pos, attrs } of nodes) tr.setNodeMarkup(pos, undefined, attrs);
  for (const { from, to, mark, attrs } of marks) tr.removeMark(from, to, mark).addMark(from, to, mark.type.create(attrs));
  return tr.doc;
}

/**
 * Applies `change` to a stored document (its Yjs state, or the HTML when
 * there is none) without touching the database: for versions and other
 * copies kept beside the live document. Null when nothing changed.
 */
export function rewriteStoredDocument(
  state: Uint8Array | null,
  html: string,
  change: (doc: PMNode) => PMNode | null,
): { state: Uint8Array; html: string } | null {
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, state || htmlState(html));
    const next = change(PMNode.fromJSON(rewriteSchema(), yDocToProsemirrorJSON(ydoc, "default")));
    if (!next) return null;
    ydoc.transact(() => updateYFragment(ydoc, ydoc.getXmlFragment("default"), next, { mapping: new Map(), isOMark: new Map() }));
    return { state: Y.encodeStateAsUpdate(ydoc), html: stateHtml(ydoc) };
  } finally {
    ydoc.destroy();
  }
}

export function rewriteDocument(
  pageId: string,
  rowId: string | null,
  userId: string,
  change: (doc: PMNode) => PMNode | null,
) {
  const stored = rowId
    ? one<{ state: Uint8Array | null; html: string; generation: string }>(
        "SELECT state,html,generation FROM row_documents WHERE row_id=?",
        rowId,
      )
    : one<{ state: Uint8Array | null; html: string; generation: string }>(
        "SELECT state,html,generation FROM documents WHERE page_id=?",
        pageId,
      );
  if (!stored) throw new HttpError(404, "Dokument nicht gefunden.");
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, stored.state || htmlState(stored.html));
  const before = Y.encodeStateVector(ydoc);
  const doc = PMNode.fromJSON(rewriteSchema(), yDocToProsemirrorJSON(ydoc, "default"));
  const next = change(doc);
  if (!next) {
    ydoc.destroy();
    return null;
  }
  ydoc.transact(() =>
    updateYFragment(ydoc, ydoc.getXmlFragment("default"), next, {
      mapping: new Map(),
      isOMark: new Map(),
    }),
  );
  const state = Y.encodeStateAsUpdate(ydoc);
  const html = stateHtml(ydoc);
  if (rowId) {
    run("UPDATE row_documents SET state=?,html=?,updated_at=CURRENT_TIMESTAMP WHERE row_id=?", state, html, rowId);
    run("UPDATE rows SET content=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?", html, userId, rowId);
  } else {
    run("UPDATE documents SET state=?,html=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?", state, html, pageId);
    run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
  }
  const update = Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString("base64");
  const key = documentKey(pageId, rowId, stored.generation);
  return {
    ydoc,
    // Run after the transaction: open editors merge the change.
    publish: () => {
      publishDocumentUpdate(key, update);
      documentChanged(pageId, rowId);
      ydoc.destroy();
    },
  };
}
