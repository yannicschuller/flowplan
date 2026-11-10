// Sign-in with an LDAP directory and the hourly group sync (lib/ldap.ts
// speaks the protocol).
//
// - The password form of the sign-in page: an address with an account
//   with e-mail and password signs in as before; every other name is
//   checked against the directory (LDAP bind) when LDAP_URL is set.
// - An LDAP account is a directory account like an SSO account: it is
//   found by its DN, else linked to an existing SSO/SCIM account with the
//   same e-mail address, else created (subject "ldap:<dn>"). An account
//   with e-mail and password of that address is never taken over.
// - Its groups (LDAP_GROUP_ATTRIBUTE, by default memberOf: the group's CN
//   and its full DN) feed the SSO group mappings (lib/sso-mappings.ts) and
//   the admin group (OIDC_ADMIN_GROUP), at sign-in and every hour.
// - The two-factor policy of the instance applies as for passwords
//   (lib/two-factor.ts): an authenticator app can be set up and is asked
//   for after the LDAP password.
// - Disabled or deleted in the directory: the hourly sync disables the
//   account (sessions end); enabled again there, the sync or the next
//   sign-in enables it again. Accounts disabled by an administrator stay
//   disabled.
import { z } from "zod";
import { all, audit, id, one, run, transaction } from "./db";
import { HttpError, adminGroup } from "./auth";
import { addressKey } from "./client-address";
import { beginAttempt, clearFailures, localLoginEnabled, passwordLogin, slowDown } from "./local-auth";
import { reapplySsoUser } from "./sso-mappings";
import { setUserDisabled } from "./account-deletion";
import { translate, type Locale } from "./i18n";
import {
  LdapError,
  entryLocked,
  entryProfile,
  groupNames,
  ldapAuthenticate,
  ldapCheckPassword,
  ldapConfig,
  ldapConfigured,
  ldapReadEntries,
  ldapTest,
  type LdapEntry,
} from "./ldap";
import { isLeader } from "./cluster/leader";

type LdapAccount = { user_id: string; dn: string; username: string; groups_json: string; is_admin: number; locked: number; synced_at: number | null };

