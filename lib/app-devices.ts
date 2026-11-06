// Which sign-ins get the lifetime of the desktop and mobile apps (#133,
// lib/session-policy.ts). The user agent (FlowplanMobile/, FlowplanDesktop/)
// alone no longer does: any browser can claim it, and with it would leave
// the administration's browser lifetime behind. A session is the app's when
// the app proves it:
//
// - "handoff": the app's sign-in through the system browser (passkey, SSO,
//   "Im Browser anmelden" – lib/desktop-sign-in.ts). The app keeps the
//   verifier, and only the code redeemed with it ends in a session, from the
//   app's own page. Every app version does this, 1.0.5 included.
// - "device": the password form inside the app. Newer apps (iOS/Android
//   after 1.0.5, desktop after 1.3.0) make a random device key per profile
//   on first launch, keep it in the system's key store (Keychain/Keystore,
//   Electron safeStorage) and put it into the instance's page only
//   (window.FlowplanApp.deviceKey / window.FlowplanDesktop.deviceKey,
//   lib/native-app.ts). The sign-in form sends it with the password; the
//   first sign-in of an account on that device registers it (trust on first
//   use, only after the password – and the code – were right), later ones
//   must bring the same secret for that device id. Only its hash is kept.
//
// Older apps send no key: their password sign-ins last like a browser's
// (with "Stay signed in" where the instance offers it), their hand-off
// sign-ins keep the app lifetime. Sessions marked as the app's before stay
// so.
//
// What this does not do: prove the app against someone who scripts the
// protocol themselves (runs the hand-off by hand, or puts a made-up key
// into the page). Nothing short of platform attestation could; it is their
// own account and session, so nobody gains rights – it only takes more than
// switching the user agent.
import { createHash, timingSafeEqual } from "node:crypto";
import { one, run } from "./db";
import { isAppAgent } from "./session-policy";

export type AppDeviceKey = { id: string; secret: string };

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
// Devices kept per account; the one unused longest makes room.
export const MAX_APP_DEVICES = 50;

const digest = (secret: string) => createHash("sha256").update(`flowplan-app-device:${secret}`).digest();

// The key from a sign-in form's body ({ device: { id, secret } }), checked.
export function appDeviceKey(input: unknown): AppDeviceKey | null {
  const device = input && typeof input === "object" ? (input as { device?: unknown }).device : null;
  if (!device || typeof device !== "object") return null;
  const { id, secret } = device as { id?: unknown; secret?: unknown };
  return typeof id === "string" && typeof secret === "string" && ID.test(id) && SECRET.test(secret) ? { id, secret } : null;
}

export type AppDeviceResult = "registered" | "known" | "mismatch" | "none";

// The device key of a sign-in whose credentials were right: registered on
// first use, compared afterwards.
export function checkAppDevice(userId: string, key: AppDeviceKey | null, now = Date.now()): AppDeviceResult {
  if (!key) return "none";
  const row = one<{ secret_hash: Buffer }>("SELECT secret_hash FROM app_devices WHERE user_id=? AND device_id=?", userId, key.id);
  if (row) {
    const stored = Buffer.from(row.secret_hash);
    const given = digest(key.secret);
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) return "mismatch";
    run("UPDATE app_devices SET last_used_at=? WHERE user_id=? AND device_id=?", now, userId, key.id);
    return "known";
  }
  run(
    `DELETE FROM app_devices WHERE user_id=? AND device_id IN (
       SELECT device_id FROM app_devices WHERE user_id=? ORDER BY last_used_at DESC LIMIT -1 OFFSET ?)`,
    userId,
    userId,
    MAX_APP_DEVICES - 1,
  );
  run("INSERT INTO app_devices(user_id,device_id,secret_hash,created_at,last_used_at) VALUES(?,?,?,?,?)", userId, key.id, digest(key.secret), now, now);
  return "registered";
}

// Whether a sign-in is the app's (its session then lasts as long as the
// app's): the hand-off always; the form inside the app (password, its
// code, a passkey, creating the account) with the app's user agent and
// device key. Nothing else – a user agent alone, SSO in the page – is.
export type AppProof =
  | { via: "handoff" }
  | { via: "form"; userId: string; input: unknown; agent: string | null | undefined };
export function provesApp(proof: AppProof, now = Date.now()) {
  if (proof.via === "handoff") return true;
  if (!isAppAgent(proof.agent)) return false;
  const result = checkAppDevice(proof.userId, appDeviceKey(proof.input), now);
  return result === "registered" || result === "known";
}
