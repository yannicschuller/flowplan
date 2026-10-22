"use client";
// Administration → Speicher & Sicherung: what is stored where – the local
// database and files, the S3 bucket – as stacked bars with their parts, and
// the counts of everything in the instance (/api/admin/storage).
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { api } from "./ui";
import { SettingGroup, SettingRow } from "./settings-ui";
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

// /api/admin/storage, loaded when the section opens; `load` checks again.
export function useStorageOverview(onError: (message: string) => void) {
  const [data, setData] = useState<StorageOverview | null>(null),
    [busy, setBusy] = useState(false);
  const report = useRef(onError);
  report.current = onError;
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api<StorageOverview>("/api/admin/storage"));
    } catch (error) {
      report.current((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, busy, load };
}

// A stacked bar with its legend: shares of a total.
function Breakdown({ parts, label }: { parts: { key: string; label: string; bytes: number; files?: number }[]; label: string }) {
  const t = useT();
  const total = parts.reduce((sum, p) => sum + p.bytes, 0);
  const shown = parts.filter((p) => p.bytes > 0);
  return (
    <div className="storage-breakdown">
      <div className="storage-bar" role="img" aria-label={`${label}: ${shown.map((p) => `${p.label} ${bytes(p.bytes)}`).join(", ") || t("leer", "empty")}`}>
        {shown.map((p, i) => (
          <span
            key={p.key}
            title={`${p.label}: ${bytes(p.bytes)}`}
            style={{
              width: `${Math.max(1, (p.bytes / Math.max(1, total)) * 100)}%`,
              background: COLORS[i % COLORS.length],
            }}
          />
        ))}
      </div>
      <ul>
        {shown.length ? (
          shown.map((p, i) => (
            <li key={p.key}>
              <i style={{ background: COLORS[i % COLORS.length] }} />
              <span>{p.label}</span>
              {p.files !== undefined && (
                <small>
                  {number(p.files)} {t("Dateien", "Files")}
                </small>
              )}
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

export function StorageUsage({ storage }: { storage: ReturnType<typeof useStorageOverview> }) {
  const t = useT();
  const { data, busy, load } = storage;
  const refresh = (
    <button type="button" className="button compact" onClick={() => void load()} disabled={busy}>
      <ArrowClockwise size={15} className={busy ? "spin" : undefined} aria-hidden />
      {busy ? t("Prüfe …", "Checking …") : t("Neu berechnen", "Recalculate")}
    </button>
  );
  if (!data)
    return (
      <SettingGroup id="usage" title={t("Belegung", "Usage")} actions={refresh}>
        <SettingRow label={t("Speicher wird geprüft …", "Checking storage …")}>
          <span />
        </SettingRow>
      </SettingGroup>
    );
  const s3 = data.objectStorage;
  const local = data.local.databaseBytes + data.local.uploads.bytes;
  const remote = s3.enabled && s3.reachable && s3.uploads ? s3.uploads.bytes + (s3.backup?.bytes || 0) + (s3.other?.bytes || 0) : null;
  return (
    <SettingGroup
      id="usage"
      title={t("Belegung", "Usage")}
      description={
        remote !== null ? t(`Lokal ${bytes(local)} · im Bucket ${bytes(remote)}`, `Local ${bytes(local)} · in the bucket ${bytes(remote)}`) : t(`Lokal ${bytes(local)}`, `Local ${bytes(local)}`)
      }
      actions={refresh}
    >
      <SettingRow wide label={t("SQLite-Datenbank", "SQLite database")} description={bytes(data.local.databaseBytes)}>
        <Breakdown parts={data.local.database} label={t("Aufteilung der Datenbank", "Database breakdown")} />
      </SettingRow>
      <SettingRow wide label={t("Hochgeladene Dateien", "Uploaded files")} description={`${bytes(data.local.uploads.bytes)} · ${number(data.local.uploads.files)} ${t("Dateien", "Files")}`}>
        <Breakdown parts={data.local.uploads.byType} label={t("Dateien nach Art", "Files by kind")} />
      </SettingRow>
      {s3.enabled && s3.reachable && s3.uploads && (
        <SettingRow
          wide
          label={t("Im S3-Bucket", "In the S3 bucket")}
          description={`${t("Dateien", "Files")} ${bytes(s3.uploads.bytes)} · ${number(s3.uploads.objects)} · ${t("Datenbanksicherung (Litestream)", "Database backup (Litestream)")} ${bytes(s3.backup?.bytes || 0)}${s3.partial ? ` · ${t("Mehr als 50 000 Objekte – Werte unvollständig.", "More than 50,000 objects – values incomplete.")}` : ""}`}
        >
          <Breakdown parts={s3.uploads.byType} label={t("Dateien im Bucket nach Art", "Files in the bucket by kind")} />
        </SettingRow>
      )}
    </SettingGroup>
  );
}

// Everything the instance holds, counted.
export function StorageCounts({ data }: { data: StorageOverview }) {
  const t = useT();
  const c = data.counts;
  const rows: [string, number | string][] = [
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
    [t("Benutzer", "Users"), `${number(c.users)}${c.disabledUsers ? t(` · ${number(c.disabledUsers)} deaktiviert`, ` · ${number(c.disabledUsers)} disabled`) : ""}`],
    [t("Aktive Sitzungen", "Active sessions"), c.sessions],
  ];
  return (
    <SettingGroup id="contents" title={t("Inhalte", "Content")} description={t("Was in der Instanz liegt, gezählt.", "What the instance holds, counted.")}>
      <dl className="admin-counts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{typeof value === "number" ? number(value) : value}</dd>
          </div>
        ))}
      </dl>
    </SettingGroup>
  );
}
