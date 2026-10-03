"use client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, CloudCheck, CloudSlash, Database, HardDrives } from "@phosphor-icons/react";
import { api } from "./ui";
import type { StorageOverview } from "@/lib/storage-overview";

const COLORS = ["#3b3fd8", "#7c4dff", "#2f9e6e", "#f0663a", "#d6457a", "#1c9bb3", "#c99a2e", "#8a8691", "#5e5a66", "#b3afbd"];
export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = value / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(LOCALE_TAG, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}
const number = (n: number) => n.toLocaleString(LOCALE_TAG);
function ago(iso: string | null, t: (de: string, en: string) => string) {
  if (!iso) return t("noch keine", "none yet");
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return t("gerade eben", "just now");
  if (minutes < 60) return t(`vor ${minutes} Min.`, `${minutes} min ago`);
  if (minutes < 1440) return t(`vor ${Math.round(minutes / 60)} Std.`, `${Math.round(minutes / 60)} h ago`);
  return t(`vor ${Math.round(minutes / 1440)} Tagen`, `${Math.round(minutes / 1440)} days ago`);
}

// A stacked bar with its legend: shares of a total.
function Breakdown({
  parts,
  label,
}: {
  parts: { key: string; label: string; bytes: number; files?: number }[];
  label: string;
}) {
  const t = useT();
  const total = parts.reduce((sum, p) => sum + p.bytes, 0);
  const shown = parts.filter((p) => p.bytes > 0);
  return (
    <div className="storage-breakdown">
      <div className="storage-bar" role="img" aria-label={label}>
        {shown.map((p, i) => (
          <span
            key={p.key}
            title={`${p.label}: ${bytes(p.bytes)}`}
            style={{ width: `${Math.max(1, (p.bytes / Math.max(1, total)) * 100)}%`, background: COLORS[i % COLORS.length] }}
          />
        ))}
      </div>
      <ul>
        {shown.length ? (
          shown.map((p, i) => (
            <li key={p.key}>
              <i style={{ background: COLORS[i % COLORS.length] }} />
              <span>{p.label}</span>
              {p.files !== undefined && <small>{number(p.files)} {t("Dateien", "Files")}</small>}
              <strong>{bytes(p.bytes)}</strong>
            </li>
          ))
        ) : (
          <li className="storage-empty">{t("Noch nichts gespeichert", "Nothing stored yet")}</li>
        )}
      </ul>
    </div>
  );
}

