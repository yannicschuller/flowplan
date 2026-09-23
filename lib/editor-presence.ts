import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { requirePage, pageRole } from "./permissions";
import {
  cursorRequestSchema,
  CURSOR_LEASE_MS,
  type CursorPeer,
} from "./cursor-protocol";
import type { Identity } from "./types";

// Tombstones outlive a lease so a delayed request cannot resurrect a departed tab.
const RETENTION_MS = 300_000;
export function editorPresence(
  user: Identity,
  sessionToken: string,
  input: unknown,
  now = Date.now(),
) {
  const data = cursorRequestSchema.parse(input);
  const session = one<{ user_id: string }>(
    "SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0",
    sessionToken,
    now,
  );
  if (session?.user_id !== user.id)
    throw new HttpError(401, "Bitte melde dich an.");
  const page = requirePage(user, data.pageId);
  const document = data.rowId
    ? one<{ generation: string }>(
        "SELECT d.generation FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.id=? AND r.page_id=?",
        data.rowId,
        page.id,
      )
    : page.kind === "document"
      ? one<{ generation: string }>(
          "SELECT generation FROM documents WHERE page_id=?",
          page.id,
        )
      : undefined;
  if (!document) throw new HttpError(404, "Dokument nicht gefunden.");
  if (document.generation !== data.generation)
    throw new HttpError(409, "Neue Dokumentversion verfügbar.");
  run("DELETE FROM editor_presence WHERE seen<?", now - RETENTION_MS);
  const previous = one<{
    page_id: string;
    row_id: string | null;
    generation: string;
    seen: number;
  }>(
    "SELECT page_id,row_id,generation,seen FROM editor_presence WHERE session_token=? AND client_id=?",
    sessionToken,
    data.clientId,
  );
  if (
    previous &&
    (previous.page_id !== page.id ||
      previous.row_id !== (data.rowId || null) ||
      previous.generation !== data.generation)
  )
    throw new HttpError(
      409,
      "Diese Cursorinstanz gehört zu einem anderen Dokument.",
    );
  if (
    !previous &&
    Number(
      one<{ n: number }>(
        "SELECT count(*) n FROM editor_presence WHERE session_token=?",
        sessionToken,
      )?.n,
    ) >= 128
  )
    throw new HttpError(429, "Zu viele aktive Dokumentinstanzen.");
  run(
    `INSERT INTO editor_presence(id,session_token,client_id,page_id,row_id,generation,sequence,cursor,seen) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_token,client_id) DO UPDATE SET sequence=excluded.sequence,cursor=excluded.cursor,seen=excluded.seen
    WHERE excluded.sequence>editor_presence.sequence`,
    id(),
    sessionToken,
    data.clientId,
    page.id,
    data.rowId || null,
    data.generation,
    data.sequence,
    data.cursor ? JSON.stringify(data.cursor) : null,
    now,
  );
  const peers = all<{
    id: string;
    user_id: string;
    name: string;
    cursor: string;
    seen: number;
  }>(
    `SELECT p.id,s.user_id,u.name,p.cursor,p.seen FROM editor_presence p
     JOIN sessions s ON s.token=p.session_token JOIN users u ON u.id=s.user_id
     WHERE p.page_id=? AND p.row_id IS ? AND p.generation=? AND p.cursor IS NOT NULL AND p.seen>?
       AND s.expires>? AND u.disabled=0 AND NOT(p.session_token=? AND p.client_id=?)
     ORDER BY p.seen DESC LIMIT 200`,
    page.id,
    data.rowId || null,
    data.generation,
    now - CURSOR_LEASE_MS,
    now,
    sessionToken,
    data.clientId,
  );
  return {
    peers: peers
      .filter((p) => pageRole({ ...user, id: p.user_id }, page))
      .map((p): CursorPeer => ({
        id: p.id,
        userId: p.user_id,
        name: p.name.slice(0, 100),
        cursor: JSON.parse(p.cursor),
        expiresInMs: Math.max(0, p.seen + CURSOR_LEASE_MS - now),
      })),
  };
}
