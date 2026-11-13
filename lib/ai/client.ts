// Browser side of the AI core: is a feature usable, may the AI read this
// page, and streaming an answer from POST /api/ai/run (see lib/ai/index.ts).
import { serverMessage } from "../i18n-errors";
import { rememberUpgrade } from "../upgrade-hint";
import { AI_REASON_TEXT, type AiFeature, type AiReason, type AiStatus } from "./features";
import type { DatabaseNote } from "./database-note";
import type { ResolvedTitle } from "./title-links";

export { aiProviderLabel, AI_FEATURES, type AiFeature, type AiStatus } from "./features";

const MARK = "\u001e";

// Whether the feature can be used (boot.ai from the bootstrap).
export const aiUsable = (status: AiStatus | null | undefined, feature: AiFeature) => !!status?.features[feature]?.ok;
// Whether the AI may read this page (false: show "KI hat keinen Zugriff").
export const aiPageReadable = (status: AiStatus | null | undefined, pageId: string) => !!status?.enabled && !status.excludedPages.includes(pageId);
export const aiReasonText = (reason: AiReason | undefined, t: (de: string, en: string) => string) =>
  reason ? t(AI_REASON_TEXT[reason][0], AI_REASON_TEXT[reason][1]) : "";

export class AiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export type StreamAiOptions = {
  feature: AiFeature;
  workspaceId: string;
  // The page or record whose content is in the prompt.
  pageId?: string;
  rowId?: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  // Abort to stop the answer (and the provider).
  signal?: AbortSignal;
  // Called with each piece and the text so far.
  onText?: (piece: string, text: string) => void;
};

// Streams the answer; resolves with the whole text. Rejects with
// AiRequestError (localized message), or an AbortError when aborted.
export async function streamAi({ signal, onText, ...body }: StreamAiOptions): Promise<string> {
  return streamAiFrom("/api/ai/run", body, { signal, onText });
}

// The same for the other AI endpoints that answer with a text stream
// (/api/ai/write, /api/ai/summarize). `onResponse` sees the response
// before the text (headers such as X-Flowplan-AI-Included).
export async function streamAiFrom(
  url: string,
  body: Record<string, unknown>,
  { signal, onText, onResponse }: { signal?: AbortSignal; onText?: (piece: string, text: string) => void; onResponse?: (response: Response) => void } = {},
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    const message = serverMessage(data?.error || "Die KI-Anfrage ist fehlgeschlagen.");
    rememberUpgrade(message, data);
    throw new AiRequestError(message, response.status);
  }
  onResponse?.(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "",
    tail = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (tail || chunk.includes(MARK)) {
        const [piece, rest = ""] = (tail ? "" : chunk).split(MARK);
        if (piece) {
          text += piece;
          onText?.(piece, text);
        }
        tail += tail ? chunk : MARK + rest;
        continue;
      }
      text += chunk;
      onText?.(chunk, text);
    }
  } finally {
    reader.releaseLock();
  }
  if (tail) {
    let message = "Die KI-Anfrage ist fehlgeschlagen.";
    try {
      message = JSON.parse(tail.slice(MARK.length)).error || message;
    } catch {}
    throw new AiRequestError(serverMessage(message), 502);
  }
  return text;
}

// ---- Ask the workspace (POST /api/ai/ask, lib/ai/ask.ts) ----

// Sources of kind "help" are sections of the Flowplan help: no pageId, a url.
export type AskSource = { n: number; pageId: string; rowId?: string; title: string; pageTitle?: string; kind: string; workspaceId?: string; workspaceName?: string; url?: string };
export type AskScope = { kind: "workspace" } | { kind: "page"; pageId: string } | { kind: "space"; spaceId: string } | { kind: "all" } | { kind: "help" };
// Opens a help source on docs.flowplan.org; only that address is trusted.
export const helpSourceUrl = (s: AskSource) => (s.kind === "help" && s.url?.startsWith("https://docs.flowplan.org/") ? s.url : null);
export type AskOptions = {
  workspaceId: string;
  question: string;
  // Earlier turns of the conversation (the server keeps none).
  history: { role: "user" | "assistant"; content: string }[];
  scope: AskScope;
  // "Diese Seite": the open page goes along in full (#135).
  page?: { pageId: string };
  signal?: AbortSignal;
  // The numbered sources, as soon as they are known (before the answer).
  onSources?: (sources: AskSource[], semantic: boolean) => void;
  onText?: (piece: string, text: string) => void;
};
function decodeSources(header: string | null): AskSource[] {
  if (!header) return [];
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
    const list = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(list) ? list.filter((s) => s && typeof s.n === "number" && typeof s.pageId === "string" && typeof s.title === "string") : [];
  } catch {
    return [];
  }
}
// `page`: whether the open page went along in full or cut to fit the model.
export async function askAi({ signal, onText, onSources, ...body }: AskOptions): Promise<{ text: string; sources: AskSource[]; page: "full" | "truncated" | null }> {
  let sources: AskSource[] = [];
  let page: "full" | "truncated" | null = null;
  const text = await streamAiFrom("/api/ai/ask", body, {
    signal,
    onText,
    onResponse: (response) => {
      sources = decodeSources(response.headers.get("X-Flowplan-Sources"));
      const included = response.headers.get("X-Flowplan-Page");
      page = included === "full" || included === "truncated" ? included : null;
      onSources?.(sources, response.headers.get("X-Flowplan-Semantic") === "1");
    },
  });
  return { text, sources, page };
}

