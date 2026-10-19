// Password and end date of links with their own permissions and of
// publications. Every way content leaves through a link (pages, records,
// files, live updates, guest edits and uploads) goes through publicTree()
// in lib/publication.ts, which calls checkShareProtection():
//
// - After its end, a link shows nothing ("abgelaufen", HTTP 410).
// - A link with a password needs an unlock cookie: set after the right
//   password, valid only on the paths of this one link (/share/<token> and
//   /api/share/<token>), signed by the server over the token and the current
//   password hash – a new password ends every unlock. Wrong passwords are
//   limited per link and address.
//
// Route handlers and the public page run their work inside
// withShareCookie(), which hands the request's cookie to the check.
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { one, run } from "./db";
import { HttpError, appUrl } from "./auth";
import { DUMMY_HASH, hashPasswordSync, verifyPassword } from "./local-auth";
import { signValue, validSignature } from "./secret-box";

export const SHARE_COOKIE = "flowplan_share";
const UNLOCK_SECONDS = 12 * 3600;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60_000;
export const SHARE_PASSWORD_MIN = 6;

type Protection = { password_hash: string | null; expires_at: number | null };
const requestCookie = new AsyncLocalStorage<{ unlock?: string }>();

export function withShareCookie<T>(unlock: string | undefined, fn: () => T): T {
  return requestCookie.run({ unlock }, fn);
}
export function shareCookieOf(headers: Headers) {
  for (const part of (headers.get("cookie") || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SHARE_COOKIE) return decodeURIComponent(value.join("="));
  }
  return undefined;
}
export const withShareRequest = <T>(req: Request, fn: () => T): T => withShareCookie(shareCookieOf(req.headers), fn);

// The protection of a link or a publication (null: no such link).
export function shareProtection(token: string): Protection | null {
  const link = one<Protection>("SELECT password_hash,expires_at FROM share_links WHERE token=?", token);
  if (link) return link;
  return (
    one<Protection>(
      "SELECT p.password_hash,p.expires_at FROM publications p JOIN pages g ON g.id=p.page_id WHERE g.public_token=? AND g.deleted_at IS NULL",
      token,
    ) ||
    (one("SELECT 1 FROM pages WHERE public_token=? AND deleted_at IS NULL", token) ? { password_hash: null, expires_at: null } : null)
  );
}
export const isExpired = (p: Protection, now = Date.now()) => !!p.expires_at && p.expires_at <= now;

const unlockData = (token: string, hash: string, expires: number) => `${token}\0${hash}\0${expires}`;
export function unlockValue(token: string, hash: string, expires: number) {
  return `${expires}.${signValue("share-unlock", unlockData(token, hash, expires))}`;
}
export function validUnlock(token: string, hash: string, value: string | undefined, now = Date.now()) {
  const [expires, signature] = (value || "").split(".");
  if (!expires || !signature || !(Number(expires) > now)) return false;
  return validSignature("share-unlock", unlockData(token, hash, Number(expires)), signature);
}

// What a visitor of the link sees.
export function shareState(token: string, unlock: string | undefined, now = Date.now()) {
  const p = shareProtection(token);
  if (!p) return "missing" as const;
  if (isExpired(p, now)) return "expired" as const;
  if (p.password_hash && !validUnlock(token, p.password_hash, unlock, now)) return "password" as const;
  return "open" as const;
}
export function checkShareProtection(token: string, p: Protection, now = Date.now()) {
  if (isExpired(p, now)) throw new HttpError(410, "Dieser Link ist abgelaufen.");
  if (p.password_hash && !validUnlock(token, p.password_hash, requestCookie.getStore()?.unlock, now))
    throw new HttpError(401, "Dieser Link ist mit einem Passwort geschützt.");
}

// The right password: the value of the unlock cookie and how long it lasts
// (never beyond the link's end).
export async function unlockShare(token: string, password: unknown, address: string, now = Date.now()) {
  const key = `share:${token}:${address}`.slice(0, 300);
  run("DELETE FROM login_failures WHERE at<?", now - FAILURE_WINDOW);
  const failures = Number(one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key=? AND at>=?", key, now - FAILURE_WINDOW)?.n || 0);
  if (failures >= MAX_FAILURES) throw new HttpError(429, "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.");
  const p = shareProtection(token);
  const text = typeof password === "string" ? password.slice(0, 200) : "";
  // The same work whether the link exists and has a password or not.
  const ok = await verifyPassword(text, p?.password_hash || DUMMY_HASH);
  if (!p) throw new HttpError(404, "Link nicht gefunden.");
  if (isExpired(p, now)) throw new HttpError(410, "Dieser Link ist abgelaufen.");
  if (!p.password_hash) return { value: "", maxAge: 0 };
  if (!ok) {
    run("INSERT INTO login_failures(key,at) VALUES(?,?)", key, now);
    throw new HttpError(401, "Das Passwort stimmt nicht.");
  }
  const seconds = Math.max(60, Math.min(UNLOCK_SECONDS, p.expires_at ? Math.floor((p.expires_at - now) / 1000) : UNLOCK_SECONDS));
  return { value: unlockValue(token, p.password_hash, now + seconds * 1000), maxAge: seconds };
}
// Set-Cookie headers for both paths of the link: its pages and its API.
export function unlockCookies(token: string, value: string, maxAge: number) {
  const secure = new URL(appUrl()).protocol === "https:" ? "; Secure" : "";
  return [`/share/${token}`, `/api/share/${token}`].map(
    (path) => `${SHARE_COOKIE}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`,
  );
}

// ---- Setting it (owners, inside the command transaction) ----

// password: undefined keeps it, null or "" removes it. expiresAt likewise
// (milliseconds; must lie in the future).
export const protectionInput = z.object({
  password: z.string().max(200).nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
});
export function protectionChanges(input: unknown, now = Date.now()) {
  const b = protectionInput.parse(input);
  const changes: Partial<Protection> = {};
  if (b.password !== undefined) {
    if (b.password && b.password.length < SHARE_PASSWORD_MIN)
      throw new HttpError(400, `Das Passwort braucht mindestens ${SHARE_PASSWORD_MIN} Zeichen.`);
    changes.password_hash = b.password ? hashPasswordSync(b.password) : null;
  }
  if (b.expiresAt !== undefined) {
    if (b.expiresAt !== null && b.expiresAt <= now) throw new HttpError(400, "Das Ablaufdatum muss in der Zukunft liegen.");
    if (b.expiresAt !== null && b.expiresAt > now + 10 * 365 * 86400_000) throw new HttpError(400, "Das Ablaufdatum liegt zu weit in der Zukunft.");
    changes.expires_at = b.expiresAt;
  }
  return changes;
}
