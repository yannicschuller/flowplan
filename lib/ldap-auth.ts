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
import { failed, limited, localLoginEnabled, passwordLogin } from "./local-auth";
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

type LdapAccount = { user_id: string; dn: string; username: string; groups_json: string; is_admin: number; locked: number; synced_at: number | null };

export const isLdapAccount = (userId: string) => !!one("SELECT 1 FROM ldap_accounts WHERE user_id=?", userId);
export function ldapGroups(userId: string): string[] {
  const row = one<{ groups_json: string }>("SELECT groups_json FROM ldap_accounts WHERE user_id=?", userId);
  try {
    const parsed = row ? JSON.parse(row.groups_json) : [];
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
}

function status(key: string, value: unknown) {
  run(
    "INSERT INTO directory_status(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    key,
    JSON.stringify(value),
    Date.now(),
  );
}
function readStatus<T>(key: string): T | null {
  const row = one<{ value: string }>("SELECT value FROM directory_status WHERE key=?", key);
  try {
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}

// Stores what the directory says about one person (inside a transaction).
function storeEntry(userId: string, entry: LdapEntry, groups: string[], now: number) {
  const profile = entryProfile(entry);
  run("UPDATE users SET name=? WHERE id=?", profile.name, userId);
  if (profile.email) run("UPDATE users SET email=? WHERE id=?", profile.email, userId);
  run(
    "UPDATE ldap_accounts SET dn=?,groups_json=?,is_admin=?,synced_at=? WHERE user_id=?",
    entry.dn,
    JSON.stringify(groups),
    groups.includes(adminGroup()) ? 1 : 0,
    now,
    userId,
  );
}

// The account for a directory entry: found by DN, linked by e-mail, or new.
function linkAccount(entry: LdapEntry, signInName: string, groups: string[], t: (de: string, en: string) => string) {
  const now = Date.now();
  const profile = entryProfile(entry, signInName);
  let row = one<LdapAccount>("SELECT * FROM ldap_accounts WHERE dn=?", entry.dn);
  if (!row) {
    if (profile.email && one("SELECT 1 FROM local_accounts WHERE email=? COLLATE NOCASE", profile.email))
      throw new HttpError(
        409,
        t(
          "Für diese E-Mail-Adresse gibt es ein Konto mit Passwort. Bitte melde dich mit der E-Mail-Adresse und dessen Passwort an.",
          "There is an account with a password for this e-mail address. Please sign in with the e-mail address and its password.",
        ),
      );
    const subject = `ldap:${entry.dn.toLowerCase()}`;
    let userId =
      one<{ id: string }>("SELECT id FROM users WHERE subject=?", subject)?.id ||
      (profile.email
        ? one<{ id: string }>(
            `SELECT u.id FROM users u WHERE lower(u.email)=lower(?) AND u.email<>'' AND u.demo_until IS NULL AND u.subject NOT LIKE 'deleted:%' AND u.subject<>'local-development'
               AND NOT EXISTS(SELECT 1 FROM local_accounts a WHERE a.user_id=u.id) AND NOT EXISTS(SELECT 1 FROM ldap_accounts l WHERE l.user_id=u.id)
             ORDER BY u.created_at LIMIT 1`,
            profile.email,
          )?.id
        : undefined);
    if (!userId) {
      userId = id();
      run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", userId, subject, profile.name, profile.email);
    }
    run("DELETE FROM ldap_accounts WHERE user_id=?", userId);
    run("INSERT INTO ldap_accounts(user_id,dn,username,created_at) VALUES(?,?,?,?)", userId, entry.dn, profile.username, now);
    row = one<LdapAccount>("SELECT * FROM ldap_accounts WHERE user_id=?", userId)!;
  }
  const user = one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", row.user_id);
  if (user?.disabled) {
    // Disabled by the sync because the directory had locked the person:
    // the directory lets them in again, so Flowplan does too.
    if (!row.locked) throw new HttpError(403, t("Dieses Konto ist deaktiviert.", "This account is disabled."));
    setUserDisabled(row.user_id, false);
    audit("", "ldap.enable", row.user_id, entry.dn);
  }
  run("UPDATE ldap_accounts SET locked=0,username=? WHERE user_id=?", profile.username, row.user_id);
  storeEntry(row.user_id, entry, groups, now);
  return row.user_id;
}

export async function ldapPasswordLogin(identifier: string, password: string, address: string, locale: Locale) {
  const t = translate(locale);
  const config = ldapConfig();
  if (!config) throw new HttpError(403, t("Anmeldung mit Passwort ist ausgeschaltet.", "Password sign-in is turned off."));
  const name = identifier.trim();
  const keys = [...addressKey("ip", address), `ldap:${name.toLowerCase()}`];
  if (limited(keys)) throw new HttpError(429, t("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", "Too many attempts. Please try again in 15 minutes."));
  const wrong = () => {
    failed(keys);
    return new HttpError(401, t("E-Mail-Adresse oder Passwort stimmt nicht.", "E-mail address or password is wrong."));
  };
  if (!name || !password) throw wrong();
  let entry: LdapEntry;
  try {
    entry = await ldapAuthenticate(name, password, config);
  } catch (e) {
    if (e instanceof LdapError && e.invalidCredentials) throw wrong();
    console.error("LDAP sign-in failed", e instanceof Error ? e.message : e);
    throw new HttpError(503, t("Der Verzeichnisdienst (LDAP) ist gerade nicht erreichbar.", "The directory service (LDAP) cannot be reached right now."));
  }
  if (entryLocked(entry)) throw new HttpError(403, t("Dieses Konto ist deaktiviert.", "This account is disabled."));
  const groups = groupNames(entry, config.groupAttribute);
  const userId = transaction(() => linkAccount(entry, name, groups, t));
  run("DELETE FROM login_failures WHERE key=?", `ldap:${name.toLowerCase()}`);
  return { userId, groups };
}

// The password form: local accounts first, the directory for everyone else.
export async function directoryPasswordLogin(input: unknown, address: string, locale: Locale) {
  if (!ldapConfigured()) return passwordLogin(input, address, locale);
  const { email, password } = z.object({ email: z.string().trim().max(256), password: z.string().max(200) }).parse(input);
  if (localLoginEnabled() && one("SELECT 1 FROM local_accounts WHERE email=? COLLATE NOCASE", email)) return passwordLogin(input, address, locale);
  return ldapPasswordLogin(email, password, address, locale);
}

// Confirms a change in the settings with the LDAP password.
export async function verifyLdapPassword(userId: string, password: string) {
  const row = one<{ dn: string }>("SELECT dn FROM ldap_accounts WHERE user_id=?", userId);
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
  const accounts = all<LdapAccount & { disabled: number }>(
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
    transaction(() => {
      for (const a of accounts) {
        const entry = entries.get(a.dn);
        if (!entry || entryLocked(entry)) {
          if (!a.disabled) {
            setUserDisabled(a.user_id, true);
            run("UPDATE ldap_accounts SET locked=1 WHERE user_id=?", a.user_id);
            audit("", "ldap.disable", a.user_id, entry ? "locked" : "missing");
            result.disabled++;
          }
          continue;
        }
        if (a.disabled && a.locked) {
          setUserDisabled(a.user_id, false);
          run("UPDATE ldap_accounts SET locked=0 WHERE user_id=?", a.user_id);
          audit("", "ldap.enable", a.user_id, a.dn);
          result.enabled++;
        }
        const groups = groupNames(entry, config.groupAttribute);
        if (JSON.stringify(groups) !== a.groups_json) result.updated++;
        storeEntry(a.user_id, entry, groups, now);
        // Sessions of pure LDAP accounts carry the new groups (admin right).
        if (one("SELECT 1 FROM users WHERE id=? AND subject LIKE 'ldap:%'", a.user_id))
          run("UPDATE sessions SET groups_json=? WHERE user_id=? AND sso=1", JSON.stringify(groups), a.user_id);
        reapplySsoUser(a.user_id);
      }
    });
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : "LDAP error";
  }
  status("ldap.sync", result);
  return result;
}

export async function testLdapConnection() {
  const result = { ...(await ldapTest()), at: Date.now() };
  status("ldap.test", result);
  return result;
}

export function ldapStatus() {
  const config = ldapConfig();
  return {
    configured: !!config,
    url: config?.url || "",
    baseDn: config?.baseDn || "",
    bindDn: config?.bindDn || "",
    userFilter: config?.userFilter || "",
    groupAttribute: config?.groupAttribute || "",
    startTls: !!config?.startTls,
    accounts: Number(one<{ n: number }>("SELECT COUNT(*) n FROM ldap_accounts")?.n || 0),
    lastSync: readStatus<LdapSyncResult>("ldap.sync"),
    lastTest: readStatus<{ ok: boolean; ms: number; error: string; at: number }>("ldap.test"),
  };
}
export type LdapStatus = ReturnType<typeof ldapStatus>;

const runtime = globalThis as unknown as { flowplanLdapTimer?: ReturnType<typeof setInterval> };
export function startLdapSyncWorker() {
  if (runtime.flowplanLdapTimer || !ldapConfigured()) return;
  const tick = () =>
    void syncLdapAccounts().catch((error) => console.error("LDAP sync failed", error instanceof Error ? error.message : error));
  setTimeout(tick, 60_000).unref?.();
  runtime.flowplanLdapTimer = setInterval(tick, 3600_000);
  runtime.flowplanLdapTimer.unref?.();
}
