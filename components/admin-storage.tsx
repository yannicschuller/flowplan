"use client";
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
  return `${v.toLocaleString("de-DE", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}
const number = (n: number) => n.toLocaleString("de-DE");
function ago(iso: string | null) {
  if (!iso) return "noch keine";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  if (minutes < 1440) return `vor ${Math.round(minutes / 60)} Std.`;
  return `vor ${Math.round(minutes / 1440)} Tagen`;
}

// A stacked bar with its legend: shares of a total.
function Breakdown({
  parts,
  label,
}: {
  parts: { key: string; label: string; bytes: number; files?: number }[];
  label: string;
}) {
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
              {p.files !== undefined && <small>{number(p.files)} Dateien</small>}
              <strong>{bytes(p.bytes)}</strong>
            </li>
          ))
        ) : (
          <li className="storage-empty">Noch nichts gespeichert</li>
        )}
      </ul>
    </div>
  );
}

export function AdminStorage({ onError }: { onError: (message: string) => void }) {
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
        <h2>Speicher</h2>
        <p className="muted">Speicher wird geprüft …</p>
      </section>
    );
  const s3 = data.objectStorage,
    c = data.counts;
  return (
    <section className="settings-section admin-storage">
      <div className="settings-list-head">
        <h2>Speicher</h2>
        <button type="button" className="button" onClick={() => void load()} disabled={busy}>
          <ArrowClockwise size={15} className={busy ? "spin" : undefined} />
          {busy ? "Prüfe …" : "Aktualisieren"}
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
              ? "S3 nicht eingerichtet – alles liegt lokal"
              : s3.reachable
                ? "S3 verbunden"
                : "S3 nicht erreichbar"}
          </strong>
          {s3.enabled ? (
            <span>
              {s3.bucket} auf {s3.endpoint}
              {s3.prefix ? ` · Ordner ${s3.prefix}` : ""}
              {s3.reachable && s3.latencyMs !== undefined ? ` · ${s3.latencyMs} ms` : ""}
              {!s3.reachable && s3.error ? ` · ${s3.error}` : ""}
            </span>
          ) : (
            <span>Mit den Variablen S3_* werden Dateien und Datenbank zusätzlich in einen Bucket gesichert.</span>
          )}
        </div>
        {s3.enabled && (
          <dl>
            <div>
              <dt>Warteschlange</dt>
              <dd>
                {s3.pending ? `${number(s3.pending)} ausstehend` : "leer"}
                {s3.retrying ? " · wird wiederholt" : ""}
              </dd>
            </div>
            {s3.reachable && s3.backup && (
              <div>
                <dt>Datenbanksicherung</dt>
                <dd>{s3.backup.objects ? `${ago(s3.backup.lastModified)} · ${bytes(s3.backup.bytes)}` : "noch keine"}</dd>
              </div>
            )}
            {s3.reachable && s3.missing !== undefined && (
              <div>
                <dt>Abgleich</dt>
                <dd>
                  {s3.missing ? `${number(s3.missing)} Dateien fehlen im Bucket` : "alle Dateien im Bucket"}
                  {s3.orphans ? ` · ${number(s3.orphans)} ohne Datei` : ""}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>

      <div className="storage-columns">
        <div className="storage-panel">
          <h3>
            <HardDrives size={18} /> Lokal
            <strong>{bytes(data.local.databaseBytes + data.local.uploads.bytes)}</strong>
          </h3>
          <h4>
            SQLite-Datenbank <span>{bytes(data.local.databaseBytes)}</span>
          </h4>
          <Breakdown parts={data.local.database} label="Aufteilung der Datenbank" />
          <h4>
            Hochgeladene Dateien <span>{bytes(data.local.uploads.bytes)} · {number(data.local.uploads.files)}</span>
          </h4>
          <Breakdown parts={data.local.uploads.byType} label="Dateien nach Art" />
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
                Datenbanksicherung (Litestream) <span>{bytes(s3.backup?.bytes || 0)} · {number(s3.backup?.objects || 0)} Teile</span>
              </h4>
              <h4>
                Dateien <span>{bytes(s3.uploads.bytes)} · {number(s3.uploads.objects)}</span>
              </h4>
              <Breakdown parts={s3.uploads.byType} label="Dateien im Bucket nach Art" />
              {s3.partial && <p className="muted">Mehr als 50 000 Objekte – Werte unvollständig.</p>}
            </>
          ) : (
            <p className="muted">
              {s3.enabled ? "Der Bucket kann gerade nicht gelesen werden." : "Kein S3-Speicher eingerichtet."}
            </p>
          )}
        </div>
      </div>

      <h3 className="storage-counts-title">Inhalte</h3>
      <div className="admin-metrics storage-counts">
        {(
          [
            ["Arbeitsbereiche", c.workspaces],
            ["Bereiche", c.spaces],
            ["Dokumente", c.documents],
            ["Datenbanken", c.databases],
            ["Datensätze", c.rows],
            ["Whiteboards", c.whiteboards],
            ["Journale", `${number(c.journals)} · ${number(c.journalDays)} Tage`],
            ["Dateien", c.files],
            ["Kommentare", c.comments],
            ["Versionen", c.versions],
            ["Vorlagen", c.templates],
            ["Im Papierkorb", c.trashedPages],
            ["Gastlinks", c.shareLinks],
            ["Veröffentlicht", c.publications],
            ["Aktive Formulare", c.forms],
            ["Benutzer", `${number(c.users)}${c.disabledUsers ? ` · ${number(c.disabledUsers)} gesperrt` : ""}`],
            ["Aktive Sitzungen", c.sessions],
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
