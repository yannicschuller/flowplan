// Small secrets the server keeps at rest (the secrets of authenticator apps)
// and keys for signing short-lived values (a sign-in waiting for its second
// step, an unlocked share link). One implementation for all stored secrets:
// lib/ai/secrets.ts (AES-256-GCM, the additional data binds a value to its
// place, e.g. "totp:<userId>", so a value copied into another row does not
// open; key from FLOWPLAN_ENCRYPTION_KEY, FLOWPLAN_SECRETS_KEY or the
// generated secrets.key in the data folder).
import { createHmac, timingSafeEqual } from "node:crypto";
import { openSecret, sealSecret, signingKey } from "./ai/secrets";

export { openSecret, sealSecret };

// A signature over `data` for one purpose; changing the key ends all of them.
export function signValue(purpose: string, data: string) {
  return createHmac("sha256", signingKey(purpose)).update(data).digest("base64url");
}
export function validSignature(purpose: string, data: string, signature: string) {
  const expected = Buffer.from(signValue(purpose, data));
  const actual = Buffer.from(signature || "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