export function AdminStorage({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [data, setData] = useState<StorageOverview | null>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api<StorageOverview>("/api/admin/storage"));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data)
    return (
      <section className="settings-section">
        <h2>{t("Speicher", "Storage")}</h2>
        <p className="muted">{t("Speicher wird geprüft …", "Checking storage …")}</p>
      </section>
    );
  const s3 = data.objectStorage,
    c = data.counts;
  return (
    <section className="settings-section admin-storage">
      <div className="settings-list-head">
        <h2>{t("Speicher", "Storage")}</h2>
        <button type="button" className="button" onClick={() => void load()} disabled={busy}>
          <ArrowClockwise size={15} className={busy ? "spin" : undefined} />
          {busy ? t("Prüfe …", "Checking …") : t("Aktualisieren", "Refresh")}
        </button>
      </div>

      <div
        className="storage-status"
        data-state={!s3.enabled ? "off" : s3.reachable ? "ok" : "error"}
        role="status"
      >
        {s3.enabled && s3.reachable ? <CloudCheck size={22} /> : <CloudSlash size={22} />}
        <div>
          <strong>
            {!s3.enabled
              ? t("S3 nicht eingerichtet – alles liegt lokal", "S3 not set up – everything is local")
              : s3.reachable
                ? "S3 verbunden"
                : t("S3 nicht erreichbar", "S3 not reachable")}
          </strong>
          {s3.enabled ? (
            <span>
              {s3.bucket} {t("auf", "on")}{" "}{s3.endpoint}
              {s3.prefix ? ` · Ordner ${s3.prefix}` : ""}
              {s3.reachable && s3.latencyMs !== undefined ? ` · ${s3.latencyMs} ms` : ""}
              {!s3.reachable && s3.error ? ` · ${s3.error}` : ""}
            </span>
          ) : (
            <span>{t("Mit den Variablen S3_* werden Dateien und Datenbank zusätzlich in einen Bucket gesichert.", "With the S3_* variables, files and database are also backed up to a bucket.")}</span>
          )}
        </div>
        {s3.enabled && (
          <dl>
            <div>
              <dt>{t("Warteschlange", "Queue")}</dt>
              <dd>
                {s3.pending ? `${number(s3.pending)} ausstehend` : "leer"}
                {s3.retrying ? t(" · wird wiederholt", " · retrying") : ""}
              </dd>
            </div>
            {s3.reachable && s3.backup && (
              <div>
                <dt>{t("Datenbanksicherung", "Database backup")}</dt>
                <dd>{s3.backup.objects ? `${ago(s3.backup.lastModified, t)} · ${bytes(s3.backup.bytes)}` : t("noch keine", "none yet")}</dd>
              </div>
            )}
            {s3.reachable && s3.missing !== undefined && (
              <div>
                <dt>{t("Abgleich", "Reconciliation")}</dt>
                <dd>
                  {s3.missing ? t(`${number(s3.missing)} Dateien fehlen im Bucket`, `${number(s3.missing)} files missing in the bucket`) : t("alle Dateien im Bucket", "all files in the bucket")}
                  {s3.orphans ? t(` · ${number(s3.orphans)} ohne Datei`, ` · ${number(s3.orphans)} without a file`) : ""}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>

      <div className="storage-columns">
        <div className="storage-panel">
          <h3>
            <HardDrives size={18} /> {t("Lokal", "Local")}
            <strong>{bytes(data.local.databaseBytes + data.local.uploads.bytes)}</strong>
          </h3>
          <h4>
            {t("SQLite-Datenbank", "SQLite database")}{" "}<span>{bytes(data.local.databaseBytes)}</span>
          </h4>
          <Breakdown parts={data.local.database} label={t("Aufteilung der Datenbank", "Database breakdown")} />
          <h4>
            {t("Hochgeladene Dateien", "Uploaded files")}{" "}<span>{bytes(data.local.uploads.bytes)} · {number(data.local.uploads.files)}</span>
          </h4>
          <Breakdown parts={data.local.uploads.byType} label={t("Dateien nach Art", "Files by kind")} />
        </div>
        <div className="storage-panel">
          <h3>
            <Database size={18} /> S3
            <strong>
              {s3.enabled && s3.reachable && s3.uploads
                ? bytes(s3.uploads.bytes + (s3.backup?.bytes || 0) + (s3.other?.bytes || 0))
                : "–"}
            </strong>
          </h3>
          {s3.enabled && s3.reachable && s3.uploads ? (
            <>
              <h4>
                {t("Datenbanksicherung (Litestream)", "Database backup (Litestream)")}{" "}<span>{bytes(s3.backup?.bytes || 0)} · {number(s3.backup?.objects || 0)} {t("Teile", "Parts")}</span>
              </h4>
              <h4>
                {t("Dateien", "Files")}{" "}<span>{bytes(s3.uploads.bytes)} · {number(s3.uploads.objects)}</span>
              </h4>
              <Breakdown parts={s3.uploads.byType} label={t("Dateien im Bucket nach Art", "Files in the bucket by kind")} />
              {s3.partial && <p className="muted">{t("Mehr als 50 000 Objekte – Werte unvollständig.", "More than 50,000 objects – values incomplete.")}</p>}
            </>
          ) : (
            <p className="muted">
              {s3.enabled ? t("Der Bucket kann gerade nicht gelesen werden.", "The bucket cannot be read right now.") : t("Kein S3-Speicher eingerichtet.", "No S3 storage set up.")}
            </p>
          )}
        </div>
      </div>

      <h3 className="storage-counts-title">{t("Inhalte", "Content")}</h3>
      <div className="admin-metrics storage-counts">
        {(
          [
            [t("Arbeitsbereiche", "Workspaces"), c.workspaces],
            [t("Bereiche", "Spaces"), c.spaces],
            [t("Dokumente", "Documents"), c.documents],
            [t("Datenbanken", "Databases"), c.databases],
            [t("Datensätze", "Records"), c.rows],
            [t("Whiteboards", "Whiteboards"), c.whiteboards],
            [t("Journale", "Journals"), t(`${number(c.journals)} · ${number(c.journalDays)} Tage`, `${number(c.journals)} · ${number(c.journalDays)} days`)],
            [t("Dateien", "Files"), c.files],
            [t("Kommentare", "Comments"), c.comments],
            [t("Versionen", "Versions"), c.versions],
            [t("Vorlagen", "Templates"), c.templates],
            [t("Im Papierkorb", "In trash"), c.trashedPages],
            [t("Gastlinks", "Guest links"), c.shareLinks],
            [t("Veröffentlicht", "Published"), c.publications],
            [t("Aktive Formulare", "Active forms"), c.forms],
            [t("Benutzer", "Users"), `${number(c.users)}${c.disabledUsers ? ` · ${number(c.disabledUsers)} gesperrt` : ""}`],
            [t("Aktive Sitzungen", "Active sessions"), c.sessions],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{typeof value === "number" ? number(value) : value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
