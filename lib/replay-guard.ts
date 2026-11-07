// One-time values of signed deliveries from outside (Mailgun's token, Slack's
// event_id): a signature only proves who sent a request, not that it is the
// first time. Each value is remembered for as long as its signature stays
// valid, in the database (route handlers run as separate module instances).
// The fingerprint tells a sender's own retry (the same body) from a replay
// that reuses the value with another body.
import { one, run } from "./db";

// "new" the first time; "same" when the value came before with the same
// fingerprint, "other" with another one (within `ttlMs` of the first use).
export function claimOnce(key: string, fingerprint: string, ttlMs: number, now = Date.now()): "new" | "same" | "other" {
  run("DELETE FROM replay_guard WHERE expires<=?", now);
  const seen = one<{ fingerprint: string }>("SELECT fingerprint FROM replay_guard WHERE key=?", key);
  if (seen) return seen.fingerprint === fingerprint ? "same" : "other";
  run("INSERT INTO replay_guard(key,fingerprint,expires) VALUES(?,?,?)", key, fingerprint, now + ttlMs);
  return "new";
}
