"use client";
// Administration → Anmeldung & SSO → "Kontakte aus LDAP" (issue #64): the
// directory area contacts databases import from. Server, search account
// and TLS are those of the LDAP sign-in (environment); here only the base
// DN, the person filter, the interval and the switch – stored values win
// over LDAP_CONTACTS_BASE_DN / LDAP_CONTACTS_FILTER. Changes are recorded
// as security events (lib/contacts-ldap.ts).
import { useEffect, useState } from "react";
import { Plugs } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { SettingGroup, SettingRow, StatusBadge, CONTROL } from "./settings-ui";
import { when } from "./settings/admin/format";
import type { ContactsLdapStatus } from "@/lib/contacts-ldap";

export function AdminContactsLdap({
  status,
  busy,
  act,
}: {
  status: ContactsLdapStatus;
  busy: string;
  act: (action: string, extra?: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const [baseDn, setBaseDn] = useState(status.baseDnSource === "admin" ? status.baseDn : "");
  const [filter, setFilter] = useState(status.filterSource === "admin" ? status.filter : "");
  const [interval, setInterval_] = useState(status.intervalMinutes);
  const [test, setTest] = useState<{ ok: boolean; ms: number; error: string; at: number } | null>(null);
  useEffect(() => {
    setBaseDn(status.baseDnSource === "admin" ? status.baseDn : "");
    setFilter(status.filterSource === "admin" ? status.filter : "");
    setInterval_(status.intervalMinutes);
  }, [status.baseDn, status.baseDnSource, status.filter, status.filterSource, status.intervalMinutes]);
  const tone = !status.server || !status.enabled ? "off" : status.lastSync && !status.lastSync.ok ? "error" : "ok";
  const source = (s: string) =>
    s === "admin" ? t("hier gesetzt", "set here") : s === "env" ? t("aus der Umgebung", "from the environment") : s === "sign-in" ? t("wie die Anmeldung (LDAP_BASE_DN)", "as for sign-in (LDAP_BASE_DN)") : t("Standard", "default");
  return (
    <SettingGroup
      id="ldap-contacts"
      title={t("Kontakte aus LDAP", "Contacts from LDAP")}
      description={
        status.server
          ? t(
              "Kontakte-Datenbanken übernehmen Personen aus einer OU und gleichen sie regelmäßig ab (nur Verzeichnis → Flowplan). Server, Suchkonto und TLS sind die der LDAP-Anmeldung; das Passwort bleibt in der Umgebung.",
              "Contacts databases import people from an OU and sync them regularly (directory → Flowplan only). Server, search account and TLS are those of the LDAP sign-in; the password stays in the environment.",
            )
          : t("Nicht verfügbar: LDAP_URL ist nicht gesetzt.", "Not available: LDAP_URL is not set.")
      }
      actions={<StatusBadge tone={tone}>{tone === "off" ? t("Aus", "Off") : tone === "error" ? t("Fehler", "Error") : t("An", "On")}</StatusBadge>}
    >
      {status.server && (
        <>
          <SettingRow label={t("Kontakte aus dem Verzeichnis", "Contacts from the directory")} description={t("Ausgeschaltet können keine Personen importiert werden und der Abgleich ruht.", "Switched off, nobody can import people and the sync rests.")}>
            <label className="checkbox-label">
              <input type="checkbox" checked={status.enabled} disabled={!!busy} onChange={(e) => void act("contacts.ldap.save", { settings: { enabled: e.target.checked } })} />
              {t("Erlaubt", "Allowed")}
            </label>
          </SettingRow>
          <SettingRow id="contacts-base-dn" label={t("Basis-DN für Kontakte", "Base DN for contacts")} description={`${status.baseDn || "–"} · ${source(status.baseDnSource)}`}>
            <input id="contacts-base-dn" className={CONTROL.lg} value={baseDn} placeholder={status.baseDnSource === "admin" ? "" : status.baseDn} spellCheck={false} onChange={(e) => setBaseDn(e.target.value)} />
          </SettingRow>
          <SettingRow id="contacts-filter" label={t("Filter für Personen", "Filter for people")} description={source(status.filterSource)}>
            <input id="contacts-filter" className={CONTROL.lg} value={filter} placeholder={status.filterSource === "admin" ? "" : status.filter} spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
          </SettingRow>
          <SettingRow id="contacts-interval" label={t("Abgleich alle", "Sync every")} description={t("Minuten (15 bis 1440)", "minutes (15 to 1440)")}>
            <input id="contacts-interval" className={CONTROL.sm} type="number" min={15} max={1440} value={interval} onChange={(e) => setInterval_(Number(e.target.value))} />
          </SettingRow>
          <SettingRow
            label={t("Übernehmen", "Apply")}
            description={
              test
                ? test.ok
                  ? t(`Erreichbar (${test.ms} ms) · ${when(test.at)}`, `Reachable (${test.ms} ms) · ${when(test.at)}`)
                  : t(`Fehler: ${test.error} · ${when(test.at)}`, `Error: ${test.error} · ${when(test.at)}`)
                : t("Leere Felder nehmen den Wert aus der Umgebung.", "Empty fields take the value from the environment.")
            }
          >
            <span className="admin-actions">
              <button
                type="button"
                className="button primary"
                disabled={!!busy}
                onClick={() => void act("contacts.ldap.save", { settings: { baseDn: baseDn.trim(), filter: filter.trim(), intervalMinutes: Math.min(1440, Math.max(15, Math.round(interval) || 60)) } })}
              >
                {t("Speichern", "Save")}
              </button>
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={async () => {
                  const r = (await act("contacts.ldap.test")) as { test?: { ok: boolean; ms: number; error: string; at: number } } | undefined;
                  if (r?.test) setTest(r.test);
                }}
              >
                <Plugs size={16} /> {t("Verbindung testen", "Test connection")}
              </button>
            </span>
          </SettingRow>
          <SettingRow
            label={t("Stand", "Status")}
            description={
              status.lastSync
                ? status.lastSync.ok
                  ? t(
                      `${when(status.lastSync.at)} · ${status.databases} Datenbanken, ${status.records} Kontakte aus dem Verzeichnis`,
                      `${when(status.lastSync.at)} · ${status.databases} databases, ${status.records} contacts from the directory`,
                    )
                  : t(`${when(status.lastSync.at)} · Fehler: ${status.lastSync.error}`, `${when(status.lastSync.at)} · Error: ${status.lastSync.error}`)
                : t(`Noch kein Abgleich · ${status.databases} Datenbanken`, `No sync yet · ${status.databases} databases`)
            }
          >
            <span />
          </SettingRow>
        </>
      )}
    </SettingGroup>
  );
}
