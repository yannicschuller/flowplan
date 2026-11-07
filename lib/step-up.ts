// Confirming a sensitive step of one's own account (#101: connecting or
// disconnecting SSO, removing or setting the password) once more, though
// signed in: the password, a code from the authenticator app (or a
// recovery code), or one of the account's passkeys – whatever the account
// has. Failures count against the same limits as at sign-in (per account
// and per address). An account with none of them (SSO only, without
// passkey or app) confirms by a sign-in within the last ten minutes.
// With OIDC_LINKED_SSO_ONLY the password of a linked account no longer
// counts here either; passkeys and codes do.
import { z } from "zod";
import { one } from "./db";
import { HttpError, hash } from "./auth";
import { addressKey } from "./client-address";
import { checkAttempt, passkeyConfirm, verifyPassword } from "./local-auth";
import { verifyLdapPassword } from "./ldap-auth";
import { confirmSecondFactor } from "./two-factor";
import { signInMethods, ssoOnlyAccount } from "./identities";
import { translate, type Locale } from "./i18n";

export const RECENT_SIGN_IN_MS = 10 * 60_000;

// When the session of this cookie began (null without one).
export async function sessionStartedAt(token: string | undefined) {
  if (!token) return null;
  return (
    (await one<{ at: number | null }>("SELECT COALESCE(authenticated_at,created_at) at FROM sessions WHERE token=?", hash(token)))?.at ?? null
  );
}

// What the account can confirm with, for the dialogs.
export async function stepUpMethods(userId: string, sessionStart: number | null, now = Date.now()) {
  const m = await signInMethods(userId);
  const password = (m.password || m.ldap) && !(await ssoOnlyAccount(userId));
  const strong = password || m.totp || m.passkeys > 0;
  return {
    password,
    code: m.totp,
    passkey: m.passkeys > 0,
    // Nothing else to confirm with: a fresh sign-in counts.
    recent: !strong,
    recentOk: !strong && !!sessionStart && now - sessionStart <= RECENT_SIGN_IN_MS,
  };
}
export type StepUpMethods = Awaited<ReturnType<typeof stepUpMethods>>;

const stepSchema = z.object({
  password: z.string().max(200).optional(),
  code: z.string().max(40).optional(),
  passkey: z.unknown().optional(),
});

export async function confirmStep(
  userId: string,
  input: unknown,
  context: { address: string; locale: Locale; passkeyToken?: string; sessionStart: number | null },
) {
  const t = translate(context.locale);
  const step = stepSchema.parse((input && typeof input === "object" ? (input as { confirm?: unknown }).confirm : undefined) ?? {});
  const methods = await stepUpMethods(userId, context.sessionStart);
  const keys = [...addressKey("ip", context.address), `totp:${userId}`];
  if (step.code && methods.code) return await confirmSecondFactor(userId, step.code, context.address, context.locale);
  const tooMany = t("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", "Too many attempts. Please try again in 15 minutes.");
  if (step.passkey && methods.passkey)
    return await checkAttempt(
      keys,
      async () => await passkeyConfirm(userId, context.passkeyToken, step.passkey),
      tooMany,
      t("Der Passkey konnte nicht bestätigt werden.", "The passkey could not be confirmed."),
    );
  const password = step.password;
  if (password !== undefined && methods.password)
    return await checkAttempt(
      keys,
      async () => {
        const local = await one<{ password_hash: string }>("SELECT password_hash FROM local_accounts WHERE user_id=?", userId);
        return local?.password_hash ? await verifyPassword(password, local.password_hash) : await verifyLdapPassword(userId, password);
      },
      tooMany,
      t("Das Passwort stimmt nicht.", "The password is wrong."),
    );
  if (methods.recentOk) return;
  throw new HttpError(
    401,
    methods.recent
      ? t("Bitte melde dich zur Bestätigung erneut an und versuche es dann gleich noch einmal.", "Please sign in again to confirm, then try again right away.")
      : t("Bitte bestätige mit deinem Passwort, einem Passkey oder einem Code aus der App.", "Please confirm with your password, a passkey or a code from the app."),
  );
}
