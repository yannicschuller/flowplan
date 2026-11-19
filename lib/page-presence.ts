// Who has a page open (the faces in the page's header, `present` of the
// page's answer): whoever asked for the page within the last PRESENT_MS.
//
// Kept in memory (#383): every page GET – the 10 s refresh of each open tab
// among them – wrote this to the database before, a write with its WAL
// commit that also emptied the read memo of every request in flight
// (lib/read-memo.ts). Presence is short-lived and needs no history.
//
// Cluster mode (several instances on one PostgreSQL): what this instance
// saw stays in memory as well, and is written to the `presence` table at
// most every WRITE_EVERY ms per person and page, so the others see it; the
// table is read alongside. A single instance never touches the table.
import { all, noteNamesRead, noteNamesWritten, run, sql } from "./db";
import { keepUntil } from "./read-memo";
import { clusterMode } from "./cluster/config";

export const PRESENT_MS = 45_000;
const WRITE_EVERY = 15_000;

type Seen = Map<string, number>; // user id → last request (ms)
const runtime = globalThis as { flowplanPagePresence?: Map<string, Seen>; flowplanPresenceWritten?: Map<string, number> };
const seenByPage = () => (runtime.flowplanPagePresence ??= new Map());
const written = () => (runtime.flowplanPresenceWritten ??= new Map());

// Drops what is older than the window (all pages now and then).
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < PRESENT_MS) return;
  lastSweep = now;
  for (const [page, seen] of seenByPage()) {
    for (const [user, at] of seen) if (now - at > PRESENT_MS) seen.delete(user);
    if (!seen.size) seenByPage().delete(page);
  }
  for (const [key, at] of written()) if (now - at > PRESENT_MS) written().delete(key);
}

// The person asked for the page now.
export async function notePresence(pageId: string, userId: string, now = Date.now()) {
  sweep(now);
  const seen = seenByPage().get(pageId) ?? seenByPage().set(pageId, new Map()).get(pageId)!;
  const before = seen.get(userId);
  seen.set(userId, now);
  // Someone new on the page: kept answers of the page are outdated
  // (lib/kept-answers.ts); a renewal changes nothing they show.
  if (before === undefined || now - before > PRESENT_MS) noteNamesWritten([presenceName(pageId)]);
  if (!clusterMode()) return;
  const key = `${pageId}\u0000${userId}`;
  const last = written().get(key);
  if (last !== undefined && now - last < WRITE_EVERY) return;
  written().set(key, now);
  await run(
    "INSERT INTO presence VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET seen=excluded.seen",
    pageId,
    userId,
    now,
  );
}

// Who asked for the page within the window: id and name, by id.
// `viewer`: who asks – their own presence is renewed by their own requests.
export async function pagePresence(pageId: string, now = Date.now(), viewer?: string): Promise<{ id: string; name: string }[]> {
  const since = now - PRESENT_MS;
  const ids = new Set<string>();
  // A kept answer of the page (lib/kept-answers.ts) lasts while the same
  // people are here: until someone new comes or the first of the others
  // drops out.
  noteNamesRead([presenceName(pageId)]);
  let first = Infinity;
  for (const [user, at] of seenByPage().get(pageId) ?? [])
    if (at > since) {
      ids.add(user);
      if (user !== viewer) first = Math.min(first, at);
    }
  if (first !== Infinity) keepUntil(first + PRESENT_MS);
  if (clusterMode())
    for (const r of await all<{ user_id: string }>("SELECT user_id FROM presence WHERE page_id=? AND seen>?", pageId, since))
      ids.add(r.user_id);
  if (!ids.size) return [];
  return await all<{ id: string; name: string }>(
    `SELECT id,name FROM users WHERE id IN ${sql.jsonValues()} ORDER BY id`,
    JSON.stringify([...ids]),
  );
}

// A deleted page: nobody is on it any more.
export function forgetPagePresence(pageId: string) {
  seenByPage().delete(pageId);
  noteNamesWritten([presenceName(pageId)]);
}
const presenceName = (pageId: string) => `~presence:${pageId}`;
