// Summaries ("summarize"): a page, a record, the records of a database view
// or the transcript of a voice note. The server loads the content itself
// after the checks; long content is summarised hierarchically (map-reduce):
// parts → part summaries → (merged further while too long) → the final
// summary, which streams.
import { z } from "zod";
import { HttpError } from "../auth";
import { requirePage } from "../permissions";
import { requireRow } from "../row-documents";
import type { Identity } from "../types";
import { aiDatabaseText, aiPageMarkdown } from "./content";
import { chunkSummaryPrompt, chunkText, cleanAnswer, combineSummaryPrompt, summaryLanguage, summaryPrompt, type SummaryKind } from "./prompts";

// Also for the browser (on-device summaries, lib/ai/device.ts): in prompts.ts.
export { chunkText };
import { isLocalProvider } from "./resolve";
import { aiComplete, aiStreamResponse, requireAi, type AiRunOptions } from "./run";

export const SUMMARY_LIMITS = {
  // Characters per part: small for models on the own server (their context
  // is often only a few thousand tokens), larger for hosted ones.
  chunkChars: { local: 12_000, remote: 48_000 },
  // Parts at most (each one a request, see the rate limit in
  // lib/action-limits.ts); beyond that the content is cut.
  maxChunks: 12,
  // Part summaries summarised at the same time.
  parallel: 2,
  // Database views.
  maxRecords: 300,
  recordDocumentChars: 1_200,
  // Transcripts and text sent from the browser.
  maxText: 200_000,
} as const;

// Runs `task` over the items, at most `limit` at a time, keeping the order.
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type SummaryPlan = {
  kind: SummaryKind;
  content: string;
  title?: string;
  note?: string;
  locale: "de" | "en" | "fr";
};

// The final prompt's input: the content itself, or – when it is longer than
// one part – the summaries of its parts, merged until they fit. `complete`
// answers one prompt (aiComplete in production, a stub in tests).
export async function reduceContent(
  plan: SummaryPlan,
  chunkChars: number,
  complete: (input: ReturnType<typeof chunkSummaryPrompt>) => Promise<string>,
) {
  const language = summaryLanguage(plan.content, plan.locale);
  let content = plan.content.trim();
  let truncated = false;
  const max = chunkChars * SUMMARY_LIMITS.maxChunks;
  if (content.length > max) {
    content = content.slice(0, max);
    truncated = true;
  }
  let chunks = chunkText(content, chunkChars);
  if (chunks.length > SUMMARY_LIMITS.maxChunks) {
    chunks = chunks.slice(0, SUMMARY_LIMITS.maxChunks);
    truncated = true;
  }
  if (chunks.length <= 1) return { content, partial: false, parts: chunks.length, truncated, language };
  let partials = (
    await mapLimit(chunks, SUMMARY_LIMITS.parallel, (chunk, i) =>
      complete(chunkSummaryPrompt({ kind: plan.kind, content: chunk, part: i + 1, parts: chunks.length, language, title: plan.title })),
    )
  ).map((text, i) => `#### ${i + 1}/${chunks.length}\n${cleanAnswer(text)}`);
  // Still too long for one prompt: merge neighbours, level by level.
  for (let level = 0; level < 4 && partials.join("\n\n").length > chunkChars && partials.length > 1; level++) {
    const groups: string[][] = [[]];
    for (const partial of partials) {
      const group = groups[groups.length - 1];
      if (group.length >= 2 && [...group, partial].join("\n\n").length > chunkChars) groups.push([partial]);
      else group.push(partial);
    }
    partials = (
      await mapLimit(groups, SUMMARY_LIMITS.parallel, (group) =>
        group.length === 1 ? Promise.resolve(group[0]) : complete(combineSummaryPrompt({ kind: plan.kind, content: group.join("\n\n"), language })),
      )
    ).map(cleanAnswer);
  }
  return { content: partials.join("\n\n").slice(0, chunkChars * 2), partial: true, parts: chunks.length, truncated, language };
}

const input = z.object({
  pageId: z.uuid(),
  rowId: z.uuid().optional(),
  // A database view: its records in order (filters as the person sees them).
  rowIds: z.array(z.uuid()).max(20_000).optional(),
  // A voice note's transcript, to be inserted into this page.
  text: z.string().max(SUMMARY_LIMITS.maxText).optional(),
  locale: z.enum(["de", "en", "fr"]).default("de"),
});

// POST /api/ai/summarize → the summary as a text stream (lib/ai/run.ts),
// with X-Flowplan-AI-* headers: records included/asked for, parts.
export async function aiSummaryResponse(user: Identity, raw: unknown, signal: AbortSignal): Promise<Response> {
  const b = input.parse(raw);
  const page = requirePage(user, b.pageId);
  if (b.rowId) requireRow(user, b.pageId, b.rowId);
  const options: AiRunOptions = { workspaceId: page.workspace_id, pageId: page.id, rowId: b.rowId, signal };
  // Feature, person, provider and whether the AI may read the page/record.
  const resolved = requireAi(user, "summarize", options);
  const local = resolved.config.kind === "ollama" || isLocalProvider(resolved.config);
  const chunkChars = local ? SUMMARY_LIMITS.chunkChars.local : SUMMARY_LIMITS.chunkChars.remote;
  let plan: SummaryPlan;
  const headers: Record<string, string> = {};
  if (b.text !== undefined) {
    plan = { kind: "transcript", content: b.text, locale: b.locale };
  } else if (b.rowId) {
    plan = { kind: "record", content: await aiPageMarkdown(user, page, b.rowId), locale: b.locale };
  } else if (page.kind === "database") {
    const data = aiDatabaseText(user, page, b.rowIds, {
      maxRecords: SUMMARY_LIMITS.maxRecords,
      maxChars: chunkChars * SUMMARY_LIMITS.maxChunks,
      documentChars: SUMMARY_LIMITS.recordDocumentChars,
    });
    headers["X-Flowplan-AI-Included"] = String(data.included);
    headers["X-Flowplan-AI-Total"] = String(data.total);
    plan = {
      kind: "database",
      content: data.text,
      title: page.title,
      locale: b.locale,
      note:
        data.included < data.total
          ? `These are ${data.included} of ${data.total} records of the view; the others were left out (limit or not readable for the AI).`
          : `These are all ${data.total} records of the view.`,
    };
  } else {
    plan = { kind: "page", content: await aiPageMarkdown(user, page), title: page.title, locale: b.locale };
  }
  if (!plan.content.trim()) throw new HttpError(400, "Hier steht noch nichts, das sich zusammenfassen ließe.");
  const reduced = await reduceContent(plan, chunkChars, (prompt) => aiComplete(user, "summarize", prompt, options));
  headers["X-Flowplan-AI-Parts"] = String(reduced.parts);
  if (reduced.truncated) headers["X-Flowplan-AI-Truncated"] = "1";
  const response = await aiStreamResponse(
    user,
    "summarize",
    summaryPrompt({ ...plan, content: reduced.content, partial: reduced.partial, language: reduced.language }),
    { ...options, signal },
  );
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}
