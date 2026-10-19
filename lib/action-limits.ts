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
// AI requests per person (lib/ai/run.ts): a burst limit and an hourly one,
// FLOWPLAN_AI_REQUESTS_PER_HOUR to change the latter.
const aiPerHour = () => Math.max(1, Number(process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR) || 300);
export function limitAi(userId: string) {
  if (!allow(`ai:${userId}`, 30, 60_000) || !allow(`ai-hour:${userId}`, aiPerHour(), HOUR))
    throw new HttpError(429, "Zu viele KI-Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
}
// Connection tests, model lists and downloads in the settings.
export function limitAiSetup(userId: string) {
  if (!allow(`ai-setup:${userId}`, 20, 10 * 60_000))
    throw new HttpError(429, "Zu viele KI-Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
}
