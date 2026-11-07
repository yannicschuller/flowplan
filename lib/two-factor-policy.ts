// Whether an account must sign in with a second factor, and whether it has
// one. Only accounts with a password (e-mail and password, LDAP) take part: SSO accounts get
// their second factor from the provider, API tokens act for scripts.
// A passkey counts as strong on its own: signing in with it asks for no
// code, unless the person turned on "also after a passkey". Kept free of
// other imports, so lib/auth.ts can ask on every request.
import { one } from "./db";
import { instanceSettings } from "./instance-settings";

export async function totpEnabled(userId: string) {
  return !!(await one("SELECT 1 FROM user_totp WHERE user_id=? AND enabled=1", userId));
}
export async function codeAfterPasskey(userId: string) {
  return !!(await one("SELECT 1 FROM user_totp WHERE user_id=? AND enabled=1 AND after_passkey=1", userId));
}
export async function hasPasskey(userId: string) {
  return !!(await one("SELECT 1 FROM passkeys WHERE user_id=? LIMIT 1", userId));
}
// What the administration asks of this account.
export async function twoFactorRequired(userId: string) {
  const policy = (await instanceSettings()).twoFactor;
  if (policy === "off") return false;
  // LDAP accounts sign in with a password too (is_admin: in the admin group
  // at the last sign-in or sync).
  const account =
    await one<{ is_admin: number }>("SELECT is_admin FROM local_accounts WHERE user_id=?", userId) ||
    await one<{ is_admin: number }>("SELECT is_admin FROM ldap_accounts WHERE user_id=?", userId);
  if (!account) return false;
  return policy === "all" || !!account.is_admin;
}
// Required, but neither an authenticator app nor a passkey yet: the person
// sets one up before using anything else.
export async function needsTwoFactorSetup(userId: string) {
  return await twoFactorRequired(userId) && !(await totpEnabled(userId)) && !(await hasPasskey(userId));
}
