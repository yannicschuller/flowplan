// Running a prompt for a feature: resolve the provider, check what may be
// read, limit size and rate, stream the answer – and stop the provider as
// soon as the person goes away.
import { z } from "zod";
import { HttpError } from "../auth";
import { limitAi } from "../action-limits";
import type { Identity } from "../types";
import { requireAiRead } from "./access";
import { AI_REASON_TEXT, type AiFeature } from "./features";
import { streamChat, type ChatMessage, type TokenUsage } from "./providers";
import { estimateTokens, noteAiUsage } from "../metrics";
import { redactSecrets } from "./redact";
import { resolveAi } from "./resolve";

export const AI_LIMITS = {
  maxMessages: 100,
  // System prompt and messages together (roughly 50 000 tokens).
  maxPromptChars: 200_000,
  maxTokens: 8192,
  // Parallel answers per person.
  concurrent: 3,
} as const;

export type AiRunInput = {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
};
export type AiRunOptions = {
  workspaceId?: string;
  // The page (or record) whose content is in the prompt: refused when the
  // AI may not read it (lib/ai/access.ts).
  pageId?: string;
  rowId?: string | null;
  signal?: AbortSignal;
};
const inputSchema = z.object({
  system: z.string().max(AI_LIMITS.maxPromptChars).optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(AI_LIMITS.maxPromptChars) }))
    .min(1)
    .max(AI_LIMITS.maxMessages),
  maxTokens: z.number().int().min(1).max(AI_LIMITS.maxTokens).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const running = new Map<string, number>();

// Throws the reason when the feature is not available for this person.
export function requireAi(user: Identity, feature: AiFeature, options: AiRunOptions = {}) {
  const resolved = resolveAi(user, feature, { workspaceId: options.workspaceId });
  if (!resolved.ok) throw new HttpError(resolved.reason === "no-provider" || resolved.reason === "key-unreadable" ? 409 : 403, AI_REASON_TEXT[resolved.reason][0]);
  if (options.pageId) requireAiRead(user, options.pageId, options.rowId);
  return resolved;
}

// The answer as it arrives. Every check happens before the first request.
export async function* aiStream(user: Identity, feature: AiFeature, raw: AiRunInput, options: AiRunOptions = {}): AsyncGenerator<string> {
  const resolved = requireAi(user, feature, options);
  const input = inputSchema.parse(raw);
  const size = (input.system?.length || 0) + input.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (size > AI_LIMITS.maxPromptChars) throw new HttpError(413, "Der Text für die KI ist zu lang.");
  limitAi(user.id);
  const count = running.get(user.id) || 0;
  if (count >= AI_LIMITS.concurrent) throw new HttpError(429, "Zu viele KI-Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  running.set(user.id, count + 1);
  // Tokens per feature for the monitoring (lib/metrics.ts): as reported by
  // the provider, else estimated from the characters.
  const usage: TokenUsage = {};
  let written = 0;
  try {
    for await (const piece of streamChat(resolved.config, { ...input, signal: options.signal, usage })) {
      written += piece.length;
      yield piece;
    }
  } finally {
    // Only answered requests (a provider that was not reached used nothing).
    if (written || usage.input !== undefined || usage.output !== undefined)
      noteAiUsage(feature, usage.input ?? estimateTokens(size), usage.output ?? estimateTokens(written));
    const left = (running.get(user.id) || 1) - 1;
    if (left > 0) running.set(user.id, left);
    else running.delete(user.id);
  }
}

// The whole answer at once (server-side features).
export async function aiComplete(user: Identity, feature: AiFeature, input: AiRunInput, options: AiRunOptions = {}) {
  let text = "";
  for await (const piece of aiStream(user, feature, input, options)) text += piece;
  return text;
}

// Separates the answer from a late error in the plain-text stream.
export const AI_STREAM_ERROR_MARK = "\u001e";

// A streaming HTTP response: plain UTF-8 text. Errors before the first
// piece answer with JSON { error } and a status like every other route; an
// error later ends the text with U+001E followed by JSON { error }
// (lib/ai/client.ts reads both). The provider call stops when the request
// is aborted (the browser went away) or the stream is cancelled.
export async function aiStreamResponse(
  user: Identity,
  feature: AiFeature,
  input: AiRunInput,
  options: AiRunOptions & { signal: AbortSignal },
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  const iterator = aiStream(user, feature, input, { ...options, signal: controller.signal })[Symbol.asyncIterator]();
  let first: IteratorResult<string>;
  try {
    first = await iterator.next();
  } catch (error) {
    options.signal.removeEventListener("abort", abort);
    throw error;
  }
  const encoder = new TextEncoder();
  const clean = (text: string) => text.replaceAll(AI_STREAM_ERROR_MARK, "");
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      if (!first.done && first.value) c.enqueue(encoder.encode(clean(first.value)));
      if (first.done) {
        options.signal.removeEventListener("abort", abort);
        c.close();
      }
    },
    async pull(c) {
      if (first.done) return;
      try {
        const next = await iterator.next();
        if (next.done) {
          options.signal.removeEventListener("abort", abort);
          c.close();
          return;
        }
        if (next.value) c.enqueue(encoder.encode(clean(next.value)));
      } catch (error) {
        options.signal.removeEventListener("abort", abort);
        if (controller.signal.aborted) {
          try {
            c.close();
          } catch {}
          return;
        }
        const message = error instanceof HttpError ? error.message : "Die KI-Anfrage ist fehlgeschlagen.";
        if (!(error instanceof HttpError)) console.error("KI-Anfrage fehlgeschlagen:", redactSecrets(String((error as Error)?.message || error)));
        c.enqueue(encoder.encode(AI_STREAM_ERROR_MARK + JSON.stringify({ error: message })));
        c.close();
      }
    },
    cancel() {
      controller.abort();
      void iterator.return?.(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
