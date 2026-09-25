import { createHash } from "node:crypto";
import * as Y from "yjs";
import { Node } from "prosemirror-model";
import { updateYFragment } from "y-prosemirror";
import { generateJSON } from "@tiptap/html/server";
import { one, run, id } from "./db";
import { cleanHtml, htmlState, stateHtml } from "./document-server";
import { documentExtensions, documentSchema } from "./document-schema";

// Live editing for guests. Each share link works on its own projection of
// the document (a Yjs document with only what the link may see). Guests
// merge their changes into it like members do; the server checks the
// result and carries it over into the real document as a minimal Yjs
// change, so members see guest edits live and vice versa.
export type LiveEntry = {
  state: Uint8Array;
  source_html: string;
  generation: string;
  pgen: string;
};
export const liveKey = (token: string, pageId: string, rowId = "") =>
  createHash("sha256")
    .update(`${token}\u0000${pageId}\u0000${rowId}`)
    .digest("hex");
export function loadLive(key: string) {
  return one<LiveEntry>(
    "SELECT state,source_html,generation,pgen FROM share_live WHERE key=?",
    key,
  );
}
export function saveLive(key: string, entry: LiveEntry) {
  run(
    `INSERT INTO share_live(key,state,source_html,generation,pgen,updated_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET state=excluded.state,source_html=excluded.source_html,
     generation=excluded.generation,pgen=excluded.pgen,updated_at=excluded.updated_at`,
    key,
    entry.state,
    entry.source_html,
    entry.generation,
    entry.pgen,
    Date.now(),
  );
  // Projections of links nobody used for a month are rebuilt when needed.
  run("DELETE FROM share_live WHERE updated_at<?", Date.now() - 30 * 86400000);
}
// Replaces the content of `doc` with `html`, changing only what differs.
export function applyHtml(doc: Y.Doc, html: string) {
  const node = Node.fromJSON(
    documentSchema(),
    generateJSON(cleanHtml(html) || "<p></p>", documentExtensions),
  );
  doc.transact(() =>
    updateYFragment(doc, doc.getXmlFragment("default"), node, {
      mapping: new Map(),
      isOMark: new Map(),
    }),
  );
}
export function newProjection(html: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return { doc, pgen: id() };
}
export { stateHtml };