// The conversation about the open page as suggested changes in it (#135,
// POST /api/ai/ask/suggest): how many the model proposed, how many are in
// the page now and how many could not be applied.
export type PageSuggestResult = { proposed: number; applied: number; failed: number; reasons: string[] };
export async function suggestPageChanges(body: { workspaceId: string; pageId: string; history: { role: "user" | "assistant"; content: string }[] }, signal?: AbortSignal) {
  return postJson<PageSuggestResult>("/api/ai/ask/suggest", body, signal);
}

// Plain page titles of an answer → the pages they name (#134,
// lib/ai/title-links.ts).
export async function resolveTitleLinks(pageId: string, titles: string[], signal?: AbortSignal): Promise<ResolvedTitle[]> {
  if (!titles.length) return [];
  return (await postJson<{ resolved: ResolvedTitle[] }>("/api/ai/links/resolve", { pageId, titles }, signal)).resolved || [];
}

// An answer split into text and citations: "… [1][2]" → parts with numbers
// that exist among the sources (others stay text).
export function citationParts(text: string, sources: AskSource[]): ({ text: string } | { cite: number })[] {
  const parts: ({ text: string } | { cite: number })[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g)) {
    const numbers = match[1].split(",").map((n) => Number(n.trim()));
    if (!numbers.every((n) => sources.some((s) => s.n === n))) continue;
    if (match.index! > last) parts.push({ text: text.slice(last, match.index) });
    for (const n of numbers) parts.push({ cite: n });
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// The chips under an answer (#180): the sources the answer cites stay in
// view, the others go behind a toggle; an answer that cites none shows the
// first few. Both keep the order (and so the [n] numbers) of the sources.
export const SOURCES_SHOWN = 3;
export function splitSources(text: string, sources: AskSource[]): { shown: AskSource[]; hidden: AskSource[] } {
  if (sources.length <= SOURCES_SHOWN) return { shown: sources, hidden: [] };
  const cited = new Set(citationParts(text, sources).flatMap((p) => ("cite" in p ? [p.cite] : [])));
  const visible = cited.size ? (s: AskSource) => cited.has(s.n) : (_: AskSource, i: number) => i < SOURCES_SHOWN;
  return { shown: sources.filter(visible), hidden: sources.filter((s, i) => !visible(s, i)) };
}

// ---- Handwriting → text (POST /api/ai/handwriting, lib/ai/handwriting.ts) ----

// The plain text of handwriting in a PNG (base64) of a lasso selection.
export async function recognizeHandwritingAi(body: { pageId: string; image: string }, signal?: AbortSignal) {
  return (await postJson<{ text: string }>("/api/ai/handwriting", body, signal)).text || "";
}

// ---- AI actions (POST /api/ai/actions/{propose,run}, lib/ai/actions.ts) ----

export type { ActionPreview, ActionResult } from "./actions";
import type { ActionPreview, ActionResult } from "./actions";

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new AiRequestError(serverMessage(data?.error || "Die KI-Anfrage ist fehlgeschlagen."), response.status);
  return data as T;
}
export type ProposeActionsOptions = {
  workspaceId: string;
  instruction: string;
  context?: string;
  pageId?: string | null;
  sources?: { pageId: string; rowId?: string | null }[];
  mode?: "general" | "transcript";
  signal?: AbortSignal;
};
// The model's proposal, checked by the server: nothing is written yet.
export async function proposeAiActions({ signal, ...body }: ProposeActionsOptions) {
  const local = new Date();
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  const answer = await postJson<{ actions: ActionPreview[]; databases?: DatabaseNote[] }>("/api/ai/actions/propose", { ...body, today }, signal);
  return { actions: answer.actions, databases: answer.databases || [] };
}
// Runs the confirmed actions (checked again on the server).
export async function runAiActions(workspaceId: string, actions: unknown[]) {
  return (await postJson<{ results: ActionResult[] }>("/api/ai/actions/run", { workspaceId, actions })).results;
}
