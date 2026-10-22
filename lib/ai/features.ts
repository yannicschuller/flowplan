// The AI features an administrator allows or forbids one by one, and every
// person can turn off for themselves. Feature code names its id when it asks
// for a provider (resolveAi in lib/ai/resolve.ts, streamAi in
// lib/ai/client.ts). To add a feature: one entry here – the administration,
// the personal settings and the resolver pick it up from this list.
//
// Safe for the browser: no server imports.

// i18n-table: 1 – [German, English] pairs
export const AI_FEATURES = [
  {
    id: "write",
    label: ["Schreibassistent", "Writing assistant"],
    description: ["Texte im Editor fortsetzen, umformulieren, kürzen, übersetzen.", "Continue, rephrase, shorten and translate text in the editor."],
  },
  {
    id: "summarize",
    label: ["Zusammenfassungen", "Summaries"],
    description: ["Zusammenfassungen und Aufgaben aus Seiten, Datenbanken und Einträgen.", "Summaries and action items of pages, databases and records."],
  },
  {
    id: "ask",
    label: ["Fragen an den Arbeitsbereich", "Ask the workspace"],
    description: ["Fragen zu den Inhalten stellen, Antworten mit Quellen.", "Ask about the content and get answers with sources."],
  },
  {
    id: "database",
    label: ["KI in Datenbanken", "AI in databases"],
    description: ["KI-Eigenschaften, Felder ausfüllen, Datenbanken aus einer Beschreibung anlegen.", "AI properties, filling in fields, creating databases from a description."],
  },
  {
    id: "actions",
    label: ["KI-Aktionen", "AI actions"],
    description: [
      "Seiten, Aufgaben und Einträge aus Antworten und Transkripten vorschlagen – angelegt wird erst nach Bestätigung.",
      "Propose pages, tasks and records from answers and transcripts – nothing is created before you confirm.",
    ],
  },
] as const;

export type AiFeature = (typeof AI_FEATURES)[number]["id"];
export const AI_FEATURE_IDS = AI_FEATURES.map((f) => f.id) as AiFeature[];
export const isAiFeature = (value: unknown): value is AiFeature =>
  typeof value === "string" && (AI_FEATURE_IDS as string[]).includes(value);

// The provider kinds. "openai" covers every OpenAI-compatible server
// (OpenAI, Mistral, OpenRouter, LM Studio, vLLM, LocalAI …).
export const AI_PROVIDER_KINDS = ["ollama", "openai", "anthropic", "gemini"] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];
export const AI_PROVIDER_NAMES: Record<AiProviderKind, string> = {
  ollama: "Ollama",
  openai: "OpenAI-kompatibel",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};
export const AI_PROVIDER_NAMES_EN: Record<AiProviderKind, string> = {
  ollama: "Ollama",
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};
// Suggestions only – any model id can be typed.
export const AI_DEFAULTS: Record<AiProviderKind, { baseUrl: string; model: string; embeddingModel: string; keyRequired: boolean }> = {
  ollama: { baseUrl: "http://ollama:11434", model: "llama3.1", embeddingModel: "nomic-embed-text", keyRequired: false },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", embeddingModel: "text-embedding-3-small", keyRequired: false },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", embeddingModel: "", keyRequired: true },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", embeddingModel: "text-embedding-004", keyRequired: true },
};

// Why AI is not available (resolveAi → { ok: false, reason }).
export type AiReason =
  | "unknown-feature"
  | "demo"
  | "api-token"
  | "off"
  | "feature-off"
  | "not-allowed"
  | "guest"
  | "user-off"
  | "user-feature-off"
  | "no-provider"
  | "key-unreadable";
// i18n-table: 1 – [German, English] pairs
export const AI_REASON_TEXT: Record<AiReason, readonly [string, string]> = {
  "unknown-feature": ["Unbekannte KI-Funktion.", "Unknown AI feature."],
  demo: ["KI ist in der Demo nicht verfügbar.", "AI is not available in the demo."],
  "api-token": ["KI ist mit einem API-Token nicht verfügbar.", "AI is not available with an API token."],
  off: ["KI ist auf dieser Instanz ausgeschaltet.", "AI is switched off on this instance."],
  "feature-off": ["Diese KI-Funktion ist auf dieser Instanz ausgeschaltet.", "This AI feature is switched off on this instance."],
  "not-allowed": ["KI ist für dein Konto nicht freigegeben.", "AI is not enabled for your account."],
  guest: ["Für Gäste ist KI ausgeschaltet.", "AI is switched off for guests."],
  "user-off": ["Du hast KI in deinen Einstellungen ausgeschaltet.", "You switched AI off in your settings."],
  "user-feature-off": ["Du hast diese KI-Funktion in deinen Einstellungen ausgeschaltet.", "You switched this AI feature off in your settings."],
  "no-provider": ["Es ist kein KI-Anbieter eingerichtet.", "No AI provider is set up."],
  "key-unreadable": ["Der gespeicherte API-Schlüssel lässt sich nicht entschlüsseln. Bitte neu eingeben.", "The stored API key cannot be decrypted. Please enter it again."],
};

// What the browser learns (bootstrap → ai, GET /api/ai/settings → status).
export type AiStatus = {
  // At least one feature is usable.
  enabled: boolean;
  features: Record<AiFeature, { ok: boolean; reason?: AiReason }>;
  // The provider in use, null without one.
  provider: {
    kind: AiProviderKind;
    model: string;
    host: string;
    source: "instance" | "user";
    // Text stays on this server (or in its own network).
    local: boolean;
  } | null;
  // Whether the person may store an own provider.
  userProviders: boolean;
  // "all": everything the person may read; "selected": only included parts.
  scope: "all" | "selected";
  // Pages of this workspace (visible to the person) the AI may not read.
  excludedPages: string[];
};

// "Ollama · llama3.1 (lokal)" / "OpenAI-kompatibel · gpt-4.1 (api.openai.com)"
export function aiProviderLabel(
  provider: AiStatus["provider"],
  t: (de: string, en: string) => string,
) {
  if (!provider) return t("Kein Anbieter", "No provider");
  const name = t(AI_PROVIDER_NAMES[provider.kind], AI_PROVIDER_NAMES_EN[provider.kind]);
  const model = provider.model ? ` · ${provider.model}` : "";
  return provider.local ? `${name}${model} ${t("(lokal)", "(local)")}` : `${name}${model} (${provider.host})`;
}
