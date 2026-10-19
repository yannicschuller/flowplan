// Flowplan AI core – the contract for AI features.
//
// Everything is off by default. An administrator switches AI on
// (Administration → KI), sets the instance provider (Ollama, an
// OpenAI-compatible server, Anthropic or Google Gemini), decides who may use
// it (everyone / selected people, guests or not), whether people may bring
// their own provider and key, and which features are allowed. Every person
// can turn features off for themselves (Settings → KI) and decide what the
// AI may read.
//
// FEATURE IDS (lib/ai/features.ts): "write" | "summarize" | "ask" | "database".
// Add new ones there; administration and settings pick them up.
//
// SERVER
//   resolveAi(user, feature, { workspaceId })
//     → { ok: true, config, source: "instance" | "user" } | { ok: false, reason }
//     The ONLY way to get a provider config. Never build an AiConfig yourself.
//   requireAi(user, feature, { workspaceId, pageId?, rowId? })
//     Same, but throws a localized HttpError; with pageId also checks access.
//   aiStream(user, feature, { system, messages, maxTokens, temperature },
//            { workspaceId, pageId?, rowId?, signal }) → AsyncGenerator<string>
//   aiComplete(…same…) → Promise<string>
//   aiStreamResponse(…same…, { signal: req.signal }) → Promise<Response>
//     For your own route: checks, rate limit (lib/action-limits.ts limitAi),
//     size limits (AI_LIMITS), streams plain text, aborts the provider call
//     when the client disconnects.
//   embedTexts(user, feature, texts, { workspaceId }) → number[][] | null
//     null when the provider (Anthropic) or the configuration has no embeddings.
//   aiStatus(user, workspaceId, visiblePages) → AiStatus (also in the
//     bootstrap as `ai`).
//
// WHAT THE AI MAY READ – mandatory for every feature (lib/ai/access.ts)
//   aiMayRead(user, pageId, rowId?) → boolean
//   aiFilter(user, [{ pageId, rowId? }, …]) → the readable items (batch)
//   aiReadablePages(user, pageIds) → Set<string>
//   requireAiRead(user, pageId, rowId?) → throws 403 "Diese Seite ist für die KI gesperrt."
//   Check BEFORE any content goes into a prompt: the current page (write,
//   summarize – also for a text selection), retrieval/search results (ask),
//   records (database). Never readable: pages the person cannot read,
//   private records hidden from them, trashed pages, journals with a PIN
//   (even unlocked), pages/spaces a manager marked "Für KI gesperrt", and
//   what the person excluded (rules per workspace, space, page, database;
//   inherited downwards; the closest rule wins, exclusion beats inclusion;
//   scope "selected" = only what is included).
//
// HTTP
//   POST /api/ai/run   { feature, workspaceId, pageId?, rowId?, system?,
//                        messages: [{ role: "user"|"assistant", content }],
//                        maxTokens?, temperature? }
//     → 200 text/plain stream; errors before the first piece as JSON
//       { error } with status 4xx/5xx; a late error appends U+001E and
//       JSON { error } (use streamAi from lib/ai/client.ts).
//     Session + origin check (CSRF); API tokens and demo are refused.
//     Pass pageId/rowId whenever the prompt contains that page's content.
//   GET  /api/ai/access?page=…&row=…  → { readable, reason }
//
// CLIENT (lib/ai/client.ts)
//   aiUsable(boot.ai, feature), aiPageReadable(boot.ai, pageId),
//   aiProviderLabel(boot.ai.provider, t), aiReasonText(reason, t),
//   streamAi({ feature, workspaceId, pageId?, system?, messages, signal?,
//              onText? }) → Promise<string>
//   Show the provider label where people trigger AI ("Ollama · llama3.1
//   (lokal)") and say whether text leaves the server (provider.local).
//
// KEYS are sealed (lib/ai/secrets.ts), write-only and never returned by any
// view, export, log or error (lib/ai/redact.ts). Features never see them
// except inside the AiConfig they pass straight to lib/ai/providers.ts.
import type { Identity } from "../types";
import type { AiFeature } from "./features";
import { embed } from "./providers";
import { requireAi, type AiRunOptions } from "./run";
import { limitAi } from "../action-limits";

export * from "./features";
export { resolveAi, aiStatus, isLocalProvider, type AiResolution } from "./resolve";
export { aiMayRead, aiFilter, aiReadablePages, requireAiRead, aiPageAccess, AI_BLOCKED_MESSAGE, type AiTarget } from "./access";
export { aiStream, aiComplete, aiStreamResponse, requireAi, AI_LIMITS, AI_STREAM_ERROR_MARK, type AiRunInput, type AiRunOptions } from "./run";
export type { AiConfig, ChatMessage, ChatInput } from "./providers";
export { redactSecrets } from "./redact";

// Vectors for the texts with the person's provider (rate-limited like a
// prompt), or null without embedding support.
export async function embedTexts(user: Identity, feature: AiFeature, texts: string[], options: AiRunOptions = {}) {
  const resolved = requireAi(user, feature, options);
  limitAi(user.id);
  return embed(resolved.config, texts, options.signal);
}
