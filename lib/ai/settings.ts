// Stored AI settings: the instance's (Administration → KI) and each
// person's (Settings → KI). API keys are kept only sealed (lib/ai/secrets.ts)
// in their own columns, are written but never read back by any view, and
// are deleted whenever the provider's kind or address changes – a stored
// key can never be sent to another host.
//
// Environment variables are the defaults until an administrator saves:
//   FLOWPLAN_AI=on                      master switch
//   FLOWPLAN_AI_PROVIDER=ollama|openai|anthropic|gemini
//   FLOWPLAN_AI_BASE_URL / OLLAMA_URL   address of the provider
//   FLOWPLAN_AI_MODEL, FLOWPLAN_AI_EMBEDDING_MODEL
//   FLOWPLAN_AI_API_KEY / _FILE         never stored; used only while the
//                                       provider equals the one from the environment
//   FLOWPLAN_AI_ACCESS=everyone|selected, FLOWPLAN_AI_GUESTS=on,
//   FLOWPLAN_AI_USER_PROVIDERS=on, FLOWPLAN_AI_FEATURES=write,summarize,…
//   FLOWPLAN_AI_SEMANTIC_SEARCH=on      semantic search ("ask") with the
//                                       instance's embedding model
//   FLOWPLAN_AI_DEVICE=off              no on-device AI in the apps (Apple's
//                                       model; on unless switched off)
import { readFileSync } from "node:fs";
import { z } from "zod";
import { HttpError } from "../auth";
import { all, audit, one, run } from "../db";
import { requireAdmin } from "../permissions";
import type { Identity } from "../types";
import { AI_DEFAULTS, AI_FEATURE_IDS, AI_PROVIDER_KINDS, DEVICE_AI_MODES, type AiFeature, type AiProviderKind } from "./features";
import { keyHint, openSecret, sealSecret, secretsKeySource } from "./secrets";
import { checkAiUrl } from "./transport";

const providerSchema = z.object({
  kind: z.enum(AI_PROVIDER_KINDS),
  baseUrl: z.string().trim().max(500),
  model: z.string().trim().max(200),
  embeddingModel: z.string().trim().max(200).default(""),
});
export type AiProviderSettings = z.infer<typeof providerSchema>;
const featureFlags = z.object(Object.fromEntries(AI_FEATURE_IDS.map((id) => [id, z.boolean().optional()])) as Record<AiFeature, z.ZodOptional<z.ZodBoolean>>);
const instanceSchema = z.object({
  enabled: z.boolean(),
  provider: providerSchema.nullable(),
  access: z.enum(["everyone", "selected"]),
  guests: z.boolean(),
  userProviders: z.boolean(),
  features: featureFlags,
  // Semantic search for "ask": embeddings of the workspace content with the
  // instance's embedding model (lib/ai/semantic.ts). Off unless switched on.
  semanticSearch: z.boolean().default(false),
  // Apple's on-device model in the apps for the light actions (lib/ai/
  // device.ts): independent of the switch above – nothing reaches this
  // server or a provider. On unless switched off.
  device: z.boolean().default(true),
});
export type AiInstanceSettings = z.infer<typeof instanceSchema>;
const userSchema = z.object({
  enabled: z.boolean(),
  features: featureFlags,
  source: z.enum(["instance", "user"]),
  scope: z.enum(["all", "selected"]),
  provider: providerSchema.nullable(),
  // The on-device model (features.ts DEVICE_AI_MODES).
  device: z.enum(DEVICE_AI_MODES).default("prefer"),
});
export type AiUserSettings = z.infer<typeof userSchema>;

const on = (value: string | undefined) => /^(1|on|true|yes)$/i.test(value?.trim() || "");
// API keys go into HTTP headers: printable ASCII only, no spaces.
const apiKeySchema = z.string().trim().min(8).max(1000).regex(/^[\x21-\x7e]+$/, "Ungültiger API-Schlüssel.");
const sameEndpoint = (a: { kind: string; baseUrl: string }, b: { kind: string; baseUrl: string }) =>
  a.kind === b.kind && normalizeUrl(a.kind as AiProviderKind, a.baseUrl) === normalizeUrl(b.kind as AiProviderKind, b.baseUrl);
