// Opening a database (#383 wave 3): its answer – thousands of records with
// their previews, roles and related data, serialised to some megabytes of
// JSON and hashed for its ETag – cost the request thread ~60 ms, the
// largest single piece of work of a busy instance. When a worker thread is
// free (lib/worker-pool.ts offThread ifFree) it builds, serialises and
// hashes the answer there.
//
// The request thread first does what only it can or what writes, in the
// order pageContent() and withActivity() have it: who is on the page
// (lib/page-presence.ts keeps that in its memory), this person's presence,
// then the visit, the readers and following (lib/page-activity.ts). The
// worker gets those and puts them where the request thread's own answer
// has them: the bytes and the ETag are exactly those of
// jsonWithTag(withActivity(pageData(…))) (tests/page-open.test.ts).
//
// Only database pages and only the opening (a visit): refreshes stay on
// the request thread, where their answer is kept for the cheap 304
// (lib/kept-answers.ts). A journal lock or an encrypted space are built as
// before; no free thread, or work that would write on the way (a record
// preview made anew): the same function on the request thread. The links
// table of the backlinks, which typing elsewhere keeps marking, is brought
// up to date here first (lib/text-links.ts).
import { pageData } from "./api";
import { requirePage } from "./permissions";
import { notePresence, pagePresence } from "./page-presence";
import { withActivity } from "./page-activity";
import { lockingJournal } from "./journal-extras";
import { isEncryptedPage } from "./e2ee-server";
import { contentTag } from "./etag";
import { offThread } from "./worker-pool";
import { drainTextLinks } from "./text-links";
import type { Identity } from "./types";

// `body`: the JSON as UTF-8 – encoded in the worker, and moved to the
// request thread rather than copied (lib/worker-pool.ts transferables).
export type OpenedDatabase = { body: Uint8Array; etag: string };
// `present`: who is on the page; `activity`: the fields withActivity() adds.
// null: not the plain answer of a database after all.
export async function openedDatabaseJson(user: Identity, pageId: string, present: unknown, activity: Record<string, unknown>): Promise<OpenedDatabase | null> {
  const data = (await pageData(user, pageId, { presence: false })) as Record<string, unknown> & { page: { kind: string } };
  if (data.page.kind !== "database" || !("database" in data) || !("present" in data) || "locked" in data) return null;
  // An existing key keeps its place; the activity's come last, as with
  // withActivity()'s spread.
  data.present = present;
  const body = Buffer.from(JSON.stringify(Object.assign(data, activity)));
  return { body, etag: contentTag(body) };
}

// The answer of opening the page with its ETag, or null: not a database
// (or not its plain answer) – the caller builds it as before.
export async function openDatabase(user: Identity, pageId: string, presence: boolean): Promise<OpenedDatabase | null> {
  const page = await requirePage(user, pageId);
  if (page.kind !== "database" || (await lockingJournal(user, page)) || (await isEncryptedPage(page))) return null;
  const present = await pagePresence(pageId, Date.now(), user.id);
  if (presence) await notePresence(pageId, user.id);
  const { page: _page, ...activity } = (await withActivity(user, { page }, true)) as Record<string, unknown>;
  // The backlinks' table brought up to date here (it writes; the worker
  // takes it as it is).
  await drainTextLinks();
  return await offThread("page.database", [user, pageId, present, activity], () => openedDatabaseJson(user, pageId, present, activity), { ifFree: true });
}
