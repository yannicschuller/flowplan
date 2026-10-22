"use client";
// Administration → Instanz: the running version and whether a newer one is
// out, the counts of the instance, and the instance-wide settings (name,
// notice, access, limits, versions and backup) as one form with a save bar.
import { useState } from "react";
import { ArrowCircleUp, Key, ShieldCheck, Stack, Users } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { InstanceSettings } from "@/lib/instance-settings";
import { useLocale, useT } from "../../i18n";
import { Select } from "../../select";
import { NumberField, SaveBar, SettingGroup, SettingRow, SwitchRow } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";

export default function GeneralSection() {
  const t = useT();
  const locale = useLocale();
  const { data, act } = useAdminData();
  if (!data) return <AdminLoading />;
  return (
    <>
      {data.update && (
        <div className="callout admin-update" role="status">
          <ArrowCircleUp size={20} aria-hidden="true" />
          <span>
            <strong>{t(`Flowplan ${data.update.latest} ist verfügbar.`, `Flowplan ${data.update.latest} is available.`)}</strong>{" "}
            {t(`Diese Instanz läuft mit ${data.update.current}.`, `This instance runs ${data.update.current}.`)}
          </span>
          <span className="admin-update-links">
            {data.update.url && (
              <a href={data.update.url} target="_blank" rel="noreferrer">
                {t("Was ist neu", "What's new")}
              </a>
            )}
            <a href={locale === "de" ? "https://docs.flowplan.org/de/installation#aktualisieren" : "https://docs.flowplan.org/en/installation#update"} target="_blank" rel="noreferrer">
              {t("So aktualisierst du", "How to update")}
            </a>
          </span>
        </div>
      )}
      <div className="admin-stats">
        <div>
          <Users />
          <strong>{data.users.length}</strong>
          <span>{t("Benutzer", "Users")}</span>
        </div>
        <div>
          <Stack />
          <strong>{data.workspaces.length}</strong>
          <span>{t("Arbeitsbereiche", "Workspaces")}</span>
        </div>
        <div>
          <Key />
          <strong>{data.sessions}</strong>
          <span>{t("Aktive Sitzungen", "Active sessions")}</span>
        </div>
      </div>
      <div className="callout">
        <ShieldCheck size={20} />
        <span>
          {t("Admin-Gruppe:", "Admin group:")}{" "}<strong>{data.adminGroup}</strong> · OIDC{" "}
          {data.oidcConfigured ? t("konfiguriert", "configured") : t("nicht konfiguriert", "not configured")}
        </span>
        {data.build && (
          <span className="admin-build" aria-label={t("Laufende Version", "Running version")}>
            {data.build.version && <strong>v{data.build.version}</strong>}
            {data.build.commit ? (
              <a href={`${data.build.repository}/commit/${data.build.commit}`} target="_blank" rel="noreferrer" title={t(`Commit ${data.build.commit} auf GitHub ansehen`, `View commit ${data.build.commit} on GitHub`)}>
                <code>{data.build.commit.slice(0, 7)}</code>
              </a>
            ) : (
              <span title={t("Beim Bauen war kein Commit bekannt (GIT_COMMIT oder SOURCE_COMMIT).", "No commit was known when building (GIT_COMMIT or SOURCE_COMMIT).")}>{t("Commit unbekannt", "commit unknown")}</span>
            )}
            {data.build.builtAt && (
              <span title={new Date(data.build.builtAt).toLocaleString(LOCALE_TAG)}>
                {t("gebaut", "built")} {new Date(data.build.builtAt).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short", year: "numeric" })}
              </span>
            )}
          </span>
        )}
      </div>
      <InstanceSettingsForm
        initial={data.settings}
        localLogin={!!data.localLogin}
        onSave={async (settings) => {
          await act({ action: "admin.settings", settings });
        }}
      />
    </>
  );
}

// Instance-wide settings in groups; empty numbers fall back to the
// environment. Changes are kept as a draft until saved.
function InstanceSettingsForm({ initial, localLogin, onSave }: { initial: InstanceSettings; localLogin: boolean; onSave: (settings: InstanceSettings) => Promise<void> }) {
  const t = useT();
  const [saved, setSaved] = useState(initial),
    [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<InstanceSettings>) => {
    setDone(false);
    setDraft({ ...draft, ...patch });
  };
  const env = t("aus der Umgebung", "from the environment");
  const unlimited = t("unbegrenzt", "unlimited");
  return (
    <form
      className="instance-settings"
      aria-label={t("Instanzeinstellungen", "Instance settings")}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(draft);
          setSaved(draft);
          setDone(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <SettingGroup title={t("Allgemein", "General")} description={t("Wie die Instanz heißt und was alle oben sehen.", "What the instance is called and what everyone sees at the top.")}>
        <SettingRow id="instance-name" label={t("Name der Instanz", "Instance name")} description={t("Erscheint bei der Anmeldung und im Browser-Tab.", "Shown when signing in and in the browser tab.")}>
          <input id="instance-name" maxLength={60} placeholder={t("z. B. Flowplan der Muster GmbH", "e.g. Flowplan of Example Ltd")} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </SettingRow>
        <SettingRow wide id="instance-notice" label={t("Hinweis für alle Personen", "Notice for everyone")} description={t("Ein Banner über jeder Seite, etwa für Wartungsarbeiten. Leer = kein Hinweis.", "A banner above every page, e.g. for maintenance. Empty = no notice.")}>
          <textarea id="instance-notice" maxLength={500} rows={2} placeholder={t("z. B. Wartung am Samstag ab 18 Uhr", "e.g. Maintenance on Saturday from 6 pm")} value={draft.announcement} onChange={(e) => set({ announcement: e.target.value })} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("Zugang", "Access")} description={t("Wer ein Konto bekommt und was neue Personen dürfen.", "Who gets an account and what new people may do.")}>
        {localLogin && (
          <SwitchRow
            label={t("Registrierung mit E-Mail und Passwort", "Sign-up with email and password")}
            description={t("Ausgeschaltet legen nur eingeladene Adressen ein Konto an. Das erste Konto einer Instanz verwaltet sie.", "When off, only invited addresses can create an account. The first account of an instance administers it.")}
            checked={!!draft.allowSignup}
            onChange={(allowSignup) => set({ allowSignup })}
          />
        )}
        {localLogin && (
          <SettingRow
            id="instance-two-factor"
            label={t("Zwei-Faktor-Anmeldung verlangen", "Require two-factor sign-in")}
            description={t(
              "Für Konten mit E-Mail und Passwort: Authenticator-App oder Passkey. Wer noch keinen zweiten Faktor hat, richtet ihn direkt nach der Anmeldung ein. SSO-Konten regelt der Anbieter.",
              "For accounts with email and password: authenticator app or passkey. Whoever has no second factor yet sets one up right after signing in. SSO accounts are handled by the provider.",
            )}
          >
            <Select id="instance-two-factor" value={draft.twoFactor || "off"} onChange={(e) => set({ twoFactor: e.target.value as InstanceSettings["twoFactor"] })}>
              <option value="off">{t("Nicht verlangen", "Not required")}</option>
              <option value="admins">{t("Nur für Admins", "Only for admins")}</option>
              <option value="all">{t("Für alle lokalen Konten", "For all local accounts")}</option>
            </Select>
          </SettingRow>
        )}
        <SwitchRow
          label={t("Alle dürfen Arbeitsbereiche anlegen", "Everyone may create workspaces")}
          description={t("Ausgeschaltet legen nur Admins neue Arbeitsbereiche an.", "When off, only admins create new workspaces.")}
          checked={draft.allowWorkspaceCreation}
          onChange={(allowWorkspaceCreation) => set({ allowWorkspaceCreation })}
        />
        <SwitchRow
          label={t("Öffentliche Demo", "Public demo")}
          description={t("Besucher bekommen unter /demo ohne Konto einen Arbeitsbereich mit Beispielen. Er verschwindet nach 45 Minuten ohne Aktivität (spätestens nach 3 Stunden). Demos können nichts veröffentlichen, teilen oder einladen.", "Visitors get a workspace with examples at /demo without an account. It disappears after 45 minutes without activity (3 hours at the latest). Demos cannot publish, share or invite.")}
          checked={!!draft.publicDemo}
          onChange={(publicDemo) => set({ publicDemo })}
        />
        <SwitchRow
          label={t("Eigene Domains für Veröffentlichungen", "Custom domains for publications")}
          description={t(
            "Eigentümer können veröffentlichte Seiten unter einer eigenen Domain zeigen, nachdem sie sie per DNS-TXT-Eintrag bestätigt haben. Das Zertifikat besorgt der Reverse Proxy (etwa Caddy mit On-Demand-TLS).",
            "Owners can show published pages under their own domain after confirming it with a DNS TXT record. The reverse proxy obtains the certificate (e.g. Caddy with on-demand TLS).",
          )}
          checked={!!draft.customDomains}
          onChange={(customDomains) => set({ customDomains })}
        />
        <SwitchRow
          label={t("Block-Erweiterungen von jeder HTTPS-Adresse", "Block extensions from any HTTPS address")}
          description={t(
            "Ausgeschaltet registrieren Eigentümer nur Erweiterungen von den Adressen in PLUGIN_ALLOWED_ORIGINS. Erweiterungen laufen immer abgeschottet in einem Rahmen.",
            "When off, owners only register extensions from the addresses in PLUGIN_ALLOWED_ORIGINS. Extensions always run isolated in a frame.",
          )}
          checked={!!draft.pluginsAnyOrigin}
          onChange={(pluginsAnyOrigin) => set({ pluginsAnyOrigin })}
        />
        <SettingRow label={t("Inaktive Konten sperren", "Block inactive accounts")} description={t("Nach so vielen Tagen ohne Anmeldung (mindestens 30). Leer = nie.", "After this many days without signing in (at least 30). Empty = never.")}>
          <NumberField label={t("Inaktive Konten sperren nach Tagen", "Block inactive accounts after days")} value={draft.inactiveDays} min={30} max={3650} unit={t("Tage", "days")} placeholder={t("nie", "never")} onChange={(inactiveDays) => set({ inactiveDays })} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title={t("Speicher und Grenzen", "Storage and limits")}
        description={t("Standardwerte für alle. Einzelne Arbeitsbereiche und Personen lassen sich in ihren Reitern abweichend einstellen. 0 = unbegrenzt; Admins sind nicht begrenzt.", "Defaults for everyone. Individual workspaces and people can differ in their tabs. 0 = unlimited; admins are not limited.")}
      >
        <SettingRow label={t("Speicher je Arbeitsbereich", "Storage per workspace")} description={t("Dateien und Bilder aller Mitglieder zusammen.", "Files and images of all members together.")}>
          <NumberField label={t("Speicher je Arbeitsbereich", "Storage per workspace")} value={draft.defaultQuotaMb} unit="MB" placeholder={env} onChange={(defaultQuotaMb) => set({ defaultQuotaMb })} />
        </SettingRow>
        <SettingRow label={t("Speicher je Person", "Storage per person")} description={t("Alles, was eine Person hochlädt oder kopiert – über alle Arbeitsbereiche.", "Everything a person uploads or copies – across all workspaces.")}>
          <NumberField label={t("Speicher je Person", "Storage per person")} value={draft.defaultUserStorageMb} unit="MB" placeholder={unlimited} onChange={(defaultUserStorageMb) => set({ defaultUserStorageMb })} />
        </SettingRow>
        <SettingRow label={t("Eigene Arbeitsbereiche je Person", "Own workspaces per person")} description={t("Wie viele Arbeitsbereiche eine Person besitzen darf.", "How many workspaces a person may own.")}>
          <NumberField label={t("Eigene Arbeitsbereiche je Person", "Own workspaces per person")} value={draft.defaultUserWorkspaces} unit="" placeholder={unlimited} max={10000} onChange={(defaultUserWorkspaces) => set({ defaultUserWorkspaces })} />
        </SettingRow>
        <SettingRow label={t("Größte Datei beim Hochladen", "Largest upload")} description={t("Für jede einzelne Datei; je Person änderbar.", "For each single file; can differ per person.")}>
          <NumberField label={t("Größte Datei beim Hochladen", "Largest upload")} value={draft.maxUploadMb} min={1} max={1024} unit="MB" required onChange={(maxUploadMb) => set({ maxUploadMb: maxUploadMb ?? 1 })} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("Versionen und Sicherung", "Versions and backup")}>
        <SettingRow label={t("Versionen aufbewahren", "Keep versions")} description={t("Ältere Versionsstände von Seiten werden danach gelöscht. 0 = für immer.", "Older page versions are deleted afterwards. 0 = forever.")}>
          <NumberField label={t("Versionen aufbewahren", "Keep versions")} value={draft.retentionDays} max={36500} unit={t("Tage", "days")} placeholder={env} onChange={(retentionDays) => set({ retentionDays })} />
        </SettingRow>
        <SwitchRow
          label={t("Tägliche Datenbanksicherung", "Daily database backup")}
          description={
            <>
              {t("Eine Kopie pro Tag – mit S3 in den Bucket (Ordner", "One copy per day – with S3 into the bucket (folder")} <code>backups/</code>
              {t("), sonst in den Datenordner.", "), otherwise into the data folder.")}
            </>
          }
          checked={draft.backupSchedule !== false}
          onChange={(backupSchedule) => set({ backupSchedule })}
        />
        <SwitchRow
          label={t("Stündlich statt täglich", "Hourly instead of daily")}
          description={t(
            "Für verschlüsselte Sicherungen anstelle von Litestream (FLOWPLAN_LITESTREAM=off). Dann mehr Sicherungen aufbewahren, z. B. 72 für drei Tage.",
            "For encrypted backups in place of Litestream (FLOWPLAN_LITESTREAM=off). Keep more backups then, e.g. 72 for three days.",
          )}
          checked={draft.backupInterval === "hourly"}
          disabled={draft.backupSchedule === false}
          onChange={(hourly) => set({ backupInterval: hourly ? "hourly" : "daily" })}
        />
        <SettingRow label={t("Aufbewahrte Sicherungen", "Backups kept")} description={t("Die ältesten werden danach entfernt.", "The oldest are removed afterwards.")}>
          <NumberField label={t("Aufbewahrte Sicherungen", "Backups kept")} value={draft.backupKeep ?? 7} min={1} max={365} unit={t("Stück", "copies")} onChange={(backupKeep) => set({ backupKeep: backupKeep ?? 7 })} />
        </SettingRow>
      </SettingGroup>
      <SaveBar
        dirty={dirty}
        busy={busy}
        onDiscard={() => setDraft(saved)}
        message={t("Ungespeicherte Änderungen", "Unsaved changes")}
        saveLabel={busy ? t("Speichert …", "Saving …") : t("Speichern", "Save")}
        discardLabel={t("Verwerfen", "Discard")}
      />
      {done && !dirty && (
        <p role="status" className="muted small">
          {t("Gespeichert.", "Saved.")}
        </p>
      )}
    </form>
  );
}