export const normalizeUrl = (kind: AiProviderKind, url: string) => (url.trim() || AI_DEFAULTS[kind].baseUrl).replace(/\/+$/, "").toLowerCase();

// ---- Environment ----

function envProvider(): AiProviderSettings | null {
  const raw = process.env.FLOWPLAN_AI_PROVIDER?.trim().toLowerCase();
  const kind = (AI_PROVIDER_KINDS as readonly string[]).includes(raw || "") ? (raw as AiProviderKind) : process.env.OLLAMA_URL?.trim() ? "ollama" : null;
  if (!kind) return null;
  return {
    kind,
    baseUrl: process.env.FLOWPLAN_AI_BASE_URL?.trim() || (kind === "ollama" ? process.env.OLLAMA_URL?.trim() : "") || AI_DEFAULTS[kind].baseUrl,
    model: process.env.FLOWPLAN_AI_MODEL?.trim() || AI_DEFAULTS[kind].model,
    embeddingModel: process.env.FLOWPLAN_AI_EMBEDDING_MODEL?.trim() ?? AI_DEFAULTS[kind].embeddingModel,
  };
}
function envKey(): string {
  let key = process.env.FLOWPLAN_AI_API_KEY?.trim() || "";
  const file = process.env.FLOWPLAN_AI_API_KEY_FILE?.trim();
  if (!key && file)
    try {
      key = readFileSync(file, "utf8").trim();
    } catch {
      console.error("FLOWPLAN_AI_API_KEY_FILE kann nicht gelesen werden.");
    }
  return key;
}
function envDefaults(): AiInstanceSettings {
  const listed = process.env.FLOWPLAN_AI_FEATURES?.trim();
  const features = listed ? listed.split(",").map((s) => s.trim()) : AI_FEATURE_IDS;
  return {
    enabled: on(process.env.FLOWPLAN_AI),
    provider: envProvider(),
    access: process.env.FLOWPLAN_AI_ACCESS?.trim() === "selected" ? "selected" : "everyone",
    guests: on(process.env.FLOWPLAN_AI_GUESTS),
    userProviders: on(process.env.FLOWPLAN_AI_USER_PROVIDERS),
    semanticSearch: on(process.env.FLOWPLAN_AI_SEMANTIC_SEARCH),
    device: !/^(0|off|false|no)$/i.test(process.env.FLOWPLAN_AI_DEVICE?.trim() || ""),
    features: Object.fromEntries(AI_FEATURE_IDS.map((id) => [id, features.includes(id)])) as Record<AiFeature, boolean>,
  };
}

// ---- Instance ----

type Row = { config: string; key_cipher: string | null; key_hint: string };
const instanceRow = async () => await one<Row>("SELECT config,key_cipher,key_hint FROM ai_instance WHERE id=1");
// Read on every use (route handlers run as separate module instances).
export async function instanceAiSettings(): Promise<AiInstanceSettings> {
  const defaults = envDefaults();
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse((await instanceRow())?.config || "{}");
  } catch {}
  const parsed = instanceSchema.safeParse({ ...defaults, ...stored, features: { ...defaults.features, ...((stored.features as object) || {}) } });
  return parsed.success ? parsed.data : defaults;
}
export const featureAllowed = (settings: AiInstanceSettings, feature: AiFeature) => settings.features[feature] !== false;

// The instance key: stored (sealed) or from the environment while the
// provider is the environment's one.
export async function instanceKey(): Promise<{ key: string; source: "stored" | "env" | null; unreadable: boolean }> {
  const row = await instanceRow();
  if (row?.key_cipher) {
    try {
      return { key: openSecret(row.key_cipher, "ai-key:instance"), source: "stored", unreadable: false };
    } catch {
      return { key: "", source: "stored", unreadable: true };
    }
  }
  const provider = (await instanceAiSettings()).provider,
    env = envProvider(),
    key = envKey();
  if (key && provider && env && sameEndpoint(provider, env)) return { key, source: "env", unreadable: false };
  return { key: "", source: null, unreadable: false };
}

async function saveInstanceRow(config: AiInstanceSettings, keyCipher: string | null, hint: string) {
  await run(
    "INSERT INTO ai_instance(id,config,key_cipher,key_hint,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,key_cipher=excluded.key_cipher,key_hint=excluded.key_hint,updated_at=excluded.updated_at",
    JSON.stringify(config),
    keyCipher,
    hint,
    Date.now(),
  );
}

