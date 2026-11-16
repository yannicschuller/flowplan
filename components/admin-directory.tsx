"use client";
// Administration → Anmeldung & SSO → Verzeichnisse: user provisioning over
// SCIM 2.0 (base address, bearer tokens shown once, the last requests) and
// the LDAP directory (configured through the environment: status,
// connection test, last sync).
import { useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Copy, Key, Plugs, Trash } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";
import { EmptyState, ResponsiveTable, SettingGroup, SettingRow, StatusBadge } from "./settings-ui";
import { when } from "./settings/admin/format";
import type { ScimOverview } from "@/lib/scim";
import type { LdapStatus } from "@/lib/ldap-auth";
import type { ContactsLdapStatus } from "@/lib/contacts-ldap";
import type { ProxyAuthStatus } from "@/lib/proxy-auth";
import { AdminContactsLdap } from "./admin-contacts-ldap";

export type DirectoryOverview = { scim: ScimOverview; ldap: LdapStatus; contacts?: ContactsLdapStatus; proxy?: ProxyAuthStatus };

// /api/admin/directory, loaded once; `act` runs a command and keeps its answer.
export function useDirectory(onError: (message: string) => void) {
  const [data, setData] = useState<DirectoryOverview | null>(null);
  const [busy, setBusy] = useState("");
  const report = useRef(onError);
  useEffect(() => {
    report.current = onError;
  });
  useEffect(() => {
    api<DirectoryOverview>("/api/admin/directory")
      .then(setData)
      .catch((e: Error) => report.current(e.message));
  }, []);
  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      const result = await api<DirectoryOverview & { token?: string }>("/api/admin/directory", { action, ...extra });
      setData({ scim: result.scim, ldap: result.ldap, contacts: result.contacts, proxy: result.proxy });
      return result;
    } catch (e) {
      report.current((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return { data, busy, act };
}

export function AdminDirectory({ directory }: { directory: Awaited<ReturnType<typeof useDirectory>> }) {
  const t = useT();
  const { data, busy, act } = directory;
  const [created, setCreated] = useState("");
  const [name, setName] = useState("");
  if (!data) return null;
  const { scim, ldap } = data;
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => undefined);
  const ldapTone = !ldap.configured ? "off" : ldap.lastSync && !ldap.lastSync.ok ? "error" : ldap.lastTest && !ldap.lastTest.ok ? "error" : "ok";
  return (
    <>
      <SettingGroup
        id="scim"
        title="SCIM"
        description={t(
          "Identitätsanbieter wie Okta oder Microsoft Entra ID legen Konten über SCIM an, ändern und deaktivieren sie. SCIM-Gruppen wirken wie SSO-Gruppen: Die Zuordnungen oben geben Rollen und Gruppen.",
          "Identity providers such as Okta or Microsoft Entra ID create, update and deactivate accounts over SCIM. SCIM groups work like SSO groups: the mappings above give roles and groups.",
        )}
        actions={scim.tokens.length ? <StatusBadge tone="ok">{t("Aktiv", "Active")}</StatusBadge> : <StatusBadge tone="off">{t("Aus", "Off")}</StatusBadge>}
      >
        <SettingRow
          label={t("SCIM-Basis-URL", "SCIM base URL")}
          description={t(`${scim.users} Konten und ${scim.groups} Gruppen bereitgestellt.`, `${scim.users} accounts and ${scim.groups} groups provisioned.`)}
        >
          <span className="admin-copy">
            <code>{scim.baseUrl}</code>
            <button type="button" className="icon-button" title={t("Kopieren", "Copy")} aria-label={t("SCIM-Basis-URL kopieren", "Copy SCIM base URL")} onClick={() => copy(scim.baseUrl)}>
              <Copy size={16} />
            </button>
          </span>
        </SettingRow>
        <form
          className="setting-row"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await act("scim.token.create", { name });
            if (result?.token) {
              setCreated(result.token);
              setName("");
            }
          }}
        >
          <div className="setting-text">
            <label htmlFor="scim-token-name">{t("Neuer SCIM-Token", "New SCIM token")}</label>
            <small>
              {t(
                "Name des Anbieters, z. B. Okta. Der Token wird nur einmal angezeigt; beim Anbieter als Bearer-Token eintragen.",
                "The provider's name, e.g. Okta. The token is shown only once; enter it at the provider as the bearer token.",
              )}
            </small>
          </div>
          <div className="setting-control admin-inline-form">
            <input id="scim-token-name" className="control-md" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
            <button className="button" disabled={!!busy}>
              <Key size={16} aria-hidden /> {t("Token erstellen", "Create token")}
            </button>
          </div>
        </form>
        {created && (
          <div className="setting-row wide">
            <div className="callout" role="status">
              <span>
                {t("Neuer Token – jetzt kopieren, er wird nicht noch einmal angezeigt:", "New token – copy it now, it is not shown again:")} <code className="admin-break">{created}</code>
              </span>
              <button type="button" className="button compact" onClick={() => copy(created)}>
                <Copy size={16} /> {t("Kopieren", "Copy")}
              </button>
            </div>
          </div>
        )}
        <div className="setting-row wide">
          <ResponsiveTable
            label={t("SCIM-Token", "SCIM tokens")}
            rows={scim.tokens}
            rowKey={(token) => token.id}
            empty={
              <EmptyState icon={<Key size={18} />} title={t("Noch kein SCIM-Token", "No SCIM token yet")}>
                {t("Ohne Token nimmt Flowplan keine SCIM-Anfragen an.", "Without a token Flowplan accepts no SCIM requests.")}
              </EmptyState>
            }
            columns={[
              {
                key: "name",
                header: t("Name", "Name"),
                primary: true,
                render: (token) => token.name,
              },
              {
                key: "prefix",
                header: t("Beginn", "Prefix"),
                render: (token) => <code>{token.prefix}…</code>,
              },
              {
                key: "created",
                header: t("Erstellt", "Created"),
                hideOnPhone: true,
                render: (token) => when(token.created_at),
              },
              {
                key: "used",
                header: t("Zuletzt benutzt", "Last used"),
                render: (token) => when(token.last_used_at),
              },
              {
                key: "revoke",
                header: t("Widerrufen", "Revoke"),
                align: "end",
                render: (token) => (
                  <button
                    type="button"
                    className="icon-button"
                    title={t("Widerrufen", "Revoke")}
                    aria-label={t(`Token ${token.name} widerrufen`, `Revoke token ${token.name}`)}
                    disabled={!!busy}
                    onClick={() => {
                      if (confirm(t("Token widerrufen? Der Anbieter kann dann nichts mehr bereitstellen.", "Revoke the token? The provider can then no longer provision.")))
                        void act("scim.token.revoke", { id: token.id });
                    }}
                  >
                    <Trash size={16} />
                  </button>
                ),
              },
            ]}
          />
        </div>
        {scim.requests.length > 0 && (
          <details className="setting-row wide admin-details">
            <summary>{t(`Letzte SCIM-Anfragen (${scim.requests.length})`, `Last SCIM requests (${scim.requests.length})`)}</summary>
            <ResponsiveTable
              label={t("Letzte SCIM-Anfragen", "Last SCIM requests")}
              rows={scim.requests}
              rowKey={(r) => String(r.id)}
              columns={[
                {
                  key: "at",
                  header: t("Zeitpunkt", "Time"),
                  primary: true,
                  render: (r) => when(r.at),
                },
                {
                  key: "request",
                  header: t("Anfrage", "Request"),
                  render: (r) => (
                    <code className="admin-break">
                      {r.method} {r.path}
                    </code>
                  ),
                },
                {
                  key: "status",
                  header: t("Status", "Status"),
                  render: (r) => <StatusBadge tone={r.status < 400 ? "ok" : "error"}>{String(r.status)}</StatusBadge>,
                },
                {
                  key: "detail",
                  header: t("Hinweis", "Detail"),
                  hideOnPhone: true,
                  render: (r) => <small>{r.detail}</small>,
                },
              ]}
            />
          </details>
        )}
      </SettingGroup>
      <SettingGroup
        id="ldap"
        title={t("LDAP-Verzeichnis", "LDAP directory")}
        description={
          ldap.configured
            ? t(
                "Personen ohne Konto mit E-Mail und Passwort melden sich mit ihrem Verzeichnis-Passwort an. Gruppen und deaktivierte Konten werden stündlich abgeglichen.",
                "People without an account with e-mail and password sign in with their directory password. Groups and disabled accounts are synced every hour.",
              )
            : t(
                "Nicht eingerichtet. LDAP wird über Umgebungsvariablen (LDAP_URL, LDAP_BASE_DN …) konfiguriert.",
                "Not set up. LDAP is configured with environment variables (LDAP_URL, LDAP_BASE_DN …).",
              )
        }
        actions={<StatusBadge tone={ldapTone}>{ldapTone === "off" ? t("Aus", "Off") : ldapTone === "error" ? t("Fehler", "Error") : t("Verbunden", "Connected")}</StatusBadge>}
      >
        {ldap.configured && (
          <>
            <SettingRow label={t("Server", "Server")} description={`${ldap.baseDn}${ldap.startTls ? " · StartTLS" : ""}`}>
              <code className="admin-break">{ldap.url}</code>
            </SettingRow>
            {(ldap.tlsUnverified || ldap.tlsServername) && (
              <SettingRow
                label={t("Zertifikat", "Certificate")}
                description={
                  ldap.tlsUnverified
                    ? t(
                        "Zertifikatsprüfung ausgeschaltet (LDAP_TLS_REJECT_UNAUTHORIZED=false): wer im Netz dazwischen sitzt, kann sich als Verzeichnis ausgeben und Passwörter mitlesen. Sicherer: LDAP_TLS_CA und LDAP_TLS_SERVERNAME.",
                        "Certificate check switched off (LDAP_TLS_REJECT_UNAUTHORIZED=false): anyone on the network path can pose as the directory and read passwords. Safer: LDAP_TLS_CA and LDAP_TLS_SERVERNAME.",
                      )
                    : t(`Geprüft gegen den Namen ${ldap.tlsServername} (LDAP_TLS_SERVERNAME).`, `Checked against the name ${ldap.tlsServername} (LDAP_TLS_SERVERNAME).`)
                }
              >
                <StatusBadge tone={ldap.tlsUnverified ? "warn" : "ok"}>{ldap.tlsUnverified ? t("Nicht geprüft", "Not verified") : t("Geprüft", "Verified")}</StatusBadge>
              </SettingRow>
            )}
            <SettingRow label={t("Suche", "Search")} description={t(`Gruppen aus ${ldap.groupAttribute}`, `Groups from ${ldap.groupAttribute}`)}>
              <code className="admin-break">{ldap.userFilter}</code>
            </SettingRow>
            <SettingRow
              label={t("Verbindung", "Connection")}
              description={
                ldap.lastTest
                  ? ldap.lastTest.ok
                    ? t(`Erreichbar (${ldap.lastTest.ms} ms) · ${when(ldap.lastTest.at)}`, `Reachable (${ldap.lastTest.ms} ms) · ${when(ldap.lastTest.at)}`)
                    : t(`Fehler: ${ldap.lastTest.error} · ${when(ldap.lastTest.at)}`, `Error: ${ldap.lastTest.error} · ${when(ldap.lastTest.at)}`)
                  : t("Noch nicht getestet.", "Not tested yet.")
              }
            >
              <button type="button" className="button" disabled={!!busy} onClick={() => void act("ldap.test")}>
                <Plugs size={16} /> {t("Verbindung testen", "Test connection")}
              </button>
            </SettingRow>
            <SettingRow
              label={t("Letzter Abgleich", "Last sync")}
              description={
                ldap.lastSync
                  ? ldap.lastSync.ok
                    ? t(
                        `${when(ldap.lastSync.at)} · ${ldap.lastSync.accounts} Konten, ${ldap.lastSync.updated} geändert, ${ldap.lastSync.disabled} deaktiviert, ${ldap.lastSync.enabled} wieder aktiv`,
                        `${when(ldap.lastSync.at)} · ${ldap.lastSync.accounts} accounts, ${ldap.lastSync.updated} changed, ${ldap.lastSync.disabled} disabled, ${ldap.lastSync.enabled} enabled again`,
                      )
                    : t(`${when(ldap.lastSync.at)} · Fehler: ${ldap.lastSync.error}`, `${when(ldap.lastSync.at)} · Error: ${ldap.lastSync.error}`)
                  : t(`Noch kein Abgleich · ${ldap.accounts} LDAP-Konten`, `No sync yet · ${ldap.accounts} LDAP accounts`)
              }
            >
              <button type="button" className="button" disabled={!!busy} onClick={() => void act("ldap.sync")}>
                <ArrowsClockwise size={16} /> {t("Jetzt abgleichen", "Sync now")}
              </button>
            </SettingRow>
          </>
        )}
      </SettingGroup>
      {data.proxy && <AdminProxyAuth status={data.proxy} />}
      {data.contacts && <AdminContactsLdap status={data.contacts} busy={busy} act={act} />}
    </>
  );
}

