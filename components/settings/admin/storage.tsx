"use client";
// Administration → Speicher & Sicherung: what is stored where (local, S3),
// the scheduled backup with a manual run, and the backup and restore of the
// whole instance.
import { useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { AdminStorage } from "../../admin-storage";
import { useAdminData, type AdminData } from "../admin-context";
import { AdminLoading } from "../shell";

export default function StorageSection() {
  const { data, load, onError } = useAdminData();
  return (
    <>
      <AdminStorage onError={onError} />
      {data ? (
        <>
          <ScheduledBackup backup={data.backup} onChange={load} onError={onError} />
          <InstanceBackup pending={data.restorePending} onChange={load} onError={onError} />
        </>
      ) : (
        <AdminLoading />
      )}
    </>
  );
}

// The scheduled backup: how, where, the last run, and a run right now.
function ScheduledBackup({ backup, onChange, onError }: { backup: AdminData["backup"]; onChange: () => void; onError: (message: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  return (
    <section className="settings-section">
      <h2>{t("Geplante Sicherung", "Scheduled backup")}</h2>
      <p>
        {backup.enabled ? (backup.hourly ? t("Stündlich", "Hourly") : t("Täglich", "Daily")) : t("Ausgeschaltet", "Off")} ·{" "}
        {backup.encrypted ? t("verschlüsselt", "encrypted") : t("unverschlüsselt", "unencrypted")} ·{" "}
        {backup.target === "s3" ? t("in den S3-Bucket", "into the S3 bucket") : t("in den Datenordner", "into the data folder")} {t("· die neuesten", "· the latest")}{" "}
        {backup.keep} {t("bleiben erhalten.", "are kept.")}
      </p>
      {backup.last && (
        <p className={backup.last.error ? "error" : "muted"}>
          {t("Letzte Sicherung", "Last backup")}{" "}{new Date(backup.last.at).toLocaleString(LOCALE_TAG)}:{" "}
          {backup.last.error ? backup.last.error : `${backup.last.name} (${(backup.last.bytes / 1048576).toFixed(1)} MB)`}
        </p>
      )}
      <button
        className="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote("");
          try {
            await api("/api/admin/backup-run", {});
            setNote(t("Sicherung erstellt.", "Backup created."));
            onChange();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t("Sichert …", "Backing up …") : t("Jetzt sichern", "Back up now")}
      </button>
      {note && <p role="status">{note}</p>}
    </section>
  );
}

// Backup and restore of the whole instance (database and uploads).
function InstanceBackup({ pending, onChange, onError }: { pending: AdminData["restorePending"]; onChange: () => Promise<void>; onError: (message: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings-section instance-backup" aria-label={t("Instanzsicherung", "Instance backup")}>
      <h2>{t("Sicherung der gesamten Instanz", "Backup of the whole instance")}</h2>
      <p className="muted">
        {t("Enthält alle Arbeitsbereiche, Konten, Einstellungen und Dateien. Die Datei enthält vertrauliche Daten und sollte sicher verwahrt werden.", "Contains all workspaces, accounts, settings and files. The file holds confidential data and should be kept safe.")}
      </p>
      <a className="button" href="/api/admin/instance-backup" download>
        {t("Sicherung herunterladen", "Download backup")}
      </a>
      <h3>{t("Aus Sicherung wiederherstellen", "Restore from backup")}</h3>
      <p className="muted">
        {t("Die hochgeladene Sicherung wird geprüft und beim nächsten Neustart des Servers übernommen. Der bisherige Stand bleibt im Datenordner als „pre-restore-…“ erhalten. Alle Sitzungen enden mit der Übernahme.", "The uploaded backup is checked and applied on the next server restart. The previous state stays in the data folder as “pre-restore-…”. All sessions end when it is applied.")}
      </p>
      {pending ? (
        <div className="callout" role="status">
          <span>
            {t("Bereit zur Übernahme beim Neustart: Sicherung vom", "Ready to apply on restart: backup from")}{" "}
            {pending.createdAt ? new Date(pending.createdAt).toLocaleString(LOCALE_TAG) : t("unbekannten Datum", "an unknown date")}{" "}
            {t("mit", "with")}{" "}{pending.workspaces} {t("Arbeitsbereichen,", "workspaces,")}{" "}{pending.pages} {t("Seiten,", "pages,")}{" "}
            {pending.users} {t("Konten und", "accounts and")}{" "}{pending.files} {t("Dateien.", "files.")}
          </span>
          <button
            className="button compact"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await fetch("/api/admin/instance-backup", { method: "DELETE" });
                if (!r.ok) throw new Error(serverMessage((await r.json()).error));
                await onChange();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Wiederherstellung abbrechen", "Cancel restore")}
          </button>
        </div>
      ) : (
        <label className="button file-label">
          {busy ? t("Sicherung wird geprüft …", "Checking backup …") : t("Sicherung auswählen", "Choose backup")}
          <input
            type="file"
            accept=".zip,.enc"
            hidden
            aria-label={t("Instanzsicherung hochladen", "Upload instance backup")}
            disabled={busy}
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!file) return;
              setBusy(true);
              try {
                const r = await fetch("/api/admin/instance-backup", { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
                if (!r.ok) throw new Error(serverMessage((await r.json()).error));
                await onChange();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      )}
    </section>
  );
}
