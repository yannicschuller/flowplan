"use client";
// Administration → Users: user provisioning over SCIM 2.0 (base address,
// bearer tokens shown once, the last requests) and the LDAP directory
// (configured through the environment: status, connection test, last sync).
import { useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Copy, Plugs, Trash } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { api } from "./ui";
import { SettingGroup, SettingRow } from "./settings-ui";
import type { ScimOverview } from "@/lib/scim";
import type { LdapStatus } from "@/lib/ldap-auth";

type Overview = { scim: ScimOverview; ldap: LdapStatus };
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(LOCALE_TAG) : "–");

export function AdminDirectory({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [data, setData] = useState<Overview | null>(null);
  const [created, setCreated] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  // Errors go through the latest onError, loading happens once.
  const report = useRef(onError);
  useEffect(() => {
    report.current = onError;
  });
  useEffect(() => {
    api<Overview>("/api/admin/directory")
      .then(setData)
      .catch((e: Error) => report.current(e.message));
  }, []);
  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      const result = await api<Overview & { token?: string }>("/api/admin/directory", { action, ...extra });
      setData({ scim: result.scim, ldap: result.ldap });
      return result;
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  if (!data) return null;
  const { scim, ldap } = data;
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => undefined);
  return (
    <>
      <SettingGroup
        title={t("Benutzerverwaltung (SCIM/LDAP)", "User provisioning (SCIM/LDAP)")}
        description={t(
          "Identitätsanbieter wie Okta oder Microsoft Entra ID legen Konten über SCIM an, ändern und deaktivieren sie. SCIM-Gruppen wirken wie SSO-Gruppen: Die SSO-Zuordnungen unter Arbeitsbereiche geben Rollen und Gruppen.",
          "Identity providers such as Okta or Microsoft Entra ID create, update and deactivate accounts over SCIM. SCIM groups work like SSO groups: the SSO mappings under Workspaces give roles and groups.",
        )}
      >
        <SettingRow label={t("SCIM-Basis-URL", "SCIM base URL")} description={t(`${scim.users} Konten und ${scim.groups} Gruppen bereitgestellt.`, `${scim.users} accounts and ${scim.groups} groups provisioned.`)}>
          <span className="directory-copy" style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0, flexWrap: "wrap" }}>
            <code>{scim.baseUrl}</code>
            <button type="button" className="icon-button" title={t("Kopieren", "Copy")} aria-label={t("Kopieren", "Copy")} onClick={() => copy(scim.baseUrl)}>
              <Copy size={16} />
            </button>
          </span>
        </SettingRow>
        <form
          className="setting-row wide"
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
            <span className="setting-label">{t("SCIM-Token", "SCIM tokens")}</span>
            <small>{t("Der Token wird nur einmal angezeigt. Beim Anbieter als Bearer-Token eintragen.", "The token is shown only once. Enter it at the provider as the bearer token.")}</small>
          </div>
          <span className="directory-copy" style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0, flexWrap: "wrap" }}>
            <input value={name} maxLength={80} placeholder={t("Name, z. B. Okta", "Name, e.g. Okta")} aria-label={t("Name des Tokens", "Token name")} onChange={(e) => setName(e.target.value)} />
            <button className="button" disabled={!!busy}>
              {t("Token erstellen", "Create token")}
            </button>
          </span>
        </form>
        {created && (
          <div className="callout" role="status">
            <span>
              {t("Neuer Token – jetzt kopieren, er wird nicht noch einmal angezeigt:", "New token – copy it now, it is not shown again:")} <code>{created}</code>
            </span>
            <button type="button" className="button compact" onClick={() => copy(created)}>
              <Copy size={16} /> {t("Kopieren", "Copy")}
            </button>
          </div>
        )}
        {scim.tokens.length > 0 && (
          <div className="data-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Name", "Name")}</th>
                  <th>{t("Beginn", "Prefix")}</th>
                  <th>{t("Erstellt", "Created")}</th>
                  <th>{t("Zuletzt benutzt", "Last used")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {scim.tokens.map((token) => (
                  <tr key={token.id}>
                    <td>{token.name}</td>
                    <td>
                      <code>{token.prefix}…</code>
                    </td>
                    <td>{when(token.created_at)}</td>
                    <td>{when(token.last_used_at)}</td>
                    <td>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {scim.requests.length > 0 && (
          <details className="setting-row wide">
            <summary>{t(`Letzte SCIM-Anfragen (${scim.requests.length})`, `Last SCIM requests (${scim.requests.length})`)}</summary>
            <div className="data-table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Zeitpunkt", "Time")}</th>
                    <th>{t("Anfrage", "Request")}</th>
                    <th>{t("Status", "Status")}</th>
                    <th>{t("Hinweis", "Detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {scim.requests.map((r) => (
                    <tr key={r.id}>
                      <td>{when(r.at)}</td>
                      <td>
                        <code>
                          {r.method} {r.path}
                        </code>
                      </td>
                      <td>
                        <span className={`tag ${r.status < 400 ? "tag-green" : "tag-red"}`}>{r.status}</span>
                      </td>
                      <td>
                        <small>{r.detail}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </SettingGroup>
      <SettingGroup
        title={t("LDAP-Verzeichnis", "LDAP directory")}
        description={
          ldap.configured
            ? t(
                "Personen ohne Konto mit E-Mail und Passwort melden sich mit ihrem Verzeichnis-Passwort an. Gruppen und deaktivierte Konten werden stündlich abgeglichen.",
                "People without an account with e-mail and password sign in with their directory password. Groups and disabled accounts are synced every hour.",
              )
            : t("Nicht eingerichtet. LDAP wird über Umgebungsvariablen (LDAP_URL, LDAP_BASE_DN …) konfiguriert.", "Not set up. LDAP is configured with environment variables (LDAP_URL, LDAP_BASE_DN …).")
        }
      >
        {ldap.configured && (
          <>
            <SettingRow label={t("Server", "Server")} description={`${ldap.baseDn}${ldap.startTls ? " · StartTLS" : ""}`}>
              <code>{ldap.url}</code>
            </SettingRow>
            <SettingRow label={t("Suche", "Search")} description={t(`Gruppen aus ${ldap.groupAttribute}`, `Groups from ${ldap.groupAttribute}`)}>
              <code>{ldap.userFilter}</code>
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
    </>
  );
}
