// Unchanged refreshes answered before anything is built (#383): the cheap
// 304 of the bootstrap and of an open page.
//
// Every open tab asks for the bootstrap and its page again and again (the
// timed refresh, components/workspace-app.tsx), and nearly always nothing
// changed. Building the answer to compare its ETag cost ~10 ms for the
// bootstrap and ~50 ms for a database. Here the ETag sent last is kept with
// the tables its answer was read from (lib/db.ts tracks the reads and the
// writes per table): while none of them was written since, the same request
// gets its 304 right away.
//
// When an answer is not kept, or no longer current – any of its tables
// written (by any code path of this process, triggers and foreign keys
// included), a write whose tables are unknown, a commit of another process
// on the SQLite file (PRAGMA data_version), a reopened database – it is
// built as before. What does not live in the database (presence, the clock:
// tasks due today, a journal unlock running out, a banner's time) is covered
// by names noted for it (noteNamesRead/noteNamesWritten), by a time it is
// valid until (keepUntil) and by MAX_AGE: no answer is kept longer than
// that without being built again. A build that ends with the same ETag
// renews it.
//
// Only on SQLite: on PostgreSQL other instances write without this process
// seeing it, so nothing is kept there.
import { database, databaseEpoch } from "./db-driver";
import { inTransaction, sqliteDataVersion, tableClockNow, tablesUnchangedSince } from "./db";
import { withTrackedReads } from "./read-memo";
export { keepUntil } from "./read-memo";

// The longest an answer is kept without being built again: what changes
// with the clock alone and is not covered by keepUntil() or the quarter
// hour shows within this time. Longer than the safety-net refresh of a tab
// with the live signal (60 s, components/use-workspace-signals.ts), so that
// refresh is a cheap 304 while nothing changed.
export const MAX_AGE = 5 * 60_000;
const MAX_ENTRIES = 5000;

type Entry = { etag: string; tables: string[]; stamp: number; at: number; until: number; epoch: number; dataVersion: number };
const holder = globalThis as { flowplanKeptAnswers?: Map<string, Entry>; flowplanKeptStats?: { hits: number; misses: number } };
const entries = (holder.flowplanKeptAnswers ??= new Map());
const stats = (holder.flowplanKeptStats ??= { hits: 0, misses: 0 });

const sqlite = () => database().backend === "sqlite";
// A quarter of an hour: the day changes for every time zone on such a
// boundary, and with it "due today". Nothing is kept across one.
const quarter = (now: number) => Math.floor(now / 900_000);

// Whether the browser's If-None-Match names a tag (a list, or "*").
function names(header: string | null, tag: string) {
  if (!header) return false;
  const bare = tag.replace(/^W\//, "");
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === tag || v.replace(/^W\//, "") === bare;
  });
}

// The 304 for `key` when the browser has the kept ETag and it is still
// current; null otherwise (build the answer).
export function keptNotModified(key: string, ifNoneMatch: string | null, now = Date.now()): Response | null {
  if (!ifNoneMatch) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  if (!names(ifNoneMatch, entry.etag) || !current(entry, now)) {
    stats.misses++;
    return null;
  }
  stats.hits++;
  return new Response(null, { status: 304, headers: { "Cache-Control": "no-store", ETag: entry.etag } });
}
function current(entry: Entry, now: number) {
  if (!sqlite() || inTransaction()) return false;
  if (now - entry.at > MAX_AGE || now >= entry.until || quarter(now) !== quarter(entry.at)) return false;
  if (entry.epoch !== databaseEpoch()) return false;
  if (!tablesUnchangedSince(entry.tables, entry.stamp)) return false;
  return sqliteDataVersion() === entry.dataVersion;
}

export type Tracked<T> = { value: T; tables: Set<string>; stamp: number; epoch: number; dataVersion: number; until: number; keeping: boolean };
// Builds an answer and notes what it was read from.
export async function trackedAnswer<T>(build: () => Promise<T>): Promise<Tracked<T>> {
  // Before anything is read: a write while building makes it outdated.
  const stamp = tableClockNow();
  const keeping = sqlite() && !inTransaction();
  const epoch = databaseEpoch();
  const dataVersion = keeping ? sqliteDataVersion() : -1;
  if (!keeping) return { value: await build(), tables: new Set(), stamp, epoch, dataVersion, until: -Infinity, keeping };
  const { value, tables, until } = await withTrackedReads(build);
  return { value, tables, stamp, epoch, dataVersion, until, keeping };
}

// The response built from a tracked answer: its ETag is kept for `key`.
export function keepAnswer(key: string, tracked: Tracked<unknown>, response: Response, now = Date.now()) {
  const etag = response.headers.get("etag");
  if (!etag || !tracked.keeping || !sqlite()) return response;
  if (response.status !== 200 && response.status !== 304) return response;
  // Written while it was built: the next request builds again.
  if (!tablesUnchangedSince(tracked.tables, tracked.stamp)) {
    entries.delete(key);
    return response;
  }
  entries.delete(key);
  entries.set(key, { etag, tables: [...tracked.tables], stamp: tracked.stamp, at: now, until: tracked.until, epoch: tracked.epoch, dataVersion: tracked.dataVersion });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return response;
}

// Hits and misses since the start (tests, the metrics).
export function keptAnswerStats() {
  return { ...stats, entries: entries.size };
}
// Tests: forget everything kept.
export function forgetKeptAnswers() {
  entries.clear();
  stats.hits = stats.misses = 0;
}
