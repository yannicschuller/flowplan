// "Monatszusammenfassung erstellen" in a journal's review (#49): a normal
// sub page of the journal (not a day) with the month in numbers, its
// highlights (trackers, places, completed tasks), its tasks still open and a
// link to every day with the start of its text. Built from what the review
// computes (journalReview), deterministic, no AI needed.
//
// One summary per journal and month: it is remembered in meeting_notes (the
// table of pages a journal creates for something, keyed per journal) under
// "month-summary:YYYY-MM", so asking again offers the existing page.
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { z } from "zod";
import { one, run } from "./db";
import { documentSchema } from "./document-schema";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { createPage } from "./seed";
import { escaped, htmlState } from "./document-server";
import { openTasks } from "./journal";
import { contentLocale, ct } from "./content-locale";
import { localeTag } from "./i18n";
import { journalReview, plainText } from "./journal-extras";
import { monthPattern, monthRange, summaryKey } from "./journal-nav";
import type { Identity, Page } from "./types";

const moodFaces = ["😞", "🙁", "😐", "🙂", "😄"];
const MAX_TASKS = 50;

export const summaryInput = z.object({
  month: z.string().regex(monthPattern),
  // Make a new one although one exists (the old one stays).
  again: z.boolean().optional(),
});

export function summaryTitle(month: string) {
  const name = new Intl.DateTimeFormat(localeTag(contentLocale()), { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
  return ct(`Monatszusammenfassung ${name}`, `Monthly summary ${name}`);
}

// The summary page of a month, when it still exists and the person may open it.
export function existingSummary(user: Identity, journal: Page, month: string): string | null {
  const row = one<{ page_id: string }>(
    "SELECT page_id FROM meeting_notes WHERE journal_id=? AND event_key=?",
    journal.id,
    summaryKey(month),
  );
  if (!row) return null;
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", row.page_id);
  return page && pageRole(user, page) ? page.id : null;
}

let cachedSchema: ReturnType<typeof documentSchema> | undefined;
const schema = () => (cachedSchema ??= documentSchema());

// Tasks written down up to the month's end that are still open now. Open
// tasks move on to each new day (lib/journal.ts), so they live on the
// journal's latest day, marked with the day they were first written.
export function stillOpenTasks(journal: Page, from: string, to: string) {
  const latest = one<Page>(
    "SELECT * FROM pages WHERE parent_id=? AND journal_date>=? AND deleted_at IS NULL ORDER BY journal_date DESC LIMIT 1",
    journal.id,
    from,
  );
  if (!latest) return [];
  const row = one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM documents WHERE page_id=?", latest.id);
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, row?.state || htmlState(row?.html || ""));
  const doc = PMNode.fromJSON(schema(), yDocToProsemirrorJSON(ydoc, "default"));
  ydoc.destroy();
  return openTasks(doc).flatMap((task) => {
    const since = typeof task.attrs.journalSince === "string" && task.attrs.journalSince ? task.attrs.journalSince : latest.journal_date!;
    const text = task.firstChild?.textContent.trim() || task.textContent.trim();
    return text && since <= to ? [{ text, since, dayId: latest.id, date: latest.journal_date! }] : [];
  });
}

const number = (value: number) =>
  value.toLocaleString(localeTag(contentLocale()), { maximumFractionDigits: 1 });

// The page's content as document HTML.
export function summaryHtml(journal: Page, month: string) {
  const { from, to } = monthRange(month);
  const review = journalReview(journal, from, to);
  const tag = localeTag(contentLocale());
  const dayName = new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
  const dayLabel = (date: string) => dayName.format(new Date(`${date}T00:00:00Z`));
  const link = (dayId: string, date: string) => `<a href="/#page=${escaped(dayId)}">${escaped(dayLabel(date))}</a>`;
  const list = (items: string[]) => `<ul>${items.map((item) => `<li><p>${item}</p></li>`).join("")}</ul>`;
  const parts: string[] = [];
  const days = review.days.length;
  const open = days ? stillOpenTasks(journal, from, to) : [];
  parts.push(
    `<p><strong>${escaped(days === 1 ? ct("1 Tag", "1 day") : ct(`${days} Tage`, `${days} days`))}</strong> · ${escaped(
      ct(`${number(review.words)} Wörter`, `${number(review.words)} words`),
    )} · ${escaped(ct(`${review.done.length} erledigt`, `${review.done.length} done`))} · ${escaped(
      ct(`${open.length} noch offen`, `${open.length} still open`),
    )}</p>`,
  );
  if (!days) {
    parts.push(`<p>${escaped(ct("In diesem Monat gibt es keine Einträge.", "There are no entries in this month."))}</p>`);
    return parts.join("");
  }

  // Highlights: trackers, places, completed tasks.
  const highlights: string[] = [];
  for (const tracker of review.trackers.filter((t) => t.count)) {
    const value =
      tracker.kind === "check"
        ? ct(
            `${tracker.values.filter((v) => v.value === true).length} von ${tracker.count} Tagen`,
            `${tracker.values.filter((v) => v.value === true).length} of ${tracker.count} days`,
          )
        : `Ø ${tracker.kind === "mood" ? `${moodFaces[Math.round(tracker.average ?? 3) - 1] || ""} ` : ""}${number(tracker.average ?? 0)}${
            tracker.unit ? ` ${tracker.unit}` : ""
          }`;
    highlights.push(`<strong>${escaped(tracker.name)}:</strong> ${escaped(value)}`);
  }
  if (review.places.length) highlights.push(`<strong>${escaped(ct("Orte", "Places"))}:</strong> ${escaped(review.places.join(", "))}`);
  if (review.images.length)
    highlights.push(escaped(review.images.length === 1 ? ct("1 Foto", "1 photo") : ct(`${review.images.length} Fotos`, `${review.images.length} photos`)));
  if (highlights.length || review.done.length) parts.push(`<h2>${escaped(ct("Höhepunkte", "Highlights"))}</h2>`);
  if (highlights.length) parts.push(list(highlights));
  if (review.done.length) {
    parts.push(`<h3>${escaped(ct("Erledigt", "Done"))}</h3>`);
    const shown = review.done.slice(0, MAX_TASKS);
    parts.push(list(shown.map((task) => `✓ ${escaped(task.text)} · ${link(task.dayId, task.date)}`)));
    if (review.done.length > shown.length)
      parts.push(`<p>${escaped(ct(`… und ${review.done.length - shown.length} weitere`, `… and ${review.done.length - shown.length} more`))}</p>`);
  }

  // Still open: plain text, so they are not counted twice in "Meine Aufgaben";
  // the link leads to the day they are on now.
  parts.push(`<h2>${escaped(ct("Noch offen", "Still open"))}</h2>`);
  if (open.length) {
    const shown = open.slice(0, MAX_TASKS);
    parts.push(
      list(
        shown.map(
          (task) =>
            `${escaped(task.text)} · ${escaped(ct(`seit ${dayLabel(task.since)}`, `since ${dayLabel(task.since)}`))} · ${link(task.dayId, task.date)}`,
        ),
      ),
    );
    if (open.length > shown.length)
      parts.push(`<p>${escaped(ct(`… und ${open.length - shown.length} weitere`, `… and ${open.length - shown.length} more`))}</p>`);
  } else parts.push(`<p>${escaped(ct("Nichts – alles erledigt.", "Nothing – everything is done."))}</p>`);

  // Every day with the start of its text.
  parts.push(`<h2>${escaped(ct("Tage", "Days"))}</h2>`);
  const excerpts = new Map<string, string>();
  for (const day of review.days) {
    const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", day.id)?.html || "";
    const text = plainText(html);
    excerpts.set(day.id, text.length > 140 ? `${text.slice(0, 140).trimEnd()} …` : text);
  }
  parts.push(
    list(
      review.days.map((day) => {
        const excerpt = excerpts.get(day.id);
        return `${link(day.id, day.date)}${excerpt ? ` – ${escaped(excerpt)}` : ""}`;
      }),
    ),
  );
  return parts.join("");
}

// Creates the summary, or names the one already there.
export function createMonthSummary(user: Identity, journal: Page, input: unknown) {
  if (journal.kind !== "journal") throw new HttpError(400, "Diese Seite ist kein Journal.");
  const { month, again } = summaryInput.parse(input);
  const existing = existingSummary(user, journal, month);
  if (existing && !again) return { id: existing, existing: true };
  const html = summaryHtml(journal, month);
  const created = createPage(journal.workspace_id, journal.space_id, user.id, summaryTitle(month), "document", journal.id);
  run("UPDATE pages SET icon=? WHERE id=?", "📊", created);
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), created);
  run(
    "INSERT OR REPLACE INTO meeting_notes(journal_id,event_key,page_id,created_by,created_at) VALUES(?,?,?,?,?)",
    journal.id,
    summaryKey(month),
    created,
    user.id,
    Date.now(),
  );
  return { id: created, existing: false };
}