export const isLdapAccount = async (userId: string) => !!(await one("SELECT 1 FROM ldap_accounts WHERE user_id=?", userId));
export async function ldapGroups(userId: string): Promise<string[]> {
  const row = await one<{ groups_json: string }>("SELECT groups_json FROM ldap_accounts WHERE user_id=?", userId);
  try {
    const parsed = row ? JSON.parse(row.groups_json) : [];
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
}

async function status(key: string, value: unknown) {
  await run(
    "INSERT INTO directory_status(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    key,
    JSON.stringify(value),
    Date.now(),
  );
}
async function readStatus<T>(key: string): Promise<T | null> {
  const row = await one<{ value: string }>("SELECT value FROM directory_status WHERE key=?", key);
  try {
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}

// Stores what the directory says about one person (inside a transaction).
async function storeEntry(userId: string, entry: LdapEntry, groups: string[], now: number) {
  const profile = entryProfile(entry);
  await run("UPDATE users SET name=? WHERE id=?", profile.name, userId);
  // A different address is confirmed by nobody yet: the old confirmation goes.
  if (profile.email)
    await run("UPDATE users SET email_verified=CASE WHEN lower(email)=lower(?) THEN email_verified ELSE 0 END,email=? WHERE id=?", profile.email, profile.email, userId);
  await run(
    "UPDATE ldap_accounts SET dn=?,groups_json=?,is_admin=?,synced_at=? WHERE user_id=?",
    entry.dn,
    JSON.stringify(groups),
    groups.includes(adminGroup()) ? 1 : 0,
    now,
    userId,
  );
}

// The account for a directory entry: found by DN, linked by e-mail, or new.
async function linkAccount(entry: LdapEntry, signInName: string, groups: string[], t: (de: string, en: string) => string) {
  const now = Date.now();
  const profile = entryProfile(entry, signInName);
  let row = await one<LdapAccount>("SELECT * FROM ldap_accounts WHERE lower(dn)=lower(?)", entry.dn);
  if (!row) {
    if (profile.email && await one("SELECT 1 FROM local_accounts WHERE lower(email)=lower(?)", profile.email))
      throw new HttpError(
        409,
        t(
          "Für diese E-Mail-Adresse gibt es ein Konto mit Passwort. Bitte melde dich mit der E-Mail-Adresse und dessen Passwort an.",
          "There is an account with a password for this e-mail address. Please sign in with the e-mail address and its password.",
        ),
      );
    const subject = `ldap:${entry.dn.toLowerCase()}`;
    let userId =
      (await one<{ id: string }>("SELECT id FROM users WHERE subject=?", subject))?.id ||
      (profile.email
        ? (await one<{ id: string }>(
            `SELECT u.id FROM users u WHERE lower(u.email)=lower(?) AND u.email<>'' AND u.email_verified=1 AND u.demo_until IS NULL AND u.subject NOT LIKE 'deleted:%' AND u.subject<>'local-development'
               AND NOT EXISTS(SELECT 1 FROM local_accounts a WHERE a.user_id=u.id) AND NOT EXISTS(SELECT 1 FROM ldap_accounts l WHERE l.user_id=u.id)
             ORDER BY u.created_at LIMIT 1`,
            profile.email,
          ))?.id
        : undefined);
    if (!userId) {
      userId = id();
      await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", userId, subject, profile.name, profile.email);
    }
    await run("DELETE FROM ldap_accounts WHERE user_id=?", userId);
    await run("INSERT INTO ldap_accounts(user_id,dn,username,created_at) VALUES(?,?,?,?)", userId, entry.dn, profile.username, now);
    row = (await one<LdapAccount>("SELECT * FROM ldap_accounts WHERE user_id=?", userId))!;
  }
  const user = await one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", row.user_id);
  if (user?.disabled) {
    // Disabled by the sync because the directory had locked the person:
    // the directory lets them in again, so Flowplan does too.
    if (!row.locked) throw new HttpError(403, t("Dieses Konto ist deaktiviert.", "This account is disabled."));
    await setUserDisabled(row.user_id, false);
    await audit("", "ldap.enable", row.user_id, entry.dn);
  }
  await run("UPDATE ldap_accounts SET locked=0,username=? WHERE user_id=?", profile.username, row.user_id);
  await storeEntry(row.user_id, entry, groups, now);
  return row.user_id;
}

export async function ldapPasswordLogin(identifier: string, password: string, address: string, locale: Locale) {
  const t = translate(locale);
  const config = ldapConfig();
  if (!config) throw new HttpError(403, t("Anmeldung mit Passwort ist ausgeschaltet.", "Password sign-in is turned off."));
  const name = identifier.trim();
  const keys = [...addressKey("ip", address), `ldap:${name.toLowerCase()}`];
  const attempt = await beginAttempt(keys);
  if (!attempt) throw new HttpError(429, t("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", "Too many attempts. Please try again in 15 minutes."));
  const wrong = async () => {
    await attempt.failed();
    return new HttpError(401, t("E-Mail-Adresse oder Passwort stimmt nicht.", "E-mail address or password is wrong."));
  };
  let entry: LdapEntry;
  try {
    await slowDown(keys);
    if (!name || !password) throw (await wrong());
    try {
      entry = await ldapAuthenticate(name, password, config);
    } catch (e) {
      if (e instanceof LdapError && e.invalidCredentials) throw (await wrong());
      console.error("LDAP sign-in failed", e instanceof Error ? e.message : e);
      throw new HttpError(503, t("Der Verzeichnisdienst (LDAP) ist gerade nicht erreichbar.", "The directory service (LDAP) cannot be reached right now."));
    }
  } finally {
    await attempt.end();
  }
  if (entryLocked(entry)) throw new HttpError(403, t("Dieses Konto ist deaktiviert.", "This account is disabled."));
  const groups = groupNames(entry, config.groupAttribute);
  const userId = await transaction(async () => await linkAccount(entry, name, groups, t));
  await clearFailures(`ldap:${name.toLowerCase()}`);
  return { userId, groups };
}

// The password form: local accounts first, the directory for everyone else.
export async function directoryPasswordLogin(input: unknown, address: string, locale: Locale) {
  if (!ldapConfigured()) return passwordLogin(input, address, locale);
  const { email, password } = z.object({ email: z.string().trim().max(256), password: z.string().max(200) }).parse(input);
  if (localLoginEnabled() && await one("SELECT 1 FROM local_accounts WHERE lower(email)=lower(?)", email)) return passwordLogin(input, address, locale);
  return ldapPasswordLogin(email, password, address, locale);
}

// Confirms a change in the settings with the LDAP password.
export async function verifyLdapPassword(userId: string, password: string) {
  const row = await one<{ dn: string }>("SELECT dn FROM ldap_accounts WHERE user_id=?", userId);
  if (!row || !password) return false;
  try {
    return await ldapCheckPassword(row.dn, password);
  } catch {
    return false;
  }
}

// ---- Sync ----

export type LdapSyncResult = { at: number; ok: boolean; accounts: number; updated: number; disabled: number; enabled: number; error?: string };

// Reads every LDAP account from the directory again: groups, name, address
// and whether it is still there and enabled. A run that would disable more
// than half of the accounts (at least five) stops instead – that is more
// likely a wrong configuration than a mass departure.
export async function syncLdapAccounts(now = Date.now()): Promise<LdapSyncResult> {
  const config = ldapConfig();
  if (!config) return { at: now, ok: false, accounts: 0, updated: 0, disabled: 0, enabled: 0, error: "LDAP is not configured" };
  const accounts = await all<LdapAccount & { disabled: number }>(
    "SELECT l.*,u.disabled FROM ldap_accounts l JOIN users u ON u.id=l.user_id ORDER BY l.created_at",
  );
  const result: LdapSyncResult = { at: now, ok: true, accounts: accounts.length, updated: 0, disabled: 0, enabled: 0 };
  try {
    const entries = accounts.length ? await ldapReadEntries(accounts.map((a) => a.dn), config) : new Map<string, LdapEntry | null>();
    const gone = accounts.filter((a) => {
      const entry = entries.get(a.dn);
      return (!entry || entryLocked(entry)) && !a.disabled;
    });
    if (gone.length >= 5 && gone.length * 2 > accounts.length)
      throw new LdapError(`Sync stopped: ${gone.length} of ${accounts.length} accounts would be disabled`);
    await transaction(async () => {
      for (const a of accounts) {
        const entry = entries.get(a.dn);
        if (!entry || entryLocked(entry)) {
          if (!a.disabled) {
            await setUserDisabled(a.user_id, true);
            await run("UPDATE ldap_accounts SET locked=1 WHERE user_id=?", a.user_id);
            await audit("", "ldap.disable", a.user_id, entry ? "locked" : "missing");
            result.disabled++;
          }
          continue;
        }
        if (a.disabled && a.locked) {
          await setUserDisabled(a.user_id, false);
          await run("UPDATE ldap_accounts SET locked=0 WHERE user_id=?", a.user_id);
          await audit("", "ldap.enable", a.user_id, a.dn);
          result.enabled++;
        }
        const groups = groupNames(entry, config.groupAttribute);
        if (JSON.stringify(groups) !== a.groups_json) result.updated++;
        await storeEntry(a.user_id, entry, groups, now);
        // Sessions of pure LDAP accounts carry the new groups (admin right).
        if (await one("SELECT 1 FROM users WHERE id=? AND subject LIKE 'ldap:%'", a.user_id))
          await run("UPDATE sessions SET groups_json=? WHERE user_id=? AND sso=1", JSON.stringify(groups), a.user_id);
        await reapplySsoUser(a.user_id);
      }
    });
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : "LDAP error";
  }
  await status("ldap.sync", result);
  return result;
}

export async function testLdapConnection() {
  const result = { ...(await ldapTest()), at: Date.now() };
  await status("ldap.test", result);
  return result;
}

export async function ldapStatus() {
  const config = ldapConfig();
  return {
    configured: !!config,
    url: config?.url || "",
    baseDn: config?.baseDn || "",
    bindDn: config?.bindDn || "",
    userFilter: config?.userFilter || "",
    groupAttribute: config?.groupAttribute || "",
    startTls: !!config?.startTls,
    accounts: Number((await one<{ n: number }>("SELECT COUNT(*) n FROM ldap_accounts"))?.n || 0),
    lastSync: await readStatus<LdapSyncResult>("ldap.sync"),
    lastTest: await readStatus<{ ok: boolean; ms: number; error: string; at: number }>("ldap.test"),
  };
}
export type LdapStatus = Awaited<ReturnType<typeof ldapStatus>>;

const runtime = globalThis as unknown as { flowplanLdapTimer?: ReturnType<typeof setInterval> };
export function startLdapSyncWorker() {
  if (runtime.flowplanLdapTimer || !ldapConfigured()) return;
  // Cluster mode: the leader only (lib/cluster/leader.ts).
  const tick = () =>
    isLeader() &&
    void syncLdapAccounts().catch((error) => console.error("LDAP sync failed", error instanceof Error ? error.message : error));
  setTimeout(tick, 60_000).unref?.();
  runtime.flowplanLdapTimer = setInterval(tick, 3600_000);
  runtime.flowplanLdapTimer.unref?.();
}
