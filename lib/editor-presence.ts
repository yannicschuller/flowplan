import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { requirePage, pageRole } from "./permissions";
import {
  cursorRequestSchema,
  CURSOR_LEASE_MS,
  type CursorPeer,
} from "./cursor-protocol";
import type { Identity } from "./types";
import { documentKey } from "./document-live";
import { presencePrefix, setTextPresence, textPeers } from "./text-presence";
import { filterAsync } from "./each-async";

// Tombstones outlive a lease so a delayed request cannot resurrect a departed tab.
const RETENTION_MS = 300_000;

// The editor's live channel closed (the tab went, components/editor.tsx:
// its client id is the cursors' one): its cursor goes too. The departure
// the tab sends itself on pagehide (a keepalive request) does not always
// arrive – Chromium loses it now and then while a service worker controls
// the page – and the others then saw the cursor until its lease ran out.
// The sequence stays: a request of the same tab, should it still be there
// (a live channel that only reconnects), shows the cursor again. Returns
// the document's key and the cursor's id when a cursor went, for the
// others to hear about it.
export async function editorLeft(sessionToken: string, clientId: string) {
  const row = await one<{ id: string; page_id: string; row_id: string | null; generation: string; cursor: string | null }>(
    "SELECT id,page_id,row_id,generation,cursor FROM editor_presence WHERE session_token=? AND client_id=?",
    sessionToken,
    clientId,
  );
  if (!row) return null;
  const textGone = setTextPresence(presencePrefix(row.page_id, row.row_id), { id: clientId, text: null });
  if (row.cursor === null && !textGone) return null;
  if (row.cursor !== null)
    await run("UPDATE editor_presence SET cursor=NULL WHERE session_token=? AND client_id=?", sessionToken, clientId);
  return { key: documentKey(row.page_id, row.row_id, row.generation), id: row.id };
}
export async function editorPresence(
  user: Identity,
  sessionToken: string,
  input: unknown,
  now = Date.now(),
) {
  const data = cursorRequestSchema.parse(input);
  const session = await one<{ user_id: string }>(
    "SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0",
    sessionToken,
    now,
  );
  if (session?.user_id !== user.id)
    throw new HttpError(401, "Bitte melde dich an.");
  const page = await requirePage(user, data.pageId);
  const document = data.rowId
    ? (await one<{ generation: string }>(
        "SELECT d.generation FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.id=? AND r.page_id=?",
        data.rowId,
        page.id,
      ))
    : page.kind === "document"
      ? (await one<{ generation: string }>(
          "SELECT generation FROM documents WHERE page_id=?",
          page.id,
        ))
      : undefined;
  if (!document) throw new HttpError(404, "Dokument nicht gefunden.");
  if (document.generation !== data.generation)
    throw new HttpError(409, "Neue Dokumentversion verfügbar.");
  await run("DELETE FROM editor_presence WHERE seen<?", now - RETENTION_MS);
  const previous = await one<{
    id: string;
    page_id: string;
    row_id: string | null;
    generation: string;
    seen: number;
    cursor: string | null;
    sequence: number;
  }>(
    "SELECT id,page_id,row_id,generation,seen,cursor,sequence FROM editor_presence WHERE session_token=? AND client_id=?",
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
      (await one<{ n: number }>(
        "SELECT count(*) n FROM editor_presence WHERE session_token=?",
        sessionToken,
      ))?.n,
    ) >= 128
  )
    throw new HttpError(429, "Zu viele aktive Dokumentinstanzen.");
  const presenceId = previous?.id ?? id();
  await run(
    `INSERT INTO editor_presence(id,session_token,client_id,page_id,row_id,generation,sequence,cursor,seen) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_token,client_id) DO UPDATE SET sequence=excluded.sequence,cursor=excluded.cursor,seen=excluded.seen
    WHERE excluded.sequence>editor_presence.sequence`,
    presenceId,
    sessionToken,
    data.clientId,
    page.id,
    data.rowId || null,
    data.generation,
    data.sequence,
    data.cursor ? JSON.stringify(data.cursor) : null,
    now,
  );
  const peers = await all<{
    id: string;
    user_id: string;
    name: string;
    cursor: string;
    seen: number;
  }>(
    `SELECT p.id,s.user_id,u.name,p.cursor,p.seen FROM editor_presence p
     JOIN sessions s ON s.token=p.session_token JOIN users u ON u.id=s.user_id
     WHERE p.page_id=? AND p.row_id IS NOT DISTINCT FROM ? AND p.generation=? AND p.cursor IS NOT NULL AND p.seen>?
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
  // Guests on share links see members by text address, members see guests.
  const prefix = presencePrefix(page.id, data.rowId);
  const textChanged =
    data.sequence > (previous?.sequence ?? -1) &&
    setTextPresence(
      prefix,
      data.cursor && data.text
        ? { id: data.clientId, userId: user.id, name: user.name.slice(0, 100), text: data.text, source: "member" }
        : { id: data.clientId, text: null },
    );
  const guests = textPeers(prefix, data.clientId, "guest");
  const accepted = data.sequence > (previous?.sequence ?? -1);
  return {
    // What the others' editors draw of this cursor (lib/document-live.ts
    // publishCursor()): every accepted update – a heartbeat renews the
    // lease there; null when the cursor went (or was not there).
    peer: !accepted
      ? undefined
      : data.cursor
        ? ({ id: presenceId, userId: user.id, name: user.name.slice(0, 100), cursor: data.cursor, expiresInMs: CURSOR_LEASE_MS } satisfies CursorPeer)
        : previous?.cursor
          ? { id: presenceId, cursor: null }
          : undefined,
    // The text address changed: the guests of share links ask again.
    textChanged,
    key: documentKey(page.id, data.rowId, data.generation),
    clientId: data.clientId,
    peers: [
      ...guests,
      ...(await filterAsync(peers, async (p) => await pageRole({ ...user, id: p.user_id }, page)))
      .map((p): CursorPeer => ({
        id: p.id,
        userId: p.user_id,
        name: p.name.slice(0, 100),
        cursor: JSON.parse(p.cursor),
        expiresInMs: Math.max(0, p.seen + CURSOR_LEASE_MS - now),
      })),
    ],
  };
}
