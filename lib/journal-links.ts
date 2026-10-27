// "@heute", "@gestern", "@2026-10-27" in the mention dialog (#49): which
// day of the journal the typed text means. The server picks the journal
// and the page (lib/journal-days.ts journalDayLink).

// The person's own date (a journal day starts at local midnight).
export function localDate(offset = 0, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
// Today and yesterday in German, English and French – also while still
// being typed ("heu") – or an ISO date.
export function journalDayQuery(term: string, today = localDate(), yesterday = localDate(-1)) {
  const word = term.trim().replace(/^@/, "").toLocaleLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(word)) {
    const valid = new Date(`${word}T00:00:00Z`);
    return !Number.isNaN(valid.getTime()) && valid.toISOString().slice(0, 10) === word ? { label: "date" as const, date: word } : null;
  }
  if (word.length < 2) return null;
  const starts = (words: string[]) => words.some((w) => w.startsWith(word));
  if (starts(["heute", "today", "aujourd'hui", "aujourd’hui"])) return { label: "today" as const, date: today };
  if (starts(["gestern", "yesterday", "hier"])) return { label: "yesterday" as const, date: yesterday };
  return null;
}
