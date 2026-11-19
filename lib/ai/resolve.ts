// resolveAi: the only way a feature gets a provider. It applies, in order:
// demo and API tokens (never), the master switch, the feature switch of the
// administration, the "selected people" policy, guests, the person's own
// switches, and finally which provider – the instance's or the person's own
// (only when the administration allows own providers).
import { all, one } from "../db";
import { isGuest } from "../permissions";
import type { Identity } from "../types";
import { z } from "zod";
import { HttpError } from "../auth";
import { AI_DEFAULTS, AI_FEATURE_IDS, AI_PROVIDER_KINDS, AI_REASON_TEXT, DEVICE_AI_FEATURES, isAiFeature, type AiFeature, type AiReason, type AiStatus } from "./features";
import { aiDeviceExcludedPages, aiExcludedPages } from "./access";
import type { AiConfig } from "./providers";
import { featureAllowed, instanceAiSettings, instanceKey, normalizeUrl, userAiSettings, userAllowedByPolicy, userKey, type AiProviderSettings } from "./settings";
import { checkAiUrl } from "./transport";
import { privateAddress } from "../safe-fetch";
import { isIP } from "node:net";
import { mapAsync } from "../each-async";
import { tokenAiAllowed } from "./token-access";

export type AiResolution = { ok: true; config: AiConfig; source: "instance" | "user" } | { ok: false; reason: AiReason };
type Options = {
  // The workspace the feature works in: guests of it are judged by the guest switch.
  workspaceId?: string;
};

