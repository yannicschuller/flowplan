// resolveAi: the only way a feature gets a provider. It applies, in order:
// demo and API tokens (never), the master switch, the feature switch of the
// administration, the "selected people" policy, guests, the person's own
// switches, and finally which provider – the instance's or the person's own
// (only when the administration allows own providers).
import { all, one } from "../db";
import { isGuest } from "../permissions";
import type { Identity } from "../types";
import { AI_DEFAULTS, AI_FEATURE_IDS, DEVICE_AI_FEATURES, isAiFeature, type AiFeature, type AiReason, type AiStatus } from "./features";
import { aiDeviceExcludedPages, aiExcludedPages } from "./access";
import type { AiConfig } from "./providers";
import { featureAllowed, instanceAiSettings, instanceKey, userAiSettings, userAllowedByPolicy, userKey, type AiProviderSettings } from "./settings";
import { privateAddress } from "../safe-fetch";
import { isIP } from "node:net";

export type AiResolution = { ok: true; config: AiConfig; source: "instance" | "user" } | { ok: false; reason: AiReason };
type Options = {
  // The workspace the feature works in: guests of it are judged by the guest switch.
  workspaceId?: string;
};

// Whether the person counts as a guest here. Without a workspace: when they
// are a full member of none.
function guestHere(user: Identity, workspaceId?: string) {
  if (workspaceId) return isGuest(user, workspaceId) || !one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", workspaceId, user.id);
  const memberships = all<{ guest: number }>(
    "SELECT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id) guest FROM members m WHERE m.user_id=?",
    user.id,
  );
  return !memberships.some((m) => !m.guest);
}

// Everything but the provider: may this person use this feature?
function gate(user: Identity, feature: string, options: Options): AiReason | null {
  if (!isAiFeature(feature)) return "unknown-feature";
  if (user.demo) return "demo";
  if (user.apiScope) return "api-token";
  const instance = instanceAiSettings();
  if (!instance.enabled) return "off";
  if (!featureAllowed(instance, feature)) return "feature-off";
  if (!userAllowedByPolicy(user.id, instance)) return "not-allowed";
  if (!instance.guests && guestHere(user, options.workspaceId)) return "guest";
  const own = userAiSettings(user.id);
  if (!own.enabled) return "user-off";
  if (own.features[feature] === false) return "user-feature-off";
  return null;
}

// The on-device model in the apps (lib/ai/device.ts): no provider, nothing
// reaches the server – so neither the master switch nor a demo counts, but
// the administration's own switch for it, the feature switches, the
// "selected people" policy, guests and every switch of the person (AI off,
// the feature off, on-device AI off) do.
export function deviceGate(user: Identity, feature: string, options: Options = {}): AiReason | null {
  if (!isAiFeature(feature) || !DEVICE_AI_FEATURES.includes(feature)) return "unknown-feature";
  if (user.apiScope) return "api-token";
  const instance = instanceAiSettings();
  if (!instance.device) return "off";
  if (!featureAllowed(instance, feature)) return "feature-off";
  if (!userAllowedByPolicy(user.id, instance)) return "not-allowed";
  if (!instance.guests && guestHere(user, options.workspaceId)) return "guest";
  const own = userAiSettings(user.id);
  if (!own.enabled || own.device === "off") return "user-off";
  if (own.features[feature] === false) return "user-feature-off";
  return null;
}

const configured = (p: AiProviderSettings | null): p is AiProviderSettings => !!p && !!p.model.trim();
type Built = { ok: true; config: AiConfig } | { ok: false; reason: AiReason };
// The instance provider as a config (also for the administration's tests).
export function instanceProviderConfig(): Built {
  const p = instanceAiSettings().provider;
  if (!configured(p)) return { ok: false, reason: "no-provider" };
  const key = instanceKey();
  if (key.unreadable) return { ok: false, reason: "key-unreadable" };
  if (AI_DEFAULTS[p.kind].keyRequired && !key.key) return { ok: false, reason: "no-provider" };
  return { ok: true, config: { ...p, baseUrl: p.baseUrl || AI_DEFAULTS[p.kind].baseUrl, apiKey: key.key || undefined, trusted: true } };
}
// The person's own provider: public https addresses only (trusted: false).
export function userProviderConfig(user: Identity): Built {
  const p = userAiSettings(user.id).provider;
  if (!instanceAiSettings().userProviders || !configured(p)) return { ok: false, reason: "no-provider" };
  const key = userKey(user.id);
  if (key.unreadable) return { ok: false, reason: "key-unreadable" };
  if (AI_DEFAULTS[p.kind].keyRequired && !key.key) return { ok: false, reason: "no-provider" };
  return { ok: true, config: { ...p, baseUrl: p.baseUrl || AI_DEFAULTS[p.kind].baseUrl, apiKey: key.key || undefined, trusted: false } };
}
// Which provider applies: the person's own when they chose it, else the
// instance's, else their own as the only one there is.
function provider(user: Identity): AiResolution {
  const own = userAiSettings(user.id);
  const mine = userProviderConfig(user);
  const instance = instanceProviderConfig();
  if (own.source === "user" && mine.ok) return { ...mine, source: "user" };
  if (instance.ok) return { ...instance, source: "instance" };
  if (mine.ok) return { ...mine, source: "user" };
  return { ok: false, reason: !mine.ok && mine.reason === "key-unreadable" ? mine.reason : !instance.ok ? instance.reason : "no-provider" };
}

export function resolveAi(user: Identity, feature: AiFeature | string, options: Options = {}): AiResolution {
  const reason = gate(user, feature, options);
  if (reason) return { ok: false, reason };
  return provider(user);
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
export function aiStatus(user: Identity, workspaceId?: string, visiblePages: { id: string }[] = []): AiStatus {
  const features = Object.fromEntries(AI_FEATURE_IDS.map((id) => [id, { ok: false }])) as AiStatus["features"];
  const own = userAiSettings(user.id);
  const instance = instanceAiSettings();
  let resolved: AiResolution | null = null;
  for (const id of AI_FEATURE_IDS) {
    const reason = gate(user, id, { workspaceId });
    if (reason) {
      features[id] = { ok: false, reason };
      continue;
    }
    resolved ??= provider(user);
    features[id] = resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason };
  }
  const enabled = AI_FEATURE_IDS.some((id) => features[id].ok);
  const deviceFeatures = Object.fromEntries(DEVICE_AI_FEATURES.map((id) => [id, !deviceGate(user, id, { workspaceId })])) as Partial<Record<AiFeature, boolean>>;
  const device = Object.values(deviceFeatures).some(Boolean);
  // One pass for both: what the device may not read is a part of what the
  // server's AI may not.
  const excluded = (enabled || device) && workspaceId ? aiExcludedPages(user, visiblePages) : [];
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
    device: device ? { mode: own.device === "fallback" ? "fallback" : "prefer", features: deviceFeatures, excludedPages: aiDeviceExcludedPages(user, excluded) } : null,
  };
}
