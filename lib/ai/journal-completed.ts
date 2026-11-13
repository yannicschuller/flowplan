// "An diesem Tag erledigt" for the AI (#273): the list below a journal day
// is not part of the day's document (lib/journal-completed.ts computes it
// from the status logs), so it never reached a prompt – "summarize what I
// completed today" found nothing. Wherever a day's content goes to the AI
// (lib/ai/content.ts aiPageMarkdown: "Diese Seite" in Ask, the writing
// assistant's page context, "Seite zusammenfassen", the journal review) and
// in the journal workflow nodes (the output `completed`), the same list
// comes along: the reader's choice "Nur meine / Alle", the journal's switch,
// and only what the person may see (completedOn) and the AI may read
// (aiFilter: no journals with a PIN even while unlocked, no encrypted
// spaces, no pages or records closed to the AI, no private records of
// others). At most AI_COMPLETED_LIMITS items and characters, with a note
// when cut.
import { one } from "../db";
import { translate, type Locale } from "../i18n";
import { contentLocale } from "../content-locale";
import { completedMineChoice, completedOn, type CompletedRecord } from "../journal-completed";
import { journalSettings } from "../journal-extras";
import { validZone } from "../date-values";
import type { Identity, Page } from "../types";
import { aiFilter, aiMayRead } from "./access";

export const AI_COMPLETED_LIMITS = { items: 200, chars: 12_000 };

export type AiCompleted = {
  items: CompletedRecord[];
  // Readable items beyond `items` (the cap).
  more: number;
  // "Nur meine" (the reader's choice for the journal).
  mine: boolean;
};

// A day page; `id` "" for a day not made yet (the journal lists completed
// records below today's draft as well).
type Day = Pick<Page, "id" | "workspace_id" | "parent_id" | "journal_date">;

// The completed items of a journal day for the AI, or null when `day` is no
// journal day, the AI may not read it or the journal switched the list off.
export async function aiCompletedItems(user: Identity, day: Day, zone = "UTC", limit = AI_COMPLETED_LIMITS.items): Promise<AiCompleted | null> {
  if (!day.journal_date || !day.parent_id) return null;
  const journal = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", day.parent_id);
  if (!journal || journal.kind !== "journal") return null;
  // The day itself (or the journal of a day not made yet): a journal with a
  // PIN stays closed even while unlocked.
  if (!(await aiMayRead(user, day.id || journal.id))) return null;
  if (!(await journalSettings(journal.id)).options.completed) return null;
  const mine = (await completedMineChoice(user, journal.id)) ?? true;
  const list = await completedOn(user, day.workspace_id, day.journal_date, validZone(zone) ? zone : "UTC", {
    dayId: day.id || undefined,
    mine,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const readable = (await aiFilter(user, list.items.map((item) => ({ item, pageId: item.pageId, rowId: item.rowId || null })))).map((r) => r.item);
  return { items: readable.slice(0, limit), more: Math.max(0, readable.length - limit), mine };
}

const line = (text: string) => text.replace(/\s+/g, " ").trim();

// One item as the journal shows it: its title and the page or database it is in.
export function completedLine(item: CompletedRecord, locale: Locale = contentLocale()) {
  const tr = translate(locale);
  return `${line(item.title) || tr("Ohne Titel", "Untitled")} (${line(item.database) || tr("Ohne Titel", "Untitled")})`;
}

// The plain Markdown section ("" when there is nothing to show, as the
// journal hides the list then).
export function completedSection(list: AiCompleted | null, locale: Locale = contentLocale(), maxChars = AI_COMPLETED_LIMITS.chars): string {
  if (!list || !list.items.length) return "";
  const tr = translate(locale);
  const heading = `## ${tr("An diesem Tag erledigt", "Completed this day")}${list.mine ? ` (${tr("Nur meine", "Only mine")})` : ""}`;
  const lines = [heading];
  let size = heading.length;
  let shown = 0;
  for (const item of list.items) {
    const text = `- [x] ${completedLine(item, locale)}`;
    if (shown && size + text.length + 1 > maxChars) break;
    lines.push(text);
    size += text.length + 1;
    shown++;
  }
  const more = list.more + list.items.length - shown;
  if (more > 0) lines.push(`- ${tr(`… und ${more} weitere`, `… and ${more} more`)}`);
  return lines.join("\n");
}

// The section for a page, "" for every page that is not a journal day.
export async function aiCompletedSection(user: Identity, page: Day, options: { zone?: string; locale?: Locale; maxChars?: number } = {}) {
  if (!page.journal_date || !page.parent_id) return "";
  return completedSection(await aiCompletedItems(user, page, options.zone), options.locale, options.maxChars);
}
