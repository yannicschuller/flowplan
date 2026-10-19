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
  const response = await fetch("/api/ai/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new AiRequestError(serverMessage(data?.error || "Die KI-Anfrage ist fehlgeschlagen."), response.status);
  }
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
