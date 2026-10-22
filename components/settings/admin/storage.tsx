"use client";
// Administration → Speicher & Sicherung: the one home of everything about
// backups – what is stored where (local, S3), the S3 mirror and Litestream,
// the scheduled backup with its settings and a run right now, the download
// of the whole instance, and the restore at the end.
import { useState } from "react";
import { DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { DangerZone, SaveState, SettingGroup, SettingRow, StatusBadge, useSaveState } from "../../settings-ui";
import { StorageCounts, StorageUsage, bytes, useStorageOverview } from "../../admin-storage";
import { useAdminData, type AdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, InstanceNumber, InstanceSwitch, useDocs, type StatusItem } from "./parts";
import { ago } from "./format";

export default function StorageSection() {
  const t = useT();
  const docs = useDocs();
  const { data, load, onError } = useAdminData();
  const storage = useStorageOverview(onError);
  if (!data) return <AdminLoading />;
  const s3 = storage.data?.objectStorage;
  const backup = data.backup;
  const items: StatusItem[] = [];
  if (s3)
    items.push(
      !s3.enabled
        ? { tone: "off", label: t("S3 aus", "S3 off") }
        : s3.reachable
          ? { tone: "ok", label: t("S3 verbunden", "S3 connected") }
          : {
              tone: "error",
              label: t("S3 nicht erreichbar", "S3 not reachable"),
            },
    );
  items.push(data.encryption.litestream ? { tone: "ok", label: t("Litestream aktiv", "Litestream active") } : { tone: "off", label: t("Litestream aus", "Litestream off") });
  items.push(
    !backup.enabled
      ? {
          tone: "warn",
          label: t("Geplante Sicherung aus", "Scheduled backup off"),
        }
      : backup.last?.error
        ? {
            tone: "error",
            label: t("Letzte Sicherung fehlgeschlagen", "Last backup failed"),
          }
        : backup.last
          ? {
              tone: "ok",
              label: t(`Letzte Sicherung ${ago(backup.last.at, t)}`, `Last backup ${ago(backup.last.at, t)}`),
            }
          : { tone: "warn", label: t("Noch keine Sicherung", "No backup yet") },
  );
  if (data.restorePending)
    items.push({
      tone: "warn",
      label: t("Wiederherstellung wartet auf Neustart", "Restore waits for a restart"),
    });
  return (
    <>
      <AdminStatus
        items={items}
        action={
          !backup.enabled || backup.last?.error ? (
            <FixLink href="#admin/storage/backup">{t("Zur Sicherung", "To the backup")}</FixLink>
          ) : s3 && !s3.enabled ? (
            <FixLink
              href={docs("configuration", "s3-und-datenbanksicherung", "s3-and-database-backup")}
            >
              {t("S3 einrichten", "Set up S3")}
            </FixLink>
          ) : undefined
        }
      />
      <Backups data={data} storage={storage} onChange={load} />
      <StorageUsage storage={storage} />
      <InstanceBackup />
      {storage.data && <StorageCounts data={storage.data} />}
      <Restore pending={data.restorePending} onChange={load} onError={onError} />
    </>
  );
}

// Where copies go and when: the S3 mirror, Litestream, the scheduled backup
// (with its settings) and a run right now.
function Backups({ data, storage, onChange }: { data: AdminData; storage: ReturnType<typeof useStorageOverview>; onChange: () => Promise<void> }) {
  const t = useT();
  const [status, run] = useSaveState();
  const [note, setNote] = useState("");
  const backup = data.backup;
  const s3 = storage.data?.objectStorage;
  const enc = data.encryption;
  return (
    <SettingGroup
      id="backup"
      title={t("Sicherungen", "Backups")}
      description={t("Was wohin gesichert wird und wann zuletzt.", "What is backed up where, and when last.")}
      actions={
        <button
          type="button"
          className="button primary"
          disabled={status.state === "saving"}
          onClick={() =>
            void run(async () => {
              setNote("");
              await api("/api/admin/backup-run", {});
              setNote(t("Sicherung erstellt.", "Backup created."));
              await onChange();
            })
          }
        >
          {status.state === "saving" ? t("Sichert …", "Backing up …") : t("Jetzt sichern", "Back up now")}
        </button>
      }
    >
      {note && (
        <p className="setting-row admin-note" role="status">
          {note}
        </p>
      )}
      <SettingRow
        label={t("S3-Spiegel", "S3 mirror")}
        description={
          !s3
            ? t("Wird geprüft …", "Checking …")
            : !s3.enabled
              ? t(
                  "Nicht eingerichtet – alles liegt lokal. Mit den Variablen S3_* werden Dateien und Datenbank zusätzlich in einen Bucket gesichert.",
                  "Not set up – everything is local. With the S3_* variables, files and database are also backed up to a bucket.",
                )
              : [
                  `${s3.bucket} ${t("auf", "on")} ${s3.endpoint}${s3.prefix ? ` · ${t("Ordner", "folder")} ${s3.prefix}` : ""}`,
                  s3.reachable && s3.latencyMs !== undefined ? `${s3.latencyMs} ms` : "",
                  !s3.reachable && s3.error ? s3.error : "",
                  s3.pending ? t(`${s3.pending} ausstehend`, `${s3.pending} pending`) : t("Warteschlange leer", "queue empty"),
                  s3.retrying ? t("wird wiederholt", "retrying") : "",
                  s3.reachable && s3.missing !== undefined
                    ? s3.missing
                      ? t(`${s3.missing} Dateien fehlen im Bucket`, `${s3.missing} files missing in the bucket`)
                      : t("alle Dateien im Bucket", "all files in the bucket")
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
        }
      >
        {s3 &&
          (!s3.enabled ? (
            <StatusBadge tone="off">{t("Aus", "Off")}</StatusBadge>
          ) : s3.reachable ? (
            <StatusBadge tone={s3.retrying ? "warn" : "ok"}>{t("Verbunden", "Connected")}</StatusBadge>
          ) : (
            <StatusBadge tone="error">{t("Nicht erreichbar", "Not reachable")}</StatusBadge>
          ))}
      </SettingRow>
      <SettingRow
        label="Litestream"
        description={
          enc.litestream
            ? [
                t("Fortlaufende Kopie der Datenbank im Bucket (Ordner db/)", "Continuous copy of the database in the bucket (folder db/)"),
                s3 && s3.enabled && s3.reachable && s3.backup?.lastModified
                  ? t(`zuletzt ${ago(Date.parse(s3.backup.lastModified), t)} · ${bytes(s3.backup.bytes)}`, `last ${ago(Date.parse(s3.backup.lastModified), t)} · ${bytes(s3.backup.bytes)}`)
                  : "",
                enc.litestreamSseC ? t("SSE-C verschlüsselt", "SSE-C encrypted") : t("unverschlüsselt", "unencrypted"),
              ]
                .filter(Boolean)
                .join(" · ")
            : t("Aus. Läuft mit S3 automatisch, außer bei FLOWPLAN_LITESTREAM=off.", "Off. Runs automatically with S3 unless FLOWPLAN_LITESTREAM=off.")
        }
      >
        <StatusBadge tone={enc.litestream ? (enc.litestreamSseC || !enc.enabled ? "ok" : "warn") : "off"}>{enc.litestream ? t("Aktiv", "Active") : t("Aus", "Off")}</StatusBadge>
      </SettingRow>
      <InstanceSwitch
        field="backupSchedule"
        label={backup.hourly ? t("Geplante Datenbanksicherung", "Scheduled database backup") : t("Tägliche Datenbanksicherung", "Daily database backup")}
        description={
          <>
            {backup.target === "s3" ? t("In den S3-Bucket (Ordner backups/)", "Into the S3 bucket (folder backups/)") : t("In den Datenordner (backups/)", "Into the data folder (backups/)")} ·{" "}
            {backup.encrypted ? t("verschlüsselt", "encrypted") : t("unverschlüsselt", "unencrypted")}
            {!backup.encrypted && (
              <>
                {" "}
                · <a href="#admin/security">{t("Verschlüsselung", "Encryption")}</a>
              </>
            )}
          </>
        }
      />
      <InstanceSwitch
        field="backupInterval"
        checked={backup.hourly}
        patch={(on) => ({ backupInterval: on ? "hourly" : "daily" })}
        label={t("Stündlich statt täglich", "Hourly instead of daily")}
        description={t(
          "Für verschlüsselte Sicherungen anstelle von Litestream (FLOWPLAN_LITESTREAM=off). Dann mehr Sicherungen aufbewahren, z. B. 72 für drei Tage.",
          "For encrypted backups in place of Litestream (FLOWPLAN_LITESTREAM=off). Keep more backups then, e.g. 72 for three days.",
        )}
        disabled={!backup.enabled}
      />
      <InstanceNumber
        field="backupKeep"
        label={t("Aufbewahrte Sicherungen", "Backups kept")}
        description={t("Die ältesten werden danach entfernt.", "The oldest are removed afterwards.")}
        unit={t("Stück", "copies")}
        min={1}
        max={365}
        fallback={7}
      />
      <SettingRow
        label={t("Letzte Sicherung", "Last backup")}
        description={
          backup.last
            ? backup.last.error
              ? `${new Date(backup.last.at).toLocaleString(LOCALE_TAG)}: ${backup.last.error}`
              : `${new Date(backup.last.at).toLocaleString(LOCALE_TAG)} · ${backup.last.name} (${(backup.last.bytes / 1048576).toFixed(1)} MB) · ${t(`die neuesten ${backup.keep} bleiben erhalten`, `the latest ${backup.keep} are kept`)}`
            : t("Noch keine.", "None yet.")
        }
      >
        <SaveState status={status} />
        {backup.last && <StatusBadge tone={backup.last.error ? "error" : "ok"}>{backup.last.error ? t("Fehlgeschlagen", "Failed") : t("In Ordnung", "Fine")}</StatusBadge>}
      </SettingRow>
    </SettingGroup>
  );
}

// The download of the whole instance (database and uploads).
function InstanceBackup() {
  const t = useT();
  return (
    <SettingGroup
      id="instance-backup"
      title={t("Gesamte Instanz", "Whole instance")}
      description={t("Alle Arbeitsbereiche, Konten, Einstellungen und Dateien in einer Datei.", "All workspaces, accounts, settings and files in one file.")}
    >
      <SettingRow label={t("Sicherung herunterladen", "Download backup")} description={t("Enthält vertrauliche Daten – sicher verwahren.", "Contains confidential data – keep it safe.")}>
        <a className="button" href="/api/admin/instance-backup" download>
          <DownloadSimple size={16} aria-hidden /> {t("Herunterladen", "Download")}
        </a>
      </SettingRow>
    </SettingGroup>
  );
}

// Restoring replaces everything on the next restart: at the end, in red.
function Restore({ pending, onChange, onError }: { pending: AdminData["restorePending"]; onChange: () => Promise<void>; onError: (message: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <DangerZone
      id="restore"
      title={t("Aus Sicherung wiederherstellen", "Restore from backup")}
      description={t(
        "Die hochgeladene Sicherung wird geprüft und beim nächsten Neustart des Servers übernommen. Der bisherige Stand bleibt im Datenordner als „pre-restore-…“ erhalten. Alle Sitzungen enden mit der Übernahme.",
        "The uploaded backup is checked and applied on the next server restart. The previous state stays in the data folder as “pre-restore-…”. All sessions end when it is applied.",
      )}
    >
      {pending ? (
        <SettingRow
          label={t("Bereit zur Übernahme beim Neustart", "Ready to apply on restart")}
          description={
            <span role="status">
              {t("Sicherung vom", "Backup from")} {pending.createdAt ? new Date(pending.createdAt).toLocaleString(LOCALE_TAG) : t("unbekannten Datum", "an unknown date")} {t("mit", "with")}{" "}
              {pending.workspaces} {t("Arbeitsbereichen,", "workspaces,")} {pending.pages} {t("Seiten,", "pages,")} {pending.users} {t("Konten und", "accounts and")} {pending.files}{" "}
              {t("Dateien.", "files.")}
            </span>
          }
        >
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await fetch("/api/admin/instance-backup", {
                  method: "DELETE",
                });
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
        </SettingRow>
      ) : (
        <SettingRow
          label={t("Sicherung hochladen", "Upload backup")}
          description={t("Eine ZIP-Datei aus „Herunterladen“ (oder .enc, verschlüsselt).", "A ZIP file from “Download” (or .enc, encrypted).")}
        >
          <label className={`button danger file-label${busy ? " disabled" : ""}`}>
            <UploadSimple size={16} aria-hidden />
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
                  const r = await fetch("/api/admin/instance-backup", {
                    method: "POST",
                    headers: { "Content-Type": "application/zip" },
                    body: file,
                  });
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
        </SettingRow>
      )}
    </DangerZone>
  );
}
