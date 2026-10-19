// Browser side of the AI core: is a feature usable, may the AI read this
// page, and streaming an answer from POST /api/ai/run (see lib/ai/index.ts).
import { serverMessage } from "../i18n-errors";
import { AI_REASON_TEXT, type AiFeature, type AiReason, type AiStatus } from "./features";

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
  return streamText("/api/ai/run", body, { signal, onText });
}

// A plain-text answer stream from one of the AI routes (see lib/ai/run.ts).
async function streamText(
  url: string,
  body: unknown,
  { signal, onText, onResponse }: { signal?: AbortSignal; onText?: (piece: string, text: string) => void; onResponse?: (response: Response) => void },
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new AiRequestError(serverMessage(data?.error || "Die KI-Anfrage ist fehlgeschlagen."), response.status);
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

export type AskSource = { n: number; pageId: string; rowId?: string; title: string; pageTitle?: string; kind: string };
export type AskScope = { kind: "workspace" } | { kind: "page"; pageId: string } | { kind: "space"; spaceId: string };
export type AskOptions = {
  workspaceId: string;
  question: string;
  // Earlier turns of the conversation (the server keeps none).
  history: { role: "user" | "assistant"; content: string }[];
  scope: AskScope;
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
export async function askAi({ signal, onText, onSources, ...body }: AskOptions): Promise<{ text: string; sources: AskSource[] }> {
  let sources: AskSource[] = [];
  const text = await streamText("/api/ai/ask", body, {
    signal,
    onText,
    onResponse: (response) => {
      sources = decodeSources(response.headers.get("X-Flowplan-Sources"));
      onSources?.(sources, response.headers.get("X-Flowplan-Semantic") === "1");
    },
  });
  return { text, sources };
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
