// Today's journal entry without a connection (#333). "Heute" in the sidebar,
// the journal's "+", the journal page and the day picker open today's page;
// offline that page usually does not exist yet (it is created on the server
// when the journal opens, or on the first write – lib/journal-days.ts), and
// a draft the server never sent cannot be loaded either. Offline the entry
// is therefore written into a local page that exists only on this device
// (components/workspace-app.tsx): its text stays here, and once the
// connection is back "journal.roll" creates the day as usual and appends
// that text to it (`append`, lib/api.ts). Pure functions over the list kept
// in localStorage, so the flow is testable.

export type OfflineJournalEntry = {
  // The local page's id (the editor keeps its text in IndexedDB under it).
  id: string;
  journalId: string;
  // The local day it was written for (YYYY-MM-DD).
  date: string;
  // What the editor shows, sent once online.
  html: string;
  // Idempotency-Key of the request that creates the day with this text: a
  // retry after a lost answer is applied once; new text gets a new key.
  key: string;
  at: number;
};

export const offlineJournalKey = (userId: string) => `flowplan:journal-offline:${userId}`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The text the server accepts with `append` (lib/api.ts).
export const OFFLINE_JOURNAL_MAX = 1_000_000;

function valid(value: unknown): value is OfflineJournalEntry {
  const e = value as OfflineJournalEntry | null;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    ID.test(e.id) &&
    typeof e.journalId === "string" &&
    ID.test(e.journalId) &&
    typeof e.date === "string" &&
    DATE.test(e.date) &&
    typeof e.html === "string" &&
    typeof e.key === "string" &&
    typeof e.at === "number"
  );
}
// The stored list; anything unreadable counts as nothing.
export function parseOfflineJournal(text: string | null | undefined): OfflineJournalEntry[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list.filter(valid) : [];
  } catch {
    return [];
  }
}
export const offlineEntryFor = (list: OfflineJournalEntry[], journalId: string, date: string) =>
  list.find((e) => e.journalId === journalId && e.date === date);
export const offlineEntryById = (list: OfflineJournalEntry[], id: string) => list.find((e) => e.id === id);
// One entry per journal and day: a newer one takes the place of the old.
export const withOfflineEntry = (list: OfflineJournalEntry[], entry: OfflineJournalEntry) => [
  ...list.filter((e) => e.id !== entry.id && !(e.journalId === entry.journalId && e.date === entry.date)),
  entry,
];
export const withoutOfflineEntry = (list: OfflineJournalEntry[], id: string) => list.filter((e) => e.id !== id);

// Whether the entry holds anything worth a page: text, a task, a picture …
// An empty paragraph (what the editor starts with) does not.
export function offlineEntryHasText(html: string) {
  if (/<(img|hr|iframe|video|audio)\b/i.test(html) || /data-type="(taskItem|media|mention)"/.test(html)) return true;
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/g, " ").trim().length > 0;
}

// The command that creates the day once online and appends the text:
// today's day the usual way (with its template and carried tasks, also when
// today's page was moved to the trash meanwhile – the text asks for a page),
// an earlier day as the day picker creates one (lib/journal.ts openJournalDay).
export function offlineEntryCommand(entry: OfflineJournalEntry, today: string): Record<string, unknown> {
  const base = { action: "journal.roll", pageId: entry.journalId, date: today, append: entry.html };
  return entry.date < today ? { ...base, day: entry.date } : { ...base, write: true, recreate: true };
}

// The journal page asks for today's page when it opens (journal.roll,
// components/journal-view.tsx). When that fails (#456): only a failure
// while the device is offline, or one that never reached Flowplan (no
// answer, a gateway error), is "offline" – "Heute" then opens the entry on
// this device. It is asked again once the device is back online and, while
// it is online all along (the server restarted, a proxy dropped the
// request), after a pause that grows with every attempt. A refusal of the
// server is an error to show, never the offline notice.
export function todayRollFailure(
  offline: boolean,
  transient: boolean,
  failures: number,
): { offline: boolean; retryIn: number | null } {
  if (!offline && !transient) return { offline: false, retryIn: null };
  return { offline: true, retryIn: offline ? null : Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1)) };
}
