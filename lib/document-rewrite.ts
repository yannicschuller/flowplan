// Changes a stored document on the server (page or record document): the
// change is merged into its Yjs state as a diff, saved, and sent to open
// editors, like an edit by a person.
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { one, run } from "./db";
import { documentSchema } from "./document-schema";
import { htmlState, stateHtml } from "./document-server";
import { documentKey, documentChanged, publishDocumentUpdate } from "./document-live";
import { HttpError } from "./auth";

let cachedSchema: ReturnType<typeof documentSchema> | undefined;
export const rewriteSchema = () => (cachedSchema ??= documentSchema());

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