const adminInput = z.object({
  settings: z.unknown().optional(),
  // A new key, null to remove it, absent to keep it.
  apiKey: apiKeySchema.nullable().optional(),
});
export async function saveInstanceAi(user: Identity, raw: unknown) {
  assertSettingsCaller(user);
  requireAdmin(user);
  const b = adminInput.parse(raw);
  const current = await instanceAiSettings();
  const incoming = (b.settings && typeof b.settings === "object" ? b.settings : {}) as Record<string, unknown>;
  const next = instanceSchema.parse({
    ...current,
    ...incoming,
    features: { ...current.features, ...((incoming.features as object) || {}) },
  });
  if (next.provider?.baseUrl) checkAiUrl(next.provider.baseUrl, true);
  const row = await instanceRow();
  let cipher = row?.key_cipher ?? null,
    hint = row?.key_hint ?? "";
  // Another kind or address: the stored key is gone.
  const moved = !!cipher && (!next.provider || !current.provider || !sameEndpoint(next.provider, current.provider));
  if (moved || b.apiKey === null) {
    cipher = null;
    hint = "";
  }
  if (typeof b.apiKey === "string") {
    if (!next.provider) throw new HttpError(400, "Bitte zuerst einen KI-Anbieter wählen.");
    cipher = sealSecret(b.apiKey, "ai-key:instance");
    hint = keyHint(b.apiKey);
  }
  await saveInstanceRow(next, cipher, hint);
  await audit(user.id, "admin.ai", "instance", JSON.stringify({ enabled: next.enabled, device: next.device, provider: next.provider?.kind || null, key: typeof b.apiKey === "string" ? "replaced" : moved || b.apiKey === null ? "removed" : "kept" }));
  return await adminAiView();
}

// Who may use AI when access is "selected".
export async function setUserAiPolicy(user: Identity, raw: unknown) {
  assertSettingsCaller(user);
  requireAdmin(user);
  const b = z.object({ userId: z.uuid().or(z.string().min(1).max(100)), allowed: z.boolean() }).parse(raw);
  if (!(await one("SELECT 1 FROM users WHERE id=?", b.userId))) throw new HttpError(404, "Benutzer nicht gefunden.");
  await run("INSERT INTO ai_user_policy(user_id,allowed) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET allowed=excluded.allowed", b.userId, b.allowed ? 1 : 0);
  await audit(user.id, "admin.aiUser", b.userId, b.allowed ? "allowed" : "denied");
  return { ok: true, allowed: await aiAllowedUsers() };
}
export const aiAllowedUsers = async () => (await all<{ user_id: string }>("SELECT user_id FROM ai_user_policy WHERE allowed=1")).map((r) => r.user_id);
export async function userAllowedByPolicy(userId: string, settings?: Awaited<ReturnType<typeof instanceAiSettings>>) {
  if (settings === undefined) settings = await instanceAiSettings();
  if (settings.access === "everyone") return true;
  return !!(await one("SELECT 1 FROM ai_user_policy WHERE user_id=? AND allowed=1", userId));
}

// What the administration sees: never the key, only whether one is there.
export async function adminAiView() {
  const settings = await instanceAiSettings();
  const row = await instanceRow();
  const key = await instanceKey();
  const env = envProvider();
  let secrets: string = "file";
  try {
    secrets = secretsKeySource();
  } catch {}
  return {
    settings,
    key: { stored: !!row?.key_cipher, hint: row?.key_cipher ? row.key_hint : "", fromEnv: key.source === "env", unreadable: key.unreadable },
    env: { provider: env ? { kind: env.kind, baseUrl: env.baseUrl } : null, key: !!envKey() },
    secretsKey: secrets,
    allowedUsers: await aiAllowedUsers(),
  };
}

// ---- Per person ----

