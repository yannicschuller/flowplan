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
import { cleanHtml, escaped, htmlState } from "./document-server";
import { openTasks } from "./journal";
import { contentLocale, ct } from "./content-locale";
import { localeTag } from "./i18n";
import { journalReview, plainText } from "./journal-extras";
import { aiSummaryKey, monthPattern, monthRange, reviewPeriod, summaryKey } from "./journal-nav";
import { aiMarkdownToHtml } from "./ai/insert";
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
export async function existingSummary(user: Identity, journal: Page, month: string): Promise<string | null> {
  const row = await one<{ page_id: string }>(
    "SELECT page_id FROM meeting_notes WHERE journal_id=? AND event_key=?",
    journal.id,
    summaryKey(month),
  );
  if (!row) return null;
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", row.page_id);
  return page && await pageRole(user, page) ? page.id : null;
}

let cachedSchema: Awaited<ReturnType<typeof documentSchema>> | undefined;
const schema = () => (cachedSchema ??= documentSchema());

// Tasks written down up to the month's end that are still open now. Open
// tasks move on to each new day (lib/journal.ts), so they live on the
// journal's latest day, marked with the day they were first written.
export async function stillOpenTasks(journal: Page, from: string, to: string) {
  const latest = await one<Page>(
    "SELECT * FROM pages WHERE parent_id=? AND journal_date>=? AND deleted_at IS NULL ORDER BY journal_date DESC LIMIT 1",
    journal.id,
    from,
  );
  if (!latest) return [];
  const row = await one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM documents WHERE page_id=?", latest.id);
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
export async function summaryHtml(journal: Page, month: string) {
  const { from, to } = monthRange(month);
  const review = await journalReview(journal, from, to);
  const tag = localeTag(contentLocale());
  const dayName = new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
  const dayLabel = (date: string) => dayName.format(new Date(`${date}T00:00:00Z`));
  const link = (dayId: string, date: string) => `<a href="/#page=${escaped(dayId)}">${escaped(dayLabel(date))}</a>`;
  const list = (items: string[]) => `<ul>${items.map((item) => `<li><p>${item}</p></li>`).join("")}</ul>`;
  const parts: string[] = [];
  const days = review.days.length;
  const open = days ? (await stillOpenTasks(journal, from, to)) : [];
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
    const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", day.id))?.html || "";
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
export async function createMonthSummary(user: Identity, journal: Page, input: unknown) {
  if (journal.kind !== "journal") throw new HttpError(400, "Diese Seite ist kein Journal.");
  const { month, again } = summaryInput.parse(input);
  const existing = await existingSummary(user, journal, month);
  if (existing && !again) return { id: existing, existing: true };
  const html = await summaryHtml(journal, month);
  const created = await createPage(journal.workspace_id, journal.space_id, user.id, summaryTitle(month), "document", journal.id);
  await run("UPDATE pages SET icon=? WHERE id=?", "📊", created);
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), created);
  await run(
    "INSERT INTO meeting_notes(journal_id,event_key,page_id,created_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(journal_id,event_key) DO UPDATE SET page_id=excluded.page_id,created_by=excluded.created_by,created_at=excluded.created_at",
    journal.id,
    summaryKey(month),
    created,
    user.id,
    Date.now(),
  );
  return { id: created, existing: false };
}

// ---- The AI summary of a review period (#170) ----
//
// "Mit KI zusammenfassen" in the review streams a preview
// (lib/ai/journal-summary.ts); only "Als Seite speichern" stores it – a
// normal sub page of the journal like the month summary, one per journal
// and period (a week or a month), remembered in meeting_notes under
// "ai-summary:<period>". Asked again, the page there is offered: open it,
// or replace its content (the old one stays in its versions).

export const aiSummaryInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  markdown: z.string().trim().min(1).max(100_000),
  replace: z.boolean().optional(),
});

function periodOf(from: string, to: string) {
  const period = reviewPeriod(from, to);
  if (!period) throw new HttpError(400, "Nur eine Woche oder ein ganzer Monat lässt sich zusammenfassen.");
  return period;
}

export function aiSummaryTitle(from: string, to: string) {
  const period = periodOf(from, to);
  if (period.kind === "month") {
    const name = new Intl.DateTimeFormat(localeTag(contentLocale()), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${from}T00:00:00Z`));
    return ct(`KI-Zusammenfassung ${name}`, `AI summary ${name}`);
  }
  const date = new Intl.DateTimeFormat(localeTag(contentLocale()), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const start = date.format(new Date(`${from}T00:00:00Z`)),
    end = date.format(new Date(`${to}T00:00:00Z`));
  return ct(`KI-Zusammenfassung ${start} – ${end}`, `AI summary ${start} – ${end}`);
}

// The AI summary page of a period, when it still exists and the person may open it.
export async function existingAiSummary(user: Identity, journal: Page, from: string, to: string): Promise<string | null> {
  const period = reviewPeriod(from, to);
  if (!period) return null;
  const row = await one<{ page_id: string }>("SELECT page_id FROM meeting_notes WHERE journal_id=? AND event_key=?", journal.id, aiSummaryKey(period.key));
  if (!row) return null;
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", row.page_id);
  return page && (await pageRole(user, page)) ? page.id : null;
}

// Saves the previewed answer: a new page, the existing one named (without
// `replace`) or its content replaced (with it).
export async function saveAiSummary(user: Identity, journal: Page, input: unknown): Promise<{ id: string; existing: boolean; replaced?: boolean }> {
  if (journal.kind !== "journal") throw new HttpError(400, "Diese Seite ist kein Journal.");
  const { from, to, markdown, replace } = aiSummaryInput.parse(input);
  const period = periodOf(from, to);
  const html = cleanHtml(
    `<p><em>${escaped(ct("Mit KI aus den Einträgen dieses Zeitraums zusammengefasst – bitte prüfen.", "Summarised from this period's entries with AI – please check."))}</em></p>${aiMarkdownToHtml(markdown)}`,
  );
  const existing = await existingAiSummary(user, journal, from, to);
  if (existing && !replace) return { id: existing, existing: true };
  if (existing) {
    // Sent like an edit from the editor: open editors receive it, the
    // previous content stays in the versions.
    const { appendHtml } = await import("./ai/actions");
    await appendHtml(user, existing, html, { replace: true });
    return { id: existing, existing: false, replaced: true };
  }
  const created = await createPage(journal.workspace_id, journal.space_id, user.id, aiSummaryTitle(from, to), "document", journal.id);
  await run("UPDATE pages SET icon=? WHERE id=?", "✨", created);
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), created);
  await run(
    "INSERT INTO meeting_notes(journal_id,event_key,page_id,created_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(journal_id,event_key) DO UPDATE SET page_id=excluded.page_id,created_by=excluded.created_by,created_at=excluded.created_at",
    journal.id,
    aiSummaryKey(period.key),
    created,
    user.id,
    Date.now(),
  );
  return { id: created, existing: false };
}
