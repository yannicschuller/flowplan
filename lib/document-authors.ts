import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireRow } from "./row-documents";
import { changedClients } from "./authorship";
import type { Identity } from "./types";

// Who wrote what (lib/authorship.ts): when the server stores changes of a
// document, it notes which person the editor sessions (Yjs clients) in them
// belong to – the first person who sends a session's changes keeps it.
// Per document and CRDT generation; a restored version starts over.
export const MAX_DOCUMENT_CLIENTS = 20000;

export function recordDocumentAuthors(
  pageId: string,
  rowId: string | null | undefined,
  generation: string,
  userId: string,
  before: Uint8Array,
  after: Uint8Array,
) {
  const clients = changedClients(before, after);
  if (!clients.length) return 0;
  const row = rowId || "";
  // Earlier generations of this document are over.
  run("DELETE FROM document_authors WHERE page_id=? AND row_id=? AND generation!=?", pageId, row, generation);
  const known = Number(
    one<{ n: number }>("SELECT COUNT(*) n FROM document_authors WHERE page_id=? AND row_id=?", pageId, row)?.n || 0,
  );
  let added = 0;
  for (const client of clients.slice(0, Math.max(0, Math.min(100, MAX_DOCUMENT_CLIENTS - known))))
    added += Number(
      run(
        "INSERT OR IGNORE INTO document_authors(page_id,row_id,generation,client_id,user_id,at) VALUES(?,?,?,?,?,?)",
        pageId,
        row,
        generation,
        client,
        userId,
        Date.now(),
      ).changes,
    );
  return added;
}

// The sessions and names for one document; only for people who may read it.
export function documentAuthors(user: Identity, pageId: string, rowId?: string | null) {
  let generation: string;
  if (rowId) {
    requireRow(user, pageId, rowId);
    generation = one<{ generation: string }>("SELECT generation FROM row_documents WHERE row_id=?", rowId)?.generation || "";
  } else {
    const page = requirePage(user, pageId);
    if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
    generation = one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId)?.generation || "";
  }
  const entries = all<{ client_id: number; user_id: string; name: string }>(
    "SELECT a.client_id,a.user_id,u.name FROM document_authors a JOIN users u ON u.id=a.user_id WHERE a.page_id=? AND a.row_id=? AND a.generation=?",
    pageId,
    rowId || "",
    generation,
  );
  const people = new Map<string, string>();
  for (const e of entries) people.set(e.user_id, e.name);
  return {
    generation,
    clients: Object.fromEntries(entries.map((e) => [String(e.client_id), e.user_id])),
    people: [...people].map(([id, name]) => ({ id, name })),
  };
}