// Whether the person counts as a guest here. Without a workspace: when they
// are a full member of none.
async function guestHere(user: Identity, workspaceId?: string) {
  if (workspaceId) return await isGuest(user, workspaceId) || !(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", workspaceId, user.id));
  const memberships = await all<{ guest: number }>(
    "SELECT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id) guest FROM members m WHERE m.user_id=?",
    user.id,
  );
  return !memberships.some((m) => !m.guest);
}

// Everything but the provider: may this person use this feature?
async function gate(user: Identity, feature: string, options: Options): Promise<AiReason | null> {
  if (!isAiFeature(feature)) return "unknown-feature";
  if (user.demo) return "demo";
  const instance = await instanceAiSettings();
  // API tokens only with the "KI und Transkription" permission, while the
  // administration allows it (lib/ai/token-access.ts).
  if (user.apiScope && !tokenAiAllowed(user, instance)) return "api-token";
  if (!instance.enabled) return "off";
  if (!featureAllowed(instance, feature)) return "feature-off";
  if (!(await userAllowedByPolicy(user.id, instance))) return "not-allowed";
  if (!instance.guests && await guestHere(user, options.workspaceId)) return "guest";
  const own = await userAiSettings(user.id);
  if (!own.enabled) return "user-off";
  if (own.features[feature] === false) return "user-feature-off";
  return null;
}

// The on-device model in the apps (lib/ai/device.ts): no provider, nothing
// reaches the server – so neither the master switch nor a demo counts, but
// the administration's own switch for it, the feature switches, the
// "selected people" policy, guests and every switch of the person (AI off,
// the feature off, on-device AI off) do.
export async function deviceGate(user: Identity, feature: string, options: Options = {}): Promise<AiReason | null> {
  if (!isAiFeature(feature) || !DEVICE_AI_FEATURES.includes(feature)) return "unknown-feature";
  if (user.apiScope) return "api-token";
  const instance = await instanceAiSettings();
  if (!instance.device) return "off";
  if (!featureAllowed(instance, feature)) return "feature-off";
  if (!(await userAllowedByPolicy(user.id, instance))) return "not-allowed";
  if (!instance.guests && await guestHere(user, options.workspaceId)) return "guest";
  const own = await userAiSettings(user.id);
  if (!own.enabled || own.device === "off") return "user-off";
  if (own.features[feature] === false) return "user-feature-off";
  return null;
}

const configured = (p: AiProviderSettings | null): p is AiProviderSettings => !!p && !!p.model.trim();
type Built = { ok: true; config: AiConfig } | { ok: false; reason: AiReason };
// The instance provider as a config (also for the administration's tests).
export async function instanceProviderConfig(): Promise<Built> {
  const p = (await instanceAiSettings()).provider;
  if (!configured(p)) return { ok: false, reason: "no-provider" };
  const key = await instanceKey();
  if (key.unreadable) return { ok: false, reason: "key-unreadable" };
  if (AI_DEFAULTS[p.kind].keyRequired && !key.key) return { ok: false, reason: "no-provider" };
  return { ok: true, config: { ...p, baseUrl: p.baseUrl || AI_DEFAULTS[p.kind].baseUrl, apiKey: key.key || undefined, trusted: true } };
}
// The person's own provider: public https addresses only (trusted: false).
export async function userProviderConfig(user: Identity): Promise<Built> {
  const p = (await userAiSettings(user.id)).provider;
  if (!(await instanceAiSettings()).userProviders || !configured(p)) return { ok: false, reason: "no-provider" };
  const key = await userKey(user.id);
  if (key.unreadable) return { ok: false, reason: "key-unreadable" };
  if (AI_DEFAULTS[p.kind].keyRequired && !key.key) return { ok: false, reason: "no-provider" };
  return { ok: true, config: { ...p, baseUrl: p.baseUrl || AI_DEFAULTS[p.kind].baseUrl, apiKey: key.key || undefined, trusted: false } };
}
// A provider as typed in the settings form, not yet saved – only to list
// its models ("Modelle abrufen", #290). The same reach as the saved one:
// the instance's may be private or http (trusted), a person's own only
// public https (checked again by aiFetch on every connection). Without a
// typed key the saved key is used, but only for exactly the saved kind and
// address – a stored key never goes to another host.
const draftInput = z.object({
  provider: z.object({ kind: z.enum(AI_PROVIDER_KINDS), baseUrl: z.string().trim().max(500) }),
  // A typed key; null: explicitly none; absent or empty: the saved one.
  apiKey: z.string().trim().max(1000).regex(/^[\x21-\x7e]*$/, "Ungültiger API-Schlüssel.").nullable().optional(),
});
export async function draftProviderConfig(user: Identity, scope: "instance" | "user", raw: unknown): Promise<AiConfig> {
  const b = draftInput.parse(raw);
  const trusted = scope === "instance";
  const instance = await instanceAiSettings();
  if (!trusted && !instance.userProviders) throw new HttpError(403, "Eigene KI-Anbieter sind auf dieser Instanz nicht erlaubt.");
  const { kind } = b.provider;
  const baseUrl = b.provider.baseUrl || AI_DEFAULTS[kind].baseUrl;
  checkAiUrl(baseUrl, trusted);
  let apiKey = b.apiKey || undefined;
  if (!apiKey && b.apiKey !== null) {
    const saved = trusted ? instance.provider : (await userAiSettings(user.id)).provider;
    if (saved && saved.kind === kind && normalizeUrl(kind, saved.baseUrl) === normalizeUrl(kind, baseUrl)) {
      const key = trusted ? await instanceKey() : await userKey(user.id);
      if (key.unreadable) throw new HttpError(409, AI_REASON_TEXT["key-unreadable"][0]);
      apiKey = key.key || undefined;
    }
  }
  return { kind, baseUrl, model: "", apiKey, trusted };
}
// Which provider applies: the person's own when they chose it, else the
// instance's, else their own as the only one there is.
async function provider(user: Identity): Promise<AiResolution> {
  const own = await userAiSettings(user.id);
  const mine = await userProviderConfig(user);
  const instance = await instanceProviderConfig();
  if (own.source === "user" && mine.ok) return { ...mine, source: "user" };
  if (instance.ok) return { ...instance, source: "instance" };
  if (mine.ok) return { ...mine, source: "user" };
  return { ok: false, reason: !mine.ok && mine.reason === "key-unreadable" ? mine.reason : !instance.ok ? instance.reason : "no-provider" };
}

// Whose provider this person's AI uses (null: none) – the AI quota
// (lib/ai/quota.ts) applies to the instance's only.
export async function aiProviderSource(user: Identity): Promise<"instance" | "user" | null> {
  const resolved = await provider(user);
  return resolved.ok ? resolved.source : null;
}

export async function resolveAi(user: Identity, feature: AiFeature | string, options: Options = {}): Promise<AiResolution> {
  const reason = await gate(user, feature, options);
  if (reason) return { ok: false, reason };
  return await provider(user);
}

// Text stays on the server or in its own network: Ollama or another server
// at a private, local or single-label address (compose service names).
export function isLocalProvider(config: { kind: string; baseUrl: string }) {
  let host = "";
  try {
    host = new URL(config.baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (isIP(host)) return privateAddress(host);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || !host.includes(".");
}

// For the browser (bootstrap): which features work, with which provider,
// and which pages of this workspace the AI may not read. No keys, no URLs
// beyond the host name.
export async function aiStatus(user: Identity, workspaceId?: string, visiblePages: { id: string }[] = [], storedPages?: Parameters<typeof aiExcludedPages>[2]): Promise<AiStatus> {
  const features = Object.fromEntries(AI_FEATURE_IDS.map((id) => [id, { ok: false }])) as AiStatus["features"];
  const own = await userAiSettings(user.id);
  const instance = await instanceAiSettings();
  let resolved: AiResolution | null = null;
  for (const id of AI_FEATURE_IDS) {
    const reason = await gate(user, id, { workspaceId });
    if (reason) {
      features[id] = { ok: false, reason };
      continue;
    }
    resolved ??= (await provider(user));
    features[id] = resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason };
  }
  const enabled = AI_FEATURE_IDS.some((id) => features[id].ok);
  const deviceFeatures = Object.fromEntries(await mapAsync(DEVICE_AI_FEATURES, async (id) => [id, !(await deviceGate(user, id, { workspaceId }))])) as Partial<Record<AiFeature, boolean>>;
  const device = Object.values(deviceFeatures).some(Boolean);
  // One pass for both: what the device may not read is a part of what the
  // server's AI may not.
  const excluded = (enabled || device) && workspaceId ? (await aiExcludedPages(user, visiblePages, storedPages?.workspaceId === workspaceId ? storedPages : undefined)) : [];
  const config = resolved?.ok ? resolved.config : null;
  let host = "";
  try {
    host = config ? new URL(config.baseUrl).hostname : "";
  } catch {}
  return {
    enabled,
    features,
    provider: config && resolved?.ok ? { kind: config.kind, model: config.model, host, source: resolved.source, local: isLocalProvider(config) } : null,
    userProviders: !user.demo && !user.apiScope && instance.enabled && instance.userProviders,
    scope: own.scope,
    excludedPages: enabled ? excluded : [],
    device: device ? { mode: own.device === "fallback" ? "fallback" : "prefer", features: deviceFeatures, excludedPages: await aiDeviceExcludedPages(user, excluded) } : null,
  };
}
