// "Mit KI zusammenfassen" in a journal's review (#170): the period the
// review shows (a week or a month) as a narrative review – highlights and
// achievements, a chronological overview, open items. The server collects
// what the review computes (lib/journal-extras.ts journalReview: the days'
// text, completed tasks, trackers, tasks still open) itself, after the same
// checks as "Seite zusammenfassen" (lib/ai/summarize.ts): the feature, the
// person, the provider, the journal's read rights and the AI's rules – a
// journal with a PIN is closed to the AI even while unlocked
// (lib/ai/access.ts). Days the AI may not read (a rule, a block) stay out
// with everything of theirs. Long periods go through the same map-reduce
// and size limits; the answer streams. Nothing is stored here: the review
// saves the answer as a page only when asked (lib/journal-summary.ts).
import { z } from "zod";
import { all } from "../db";
import { HttpError } from "../auth";
import { requirePage } from "../permissions";
import { dayEntry, journalReview, requireUnlocked } from "../journal-extras";
import { stillOpenTasks } from "../journal-summary";
import { reviewPeriod } from "../journal-nav";
import type { Identity, Page } from "../types";
import { aiReadablePages } from "./access";
import { aiPageParts } from "./content";
import { journalSummaryPrompt, type AiLocale } from "./prompts";
import { isLocalProvider } from "./resolve";
import { aiComplete, aiStreamResponse, requireAi, type AiRunOptions } from "./run";
import { reduceContent, SUMMARY_LIMITS } from "./summarize";

const journalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const journalSummaryInput = z.object({
  journalId: z.uuid(),
  from: journalDay,
  to: journalDay,
  locale: z.enum(["de", "en", "fr", "zh"]).default("de"),
  // The reader's time zone: which day "An diesem Tag erledigt" covers (#273).
  zone: z.string().max(100).optional(),
});

const weekday = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" });
const dayName = (date: string) => `${date} (${weekday.format(new Date(`${date}T00:00:00Z`))})`;
const number = (value: number) => String(Math.round(value * 10) / 10);
const MAX_TASKS = 100;

