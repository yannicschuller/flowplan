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
import { estimateTokens, noteAiCall } from "../metrics";
import { shiftArea } from "../server-metrics";
import { one } from "../db";
import { AI_MESSAGES } from "./transport";
import { redactSecrets } from "./redact";
import { resolveAi } from "./resolve";
import { takeAiSlot } from "./concurrency";
import { recordQuotaUsage, requireQuota } from "./quota";

export const AI_LIMITS = {
  maxMessages: 100,
  // System prompt and messages together (roughly 50 000 tokens).
  maxPromptChars: 200_000,
  maxTokens: 8192,
  // Parallel answers per person – across all instances in cluster mode
  // (lib/ai/concurrency.ts).
  concurrent: 3,
  // Pictures in a prompt (lib/ai/handwriting.ts): per request, and the
  // base64 characters of each.
  images: 2,
  imageChars: 4_000_000,
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
  // The request took its slot of the AI rate limit before its preparation
  // (lib/ai/ask.ts prepareAsk): not counted a second time.
  charged?: boolean;
  // The tokens a request used (as reported, else estimated) – workflows
  // count them against their own budget (lib/workflows/nodes/ai.ts).
  onUsage?: (input: number, output: number) => void;
};
const inputSchema = z.object({
  system: z.string().max(AI_LIMITS.maxPromptChars).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(AI_LIMITS.maxPromptChars),
        images: z
          .array(z.object({ mime: z.enum(["image/png", "image/jpeg"]), data: z.string().min(1).max(AI_LIMITS.imageChars).regex(/^[A-Za-z0-9+/]+={0,2}$/) }))
          .max(AI_LIMITS.images)
          .optional(),
      }),
    )
    .min(1)
    .max(AI_LIMITS.maxMessages),
  maxTokens: z.number().int().min(1).max(AI_LIMITS.maxTokens).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

// A failed provider call as the statistics count it: a timeout (no answer
// in time: 504/408 or the transport's timeout) or another error.
export function aiFailureKind(error: unknown): "error" | "timeout" {
  const status = (error as { status?: number })?.status;
  const message = String((error as Error)?.message || "");
  return status === 504 || status === 408 || message === AI_MESSAGES.timeout || (error as Error)?.name === "TimeoutError" ? "timeout" : "error";
}

// Throws the reason when the feature is not available for this person.
export async function requireAi(user: Identity, feature: AiFeature, options: AiRunOptions = {}) {
  const resolved = await resolveAi(user, feature, { workspaceId: options.workspaceId });
  if (!resolved.ok) throw new HttpError(resolved.reason === "no-provider" || resolved.reason === "key-unreadable" ? 409 : 403, AI_REASON_TEXT[resolved.reason][0]);
  if (options.pageId) await requireAiRead(user, options.pageId, options.rowId);
  return resolved;
}

// The answer as it arrives. Every check happens before the first request.
export async function* aiStream(user: Identity, feature: AiFeature, raw: AiRunInput, options: AiRunOptions = {}): AsyncGenerator<string> {
  const resolved = await requireAi(user, feature, options);
  const input = inputSchema.parse(raw);
  const size = (input.system?.length || 0) + input.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (size > AI_LIMITS.maxPromptChars) throw new HttpError(413, "Der Text für die KI ist zu lang.");
  if (input.messages.reduce((n, m) => n + (m.images?.length || 0), 0) > AI_LIMITS.images) throw new HttpError(413, "Zu viele Bilder für die KI.");
  if (!options.charged) limitAi(user.id);
  // The AI quota (#382, lib/ai/quota.ts): only the instance's provider
  // counts. The estimate – the prompt and the most the answer may take –
  // must fit, else nothing is sent – or, once the person's limit is used
  // up and a rule says so, it goes with the model the rule names.
  const quota = resolved.source === "instance" ? await requireQuota(user, { feature, model: resolved.config.model, tokensIn: estimateTokens(size), tokensOut: input.maxTokens ?? 1024 }) : null;
  const config = quota?.model ? { ...resolved.config, model: quota.model } : resolved.config;
  const release = await takeAiSlot(user.id, AI_LIMITS.concurrent);
  if (!release) {
    quota?.release();
    throw new HttpError(429, "Zu viele KI-Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  }
  // Tokens per feature for the monitoring (lib/metrics.ts): as reported by
  // the provider, else estimated from the characters.
  const usage: TokenUsage = {};
  let written = 0;
  // In detail (Administration → KI → Statistik): model, provider,
  // workspace and person, errors, timeouts and the time to the answer's end.
  const started = Date.now();
  let failure: "error" | "timeout" | null = null;
  // The CPU of the request counts as AI while the answer streams.
  const area = shiftArea("api", "ai");
  try {
    for await (const piece of streamChat(config, { ...input, signal: options.signal, usage })) {
      written += piece.length;
      yield piece;
    }
  } catch (error) {
    // A request the person cancelled is no failure of the provider.
    if (!options.signal?.aborted) failure = aiFailureKind(error);
    throw error;
  } finally {
    area();
    // Tokens only for answered requests (a provider that was not reached used nothing).
    const answered = !!written || usage.input !== undefined || usage.output !== undefined;
    const tokensIn = usage.input ?? estimateTokens(size),
      tokensOut = usage.output ?? estimateTokens(written);
    if (answered) options.onUsage?.(tokensIn, tokensOut);
    if (answered || failure) {
      let workspaceId = options.workspaceId || null;
      if (!workspaceId && options.pageId)
        try {
          workspaceId = (await one<{ workspace_id: string }>("SELECT workspace_id FROM pages WHERE id=?", options.pageId))?.workspace_id || null;
        } catch {}
      noteAiCall({ feature, tokensIn, tokensOut, answered, failure, ms: Date.now() - started, model: config.model, source: resolved.source, workspaceId, userId: user.id });
    }
    if (answered && resolved.source === "instance")
      await recordQuotaUsage({ userId: user.id, kind: feature === "workflows" ? "workflow" : "person", model: config.model, tokensIn, tokensOut });
    quota?.release();
    release();
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
// How long a streaming response waits for the first piece of the answer
// before it starts anyway (see aiStreamResponse).
const FIRST_PIECE_WAIT_MS = 8_000;

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
  // Errors before the first piece answer with a status. But a model that
  // thinks first (or is still loading) may write nothing for a minute, and a
  // reverse proxy closes a request without response headers long before: so
  // after a few seconds the response starts anyway, and a later error ends
  // the text with the error mark.
  const pending = iterator.next();
  let first: IteratorResult<string> | null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    first = await Promise.race([pending, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), FIRST_PIECE_WAIT_MS)))]);
  } catch (error) {
    options.signal.removeEventListener("abort", abort);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!first) pending.catch(() => {});
  const encoder = new TextEncoder();
  const clean = (text: string) => text.replaceAll(AI_STREAM_ERROR_MARK, "");
  let done = !!first?.done;
  let waiting: Promise<IteratorResult<string>> | null = first ? null : pending;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      if (first && !first.done && first.value) c.enqueue(encoder.encode(clean(first.value)));
      if (done) {
        options.signal.removeEventListener("abort", abort);
        c.close();
      }
    },
    async pull(c) {
      if (done) return;
      try {
        const next = await (waiting ?? iterator.next());
        waiting = null;
        if (next.done) {
          done = true;
          options.signal.removeEventListener("abort", abort);
          c.close();
          return;
        }
        if (next.value) c.enqueue(encoder.encode(clean(next.value)));
      } catch (error) {
        done = true;
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
