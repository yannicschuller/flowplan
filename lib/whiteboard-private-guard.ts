// The board's normal sync during private mode (lib/whiteboard.ts): changes
// of private writers never enter the shared board, whatever a browser sends,
// and a change that would depend on private content is refused – it could
// not be applied by the others and would carry private content to them.
import type * as Y from "yjs";
import { all } from "./db";
import { HttpError } from "./auth";
import { withoutClients } from "./whiteboard-private-mode";

// Private writers of the running (not yet revealed) session of a board.
export function activePrivateClients(pageId: string) {
  return new Set(
    all<{ client: number }>(
      "SELECT c.client FROM whiteboard_private_clients c JOIN whiteboard_private s ON s.id=c.session_id WHERE c.page_id=? AND s.revealed_at IS NULL",
      pageId,
    ).map((r) => Number(r.client)),
  );
}
export function withoutPrivateChanges(pageId: string, update: Uint8Array) {
  const clients = activePrivateClients(pageId);
  return clients.size ? withoutClients(update, clients) : update;
}
export function assertNoPrivateGap(pageId: string, doc: Y.Doc) {
  const pending = doc.store.pendingStructs;
  if (!pending) return;
  const clients = activePrivateClients(pageId);
  if ([...pending.missing.keys()].some((client) => clients.has(client)))
    throw new HttpError(409, "Diese Änderung hängt an privaten Inhalten und wird erst nach dem Aufdecken gespeichert.");
}
