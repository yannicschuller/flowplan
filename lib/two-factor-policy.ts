// Whether an account must sign in with a second factor, and whether it has
// one. Only accounts with e-mail and password take part: SSO accounts get
// their second factor from the provider, API tokens act for scripts.
// A passkey counts as strong on its own. Kept free of other imports, so
// lib/auth.ts can ask on every request.
import { one } from "./db";
import { instanceSettings } from "./instance-settings";

export function totpEnabled(userId: string) {
  return !!one("SELECT 1 FROM user_totp WHERE user_id=? AND enabled=1", userId);
}
export function hasPasskey(userId: string) {
  return !!one("SELECT 1 FROM passkeys WHERE user_id=? LIMIT 1", userId);
}
// What the administration asks of this account.
export function twoFactorRequired(userId: string) {
  const policy = instanceSettings().twoFactor;
  if (policy === "off") return false;
  const account = one<{ is_admin: number }>("SELECT is_admin FROM local_accounts WHERE user_id=?", userId);
  if (!account) return false;
  return policy === "all" || !!account.is_admin;
}
// Required, but neither an authenticator app nor a passkey yet: the person
// sets one up before using anything else.
export function needsTwoFactorSetup(userId: string) {
  return twoFactorRequired(userId) && !totpEnabled(userId) && !hasPasskey(userId);
}
