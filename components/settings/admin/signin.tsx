"use client";
// Administration → Anmeldung & SSO: who gets an account (registration,
// creating workspaces, inactive accounts), the two-factor policy, how long
// sessions last (browser and apps, lib/session-policy.ts), single
// sign-on, the SSO groups mapped centrally, and the directories (SCIM,
// LDAP) – each as a card with its state.
import { useT } from "../../i18n";
import { SsoMappings } from "../../sso-mappings";
import { AdminDirectory, useDirectory } from "../../admin-directory";
import { SettingGroup, SettingRow, StatusBadge } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { APP_DAY_CHOICES, REMEMBER_DAY_CHOICES, SESSION_HOUR_CHOICES } from "@/lib/session-choices";
import { AdminStatus, FixLink, InstanceNumber, InstanceSelect, InstanceSwitch, useDocs, type StatusItem } from "./parts";

export default function SigninSection() {
  const t = useT();
  const docs = useDocs();
  const { data, act, onError } = useAdminData();
  const directory = useDirectory(onError);
  if (!data) return <AdminLoading />;
  const s = data.settings;
  const local = Object.values(data.localAccounts || {});
  const secured = local.filter((a) => a.totp || a.passkeys).length;
  const dir = directory.data;
  const ldapFailed = !!dir && dir.ldap.configured && !!dir.ldap.lastSync && !dir.ldap.lastSync.ok;
  const twoFactor = s.twoFactor || "off";
  const sessions = data.sessionPolicy;
  const items: StatusItem[] = [
    data.oidcConfigured ? { tone: "ok", label: t("SSO an", "SSO on") } : { tone: "off", label: t("SSO aus", "SSO off") },
    dir?.scim.tokens.length ? { tone: "ok", label: t("SCIM an", "SCIM on") } : { tone: "off", label: t("SCIM aus", "SCIM off") },
    ldapFailed
      ? {
          tone: "error",
          label: t("LDAP-Abgleich fehlgeschlagen", "LDAP sync failed"),
        }
      : dir?.ldap.configured
        ? { tone: "ok", label: t("LDAP an", "LDAP on") }
        : { tone: "off", label: t("LDAP aus", "LDAP off") },
  ];
  if (data.localLogin)
    items.push(
      twoFactor === "off"
        ? { tone: "warn", label: t("2FA nicht verlangt", "2FA not required") }
        : {
            tone: "ok",
            label: twoFactor === "all" ? t("2FA für alle", "2FA for everyone") : t("2FA für Admins", "2FA for admins"),
          },
      s.allowSignup
        ? { tone: "info", label: t("Registrierung offen", "Sign-up open") }
        : {
            tone: "off",
            label: t("Registrierung geschlossen", "Sign-up closed"),
          },
    );
  return (
    <>
      <AdminStatus items={items} action={ldapFailed ? <FixLink href="#admin/signin/ldap">{t("Zum LDAP-Verzeichnis", "To the LDAP directory")}</FixLink> : undefined}>
        {data.localLogin
          ? t(
              `Anmeldung mit E-Mail und Passwort ist an · ${secured} von ${local.length} lokalen Konten haben einen zweiten Faktor.`,
              `Sign-in with e-mail and password is on · ${secured} of ${local.length} local accounts have a second factor.`,
            )
          : t("Anmeldung nur über SSO oder Verzeichnis (FLOWPLAN_LOCAL_LOGIN=false).", "Sign-in only through SSO or a directory (FLOWPLAN_LOCAL_LOGIN=false).")}
      </AdminStatus>

      <SettingGroup
        id="registration"
        title={t("Registrierung & Zugang", "Sign-up & access")}
        description={t("Wer ein Konto bekommt und was neue Personen dürfen.", "Who gets an account and what new people may do.")}
      >
        {data.localLogin && (
          <InstanceSwitch
            field="allowSignup"
            label={t("Registrierung mit E-Mail und Passwort", "Sign-up with email and password")}
            description={
              s.allowSignup
                ? t("Jede Person kann sich mit E-Mail und Passwort ein Konto anlegen.", "Anyone can create an account with email and password.")
                : t(
                    "Aus: Nur eingeladene Adressen legen ein Konto an; der Knopf „Registrieren“ ist ausgeblendet. Das erste Konto einer Instanz verwaltet sie.",
                    "Off: only invited addresses create an account; the “Sign up” button is hidden. The first account of an instance administers it.",
                  )
            }
          />
        )}
        <InstanceSwitch
          field="allowWorkspaceCreation"
          label={t("Alle dürfen Arbeitsbereiche anlegen", "Everyone may create workspaces")}
          description={t("Aus: Nur Admins legen neue Arbeitsbereiche an.", "Off: only admins create new workspaces.")}
        />
        <InstanceNumber
          field="inactiveDays"
          label={t("Inaktive Konten sperren", "Block inactive accounts")}
          description={t(
            "Nach so vielen Tagen ohne Anmeldung wird ein Konto deaktiviert (mindestens 30). Leer = nie.",
            "After this many days without signing in an account is disabled (at least 30). Empty = never.",
          )}
          unit={t("Tage", "days")}
          min={30}
          // Earlier than deleting: a larger number becomes the largest allowed.
          max={s.deleteInactiveDays ? Math.max(30, s.deleteInactiveDays - 1) : 3650}
          placeholder={t("nie", "never")}
        />
        <InstanceNumber
          field="deleteInactiveDays"
          label={t("Inaktive Konten löschen", "Delete inactive accounts")}
          description={
            data.mail?.configured
              ? t(
                  "Nach so vielen Tagen ohne jede Nutzung wird ein Konto gelöscht (mindestens 60, mehr als beim Sperren). 14 und 3 Tage vorher bekommt die Person eine E-Mail mit dem Datum; meldet sie sich an, bleibt das Konto. Admins und Konten ohne E-Mail-Adresse werden nie gelöscht. Leer = nie.",
                  "After this many days without any use an account is deleted (at least 60, more than for blocking). 14 and 3 days before, the person gets an e-mail with the date; signing in keeps the account. Admins and accounts without an e-mail address are never deleted. Empty = never.",
                )
              : t(
                  "Braucht den E-Mail-Versand (Administration → E-Mail): Ohne Vorwarnung per E-Mail wird kein Konto gelöscht. Leer = nie.",
                  "Needs e-mail delivery (Administration → E-mail): without a warning by e-mail no account is deleted. Empty = never.",
                )
          }
          unit={t("Tage", "days")}
          // Later than blocking: a smaller number becomes the smallest allowed.
          min={Math.max(60, (s.inactiveDays ?? 0) + 1)}
          max={3650}
          placeholder={t("nie", "never")}
        />
      </SettingGroup>

      {data.localLogin && (
        <SettingGroup
          id="two-factor"
          title={t("Zwei-Faktor-Anmeldung", "Two-factor sign-in")}
          description={t(
            "Für Konten mit E-Mail und Passwort: Authenticator-App oder Passkey. SSO-Konten regelt der Anbieter.",
            "For accounts with email and password: authenticator app or passkey. SSO accounts are handled by the provider.",
          )}
        >
          <InstanceSelect
            field="twoFactor"
            label={t("Zwei-Faktor-Anmeldung verlangen", "Require two-factor sign-in")}
            description={t("Wer noch keinen zweiten Faktor hat, richtet ihn direkt nach der Anmeldung ein.", "Whoever has no second factor yet sets one up right after signing in.")}
            options={[
              { value: "off", label: t("Nicht verlangen", "Not required") },
              {
                value: "admins",
                label: t("Nur für Admins", "Only for admins"),
              },
              {
                value: "all",
                label: t("Für alle lokalen Konten", "For all local accounts"),
              },
            ]}
          />
          <SettingRow
            label={t("Eingerichtet", "Set up")}
            description={t(
              "Lokale Konten mit Authenticator-App oder Passkey. Einzelne Konten setzt du unter Benutzer zurück.",
              "Local accounts with an authenticator app or a passkey. Reset single accounts under Users.",
            )}
          >
            <StatusBadge tone={secured === local.length ? "ok" : "warn"}>{t(`${secured} von ${local.length}`, `${secured} of ${local.length}`)}</StatusBadge>
          </SettingRow>
        </SettingGroup>
      )}

      {sessions && (
        <SettingGroup
          id="sessions"
          title={t("Sitzungen", "Sessions")}
          description={t(
            "Wie lange man angemeldet bleibt. „Standard“ folgt der Umgebung (SESSION_HOURS, SESSION_REMEMBER, SESSION_IDLE_HOURS, SESSION_APP_REMEMBER, SESSION_APP_DAYS). Kürzere Zeiten gelten ab der nächsten Anmeldung; längere verlängern Sitzungen, die angemeldet bleiben, bei ihrer nächsten Nutzung.",
            "How long people stay signed in. “Default” follows the environment (SESSION_HOURS, SESSION_REMEMBER, SESSION_IDLE_HOURS, SESSION_APP_REMEMBER, SESSION_APP_DAYS). Shorter times apply from the next sign-in; longer ones extend sessions that stay signed in the next time they are used.",
          )}
        >
          <InstanceSelect
            field="sessionHours"
            label={t("Browser ohne „Angemeldet bleiben“", "Browser without “Stay signed in”")}
            description={t(
              "Die Sitzung endet so viele Stunden nach der Anmeldung – auch wenn Flowplan dabei offen ist.",
              "The session ends this many hours after signing in – even while Flowplan is open.",
            )}
            standard={t(`Standard (${sessions.env.hours} Std.)`, `Default (${sessions.env.hours} h)`)}
            parse={Number}
            options={SESSION_HOUR_CHOICES.map((h) => ({ value: String(h), label: h === 1 ? t("1 Stunde", "1 hour") : t(`${h} Stunden`, `${h} hours`) }))}
          />
          <InstanceSelect
            field="sessionRemember"
            label={t("„Angemeldet bleiben“ im Browser anbieten", "Offer “Stay signed in” in the browser")}
            description={t(
              "Ein Kästchen auf der Anmeldeseite – für Passwort, Passkey und SSO. Gedacht für eigene Geräte: Die Anmeldung bleibt bestehen, solange sie genutzt wird.",
              "A box on the sign-in page – for password, passkey and SSO. Meant for one's own devices: the sign-in lasts while it is used.",
            )}
            standard={sessions.env.browserRemember ? t("Standard (an)", "Default (on)") : t("Standard (aus)", "Default (off)")}
            parse={(value) => value === "true"}
            options={[
              { value: "true", label: t("An", "On") },
              { value: "false", label: t("Aus", "Off") },
            ]}
          />
          <InstanceSelect
            field="rememberDays"
            label={t("Browser mit „Angemeldet bleiben“", "Browser with “Stay signed in”")}
            description={t(
              "Die Sitzung endet nach so vielen Tagen ohne Nutzung. Wer Flowplan nutzt, bleibt angemeldet.",
              "The session ends after this many days without use. Whoever uses Flowplan stays signed in.",
            )}
            standard={t(`Standard (${sessions.env.rememberDays} Tage)`, `Default (${sessions.env.rememberDays} days)`)}
            parse={Number}
            options={REMEMBER_DAY_CHOICES.map((d) => ({ value: String(d), label: t(`${d} Tage`, `${d} days`) }))}
          />
          <InstanceSelect
            field="appSessions"
            label={t("Desktop- und Mobil-Apps", "Desktop and mobile apps")}
            description={t(
              "Die Apps laufen auf persönlichen Geräten und bleiben angemeldet, solange sie genutzt werden – auch über die Widgets. Das gilt für Anmeldungen, die die App belegt: über den Browser (Passkey, SSO) oder mit Passwort und dem Geräteschlüssel der App. Ältere App-Versionen ohne Geräteschlüssel bleiben nach einer Anmeldung mit Passwort so lange angemeldet wie ein Browser. Zusätzlich schützt die App-Sperre (Face ID, Fingerabdruck oder Code) in den Einstellungen der App.",
              "The apps run on personal devices and stay signed in while they are used – the widgets included. This applies to sign-ins the app proves: through the browser (passkey, SSO) or with the password and the app's device key. Older app versions without a device key stay signed in only as long as a browser after a password sign-in. The app lock (Face ID, fingerprint or passcode) in the app's settings protects them further.",
            )}
            standard={sessions.env.appRemember ? t("Standard (an)", "Default (on)") : t("Standard (aus)", "Default (off)")}
            options={[
              { value: "remember", label: t("Angemeldet bleiben", "Stay signed in") },
              { value: "off", label: t("Wie im Browser ohne „Angemeldet bleiben“", "As in the browser without “Stay signed in”") },
            ]}
          />
          {sessions.appRemember && (
            <InstanceSelect
              field="appDays"
              label={t("Apps: Ende ohne Nutzung", "Apps: end without use")}
              description={t(
                "Die App-Sitzung endet nach so vielen Tagen, in denen weder die App noch ihre Widgets genutzt wurden.",
                "The app's session ends after this many days in which neither the app nor its widgets were used.",
              )}
              standard={t(`Standard (${sessions.env.appDays} Tage)`, `Default (${sessions.env.appDays} days)`)}
              parse={Number}
              options={APP_DAY_CHOICES.map((d) => ({ value: String(d), label: t(`${d} Tage`, `${d} days`) }))}
            />
          )}
        </SettingGroup>
      )}

      <SettingGroup
        id="sso"
        title={t("Single Sign-on (OIDC)", "Single sign-on (OIDC)")}
        description={t(
          "Anmeldung über einen Identitätsanbieter wie Keycloak, Authentik, Entra ID oder Google.",
          "Sign-in through an identity provider such as Keycloak, Authentik, Entra ID or Google.",
        )}
        actions={data.oidcConfigured ? <StatusBadge tone="ok">{t("Eingerichtet", "Set up")}</StatusBadge> : <StatusBadge tone="off">{t("Nicht eingerichtet", "Not set up")}</StatusBadge>}
      >
        <SettingRow
          label={t("OIDC-Anbieter", "OIDC provider")}
          description={
            data.oidcConfigured ? (
              <>
                {t("Über OIDC_ISSUER eingerichtet · Admin-Gruppe", "Set up through OIDC_ISSUER · admin group")} <code>{data.adminGroup}</code>
              </>
            ) : (
              <>
                {t("Mit", "With")} <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code> {t("und", "and")} <code>OIDC_CLIENT_SECRET</code> {t("in der Umgebung.", "in the environment.")}
              </>
            )
          }
        >
          <FixLink href={docs("sign-in")}>{t("Anleitung", "Guide")}</FixLink>
        </SettingRow>
      </SettingGroup>

      {(data.oidcConfigured || !!data.ssoMappings?.length) && (
        <SettingGroup
          id="sso-groups"
          title={t("SSO-Gruppen zentral zuordnen", "Map SSO groups centrally")}
          description={t(
            "Gruppen aus dem Identitätsanbieter geben bei jeder SSO-Anmeldung eine Rolle im gewählten Arbeitsbereich und/oder eine seiner Gruppen. Dieselben Zuordnungen sehen die Eigentümer in den Einstellungen des Arbeitsbereichs.",
            "Groups from the identity provider give a role in the chosen workspace and/or one of its groups at every SSO sign-in. The workspace's owners see the same mappings in its settings.",
          )}
        >
          <SsoMappings
            mappings={data.ssoMappings || []}
            groups={data.workspaceGroups || []}
            workspaces={data.workspaces}
            onAdd={async (workspaceId, m) =>
              !!(await act({
                action: "admin.ssoMapping.add",
                workspaceId,
                ...m,
              }))
            }
            onDelete={(workspaceId, id) => act({ action: "admin.ssoMapping.delete", workspaceId, id })}
          />
        </SettingGroup>
      )}

      <AdminDirectory directory={directory} />
    </>
  );
}
