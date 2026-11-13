// The upgrade link for hosted offerings (off by default): only when
// FLOWPLAN_UPGRADE_URL (an https address) and FLOWPLAN_UPGRADE_SECRET (at
// least 32 characters) are set, account settings and the "storage full" /
// "AI not available" messages offer "Speicher erweitern / Upgrade". It
// opens `${FLOWPLAN_UPGRADE_URL}?t=<token>`, the token telling the other
// side (which shares the secret) who asks, signed and valid for 15 minutes:
//
//   payload = base64url(JSON.stringify({ u, e, n, i, exp }))
//   token   = payload + "." + base64url(HMAC-SHA256(secret, payload))
//
// u = account id, e = e-mail, n = name, i = the instance's origin (APP_URL),
// exp = Unix seconds. base64url without padding. Nothing about plans or
// prices lives here; tests/fixtures/upgrade-token.json is a test vector.
import { createHmac } from "node:crypto";
import { appUrl, HttpError } from "./auth";

// A refusal the person could lift by upgrading their own account: the API
// answer carries `upgrade: true` while the upgrade link is configured
// (components/ui.tsx offers the link next to the message).
export class LimitError extends HttpError {
  readonly upgrade = true;
}
export const isLimitError = (e: unknown): e is LimitError => e instanceof HttpError && (e as { upgrade?: unknown }).upgrade === true;

export const UPGRADE_TOKEN_SECONDS = 15 * 60;

export function upgradeConfig(): { url: URL; secret: string } | null {
  const raw = process.env.FLOWPLAN_UPGRADE_URL?.trim();
  const secret = process.env.FLOWPLAN_UPGRADE_SECRET?.trim() || "";
  if (!raw || secret.length < 32) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? { url, secret } : null;
  } catch {
    return null;
  }
}
export const upgradeConfigured = () => !!upgradeConfig();

export type UpgradeClaims = { u: string; e: string; n: string; i: string; exp: number };
export function upgradeToken(secret: string, person: { id: string; email: string; name: string }, origin: string, now = Date.now()) {
  const claims: UpgradeClaims = { u: person.id, e: person.email, n: person.name, i: origin, exp: Math.floor(now / 1000) + UPGRADE_TOKEN_SECONDS };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
export const instanceOrigin = () => new URL(appUrl()).origin;

// Where the link points for this person, or null when it is not offered
// (not configured, demo accounts, API tokens).
export function upgradeUrlFor(user: { id: string; email: string; name: string; demo?: boolean; apiScope?: unknown }, now = Date.now()) {
  const config = upgradeConfig();
  if (!config || user.demo || user.apiScope) return null;
  const url = new URL(config.url);
  url.searchParams.set("t", upgradeToken(config.secret, user, instanceOrigin(), now));
  return url.toString();
}

// GET /api/upgrade (app/api/upgrade/route.ts): a fresh token on every
// click, so a link in the page never goes stale.
export function upgradeRedirect(user: { id: string; email: string; name: string; demo?: boolean; apiScope?: unknown } | null) {
  if (!upgradeConfig()) return new Response("Not found", { status: 404 });
  if (!user) return new Response("Unauthorized", { status: 401 });
  const target = upgradeUrlFor(user);
  if (!target) return new Response("Forbidden", { status: 403 });
  return new Response(null, { status: 303, headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
