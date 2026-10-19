// Limits for actions that reach people outside: invitations, shared pages
// and their e-mails. Counted in memory (one server process); a restart
// starts the count again, which is fine for this purpose.
import { HttpError } from "./auth";

const hits = new Map<string, number[]>();
// Whether `key` may act again: at most `max` times within `windowMs`.
export function allow(key: string, max: number, windowMs: number, now = Date.now()) {
  const recent = (hits.get(key) || []).filter((at) => at > now - windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, list] of hits) if (!list.some((at) => at > now - windowMs)) hits.delete(k);
  return true;
}
export function requireAllowed(key: string, max: number, windowMs: number) {
  if (!allow(key, max, windowMs)) throw new HttpError(429, "Zu viele Einladungen in kurzer Zeit. Bitte später erneut versuchen.");
}
const HOUR = 3_600_000;
// Per person who invites or shares, and per address that receives mail.
export const limitInviter = (userId: string) => requireAllowed(`inviter:${userId}`, 40, HOUR);
export const mailAllowed = (email: string) => allow(`mail:${email.toLowerCase()}`, 5, HOUR);
