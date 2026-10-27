// The four provider formats behind one interface:
//   streamChat(config, input)  → AsyncIterable<string>  text as it arrives
//   complete(config, input)    → Promise<string>        the same, collected
//   embed(config, texts)       → number[][] | null      null: not supported/configured
//   listModels(config)         → string[]
//   testConnection(config)     → { models, reply, ms }
//   pullModel(config, model)   → progress of an Ollama download
// Configs come only from resolveAi (lib/ai/resolve.ts) or, for the
// administration's tests, from the stored settings. Errors are AiError
// (HttpError) with a German message that never contains the key.
import { AI_DEFAULTS, type AiProviderKind } from "./features";
import { redactSecrets } from "./redact";
import { estimateTokens, noteAiUsage } from "../metrics";
import { AI_MESSAGES, AiError, aiFetch, lines, sseEvents, type AiResponse } from "./transport";

export type AiConfig = {
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  embeddingModel?: string;
  apiKey?: string;
  // Set by an administrator (may reach private addresses, may use http).
  trusted: boolean;
};
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatInput = {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  // Filled with the tokens the provider reports (where it does) – for the
  // usage statistics (lib/metrics.ts).
  usage?: TokenUsage;
};
export type TokenUsage = { input?: number; output?: number };

// Upper bounds for what comes back.
export const MAX_OUTPUT_CHARS = 200_000;
const MAX_STREAM_BYTES = 20_000_000;
const MAX_EMBED_TEXTS = 256;
const MAX_EMBED_CHARS = 32_000;

