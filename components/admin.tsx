"use client";
import { useEffect, useState } from "react";
import {
  ShieldCheck,
  Users,
  Stack,
  Key,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import { api, Avatar } from "./ui";
import type { User } from "@/lib/types";
import type { InstanceSettings } from "@/lib/instance-settings";
type AdminData = {
  users: User[];
  workspaces: { id: string; name: string; members: number; pages: number }[];
  sessions: number;
  audit: {
    id: string;
    name: string;
    action: string;
    resource_id: string;
    created_at: string;
  }[];
  adminGroup: string;
  oidcConfigured: boolean;
  metrics: {
    databaseBytes: number;
    uploadBytes: number;
    files: number;
    pages: number;
    trashedPages: number;
    rows: number;
    snapshots: number;
    pushPending: number;
    pushFailed: number;
    searchBacklog: number;
    reminders: number;
    retentionDays: number;
    defaultQuotaMb: number;
    uptimeSeconds: number;
    node: string;
  };
  usage: {
    id: string;
    bytes: number;
    quotaMb: number | null;
    effectiveQuotaMb: number;
  }[];
  settings: InstanceSettings;
  restorePending: {
    createdAt: string;
    users: number;
    workspaces: number;
    pages: number;
    files: number;
  } | null;
};
const mb = (bytes: number) =>
  `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
const duration = (seconds: number) =>
  seconds < 3600
    ? `${Math.round(seconds / 60)} Min.`
    : seconds < 86400
      ? `${Math.round(seconds / 3600)} Std.`
      : `${Math.round(seconds / 86400)} Tage`;
export default function Admin({
  mutate,
  onError,
}: {
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onError: (s: string) => void;
}) {
  const [data, setData] = useState<AdminData | null>(null),
    [tab, setTab] = useState("users");
  async function load() {
    try {
      setData(await api("/api/admin"));
    } catch (e) {
      onError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function act(b: Record<string, unknown>) {
    try {
      await mutate(b);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  if (!data)
    return <div className="loading-content">Administration wird geladen …</div>;
  return (
    <div className="utility-content admin-page">
      <div className="utility-title">
        <ShieldCheck size={32} />
        <h1>Administration</h1>
        <p>Benutzer, Arbeitsbereiche und Zugriffe deiner Flowplan-Instanz.</p>
      </div>
      <div className="admin-stats">
        <div>
          <Users />
          <strong>{data.users.length}</strong>
          <span>Benutzer</span>
        </div>
        <div>
          <Stack />
          <strong>{data.workspaces.length}</strong>
          <span>Arbeitsbereiche</span>
        </div>
        <div>
          <Key />
          <strong>{data.sessions}</strong>
          <span>Aktive Sitzungen</span>
        </div>
      </div>
      <div className="callout">
        <ShieldCheck size={20} />
        <span>
          Admin-Gruppe: <strong>{data.adminGroup}</strong> · OIDC{" "}
          {data.oidcConfigured ? "konfiguriert" : "nicht konfiguriert"}
        </span>
      </div>
      <div className="settings-tabs">
        {[
          ["users", "Benutzer"],
          ["workspaces", "Arbeitsbereiche"],
          ["operations", "Betrieb"],
          ["instance", "Instanz"],
          ["audit", "Aktivitätsprotokoll"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <button
          className="icon-button"
          title="Aktualisieren"
          onClick={() => load()}
        >
          <ArrowCounterClockwise />
        </button>
      </div>
      {tab === "users" &&
        data.users.map((u) => (
          <div className="member-row" key={u.id}>
            <Avatar name={u.name} />
            <span>
              {u.name}
              <small>{u.email}</small>
            </span>
            <button
              className="button compact"
              onClick={() => act({ action: "admin.revoke", userId: u.id })}
            >
              Sitzungen beenden
            </button>
            <button
              className={`button compact ${u.disabled ? "" : "danger"}`}
              onClick={() =>
                act({
                  action: "admin.user",
                  userId: u.id,
                  disabled: !u.disabled,
                })
              }
            >
              {u.disabled ? "Aktivieren" : "Deaktivieren"}
            </button>
          </div>
        ))}
      {tab === "workspaces" && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Arbeitsbereich</th>
              <th>Mitglieder</th>
              <th>Seiten</th>
              <th>Speicher</th>
              <th>Kontingent (MB)</th>
            </tr>
          </thead>
          <tbody>
            {data.workspaces.map((w) => {
              const usage = data.usage.find((u) => u.id === w.id);
              const quota = usage?.effectiveQuotaMb || 0;
              return (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td>{w.members}</td>
                  <td>{w.pages}</td>
                  <td>
                    {mb(usage?.bytes || 0)}
                    {quota > 0 && (
                      <meter
                        min={0}
                        max={quota * 1024 * 1024}
                        value={usage?.bytes || 0}
                        high={quota * 1024 * 1024 * 0.9}
                        aria-label={`Belegung ${w.name}`}
                      />
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      className="quota-input"
                      aria-label={`Kontingent ${w.name}`}
                      placeholder={
                        data.metrics.defaultQuotaMb
                          ? `Standard ${data.metrics.defaultQuotaMb}`
                          : "unbegrenzt"
                      }
                      defaultValue={usage?.quotaMb ?? ""}
                      onBlur={(e) => {
                        const raw = e.target.value.trim();
                        const next = raw === "" ? null : Number(raw);
                        if (next === (usage?.quotaMb ?? null)) return;
                        void act({
                          action: "admin.quota",
                          workspaceId: w.id,
                          quotaMb: next,
                        });
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {tab === "instance" && (
        <>
          <InstanceSettingsForm
            initial={data.settings}
            onSave={(settings) => act({ action: "admin.settings", settings })}
          />
          <InstanceBackup
            pending={data.restorePending}
            onChange={load}
            onError={onError}
          />
        </>
      )}
      {tab === "operations" && (
        <div className="admin-metrics" aria-label="Betriebsmetriken">
          {(
            [
              ["Datenbank", mb(data.metrics.databaseBytes)],
              [
                "Uploads",
                `${mb(data.metrics.uploadBytes)} · ${data.metrics.files} Dateien`,
              ],
              [
                "Seiten",
                `${data.metrics.pages} aktiv · ${data.metrics.trashedPages} im Papierkorb`,
              ],
              ["Datensätze", String(data.metrics.rows)],
              [
                "Versionen",
                `${data.metrics.snapshots} · Aufbewahrung ${data.metrics.retentionDays ? `${data.metrics.retentionDays} Tage` : "unbegrenzt"}`,
              ],
              [
                "Push-Warteschlange",
                `${data.metrics.pushPending} offen · ${data.metrics.pushFailed} fehlgeschlagen`,
              ],
              [
                "Suchindex",
                data.metrics.searchBacklog
                  ? `${data.metrics.searchBacklog} Änderungen ausstehend`
                  : "aktuell",
              ],
              ["Erinnerungen", String(data.metrics.reminders)],
              [
                "Standardkontingent",
                data.metrics.defaultQuotaMb
                  ? `${data.metrics.defaultQuotaMb} MB je Arbeitsbereich`
                  : "unbegrenzt",
              ],
              [
                "Laufzeit",
                `${duration(data.metrics.uptimeSeconds)} · Node ${data.metrics.node}`,
              ],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      )}
      {tab === "audit" && (
        <div className="audit-list">
          {data.audit.map((a) => (
            <div className="audit-row" key={a.id}>
              <span>
                <strong>{a.name || "System"}</strong>
                <small>{a.created_at}</small>
              </span>
              <code>{a.action}</code>
              <small>{a.resource_id.slice(0, 8)}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Instance-wide settings; empty numbers fall back to the environment.
function InstanceSettingsForm({
  initial,
  onSave,
}: {
  initial: InstanceSettings;
  onSave: (settings: InstanceSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial),
    [saved, setSaved] = useState(false);
  const optional = (value: string) =>
    value.trim() === "" ? null : Math.max(0, Math.round(Number(value)));
  return (
    <form
      className="settings-section instance-settings"
      aria-label="Instanzeinstellungen"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        await onSave(draft);
        setSaved(true);
      }}
    >
      <label>
        Name der Instanz
        <input
          maxLength={60}
          placeholder="z. B. Flowplan der Muster GmbH"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        Hinweis für alle Personen
        <textarea
          maxLength={500}
          rows={2}
          placeholder="z. B. Wartung am Samstag ab 18 Uhr"
          value={draft.announcement}
          onChange={(e) => setDraft({ ...draft, announcement: e.target.value })}
        />
      </label>
      <label>
        Standard-Speicherkontingent je Arbeitsbereich (MB, 0 = unbegrenzt)
        <input
          type="number"
          min={0}
          placeholder="Wert aus der Umgebung"
          value={draft.defaultQuotaMb ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, defaultQuotaMb: optional(e.target.value) })
          }
        />
      </label>
      <label>
        Versionen aufbewahren (Tage, 0 = unbegrenzt)
        <input
          type="number"
          min={0}
          placeholder="Wert aus der Umgebung"
          value={draft.retentionDays ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, retentionDays: optional(e.target.value) })
          }
        />
      </label>
      <label>
        Größte Datei beim Hochladen (MB)
        <input
          type="number"
          min={1}
          max={1024}
          required
          value={draft.maxUploadMb}
          onChange={(e) =>
            setDraft({
              ...draft,
              maxUploadMb: Math.min(
                1024,
                Math.max(1, Math.round(Number(e.target.value) || 1)),
              ),
            })
          }
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={draft.allowWorkspaceCreation}
          onChange={(e) =>
            setDraft({ ...draft, allowWorkspaceCreation: e.target.checked })
          }
        />
        Alle Personen dürfen Arbeitsbereiche anlegen
      </label>
      <button className="button primary">Einstellungen speichern</button>
      {saved && <p role="status">Gespeichert.</p>}
    </form>
  );
}

// Backup and restore of the whole instance (database and uploads).
function InstanceBackup({
  pending,
  onChange,
  onError,
}: {
  pending: AdminData["restorePending"];
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <section
      className="settings-section instance-backup"
      aria-label="Instanzsicherung"
    >
      <h2>Sicherung der gesamten Instanz</h2>
      <p className="muted">
        Enthält alle Arbeitsbereiche, Konten, Einstellungen und Dateien. Die
        Datei enthält vertrauliche Daten und sollte sicher verwahrt werden.
      </p>
      <a className="button" href="/api/admin/instance-backup" download>
        Sicherung herunterladen
      </a>
      <h3>Aus Sicherung wiederherstellen</h3>
      <p className="muted">
        Die hochgeladene Sicherung wird geprüft und beim nächsten Neustart des
        Servers übernommen. Der bisherige Stand bleibt im Datenordner als
        „pre-restore-…“ erhalten. Alle Sitzungen enden mit der Übernahme.
      </p>
      {pending ? (
        <div className="callout" role="status">
          <span>
            Bereit zur Übernahme beim Neustart: Sicherung vom{" "}
            {pending.createdAt
              ? new Date(pending.createdAt).toLocaleString("de-DE")
              : "unbekannten Datum"}{" "}
            mit {pending.workspaces} Arbeitsbereichen, {pending.pages} Seiten,{" "}
            {pending.users} Konten und {pending.files} Dateien.
          </span>
          <button
            className="button compact"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await fetch("/api/admin/instance-backup", {
                  method: "DELETE",
                });
                if (!r.ok) throw new Error((await r.json()).error);
                await onChange();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Wiederherstellung abbrechen
          </button>
        </div>
      ) : (
        <label className="button file-label">
          {busy ? "Sicherung wird geprüft …" : "Sicherung auswählen"}
          <input
            type="file"
            accept=".zip"
            hidden
            aria-label="Instanzsicherung hochladen"
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
                if (!r.ok) throw new Error((await r.json()).error);
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