// Sign-in through a reverse proxy (lib/proxy-auth.ts): configured through
// the environment, shown read-only like LDAP.
function AdminProxyAuth({ status }: { status: ProxyAuthStatus }) {
  const t = useT();
  const tone = !status.enabled ? "off" : status.wideProxies.length ? "warn" : "ok";
  const none = t("nicht gesetzt", "not set");
  return (
    <SettingGroup
      id="proxy-auth"
      title={t("Anmeldung über einen Reverse-Proxy", "Sign-in through a reverse proxy")}
      description={
        status.enabled
          ? t(
              `Ein Portal vor Flowplan (z. B. YunoHost, Authelia, Authentik) meldet Personen an und nennt sie im Header ${status.userHeader}. ${status.accounts} Konten melden sich so an.`,
              `A portal in front of Flowplan (e.g. YunoHost, Authelia, Authentik) signs people in and names them in the header ${status.userHeader}. ${status.accounts} accounts sign in this way.`,
            )
          : t(
              "Nicht eingerichtet. Wird über Umgebungsvariablen (AUTH_PROXY_USER_HEADER, AUTH_PROXY_TRUSTED_PROXIES …) konfiguriert.",
              "Not set up. Configured with environment variables (AUTH_PROXY_USER_HEADER, AUTH_PROXY_TRUSTED_PROXIES …).",
            )
      }
      actions={<StatusBadge tone={tone}>{tone === "off" ? t("Aus", "Off") : tone === "warn" ? t("Prüfen", "Check") : t("An", "On")}</StatusBadge>}
    >
      {status.enabled && (
        <>
          <SettingRow
            label={t("Vertrauenswürdige Proxys", "Trusted proxies")}
            description={
              status.wideProxies.length
                ? t(
                    `Nicht nur dieser Rechner: Wer Flowplans Port von ${status.wideProxies.join(", ")} aus erreicht, kann sich als beliebige Person ausgeben. Stelle sicher, dass der Port nur über den Proxy erreichbar ist.`,
                    `Not only this machine: anyone who reaches Flowplan's port from ${status.wideProxies.join(", ")} can pose as anyone. Make sure the port is reachable only through the proxy.`,
                  )
                : t("Nur Verbindungen von diesem Rechner (AUTH_PROXY_TRUSTED_PROXIES).", "Only connections from this machine (AUTH_PROXY_TRUSTED_PROXIES).")
            }
          >
            <code className="admin-break">{status.trustedProxies.join(", ")}</code>
          </SettingRow>
          <SettingRow
            label={t("Header", "Headers")}
            description={t(
              `E-Mail: ${status.emailHeader || none} · Name: ${status.nameHeader || none} · Gruppen: ${status.groupsHeader || none}`,
              `E-mail: ${status.emailHeader || none} · Name: ${status.nameHeader || none} · Groups: ${status.groupsHeader || none}`,
            )}
          >
            <code className="admin-break">{status.userHeader}</code>
          </SettingRow>
          <SettingRow
            label={t("Portal", "Portal")}
            description={t(
              `Anmelden: ${status.loginUrl || none} · Abmelden: ${status.logoutUrl || none}`,
              `Sign in: ${status.loginUrl || none} · Sign out: ${status.logoutUrl || none}`,
            )}
          >
            <StatusBadge tone={status.only ? "info" : "off"}>{status.only ? t("Nur Portal", "Portal only") : t("Auch Passwort", "Password too")}</StatusBadge>
          </SettingRow>
          <SettingRow
            label={t("Neue Konten", "New accounts")}
            description={
              status.autoCreate
                ? t("Personen ohne Konto bekommen bei der ersten Anmeldung eines (AUTH_PROXY_AUTO_CREATE).", "People without an account get one at their first sign-in (AUTH_PROXY_AUTO_CREATE).")
                : t("Nur Personen mit Konto (LDAP, SCIM oder schon verbunden) melden sich an.", "Only people with an account (LDAP, SCIM or already connected) sign in.")
            }
          >
            <StatusBadge tone={status.autoCreate ? "ok" : "off"}>{status.autoCreate ? t("An", "On") : t("Aus", "Off")}</StatusBadge>
          </SettingRow>
        </>
      )}
    </SettingGroup>
  );
}