const base = (config: AiConfig) => (config.baseUrl || AI_DEFAULTS[config.kind].baseUrl).trim().replace(/\/+$/, "");
const geminiModel = (model: string) => encodeURIComponent(model.replace(/^models\//, ""));

function headers(config: AiConfig): Record<string, string> {
  const key = config.apiKey?.trim();
  if (config.kind === "anthropic") return { ...(key ? { "x-api-key": key } : {}), "anthropic-version": "2023-06-01" };
  if (config.kind === "gemini") return key ? { "x-goog-api-key": key } : {};
  return key ? { authorization: `Bearer ${key}` } : {};
}

// A failed response as a message without secrets.
async function failure(config: AiConfig, response: AiResponse): Promise<never> {
  let detail = "";
  try {
    const text = await response.text(64_000);
    try {
      const data = JSON.parse(text);
      const error = data?.error ?? data?.message ?? data?.detail;
      detail = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
    } catch {
      detail = /<html/i.test(text) ? "" : text;
    }
  } catch {}
  detail = redactSecrets(detail, [config.apiKey]).replace(/\s+/g, " ").trim().slice(0, 300);
  const status = response.status;
  if (status === 401 || status === 403)
    throw new AiError(502, "Der KI-Anbieter lehnt den Zugang ab – API-Schlüssel fehlt oder ist ungültig.");
  if (status === 429) throw new AiError(429, "Der KI-Anbieter meldet zu viele Anfragen. Bitte später erneut versuchen.");
  if (detail) throw new AiError(502, `Der KI-Anbieter meldet: ${detail}`);
  if (status === 404) throw new AiError(502, "Modell oder Adresse beim KI-Anbieter nicht gefunden.");
  throw new AiError(502, `Der KI-Anbieter meldet einen Fehler (HTTP ${status}).`);
}
function streamError(config: AiConfig, error: unknown): never {
  const message = typeof error === "string" ? error : typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : "";
  const clean = redactSecrets(message, [config.apiKey]).replace(/\s+/g, " ").trim().slice(0, 300);
  throw new AiError(502, clean ? `Der KI-Anbieter meldet: ${clean}` : AI_MESSAGES.garbled);
}
const parse = (config: AiConfig, text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError(502, AI_MESSAGES.garbled);
  }
};

// Claude models that think on every request (adaptive thinking by default).
const THINKING_CLAUDE = /^claude-(opus-5|sonnet-5-5|haiku-5|fable|mythos)/;

function chatRequest(config: AiConfig, input: ChatInput): { url: string; body: unknown } {
  const maxTokens = Math.max(1, Math.min(16_384, Math.round(input.maxTokens ?? 1024)));
  const temperature = input.temperature === undefined ? undefined : Math.max(0, Math.min(config.kind === "anthropic" ? 1 : 2, input.temperature));
  const messages = input.messages.map((m) => ({ role: m.role, content: m.content }));
  switch (config.kind) {
    case "ollama":
      return {
        url: `${base(config)}/api/chat`,
        body: {
          model: config.model,
          stream: true,
          messages: input.system ? [{ role: "system", content: input.system }, ...messages] : messages,
          options: { num_predict: maxTokens, ...(temperature === undefined ? {} : { temperature }) },
        },
      };
    case "openai": {
      // api.openai.com wants max_completion_tokens; compatible servers max_tokens.
      const official = /^https:\/\/([^/]+\.)?openai\.com(\/|$)/i.test(base(config));
      return {
        url: `${base(config)}/chat/completions`,
        body: {
          model: config.model,
          stream: true,
          messages: input.system ? [{ role: "system", content: input.system }, ...messages] : messages,
          ...(official ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
          ...(temperature === undefined ? {} : { temperature }),
        },
      };
    }
    case "anthropic":
      return {
        url: `${base(config)}/v1/messages`,
        body: {
          model: config.model,
          stream: true,
          // Models that always think count their thinking in max_tokens:
          // room for it, so the answer is not cut off (only what is
          // written is billed).
          max_tokens: THINKING_CLAUDE.test(config.model) ? maxTokens + 16_000 : maxTokens,
          ...(input.system ? { system: input.system } : {}),
          messages,
          // Current Claude models refuse sampling settings (HTTP 400), and
          // the API drops them for every model: never sent.
        },
      };
    case "gemini":
      return {
        url: `${base(config)}/v1beta/models/${geminiModel(config.model)}:streamGenerateContent?alt=sse`,
        body: {
          contents: input.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
          generationConfig: { maxOutputTokens: maxTokens, ...(temperature === undefined ? {} : { temperature }) },
        },
      };
  }
}

const tokens = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined);

// The text pieces of one provider's stream; the token counts it reports go
// into `usage`.
async function* pieces(config: AiConfig, body: AsyncIterable<Buffer>, usage: TokenUsage = {}): AsyncGenerator<string> {
  if (config.kind === "ollama") {
    for await (const line of lines(body, MAX_STREAM_BYTES)) {
      if (!line.trim()) continue;
      const data = parse(config, line);
      if (data.error) streamError(config, data.error);
      if (typeof data.message?.content === "string") yield data.message.content;
      if (data.done) {
        usage.input = tokens(data.prompt_eval_count) ?? usage.input;
        usage.output = tokens(data.eval_count) ?? usage.output;
        return;
      }
    }
    return;
  }
  for await (const { event, data: raw } of sseEvents(body, MAX_STREAM_BYTES)) {
    if (raw === "[DONE]") return;
    const data = parse(config, raw);
    if (data?.error || event === "error") streamError(config, data?.error ?? data);
    if (config.kind === "openai") {
      const text = data?.choices?.[0]?.delta?.content;
      if (typeof text === "string") yield text;
      if (data?.usage) {
        usage.input = tokens(data.usage.prompt_tokens) ?? usage.input;
        usage.output = tokens(data.usage.completion_tokens) ?? usage.output;
      }
    } else if (config.kind === "anthropic") {
      if (data?.type === "content_block_delta" && data.delta?.type === "text_delta" && typeof data.delta.text === "string") yield data.delta.text;
      if (data?.type === "message_start") usage.input = tokens(data.message?.usage?.input_tokens) ?? usage.input;
      if (data?.type === "message_delta") usage.output = tokens(data.usage?.output_tokens) ?? usage.output;
      if (data?.type === "message_stop") return;
    } else {
      for (const part of data?.candidates?.[0]?.content?.parts || [])
        if (typeof part?.text === "string" && !part.thought) yield part.text;
      if (data?.usageMetadata) {
        usage.input = tokens(data.usageMetadata.promptTokenCount) ?? usage.input;
        usage.output = tokens(data.usageMetadata.candidatesTokenCount) ?? usage.output;
      }
    }
  }
}

export async function* streamChat(config: AiConfig, input: ChatInput): AsyncGenerator<string> {
  if (!config.model?.trim()) throw new AiError(400, "Für den KI-Anbieter ist kein Modell eingetragen.");
  const { url, body } = chatRequest(config, input);
  const response = await aiFetch(url, {
    method: "POST",
    headers: { ...headers(config), accept: config.kind === "ollama" ? "application/x-ndjson" : "text/event-stream" },
    body: JSON.stringify(body),
    signal: input.signal,
    trusted: config.trusted,
    // A local model may first have to be loaded.
    headersTimeout: config.kind === "ollama" ? 300_000 : 120_000,
    idleTimeout: 120_000,
  });
  if (response.status < 200 || response.status >= 300) await failure(config, response);
  let size = 0;
  for await (const piece of pieces(config, response.body, input.usage)) {
    if (input.signal?.aborted) throw new AiError(499, AI_MESSAGES.aborted);
    if (!piece) continue;
    size += piece.length;
    if (size > MAX_OUTPUT_CHARS) throw new AiError(502, AI_MESSAGES.tooLarge);
    yield piece;
  }
}

export async function complete(config: AiConfig, input: ChatInput): Promise<string> {
  let text = "";
  for await (const piece of streamChat(config, input)) text += piece;
  return text;
}

async function getJson(config: AiConfig, url: string, signal?: AbortSignal) {
  const response = await aiFetch(url, { method: "GET", headers: headers(config), trusted: config.trusted, signal, headersTimeout: 30_000, idleTimeout: 30_000 });
  if (response.status < 200 || response.status >= 300) await failure(config, response);
  return parse(config, await response.text(5_000_000));
}
async function postJson(config: AiConfig, url: string, body: unknown, signal?: AbortSignal) {
  const response = await aiFetch(url, { method: "POST", headers: headers(config), body: JSON.stringify(body), trusted: config.trusted, signal, headersTimeout: 120_000, idleTimeout: 120_000 });
  if (response.status < 200 || response.status >= 300) await failure(config, response);
  return parse(config, await response.text(MAX_STREAM_BYTES));
}

// Vectors for texts, or null when the provider has none (Anthropic) or no
// embedding model is set.
export async function embed(config: AiConfig, texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
  const model = config.embeddingModel?.trim();
  if (!model || config.kind === "anthropic") return null;
  if (texts.length > MAX_EMBED_TEXTS) throw new AiError(413, "Zu viele Texte auf einmal.");
  const input = texts.map((t) => t.slice(0, MAX_EMBED_CHARS));
  if (!input.length) return [];
  let vectors: unknown;
  if (config.kind === "ollama") vectors = (await postJson(config, `${base(config)}/api/embed`, { model, input }, signal))?.embeddings;
  else if (config.kind === "openai") {
    const data = (await postJson(config, `${base(config)}/embeddings`, { model, input }, signal))?.data;
    vectors = Array.isArray(data) ? [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map((d) => d?.embedding) : null;
  } else {
    const name = model.replace(/^models\//, "");
    const data = await postJson(
      config,
      `${base(config)}/v1beta/models/${geminiModel(name)}:batchEmbedContents`,
      { requests: input.map((text) => ({ model: `models/${name}`, content: { parts: [{ text }] } })) },
      signal,
    );
    vectors = Array.isArray(data?.embeddings) ? data.embeddings.map((e: { values?: unknown }) => e?.values) : null;
  }
  if (!Array.isArray(vectors) || vectors.length !== input.length || !vectors.every((v) => Array.isArray(v) && v.every((n) => typeof n === "number")))
    throw new AiError(502, AI_MESSAGES.garbled);
  noteAiUsage("embeddings", estimateTokens(input.reduce((sum, t) => sum + t.length, 0)), 0);
  return vectors as number[][];
}

export async function listModels(config: AiConfig, signal?: AbortSignal): Promise<string[]> {
  let names: unknown[] = [];
  if (config.kind === "ollama") names = ((await getJson(config, `${base(config)}/api/tags`, signal))?.models || []).map((m: { name?: unknown }) => m?.name);
  else if (config.kind === "openai") names = ((await getJson(config, `${base(config)}/models`, signal))?.data || []).map((m: { id?: unknown }) => m?.id);
  else if (config.kind === "anthropic") names = ((await getJson(config, `${base(config)}/v1/models?limit=100`, signal))?.data || []).map((m: { id?: unknown }) => m?.id);
  else
    names = ((await getJson(config, `${base(config)}/v1beta/models?pageSize=200`, signal))?.models || []).map((m: { name?: unknown }) =>
      typeof m?.name === "string" ? m.name.replace(/^models\//, "") : null,
    );
  return [...new Set(names.filter((n): n is string => typeof n === "string" && n.length > 0 && n.length < 200))].sort().slice(0, 500);
}

// Lists the models and, with a model set, asks for a word – so address,
// key and model are all checked.
export async function testConnection(config: AiConfig, signal?: AbortSignal) {
  const started = Date.now();
  let models: string[] = [];
  let listError = "";
  try {
    models = await listModels(config, signal);
  } catch (error) {
    // Some OpenAI-compatible servers have no model list; the reply decides.
    if (!config.model || (error as AiError).status === 429 || /Zugang ab/.test((error as Error).message)) throw error;
    listError = (error as Error).message;
  }
  let reply = "";
  if (config.model) reply = (await complete(config, { messages: [{ role: "user", content: "Reply with the single word: OK" }], maxTokens: 16, signal })).trim().slice(0, 100);
  return { ok: true as const, models, reply, ms: Date.now() - started, modelListed: !models.length || models.includes(config.model), listError };
}

// Ollama only: downloads a model, reporting progress.
export async function* pullModel(config: AiConfig, model: string, signal?: AbortSignal): AsyncGenerator<{ status: string; completed?: number; total?: number }> {
  if (config.kind !== "ollama") throw new AiError(400, "Modelle lassen sich nur bei Ollama herunterladen.");
  const response = await aiFetch(`${base(config)}/api/pull`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ model, stream: true }),
    trusted: config.trusted,
    signal,
    headersTimeout: 60_000,
    idleTimeout: 600_000,
  });
  if (response.status < 200 || response.status >= 300) await failure(config, response);
  for await (const line of lines(response.body, 50_000_000)) {
    if (!line.trim()) continue;
    const data = parse(config, line);
    if (data.error) streamError(config, data.error);
    yield {
      status: String(data.status || "").slice(0, 200),
      ...(typeof data.completed === "number" ? { completed: data.completed } : {}),
      ...(typeof data.total === "number" ? { total: data.total } : {}),
    };
  }
}
