// Where the Flowplan Marketplace lives and whether this instance uses it
// (docs: Marketplace). FLOWPLAN_MARKETPLACE_URL names the marketplace
// (default https://marketplace.flowplan.org, "off" switches the feature
// off); administrators can also switch it off for the instance
// (Administration → Erweiterungen & Domains). Off: no buttons, the
// receiver ignores messages and the routes answer 404.
//
// The instance never contacts the marketplace: the origin only fixes the
// target origin of postMessage and which messages are accepted.
import { HttpError } from "./auth";
import { buildInfo } from "./build-info";
import { instanceSettings } from "./instance-settings";

export const DEFAULT_MARKETPLACE_URL = "https://marketplace.flowplan.org";
// The first version that imports marketplace packages.
export const MARKETPLACE_SINCE = "0.9.4";

// The origin of FLOWPLAN_MARKETPLACE_URL, or null when it is off or not a
// usable address (https, http only for localhost).
export function marketplaceOrigin(raw: string | undefined = process.env.FLOWPLAN_MARKETPLACE_URL): string | null {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_MARKETPLACE_URL;
  if (/^(off|false|0|no|none|disabled)$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)) return url.origin;
  } catch {}
  return null;
}

export type MarketplaceClientConfig = { origin: string; version: string };

// What the browser needs: the marketplace's origin and this instance's
// version (sent in the ready message); null when the feature is off.
export async function marketplaceConfig(): Promise<MarketplaceClientConfig | null> {
  const origin = marketplaceOrigin();
  if (!origin) return null;
  if (!(await instanceSettings()).marketplace) return null;
  return { origin, version: buildInfo().version || "" };
}

export async function requireMarketplace() {
  const config = await marketplaceConfig();
  if (!config) throw new HttpError(404, "Der Marketplace ist auf dieser Instanz ausgeschaltet.");
  return config;
}

// The minVersion a package built here needs: this version, at least the
// first one that imports packages.
export function packageMinVersion(version: string = buildInfo().version) {
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(version || "");
  const own = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  const since = MARKETPLACE_SINCE.split(".").map(Number);
  if (!own) return MARKETPLACE_SINCE;
  for (let i = 0; i < 3; i++) if (own[i] !== since[i]) return own[i] > since[i] ? own.join(".") : MARKETPLACE_SINCE;
  return MARKETPLACE_SINCE;
}
