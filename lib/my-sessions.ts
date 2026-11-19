// The signed-in person's own sessions ("devices"), to see where they are
// signed in and to sign out a single device or all others.
import { createHash } from "node:crypto";
import { all, run } from "./db";
import { securityEvent } from "./security-events";
import { HttpError, hash } from "./auth";
import type { Identity } from "./types";
import { deviceName } from "./device-name";
export { deviceName };

// A short public id for a session: derived from the stored token hash, so it
// can neither sign in nor be turned back into the hash.
const publicId = (tokenHash: string) => createHash("sha256").update(`session:${tokenHash}`).digest("hex").slice(0, 20);

export async function mySessions(user: Identity, currentToken: string | undefined) {
  const current = currentToken ? hash(currentToken) : "";
  return (await all<{ token: string; created_at: number | null; last_seen: number | null; expires: number; remember: number; agent: string; widgets_only: number }>(
    `SELECT token,created_at,last_seen,expires,remember,agent,
       (EXISTS(SELECT 1 FROM mobile_devices d WHERE d.session_token=sessions.token) AND NOT EXISTS(SELECT 1 FROM mobile_devices d WHERE d.session_token=sessions.token AND d.push_enabled<>0)) widgets_only
     FROM sessions WHERE user_id=? AND expires>? ORDER BY COALESCE(last_seen,created_at,0) DESC`,
    user.id,
    Date.now(),
  )).map((s) => ({
    id: publicId(s.token),
    current: s.token === current,
    ...deviceName(s.agent),
    createdAt: s.created_at,
    lastSeen: s.last_seen,
    expires: s.expires,
    remember: !!s.remember,
    // An app profile that is not the active one: it stays signed in for its
    // widgets, without notifications (lib/mobile-devices.ts).
    widgetsOnly: !!Number(s.widgets_only),
  }));
}

// Signs out one device, or all but the current one.
export async function endMySessions(user: Identity, currentToken: string | undefined, target: { id?: unknown; others?: unknown }) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  const current = currentToken ? hash(currentToken) : "";
  const sessions = await all<{ token: string }>("SELECT token FROM sessions WHERE user_id=?", user.id);
  const ended = sessions.filter((s) =>
    target.others === true ? s.token !== current : typeof target.id === "string" && publicId(s.token) === target.id,
  );
  if (!ended.length && target.others !== true) throw new HttpError(404, "Diese Sitzung gibt es nicht mehr.");
  for (const s of ended) await run("DELETE FROM sessions WHERE token=? AND user_id=?", s.token, user.id);
  if (ended.length) securityEvent("session.revoked", { actorId: user.id, severity: "info", detail: target.others === true ? `${ended.length} other sessions` : "one session" });
  return { ended: ended.length, current: ended.some((s) => s.token === current) };
}
