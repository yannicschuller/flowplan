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
//
// Several processes on one host (FLOWPLAN_PROCESSES, without cluster mode):
// no table either – what one process saw goes to the others over the bus
// ("presence"), at most every WRITE_EVERY ms per person and page, and they
// keep it in their memory alongside their own.
import { all, noteNamesRead, noteNamesWritten, run, sql } from "./db";
import { keepUntil } from "./read-memo";
import { clusterMode } from "./cluster/config";
import { onBus, publish } from "./cluster/bus";
import { multiProcess } from "./cluster/processes";

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

// Notes `userId` on the page as of `at`; true when they were not there.
function seenAt(pageId: string, userId: string, at: number, now: number) {
  sweep(now);
  const seen = seenByPage().get(pageId) ?? seenByPage().set(pageId, new Map()).get(pageId)!;
  const before = seen.get(userId);
  if (before !== undefined && before >= at) return false;
  seen.set(userId, at);
  // Someone new on the page: kept answers of the page are outdated
  // (lib/kept-answers.ts); a renewal changes nothing they show.
  const arrived = before === undefined || now - before > PRESENT_MS;
  if (arrived) noteNamesWritten([presenceName(pageId)]);
  return arrived;
}
const shared = globalThis as { flowplanPresenceBus?: boolean };
function listen() {
  if (shared.flowplanPresenceBus) return;
  shared.flowplanPresenceBus = true;
  onBus("presence", (payload) => {
    const m = payload as { p?: unknown; u?: unknown; at?: unknown; gone?: unknown };
    if (typeof m?.p !== "string") return;
    if (m.gone) {
      seenByPage().delete(m.p);
      noteNamesWritten([presenceName(m.p)]);
      return;
    }
    const now = Date.now();
    // Never ahead of this process's clock (the same host: the same clock).
    if (typeof m.u === "string" && typeof m.at === "number" && m.at > now - PRESENT_MS) seenAt(m.p, m.u, Math.min(m.at, now), now);
  });
}
if (multiProcess() && !clusterMode()) listen();

// The person asked for the page now.
export async function notePresence(pageId: string, userId: string, now = Date.now()) {
  seenAt(pageId, userId, now, now);
  const localPeers = !clusterMode() && multiProcess();
  if (!clusterMode() && !localPeers) return;
  const key = `${pageId}\u0000${userId}`;
  const last = written().get(key);
  if (last !== undefined && now - last < WRITE_EVERY) return;
  written().set(key, now);
  if (localPeers) {
    publish("presence", { p: pageId, u: userId, at: now });
    return;
  }
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
  if (!clusterMode() && multiProcess()) publish("presence", { p: pageId, gone: true });
}
const presenceName = (pageId: string) => `~presence:${pageId}`;