const defaultUser = (): AiUserSettings => ({
  enabled: true,
  features: {} as Record<AiFeature, boolean>,
  source: "instance",
  scope: "all",
  provider: null,
  device: "prefer",
});
type UserRow = Row & { user_id: string };
const userRow = async (userId: string) => await one<UserRow>("SELECT user_id,config,key_cipher,key_hint FROM ai_user_settings WHERE user_id=?", userId);
export async function userAiSettings(userId: string): Promise<AiUserSettings> {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse((await userRow(userId))?.config || "{}");
  } catch {}
  const parsed = userSchema.safeParse({ ...defaultUser(), ...stored });
  return parsed.success ? parsed.data : defaultUser();
}
export const userAiKeyAad = (userId: string) => `ai-key:user:${userId}`;
export async function userKey(userId: string): Promise<{ key: string; stored: boolean; unreadable: boolean }> {
  const row = await userRow(userId);
  if (!row?.key_cipher) return { key: "", stored: false, unreadable: false };
  try {
    return { key: openSecret(row.key_cipher, userAiKeyAad(userId)), stored: true, unreadable: false };
  } catch {
    return { key: "", stored: true, unreadable: true };
  }
}
async function saveUserRow(userId: string, settings: AiUserSettings, cipher: string | null, hint: string) {
  await run(
    "INSERT INTO ai_user_settings(user_id,config,key_cipher,key_hint,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET config=excluded.config,key_cipher=excluded.key_cipher,key_hint=excluded.key_hint,updated_at=excluded.updated_at",
    userId,
    JSON.stringify(settings),
    cipher,
    hint,
    Date.now(),
  );
}

// AI settings are changed only in a signed-in browser session: never with
// an API token, never in a demo.
export function assertSettingsCaller(user: Identity) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
}

const prefsInput = z.object({
  enabled: z.boolean().optional(),
  features: featureFlags.optional(),
  source: z.enum(["instance", "user"]).optional(),
  scope: z.enum(["all", "selected"]).optional(),
  device: z.enum(DEVICE_AI_MODES).optional(),
});
export async function saveUserAiPrefs(user: Identity, raw: unknown) {
  assertSettingsCaller(user);
  const b = prefsInput.parse(raw);
  const current = await userAiSettings(user.id);
  const row = await userRow(user.id);
  const next = userSchema.parse({
    ...current,
    ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
    features: { ...current.features, ...(b.features || {}) },
  });
  await saveUserRow(user.id, next, row?.key_cipher ?? null, row?.key_hint ?? "");
  return { ok: true };
}

const providerInput = z.object({
  provider: providerSchema.nullable(),
  apiKey: apiKeySchema.nullable().optional(),
});
// The person's own provider (only when the administration allows it).
// Removing it is always possible.
export async function saveUserAiProvider(user: Identity, raw: unknown) {
  assertSettingsCaller(user);
  const b = providerInput.parse(raw);
  const current = await userAiSettings(user.id);
  const row = await userRow(user.id);
  if (b.provider && !(await instanceAiSettings()).userProviders)
    throw new HttpError(403, "Eigene KI-Anbieter sind auf dieser Instanz nicht erlaubt.");
  // Own providers are only reached through public https addresses.
  if (b.provider) checkAiUrl(b.provider.baseUrl || AI_DEFAULTS[b.provider.kind].baseUrl, false);
  let cipher = row?.key_cipher ?? null,
    hint = row?.key_hint ?? "";
  const moved = !!cipher && (!b.provider || !current.provider || !sameEndpoint(b.provider, current.provider));
  if (moved || b.apiKey === null) {
    cipher = null;
    hint = "";
  }
  if (typeof b.apiKey === "string") {
    if (!b.provider) throw new HttpError(400, "Bitte zuerst einen KI-Anbieter wählen.");
    cipher = sealSecret(b.apiKey, userAiKeyAad(user.id));
    hint = keyHint(b.apiKey);
  }
  const next = { ...current, provider: b.provider, ...(b.provider ? {} : { source: "instance" as const }) };
  await saveUserRow(user.id, next, cipher, hint);
  await audit(user.id, "ai.provider", user.id, JSON.stringify({ provider: b.provider?.kind || null, key: typeof b.apiKey === "string" ? "replaced" : moved || b.apiKey === null ? "removed" : "kept" }));
  return { ok: true };
}

export async function userKeyInfo(userId: string) {
  const row = await userRow(userId);
  const key = await userKey(userId);
  return { stored: !!row?.key_cipher, hint: row?.key_cipher ? row.key_hint : "", unreadable: key.unreadable };
}