// The period's content for the prompt: only what the AI may read.
export async function journalSummaryContent(user: Identity, journal: Page, from: string, to: string, zone?: string) {
  const review = await journalReview(journal, from, to);
  const readable = await aiReadablePages(user, review.days.map((day) => day.id));
  const days = review.days.filter((day) => readable.has(day.id));
  const dates = new Set(days.map((day) => day.date));
  const lines: string[] = [];
  const done = review.done.filter((task) => readable.has(task.dayId));
  if (done.length) {
    lines.push("## Completed tasks", ...done.slice(0, MAX_TASKS).map((task) => `- [x] ${task.text} (${task.date})`));
    if (done.length > MAX_TASKS) lines.push(`- … ${done.length - MAX_TASKS} more`);
    lines.push("");
  }
  const trackers = review.trackers
    .map((tracker) => ({ ...tracker, values: tracker.values.filter((v) => dates.has(v.date)) }))
    .filter((tracker) => tracker.values.length);
  if (trackers.length) {
    lines.push("## Trackers");
    for (const tracker of trackers) {
      if (tracker.kind === "check") lines.push(`- ${tracker.name}: ${tracker.values.filter((v) => v.value === true).length} of ${tracker.values.length} days`);
      else {
        const numbers = tracker.values.map((v) => Number(v.value));
        const average = numbers.reduce((a, b) => a + b, 0) / numbers.length;
        lines.push(`- ${tracker.name}: average ${number(average)}${tracker.unit ? ` ${tracker.unit}` : ""}${tracker.kind === "mood" ? " (mood, 1 = bad … 5 = great)" : ""} over ${numbers.length} days`);
      }
    }
    lines.push("");
  }
  // Open tasks move on to the journal's latest day (lib/journal.ts), which
  // may lie after the period: it must be readable for the AI too.
  const stillOpen = days.length ? await stillOpenTasks(journal, from, to) : [];
  const openDays = await aiReadablePages(user, [...new Set(stillOpen.map((task) => task.dayId))]);
  const open = stillOpen.filter((task) => openDays.has(task.dayId));
  if (open.length) {
    lines.push("## Still open", ...open.slice(0, MAX_TASKS).map((task) => `- [ ] ${task.text} (since ${task.since})`));
    if (open.length > MAX_TASKS) lines.push(`- … ${open.length - MAX_TASKS} more`);
    lines.push("");
  }
  lines.push("## Days", "");
  const pages = new Map(
    days.length
      ? (await all<Page>(`SELECT * FROM pages WHERE id IN (${days.map(() => "?").join(",")})`, ...days.map((day) => day.id))).map((p) => [p.id, p])
      : [],
  );
  const names = new Map(review.trackers.map((tracker) => [tracker.id, tracker]));
  for (const day of days) {
    const page = pages.get(day.id);
    if (!page) continue;
    lines.push(`### ${dayName(day.date)}`);
    const entry = await dayEntry(day.id);
    const values = Object.entries(entry.values).flatMap(([id, value]) => {
      const tracker = names.get(id);
      if (!tracker) return [];
      return [`${tracker.name}: ${typeof value === "boolean" ? (value ? "yes" : "no") : `${number(value)}${tracker.unit ? ` ${tracker.unit}` : ""}`}`];
    });
    if (values.length) lines.push(`Trackers: ${values.join(" · ")}`);
    if (entry.place) lines.push(`Place: ${entry.place}`);
    // The day's text and its list "An diesem Tag erledigt" (#273), a level below the day.
    const { body, completed } = await aiPageParts(user, page, null, { zone, maxChars: 4000 });
    lines.push(body || "(no text)", "");
    if (completed) lines.push(completed.replace(/^## /, "#### "), "");
  }
  return { content: lines.join("\n").trim(), included: days.length, total: review.days.length };
}

// POST /api/ai/journal-summary → the review as a text stream (lib/ai/run.ts),
// with X-Flowplan-AI-* headers: days included / in the period, parts.
export async function aiJournalSummaryResponse(user: Identity, raw: unknown, signal: AbortSignal): Promise<Response> {
  const b = journalSummaryInput.parse(raw);
  const period = reviewPeriod(b.from, b.to);
  if (!period) throw new HttpError(400, "Nur eine Woche oder ein ganzer Monat lässt sich zusammenfassen.");
  const journal = await requirePage(user, b.journalId);
  if (journal.kind !== "journal") throw new HttpError(400, "Diese Seite ist kein Journal.");
  await requireUnlocked(user, journal);
  const options: AiRunOptions = { workspaceId: journal.workspace_id, pageId: journal.id, signal };
  // Feature, person, provider and whether the AI may read the journal (a
  // PIN closes it to the AI).
  const resolved = await requireAi(user, "summarize", options);
  const local = resolved.config.kind === "ollama" || isLocalProvider(resolved.config);
  const chunkChars = local ? SUMMARY_LIMITS.chunkChars.local : SUMMARY_LIMITS.chunkChars.remote;
  const data = await journalSummaryContent(user, journal, b.from, b.to, b.zone);
  if (!data.total) throw new HttpError(400, "In diesem Zeitraum gibt es keine Einträge.");
  if (!data.included) throw new HttpError(403, "Die Tage dieses Zeitraums sind für die KI gesperrt.");
  const locale = b.locale as AiLocale;
  const note =
    data.included < data.total
      ? `These are ${data.included} of the ${data.total} days of the period; the others are closed to the AI and were left out.`
      : undefined;
  const reduced = await reduceContent({ kind: "journal", content: data.content, title: journal.title, locale, language: locale, note }, chunkChars, (prompt) =>
    aiComplete(user, "summarize", prompt, options),
  );
  const response = await aiStreamResponse(
    user,
    "summarize",
    journalSummaryPrompt({
      content: reduced.content,
      title: journal.title,
      period: `${period.kind === "week" ? "week" : "month"} from ${b.from} to ${b.to}`,
      language: reduced.language,
      partial: reduced.partial,
      note,
    }),
    { ...options, signal },
  );
  response.headers.set("X-Flowplan-AI-Included", String(data.included));
  response.headers.set("X-Flowplan-AI-Total", String(data.total));
  response.headers.set("X-Flowplan-AI-Parts", String(reduced.parts));
  if (reduced.truncated) response.headers.set("X-Flowplan-AI-Truncated", "1");
  return response;
}
