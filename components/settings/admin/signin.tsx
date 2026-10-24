"use client";
// Administration → Anmeldung & SSO: who gets an account (registration,
// creating workspaces, inactive accounts), the two-factor policy, single
// sign-on, the SSO groups mapped centrally, and the directories (SCIM,
// LDAP) – each as a card with its state.
import { useT } from "../../i18n";
import { SsoMappings } from "../../sso-mappings";
import { AdminDirectory, useDirectory } from "../../admin-directory";
import { SettingGroup, SettingRow, StatusBadge } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
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
